import { compareMergeMedia, type MergeCompatibility } from './merge-compatibility';
import { createAudioTimelineFilter } from './audio-processing';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createCutterExportPlan, type CutterHardwareEncoder } from './cutter-export';
import type { CutterProjectSource } from './cutter-project';
import { readVideoSourceFormat } from './media-format';
import { type ExportJobContext, type ExportJobRequest, validateExportJobRequest } from './export-job-queue';

const executeFile = promisify(execFile);
interface ProbeStream extends Record<string, unknown> { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; sample_rate?: string; channel_layout?: string; channels?: number; tags?: { language?: string; rotate?: string }; side_data_list?: Array<Record<string, unknown>>; }
interface MediaProbe { streams: ProbeStream[]; format: { duration?: string; start_time?: string } }
export interface ExportJobRunnerOptions {
    resolveTools(): Promise<{ ffmpeg: string; ffprobe: string }>;
    availableHardwareEncoders?(): Promise<readonly CutterHardwareEncoder[]>;
}
function aborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Export cancelled');
}
async function verifySource(source: CutterProjectSource): Promise<void> {
    const stat = await fs.stat(source.path);
    if (!stat.isFile() || stat.size !== source.size || stat.mtimeMs !== source.mtimeMs) throw new Error('Export source changed: ' + path.basename(source.path));
}
async function probeMedia(ffprobe: string, file: string, signal: AbortSignal): Promise<MediaProbe> {
    aborted(signal);
    const { stdout } = await executeFile(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-show_data_hash', 'SHA256', '-of', 'json', file], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, signal });
    const parsed = JSON.parse(stdout) as MediaProbe;
    if (!Array.isArray(parsed.streams) || !parsed.streams.some(stream => stream.codec_type === 'video') || !parsed.format || !(Number(parsed.format.duration) > 0)) throw new Error('Invalid media: ' + path.basename(file));
    return parsed;
}
function frameRate(video: ProbeStream): number {
    const [numerator, denominator = '1'] = String(video.avg_frame_rate || '').split('/').map(Number);
    const value = numerator / Number(denominator);
    return Number.isFinite(value) && value > 0 ? value : 30;
}
export async function inspectMergeSources(sources: CutterProjectSource[], options: ExportJobRunnerOptions, signal: AbortSignal): Promise<MergeCompatibility> {
    const tools = await options.resolveTools();
    const probes: MediaProbe[] = [];
    for (const source of sources) { await verifySource(source); probes.push(await probeMedia(tools.ffprobe, source.path, signal)); await verifySource(source); }
    return compareMergeMedia(probes, sources.map(source => path.basename(source.path)));
}
export function runExportProcess(ffmpeg: string, args: string[], duration: number, context: ExportJobContext): Promise<void> {
    aborted(context.signal);
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let stdout = '';
        let settled = false;
        const cancel = () => { child.kill(); };
        context.signal.addEventListener('abort', cancel, { once: true });
        if (context.signal.aborted) cancel();
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            context.signal.removeEventListener('abort', cancel);
            if (error) reject(error); else resolve();
        };
        child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            const lines = stdout.split(/\r?\n/); stdout = lines.pop() || '';
            for (const line of lines) {
                const match = /^out_time_us=(\d+)$/.exec(line);
                if (match) context.onProgress(Number(match[1]) / 1000000 / duration * 100);
            }
        });
        child.once('error', error => finish(error));
        child.once('close', code => finish(context.signal.aborted ? new Error('Export cancelled') : code === 0 ? undefined : new Error(stderr.trim() || 'FFmpeg failed (' + code + ')')));
    });
}
async function destinationIdentity(file: string): Promise<string | null> {
    try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Export destination is not a regular file'); return stat.size + ':' + stat.mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function publishOutput(temporary: string, target: string, expected: string | null): Promise<void> {
    if (await destinationIdentity(target) !== expected) throw new Error('Export destination changed while rendering');
    if (expected === null) {
        await fs.link(temporary, target);
        await fs.unlink(temporary);
        return;
    }
    const backup = target + '.' + randomUUID() + '.backup';
    await fs.rename(target, backup);
    try { await fs.rename(temporary, target); }
    catch (error) { await fs.rename(backup, target); throw error; }
    await fs.unlink(backup);
}

