import { describe, expect, it } from 'vitest';
import { loadChatActivity, loadChatPage, loadChatRange, loadVodClips, type GqlRequest } from './vod-signals';

interface StoredMessage { id: string; offset: number; user: string; text: string }

function chatGql(messages: StoredMessage[], pageSize = 5): { gql: GqlRequest; offsets: number[] } {
    const offsets: number[] = [];
    const gql = (async (_query: string, variables: Record<string, unknown>) => {
        const offset = Number(variables.offset);
        offsets.push(offset);
        const first = Math.max(0, messages.findIndex(message => message.offset >= offset - 2));
        const page = messages.findIndex(message => message.offset >= offset - 2) < 0 ? [] : messages.slice(first, first + pageSize);
        return {
            video: {
                comments: {
                    edges: page.map(message => ({ node: { id: message.id, contentOffsetSeconds: message.offset, message: { fragments: [{ text: message.text }] }, commenter: { displayName: message.user } } })),
                    pageInfo: { hasNextPage: first + pageSize < messages.length },
                },
            },
        };
    }) as GqlRequest;
    return { gql, offsets };
}

const steady = Array.from({ length: 60 }, (_value, index) => ({ id: 'id' + index, offset: 100 + index * 10, user: 'user' + (index % 3), text: 'Nachricht ' + index }));
const signal = new AbortController().signal;

describe('loadChatPage', () => {
    it('reads messages with their position and drops broken entries', async () => {
        const gql = (async () => ({ video: { comments: { edges: [
            { node: { id: 'a', contentOffsetSeconds: 12, message: { fragments: [{ text: 'Hallo ' }, { text: 'Welt\u0007' }] }, commenter: { displayName: 'Anna' } } },
            { node: { id: 'b', contentOffsetSeconds: 'x', message: { fragments: [{ text: 'kaputt' }] }, commenter: null } },
            { node: { id: 'c', contentOffsetSeconds: 13, message: { fragments: [] }, commenter: null } },
            { node: { id: 'd', contentOffsetSeconds: 14, message: { fragments: [{ text: 'x'.repeat(500) }] }, commenter: null } },
        ], pageInfo: { hasNextPage: true } } } })) as GqlRequest;
        const page = await loadChatPage(gql, '900', 10);
        expect(page!.hasNext).toBe(true);
        expect(page!.messages).toHaveLength(2);
        expect(page!.messages[0]).toEqual({ id: 'a', offset: 12, user: 'Anna', text: 'Hallo Welt' });
        expect(page!.messages[1].text).toHaveLength(300);
        expect(page!.messages[1].user).toBe('');
    });

    it('reports an unavailable chat replay', async () => {
        expect(await loadChatPage((async () => null) as GqlRequest, '900', 0)).toBeNull();
        expect(await loadChatPage((async () => ({ video: null })) as GqlRequest, '900', 0)).toBeNull();
    });
});

describe('loadChatRange', () => {
    it('pages through a range by position without duplicates', async () => {
        const { gql, offsets } = chatGql(steady);
        const range = await loadChatRange(gql, '900', 150, 400, 100, signal);
        expect(range!.messages.map(message => message.offset)).toEqual(Array.from({ length: 25 }, (_value, index) => 150 + index * 10));
        expect(new Set(range!.messages.map(message => message.id)).size).toBe(25);
        expect(range!.nextFrom).toBeNull();
        expect(offsets[0]).toBe(150);
        expect(offsets.length).toBeGreaterThan(3);
    });

    it('stops at the message limit and names where to continue', async () => {
        const { gql } = chatGql(steady);
        const range = await loadChatRange(gql, '900', 100, 700, 7, signal);
        expect(range!.messages).toHaveLength(7);
        expect(range!.nextFrom).toBe(170);
    });

    it('moves forward when one second holds more messages than a page', async () => {
        const burst = [...Array.from({ length: 12 }, (_value, index) => ({ id: 'b' + index, offset: 50, user: 'u', text: 'spam' })), { id: 'after', offset: 70, user: 'u', text: 'danach' }];
        const { gql } = chatGql(burst, 5);
        const range = await loadChatRange(gql, '900', 40, 100, 100, signal);
        expect(range!.messages.at(-1)!.text).toBe('danach');
        expect(range!.nextFrom).toBeNull();
    });

    it('returns nothing when the replay cannot be read', async () => {
        expect(await loadChatRange((async () => null) as GqlRequest, '900', 0, 100, 50, signal)).toBeNull();
    });
});

describe('loadChatActivity', () => {
    it('estimates the message rate per step and returns sample messages', async () => {
        const busy = Array.from({ length: 300 }, (_value, index) => ({ id: 'x' + index, offset: 600 + index, user: 'u', text: 'W ' + index }));
        const quiet = [{ id: 'q1', offset: 30, user: 'u', text: 'erster' }, { id: 'q2', offset: 200, user: 'u', text: 'zweiter' }];
        const { gql } = chatGql([...quiet, ...busy], 50);
        const buckets = await loadChatActivity(gql, '900', 0, 1200, 300, signal);
        expect(buckets!.map(bucket => bucket.start)).toEqual([0, 300, 600, 900]);
        expect(buckets![0]).toMatchObject({ messagesPerMinute: 0.4, samples: ['erster', 'zweiter'] });
        expect(buckets![1].messagesPerMinute).toBe(0);
        expect(buckets![2].messagesPerMinute).toBeGreaterThan(55);
        expect(buckets![2].samples).toHaveLength(8);
        expect(buckets![3].messagesPerMinute).toBe(0);
    });

    it('reports an unavailable chat replay', async () => {
        expect(await loadChatActivity((async () => null) as GqlRequest, '900', 0, 600, 300, signal)).toBeNull();
    });
});

