import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseTwitchClipId } from '../twitch/clip-url';
import { runMediaProcess } from './media-process';

export function validateVodPlaybackRequest(value: unknown): { id: string; url: string } {
    const request = value as { id?: unknown; url?: unknown } | null;
    if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.id)
        || typeof request.url !== 'string' || !/^https:\/\/(?:www\.)?twitch\.tv\/videos\/\d+$/.test(request.url)) {
        throw new Error('Invalid VOD playback request');
    }
    return { id: request.id, url: request.url };
}

export function validateVodMediaUrl(value: string): URL {
    const url = new URL(value);
    const allowed = ['ttvnw.net', 'twitchcdn.net', 'jtvnw.net', 'cloudfront.net', 'twitch.tv'];
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || !allowed.some(domain => url.hostname.endsWith(`.${domain}`))) throw new Error('Invalid VOD media host');
    return url;
}

interface PlaybackSession {
    id: string;
    controller: AbortController;
    server: Server | null;
    resources: Map<string, string>;
    routes: Map<string, string>;
    prefix: string;
    origin: string;
}

interface PlaybackTools {
    prepare: () => Promise<boolean>;
    streamlink: () => { command: string; prefixArgs: string[] } | Promise<{ command: string; prefixArgs: string[] }>;
    quality: string;
    sourceUrl?: string | null;
    resolveSource?: (signal: AbortSignal) => Promise<string | null>;
}

export class VodPlaybackService {
    private current: PlaybackSession | null = null;

    constructor(private readonly fetchMedia: typeof fetch = fetch) {}

    async close(id?: string): Promise<void> {
        const session = this.current;
        if (!session || (id !== undefined && id !== session.id)) return;
        this.current = null;
        session.controller.abort();
        await this.stopServer(session);
    }

