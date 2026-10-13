import { LastGoodCache } from '../domain/last-good-cache';
import { parseGraphqlDataEnvelope, parseHelixDataArray } from '../domain/provider-payload';
import type { RefreshOutcome } from '../domain/refresh-result';

const TWITCH_PUBLIC_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TWITCH_PUBLIC_VODS_QUERY = 'query($login:String!,$first:Int!){ user(login:$login){ videos(first:$first, type:ARCHIVE, sort:TIME){ edges{ node{ id title publishedAt lengthSeconds viewCount previewThumbnailURL(width:320,height:180) } } } } }';

export interface TwitchGraphqlHttpClient {
    post(url: string, body: { query: string; variables: Record<string, unknown> }, config: {
        headers: { 'Client-ID': string; 'Content-Type': 'application/json' };
        timeout: number;
    }): Promise<{ data?: unknown }>;
}

export interface TwitchHelixHttpClient {
    get(url: string, config: {
        params: Record<string, string | number>;
        headers: { 'Client-ID': string; Authorization: string };
        timeout: number;
    }): Promise<{ data?: unknown }>;
}

export interface TwitchHelixAuth {
    clientId: string;
    accessToken: string;
}

export interface TwitchHelixUser {
    id: string;
    login: string;
    display_name: string;
    description: string;
    profile_image_url: string;
    broadcaster_type: string;
}

export interface TwitchVod {
    id: string;
    title: string;
    created_at: string;
    duration: string;
    thumbnail_url: string;
    url: string;
    view_count: number;
    stream_id: string;
    user_login?: string;
}

export type TwitchHelixRefreshOutcome<T> = RefreshOutcome<T[]> | { status: 'unauthorized' };

export interface TwitchProviderRefreshDependencies<T> {
    requestPublic(key: string): Promise<RefreshOutcome<T[]>>;
    requestHelix(key: string): Promise<TwitchHelixRefreshOutcome<T>>;
    refreshToken(): Promise<boolean>;
    maxLastGoodEntries: number;
}

export interface TwitchProviderRefreshResult<T> {
    value: T[] | null;
    source: 'helix' | 'public' | 'last-good' | 'not-found' | 'unavailable';
    stale: boolean;
}

type TwitchProviderRefreshOperations<T> = Omit<TwitchProviderRefreshDependencies<T>, 'maxLastGoodEntries'>;

function isTransientHttpError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return true;
    const response = (error as { response?: { status?: unknown } }).response;
    const status = Number(response?.status);
    return !Number.isFinite(status) || status === 408 || status === 429 || (status >= 500 && status < 600);
}

function httpStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const status = Number((error as { response?: { status?: unknown } }).response?.status);
    return Number.isFinite(status) ? status : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function helixConfig(auth: TwitchHelixAuth, params: Record<string, string | number>, timeout: number) {
    return {
        params,
        headers: { 'Client-ID': auth.clientId, Authorization: `Bearer ${auth.accessToken}` },
        timeout,
    };
}

export async function requestTwitchHelixUsers(
    client: TwitchHelixHttpClient,
    login: string,
    auth: TwitchHelixAuth,
    timeoutMs: number,
): Promise<TwitchHelixRefreshOutcome<TwitchHelixUser>> {
    try {
        const response = await client.get('https://api.twitch.tv/helix/users', helixConfig(auth, { login }, timeoutMs));
        const parsed = parseHelixDataArray(response.data);
        if (parsed.status !== 'success') return parsed;
        if (parsed.value.length === 0) return { status: 'not-found' };
        const users: TwitchHelixUser[] = [];
        for (const value of parsed.value) {
            const user = asRecord(value);
            if (!user
                || typeof user.id !== 'string'
                || typeof user.login !== 'string'
                || typeof user.display_name !== 'string'
                || typeof user.description !== 'string'
                || typeof user.profile_image_url !== 'string'
                || typeof user.broadcaster_type !== 'string') return { status: 'unavailable' };
            users.push(user as unknown as TwitchHelixUser);
        }
        return { status: 'success', value: users };
    } catch (error) {
        return httpStatus(error) === 401 ? { status: 'unauthorized' } : { status: 'unavailable' };
    }
}

