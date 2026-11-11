// Twitch Helix Top-Clips Crawler. Pure: fetch wird via injizierter fetchImpl
// aufgerufen (Tests koennen mocken). Helix-Endpunkt:
//   GET https://api.twitch.tv/helix/clips?broadcaster_id=X&first=N
//
// Auth: Client-Credentials (app-token) reicht — kein User-Token noetig.
// Spaeter koennen wir aus token-store den default-Twitch-User-Token nehmen.

const HELIX_CLIPS_URL = 'https://api.twitch.tv/helix/clips';

export interface TopClip {
    id: string;
    url: string;
    embedUrl: string;
    broadcasterId: string;
    broadcasterName: string;
    creatorId: string;
    creatorName: string;
    videoId: string;
    gameId: string;
    language: string;
    title: string;
    viewCount: number;
    createdAt: string;       // ISO timestamp
    thumbnailUrl: string;
    duration: number;        // seconds
    vodOffsetSeconds: number | null;
}

interface HelixClipRow {
    id: string;
    url: string;
    embed_url: string;
    broadcaster_id: string;
    broadcaster_name: string;
    creator_id: string;
    creator_name: string;
    video_id: string;
    game_id: string;
    language: string;
    title: string;
    view_count: number;
    created_at: string;
    thumbnail_url: string;
    duration: number;
    vod_offset?: number | null;
}

interface HelixClipsResponse {
    data?: HelixClipRow[];
    pagination?: { cursor?: string };
}

export interface FetchTopClipsOptions {
    clientId: string;
    accessToken: string;
    broadcasterId: string;
    startedAt?: string;       // ISO RFC3339
    endedAt?: string;
    first?: number;           // 1-100, default 20
    fetchImpl?: typeof fetch;
    after?: string;
    signal?: AbortSignal;
}

function rowToClip(row: HelixClipRow): TopClip {
    return {
        id: row.id,
        url: row.url,
        embedUrl: row.embed_url,
        broadcasterId: row.broadcaster_id,
        broadcasterName: row.broadcaster_name,
        creatorId: row.creator_id,
        creatorName: row.creator_name,
        videoId: row.video_id,
        gameId: row.game_id,
        language: row.language,
        title: row.title,
        viewCount: row.view_count,
        createdAt: row.created_at,
        thumbnailUrl: row.thumbnail_url,
        duration: row.duration,
        vodOffsetSeconds: row.vod_offset ?? null,
    };
}

export interface TopClipsPage { clips: TopClip[]; cursor: string | null }

export async function fetchTopClips(opts: FetchTopClipsOptions): Promise<TopClip[]> {
    return (await fetchTopClipsPage(opts)).clips;
}

export async function fetchTopClipsPage(opts: FetchTopClipsOptions): Promise<TopClipsPage> {
    const fetchFn = opts.fetchImpl ?? fetch;
    const first = Math.min(100, Math.max(1, opts.first ?? 20));

    const params = new URLSearchParams({
        broadcaster_id: opts.broadcasterId,
        first: String(first),
    });
    if (opts.after) params.set('after', opts.after);
    if (opts.startedAt) params.set('started_at', opts.startedAt);
    if (opts.endedAt) params.set('ended_at', opts.endedAt);

    let res: Response;
    try {
        res = await fetchFn(`${HELIX_CLIPS_URL}?${params.toString()}`, {
            signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
            headers: {
                'Authorization': `Bearer ${opts.accessToken}`,
                'Client-Id': opts.clientId,
            },
        });
    } catch {
        throw new Error('top-clips-crawler: helix request failed');
    }
    if (!res.ok) throw new Error(`top-clips-crawler: helix returned HTTP ${res.status}`);
    let parsed: HelixClipsResponse;
    try {
        parsed = JSON.parse(await res.text()) as HelixClipsResponse;
    } catch {
        throw new Error('top-clips-crawler: invalid helix response');
    }

    if (!parsed || typeof parsed !== 'object' || (parsed.data !== undefined && !Array.isArray(parsed.data))) throw new Error('top-clips-crawler: invalid helix response');
    const rows = (parsed.data ?? []).filter(row => row && typeof row.id === 'string').slice(0, 100);
    // Helix returns clips already sorted by view_count desc, but we re-sort
    // defensively in case that order ever changes.
    return { clips: rows.map(rowToClip).sort((a, b) => b.viewCount - a.viewCount), cursor: typeof parsed.pagination?.cursor === 'string' ? parsed.pagination.cursor.slice(0, 1024) : null };
}

export interface DateRange {
    startedAt: string;
    endedAt: string;
}

/**
 * Convenience: ISO range fuer "letzte N Tage" ab jetzt. Twitch erwartet
 * RFC3339 Format (`2026-05-11T00:00:00Z`).
 */
export function rangeLastDays(days: number, now: Date = new Date()): DateRange {
    const end = new Date(now.getTime());
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return {
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
    };
}
