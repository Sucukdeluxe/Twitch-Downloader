import { spawn } from 'node:child_process';

export interface GrabbedFrame { time: number; jpeg: Buffer | null }
export interface FrameSource {
    ffmpegPath: string;
    input: string;
    inputArgs?: string[];
    signal: AbortSignal;
    onProcess?(command: string): void;
    timeoutMs?: number;
}
export interface FrameGrabOptions extends FrameSource { times: number[]; width: number }
export interface RawFrameGrabOptions extends FrameSource { times: number[]; width: number; height: number; parallel?: number }
export interface ImageCodecOptions { ffmpegPath: string; signal: AbortSignal; onProcess?(command: string): void }

export const MAX_FRAMES_PER_REQUEST = 12;
export const MIN_FRAME_WIDTH = 160;
export const MAX_FRAME_WIDTH = 1280;
export const MAX_SCAN_FRAMES = 160;
const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const MAX_SHEET_BYTES = 8 * 1024 * 1024;
const PARALLEL_FRAMES = 3;
const PARALLEL_RAW_FRAMES = 6;
const QUALITY_LADDER = ['160p', '160p30', '360p', '360p30', '480p', '480p30', '720p', '720p30', '720p60', '1080p', '1080p60', 'source'];

export function qualitiesForWidth(width: number): string[] {
    const first = width <= 256 ? '160p' : width <= 480 ? '360p' : width <= 720 ? '480p' : width <= 1024 ? '720p' : '1080p';
    const start = QUALITY_LADDER.indexOf(first);
    return [...QUALITY_LADDER.slice(start), ...QUALITY_LADDER.slice(0, start).reverse()];
}

function runBinary(command: string, args: string[], options: { input?: Buffer; maxBytes: number; timeoutMs: number; signal: AbortSignal; onProcess?(command: string): void }): Promise<Buffer | null> {
    return new Promise(resolve => {
        if (options.signal.aborted) { resolve(null); return; }
        options.onProcess?.(command);
        const child = spawn(command, args, { windowsHide: true, stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
        const chunks: Buffer[] = [];
        let bytes = 0, settled = false;
        const finish = (value: Buffer | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal.removeEventListener('abort', stop);
            resolve(value);
        };
        const stop = (): void => { child.kill(); finish(null); };
        const timer = setTimeout(stop, options.timeoutMs);
        options.signal.addEventListener('abort', stop, { once: true });
        child.stdout!.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > options.maxBytes) stop();
            else chunks.push(chunk);
        });
        if (options.input) {
            child.stdin!.once('error', () => undefined);
            child.stdin!.end(options.input);
        }
        child.once('error', () => finish(null));
        child.once('close', code => finish(code === 0 ? Buffer.concat(chunks) : null));
    });
}

function isJpeg(data: Buffer | null): data is Buffer {
    return data !== null && data.length > 3 && data[0] === 0xFF && data[1] === 0xD8;
}

async function inParallel<T>(count: number, parallel: number, signal: AbortSignal, task: (index: number) => Promise<T>, fallback: T): Promise<T[]> {
    const results: T[] = Array.from({ length: count }, () => fallback);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, count) }, async () => {
        while (next < count && !signal.aborted) {
            const index = next++;
            results[index] = await task(index);
        }
    }));
    return results;
}

export async function grabFrames(options: FrameGrabOptions): Promise<GrabbedFrame[]> {
    const width = Math.max(MIN_FRAME_WIDTH, Math.min(MAX_FRAME_WIDTH, Math.round(options.width / 2) * 2));
    const times = options.times.slice(0, MAX_FRAMES_PER_REQUEST);
    const frames = await inParallel<Buffer | null>(times.length, PARALLEL_FRAMES, options.signal, async (index) => {
        const jpeg = await runBinary(options.ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostdin', ...(options.inputArgs ?? []),
            '-ss', times[index].toFixed(3), '-i', options.input, '-frames:v', '1', '-an', '-sn', '-dn',
            '-vf', `scale=${width}:-2`, '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
        ], { maxBytes: MAX_FRAME_BYTES, timeoutMs: options.timeoutMs ?? 45000, signal: options.signal, onProcess: options.onProcess });
        return isJpeg(jpeg) ? jpeg : null;
    }, null);
    return times.map((time, index) => ({ time, jpeg: frames[index] }));
}

export function grabRawFrames(options: RawFrameGrabOptions): Promise<Array<Buffer | null>> {
    const { width, height } = options;
    const times = options.times.slice(0, MAX_SCAN_FRAMES);
    const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
    return inParallel<Buffer | null>(times.length, options.parallel ?? PARALLEL_RAW_FRAMES, options.signal, async (index) => {
        const raw = await runBinary(options.ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostdin', ...(options.inputArgs ?? []),
            '-ss', times[index].toFixed(3), '-i', options.input, '-frames:v', '1', '-an', '-sn', '-dn',
            '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
        ], { maxBytes: width * height * 3, timeoutMs: options.timeoutMs ?? 45000, signal: options.signal, onProcess: options.onProcess });
        return raw && raw.length === width * height * 3 ? raw : null;
    }, null);
}

export async function encodeJpeg(image: { width: number; height: number; rgb: Buffer }, options: ImageCodecOptions): Promise<Buffer | null> {
    if (image.rgb.length !== image.width * image.height * 3) return null;
    const jpeg = await runBinary(options.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${image.width}x${image.height}`, '-i', 'pipe:0',
        '-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { input: image.rgb, maxBytes: MAX_SHEET_BYTES, timeoutMs: 30000, signal: options.signal, onProcess: options.onProcess });
    return isJpeg(jpeg) ? jpeg : null;
}

export async function decodeToRgb(jpeg: Buffer, width: number, height: number, options: ImageCodecOptions): Promise<Buffer | null> {
    const raw = await runBinary(options.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', 'pipe:0',
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { input: jpeg, maxBytes: width * height * 3, timeoutMs: 30000, signal: options.signal, onProcess: options.onProcess });
    return raw && raw.length === width * height * 3 ? raw : null;
}
