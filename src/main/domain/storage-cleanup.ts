import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface CleanupFile {
    path: string;
    bytes: number;
    mtimeMs: number;
    device: number;
    inode: number;
}
export interface StorageCleanupCandidate {
    videoPath: string;
    sidecarPaths: string[];
    streamer: string;
    bytes: number;
    ageDays: number;
    files: CleanupFile[];
}
export interface StorageCleanupOptions {
    root: string;
    streamers: readonly string[];
    cutoffDays: number;
    target: 'live_only' | 'all';
    action: 'delete' | 'archive';
    enabled: boolean;
}
export interface StorageCleanupPreview {
    token: string;
    enabled: boolean;
    dryRun: true;
    cutoffDays: number;
    target: 'live_only' | 'all';
    action: 'delete' | 'archive';
    scannedAt: string;
    candidates: number;
    processed: number;
    failed: number;
    bytesFreed: number;
    bytesAffected: number;
    failures: Array<{ path: string; error: string }>;
    items: StorageCleanupCandidate[];
    recoveryPaths: string[];
}
export interface StorageCleanupResult extends Omit<StorageCleanupPreview, 'dryRun'> {
    dryRun: false;
    skipped: number;
    cancelled: boolean;
}
interface CleanupJournal {
    version: 1;
    operationId: string;
    published: boolean;
    names: string[];
    destinations: string[];
    hashes: string[];
}
const VIDEO = /\.(mp4|ts|mkv|mov|avi)$/i;
const SIDECARS = ['.chat.json', '.chat.jsonl', '.events.jsonl'];
const STAGING = '.tvm-cleanup-';
const DAY = 86400000;
const filenameKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;

function within(root: string, filename: string): boolean {
    const relative = path.relative(root, filename);
    return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

async function safePath(root: string, filename: string, allowMissing = false): Promise<void> {
    if (!within(root, filename)) throw new Error('outside-root');
    let current = root;
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe-root');
    for (const part of path.relative(root, filename).split(path.sep)) {
        current = path.join(current, part);
        try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('symbolic-link'); }
        catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
}

async function identity(root: string, filename: string): Promise<CleanupFile> {
    await safePath(root, filename);
    return fileIdentity(filename);
}

async function fileIdentity(filename: string): Promise<CleanupFile> {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not-file');
    return { path: filename, bytes: stat.size, mtimeMs: stat.mtimeMs, device: stat.dev, inode: stat.ino };
}

function same(left: CleanupFile, right: CleanupFile): boolean {
    return left.bytes === right.bytes && left.mtimeMs === right.mtimeMs && left.device === right.device && left.inode === right.inode;
}

async function hashFile(filename: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk);
    return hash.digest('hex');
}

async function saveJournal(directory: string, journal: CleanupJournal): Promise<void> {
    const temporary = path.join(directory, 'operation.tmp');
    const handle = await fs.open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, path.join(directory, 'operation.json'));
}

