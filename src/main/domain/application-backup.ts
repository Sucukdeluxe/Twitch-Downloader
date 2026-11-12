import { normalizeVodLibrary } from './vod-library';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase, type DbHandle } from '../infra/db';
import { isSecretBearingKey } from './config-export';
import { sanitizeConfigInput } from './config-input';
import { parseExportJobs } from './export-job-queue';
import { parsePortableCutterProject, parseRecentCutterProjects, portableSourceReference, validatePortableCutterEdit, type PortableCutterProject } from './portable-cutter-project';

const TABLES = ['config_kv', 'queue_items', 'downloaded_vods', 'streamers', 'archive_files', 'chunk_index', 'download_history', 'download_history_details'] as const;
const FILES = ['workspace-session.json', 'cutter-projects.json', 'recent-cutter-projects.json', 'export-jobs.json', 'vod-library.json', 'portable-project-backups.json'] as const;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const PENDING = 'pending-restore.json';
const JOURNAL = 'restore-journal.json';
type Row = Record<string, string | number | null>;
type TableName = typeof TABLES[number];
type FileName = typeof FILES[number];

interface BackupDocument {
    format: 'twitch-vod-manager-backup';
    version: 1;
    appVersion: string;
    createdAt: string;
    tables: Record<TableName, Row[]>;
    files: Record<FileName, string | null>;
    historyStartedAt: string | null;
}

export interface ApplicationBackupPreview {
    digest: string;
    appVersion: string;
    createdAt: string;
    settings: number;
    queue: number;
    downloads: number;
    downloadedVods: number;
    projects: number;
    clips: number;
    mergeFiles: number;
    exportJobs: number;
    recentProjects: number;
    credentialsIncluded: false;
    mediaIncluded: false;
}

export class ApplicationBackupError extends Error {
    constructor(public readonly code: 'invalid' | 'changed' | 'too-large' | 'busy' | 'recovery-failed') {
        super(`Application backup: ${code}`);
    }
}

function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function redact(value: unknown, depth = 0): unknown {
    if (depth > 64) throw new ApplicationBackupError('invalid');
    if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !isSecretBearingKey(key) && !['__proto__', 'constructor', 'prototype', 'error', 'last_error', 'error_message'].includes(key))
        .map(([key, item]) => [key, redact(item, depth + 1)]));
}

async function verifyDataDirectory(directory: string): Promise<void> {
    const rootStat = await fs.lstat(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ApplicationBackupError('invalid');
    for (const name of ['app.db', 'app.db-wal', 'app.db-shm', PENDING, JOURNAL, ...FILES]) {
        try {
            const stat = await fs.lstat(path.join(directory, name));
            if (!stat.isFile() || stat.isSymbolicLink()) throw new ApplicationBackupError('invalid');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
}

async function readBounded(filename: string, maxBytes = MAX_BYTES): Promise<Buffer> {
    const handle = await fs.open(filename, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) throw new ApplicationBackupError('too-large');
        const bytes = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset !== stat.size) throw new ApplicationBackupError('changed');
        return bytes.subarray(0, offset);
    } finally { await handle.close(); }
}

async function writeAtomic(filename: string, bytes: string | Buffer): Promise<void> {
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temp, filename);
    } finally { await fs.rm(temp, { force: true }); }
}

interface ProjectBackup { filePath: string; document: PortableCutterProject }

function parseProjectBackups(value: unknown): ProjectBackup[] {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 50) throw new ApplicationBackupError('invalid');
    return value.projects.map(entry => {
        if (!object(entry) || typeof entry.filePath !== 'string' || entry.filePath.length > 4096 || !path.isAbsolute(entry.filePath)) throw new ApplicationBackupError('invalid');
        return { filePath: entry.filePath, document: parsePortableCutterProject(entry.document) };
    });
}

