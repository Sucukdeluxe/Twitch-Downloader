import * as fs from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Transform } from 'node:stream';
import { createPausableOutput, type PausableOutput } from './pausable-output';
import { DownloadStallTracker, MediaDownloadProgress } from './download-progress';
import { spawnDownloadProcess, killDownloadProcess } from '../infra/download-process';
import { buildVodSnapshotPlaylist, type HlsMediaPlaylist } from './vod-live-snapshot';
import { waitForChildProcessExit } from '../queue/process-registry';

export function planVodTrimSpools(playlist: HlsMediaPlaylist, startSeconds: number, durationSeconds: number | null): {
    text: string; originText: string | null; timelineStartSeconds: number; durationSeconds: number; fragmentedMp4: boolean;
} {
    if (!playlist.segments.length || !Number.isFinite(startSeconds) || startSeconds < 0) throw new Error('VOD source playlist is empty or invalid');
    const end = Math.min(playlist.totalSeconds, durationSeconds === null ? playlist.totalSeconds : startSeconds + durationSeconds);
    let epoch = 0;
    for (let i = 0; i < playlist.segments.length; i++) {
        const segment = playlist.segments[i];
        if (segment.discontinuity && segment.start <= startSeconds + .000001) epoch = i;
        else if (segment.discontinuity && segment.start < end - .000001) {
            throw new Error('Precise VOD range crosses a source timestamp discontinuity');
        }
    }
    const first = playlist.segments[epoch];
    const nextEpoch = playlist.segments.findIndex((segment, index) => index > epoch && segment.discontinuity);
    const last = nextEpoch < 0 ? playlist.segments.length : nextEpoch;
    const epochEnd = nextEpoch < 0 ? playlist.totalSeconds : playlist.segments[nextEpoch].start;
    const localPlaylist: HlsMediaPlaylist = { ...playlist, mediaSequence: first.sequence,
        segments: playlist.segments.slice(epoch, last).map(segment => ({ ...segment, start: segment.start - first.start })),
        totalSeconds: epochEnd - first.start };
    const selected = buildVodSnapshotPlaylist(localPlaylist, startSeconds - first.start, end - startSeconds);
    const prefix = buildVodSnapshotPlaylist(localPlaylist, 0, first.duration);
    return { text: selected.text, originText: selected.firstSequence === first.sequence ? null : prefix.text,
        timelineStartSeconds: startSeconds - first.start, durationSeconds: selected.durationSeconds,
        fragmentedMp4: Boolean(first.map) };
}

export function planVodTrimEpochs(playlist: HlsMediaPlaylist, startSeconds: number, durationSeconds: number | null): ReturnType<typeof planVodTrimSpools>[] {
    const end = Math.min(playlist.totalSeconds, durationSeconds === null ? playlist.totalSeconds : startSeconds + durationSeconds);
    const boundaries = [startSeconds, ...playlist.segments.filter(segment => segment.discontinuity
        && segment.start > startSeconds + .000001 && segment.start < end - .000001).map(segment => segment.start), end];
    return boundaries.slice(0, -1).map((start, index) => planVodTrimSpools(playlist, start, boundaries[index + 1] - start));
}

// A bounded snapshot is close to its requested mark even after the MPEG-TS
// 33-bit clock wraps. Do not mistake a wrap for a request to decode 26 hours.
export function vodSpoolSeekOffset(originSeconds: number, formatStartSeconds: number, timelineStartSeconds: number, fragmentedMp4: boolean): number {
    const offset = originSeconds - formatStartSeconds;
    const wrap = 2 ** 33 / 90000;
    return fragmentedMp4 ? offset : offset - Math.round((timelineStartSeconds + offset) / wrap) * wrap;
}

