import { runMediaProcess, type MediaProcessOptions } from './media-process';
import { Mp4ProgressTracker } from './mp4-progress';
import type { Mp4FinalizationProgress } from '../../types';

export interface Mp4RemuxOptions extends MediaProcessOptions {
    inputPath: string;
    outputPath: string;
    ffmpegPath: string;
    ffprobePath: string;
    durationSeconds?: number;
    onProgress?: (progress: Mp4FinalizationProgress) => void;
}

export async function remuxMp4(options: Mp4RemuxOptions): Promise<void> {
    let duration = options.durationSeconds;
    if (!(duration && Number.isFinite(duration) && duration > 0)) {
        const raw = await runMediaProcess(options.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', options.inputPath], options);
        duration = Number((JSON.parse(raw) as { format?: { duration?: string } }).format?.duration);
    }
    const tracker = new Mp4ProgressTracker(duration, progress => options.onProgress?.(progress));
    tracker.setStage('writing');
    await runMediaProcess(options.ffmpegPath, [
        '-hide_banner', '-loglevel', 'info', '-nostdin', '-nostats', '-stats_period', '0.25', '-progress', 'pipe:1', '-i', options.inputPath,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero', '-f', 'mp4', '-y', options.outputPath,
    ], { ...options, timeoutMs: options.timeoutMs ?? 30 * 60 * 1000, onProcess: process => {
        let stderr = '';
        const onOutput = (chunk: Buffer): void => tracker.push(chunk.toString());
        const onError = (chunk: Buffer): void => {
            stderr = (stderr + chunk.toString()).slice(-2048);
            if (/Starting second pass: moving the moov atom/.test(stderr)) { tracker.setStage('optimizing'); stderr = ''; }
        };
        process.stdout?.on('data', onOutput);
        process.stderr?.on('data', onError);
        const release = options.onProcess?.(process);
        return () => { process.stdout?.off('data', onOutput); process.stderr?.off('data', onError); release?.(); };
    } });
    tracker.setStage('verifying');
    const raw = await runMediaProcess(options.ffprobePath, [
        '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type',
        '-of', 'json', options.outputPath,
    ], options);
    const probe = JSON.parse(raw) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string }> };
    if (!probe.format?.format_name?.split(',').includes('mp4')
        || !(Number(probe.format.duration) > 0)
        || !probe.streams?.some((stream) => stream.codec_type === 'video')) {
        throw new Error('Invalid MP4 output');
    }
}
