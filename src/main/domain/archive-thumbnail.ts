import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
type ThumbnailFile = { fullPath: string; size: number; mtimeMs: number };

export class ArchiveThumbnailService {
    private readonly memory = new Map<string, { source: string | null; expires: number }>();
    private readonly requests = new Map<string, Promise<string | null>>();
    private readonly controllers = new Set<AbortController>();
    private readonly waiting: Array<() => void> = [];
    private active = 0;
    private closed = false;
    private generated = 0;

    constructor(private readonly directory: string, private readonly command: () => Promise<string>, private readonly onExecute?: (command: string) => void) {}

    async load(file: ThumbnailFile): Promise<string | null> {
        if (this.closed || !/\.(mp4|mkv|ts|m4v|webm|mov)$/i.test(file.fullPath)) return null;
        const key = createHash('sha256').update(JSON.stringify([file.fullPath, file.size, file.mtimeMs])).digest('hex');
        const cached = this.memory.get(key);
        if (cached && cached.expires > Date.now()) return cached.source;
        this.memory.delete(key);
        const pending = this.requests.get(key);
        if (pending) return pending;
        if (this.requests.size >= 48) return null;
        const request = this.create(file, key).catch(() => null).then(value => {
            if (!this.closed) {
                if (this.memory.size >= 256) this.memory.delete(this.memory.keys().next().value!);
                this.memory.set(key, { source: value, expires: value ? Number.POSITIVE_INFINITY : Date.now() + 30000 });
            }
            return value;
        }).finally(() => this.requests.delete(key));
        this.requests.set(key, request);
        return request;
    }

    private async matches(file: ThumbnailFile): Promise<boolean> {
        try {
            const stat = await fs.stat(file.fullPath);
            return stat.isFile() && stat.size === file.size && stat.mtimeMs === file.mtimeMs;
        } catch { return false; }
    }

    private async create(file: ThumbnailFile, key: string): Promise<string | null> {
        if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
        if (this.closed) return null;
        this.active++;
        try {
            if (!await this.matches(file)) return null;
            const filename = path.join(this.directory, key + '.jpg');
            try {
                const bytes = await fs.readFile(filename);
                if (this.valid(bytes)) return 'data:image/jpeg;base64,' + bytes.toString('base64');
            } catch { }
            const command = await this.command();
            if (this.closed) return null;
            const controller = new AbortController();
            this.controllers.add(controller);
            try {
                for (const seconds of ['1', '0']) {
                    if (this.closed) return null;
                    this.onExecute?.(command);
                    const output = await execute(command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-ss', seconds, '-i', file.fullPath,
                        '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', 'scale=256:144:force_original_aspect_ratio=decrease,pad=256:144:(ow-iw)/2:(oh-ih)/2',
                        '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'], {
                        encoding: 'buffer', windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024, signal: controller.signal,
                    }).catch(() => null);
                    if (!output || !this.valid(output.stdout)) continue;
                    if (!await this.matches(file) || this.closed) return null;
                    await fs.mkdir(this.directory, { recursive: true });
                    await fs.writeFile(filename, output.stdout).catch(() => undefined);
                    if (this.generated++ % 32 === 0) await this.prune();
                    return 'data:image/jpeg;base64,' + output.stdout.toString('base64');
                }
            } finally { this.controllers.delete(controller); }
            return null;
        } finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }

    private valid(bytes: Buffer): boolean {
        return bytes.length >= 4 && bytes.length <= 1024 * 1024 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    }

    private async prune(): Promise<void> {
        const names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.jpg$/.test(name));
        if (names.length <= 512) return;
        const files = await Promise.all(names.map(async name => ({ name, modified: (await fs.stat(path.join(this.directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
        files.sort((left, right) => right.modified - left.modified);
        await Promise.all(files.slice(512).map(file => fs.unlink(path.join(this.directory, file.name)).catch(() => undefined)));
    }

    async dispose(): Promise<void> {
        this.closed = true;
        for (const controller of this.controllers) controller.abort();
        for (const resolve of this.waiting.splice(0)) resolve();
        await Promise.allSettled(this.requests.values());
        this.memory.clear();
    }
}
