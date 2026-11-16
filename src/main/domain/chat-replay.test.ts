import { describe, expect, it } from 'vitest';
import { fetchChatReplay, type ChatReplayGql } from './chat-replay';

interface Stored { id: string; offset: number; text: string }

function twitch(messages: Stored[], options: { failAt?: number; dropEvery?: number } = {}): { gql: ChatReplayGql; offsets: number[] } {
    const offsets: number[] = [];
    const last = messages.at(-1)?.offset ?? 0;
    const gql = (async (query: string, variables: Record<string, unknown>) => {
        expect(query).not.toContain('cursor');
        const offset = Number(variables.offset);
        offsets.push(offset);
        if (options.failAt !== undefined && offset >= options.failAt) return null;
        if (offset > last + 60) return null;
        const found = messages.findIndex(message => message.offset >= offset);
        const index = found < 0 ? messages.length : found;
        const start = Math.max(0, index - 14);
        const call = offsets.length;
        const window = messages.slice(start, start + 56).filter(message => !options.dropEvery || (Math.floor(message.offset) + call) % options.dropEvery !== 0);
        return { video: { comments: {
            edges: window.map(message => ({ node: {
                id: message.id, contentOffsetSeconds: message.offset, createdAt: '2026-11-15T12:00:00Z',
                message: { fragments: [{ text: message.text }, { text: '!' }], userColor: '#FF0000' }, commenter: { displayName: 'Anna', login: 'anna' },
            } })),
            pageInfo: { hasNextPage: start + 56 < messages.length },
        } } };
    }) as ChatReplayGql;
    return { gql, offsets };
}

const quiet = Array.from({ length: 900 }, (_value, index) => ({ id: 'q' + index, offset: index * 4, text: 'ruhig ' + index }));
const busy = Array.from({ length: 1200 }, (_value, index) => ({ id: 'b' + index, offset: 3600 + Math.floor(index / 15), text: 'voll ' + index }));
const stream = [...quiet, ...busy, ...Array.from({ length: 300 }, (_value, index) => ({ id: 'e' + index, offset: 3700 + index * 12, text: 'ende ' + index }))];

