import { runMediaProcess, type MediaProcessOptions } from './media-process';
import { resolveVodPlaybackSource, vodQualityStreamArg, TWITCH_VIDEO_CODEC_ARGS } from './vod-quality';
import { validateVodMediaUrl } from './vod-playback-service';

// Resolve the playlist, not a segment-rounded excerpt. FFmpeg then seeks on
// the same media timeline as the player, including for ordinary 1080p VODs.
export async function resolveVodTrimSource(options: {
    url: string;
    quality: string;
    streamlink: () => Promise<{ command: string; prefixArgs: string[] }>;
    signal: AbortSignal;
    onProcess?: MediaProcessOptions['onProcess'];
}): Promise<string> {
    options.signal.throwIfAborted();
    const direct = await resolveVodPlaybackSource(options.url, options.quality, options.signal);
    options.signal.throwIfAborted();
    if (direct) return validateVodMediaUrl(direct).href;
    const tool = await options.streamlink();
    options.signal.throwIfAborted();
    const source = await runMediaProcess(tool.command, [
        ...tool.prefixArgs, ...TWITCH_VIDEO_CODEC_ARGS, '--loglevel', 'none', '--stream-url',
        options.url, vodQualityStreamArg(options.quality),
    ], { signal: options.signal, timeoutMs: 60000, onProcess: options.onProcess });
    options.signal.throwIfAborted();
    return validateVodMediaUrl(source.trim()).href;
}

export function buildVodSourceDownloadArgs(source: string, startTime: string | null, duration: string | null, totalDurationSeconds = 0): string[] {
    const limit = duration || (Number.isFinite(totalDurationSeconds) && totalDurationSeconds > 0 ? String(totalDurationSeconds) : null);
    return [
        '-hide_banner', '-loglevel', 'error', '-xerror',
        '-rw_timeout', '30000000',
        '-live_start_index', '0',
        ...(startTime ? ['-ss', startTime] : []),
        '-i', source,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
        ...(limit ? ['-t', limit] : []),
        '-f', 'mpegts', 'pipe:1',
    ];
}

export function isVodSourceReadTimeout(stderr: string): boolean {
    return /error number -138|timed out|timeout/i.test(stderr);
}
