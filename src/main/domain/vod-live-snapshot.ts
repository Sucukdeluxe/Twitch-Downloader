import { validateVodMediaUrl } from './vod-playback-service';

export interface HlsMediaSegment {
    uri: string;
    duration: number;
    start: number;
    sequence: number;
    discontinuity: boolean;
    byteRange?: string;
    map?: string;
}

export interface HlsMediaPlaylist {
    url: string;
    ended: boolean;
    targetDuration: number;
    mediaSequence: number;
    segments: HlsMediaSegment[];
    totalSeconds: number;
}

export interface VodSnapshotPlaylist {
    text: string;
    seekSeconds: number;
    durationSeconds: number;
    firstSequence: number;
    segmentCount: number;
}

export type LiveVodWaitReason = 'available' | 'ended' | 'stale' | 'cancelled';

export interface LiveVodWaitOptions {
    load: () => Promise<HlsMediaPlaylist | null>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    shouldContinue: () => Promise<boolean>;
    onWait: (availableSeconds: number) => void;
    staleAfterMs?: number;
}

const EPSILON = 0.0005;
const MAX_PLAYLIST_BYTES = 32 * 1024 * 1024;

export function parseClockSeconds(value: string | null | undefined): number | null {
    if (!value) return null;
    const parts = value.trim().split(':');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1]) || !/^\d{1,2}$/.test(parts[2].split('.')[0]) || !/^\d{0,6}$/.test(parts[2].split('.')[1] ?? '') || parts[2].split('.').length > 2) return null;
    const [hours, minutes, seconds] = parts.map(Number);
    if (minutes >= 60 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
}

function absoluteMediaUrl(value: string, base: string): string {
    return validateVodMediaUrl(new URL(value, base).href).href;
}

export function parseHlsMediaPlaylist(text: string, playlistUrl: string): HlsMediaPlaylist {
    const lines = text.split(/\r?\n/).map(line => line.trim());
    if (lines[0] !== '#EXTM3U') throw new Error('Invalid media playlist');
    let targetDuration = 0;
    let mediaSequence = 0;
    let ended = false;
    let map: string | undefined;
    let pendingDuration: number | null = null;
    let pendingDiscontinuity = false;
    let pendingByteRange: string | undefined;
    let start = 0;
    const segments: HlsMediaSegment[] = [];
    for (const line of lines.slice(1)) {
        if (!line) continue;
        if (line.startsWith('#EXT-X-STREAM-INF')) throw new Error('Expected a media playlist');
        if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.slice(22)) || 0;
        else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number(line.slice(22)) || 0;
        else if (line === '#EXT-X-ENDLIST') ended = true;
        else if (line === '#EXT-X-DISCONTINUITY') pendingDiscontinuity = true;
        else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingByteRange = line.slice(17);
        else if (line.startsWith('#EXT-X-KEY:')) {
            if (!/METHOD=NONE(?:,|$)/.test(line.slice(11))) throw new Error('Encrypted media playlists are not supported');
        } else if (line.startsWith('#EXT-X-MAP:')) {
            const uri = /URI="([^"]+)"/.exec(line)?.[1];
            if (!uri || /BYTERANGE=/.test(line)) throw new Error('Unsupported media initialization section');
            map = absoluteMediaUrl(uri, playlistUrl);
        } else if (line.startsWith('#EXTINF:')) {
            const duration = Number(line.slice(8).split(',')[0]);
            if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid segment duration');
            pendingDuration = duration;
        } else if (!line.startsWith('#')) {
            if (pendingDuration === null) throw new Error('Segment without duration');
            segments.push({
                uri: absoluteMediaUrl(line, playlistUrl),
                duration: pendingDuration,
                start,
                sequence: mediaSequence + segments.length,
                discontinuity: pendingDiscontinuity,
                ...(pendingByteRange ? { byteRange: pendingByteRange } : {}),
                ...(map ? { map } : {}),
            });
            start += pendingDuration;
            pendingDuration = null;
            pendingDiscontinuity = false;
            pendingByteRange = undefined;
        }
    }
    return { url: playlistUrl, ended, targetDuration, mediaSequence, segments, totalSeconds: start };
}