export async function requestTwitchHelixVideos(
    client: TwitchHelixHttpClient,
    userId: string,
    auth: TwitchHelixAuth,
    timeoutMs: number,
    maxPages = 50,
): Promise<TwitchHelixRefreshOutcome<TwitchVod>> {
    const videos: TwitchVod[] = [];
    let cursor = '';
    try {
        for (let page = 0; page < maxPages; page++) {
            const params: Record<string, string | number> = { user_id: userId, type: 'archive', first: 100 };
            if (cursor) params.after = cursor;
            const response = await client.get('https://api.twitch.tv/helix/videos', helixConfig(auth, params, timeoutMs));
            const parsed = parseHelixDataArray(response.data);
            if (parsed.status !== 'success') return parsed;
            for (const value of parsed.value) {
                const video = asRecord(value);
                if (!video
                    || typeof video.id !== 'string'
                    || typeof video.title !== 'string'
                    || typeof video.created_at !== 'string'
                    || typeof video.duration !== 'string'
                    || typeof video.thumbnail_url !== 'string'
                    || typeof video.url !== 'string'
                    || typeof video.view_count !== 'number'
                    || typeof video.stream_id !== 'string') return { status: 'unavailable' };
                videos.push(video as unknown as TwitchVod);
            }
            const envelope = asRecord(response.data);
            const pagination = asRecord(envelope?.pagination);
            if (!pagination) return { status: 'unavailable' };
            if (pagination.cursor !== undefined && typeof pagination.cursor !== 'string') return { status: 'unavailable' };
            cursor = typeof pagination.cursor === 'string' ? pagination.cursor : '';
            if (!cursor) break;
        }
        return { status: 'success', value: videos };
    } catch (error) {
        return httpStatus(error) === 401 ? { status: 'unauthorized' } : { status: 'unavailable' };
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function requestPublicTwitchGraphql<T>(
    client: TwitchGraphqlHttpClient,
    query: string,
    variables: Record<string, unknown>,
    timeoutMs: number,
    attempts = 3,
): Promise<RefreshOutcome<T>> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await client.post('https://gql.twitch.tv/gql', { query, variables }, {
                headers: { 'Client-ID': TWITCH_PUBLIC_WEB_CLIENT_ID, 'Content-Type': 'application/json' },
                timeout: timeoutMs,
            });
            if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
                const errors = (response.data as Record<string, unknown>).errors;
                if (Array.isArray(errors) && errors.length > 0) {
                    if (attempt === attempts) return { status: 'unavailable' };
                    await delay(400 * Math.pow(2, attempt - 1));
                    continue;
                }
            }
            const parsed = parseGraphqlDataEnvelope(response.data);
            return parsed.status === 'success'
                ? { status: 'success', value: parsed.value as T }
                : parsed;
        } catch (error) {
            if (!isTransientHttpError(error) || attempt === attempts) return { status: 'unavailable' };
            await delay(400 * Math.pow(2, attempt - 1));
        }
    }
    return { status: 'unavailable' };
}

function formatTwitchDuration(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return `${hours > 0 ? `${hours}h` : ''}${minutes > 0 ? `${minutes}m` : ''}${remainder > 0 || (hours === 0 && minutes === 0) ? `${remainder}s` : ''}`;
}

export async function requestPublicTwitchVodsByLogin(
    client: TwitchGraphqlHttpClient,
    login: string,
    first = 100,
    timeoutMs = 10000,
    attempts = 3,
): Promise<RefreshOutcome<TwitchVod[]>> {
    if (!login || !Number.isSafeInteger(first) || first < 1 || first > 100) return { status: 'not-found' };
    const outcome = await requestPublicTwitchGraphql<Record<string, unknown>>(
        client,
        TWITCH_PUBLIC_VODS_QUERY,
        { login, first },
        timeoutMs,
        attempts,
    );
    if (outcome.status !== 'success') return outcome;
    const user = asRecord(outcome.value.user);
    if (outcome.value.user === null) return { status: 'not-found' };
    const videos = asRecord(user?.videos);
    if (!videos || !Array.isArray(videos.edges)) return { status: 'unavailable' };
    const vods: TwitchVod[] = [];
    for (const edgeValue of videos.edges) {
        const node = asRecord(asRecord(edgeValue)?.node);
        if (!node
            || typeof node.id !== 'string'
            || !node.id
            || typeof node.lengthSeconds !== 'number'
            || !Number.isFinite(node.lengthSeconds)
            || typeof node.viewCount !== 'number'
            || !Number.isFinite(node.viewCount)) {
            return { status: 'unavailable' };
        }
        vods.push({
            id: node.id,
            title: typeof node.title === 'string' && node.title ? node.title : 'Untitled VOD',
            created_at: typeof node.publishedAt === 'string' && node.publishedAt ? node.publishedAt : new Date(0).toISOString(),
            duration: formatTwitchDuration(node.lengthSeconds),
            thumbnail_url: typeof node.previewThumbnailURL === 'string' ? node.previewThumbnailURL : '',
            url: `https://www.twitch.tv/videos/${node.id}`,
            view_count: node.viewCount,
            stream_id: '',
            user_login: login,
        });
    }
    return { status: 'success', value: vods };
}

export async function refreshTwitchProviderData<T>(
    key: string,
    previous: T[] | undefined,
    operations: TwitchProviderRefreshOperations<T>,
): Promise<TwitchProviderRefreshResult<T>> {
    let helix = await operations.requestHelix(key);
    if (helix.status === 'unauthorized' && await operations.refreshToken()) {
        helix = await operations.requestHelix(key);
    }
    if (helix.status === 'success') return { value: helix.value, source: 'helix', stale: false };
    const publicOutcome = await operations.requestPublic(key);
    if (publicOutcome.status === 'success') return { value: publicOutcome.value, source: 'public', stale: false };
    if (helix.status === 'not-found' || publicOutcome.status === 'not-found') {
        return { value: null, source: 'not-found', stale: false };
    }
    return previous
        ? { value: previous, source: 'last-good', stale: true }
        : { value: null, source: 'unavailable', stale: false };
}

export function createTwitchProviderRefreshService<T>(dependencies: TwitchProviderRefreshDependencies<T>): {
    refresh(key: string): Promise<TwitchProviderRefreshResult<T>>;
} {
    const lastGood = new LastGoodCache<T[]>(dependencies.maxLastGoodEntries);
    return {
        async refresh(key: string): Promise<TwitchProviderRefreshResult<T>> {
            const result = await refreshTwitchProviderData(key, lastGood.get(key), dependencies);
            if (result.source === 'helix' || result.source === 'public') lastGood.set(key, result.value ?? []);
            if (result.source === 'not-found') lastGood.delete(key);
            return result;
        },
    };
}
