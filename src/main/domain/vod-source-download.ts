export function buildVodSourceDownloadArgs(source: string, startTime: string | null, duration: string | null, totalDurationSeconds = 0): string[] {
    const limit = duration || (Number.isFinite(totalDurationSeconds) && totalDurationSeconds > 0 ? String(totalDurationSeconds) : null);
    return [
        '-hide_banner', '-loglevel', 'error',
        '-live_start_index', '0',
        ...(startTime ? ['-ss', startTime] : []),
        '-i', source,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
        ...(limit ? ['-t', limit] : []),
        '-f', 'mpegts', 'pipe:1',
    ];
}