describe('loadVodClips', () => {
    const clip = (slug: string, offset: number | null, views = 1) => ({ node: { slug, title: 'titel ' + slug, viewCount: views, durationSeconds: 30, videoOffsetSeconds: offset, createdAt: '2026-11-15T21:40:00Z' } });

    it('returns clips in VOD order and ignores malformed entries', async () => {
        const queries: string[] = [];
        const gql = (async (query: string, variables: Record<string, unknown>) => {
            queries.push(query);
            expect(variables).toEqual({ videoID: '900', first: 100 });
            return { video: { clips: { edges: [clip('SpaeterClip-1', 17996, 204), clip('FrueherClip-2', 6570, 308), clip('../kaputt', 10), clip('OhneZeit', null)], pageInfo: { hasNextPage: false } } } };
        }) as GqlRequest;
        const list = await loadVodClips(gql, '900');
        expect(list!.clips.map(entry => [entry.slug, entry.offset, entry.views])).toEqual([['FrueherClip-2', 6570, 308], ['SpaeterClip-1', 17996, 204]]);
        expect(list).toMatchObject({ complete: true, uncovered: null });
        expect(queries).toHaveLength(1);
    });

    it('also reads the last clips of a VOD and names the range Twitch does not list', async () => {
        const gql = (async (query: string) => ({ video: { clips: {
            edges: query.includes('sort:DESC') ? [clip('Ende-2', 23000), clip('Ende-1', 14730)] : [clip('Anfang-1', 219), clip('Anfang-2', 5850)],
            pageInfo: { hasNextPage: true },
        } } })) as GqlRequest;
        const list = await loadVodClips(gql, '900');
        expect(list!.clips.map(entry => entry.slug)).toEqual(['Anfang-1', 'Anfang-2', 'Ende-1', 'Ende-2']);
        expect(list).toMatchObject({ complete: false, uncovered: { start: 5850, end: 14730 } });
    });

    it('reports a complete list when the first and the last clips overlap', async () => {
        const gql = (async (query: string) => ({ video: { clips: {
            edges: query.includes('sort:DESC') ? [clip('C', 900), clip('B', 500)] : [clip('A', 100), clip('B', 500)],
            pageInfo: { hasNextPage: true },
        } } })) as GqlRequest;
        const list = await loadVodClips(gql, '900');
        expect(list!.clips.map(entry => entry.slug)).toEqual(['A', 'B', 'C']);
        expect(list).toMatchObject({ complete: true, uncovered: null });
    });

    it('keeps the first clips when the last ones cannot be read and distinguishes an unknown VOD', async () => {
        const partial = await loadVodClips((async (query: string) => query.includes('sort:DESC') ? null : { video: { clips: { edges: [clip('A', 100)], pageInfo: { hasNextPage: true } } } }) as GqlRequest, '900');
        expect(partial).toMatchObject({ complete: false, uncovered: { start: 100, end: null } });
        expect(await loadVodClips((async () => ({ video: null })) as GqlRequest, '900')).toBeNull();
        expect(await loadVodClips((async () => ({ video: { clips: { edges: [] } } })) as GqlRequest, '900')).toEqual({ clips: [], complete: true, uncovered: null });
    });
});

describe('Twitch pages that do not start at the requested position', () => {
    const node = (id: string, offset: number) => ({ node: { id, contentOffsetSeconds: offset, message: { fragments: [{ text: 'text ' + id }] }, commenter: { displayName: 'u' } } });

    it('looks one second further when a page ends before the requested step', async () => {
        const gql = (async (_query: string, variables: Record<string, unknown>) => ({ video: { comments: {
            edges: Number(variables.offset) === 300 ? [node('a', 296), node('b', 299)] : [node('c', 300), node('d', 310), node('e', 700)],
            pageInfo: { hasNextPage: true },
        } } })) as GqlRequest;
        const buckets = await loadChatActivity(gql, '900', 300, 600, 300, signal);
        expect(buckets![0].samples).toEqual(['text c', 'text d']);
        expect(buckets![0].messagesPerMinute).toBeGreaterThan(0);
    });

    it('finishes a second before stopping at the message limit so that the next call moves on', async () => {
        const all = [...Array.from({ length: 15 }, (_value, index) => ({ id: 's' + index, offset: 1000, user: 'u', text: 'voll ' + index })), { id: 'next', offset: 1001, user: 'u', text: 'weiter' }, { id: 'later', offset: 1005, user: 'u', text: 'danach' }];
        const { gql } = chatGql(all, 30);
        const first = await loadChatRange(gql, '900', 1000, 1300, 10, signal);
        expect(first!.messages).toHaveLength(15);
        expect(first!.nextFrom).toBe(1001);
        const second = await loadChatRange(gql, '900', first!.nextFrom!, 1300, 10, signal);
        expect(second!.messages.map(message => message.text)).toEqual(['weiter', 'danach']);
        expect(second!.nextFrom).toBeNull();
    });
});