export function buildVodSnapshotPlaylist(playlist: HlsMediaPlaylist, startSeconds: number, durationSeconds: number | null): VodSnapshotPlaylist {
    const start = Math.max(0, startSeconds);
    if (start + EPSILON >= playlist.totalSeconds) throw new Error('Requested range is not available yet');
    const end = durationSeconds === null ? playlist.totalSeconds : Math.min(playlist.totalSeconds, start + Math.max(0, durationSeconds));
    if (end <= start + EPSILON) throw new Error('Requested range is empty');
    let firstIndex = 0;
    for (let index = 0; index < playlist.segments.length; index++) {
        if (playlist.segments[index].start <= start + EPSILON) firstIndex = index;
        else break;
    }
    const selected = playlist.segments.slice(firstIndex).filter(segment => segment.start < end - EPSILON);
    const targetDuration = Math.max(playlist.targetDuration, ...selected.map(segment => Math.ceil(segment.duration)));
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:' + (selected.some(segment => segment.map) ? 6 : 3),
        '#EXT-X-TARGETDURATION:' + targetDuration,
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-MEDIA-SEQUENCE:' + selected[0].sequence,
    ];
    let writtenMap: string | undefined;
    for (const [index, segment] of selected.entries()) {
        if (segment.discontinuity && index > 0) lines.push('#EXT-X-DISCONTINUITY');
        if (segment.map && segment.map !== writtenMap) {
            lines.push(`#EXT-X-MAP:URI="${segment.map}"`);
            writtenMap = segment.map;
        }
        lines.push(`#EXTINF:${segment.duration.toFixed(3)},`);
        if (segment.byteRange) lines.push('#EXT-X-BYTERANGE:' + segment.byteRange);
        lines.push(segment.uri);
    }
    lines.push('#EXT-X-ENDLIST');
    return {
        text: lines.join('\n') + '\n',
        seekSeconds: Math.round(Math.max(0, start - selected[0].start) * 1000) / 1000,
        durationSeconds: Math.round((end - start) * 1000) / 1000,
        firstSequence: selected[0].sequence,
        segmentCount: selected.length,
    };
}

export function buildVodSnapshotDownloadArgs(snapshotPath: string, seekSeconds: number, durationSeconds: number): string[] {
    return [
        '-hide_banner', '-loglevel', 'error', '-xerror',
        '-rw_timeout', '30000000',
        '-protocol_whitelist', 'file,crypto,data,https,tls,tcp,httpproxy',
        ...(seekSeconds > EPSILON ? ['-ss', seekSeconds.toFixed(3)] : []),
        '-i', snapshotPath,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
        '-t', durationSeconds.toFixed(3),
        '-f', 'mpegts', 'pipe:1',
    ];
}

export async function fetchHlsMediaPlaylist(url: string, signal?: AbortSignal): Promise<HlsMediaPlaylist> {
    const source = validateVodMediaUrl(url).href;
    const requestSignal = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    const response = await fetch(source, { signal: requestSignal, redirect: 'error' });
    if (!response.ok) throw new Error(`Media playlist unavailable (${response.status})`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PLAYLIST_BYTES) throw new Error('Media playlist too large');
    const text = await response.text();
    if (text.length > MAX_PLAYLIST_BYTES) throw new Error('Media playlist too large');
    return parseHlsMediaPlaylist(text, source);
}

export async function waitForLiveVodRange(initial: HlsMediaPlaylist, endSeconds: number, options: LiveVodWaitOptions): Promise<{ reason: LiveVodWaitReason; playlist: HlsMediaPlaylist }> {
    const staleAfterMs = options.staleAfterMs ?? 180_000;
    let playlist = initial;
    let lastGrowth = options.now();
    const missing = (): boolean => !playlist.ended && playlist.totalSeconds + EPSILON < endSeconds;
    const proceed = async (): Promise<boolean> => {
        const before = options.now();
        const allowed = await options.shouldContinue();
        if (options.now() - before > 1000) lastGrowth = options.now();
        return allowed;
    };
    while (missing()) {
        if (!(await proceed())) return { reason: 'cancelled', playlist };
        options.onWait(playlist.totalSeconds);
        await options.sleep(Math.max(2000, playlist.targetDuration * 1000));
        if (!(await proceed())) return { reason: 'cancelled', playlist };
        const next = await options.load();
        if (next) {
            if (next.totalSeconds > playlist.totalSeconds + EPSILON || next.ended) lastGrowth = options.now();
            playlist = next;
        }
        if (missing() && options.now() - lastGrowth >= staleAfterMs) return { reason: 'stale', playlist };
    }
    return { reason: playlist.totalSeconds + EPSILON < endSeconds ? 'ended' : 'available', playlist };
}