export function createExportJobRunner(options: ExportJobRunnerOptions) {
    return async (input: ExportJobRequest, context: ExportJobContext): Promise<{ outputFiles: string[] }> => {
        const request = validateExportJobRequest(input);
        const sources = request.kind === 'cut' ? [request.project.source] : request.sources;
        aborted(context.signal);
        await Promise.all(sources.map(verifySource));
        const expectedDestination = await destinationIdentity(request.outputPath);
        if (expectedDestination !== null && !request.replaceExisting) throw new Error('Export destination already exists');
        const extension = path.extname(request.outputPath).toLowerCase();
        if (!['.mp4', '.mkv', '.mov', '.webm', '.ts'].includes(extension)) throw new Error('Unsupported export container');
        const temporary = path.join(path.dirname(request.outputPath), '.' + path.basename(request.outputPath, extension) + '.' + randomUUID() + '.export' + extension);
        const concatFile = temporary + '.ffconcat';
        const tools = await options.resolveTools();
        const probes: MediaProbe[] = [];
        for (const source of sources) probes.push(await probeMedia(tools.ffprobe, source.path, context.signal));
        let duration: number;
        let args: string[];
        let fallbackArgs: string[] | null = null;
        let expectedAudioTracks: number;
        let expectedVideoFormat: { bitDepth: number; hdr: boolean };
        const firstVideo = probes[0].streams.find(stream => stream.codec_type === 'video')!;
        try {
            if (request.kind === 'cut') {
                const project = request.project;
                const segments: Array<{ start: number; end: number }> = [];
                let position = project.trimStart;
                for (const cut of project.cuts) { if (cut.start > position) segments.push({ start: position, end: cut.start }); position = cut.end; }
                if (position < project.trimEnd) segments.push({ start: position, end: project.trimEnd });
                const audioStreams = probes[0].streams.filter(stream => stream.codec_type === 'audio').map((stream, index) => ({ index, language: stream.tags?.language || null }));
                if (audioStreams.length && !audioStreams.some(stream => stream.index === project.audioStreamIndex)) throw new Error('Audio stream is no longer available');
                const rawRotation = Number(firstVideo.side_data_list?.find(value => value.rotation !== undefined)?.rotation ?? firstVideo.tags?.rotate ?? 0);
                const startTime = Number(probes[0].format.start_time);
                const planOptions = { startTime: Number.isFinite(startTime) ? startTime : 0, inputFile: sources[0].path, outputFile: temporary, segments, hasAudio: audioStreams.length > 0, profile: project.profile, encoder: project.encoder,
                    availableHardwareEncoders: await options.availableHardwareEncoders?.() || [], audioStreamIndex: project.audioStreamIndex,
                    audioStreamIndices: project.allAudioStreams ? audioStreams.map(stream => stream.index) : undefined, audioStreams,
                    audioProcessing: project.audioProcessing, sourceFormat: readVideoSourceFormat(firstVideo), colorMode: project.colorMode || 'source', rotation: rawRotation };
                const plan = createCutterExportPlan(planOptions);
                args = plan.ffmpegArgs; duration = plan.remainingDuration;
                expectedAudioTracks = plan.audioStreamIndices.length;
                expectedVideoFormat = plan;
                if (['h264_nvenc', 'h264_qsv', 'h264_amf'].includes(plan.selectedEncoder)) fallbackArgs = createCutterExportPlan({ ...planOptions, encoder: 'software' }).ffmpegArgs;
            } else {
                duration = probes.reduce((sum, probe) => sum + Number(probe.format.duration), 0);
                expectedAudioTracks = probes[0].streams.filter(stream => stream.codec_type === 'audio').length;
                expectedVideoFormat = request.mode === 'copy' ? readVideoSourceFormat(firstVideo) : { bitDepth: 8, hdr: false };
                if (request.mode === 'copy') {
                    if (!compareMergeMedia(probes, sources.map(source => path.basename(source.path))).copyAllowed) throw new Error('Merge sources require encoding');
                    await fs.writeFile(concatFile, 'ffconcat version 1.0\n' + sources.map(source => "file '" + source.path.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n'), 'utf8');
                    args = ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-map', '0', '-c', 'copy', '-progress', 'pipe:1', '-nostats', temporary];
                } else {
                    if (!compareMergeMedia(probes, sources.map(source => path.basename(source.path))).encodeAllowed) throw new Error('Merge encoding would discard source information');
                    const videos = probes.map(probe => probe.streams.find(stream => stream.codec_type === 'video')!);
                    if (videos.some(video => readVideoSourceFormat(video).hdr || readVideoSourceFormat(video).bitDepth !== 8 || !['yuv420p', 'yuvj420p'].includes(String(video.pix_fmt)))) throw new Error('Merge encoding requires matching SDR 8-bit sources');
                    const width = Number(firstVideo.width); const height = Number(firstVideo.height); const fps = frameRate(firstVideo);
                    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width % 2 || height % 2) throw new Error('Invalid merge resolution');
                    const audios = probes.map(probe => probe.streams.filter(stream => stream.codec_type === 'audio'));
                    if (!audios.every(streams => streams.length === audios[0].length)) throw new Error('Merge sources have different audio track counts');
                    const filters: string[] = [];
                    for (let i = 0; i < sources.length; i++) {
                        filters.push('[' + i + ':v:0]setpts=PTS-STARTPTS,scale=' + width + ':' + height + ':force_original_aspect_ratio=decrease,pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=' + fps + ',format=yuv420p[v' + i + ']');
                        for (let a = 0; a < audios[0].length; a++) {
                            const layout = audios[0][a].channel_layout || (audios[0][a].channels === 1 ? 'mono' : audios[0][a].channels === 2 ? 'stereo' : '');
                            if (!/^[a-z0-9.()+-]+$/i.test(layout)) throw new Error('Unsupported merge channel layout');
                            filters.push('[' + i + ':a:' + a + ']' + createAudioTimelineFilter(48000) + ',aformat=sample_fmts=fltp:channel_layouts=' + layout + '[a' + i + '_' + a + ']');
                        }
                    }
                    const labels = sources.map((_, i) => '[v' + i + ']' + audios[0].map((_, a) => '[a' + i + '_' + a + ']').join('')).join('');
                    filters.push(labels + 'concat=n=' + sources.length + ':v=1:a=' + audios[0].length + '[vout]' + audios[0].map((_, a) => '[aout' + a + ']').join(''));
                    args = ['-hide_banner', '-nostdin', '-y', '-copyts', ...sources.flatMap((source, index) => {
                        const start = Number(videos[index].start_time ?? probes[index].format.start_time);
                        return ['-itsoffset', String(Number.isFinite(start) ? -start : 0), '-i', source.path];
                    }), '-filter_complex', filters.join(';'), '-map', '[vout]', ...audios[0].flatMap((_, a) => ['-map', '[aout' + a + ']']), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', ...audios[0].flatMap((stream, index) => /^[a-z]{2,3}$/i.test(stream.tags?.language || '') ? ['-metadata:s:a:' + index, 'language=' + stream.tags!.language] : []), '-progress', 'pipe:1', '-nostats', temporary];
                }
            }
            try { await runExportProcess(tools.ffmpeg, args, duration, context); }
            catch (error) { if (!fallbackArgs || context.signal.aborted) throw error; await runExportProcess(tools.ffmpeg, fallbackArgs, duration, context); }
            aborted(context.signal);
            await Promise.all(sources.map(verifySource));
            if ((await fs.stat(temporary)).size < 256) throw new Error('Export output is incomplete');
            const output = await probeMedia(tools.ffprobe, temporary, context.signal);
            const outputVideo = readVideoSourceFormat(output.streams.find(stream => stream.codec_type === 'video')!);
            if (output.streams.filter(stream => stream.codec_type === 'audio').length !== expectedAudioTracks) throw new Error('Export audio tracks are incomplete');
            if (expectedVideoFormat && (outputVideo.bitDepth < expectedVideoFormat.bitDepth || outputVideo.hdr !== expectedVideoFormat.hdr)) throw new Error('Export color format differs from the source selection');
            const tolerance = request.kind === 'cut' ? Math.max(0.12, 3 / frameRate(firstVideo)) : Math.max(0.25, sources.length * 3 / frameRate(firstVideo));
            if (Math.abs(Number(output.format.duration) - duration) > tolerance) throw new Error('Export duration differs from the selected range');
            aborted(context.signal);
            await publishOutput(temporary, request.outputPath, expectedDestination);
            return { outputFiles: [request.outputPath] };
        } finally {
            await fs.rm(temporary, { force: true });
            await fs.rm(concatFile, { force: true });
        }
    };
}
