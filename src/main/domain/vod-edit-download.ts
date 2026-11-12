import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runMediaProcess, type MediaProcessOptions } from './media-process';
import { buildVodConcatArgs, probeVodMedia, VOD_TRIM_VERSION, type VodMediaInfo } from './vod-precise-trim';
import { planEditedVod, type EditedVodPart, type OmissionConfig, type OmittedRange } from './vod-edit-plan';

interface CachedInput extends VodMediaInfo { size: number }
interface PublishedPart { path: string; size: number }
interface CopyIdentity { dev: number; ino: number; birthtimeMs: number }
interface PendingPart extends PublishedPart { index: number; number: number; copyIdentity?: CopyIdentity }
interface EditJournal { version: 2; identity: string; inputs: Record<string, CachedInput>; published: Record<string, PublishedPart>; pending?: PendingPart }
export interface EditedVodOptions extends MediaProcessOptions {
    id: string; url: string; folder: string; duration: number; startPart: number; omissions: OmissionConfig;
    namingIdentity: string; ffmpegPath: string; ffprobePath: string;
    download(range: OmittedRange, filename: string, progress: (percent: number) => void): Promise<void>;
    filename(part: EditedVodPart): string;
    wait(): Promise<boolean>;
    checkSpace(bytes: number): void;
    progress(percent: number, phase: 'download' | 'assemble' | 'publish', index: number, count: number): void;
}

export function editedVodWorkspace(folder: string, id: string): string {
    const [timestamp, suffix, extra] = id.split('-');
    if (!/^\d{13}$/.test(timestamp) || extra !== undefined || (suffix !== undefined && !/^\d{1,3}$/.test(suffix))) throw new Error('Invalid queue ID');
    return path.join(path.resolve(folder), '.vod-edit-' + id);
}

async function fileSize(filename: string): Promise<number> {
    try { const stat = await fs.lstat(filename); return stat.isFile() && !stat.isSymbolicLink() ? stat.size : -1; } catch { return -1; }
}

export async function cleanupEditedVod(folder: string, id: string): Promise<void> {
    const workspace = editedVodWorkspace(folder, id);
    const stat = await fs.lstat(workspace).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of await fs.readdir(workspace)) {
        if (!/^(?:source-\d{4}\.mp4(?:\.tvm-part|\.remux\.tvm-part)?|part-\d{4}\.mp4|concat\.ffconcat|journal\.json(?:\.tmp)?)$/.test(name)) continue;
        const filename = path.join(workspace, name);
        if (await fileSize(filename) >= 0) await fs.unlink(filename).catch(() => undefined);
    }
    await fs.rmdir(workspace).catch(() => undefined);
}

async function probe(filename: string, options: EditedVodOptions): Promise<CachedInput> {
    const info = await probeVodMedia(options.ffprobePath, filename, { ...options, timeoutMs: 120000 });
    const size = await fileSize(filename);
    if (size < 1) throw new Error('Invalid edited VOD media');
    return { ...info, size };
}

async function hashFile(filename: string, length?: number): Promise<string> {
    const hash = createHash('sha256');
    if (length !== 0) for await (const chunk of createReadStream(filename, length === undefined ? {} : { start: 0, end: length - 1 })) hash.update(chunk);
    return hash.digest('hex');
}

