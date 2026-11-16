import { describe, expect, it } from 'vitest';
import {
    AuthFailureLimiter,
    clientAddress,
    generateAccessToken,
    isAllowedOrigin,
    isValidAccessToken,
    mcpCopyAddresses,
    normalizeMcpPort,
    normalizeMcpPublicUrl,
    readRequestCredentials,
    resolveMcpCopyAddress,
    tokensMatch,
} from './access';

describe('access tokens', () => {
    it('creates distinct URL-safe keys with 256 bits of entropy', () => {
        const first = generateAccessToken(), second = generateAccessToken();
        expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(first).not.toBe(second);
        expect(isValidAccessToken(first)).toBe(true);
    });

    it('rejects short or malformed stored keys', () => {
        for (const value of ['', 'short', 'a'.repeat(31), 'a'.repeat(129), 'has space'.repeat(5), null, 42]) expect(isValidAccessToken(value)).toBe(false);
    });

    it('compares keys of any length without throwing', () => {
        const token = generateAccessToken();
        expect(tokensMatch(token, token)).toBe(true);
        expect(tokensMatch(token, token + 'x')).toBe(false);
        expect(tokensMatch(token, '')).toBe(false);
    });
});

describe('readRequestCredentials', () => {
    it('reads the bearer header on the endpoint', () => {
        expect(readRequestCredentials('/mcp', 'Bearer abc')).toEqual({ endpoint: true, token: 'abc', source: 'header' });
        expect(readRequestCredentials('/mcp/', 'bearer   abc  ')).toEqual({ endpoint: true, token: 'abc', source: 'header' });
        expect(readRequestCredentials('/mcp', undefined)).toEqual({ endpoint: true, token: null, source: null });
    });

    it('reads the key from the address when no header is sent', () => {
        expect(readRequestCredentials('/mcp/secret-key', undefined)).toEqual({ endpoint: true, token: 'secret-key', source: 'path' });
        expect(readRequestCredentials('/mcp/secret-key/', 'Basic xyz')).toEqual({ endpoint: true, token: 'secret-key', source: 'path' });
        expect(readRequestCredentials('/mcp/secret-key', 'Bearer other')).toEqual({ endpoint: true, token: 'other', source: 'header' });
    });

    it('does not treat other paths as the endpoint', () => {
        for (const path of ['/', '/mcpx', '/mcp/a/b', '/.well-known/oauth-protected-resource', '/api/mcp']) {
            expect(readRequestCredentials(path, 'Bearer abc').endpoint).toBe(false);
        }
    });
});

describe('isAllowedOrigin', () => {
    it('accepts requests without an origin and local or same-host origins', () => {
        expect(isAllowedOrigin(undefined, '127.0.0.1:47821')).toBe(true);
        expect(isAllowedOrigin('http://localhost:6274', '127.0.0.1:47821')).toBe(true);
        expect(isAllowedOrigin('http://127.0.0.1:5173', 'example.de')).toBe(true);
        expect(isAllowedOrigin('https://mcp.example.de', 'mcp.example.de')).toBe(true);
    });

    it('accepts the hosted Claude and ChatGPT clients', () => {
        for (const origin of ['https://claude.ai', 'https://www.claude.com', 'https://chatgpt.com', 'https://api.openai.com', 'https://console.anthropic.com']) {
            expect(isAllowedOrigin(origin, 'mcp.example.de')).toBe(true);
        }
    });

    it('rejects foreign websites, lookalikes and malformed origins', () => {
        for (const origin of ['https://evil.example', 'http://claude.ai', 'https://claude.ai.evil.example', 'https://notclaude.ai', 'null', 'file:///c:/x', 'not a url']) {
            expect(isAllowedOrigin(origin, '127.0.0.1:47821')).toBe(false);
        }
    });
});

