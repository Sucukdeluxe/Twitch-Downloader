import { test, expect, describe } from 'vitest';
import { fetchTopClips, rangeLastDays } from './top-clips-crawler';

function fakeFetch(rows: Array<Record<string, unknown>>, status = 200): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        // verify request shape lightly inside the fake
        const headers = init?.headers as Record<string, string> | undefined;
        if (status === 200 && (!headers?.['Authorization'] || !headers?.['Client-Id'])) {
            return new Response('missing auth headers', { status: 401 });
        }
        return new Response(JSON.stringify({ data: rows }), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
}

describe('fetchTopClips', () => {
    test('returns parsed clips sorted by view_count desc', async () => {
        const fakeRows = [
            {
                id: 'C2', url: 'u2', embed_url: 'e2', broadcaster_id: 'b', broadcaster_name: 'B',
                creator_id: 'c', creator_name: 'C', video_id: 'v', game_id: 'g', language: 'en',
                title: 'mid', view_count: 50, created_at: '2026-05-10T00:00:00Z',
                thumbnail_url: 't', duration: 30, vod_offset: 120,
            },
            {
                id: 'C1', url: 'u1', embed_url: 'e1', broadcaster_id: 'b', broadcaster_name: 'B',
                creator_id: 'c', creator_name: 'C', video_id: 'v', game_id: 'g', language: 'en',
                title: 'high', view_count: 200, created_at: '2026-05-09T00:00:00Z',
                thumbnail_url: 't', duration: 45, vod_offset: null,
            },
        ];
        const clips = await fetchTopClips({
            clientId: 'CID', accessToken: 'TOK', broadcasterId: 'b',
            fetchImpl: fakeFetch(fakeRows),
        });

        expect(clips).toHaveLength(2);
        expect(clips[0].id).toBe('C1');
        expect(clips[0].viewCount).toBe(200);
        expect(clips[1].id).toBe('C2');
        expect(clips[1].vodOffsetSeconds).toBe(120);
        expect(clips[0].vodOffsetSeconds).toBeNull();
    });

    test('snake_case → camelCase mapping for broadcaster fields', async () => {
        const fakeRows = [
            {
                id: 'X', url: 'u', embed_url: 'e', broadcaster_id: 'bid', broadcaster_name: 'BName',
                creator_id: 'cid', creator_name: 'CName', video_id: 'vid', game_id: 'gid',
                language: 'de', title: 'T', view_count: 10, created_at: '2026-05-01T00:00:00Z',
                thumbnail_url: 'th', duration: 12,
            },
        ];
        const [c] = await fetchTopClips({
            clientId: 'CID', accessToken: 'TOK', broadcasterId: 'bid',
            fetchImpl: fakeFetch(fakeRows),
        });
        expect(c.broadcasterId).toBe('bid');
        expect(c.broadcasterName).toBe('BName');
        expect(c.creatorId).toBe('cid');
        expect(c.creatorName).toBe('CName');
        expect(c.videoId).toBe('vid');
        expect(c.gameId).toBe('gid');
    });

    test('builds query string with broadcaster_id + first + date range', async () => {
        let capturedUrl: string | null = null;
        const captureFetch = (async (url: string | URL | Request): Promise<Response> => {
            capturedUrl = String(url);
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }) as unknown as typeof fetch;

        await fetchTopClips({
            clientId: 'CID', accessToken: 'TOK', broadcasterId: '12345',
            startedAt: '2026-05-01T00:00:00Z', endedAt: '2026-05-11T00:00:00Z',
            first: 50, fetchImpl: captureFetch,
        });
        expect(capturedUrl).toContain('broadcaster_id=12345');
        expect(capturedUrl).toContain('first=50');
        expect(capturedUrl).toContain('started_at=2026-05-01T00%3A00%3A00Z');
        expect(capturedUrl).toContain('ended_at=2026-05-11T00%3A00%3A00Z');
    });

    test('clamps first to [1, 100]', async () => {
        let capturedUrl: string | null = null;
        const captureFetch = (async (url: string | URL | Request): Promise<Response> => {
            capturedUrl = String(url);
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }) as unknown as typeof fetch;

        await fetchTopClips({ clientId: 'C', accessToken: 'T', broadcasterId: 'b', first: 999, fetchImpl: captureFetch });
        expect(capturedUrl).toContain('first=100');

        await fetchTopClips({ clientId: 'C', accessToken: 'T', broadcasterId: 'b', first: 0, fetchImpl: captureFetch });
        expect(capturedUrl).toContain('first=1');
    });

    test('throws on non-2xx response', async () => {
        await expect(fetchTopClips({
            clientId: 'C', accessToken: 'T', broadcasterId: 'b',
            fetchImpl: fakeFetch([], 503),
        })).rejects.toThrow(/503/);
    });

    test('throws on malformed JSON', async () => {
        const brokenFetch = (async (): Promise<Response> => new Response('{not-json', { status: 200 })) as unknown as typeof fetch;
        await expect(fetchTopClips({
            clientId: 'C', accessToken: 'T', broadcasterId: 'b', fetchImpl: brokenFetch,
        })).rejects.toThrow(/invalid helix response/);
    });

    test('empty data returns empty array (not null)', async () => {
        const emptyFetch = (async (): Promise<Response> => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
        const clips = await fetchTopClips({
            clientId: 'C', accessToken: 'T', broadcasterId: 'b', fetchImpl: emptyFetch,
        });
        expect(clips).toEqual([]);
    });
});

describe('rangeLastDays', () => {
    test('produces ISO RFC3339 strings exactly N days apart', () => {
        const now = new Date('2026-05-11T12:00:00Z');
        const range = rangeLastDays(7, now);
        expect(range.endedAt).toBe('2026-05-11T12:00:00.000Z');
        expect(range.startedAt).toBe('2026-05-04T12:00:00.000Z');
    });

    test('1-day range', () => {
        const now = new Date('2026-05-11T12:00:00Z');
        const range = rangeLastDays(1, now);
        expect(range.startedAt).toBe('2026-05-10T12:00:00.000Z');
        expect(range.endedAt).toBe('2026-05-11T12:00:00.000Z');
    });
});
