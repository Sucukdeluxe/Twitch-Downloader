import { afterEach, describe, expect, it } from 'vitest';
import { startMcpHttpServer, type McpHttpActivity, type McpHttpServer } from './http-server';

const TOKEN = 'k'.repeat(43);
const servers: McpHttpServer[] = [];

async function start(overrides: { token?: string | null; onActivity?: (activity: McpHttpActivity) => void } = {}) {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const server = await startMcpHttpServer({
        host: '127.0.0.1',
        port: 0,
        token: () => overrides.token === undefined ? TOKEN : overrides.token,
        log: () => undefined,
        onActivity: overrides.onActivity,
        handler: {
            async fetch(request) {
                seen.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
                return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
            },
        },
    });
    servers.push(server);
    return { base: `http://127.0.0.1:${server.port}`, seen };
}

function post(url: string, headers: Record<string, string> = {}, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('MCP HTTP server', () => {
    it('forwards authenticated requests without exposing the key to the handler', async () => {
        const { base, seen } = await start();
        const response = await post(base + '/mcp', { authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2025-06-18', 'x-custom': 'dropped' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
        expect(seen).toHaveLength(1);
        expect(new URL(seen[0].url).pathname).toBe('/mcp');
        expect(seen[0].headers.authorization).toBeUndefined();
        expect(seen[0].headers['x-custom']).toBeUndefined();
        expect(seen[0].headers['mcp-protocol-version']).toBe('2025-06-18');
        expect(JSON.parse(seen[0].body).method).toBe('tools/list');
    });

    it('accepts the key as part of the address', async () => {
        const { base, seen } = await start();
        const response = await post(`${base}/mcp/${TOKEN}`);
        expect(response.status).toBe(200);
        expect(seen[0].url).not.toContain(TOKEN);
    });

    it('rejects missing and wrong keys with a bearer challenge', async () => {
        const { base, seen } = await start();
        for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Basic ${TOKEN}` }]) {
            const response = await post(base + '/mcp', headers);
            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate')).toContain('Bearer');
        }
        expect((await post(base + '/mcp/wrong-key')).status).toBe(401);
        expect(seen).toHaveLength(0);
    });

    it('rejects every request while no key is stored', async () => {
        const { base, seen } = await start({ token: null });
        expect((await post(base + '/mcp', { authorization: 'Bearer ' })).status).toBe(401);
        expect((await post(base + '/mcp/' + TOKEN)).status).toBe(401);
        expect(seen).toHaveLength(0);
    });

    it('slows repeated wrong keys but still accepts the right key', async () => {
        const { base } = await start();
        for (let attempt = 0; attempt < 10; attempt++) expect((await post(base + '/mcp', { authorization: 'Bearer wrong' })).status).toBe(401);
        const blocked = await post(base + '/mcp', { authorization: 'Bearer wrong' });
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('retry-after')).toBe('300');
        expect((await post(base + '/mcp', { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    });

    it('answers unknown paths with 404 before looking at credentials', async () => {
        const { base, seen } = await start();
        for (const path of ['/', '/.well-known/oauth-protected-resource', '/mcp/a/b', '/other']) {
            expect((await post(base + path, { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
        }
        expect(seen).toHaveLength(0);
    });

    it('rejects foreign browser origins and answers preflight for allowed ones', async () => {
        const { base, seen } = await start();
        expect((await post(base + '/mcp', { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })).status).toBe(403);
        expect(seen).toHaveLength(0);
        const preflight = await fetch(base + '/mcp', { method: 'OPTIONS', headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' } });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:6274');
        expect(preflight.headers.get('access-control-allow-headers')).toContain('mcp-protocol-version');
        const allowed = await post(base + '/mcp', { authorization: `Bearer ${TOKEN}`, origin: 'http://localhost:6274' });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:6274');
    });

    it('limits the request body to one megabyte', async () => {
        const { base, seen } = await start();
        const response = await post(base + '/mcp', { authorization: `Bearer ${TOKEN}` }, JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 10) }));
        expect(response.status).toBe(413);
        expect(seen).toHaveLength(0);
    });

    it('reports the called method and tool for the activity display', async () => {
        const activity: McpHttpActivity[] = [];
        const { base } = await start({ onActivity: entry => activity.push(entry) });
        await post(base + '/mcp', { authorization: `Bearer ${TOKEN}` }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
        expect(activity).toHaveLength(1);
        expect(activity[0]).toMatchObject({ method: 'tools/call', tool: 'get_status', client: '127.0.0.1' });
    });

    it('passes GET through so the protocol handler can answer it', async () => {
        const { base, seen } = await start();
        const response = await fetch(base + '/mcp', { headers: { authorization: `Bearer ${TOKEN}` } });
        expect(response.status).toBe(200);
        expect(seen[0].method).toBe('GET');
    });
});
