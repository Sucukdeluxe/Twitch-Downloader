import { spawn } from 'node:child_process';

export interface GrabbedFrame { time: number; jpeg: Buffer | null }
export interface FrameGrabOptions {
    ffmpegPath: string;
    input: string;
    inputArgs?: string[];
    times: number[];
    width: number;
    signal: AbortSignal;
    onProcess?(command: string): void;
    timeoutMs?: number;
}

export const MAX_FRAMES_PER_REQUEST = 12;
export const MIN_FRAME_WIDTH = 160;
export const MAX_FRAME_WIDTH = 1280;
const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const PARALLEL_FRAMES = 3;

function grabFrame(options: FrameGrabOptions, time: number): Promise<Buffer | null> {
    return new Promise(resolve => {
        if (options.signal.aborted) { resolve(null); return; }
        options.onProcess?.(options.ffmpegPath);
        const child = spawn(options.ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostdin', ...(options.inputArgs ?? []),
            '-ss', time.toFixed(3), '-i', options.input, '-frames:v', '1', '-an', '-sn', '-dn',
            '-vf', `scale=${options.width}:-2`, '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
        const timer = setTimeout(stop, options.timeoutMs ?? 45000);
        options.signal.addEventListener('abort', stop, { once: true });
        child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_FRAME_BYTES) stop();
            else chunks.push(chunk);
        });
        child.once('error', () => finish(null));
        child.once('close', code => {
            const jpeg = Buffer.concat(chunks);
            finish(code === 0 && jpeg.length > 3 && jpeg[0] === 0xFF && jpeg[1] === 0xD8 ? jpeg : null);
        });
    });
}

export async function grabFrames(options: FrameGrabOptions): Promise<GrabbedFrame[]> {
    const width = Math.max(MIN_FRAME_WIDTH, Math.min(MAX_FRAME_WIDTH, Math.round(options.width / 2) * 2));
    const times = options.times.slice(0, MAX_FRAMES_PER_REQUEST);
    const frames: GrabbedFrame[] = times.map(time => ({ time, jpeg: null }));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PARALLEL_FRAMES, times.length) }, async () => {
        while (next < times.length && !options.signal.aborted) {
            const index = next++;
            frames[index].jpeg = await grabFrame({ ...options, width }, times[index]);
        }
    }));
    return frames;
}
