import { projectExternalError, type SafeExternalError } from '../domain/external-error';

export interface TwitchAppTokenCredentials {
    clientId: string;
    clientSecret: string;
}

export type TwitchAppTokenRequester = (credentials: TwitchAppTokenCredentials) => Promise<unknown>;
export type TwitchAppTokenErrorHandler = (error: SafeExternalError) => void;

export interface TwitchAppTokenHttpClient {
    post(url: string, data: null, config: {
        params: { client_id: string; client_secret: string; grant_type: 'client_credentials' };
        timeout: number;
    }): Promise<unknown>;
}

export async function requestTwitchAppAccessToken(
    client: TwitchAppTokenHttpClient,
    credentials: TwitchAppTokenCredentials,
    timeoutMs: number,
): Promise<string> {
    const response = await client.post('https://id.twitch.tv/oauth2/token', null, {
        params: {
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            grant_type: 'client_credentials',
        },
        timeout: timeoutMs,
    });
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new Error('Twitch app token response was invalid');
    }
    const data = (response as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Twitch app token response was invalid');
    }
    const token = (data as Record<string, unknown>).access_token;
    if (typeof token !== 'string' || !token.trim()) {
        throw new Error('Twitch app token response was invalid');
    }
    return token.trim();
}

function hasCredentials(credentials: TwitchAppTokenCredentials): boolean {
    return credentials.clientId.trim().length > 0 && credentials.clientSecret.trim().length > 0;
}

function sameCredentials(left: TwitchAppTokenCredentials | null, right: TwitchAppTokenCredentials): boolean {
    return left?.clientId === right.clientId && left.clientSecret === right.clientSecret;
}

export class TwitchAppTokenService {
    private token: string | null = null;
    private credentials: TwitchAppTokenCredentials | null = null;
    private activeRequest: Promise<string | null> | null = null;
    private generation = 0;

    constructor(
        private readonly requestToken: TwitchAppTokenRequester,
        private readonly onError?: TwitchAppTokenErrorHandler,
    ) { }

    get currentToken(): string | null {
        return this.token;
    }

    ensure(credentials: TwitchAppTokenCredentials, forceRefresh = false): Promise<string | null> {
        if (!hasCredentials(credentials)) {
            this.clear();
            return Promise.resolve(null);
        }

        if (!sameCredentials(this.credentials, credentials)) {
            this.invalidate();
            this.credentials = { ...credentials };
        }

        if (this.activeRequest) return this.activeRequest;
        if (!forceRefresh && this.token) return Promise.resolve(this.token);

        const requestGeneration = this.generation;
        const requestCredentials = { ...credentials };
        const request = this.resolveRequest(requestCredentials, requestGeneration);
        const tracked = request.finally(() => {
            if (this.activeRequest === tracked) this.activeRequest = null;
        });
        this.activeRequest = tracked;
        return tracked;
    }

    clear(): void {
        this.invalidate();
        this.credentials = null;
    }

    private invalidate(): void {
        this.generation += 1;
        this.token = null;
        this.activeRequest = null;
    }

    private async resolveRequest(credentials: TwitchAppTokenCredentials, generation: number): Promise<string | null> {
        try {
            const response = await this.requestToken(credentials);
            if (typeof response !== 'string' || !response.trim()) {
                throw new Error('Twitch app token response was invalid');
            }
            if (this.generation !== generation) return null;
            this.token = response.trim();
            return this.token;
        } catch (error) {
            if (this.generation !== generation) return null;
            this.token = null;
            try {
                this.onError?.(projectExternalError('twitch-oauth', error));
            } catch { }
            return null;
        }
    }
}
