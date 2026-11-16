import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runMediaProcess } from '../domain/media-process';
import { frameRatesMatch } from '../domain/merge-compatibility';

export interface ComposeSegmentInput { path: string; start?: number | null; end?: number | null }
export interface ComposeSegment { path: string; start: number; end: number; whole: boolean }
export interface ComposeProbe { streams: Array<Record<string, unknown>>; format: { duration?: string } }
export interface ComposeSourceInfo { path: string; duration: number; size: number; probe: ComposeProbe }
export interface ComposePlan { segments: ComposeSegment[]; duration: number; estimatedBytes: number; temporaryBytes: number }
export interface ComposeOptions {
    segments: ComposeSegmentInput[];
    outputPath: string;
    ffmpegPath: string;
    ffprobePath: string;
    signal: AbortSignal;
    onProgress(percent: number): void;
    checkSpace(directory: string, bytes: number): void;
}
export interface ComposeResult { outputPath: string; duration: number; bytes: number }

export class ComposeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ComposeError';
    }
}

export const MAX_COMPOSE_SEGMENTS = 200;
const WHOLE_FILE_TOLERANCE_SECONDS = 0.05;
const MIN_SEGMENT_SECONDS = 1;
const PROCESS_TIMEOUT_MS = 12 * 60 * 60 * 1000;

function sameFile(left: string, right: string): boolean {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export async function probeComposeSource(ffprobePath: string, file: string, signal: AbortSignal): Promise<ComposeSourceInfo> {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) throw new ComposeError(`Source file not found: ${path.basename(file)}`);
    let probe: ComposeProbe;
    try {
        probe = JSON.parse(await runMediaProcess(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-show_data_hash', 'SHA256', '-of', 'json', file], { signal, timeoutMs: 120000 })) as ComposeProbe;
    } catch (error) {
        if (signal.aborted) throw error;
        throw new ComposeError(`Source file is not readable as video: ${path.basename(file)}`);
    }
    const duration = Number(probe?.format?.duration);
    if (!Array.isArray(probe?.streams) || !probe.streams.some(stream => stream.codec_type === 'video') || !Number.isFinite(duration) || duration <= 0) {
        throw new ComposeError(`Source file contains no usable video: ${path.basename(file)}`);
    }
    return { path: file, duration, size: stat.size, probe };
}

export function planCompose(inputs: ComposeSegmentInput[], sources: ComposeSourceInfo[]): ComposePlan {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new ComposeError('At least one segment is required.');
    if (inputs.length > MAX_COMPOSE_SEGMENTS) throw new ComposeError(`No more than ${MAX_COMPOSE_SEGMENTS} segments are supported.`);
    const differences = formatDifferences(sources);
    if (differences.length) {
        throw new ComposeError(`The sources cannot be joined without re-encoding because their formats differ (${differences.join(', ')}).`);
    }
    let estimatedBytes = 0, temporaryBytes = 0, duration = 0;
    const segments = inputs.map((input, index): ComposeSegment => {
        const source = sources.find(candidate => sameFile(candidate.path, input.path));
        if (!source) throw new ComposeError(`Segment ${index + 1} refers to an unknown source.`);
        const name = path.basename(source.path);
        const start = input.start ?? 0;
        let end = input.end ?? source.duration;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) throw new ComposeError(`Segment ${index + 1} (${name}) has an invalid time range.`);
        if (end > source.duration && end <= source.duration + 1) end = source.duration;
        if (end > source.duration) throw new ComposeError(`Segment ${index + 1} ends after the end of ${name} (${source.duration.toFixed(3)} s).`);
        if (end - start < MIN_SEGMENT_SECONDS) throw new ComposeError(`Segment ${index + 1} (${name}) is shorter than ${MIN_SEGMENT_SECONDS} second.`);
        const whole = start <= WHOLE_FILE_TOLERANCE_SECONDS && end >= source.duration - WHOLE_FILE_TOLERANCE_SECONDS;
        const bytes = Math.ceil(source.size * (end - start) / source.duration);
        estimatedBytes += bytes;
        if (!whole) temporaryBytes += bytes;
        duration += end - start;
        return { path: source.path, start: whole ? 0 : start, end: whole ? source.duration : end, whole };
    });
    return { segments, duration, estimatedBytes, temporaryBytes };
}

const VIDEO_FORMAT_FIELDS = ['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'extradata_hash'] as const;
const AUDIO_FORMAT_FIELDS = ['codec_name', 'profile', 'sample_rate', 'channels', 'channel_layout', 'extradata_hash'] as const;
const FORMAT_LABELS: Record<string, string> = {
    codec_name: 'codec', profile: 'codec profile', width: 'width', height: 'height', pix_fmt: 'pixel format', extradata_hash: 'encoder settings',
    sample_rate: 'audio sample rate', channels: 'audio channels', channel_layout: 'audio channel layout',
};

function frameRate(stream: Record<string, unknown>): number {
    const [numerator, denominator = 1] = String(stream.avg_frame_rate || '0').split('/').map(Number);
    return denominator ? numerator / denominator : 0;
}

export function formatDifferences(sources: ComposeSourceInfo[]): string[] {
    const differences = new Set<string>();
    const layout = (source: ComposeSourceInfo) => ({
        video: source.probe.streams.find(stream => stream.codec_type === 'video')!,
        audio: source.probe.streams.filter(stream => stream.codec_type === 'audio'),
    });
    const base = layout(sources[0]);
    for (const source of sources.slice(1)) {
        const current = layout(source);
        for (const field of VIDEO_FORMAT_FIELDS) if (base.video[field] !== current.video[field]) differences.add('video ' + FORMAT_LABELS[field]);
        const rates = [frameRate(base.video), frameRate(current.video)];
        if (rates[0] > 0 && rates[1] > 0 && !frameRatesMatch(rates[0], rates[1])) differences.add('frame rate');
        if (base.audio.length !== current.audio.length) { differences.add('number of audio tracks'); continue; }
        for (const [index, track] of base.audio.entries()) {
            for (const field of AUDIO_FORMAT_FIELDS) if (track[field] !== current.audio[index][field]) differences.add(FORMAT_LABELS[field].startsWith('audio') ? FORMAT_LABELS[field] : 'audio ' + FORMAT_LABELS[field]);
        }
    }
    return [...differences];
}

export function concatListEntry(file: string): string {
    return "file '" + file.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
}

function trackProgress(onSeconds: (seconds: number) => void) {
    return (process: import('node:child_process').ChildProcess): void => {
        let buffer = '';
        process.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                const match = /^out_time_us=(\d+)$/.exec(line);
                if (match) onSeconds(Number(match[1]) / 1000000);
            }
        });
    };
}