async function ensureDirectory(root: string, directory: string): Promise<void> {
    if (!within(root, directory)) throw new Error('outside-root');
    let current = root;
    for (const part of path.relative(root, directory).split(path.sep)) {
        current = path.join(current, part);
        await safePath(root, current, true);
        try { await fs.mkdir(current); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-directory');
    }
}

async function rollback(root: string, directory: string, journal: CleanupJournal): Promise<void> {
    await safePath(root, directory);
    if (journal.version !== 1 || typeof journal.operationId !== 'string' || !Array.isArray(journal.names) ||
        !Array.isArray(journal.destinations) || !Array.isArray(journal.hashes) || journal.names.length < 1 || journal.names.length > 4 ||
        journal.names.some(name => typeof name !== 'string' || name !== path.basename(name) || name === '.' || name === '..') ||
        journal.destinations.some(name => typeof name !== 'string' || !within(root, name))) throw new Error('invalid-journal');
    if (typeof journal.published !== 'boolean' || journal.hashes.length !== journal.destinations.length ||
        journal.hashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) || new Set(journal.names).size !== journal.names.length) throw new Error('invalid-journal');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || ![...journal.names, 'operation.json', 'operation.tmp'].includes(entry.name))) throw new Error('unexpected-staged-file');
    if (journal.published) {
        for (let i = 0; i < journal.destinations.length; i++) {
            await safePath(root, journal.destinations[i]);
            if (await hashFile(journal.destinations[i]) !== journal.hashes[i]) throw new Error('archive-changed');
        }
    } else {
        for (const name of journal.names) {
            const staged = path.join(directory, name);
            const original = path.join(path.dirname(directory), name);
            const exists = await fs.lstat(staged).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
            if (!exists) continue;
            await safePath(root, original, true);
            await fs.copyFile(staged, original, constants.COPYFILE_EXCL);
            if (await hashFile(staged) !== await hashFile(original)) throw new Error('rollback-copy-failed');
            const stat = await fs.stat(staged);
            await fs.utimes(original, stat.atime, stat.mtime);
            await fs.unlink(staged);
        }
        for (let i = 0; i < journal.destinations.length; i++) {
            const destination = journal.destinations[i];
            try {
                await safePath(root, destination);
                if (await hashFile(destination) !== journal.hashes[i]) throw new Error('archive-changed');
                await fs.unlink(destination);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
    }
    await safePath(root, directory);
    await fs.rm(directory, { recursive: true });
}

export function createStorageCleanupService(dependencies: {
    isActive: (filename: string) => boolean;
    trashDirectory: (directory: string) => Promise<void>;
    now?: () => number;
}) {
    const now = dependencies.now ?? Date.now;
    const plans = new Map<string, { options: StorageCleanupOptions; preview: StorageCleanupPreview; createdAt: number }>();
    let active = false;

    const preview = async (input: StorageCleanupOptions, signal?: AbortSignal): Promise<StorageCleanupPreview> => {
        if (!['live_only', 'all'].includes(input.target) || !['delete', 'archive'].includes(input.action) || !Number.isInteger(input.cutoffDays) || input.cutoffDays < 1 || input.cutoffDays > 3650 || !path.isAbsolute(input.root)) throw new Error('invalid-cleanup-options');
        const options = { ...input, root: path.resolve(input.root), streamers: [...input.streamers] };
        const scannedAt = now();
        const result: StorageCleanupPreview = { token: randomUUID(), enabled: input.enabled, dryRun: true, cutoffDays: input.cutoffDays,
            target: input.target, action: input.action, scannedAt: new Date(scannedAt).toISOString(), candidates: 0, processed: 0, failed: 0,
            bytesFreed: 0, bytesAffected: 0, failures: [], items: [], recoveryPaths: [] };
        const rootStat = await fs.lstat(options.root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe-root');
        const known = new Set(options.streamers.map(value => value.toLowerCase()));
        const roots = (await fs.readdir(options.root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() &&
            entry.name.toLowerCase() !== 'archived' && (known.has(entry.name.toLowerCase()) || entry.name.toLowerCase() === 'clips'));
        const pending = roots.map(entry => ({ directory: path.join(options.root, entry.name), streamer: entry.name, live: input.target === 'all' }));
        while (pending.length) {
            if (signal?.aborted) throw new Error('cancelled');
            const current = pending.pop()!;
            let scan;
            try {
                await safePath(options.root, current.directory);
                scan = { stat: await fs.lstat(current.directory), entries: await fs.readdir(current.directory, { withFileTypes: true }) };
            }
            catch (error) { result.failures.push({ path: current.directory, error: error instanceof Error ? error.message : String(error) }); continue; }
            const entries = scan.entries;
            const fileEntries = new Map(entries.map(entry => [filenameKey(entry.name), entry]));
            const directoryStart = scan.stat;
            const firstItem = result.items.length;
            for (const entry of entries) {
                if (signal?.aborted) throw new Error('cancelled');
                const filename = path.join(current.directory, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (entry.name.startsWith(STAGING)) { result.recoveryPaths.push(filename); continue; }
                    if (entry.name.toLowerCase() !== 'archived') pending.push({ ...current, directory: filename, live: current.live || entry.name.toLowerCase() === 'live' });
                    continue;
                }
                if (!entry.isFile() || !current.live || !VIDEO.test(entry.name)) continue;
                try {
                    const video = await fileIdentity(filename);
                    if (video.mtimeMs > scannedAt - input.cutoffDays * DAY || dependencies.isActive(filename)) continue;
                    const base = filename.slice(0, -path.extname(filename).length);
                    const files = [video];
                    for (const extension of SIDECARS) {
                        const entry = fileEntries.get(filenameKey(path.basename(base + extension)));
                        if (!entry) continue;
                        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe-sidecar');
                        try { files.push(await fileIdentity(path.join(current.directory, entry.name))); }
                        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                    }
                    if (files.some(file => dependencies.isActive(file.path))) continue;
                    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
                    result.items.push({ videoPath: filename, sidecarPaths: files.slice(1).map(file => file.path), streamer: current.streamer,
                        bytes, ageDays: Math.floor((scannedAt - video.mtimeMs) / DAY), files });
                    result.bytesAffected += bytes;
                } catch (error) { result.failures.push({ path: filename, error: error instanceof Error ? error.message : String(error) }); }
            }
            try {
                await safePath(options.root, current.directory);
                const directoryEnd = await fs.lstat(current.directory);
                if (directoryStart.dev !== directoryEnd.dev || directoryStart.ino !== directoryEnd.ino) throw new Error('directory-changed');
            } catch (error) {
                const rejected = result.items.splice(firstItem);
                result.bytesAffected -= rejected.reduce((sum, candidate) => sum + candidate.bytes, 0);
                result.failures.push({ path: current.directory, error: error instanceof Error ? error.message : String(error) });
            }
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        result.items.sort((left, right) => left.videoPath.localeCompare(right.videoPath));
        result.candidates = result.items.length;
        result.failed = result.failures.length;
        for (const [token, plan] of plans) if (now() - plan.createdAt > 15 * 60_000) plans.delete(token);
        if (plans.size >= 4) plans.delete(plans.keys().next().value!);
        plans.set(result.token, { options, preview: structuredClone(result), createdAt: now() });
        return result;
    };

    const execute = async (token: string, signal?: AbortSignal): Promise<StorageCleanupResult> => {
        if (active) throw new Error('cleanup-busy');
        const plan = plans.get(token);
        if (!plan || now() - plan.createdAt > 15 * 60_000) throw new Error('preview-expired');
        plans.delete(token);
        active = true;
        const { options } = plan;
        const result: StorageCleanupResult = { ...structuredClone(plan.preview), dryRun: false, bytesAffected: 0, skipped: 0, cancelled: false };
        try {
            for (const candidate of plan.preview.items) {
                if (signal?.aborted) { result.cancelled = true; break; }
                let stage: string | undefined;
                const journal: CleanupJournal = { version: 1, operationId: randomUUID(), published: false, names: candidate.files.map(file => path.basename(file.path)), destinations: [], hashes: [] };
                try {
                    for (const file of candidate.files) {
                        if (dependencies.isActive(file.path) || !same(file, await identity(options.root, file.path))) throw new Error('changed-or-active');
                    }
                    const base = candidate.videoPath.slice(0, -path.extname(candidate.videoPath).length);
                    for (const extension of SIDECARS) {
                        const filename = base + extension;
                        const exists = await fs.lstat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
                        if (exists !== candidate.sidecarPaths.some(sidecar => filenameKey(sidecar) === filenameKey(filename))) throw new Error('changed-or-active');
                    }
                    stage = await fs.mkdtemp(path.join(path.dirname(candidate.videoPath), STAGING));
                    await saveJournal(stage, journal);
                    for (const file of candidate.files) {
                        if (dependencies.isActive(file.path) || !same(file, await identity(options.root, file.path))) throw new Error('changed-or-active');
                        await fs.rename(file.path, path.join(stage, path.basename(file.path)));
                    }
                    for (const file of candidate.files) {
                        if (dependencies.isActive(file.path) || !same(file, await identity(options.root, path.join(stage, path.basename(file.path))))) throw new Error('changed-or-active');
                    }
                    if (options.action === 'delete') {
                        if (signal?.aborted) throw new Error('cancelled');
                        await dependencies.trashDirectory(stage);
                        stage = undefined;
                    } else {
                        const date = new Date(candidate.files[0].mtimeMs);
                        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                        const destinationDirectory = path.join(options.root, 'archived', candidate.streamer, month);
                        await ensureDirectory(options.root, destinationDirectory);
                        const videoName = path.basename(candidate.videoPath);
                        const extension = path.extname(videoName);
                        const base = videoName.slice(0, -extension.length);
                        let suffix = 0;
                        let destinations: string[];
                        while (true) {
                            const newBase = base + (suffix ? ` (${suffix})` : '');
                            destinations = candidate.files.map((file, index) => path.join(destinationDirectory, index === 0 ? newBase + extension : newBase + path.basename(file.path).slice(base.length)));
                            const occupied = await Promise.all(destinations.map(filename => fs.lstat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })));
                            if (!occupied.some(Boolean)) break;
                            suffix += 1;
                            if (suffix > 10000) throw new Error('archive-name-conflict');
                        }
                        for (let index = 0; index < candidate.files.length; index++) {
                            const source = path.join(stage, journal.names[index]);
                            const destination = destinations[index];
                            await safePath(options.root, destination, true);
                            const expectedHash = await hashFile(source, signal);
                            await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
                            journal.destinations.push(destination);
                            journal.hashes.push(expectedHash);
                            await saveJournal(stage, journal);
                            if (await hashFile(destination, signal) !== expectedHash) throw new Error('archive-copy-failed');
                            const stat = await fs.stat(source);
                            await fs.utimes(destination, stat.atime, stat.mtime);
                        }
                        for (const file of candidate.files) {
                            if (dependencies.isActive(file.path) || !same(file, await identity(options.root, path.join(stage, path.basename(file.path))))) throw new Error('changed-or-active');
                        }
                        journal.published = true;
                        await saveJournal(stage, journal);
                        await rollback(options.root, stage, journal);
                        stage = undefined;
                    }
                    result.processed += 1;
                    result.bytesAffected += candidate.bytes;
                } catch (error) {
                    if (stage) {
                        try { await rollback(options.root, stage, journal); }
                        catch (rollbackError) { result.recoveryPaths.push(stage); result.failures.push({ path: stage, error: `recovery-required: ${String(rollbackError)}` }); }
                    }
                    if (error instanceof Error && error.message === 'changed-or-active') result.skipped += 1;
                    else result.failed += 1;
                    result.failures.push({ path: candidate.videoPath, error: error instanceof Error ? error.message : String(error) });
                    if (signal?.aborted) { result.cancelled = true; break; }
                }
            }
            return result;
        } finally { active = false; }
    };

    const recover = async (root: string, directories: readonly string[]): Promise<void> => {
        if (active) throw new Error('cleanup-busy');
        active = true;
        try {
            for (const directory of directories) {
                if (!path.basename(directory).startsWith(STAGING)) throw new Error('invalid-journal-path');
                await safePath(root, directory);
                const filename = path.join(directory, 'operation.json');
                await safePath(root, filename);
                if ((await fs.stat(filename)).size > 32768) throw new Error('invalid-journal');
                await rollback(root, directory, JSON.parse(await fs.readFile(filename, 'utf8')) as CleanupJournal);
            }
        } finally { active = false; }
    };

    return { preview, execute, recover, isBusy: () => active };
}