describe('fetchChatReplay', () => {
    it('reads the whole chat by position without the paging argument Twitch removed', async () => {
        const { gql } = twitch(stream);
        const replay = await fetchChatReplay(gql, '900');
        expect(replay.truncated).toBe(false);
        expect(replay.messages).toHaveLength(stream.length);
        expect(new Set(replay.messages.map(message => message.id)).size).toBe(stream.length);
        expect(replay.messages.every((message, index, all) => index === 0 || message.offset >= all[index - 1].offset)).toBe(true);
        expect(replay.messages[0]).toEqual({ id: 'q0', offset: 0, createdAt: '2026-11-15T12:00:00Z', user: 'Anna', login: 'anna', color: '#FF0000', text: 'ruhig 0!' });
        expect(replay.pages).toBeGreaterThan(40);
    });

    it('reads several stretches of a long VOD at the same time and still returns every message once', async () => {
        const { gql, offsets } = twitch(stream);
        const counts: number[] = [];
        const replay = await fetchChatReplay(gql, '900', { durationSeconds: 7300, onProgress: count => counts.push(count) });
        expect(replay.truncated).toBe(false);
        expect(replay.messages.map(message => message.id).sort()).toEqual(stream.map(message => message.id).sort());
        expect(offsets.slice(0, 8).sort((a, b) => a - b)).toEqual([0, 912, 1825, 2737, 3650, 4562, 5475, 6387]);
        expect(counts.at(-1)).toBe(stream.length);
    });

    it('asks several times for positions where the chat is dense', async () => {
        const { gql, offsets } = twitch(stream);
        await fetchChatReplay(gql, '900', { maxPasses: 1 });
        const asked = (offset: number): number => offsets.filter(value => value === offset).length;
        const dense = [...new Set(offsets.filter(offset => offset >= 3610 && offset < 3670))];
        expect(dense.length).toBeGreaterThan(5);
        expect(dense.every(offset => asked(offset) === 3)).toBe(true);
        expect([...new Set(offsets.filter(offset => offset < 3000))].every(offset => asked(offset) === 1)).toBe(true);
    });

    it('reads the chat again when single answers leave out whole seconds', async () => {
        const single = await fetchChatReplay(twitch(stream, { dropEvery: 5 }).gql, '900', { maxPasses: 1 });
        expect(single.messages.length).toBeLessThan(stream.length);
        const lossy = twitch(stream, { dropEvery: 5 });
        const replay = await fetchChatReplay(lossy.gql, '900');
        expect(replay.messages).toHaveLength(stream.length);
        expect(replay.truncated).toBe(false);
        expect(replay.pages).toBeGreaterThan(single.pages * 1.9);
    });

    it('stops repeating once a further read adds nothing', async () => {
        const first = await fetchChatReplay(twitch(stream).gql, '900', { maxPasses: 1 });
        const replay = await fetchChatReplay(twitch(stream).gql, '900');
        expect(replay.pages).toBe(first.pages * 2);
    });

    it('marks the result as incomplete when Twitch stops answering', async () => {
        const replay = await fetchChatReplay(twitch(stream, { failAt: 2000 }).gql, '900');
        expect(replay.truncated).toBe(true);
        expect(replay.messages.length).toBeGreaterThan(400);
        expect(replay.messages.length).toBeLessThan(stream.length);
        const none = await fetchChatReplay((async () => null) as ChatReplayGql, '900');
        expect(none).toEqual({ messages: [], truncated: true, pages: 0 });
    });

    it('treats the end of the VOD as the end of the chat', async () => {
        const tail = [...stream, { id: 'nach-ende-1', offset: 7300, text: 'bis bald' }, { id: 'nach-ende-2', offset: 7303, text: 'gg' }];
        const gql = (async (_query: string, variables: Record<string, unknown>) => {
            const offset = Number(variables.offset);
            if (offset > 7302) return null;
            const found = tail.findIndex(message => message.offset >= offset);
            const index = found < 0 ? tail.length : found, start = Math.max(0, index - 14);
            return { video: { comments: { edges: tail.slice(start, start + 56).map(message => ({ node: { id: message.id, contentOffsetSeconds: message.offset, createdAt: '', message: { fragments: [{ text: message.text }] }, commenter: null } })), pageInfo: { hasNextPage: true } } } };
        }) as ChatReplayGql;
        const replay = await fetchChatReplay(gql, '900', { durationSeconds: 7300 });
        expect(replay.truncated).toBe(false);
        expect(replay.messages.length).toBeGreaterThanOrEqual(stream.length);
        const unknownLength = await fetchChatReplay(gql, '900');
        expect(unknownLength.truncated).toBe(true);
    });

    it('stops when cancelled or at the page limit and says so', async () => {
        let calls = 0;
        const cancelled = await fetchChatReplay(twitch(stream).gql, '900', { cancelCheck: () => ++calls > 5 });
        expect(cancelled.truncated).toBe(true);
        expect(cancelled.pages).toBe(5);
        const limited = await fetchChatReplay(twitch(stream).gql, '900', { maxPages: 3 });
        expect(limited).toMatchObject({ truncated: true, pages: 3 });
    });

    it('accepts a VOD without chat messages and skips broken entries', async () => {
        const empty = await fetchChatReplay((async () => ({ video: { comments: { edges: [], pageInfo: { hasNextPage: false } } } })) as ChatReplayGql, '900');
        expect(empty).toEqual({ messages: [], truncated: false, pages: 1 });
        const broken = await fetchChatReplay((async () => ({ video: { comments: { edges: [
            { node: { id: 'a', contentOffsetSeconds: 3, message: { fragments: [{ text: 'ok' }] }, commenter: null } },
            { node: { id: 7, contentOffsetSeconds: 4 } }, { node: null }, { node: { id: 'b', contentOffsetSeconds: 'x' } },
        ], pageInfo: { hasNextPage: false } } } })) as ChatReplayGql, '900');
        expect(broken.messages).toEqual([{ id: 'a', offset: 3, createdAt: '', user: '', login: '', color: '', text: 'ok' }]);
    });
});
