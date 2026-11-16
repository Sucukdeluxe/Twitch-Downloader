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
    it('returns clips in VOD order and ignores malformed entries', async () => {
        const gql = (async (_query: string, variables: Record<string, unknown>) => {
            expect(variables).toEqual({ videoID: '900', first: 100 });
            return { video: { clips: { edges: [
                { node: { slug: 'SpaeterClip-1', title: 'van der linde crash', viewCount: 204, durationSeconds: 30, videoOffsetSeconds: 17996, createdAt: '2026-11-15T21:40:00Z' } },
                { node: { slug: 'FrueherClip-2', title: 'rewi anruf', viewCount: 308, durationSeconds: 60, videoOffsetSeconds: 6570, createdAt: '2026-11-15T18:30:00Z' } },
                { node: { slug: '../kaputt', title: 'x', viewCount: 1, durationSeconds: 5, videoOffsetSeconds: 10 } },
                { node: { slug: 'OhneZeit', title: 'x', viewCount: 1, durationSeconds: 5, videoOffsetSeconds: null } },
            ] } } };
        }) as GqlRequest;
        const clips = await loadVodClips(gql, '900');
        expect(clips!.map(clip => [clip.slug, clip.offset, clip.title, clip.views])).toEqual([['FrueherClip-2', 6570, 'rewi anruf', 308], ['SpaeterClip-1', 17996, 'van der linde crash', 204]]);
    });

    it('distinguishes an unknown VOD from a VOD without clips', async () => {
        expect(await loadVodClips((async () => ({ video: null })) as GqlRequest, '900')).toBeNull();
        expect(await loadVodClips((async () => ({ video: { clips: { edges: [] } } })) as GqlRequest, '900')).toEqual([]);
    });
});
