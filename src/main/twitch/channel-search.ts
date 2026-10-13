import type { TwitchGraphqlHttpClient } from './provider-refresh';

export interface TwitchChannelSearchHit {
    id: string;
    login: string;
    displayName: string;
    avatarUrl: string;
}

export interface TwitchChannelSearchResult {
    channels: TwitchChannelSearchHit[];
    error?: 'invalid' | 'unavailable';
}

export function normalizeTwitchChannelQuery(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    let query = value.trim();
    if (query.length > 100) return null;
    const withoutScheme = query.replace(/^https?:\/\//i, '').toLowerCase();
    if (withoutScheme.startsWith('twitch.tv/') || withoutScheme.startsWith('www.twitch.tv/')) {
        try {
            const url = new URL(/^https?:\/\//i.test(query) ? query : 'https://' + query);
            const parts = url.pathname.split('/').filter(Boolean);
            if (!['twitch.tv', 'www.twitch.tv'].includes(url.hostname.toLowerCase()) || parts.length !== 1) return null;
            query = parts[0];
        } catch { return null; }
    } else if (query.includes('://') || query.includes('/')) return null;
    return query.replace(/^@/, '').trim();
}

export async function requestTwitchChannelSearch(client: TwitchGraphqlHttpClient, query: string): Promise<TwitchChannelSearchResult> {
    try {
        const response = await client.post('https://gql.twitch.tv/gql', {
            query: 'query($query:String!){searchFor(userQuery:$query,platform:"web"){channels{items{... on User{id login displayName profileImageURL(width:150)}}}}}',
            variables: { query },
        }, {
            headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
            timeout: 6000,
        });
        const data = response.data as { data?: { searchFor?: { channels?: { items?: unknown } } } } | undefined;
        const items = data?.data?.searchFor?.channels?.items;
        if (!Array.isArray(items)) return { channels: [], error: 'unavailable' };
        const unique = new Map<string, TwitchChannelSearchHit>();
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const row = item as Record<string, unknown>;
            if (typeof row.login !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(row.login) || typeof row.id !== 'string') continue;
            const login = row.login.toLowerCase();
            let avatarUrl = '';
            if (typeof row.profileImageURL === 'string') {
                try {
                    const url = new URL(row.profileImageURL);
                    if (url.protocol === 'https:' && url.hostname === 'static-cdn.jtvnw.net') avatarUrl = url.href;
                } catch { }
            }
            unique.set(login, { id: row.id, login, displayName: typeof row.displayName === 'string' ? row.displayName.slice(0, 80) : login, avatarUrl });
            if (unique.size === 20) break;
        }
        return { channels: [...unique.values()].sort((a, b) => Number(b.login === query.toLowerCase()) - Number(a.login === query.toLowerCase())) };
    } catch { return { channels: [], error: 'unavailable' }; }
}

export function createTwitchChannelSearch(request: (query: string) => Promise<TwitchChannelSearchResult>, now = Date.now) {
    const cache = new Map<string, { result: TwitchChannelSearchResult; expires: number }>();
    const pending = new Map<string, Promise<TwitchChannelSearchResult>>();
    return async (input: unknown): Promise<TwitchChannelSearchResult> => {
        const query = normalizeTwitchChannelQuery(input);
        if (query === null) return { channels: [], error: 'invalid' };
        if (!query) return { channels: [] };
        const key = query.toLowerCase();
        const cached = cache.get(key);
        if (cached && cached.expires > now()) return cached.result;
        const existing = pending.get(key);
        if (existing) return existing;
        const task = Promise.resolve().then(() => request(query)).catch((): TwitchChannelSearchResult => ({ channels: [], error: 'unavailable' })).then(result => {
            if (!result.error) {
                cache.delete(key);
                cache.set(key, { result, expires: now() + 30000 });
                if (cache.size > 64) cache.delete(cache.keys().next().value!);
            }
            return result;
        }).finally(() => pending.delete(key));
        pending.set(key, task);
        return task;
    };
}