async function publish(temporary: string, target: string): Promise<void> {
    try {
        await fs.link(temporary, target);
        await fs.unlink(temporary);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || '';
        if (code === 'EEXIST') throw new ComposeError(`Output file already exists: ${path.basename(target)}`);
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP', 'ENOSYS'].includes(code)) throw error;
        const handle = await fs.open(target, 'wx').catch((openError: NodeJS.ErrnoException) => {
            if (openError.code === 'EEXIST') throw new ComposeError(`Output file already exists: ${path.basename(target)}`);
            throw openError;
        });
        await handle.close();
        await fs.rename(temporary, target);
    }
}

export async function composeLossless(options: ComposeOptions): Promise<ComposeResult> {
    const target = path.resolve(options.outputPath);
    if (path.extname(target).toLowerCase() !== '.mp4') throw new ComposeError('The output file must be an MP4 file.');
    if (await fs.stat(target).then(() => true, () => false)) throw new ComposeError(`Output file already exists: ${path.basename(target)}`);
    const distinct = options.segments.map(segment => path.resolve(segment.path)).filter((file, index, all) => all.findIndex(other => sameFile(other, file)) === index);
    if (distinct.some(file => sameFile(file, target))) throw new ComposeError('The output file must differ from every source file.');
    const sources: ComposeSourceInfo[] = [];
    for (const file of distinct) sources.push(await probeComposeSource(options.ffprobePath, file, options.signal));
    const plan = planCompose(options.segments, sources);
    const directory = path.dirname(target);
    await fs.mkdir(directory, { recursive: true });
    options.checkSpace(directory, plan.estimatedBytes + plan.temporaryBytes + 64 * 1024 * 1024);
    const workspace = path.join(directory, '.mcp-compose-' + randomUUID());
    await fs.mkdir(workspace);
    const totalWork = plan.duration + plan.segments.filter(segment => !segment.whole).reduce((sum, segment) => sum + segment.end - segment.start, 0);
    let finishedWork = 0;
    const report = (seconds: number, length: number): void => options.onProgress(Math.min(99, (finishedWork + Math.max(0, Math.min(length, seconds))) / totalWork * 100));
    try {
        const inputs: string[] = [];
        for (const [index, segment] of plan.segments.entries()) {
            if (segment.whole) { inputs.push(segment.path); continue; }
            const length = segment.end - segment.start;
            const extracted = path.join(workspace, 'segment-' + String(index).padStart(4, '0') + '.mp4');
            await runMediaProcess(options.ffmpegPath, [
                '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', segment.start.toFixed(3), '-i', segment.path, '-t', length.toFixed(3),
                '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-progress', 'pipe:1', '-nostats', '-y', extracted,
            ], { signal: options.signal, timeoutMs: PROCESS_TIMEOUT_MS, onProcess: trackProgress(seconds => report(seconds, length)) });
            finishedWork += length;
            inputs.push(extracted);
        }
        const temporary = path.join(workspace, 'output.mp4');
        if (inputs.length === 1 && plan.segments[0].whole) {
            throw new ComposeError('A single complete file needs no processing. Add more segments or a time range.');
        }
        const listFile = path.join(workspace, 'concat.ffconcat');
        await fs.writeFile(listFile, 'ffconcat version 1.0\n' + inputs.map(concatListEntry).join('\n') + '\n', 'utf8');
        await runMediaProcess(options.ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listFile,
            '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-y', temporary,
        ], { signal: options.signal, timeoutMs: PROCESS_TIMEOUT_MS, onProcess: trackProgress(seconds => report(seconds, plan.duration)) });
        const output = await probeComposeSource(options.ffprobePath, temporary, options.signal);
        const partialSegments = plan.segments.filter(segment => !segment.whole).length;
        const tolerance = Math.max(2, plan.duration * 0.002) + partialSegments * 10;
        if (Math.abs(output.duration - plan.duration) > tolerance) {
            throw new ComposeError(`The output is ${output.duration.toFixed(1)} s long, expected ${plan.duration.toFixed(1)} s.`);
        }
        if (options.signal.aborted) throw new Error('Media operation cancelled');
        await publish(temporary, target);
        options.onProgress(100);
        return { outputPath: target, duration: output.duration, bytes: output.size };
    } finally {
        await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
}
