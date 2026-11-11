import { test, expect, describe } from 'vitest';
import * as http from 'http';
import { startLoopbackServer } from './loopback-server';

function httpGet(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            let body = '';
            res.on('data', chunk => { body += chunk.toString(); });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
    });
}

describe('startLoopbackServer', () => {
    test('binds to 127.0.0.1 and returns url with pathPrefix', async () => {
        const server = await startLoopbackServer({ pathPrefix: '/cb' });
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/);
        server.close();
    });

    test('captures redirect params (code + state)', async () => {
        const server = await startLoopbackServer({ pathPrefix: '/cb' });
        const captureP = server.awaitParams({ timeoutMs: 3000 });
        const response = await httpGet(`${server.url}?code=abc123&state=xyz`);
        expect(response.status).toBe(200);
        const params = await captureP;
        expect(params.get('code')).toBe('abc123');
        expect(params.get('state')).toBe('xyz');
        server.close();
    });

    test('non-matching path returns 404, capture not triggered', async () => {
        const server = await startLoopbackServer({ pathPrefix: '/cb' });
        const captureP = server.awaitParams({ timeoutMs: 500 });
        const response = await httpGet(`${server.url.replace('/cb', '/other')}`);
        expect(response.status).toBe(404);
        await expect(captureP).rejects.toThrow(/timeout/);
        server.close();
    });

    test('error param renders errorHtml', async () => {
        const server = await startLoopbackServer({ pathPrefix: '/cb' });
        const captureP = server.awaitParams({ timeoutMs: 3000 });
        const response = await httpGet(`${server.url}?error=access_denied`);
        expect(response.body).toContain('Fehler');
        const params = await captureP;
        expect(params.get('error')).toBe('access_denied');
        server.close();
    });

    test('timeout rejects', async () => {
        const server = await startLoopbackServer({ pathPrefix: '/cb' });
        await expect(server.awaitParams({ timeoutMs: 200 })).rejects.toThrow(/timeout/);
        server.close();
    });
});
