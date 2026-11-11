import { fetchTopClipsPage, rangeLastDays, type FetchTopClipsOptions, type TopClipsPage } from './top-clips-crawler';

export interface ClipDiscoveryRequest { channel: string; days?: 1 | 7 | 30 | 90; since?: string; until?: string; cursor?: string }
export interface DiscoveredClip { id: string; url: string; title: string; channel: string; createdAt: string; duration: number; views: number; downloaded: boolean }
export interface ClipDiscoveryResult { status: 'success' | 'auth-required' | 'not-found'; clips: DiscoveredClip[]; cursor: string | null }
export interface ClipDiscoveryDependencies {
    credentials(): Promise<{ clientId: string; accessToken: string } | null>;
    userId(channel: string): Promise<string | null>;
    downloaded(clipId: string): boolean;
    fetchPage?: (options: FetchTopClipsOptions) => Promise<TopClipsPage>;
    now?: () => Date;
}

export function normalizeClipDiscoveryChannel(input: unknown): string {
    if (typeof input !== 'string' || input.length > 300) throw new Error('Invalid channel');
    let channel = input.trim();
    if (/^https?:\/\//i.test(channel)) {
        const url = new URL(channel);
        if (!['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Invalid channel');
        channel = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    }
    if (!/^[a-zA-Z0-9_]{1,25}$/.test(channel)) throw new Error('Invalid channel');
    return channel.toLowerCase();
}

function localBoundary(value: string, end: boolean): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date range');
    const date = new Date(value + 'T00:00:00');
    const [year, month, day] = value.split('-').map(Number);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) throw new Error('Invalid date range');
    if (end) date.setDate(date.getDate() + 1);
    return date;
}

export async function discoverClips(request: ClipDiscoveryRequest, deps: ClipDiscoveryDependencies): Promise<ClipDiscoveryResult> {
    const channel = normalizeClipDiscoveryChannel(request?.channel);
    if (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 1024)) throw new Error('Invalid cursor');
    let range;
    if (request.since || request.until) {
        const start = localBoundary(request.since || '', false);
        const end = localBoundary(request.until || '', true);
        if (end <= start || end.getTime() - start.getTime() > 367 * 86400000) throw new Error('Invalid date range');
        range = { startedAt: start.toISOString(), endedAt: end.toISOString() };
    } else {
        if (request.days !== undefined && ![1, 7, 30, 90].includes(request.days)) throw new Error('Invalid date range');
        range = rangeLastDays(request.days ?? 7, deps.now?.() ?? new Date());
    }
    const credentials = await deps.credentials();
    if (!credentials) return { status: 'auth-required', clips: [], cursor: null };
    const broadcasterId = await deps.userId(channel);
    if (!broadcasterId) return { status: 'not-found', clips: [], cursor: null };
    const result = await (deps.fetchPage ?? fetchTopClipsPage)({ ...credentials, broadcasterId, ...range, first: 100, after: request.cursor });
    const seen = new Set<string>();
    const clips: DiscoveredClip[] = [];
    for (const clip of result.clips) {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(clip.id) || seen.has(clip.id)) continue;
        seen.add(clip.id);
        clips.push({
            id: clip.id, url: 'https://clips.twitch.tv/' + clip.id,
            title: typeof clip.title === 'string' ? clip.title.trim().slice(0, 4096) : '',
            channel: typeof clip.broadcasterName === 'string' ? clip.broadcasterName.slice(0, 100) : channel,
            createdAt: typeof clip.createdAt === 'string' && Number.isFinite(Date.parse(clip.createdAt)) ? clip.createdAt : '',
            duration: Number.isFinite(clip.duration) ? Math.max(0, clip.duration) : 0,
            views: Number.isSafeInteger(clip.viewCount) ? Math.max(0, clip.viewCount) : 0,
            downloaded: deps.downloaded(clip.id),
        });
    }
    return { status: 'success', clips, cursor: result.cursor === request.cursor ? null : result.cursor };
}