async function collectProjectBackups(files: BackupDocument['files']): Promise<void> {
    const recent = parseRecentCutterProjects(files['recent-cutter-projects.json'] ? JSON.parse(files['recent-cutter-projects.json']) : undefined);
    const projects: ProjectBackup[] = [];
    for (const entry of recent) {
        try {
            const document = parsePortableCutterProject(JSON.parse((await readBounded(entry.filePath, 1024 * 1024)).toString('utf8')));
            document.source.originalPath ??= path.resolve(path.dirname(entry.filePath), document.source.relativePath);
            projects.push({ filePath: entry.filePath, document });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    files['portable-project-backups.json'] = JSON.stringify({ version: 1, projects });
}

async function restoreProjectBackups(document: BackupDocument, destination: string): Promise<void> {
    const raw = document.files['portable-project-backups.json'];
    if (!raw) return;
    const projects = parseProjectBackups(JSON.parse(raw));
    if (!projects.length) return;
    await fs.mkdir(destination, { mode: 0o700 });
    const recent = parseRecentCutterProjects(document.files['recent-cutter-projects.json'] ? JSON.parse(document.files['recent-cutter-projects.json']) : undefined);
    for (const [index, entry] of projects.entries()) {
        const target = path.join(destination, String(index + 1) + '.tvmcut');
        const sourcePath = entry.document.source.originalPath ?? path.resolve(path.dirname(entry.filePath), entry.document.source.relativePath);
        entry.document.source = { ...entry.document.source, ...portableSourceReference(target, sourcePath) };
        await writeAtomic(target, JSON.stringify(entry.document));
        for (const item of recent) if (path.resolve(item.filePath) === path.resolve(entry.filePath)) item.filePath = target;
    }
    document.files['recent-cutter-projects.json'] = JSON.stringify({ version: 1, projects: recent });
}

function parseWorkspace(filename: FileName, text: string): Record<string, unknown> {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new ApplicationBackupError('too-large');
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.version !== 1) throw new ApplicationBackupError('invalid');
    if (filename === 'workspace-session.json' && (!Array.isArray(value.clips) || !Array.isArray(value.mergeFiles))) throw new ApplicationBackupError('invalid');
    if (filename === 'cutter-projects.json' && !Array.isArray(value.projects)) throw new ApplicationBackupError('invalid');
    if (filename === 'workspace-session.json') {
        if ((value.clips as unknown[]).length > 200 || (value.mergeFiles as unknown[]).length > 500 ||
            (value.clips as unknown[]).some(item => !object(item) || typeof item.url !== 'string' || item.url.length > 4096) ||
            (value.mergeFiles as unknown[]).some(item => !object(item) || typeof item.id !== 'string' || typeof item.path !== 'string' || !path.isAbsolute(item.path) || typeof item.size !== 'number' || item.size < 0)) throw new ApplicationBackupError('invalid');
    } else if (filename === 'cutter-projects.json') {
        for (const project of value.projects as unknown[]) validatePortableCutterEdit(project);
    }
    if (filename === 'recent-cutter-projects.json') parseRecentCutterProjects(value);
    if (filename === 'export-jobs.json') parseExportJobs(value);
    if (filename === 'vod-library.json') normalizeVodLibrary(value);
    if (filename === 'portable-project-backups.json') parseProjectBackups(value);
    const clean = redact(value) as Record<string, unknown>;
    if (filename === 'export-jobs.json') for (const job of clean.jobs as Array<Record<string, unknown>>) job.error = null;
    return clean;
}

function parseDocument(bytes: Buffer): BackupDocument {
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new ApplicationBackupError('invalid'); }
    if (!object(value) || value.format !== 'twitch-vod-manager-backup' || value.version !== 1 ||
        typeof value.appVersion !== 'string' || value.appVersion.length > 80 ||
        typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
        !object(value.tables) || !object(value.files)) throw new ApplicationBackupError('invalid');
    if (Object.keys(value.tables).some(key => !TABLES.includes(key as TableName)) ||
        Object.keys(value.files).some(key => !FILES.includes(key as FileName))) throw new ApplicationBackupError('invalid');
    for (const name of TABLES) {
        const rows = value.tables[name];
        if (!Array.isArray(rows) || rows.length > 1_000_000 || rows.some(row => !object(row) || Object.entries(row).some(([key, cell]) =>
            isSecretBearingKey(key) || !(/^[a-z_]+$/).test(key) || !(cell === null || typeof cell === 'string' || typeof cell === 'number' && Number.isFinite(cell))))) throw new ApplicationBackupError('invalid');
    }
    for (const name of FILES) {
        const text = value.files[name] ?? null;
        value.files[name] = text;
        if (text !== null && typeof text !== 'string') throw new ApplicationBackupError('invalid');
        if (typeof text === 'string') value.files[name] = JSON.stringify(parseWorkspace(name, text));
    }
    if (value.historyStartedAt !== null && (typeof value.historyStartedAt !== 'string' || !Number.isFinite(Date.parse(value.historyStartedAt)))) throw new ApplicationBackupError('invalid');
    return value as unknown as BackupDocument;
}

