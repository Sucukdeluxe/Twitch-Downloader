import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthFailureLimiter, clientAddress, isAllowedOrigin, readRequestCredentials, tokensMatch, MCP_ENDPOINT_PATH } from './access';

export interface McpFetchHandler {
    fetch(request: Request): Promise<Response>;
}
export interface McpHttpActivity { at: number; client: string; method: string | null; tool: string | null }
export interface McpHttpServerOptions {
    host: string;
    port: number;
    token(): string | null;
    handler: McpFetchHandler;
    log(event: string, details?: unknown): void;
    onActivity?(activity: McpHttpActivity): void;
}
export interface McpHttpServer {
    readonly host: string;
    readonly port: number;
    close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const CORS_ALLOWED_HEADERS = 'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id';
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'last-event-id', 'user-agent'];

function sendJson(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', ...headers });
    response.end(payload);
}

function rpcError(message: string): { jsonrpc: '2.0'; error: { code: number; message: string }; id: null } {
    return { jsonrpc: '2.0', error: { code: -32000, message }, id: null };
}

function readBody(request: http.IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let bytes = 0, exceeded = false;
        request.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) exceeded = true;
            else chunks.push(chunk);
        });
        request.once('end', () => resolve(exceeded ? null : Buffer.concat(chunks)));
        request.once('error', reject);
    });
}

function describeCall(body: Buffer | null): { method: string | null; tool: string | null } {
    if (!body?.length) return { method: null, tool: null };
    try {
        const message = JSON.parse(body.toString('utf8')) as { method?: unknown; params?: { name?: unknown } };
        const method = typeof message?.method === 'string' ? message.method.slice(0, 80) : null;
        const tool = method === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name.slice(0, 80) : null;
        return { method, tool };
    } catch {
        return { method: null, tool: null };
    }
}

async function writeWebResponse(source: Response, target: http.ServerResponse, extraHeaders: Record<string, string>): Promise<void> {
    const headers: Record<string, string> = { ...extraHeaders };
    source.headers.forEach((value, key) => { headers[key] = value; });
    target.writeHead(source.status, headers);
    if (!source.body) { target.end(); return; }
    const reader = source.body.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => undefined); };
    target.once('close', cancel);
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!target.write(chunk.value)) await new Promise<void>(resolve => target.once('drain', resolve));
        }
    } finally {
        target.off('close', cancel);
        target.end();
    }
}

export function startMcpHttpServer(options: McpHttpServerOptions): Promise<McpHttpServer> {
    const limiter = new AuthFailureLimiter();
    const server = http.createServer((request, response) => {
        void handle(request, response).catch(error => {
            options.log('mcp-request-failed', String(error));
            if (!response.headersSent) sendJson(response, 500, rpcError('Internal server error'));
            else response.destroy();
        });
    });

    async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
        const hostHeader = typeof request.headers.host === 'string' ? request.headers.host : undefined;
        let url: URL;
        try { url = new URL(request.url || '/', 'http://localhost'); } catch { sendJson(response, 400, rpcError('Invalid request URL')); return; }
        const credentials = readRequestCredentials(url.pathname, typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined);
        if (!credentials.endpoint) { sendJson(response, 404, rpcError('Not found')); return; }
        if (!isAllowedOrigin(origin, hostHeader)) { sendJson(response, 403, rpcError('Origin not allowed')); return; }
        const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Expose-Headers': 'mcp-session-id' } : {};
        if (request.method === 'OPTIONS') {
            response.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS, 'Access-Control-Max-Age': '600' });
            response.end();
            return;
        }
        const client = clientAddress(request.socket.remoteAddress, typeof request.headers['x-forwarded-for'] === 'string' ? request.headers['x-forwarded-for'] : undefined);
        const expected = options.token();
        if (!expected || !credentials.token || !tokensMatch(expected, credentials.token)) {
            request.resume();
            if (limiter.blocked(client)) { sendJson(response, 429, rpcError('Too many failed sign-in attempts'), { ...cors, 'Retry-After': '300' }); return; }
            limiter.recordFailure(client);
            options.log('mcp-auth-rejected', { client, presented: Boolean(credentials.token) });
            sendJson(response, 401, rpcError('Access token missing or invalid'), { ...cors, 'WWW-Authenticate': 'Bearer realm="Twitch Downloader MCP"' });
            return;
        }
        limiter.recordSuccess(client);
        const body = request.method === 'POST' ? await readBody(request) : (request.resume(), Buffer.alloc(0));
        if (body === null) { sendJson(response, 413, rpcError('Request body too large'), cors); return; }
        const headers = new Headers();
        for (const name of FORWARDED_REQUEST_HEADERS) {
            const value = request.headers[name];
            if (typeof value === 'string') headers.set(name, value);
        }
        const webRequest = new Request('http://' + (hostHeader || 'localhost') + MCP_ENDPOINT_PATH, {
            method: request.method || 'GET',
            headers,
            ...(request.method === 'POST' ? { body: new Uint8Array(body) } : {}),
        });
        options.onActivity?.({ at: Date.now(), client, ...describeCall(body) });
        await writeWebResponse(await options.handler.fetch(webRequest), response, cors);
    }

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
            server.off('error', reject);
            server.on('error', error => options.log('mcp-server-error', String(error)));
            const address = server.address() as AddressInfo;
            resolve({
                host: options.host,
                port: address.port,
                close: () => new Promise<void>(done => {
                    server.close(() => done());
                    server.closeAllConnections();
                }),
            });
        });
    });
}
