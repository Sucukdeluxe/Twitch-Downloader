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