function preview(document: BackupDocument, bytes: Buffer): ApplicationBackupPreview {
    const projects = document.files['cutter-projects.json'] ? JSON.parse(document.files['cutter-projects.json']).projects.length : 0;
    const workspace = document.files['workspace-session.json'] ? JSON.parse(document.files['workspace-session.json']) : {};
    return { digest: createHash('sha256').update(bytes).digest('hex'), appVersion: document.appVersion, createdAt: document.createdAt,
        settings: document.tables.config_kv.length, queue: document.tables.queue_items.length,
        downloads: document.tables.download_history.length, downloadedVods: document.tables.downloaded_vods.length,
        projects: projects + (document.files['portable-project-backups.json'] ? parseProjectBackups(JSON.parse(document.files['portable-project-backups.json'])).length : 0), clips: workspace.clips?.length ?? 0, mergeFiles: workspace.mergeFiles?.length ?? 0,
        exportJobs: document.files['export-jobs.json'] ? JSON.parse(document.files['export-jobs.json']).jobs.length : 0,
        recentProjects: document.files['recent-cutter-projects.json'] ? JSON.parse(document.files['recent-cutter-projects.json']).projects.length : 0,
        credentialsIncluded: false, mediaIncluded: false };
}

function insertRows(db: DbHandle, name: TableName | 'app_secrets' | 'oauth_accounts', rows: Row[]): void {
    const columns = db.all<{ name: string }>(`PRAGMA table_info("${name}")`).map(column => column.name);
    for (const row of rows) {
        const keys = Object.keys(row);
        if (!keys.length || keys.some(key => !columns.includes(key))) throw new ApplicationBackupError('invalid');
        db.run(`INSERT INTO "${name}" (${keys.map(key => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => row[key]));
    }
}

function importDocument(db: DbHandle, document: BackupDocument): void {
    db.transaction(() => {
        for (const name of TABLES) {
            const rows = document.tables[name].map(row => ({ ...row }));
            if (name === 'config_kv') {
                const config = sanitizeConfigInput(Object.fromEntries(rows.filter(row => typeof row.key === 'string' && !isSecretBearingKey(row.key)).map(row => [row.key, JSON.parse(String(row.value))])));
                insertRows(db, name, Object.entries(config).map(([key, value]) => ({ key, value: JSON.stringify(value) })));
            } else if (name === 'queue_items') {
                for (const row of rows) {
                    const payload = redact(JSON.parse(String(row.payload_json)));
                    if (!object(payload) || typeof payload.id !== 'string' || payload.id !== row.id) throw new ApplicationBackupError('invalid');
                    if (!['completed', 'error', 'paused'].includes(String(payload.status))) {
                        payload.status = 'paused';
                        row.status = 'paused';
                    }
                    row.error_message = null;
                    row.payload_json = JSON.stringify(payload);
                }
                insertRows(db, name, rows);
            } else insertRows(db, name, rows);
        }
        if (document.historyStartedAt) db.run('UPDATE schema_meta SET value = ? WHERE key = ?', [document.historyStartedAt, 'download_history_started_at']);
        db.run('INSERT OR REPLACE INTO migrations_applied(name, payload) VALUES (?, ?)', ['authoritative-state-v1', JSON.stringify({ restored: true })]);
    });
    if (db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check !== 'ok') throw new ApplicationBackupError('invalid');
}

async function validateStaging(document: BackupDocument, directory: string): Promise<void> {
    const filename = path.join(directory, `.backup-validation-${randomUUID()}.db`);
    let db: DbHandle | undefined;
    try { db = openDatabase(filename); importDocument(db, document); }
    finally {
        db?.close();
        for (const suffix of ['', '-wal', '-shm']) await fs.rm(filename + suffix, { force: true });
    }
}

export async function createApplicationBackup(options: { db: DbHandle; dataDirectory: string; appVersion: string; outputFile: string; queue?: readonly object[] }): Promise<ApplicationBackupPreview> {
    await verifyDataDirectory(options.dataDirectory);
    if (path.extname(options.outputFile).toLowerCase() !== '.tvmbackup') throw new ApplicationBackupError('invalid');
    const files = {} as BackupDocument['files'];
    for (const name of FILES) {
        try { files[name] = JSON.stringify(parseWorkspace(name, (await readBounded(path.join(options.dataDirectory, name), MAX_FILE_BYTES)).toString('utf8'))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files[name] = null; }
    }
    await collectProjectBackups(files);
    const document = options.db.transaction((): BackupDocument => {
        const tables = {} as BackupDocument['tables'];
        for (const name of TABLES) tables[name] = (options.db.get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', name]) ? options.db.all<Row>(`SELECT * FROM "${name}"`) : []).map(row => {
            const copy = { ...row };
            if (name === 'queue_items') { copy.payload_json = JSON.stringify(redact(JSON.parse(String(copy.payload_json)))); copy.error_message = null; }
            return copy;
        });
        if (options.queue) tables.queue_items = options.queue.map((entry, index) => {
            const item = entry as Record<string, unknown>, now = Math.floor(Date.now() / 1000);
            if (typeof item.id !== 'string' || !item.id) throw new ApplicationBackupError('invalid');
            return { id: item.id, queue_position: index, streamer_login: typeof item.streamer === 'string' ? item.streamer : null,
                vod_id: null, clip_id: null, title: typeof item.title === 'string' ? item.title : null, output_path: null,
                status: typeof item.status === 'string' ? item.status : 'pending', progress_pct: typeof item.progress === 'number' ? item.progress : 0,
                error_message: null, created_at: now, updated_at: now, completed_at: null, payload_json: JSON.stringify(redact(item)) };
        });
        tables.config_kv = tables.config_kv.filter(row => typeof row.key === 'string' && !isSecretBearingKey(row.key)).map(row => ({ ...row, value: JSON.stringify(redact(JSON.parse(String(row.value)))) }));
        return { format: 'twitch-vod-manager-backup', version: 1, appVersion: options.appVersion, createdAt: new Date().toISOString(), tables, files,
            historyStartedAt: options.db.get<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', ['download_history_started_at'])?.value ?? null };
    });
    const bytes = Buffer.from(JSON.stringify(document));
    if (bytes.length > MAX_BYTES) throw new ApplicationBackupError('too-large');
    await validateStaging(parseDocument(bytes), options.dataDirectory);
    await writeAtomic(options.outputFile, bytes);
    const written = await readBounded(options.outputFile);
    if (!written.equals(bytes)) throw new ApplicationBackupError('changed');
    return preview(document, bytes);
}

export async function inspectApplicationBackup(filename: string, validationDirectory: string): Promise<ApplicationBackupPreview> {
    const bytes = await readBounded(filename);
    const document = parseDocument(bytes);
    await validateStaging(document, validationDirectory);
    return preview(document, bytes);
}

export async function queueApplicationRestore(options: { filename: string; expectedDigest: string; dataDirectory: string }): Promise<void> {
    await verifyDataDirectory(options.dataDirectory);
    const bytes = await readBounded(options.filename);
    if (createHash('sha256').update(bytes).digest('hex') !== options.expectedDigest) throw new ApplicationBackupError('changed');
    const document = parseDocument(bytes);
    await validateStaging(document, options.dataDirectory);
    await writeAtomic(path.join(options.dataDirectory, PENDING), bytes);
}

interface RestoreJournal { version: 1; directory: string; present: string[]; hashes: Record<string, string> }

async function digestFile(filename: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

async function copyAtomic(source: string, target: string): Promise<void> {
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
        await fs.copyFile(source, temp);
        const handle = await fs.open(temp, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temp, target);
    } finally { await fs.rm(temp, { force: true }); }
}

async function recoverInterruptedRestore(directory: string): Promise<boolean> {
    let value: unknown;
    try { value = JSON.parse((await readBounded(path.join(directory, JOURNAL), 4096)).toString('utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new ApplicationBackupError('recovery-failed'); }
    if (!object(value) || value.version !== 1 || typeof value.directory !== 'string' ||
        !/^before-restore-[0-9a-f-]{36}$/.test(value.directory) || !Array.isArray(value.present) ||
        value.present.some(name => !['app.db', ...FILES].includes(String(name))) || !object(value.hashes)) throw new ApplicationBackupError('recovery-failed');
    const journal = value as unknown as RestoreJournal;
    const backup = path.join(directory, journal.directory);
    const backupStat = await fs.lstat(backup);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new ApplicationBackupError('recovery-failed');
    for (const name of journal.present) {
        const stat = await fs.lstat(path.join(backup, name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new ApplicationBackupError('recovery-failed');
        if (await digestFile(path.join(backup, name)) !== journal.hashes[name]) throw new ApplicationBackupError('recovery-failed');
    }
    for (const name of ['app.db', ...FILES]) {
        const target = path.join(directory, name);
        if (journal.present.includes(name)) {
            await copyAtomic(path.join(backup, name), target);
        } else await fs.rm(target, { force: true });
    }
    for (const suffix of ['-wal', '-shm']) await fs.rm(path.join(directory, `app.db${suffix}`), { force: true });
    await fs.rm(path.join(directory, JOURNAL));
    return true;
}

export async function applyPendingApplicationRestore(directory: string): Promise<{ restored: boolean; recovered: boolean; safetyDirectory?: string }> {
    await verifyDataDirectory(directory);
    const recovered = await recoverInterruptedRestore(directory);
    const pending = path.join(directory, PENDING);
    let document: BackupDocument;
    try { document = parseDocument(await readBounded(pending)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { restored: false, recovered }; throw error; }
    const id = randomUUID();
    const safetyDirectory = path.join(directory, `before-restore-${id}`);
    const stage = path.join(directory, `.restore-${id}.db`);
    const restoredProjects = path.join(directory, `restored-projects-${id}`);
    await fs.mkdir(safetyDirectory, { mode: 0o700 });
    let staging: DbHandle | undefined;
    const present: string[] = [];
    try {
        await restoreProjectBackups(document, restoredProjects);
        staging = openDatabase(stage);
        importDocument(staging, document);
        try {
            const current = new Database(path.join(directory, 'app.db'), { readonly: true, fileMustExist: true });
            try {
                if ((current.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]?.integrity_check !== 'ok') throw new ApplicationBackupError('invalid');
                await current.backup(path.join(safetyDirectory, 'app.db'));
                for (const name of ['app_secrets', 'oauth_accounts'] as const) insertRows(staging, name, current.prepare(`SELECT * FROM "${name}"`).all() as Row[]);
                present.push('app.db');
            } finally { current.close(); }
        } catch (error) {
            if (await fs.stat(path.join(directory, 'app.db')).then(() => true, statError => { if (statError.code === 'ENOENT') return false; throw statError; })) throw error;
        }
        staging.raw.pragma('wal_checkpoint(TRUNCATE)');
        staging.close(); staging = undefined;
        for (const name of FILES) {
            try { await writeAtomic(path.join(safetyDirectory, name), await readBounded(path.join(directory, name), MAX_FILE_BYTES)); present.push(name); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (present.includes('app.db')) {
            const verification = new Database(path.join(safetyDirectory, 'app.db'), { readonly: true, fileMustExist: true });
            try { if ((verification.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]?.integrity_check !== 'ok') throw new ApplicationBackupError('invalid'); }
            finally { verification.close(); }
        }
        const hashes: Record<string, string> = {};
        for (const name of present) hashes[name] = await digestFile(path.join(safetyDirectory, name));
        await writeAtomic(path.join(directory, JOURNAL), JSON.stringify({ version: 1, directory: path.basename(safetyDirectory), present, hashes }));
        for (const suffix of ['-wal', '-shm']) await fs.rm(path.join(directory, `app.db${suffix}`), { force: true });
        await fs.rename(stage, path.join(directory, 'app.db'));
        for (const name of FILES) {
            const text = document.files[name];
            if (text === null) await fs.rm(path.join(directory, name), { force: true });
            else await writeAtomic(path.join(directory, name), text);
        }
        await fs.rm(pending);
        await fs.rm(path.join(directory, JOURNAL));
        return { restored: true, recovered, safetyDirectory };
    } catch (error) {
        await recoverInterruptedRestore(directory);
        if (path.dirname(path.resolve(restoredProjects)) === path.resolve(directory)) await fs.rm(restoredProjects, { recursive: true, force: true });
        throw error;
    } finally {
        staging?.close();
        for (const suffix of ['', '-wal', '-shm']) await fs.rm(stage + suffix, { force: true });
    }
}
