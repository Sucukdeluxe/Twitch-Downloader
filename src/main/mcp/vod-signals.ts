export type GqlRequest = <T>(query: string, variables: Record<string, unknown>) => Promise<T | null>;
export interface ChatMessage { id: string; offset: number; user: string; text: string }
export interface ChatRange { messages: ChatMessage[]; nextFrom: number | null }
export interface ChatActivityBucket { start: number; messagesPerMinute: number; samples: string[] }
export interface VodClip { slug: string; title: string; views: number; duration: number; offset: number; createdAt: string }

export const MAX_CHAT_MESSAGES = 1000;
export const MAX_CHAT_ACTIVITY_BUCKETS = 240;
export const MAX_VOD_CLIPS = 100;
const MAX_CHAT_PAGES = 60;
const MAX_TEXT_LENGTH = 300;
const CHAT_QUERY = 'query($videoID:ID!,$offset:Int){video(id:$videoID){comments(contentOffsetSeconds:$offset){edges{node{id contentOffsetSeconds message{fragments{text}} commenter{displayName}}} pageInfo{hasNextPage}}}}';
const CLIPS_QUERY = 'query($videoID:ID!,$first:Int){video(id:$videoID){clips(first:$first){edges{node{slug title viewCount durationSeconds videoOffsetSeconds createdAt}}}}}';

interface CommentsResult {
    video: { comments: { edges: Array<{ node: { id?: unknown; contentOffsetSeconds?: unknown; message?: { fragments?: Array<{ text?: unknown }> }; commenter?: { displayName?: unknown } | null } }> | null; pageInfo?: { hasNextPage?: boolean } } | null } | null;
}
interface ClipsResult {
    video: { clips: { edges: Array<{ node: { slug?: unknown; title?: unknown; viewCount?: unknown; durationSeconds?: unknown; videoOffsetSeconds?: unknown; createdAt?: unknown } }> | null } | null } | null;
}

function cleanText(value: unknown, maximum = MAX_TEXT_LENGTH): string {
    if (typeof value !== 'string') return '';
    return Array.from(value, character => character.charCodeAt(0) < 32 ? ' ' : character).join('').trim().slice(0, maximum);
}

export async function loadChatPage(gql: GqlRequest, vodId: string, offset: number): Promise<{ messages: ChatMessage[]; hasNext: boolean } | null> {
    const data = await gql<CommentsResult>(CHAT_QUERY, { videoID: vodId, offset: Math.max(0, Math.floor(offset)) });
    const comments = data?.video?.comments;
    if (!comments) return null;
    const messages = (comments.edges ?? []).flatMap((edge): ChatMessage[] => {
        const node = edge?.node;
        const messageOffset = typeof node?.contentOffsetSeconds === 'number' ? node.contentOffsetSeconds : Number.NaN;
        const text = cleanText((node?.message?.fragments ?? []).map(fragment => typeof fragment?.text === 'string' ? fragment.text : '').join(''));
        if (!node || typeof node.id !== 'string' || !Number.isFinite(messageOffset) || !text) return [];
        return [{ id: node.id, offset: messageOffset, user: cleanText(node.commenter?.displayName, 60), text }];
    });
    return { messages, hasNext: comments.pageInfo?.hasNextPage === true };
}

export async function loadChatRange(gql: GqlRequest, vodId: string, from: number, to: number, maximum: number, signal: AbortSignal): Promise<ChatRange | null> {
    const limit = Math.max(1, Math.min(MAX_CHAT_MESSAGES, Math.floor(maximum)));
    const seen = new Set<string>();
    const messages: ChatMessage[] = [];
    let offset = Math.floor(from);
    for (let page = 0; page < MAX_CHAT_PAGES && !signal.aborted; page++) {
        const result = await loadChatPage(gql, vodId, offset);
        if (!result) return page === 0 ? null : { messages, nextFrom: offset };
        const fresh = result.messages.filter(message => !seen.has(message.id));
        for (const message of fresh) seen.add(message.id);
        for (const message of fresh) {
            if (message.offset < from) continue;
            if (message.offset >= to) return { messages, nextFrom: null };
            if (messages.length >= limit) return { messages, nextFrom: message.offset };
            messages.push(message);
        }
        const last = result.messages.at(-1);
        if (!result.hasNext || !last) return { messages, nextFrom: null };
        offset = fresh.length === 0 || Math.floor(last.offset) <= offset ? offset + 1 : Math.floor(last.offset);
        if (offset >= to) return { messages, nextFrom: null };
    }
    return { messages, nextFrom: offset };
}

export async function loadChatActivity(gql: GqlRequest, vodId: string, from: number, to: number, stepSeconds: number, signal: AbortSignal): Promise<ChatActivityBucket[] | null> {
    const starts: number[] = [];
    for (let start = Math.floor(from); start < to && starts.length < MAX_CHAT_ACTIVITY_BUCKETS; start += stepSeconds) starts.push(start);
    const buckets: Array<ChatActivityBucket | null> = starts.map(() => null);
    let next = 0, failed = 0;
    await Promise.all(Array.from({ length: Math.min(4, starts.length) }, async () => {
        while (next < starts.length && !signal.aborted) {
            const index = next++;
            const start = starts[index];
            const page = await loadChatPage(gql, vodId, start);
            if (!page) { failed += 1; continue; }
            const inBucket = page.messages.filter(message => message.offset >= start && message.offset < start + stepSeconds);
            const span = inBucket.length > 1 ? Math.max(1, inBucket[inBucket.length - 1].offset - inBucket[0].offset) : stepSeconds;
            const coversBucket = !page.hasNext || (page.messages.at(-1)?.offset ?? 0) >= start + stepSeconds;
            buckets[index] = {
                start,
                messagesPerMinute: inBucket.length === 0 ? 0 : Math.round(inBucket.length / (coversBucket ? stepSeconds : span) * 600) / 10,
                samples: inBucket.slice(0, 8).map(message => message.text.slice(0, 120)),
            };
        }
    }));
    if (failed === starts.length && starts.length > 0) return null;
    return buckets.filter((bucket): bucket is ChatActivityBucket => bucket !== null);
}

export async function loadVodClips(gql: GqlRequest, vodId: string): Promise<VodClip[] | null> {
    const data = await gql<ClipsResult>(CLIPS_QUERY, { videoID: vodId, first: MAX_VOD_CLIPS });
    if (!data?.video) return null;
    return (data.video.clips?.edges ?? []).flatMap((edge): VodClip[] => {
        const node = edge?.node;
        const offset = typeof node?.videoOffsetSeconds === 'number' ? node.videoOffsetSeconds : Number.NaN, duration = Number(node?.durationSeconds);
        if (!node || typeof node.slug !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(node.slug) || !Number.isFinite(offset) || offset < 0) return [];
        return [{
            slug: node.slug, title: cleanText(node.title, 200), views: Number.isFinite(Number(node.viewCount)) ? Number(node.viewCount) : 0,
            duration: Number.isFinite(duration) ? duration : 0, offset, createdAt: typeof node.createdAt === 'string' ? node.createdAt.slice(0, 40) : '',
        }];
    }).sort((a, b) => a.offset - b.offset);
}