// Preserve the original decode/presentation clock for the later exact cut.
// The input is an owned, bounded playlist; copying whole selected segments is
// essential because input seeking can discard the only preceding keyframe.
export function buildVodSpoolArgs(snapshot: string, fragmentedMp4 = false): string[] {
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror',
        '-rw_timeout', '30000000', '-protocol_whitelist', 'file,crypto,data,https,tls,tcp,httpproxy',
        '-copyts', '-i', snapshot, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
        '-avoid_negative_ts', 'disabled',
        ...(fragmentedMp4
            // delay_moov preserves the input's first decoding timestamps. An
            // empty_moov starts streams independently and loses their offsets.
            ? ['-movie_timescale', '1000000', '-movflags', '+delay_moov+frag_keyframe+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4']
            : ['-mpegts_copyts', '1', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts']), 'pipe:1'];
}

export interface VodTransferProgress {
    bytes: number; speed: number; seconds: number | null; paused: boolean; stalled: boolean;
}

export async function transferVodSource(options: {
    command: string; args: string[]; outputPath: string; throttle?: Transform; signal?: AbortSignal;
    onReady?: (process: ChildProcessWithoutNullStreams, output: PausableOutput) => (() => void) | void;
    onProgress?: (progress: VodTransferProgress) => void;
    intervalMs?: number; stallAfterMs?: number; stallTimeoutMs?: number;
}): Promise<number> {
    options.signal?.throwIfAborted();
    // Acquire ownership before starting a producer. EEXIST must never enter a
    // cleanup path that could remove somebody else's file.
    const descriptor = fs.openSync(options.outputPath, 'wx');
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnDownloadProcess(options.command, options.args); }
    catch (error) { fs.closeSync(descriptor); fs.rmSync(options.outputPath); throw error; }
    const target = fs.createWriteStream(options.outputPath, { fd: descriptor, autoClose: true });
    const output = createPausableOutput(child.stdout, target, options.throttle);
    const media = new MediaDownloadProgress();
    child.stdout.on('data', (bytes: Buffer) => media.push(bytes));
    let stderr = '', error: Error | undefined, completed = false, childClosed = false, terminationRequested = false;
    const terminate = (): void => {
        if (terminationRequested || childClosed) return;
        terminationRequested = true;
        try { killDownloadProcess(child); }
        catch (failure) { error ??= failure instanceof Error ? failure : new Error(String(failure)); }
    };
    child.stderr.on('data', (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-8192); });
    const closed = new Promise<number | null>(resolve => {
        child.once('error', failure => { error = failure; void output.cancel(); });
        child.once('close', code => { childClosed = true; resolve(code); });
    });
    const outputFinished = output.finished.catch(failure => {
        error = failure instanceof Error ? failure : new Error(String(failure));
        terminate();
    });
    const abort = (): void => {
        error = new Error('VOD transfer cancelled');
        terminate();
        void output.cancel();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    let release: (() => void) | void = undefined;
    let lastBytes = 0, lastTime = Date.now();
    const stall = new DownloadStallTracker(options.stallAfterMs ?? 15000);
    const interval = setInterval(() => {
        const now = Date.now(), bytes = target.bytesWritten;
        const paused = output.isPaused() || Boolean(child.stdout.isPaused() && !child.stdout.readableEnded);
        const state = stall.observe(bytes, now, paused);
        const speed = paused ? 0 : Math.max(0, bytes - lastBytes) / Math.max(.001, (now - lastTime) / 1000);
        lastBytes = bytes; lastTime = now;
        options.onProgress?.({ bytes, speed, seconds: media.seconds, paused, stalled: state.stalled });
        if (state.stalledForMs >= (options.stallTimeoutMs ?? 120000)) {
            error = new Error('VOD source read timeout');
            terminate();
            void output.cancel();
        }
    }, options.intervalMs ?? 1000);
    try {
        release = options.onReady?.(child, output);
        if (options.signal?.aborted) abort();
        const code = await closed;
        await outputFinished;
        if (error) throw error;
        if (code !== 0) throw new Error(stderr || `VOD source transfer exited with ${code}`);
        if (target.bytesWritten <= 0) throw new Error('VOD source transfer produced no media');
        completed = true;
        options.onProgress?.({ bytes: target.bytesWritten, speed: 0, seconds: media.seconds, paused: false, stalled: false });
        return target.bytesWritten;
    } finally {
        clearInterval(interval);
        options.signal?.removeEventListener('abort', abort);
        try {
            if (!completed) {
                terminate();
                await output.cancel();
                if (!childClosed) await waitForChildProcessExit(child);
            }
        } finally {
            try { release?.(); }
            finally { if (!completed) fs.rmSync(options.outputPath, { force: true }); }
        }
    }
}
