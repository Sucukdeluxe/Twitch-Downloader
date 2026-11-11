export function parseTwitchClipId(input: unknown): string | null {
    if (typeof input !== 'string' || input.length > 4096) return null;
    try {
        const url = new URL(input.trim());
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
        const match = url.hostname === 'clips.twitch.tv'
            ? /^\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)
            : ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname)
                ? /^\/[A-Za-z0-9_]+\/clip\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)
                : null;
        return match?.[1] || null;
    } catch {
        return null;
    }
}