describe('settings normalisation', () => {
    it('keeps valid ports and falls back to the default', () => {
        expect(normalizeMcpPort(50000)).toBe(50000);
        for (const value of [80, 70000, 1.5, '8080x', undefined]) expect(normalizeMcpPort(value)).toBe(47821);
    });

    it('reduces a public address to origin and base path', () => {
        expect(normalizeMcpPublicUrl(' https://mcp.example.de/ ')).toBe('https://mcp.example.de');
        expect(normalizeMcpPublicUrl('https://example.de/tools/mcp')).toBe('https://example.de/tools');
        expect(normalizeMcpPublicUrl('http://192.168.1.20:47821/mcp/')).toBe('http://192.168.1.20:47821');
        const withCredentials = ['https://user', 'pw@example.de'].join(':');
        for (const value of ['', 'ftp://example.de', withCredentials, 'https://example.de/?a=1', 'example.de', 5]) expect(normalizeMcpPublicUrl(value)).toBe('');
    });
});

describe('addresses for the copy buttons', () => {
    const local = 'http://127.0.0.1:47821/mcp', network = ['http://192.168.1.20:47821/mcp', 'http://10.8.0.2:47821/mcp'];

    it('offers the public address first, then the network addresses, then the local one', () => {
        expect(mcpCopyAddresses({ publicUrl: 'https://mcp.example.de', networkUrls: network, localUrl: local })).toEqual(['https://mcp.example.de/mcp', ...network, local]);
        expect(mcpCopyAddresses({ publicUrl: '', networkUrls: network, localUrl: local })).toEqual([...network, local]);
        expect(mcpCopyAddresses({ publicUrl: '', networkUrls: [], localUrl: local })).toEqual([local]);
        expect(mcpCopyAddresses({ publicUrl: 'http://192.168.1.20:47821', networkUrls: network, localUrl: local })).toEqual([...network, local]);
    });

    it('uses the network address by default when network access is on and nothing public is set', () => {
        expect(resolveMcpCopyAddress({ publicUrl: '', networkUrls: network, localUrl: local }, '')).toBe(network[0]);
        expect(resolveMcpCopyAddress({ publicUrl: '', networkUrls: [], localUrl: local }, undefined)).toBe(local);
    });

    it('accepts only an offered address as the choice', () => {
        const addresses = { publicUrl: 'https://mcp.example.de', networkUrls: network, localUrl: local };
        expect(resolveMcpCopyAddress(addresses, local)).toBe(local);
        expect(resolveMcpCopyAddress(addresses, network[1])).toBe(network[1]);
        expect(resolveMcpCopyAddress(addresses, 'https://evil.example/mcp')).toBe('https://mcp.example.de/mcp');
        expect(resolveMcpCopyAddress(addresses, 5)).toBe('https://mcp.example.de/mcp');
    });
});

describe('clientAddress', () => {
    it('uses the forwarded address only for a local reverse proxy', () => {
        expect(clientAddress('::ffff:203.0.113.5', '10.0.0.1')).toBe('203.0.113.5');
        expect(clientAddress('127.0.0.1', '198.51.100.7, 203.0.113.9')).toBe('203.0.113.9');
        expect(clientAddress('127.0.0.1', undefined)).toBe('127.0.0.1');
    });
});

describe('AuthFailureLimiter', () => {
    it('blocks after repeated failures until the window ends', () => {
        let now = 1000;
        const limiter = new AuthFailureLimiter(3, 60000, () => now);
        for (let attempt = 0; attempt < 3; attempt++) {
            expect(limiter.blocked('a')).toBe(false);
            limiter.recordFailure('a');
        }
        expect(limiter.blocked('a')).toBe(true);
        expect(limiter.blocked('b')).toBe(false);
        now += 60001;
        expect(limiter.blocked('a')).toBe(false);
    });

    it('forgets failures after a successful sign-in', () => {
        const limiter = new AuthFailureLimiter(2);
        limiter.recordFailure('a');
        limiter.recordFailure('a');
        limiter.recordSuccess('a');
        expect(limiter.blocked('a')).toBe(false);
    });
});
