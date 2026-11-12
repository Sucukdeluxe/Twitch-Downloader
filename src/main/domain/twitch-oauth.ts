import { createPkcePair, generateState, type PkcePair } from './pkce';
import { startLoopbackServer, type LoopbackServer } from '../infra/loopback-server';

/**
 * Twitch OAuth 2.1 Authorization Code Flow + PKCE.
 *
 * Twitch supports PKCE since ~2022. Endpoints:
 *   Authorize: https://id.twitch.tv/oauth2/authorize
 *   Token:     https://id.twitch.tv/oauth2/token
 *   Validate:  https://id.twitch.tv/oauth2/validate
 *   Helix /users (whoami): https://api.twitch.tv/helix/users
 *
 * Flow:
 *   1. startLoginFlow({clientId, scopes}) → { authUrl, ... }
 *   2. shell.openExternal(authUrl) im Caller (main.ts hat shell)
 *   3. await completeLoginFlow(state) → wartet auf Loopback-Redirect
 *   4. Exchange code+verifier gegen token via fetch
 *   5. Helix /users mit Bearer-Token → twitch_user_id + login + display_name
 *
 * Plan 03b liefert NUR Module + Tests. Eigentlicher login-flow IPC handler
 * + Renderer-Button kommt in Folgeplan, weil das Twitch-Account-Setup
 * (Client-ID in Twitch Dev Console mit korrektem Redirect-URI) erst
 * vorbereitet werden muss.
 */

const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_HELIX_USERS_URL = 'https://api.twitch.tv/helix/users';

export interface TwitchTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string[];
    token_type: 'bearer';
}

export interface TwitchUserInfo {
    id: string;
    login: string;
    display_name: string;
}

export interface LoginStart {
    authUrl: string;
    state: string;
    pkce: PkcePair;
    server: LoopbackServer;
    redirectUri: string;
}

export interface LoginStartOptions {
    clientId: string;
    scopes: string[];
    pathPrefix?: string;        // default '/oauth/callback'
    port?: number;              // 0 = OS-chooses
}

export async function startLoginFlow(opts: LoginStartOptions): Promise<LoginStart> {
    const server = await startLoopbackServer({
        pathPrefix: opts.pathPrefix ?? '/oauth/callback',
        port: opts.port,
    });

    const pkce = createPkcePair();
    const state = generateState();
    const redirectUri = server.url;

    const params = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: opts.scopes.join(' '),
        state,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: pkce.codeChallengeMethod,
        force_verify: 'true',
    });
    const authUrl = `${TWITCH_AUTHORIZE_URL}?${params.toString()}`;

    return { authUrl, state, pkce, server, redirectUri };
}

export interface CompleteLoginResult {
    code: string;
    state: string;
}

/**
 * Wartet auf Redirect-Capture und prueft state.
 * Throws bei mismatch state, bei `?error=` Parameter, oder bei Timeout.
 */
export async function awaitAuthorizationCode(login: LoginStart, timeoutMs?: number): Promise<CompleteLoginResult> {
    const params = await login.server.awaitParams({ timeoutMs });
    if (params.has('error')) {
        const rawError = params.get('error') ?? '';
        const errorCode = /^[A-Za-z0-9_.-]{1,80}$/.test(rawError) ? rawError : 'unknown_error';
        throw new Error(`twitch-oauth: provider error: ${errorCode}`);
    }
    const returnedState = params.get('state') ?? '';
    if (returnedState !== login.state) {
        throw new Error('twitch-oauth: state mismatch (possible CSRF or stale flow)');
    }
    const code = params.get('code');
    if (!code) {
        throw new Error('twitch-oauth: missing code parameter');
    }
    return { code, state: returnedState };
}

export interface TokenExchangeOptions {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    fetchImpl?: typeof fetch;
}

export async function exchangeCodeForToken(opts: TokenExchangeOptions): Promise<TwitchTokenResponse> {
    const fetchFn = opts.fetchImpl ?? fetch;
    const body = new URLSearchParams({
        client_id: opts.clientId,
        code: opts.code,
        code_verifier: opts.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: opts.redirectUri,
    });

    let res: Response;
    try {
        res = await fetchFn(TWITCH_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
    } catch {
        throw new Error('twitch-oauth: token request failed');
    }
    if (!res.ok) throw new Error(`twitch-oauth: token endpoint returned HTTP ${res.status}`);
    try {
        return JSON.parse(await res.text()) as TwitchTokenResponse;
    } catch {
        throw new Error('twitch-oauth: invalid token response');
    }
}

export async function fetchTwitchUserInfo(
    accessToken: string,
    clientId: string,
    fetchImpl?: typeof fetch
): Promise<TwitchUserInfo> {
    const fetchFn = fetchImpl ?? fetch;
    let res: Response;
    try {
        res = await fetchFn(TWITCH_HELIX_USERS_URL, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': clientId,
            },
        });
    } catch {
        throw new Error('twitch-oauth: helix /users request failed');
    }
    if (!res.ok) throw new Error(`twitch-oauth: helix /users returned HTTP ${res.status}`);
    let json: { data?: TwitchUserInfo[] };
    try {
        json = JSON.parse(await res.text()) as { data?: TwitchUserInfo[] };
    } catch {
        throw new Error('twitch-oauth: invalid helix /users response');
    }
    const first = json.data?.[0];
    if (!first) throw new Error('twitch-oauth: helix /users returned no user');
    return first;
}
