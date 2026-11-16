export interface ChatReplayMessage { id: string; offset: number; createdAt: string; user: string; login: string; color: string; text: string }
export interface ChatReplayResult { messages: ChatReplayMessage[]; truncated: boolean; pages: number }
export type ChatReplayGql = <T>(query: string, variables: Record<string, unknown>) => Promise<T | null>;
export interface ChatReplayOptions {
    durationSeconds?: number;
    onProgress?(count: number): void;
    cancelCheck?(): boolean;
    maxPages?: number;
    maxMessages?: number;
    maxPasses?: number;
}

const QUERY = 'query($videoID:ID!,$offset:Int){video(id:$videoID){comments(contentOffsetSeconds:$offset){edges{node{id contentOffsetSeconds createdAt message{fragments{text} userColor} commenter{displayName login}}} pageInfo{hasNextPage}}}}';
const PARALLEL_STRETCHES = 8;
const DENSE_SPAN_SECONDS = 10;
const DENSE_MIN_MESSAGES = 20;
const DENSE_READS = 3;
const MIN_STRETCH_SECONDS = 600;
const DEFAULT_MAX_PAGES = 250000;
const DEFAULT_MAX_MESSAGES = 2000000;
const DEFAULT_MAX_PASSES = 4;
const MIN_PASSES = 2;
const REPEAT_ABOVE_NEW_SHARE = 0.0025;

interface CommentsPage {
    video: { comments: { edges: Array<{ node: Record<string, unknown> | null } | null> | null; pageInfo?: { hasNextPage?: boolean } } | null } | null;
}

function readMessage(node: Record<string, unknown> | null | undefined): ChatReplayMessage | null {
    if (!node || typeof node.id !== 'string' || typeof node.contentOffsetSeconds !== 'number' || !Number.isFinite(node.contentOffsetSeconds)) return null;
    const message = node.message as { fragments?: Array<{ text?: unknown }>; userColor?: unknown } | null | undefined;
    const commenter = node.commenter as { displayName?: unknown; login?: unknown } | null | undefined;
    const text = (name: unknown): string => typeof name === 'string' ? name : '';
    return {
        id: node.id, offset: node.contentOffsetSeconds, createdAt: text(node.createdAt), user: text(commenter?.displayName), login: text(commenter?.login), color: text(message?.userColor),
        text: (Array.isArray(message?.fragments) ? message.fragments : []).map(fragment => text(fragment?.text)).join(''),
    };
}

export async function fetchChatReplay(gql: ChatReplayGql, videoId: string, options: ChatReplayOptions = {}): Promise<ChatReplayResult> {
    const duration = Number.isFinite(options.durationSeconds) && options.durationSeconds! > 0 ? options.durationSeconds! : 0;
    const stretches = Math.max(1, Math.min(PARALLEL_STRETCHES, Math.floor(duration / MIN_STRETCH_SECONDS)));
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES, maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const maxPasses = Math.max(1, options.maxPasses ?? DEFAULT_MAX_PASSES);
    const messages = new Map<string, ChatReplayMessage>();
    let pages = 0, truncated = false;
    const readStretch = async (from: number, to: number): Promise<void> => {
        let offset = from, reads = 0;
        while (!truncated) {
            if (options.cancelCheck?.() || pages >= maxPages || messages.size >= maxMessages) { truncated = true; return; }
            const data = await gql<CommentsPage>(QUERY, { videoID: videoId, offset });
            const comments = data?.video?.comments;
            if (!comments) { truncated = true; return; }
            pages += 1;
            let earliest: number | null = null, latest: number | null = null, count = 0;
            for (const edge of comments.edges ?? []) {
                const message = readMessage(edge?.node);
                if (!message) continue;
                count += 1;
                earliest = earliest === null ? message.offset : Math.min(earliest, message.offset);
                latest = latest === null ? message.offset : Math.max(latest, message.offset);
                if (message.offset < to && !messages.has(message.id)) messages.set(message.id, message);
            }
            options.onProgress?.(messages.size);
            reads += 1;
            if (latest !== null && earliest !== null && count >= DENSE_MIN_MESSAGES && latest - earliest <= DENSE_SPAN_SECONDS && reads < DENSE_READS) continue;
            reads = 0;
            if (comments.pageInfo?.hasNextPage !== true || latest === null || latest >= to) return;
            offset = Math.floor(latest) > offset ? Math.floor(latest) : offset + 1;
        }
    };
    for (let pass = 1; pass <= maxPasses && !truncated; pass++) {
        const known = messages.size;
        await Promise.all(Array.from({ length: stretches }, (_value, index) => readStretch(
            Math.floor(duration * index / stretches),
            index === stretches - 1 ? Number.POSITIVE_INFINITY : Math.floor(duration * (index + 1) / stretches),
        )));
        const added = messages.size - known;
        if (messages.size === 0 || (pass >= MIN_PASSES && added <= messages.size * REPEAT_ABOVE_NEW_SHARE)) break;
    }
    return {
        messages: [...messages.values()].sort((a, b) => a.offset - b.offset || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
        truncated, pages,
    };
}
