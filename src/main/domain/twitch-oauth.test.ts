import { test, expect, describe } from 'vitest';
import {
    startLoginFlow,
    awaitAuthorizationCode,
    exchangeCodeForToken,
    fetchTwitchUserInfo,
} from './twitch-oauth';
import * as http from 'http';

function httpGet(url: string): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            res.on('data', () => { /* drain */ });
            res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        });
        req.on('error', reject);
    });
}

describe('startLoginFlow', () => {
    test('builds Twitch authorize URL with required params + PKCE + state', async () => {
        const flow = await startLoginFlow({
            clientId: 'test-client',
            scopes: ['user:read:email', 'channel:read:subscriptions'],
        });
        try {
            expect(flow.authUrl).toContain('https://id.twitch.tv/oauth2/authorize');
            const url = new URL(flow.authUrl);
            expect(url.searchParams.get('client_id')).toBe('test-client');
            expect(url.searchParams.get('response_type')).toBe('code');
            expect(url.searchParams.get('scope')).toBe('user:read:email channel:read:subscriptions');
            expect(url.searchParams.get('state')).toBe(flow.state);
            expect(url.searchParams.get('code_challenge')).toBe(flow.pkce.codeChallenge);
            expect(url.searchParams.get('code_challenge_method')).toBe('S256');
            expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
        } finally {
            flow.server.close();
        }
    });
});

describe('awaitAuthorizationCode', () => {
    test('returns code on successful redirect with matching state', async () => {
        const flow = await startLoginFlow({ clientId: 't', scopes: ['user:read:email'] });
        try {
            const captureP = awaitAuthorizationCode(flow, 3000);
            await httpGet(`${flow.server.url}?code=AUTHCODE&state=${flow.state}`);
            const result = await captureP;
            expect(result.code).toBe('AUTHCODE');
            expect(result.state).toBe(flow.state);
        } finally {
            flow.server.close();
        }
    });

    test('rejects on state mismatch (CSRF protection)', async () => {
        const flow = await startLoginFlow({ clientId: 't', scopes: ['user:read:email'] });
        try {
            // .catch fangt unhandled rejection ab — wir pruefen den Error manuell.
            const captureP = awaitAuthorizationCode(flow, 3000).catch((e: Error) => e);
            await httpGet(`${flow.server.url}?code=AUTHCODE&state=WRONG_STATE`);
            const err = await captureP;
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toMatch(/state mismatch/);
        } finally {
            flow.server.close();
        }
    });

    test('rejects on error parameter', async () => {
        const flow = await startLoginFlow({ clientId: 't', scopes: ['user:read:email'] });
        try {
            const captureP = awaitAuthorizationCode(flow, 3000).catch((e: Error) => e);
            await httpGet(`${flow.server.url}?error=access_denied&error_description=user+denied`);
            const err = await captureP;
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toMatch(/access_denied/);
        } finally {
            flow.server.close();
        }
    });

    test('rejects on missing code', async () => {
        const flow = await startLoginFlow({ clientId: 't', scopes: ['user:read:email'] });
        try {
            const captureP = awaitAuthorizationCode(flow, 3000).catch((e: Error) => e);
            await httpGet(`${flow.server.url}?state=${flow.state}`);
            const err = await captureP;
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toMatch(/missing code/);
        } finally {
            flow.server.close();
        }
    });
});

describe('exchangeCodeForToken', () => {
    test('POSTs correct body and returns parsed token', async () => {
        let capturedBody: string | null = null;
        const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            capturedBody = init?.body as string;
            return new Response(JSON.stringify({
                access_token: 'ACC',
                refresh_token: 'REF',
                expires_in: 14400,
                scope: ['user:read:email'],
                token_type: 'bearer',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        const token = await exchangeCodeForToken({
            clientId: 'cid', code: 'CODE', codeVerifier: 'VERIFIER',
            redirectUri: 'http://127.0.0.1:5555/oauth/callback',
            fetchImpl: fakeFetch as unknown as typeof fetch,
        });
        expect(token.access_token).toBe('ACC');
        expect(token.refresh_token).toBe('REF');
        expect(capturedBody).toContain('client_id=cid');
        expect(capturedBody).toContain('code=CODE');
        expect(capturedBody).toContain('code_verifier=VERIFIER');
        expect(capturedBody).toContain('grant_type=authorization_code');
    });

    test('throws on non-2xx response', async () => {
        const fakeFetch = async (): Promise<Response> => new Response('bad request', { status: 400 });
        await expect(exchangeCodeForToken({
            clientId: 'cid', code: 'X', codeVerifier: 'V', redirectUri: 'http://x',
            fetchImpl: fakeFetch as unknown as typeof fetch,
        })).rejects.toThrow(/400/);
    });
});

describe('fetchTwitchUserInfo', () => {
    test('returns first user from helix /users response', async () => {
        const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const headers = init?.headers as Record<string, string>;
            expect(headers['Authorization']).toBe('Bearer TOKEN');
            expect(headers['Client-Id']).toBe('CID');
            return new Response(JSON.stringify({
                data: [{ id: '12345', login: 'alice', display_name: 'Alice' }],
            }), { status: 200 });
        };
        const user = await fetchTwitchUserInfo('TOKEN', 'CID', fakeFetch as unknown as typeof fetch);
        expect(user.id).toBe('12345');
        expect(user.login).toBe('alice');
        expect(user.display_name).toBe('Alice');
    });

    test('throws when no user in response', async () => {
        const fakeFetch = async (): Promise<Response> => new Response(JSON.stringify({ data: [] }), { status: 200 });
        await expect(fetchTwitchUserInfo('T', 'C', fakeFetch as unknown as typeof fetch))
            .rejects.toThrow(/no user/);
    });
});