function sameCopyIdentity(left: CopyIdentity, right: CopyIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

async function copyIntoReservedOutput(source: string, output: Awaited<ReturnType<typeof fs.open>>, offset: number, options: EditedVodOptions): Promise<void> {
    const input = await fs.open(source, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
        while (true) {
            if (!(await options.wait())) throw new Error('Edited VOD cancelled');
            const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
            if (bytesRead === 0) break;
            let written = 0;
            while (written < bytesRead) {
                const result = await output.write(buffer, written, bytesRead - written, offset + written);
                if (!result.bytesWritten) throw new Error('Could not write edited VOD output');
                written += result.bytesWritten;
            }
            offset += bytesRead;
        }
        await output.sync();
    } finally { await input.close(); }
}

function validateOutputPath(folder: string, filename: string): void {
    const relative = path.relative(path.resolve(folder), path.resolve(filename));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid edited VOD output path');
}

export async function downloadEditedVod(options: EditedVodOptions): Promise<string[]> {
    const plan = planEditedVod(options.duration, options.omissions.partDurationSec, options.omissions.ranges, options.startPart, options.omissions.selection);
    if (!plan.parts.length) throw new Error('No remaining VOD content');
    const workspace = editedVodWorkspace(options.folder, options.id);
    await fs.mkdir(workspace, { recursive: true });
    const stat = await fs.lstat(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid edit workspace');
    const identity = createHash('sha256').update(JSON.stringify([VOD_TRIM_VERSION, options.url, options.duration, options.omissions, options.startPart, options.namingIdentity])).digest('hex');
    const journalPath = path.join(workspace, 'journal.json');
    let journal: EditJournal = { version: 2, identity, inputs: {}, published: {} };
    const previous = await fs.readFile(journalPath, 'utf8').catch(() => null);
    if (previous) {
        if (previous.length > 1024 * 1024) throw new Error('Invalid edit recovery journal');
        const parsed = JSON.parse(previous) as EditJournal;
        if (Number(parsed.version) === 1) {
            // Only owned staging files are discarded. Previously published files
            // remain untouched and the caller reserves fresh output names.
            await cleanupEditedVod(options.folder, options.id);
            await fs.mkdir(workspace, { recursive: true });
        } else {
            if (parsed.version !== 2 || parsed.identity !== identity || !parsed.inputs || !parsed.published) throw new Error('Edit recovery settings differ');
            journal = parsed;
        }
    }
    const save = async (): Promise<void> => { await fs.writeFile(journalPath + '.tmp', JSON.stringify(journal)); await fs.rename(journalPath + '.tmp', journalPath); };
    await save();
    if (journal.pending) {
        const pending = journal.pending;
        if (plan.parts[pending.index]?.number !== pending.number) throw new Error('Invalid pending VOD part');
        validateOutputPath(options.folder, pending.path);
        if (await fileSize(pending.path) >= 0) {
            const stagedPath = path.join(workspace, 'part-' + String(pending.index).padStart(4, '0') + '.mp4');
            const currentSize = await fileSize(pending.path);
            if (currentSize < pending.size && pending.copyIdentity) {
                const output = await fs.open(pending.path, 'r+');
                try {
                    if (!sameCopyIdentity(await output.stat(), pending.copyIdentity) || await hashFile(pending.path) !== await hashFile(stagedPath, currentSize)) throw new Error('Pending VOD output changed');
                    options.checkSpace(pending.size - currentSize + 32 * 1024 * 1024);
                    await copyIntoReservedOutput(stagedPath, output, currentSize, options);
                } finally { await output.close(); }
            }
            if (await fileSize(pending.path) !== pending.size || await hashFile(pending.path) !== await hashFile(stagedPath)) throw new Error('Pending VOD output changed');
            journal.published[String(pending.number)] = { path: pending.path, size: pending.size };
        }
        delete journal.pending;
        await save();
    }
    const outputs: string[] = [];
    for (const part of plan.parts) {
        const published = journal.published[String(part.number)];
        if (!published) break;
        validateOutputPath(options.folder, published.path);
        if (await fileSize(published.path) !== published.size) throw new Error('Published VOD part changed');
        outputs.push(published.path);
    }
    if (outputs.length === plan.parts.length) {
        if (!(await options.wait())) throw new Error('Edited VOD cancelled');
        return outputs;
    }
    let completedDuration = 0;
    const inputs: Array<{ name: string; duration: number; info: CachedInput }> = [];
    // Split the source ranges at output part boundaries before encoding. No
    // downstream stream-copy split may move a boundary to a nearby keyframe.
    const sourceRanges = plan.parts.flatMap(part => part.ranges);
    for (let index = 0; index < sourceRanges.length; index++) {
        if (!(await options.wait())) throw new Error('Edited VOD cancelled');
        const range = sourceRanges[index], duration = range.end - range.start;
        const name = 'source-' + String(index).padStart(4, '0') + '.mp4', filename = path.join(workspace, name);
        let cached = journal.inputs[name];
        if (!cached || await fileSize(filename) !== cached.size) {
            await fs.unlink(filename).catch(() => undefined);
            await options.download(range, filename, percent => options.progress((completedDuration + duration * Math.max(0, Math.min(100, percent)) / 100) / plan.duration * 75, 'download', index + 1, sourceRanges.length));
            cached = await probe(filename, options);
            if (Math.abs(cached.duration - duration) > cached.frameSeconds + 0.025) throw new Error('Downloaded range duration differs');
            journal.inputs[name] = cached;
            await save();
        }
        inputs.push({ name, duration, info: cached });
        completedDuration += duration;
        options.progress(completedDuration / plan.duration * 75, 'download', index + 1, sourceRanges.length);
    }
    if (!(await options.wait())) throw new Error('Edited VOD cancelled');
    options.checkSpace(Object.values(journal.inputs).reduce((sum, input) => sum + input.size, 0) * 1.1 + 32 * 1024 * 1024);
    const staged: CachedInput[] = [];
    let sourceIndex = 0;
    for (let index = 0; index < plan.parts.length; index++) {
        if (!(await options.wait())) throw new Error('Edited VOD cancelled');
        const part = plan.parts[index];
        const fragments = inputs.slice(sourceIndex, sourceIndex + part.ranges.length);
        sourceIndex += part.ranges.length;
        const output = path.join(workspace, 'part-' + String(index).padStart(4, '0') + '.mp4');
        options.progress(75 + index / plan.parts.length * 22, 'assemble', index + 1, plan.parts.length);
        // A previous publication may still be hard-linked to this staging name.
        // Unlink before rewriting so a retry cannot alter a published file.
        await fs.unlink(output).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        // The single-fragment file is already a precise MP4, including its AAC
        // edit list. Copying it avoids a needless second lossy generation.
        if (fragments.length === 1) await fs.copyFile(path.join(workspace, fragments[0].name), output);
        else await runMediaProcess(options.ffmpegPath, buildVodConcatArgs(fragments.map(fragment => ({
            filename: path.join(workspace, fragment.name), info: fragment.info, duration: fragment.duration,
        })), output), { ...options, timeoutMs: 24 * 60 * 60 * 1000 });
        if (!(await options.wait())) throw new Error('Edited VOD cancelled');
        const info = await probe(output, options);
        if (Math.abs(info.duration - part.duration) > fragments.length * info.frameSeconds + 0.025) throw new Error('Output part duration differs');
        staged.push(info);
    }
    for (let index = outputs.length; index < plan.parts.length; index++) {
        if (!(await options.wait())) throw new Error('Edited VOD cancelled');
        const part = plan.parts[index], target = options.filename(part), stagedPath = path.join(workspace, 'part-' + String(index).padStart(4, '0') + '.mp4');
        validateOutputPath(options.folder, target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        journal.pending = { path: target, size: staged[index].size, index, number: part.number };
        await save();
        try { await fs.link(stagedPath, target); }
        catch (error) {
            if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
            options.checkSpace(staged[index].size + 32 * 1024 * 1024);
            const output = await fs.open(target, 'wx');
            try {
                const { dev, ino, birthtimeMs } = await output.stat();
                journal.pending.copyIdentity = { dev, ino, birthtimeMs };
                await save();
                await copyIntoReservedOutput(stagedPath, output, 0, options);
            } finally { await output.close(); }
        }
        journal.published[String(part.number)] = { path: target, size: staged[index].size };
        delete journal.pending;
        await save();
        outputs.push(target);
        options.progress(97 + (index + 1) / plan.parts.length * 3, 'publish', index + 1, plan.parts.length);
    }
    if (!(await options.wait())) throw new Error('Edited VOD cancelled');
    return outputs;
}