    private async stopServer(session: PlaybackSession): Promise<void> {
        const server = session.server;
        if (!server) return;
        session.server = null;
        await new Promise<void>(resolve => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
        session.resources.clear();
        session.routes.clear();
    }

    async open(value: unknown, tools: PlaybackTools): Promise<{ id: string; sourceUrl: string; quality: string }> {
        return this.openRequest(validateVodPlaybackRequest(value), tools, true);
    }

    async openClip(value: unknown, tools: PlaybackTools): Promise<{ id: string; sourceUrl: string; quality: string }> {
        const request = value as { id?: unknown; url?: unknown } | null;
        const clipId = typeof request?.url === 'string' ? parseTwitchClipId(request.url) : null;
        if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.id) || !clipId) throw new Error('Invalid clip playback request');
        return this.openRequest({ id: request.id, url: 'https://clips.twitch.tv/' + clipId }, tools, false);
    }

    private async openRequest(request: { id: string; url: string }, tools: PlaybackTools, playlist: boolean): Promise<{ id: string; sourceUrl: string; quality: string }> {
        const previous = this.close();
        const session: PlaybackSession = {
            id: request.id, controller: new AbortController(), server: null,
            resources: new Map(), routes: new Map(), prefix: `/${randomBytes(24).toString('hex')}/`, origin: '',
        };
        this.current = session;
        const signal = session.controller.signal;
        try {
            await previous;
            signal.throwIfAborted();
            const directSource = tools.sourceUrl || await tools.resolveSource?.(signal);
            signal.throwIfAborted();
            let source: string;
            if (directSource) {
                source = validateVodMediaUrl(directSource).href;
            } else {
                const prepared = await new Promise<boolean>((resolve, reject) => {
                    const abort = (): void => reject(new Error('Playback cancelled'));
                    signal.addEventListener('abort', abort, { once: true });
                    tools.prepare().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
                });
                signal.throwIfAborted();
                if (!prepared) throw new Error('Playback tools unavailable');
                const streamlink = await tools.streamlink();
                const output = await runMediaProcess(streamlink.command, [
                    ...streamlink.prefixArgs, '--loglevel', 'none', '--stream-url', request.url, tools.quality,
                ], { signal, timeoutMs: 60000 });
                signal.throwIfAborted();
                source = validateVodMediaUrl(output.trim()).href;
            }
            const server = createServer((req, res) => { void this.serve(session, req, res); });
            session.server = server;
            await new Promise<void>((resolve, reject) => {
                const cleanup = (): void => {
                    signal.removeEventListener('abort', abort);
                    server.removeListener('error', fail);
                };
                const fail = (error: Error): void => { cleanup(); reject(error); };
                const abort = (): void => fail(new Error('Playback cancelled'));
                signal.addEventListener('abort', abort, { once: true });
                server.once('error', fail);
                server.listen({ port: 0, host: '127.0.0.1', signal }, () => { cleanup(); resolve(); });
            });
            signal.throwIfAborted();
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Playback server unavailable');
            session.origin = `http://127.0.0.1:${address.port}`;
            return { id: request.id, sourceUrl: session.origin + this.register(session, source, playlist), quality: tools.quality };
        } catch (error) {
            session.controller.abort();
            await this.stopServer(session);
            if (this.current === session) this.current = null;
            throw error;
        }
    }

    private register(session: PlaybackSession, source: string, playlist = false): string {
        const url = validateVodMediaUrl(source).href;
        const existing = session.routes.get(url);
        if (existing) return existing;
        if (session.resources.size >= 100000) throw new Error('VOD playlist too large');
        const route = `${session.prefix}${session.resources.size}${playlist || new URL(url).pathname.endsWith('.m3u8') ? '.m3u8' : '.media'}`;
        session.resources.set(route, url);
        session.routes.set(url, route);
        return route;
    }

    private async getRemote(url: string, signal: AbortSignal, range?: string): Promise<{ response: Response; url: string }> {
        for (let redirects = 0; redirects < 5; redirects++) {
            validateVodMediaUrl(url);
            const response = await this.fetchMedia(url, { signal, redirect: 'manual', headers: range ? { Range: range } : {} });
            if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
                await response.body?.cancel();
                url = new URL(response.headers.get('location')!, url).href;
                continue;
            }
            return { response, url };
        }
        throw new Error('Too many media redirects');
    }

    private async serve(session: PlaybackSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
        let pathname: string;
        try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; }
        catch { res.writeHead(400).end(); return; }
        const source = session.resources.get(pathname);
        if (session.controller.signal.aborted || req.headers.host !== session.origin.slice(7) || !source
            || (req.headers.origin && req.headers.origin !== 'null' && req.headers.origin !== session.origin)) {
            res.writeHead(403).end();
            return;
        }
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
        const range = req.headers.range;
        if (range && !/^bytes=\d+-\d*$/.test(range)) { res.writeHead(416).end(); return; }
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        const timeout = setTimeout(abort, 30000);
        session.controller.signal.addEventListener('abort', abort, { once: true });
        res.once('close', abort);
        try {
            const { response, url } = await this.getRemote(source, controller.signal, range);
            if (!response.ok) {
                await response.body?.cancel();
                res.writeHead(response.status === 403 || response.status === 404 ? response.status : 502).end();
                return;
            }
            const type = response.headers.get('content-type') || '';
            if (pathname.endsWith('.m3u8') || /mpegurl/i.test(type)) {
                const reader = response.body?.getReader();
                if (!reader) throw new Error('Empty playlist');
                const chunks: Uint8Array[] = [];
                let bytes = 0;
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('VOD playlist too large'); }
                    chunks.push(chunk.value);
                }
                const playlist = Buffer.concat(chunks).toString('utf8');
                if (!playlist.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid VOD playlist');
                const rewrite = (value: string): string => this.register(session, new URL(value, url).href);
                const rewritten = playlist.split(/\r?\n/).map(line => {
                    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${rewrite(uri)}"`);
                    return line.trim() ? rewrite(line.trim()) : line;
                }).join('\n');
                res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(rewritten) });
                res.end(req.method === 'HEAD' ? undefined : rewritten);
            } else {
                for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
                    const value = response.headers.get(name);
                    if (value) res.setHeader(name, value);
                }
                res.writeHead(response.status);
                if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); }
                else await pipeline(Readable.fromWeb(response.body as any), res);
            }
        } catch {
            if (!res.headersSent) res.writeHead(502).end();
            else res.destroy();
        } finally {
            clearTimeout(timeout);
            session.controller.signal.removeEventListener('abort', abort);
            res.removeListener('close', abort);
        }
    }
}
