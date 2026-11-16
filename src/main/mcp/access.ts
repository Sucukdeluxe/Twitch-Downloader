import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MCP_ENDPOINT_PATH = '/mcp';
export const MCP_DEFAULT_PORT = 47821;
export const MCP_MIN_PORT = 1024;
export const MCP_MAX_PORT = 65535;

const TRUSTED_CLIENT_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com', 'chatgpt.com', 'openai.com'];
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function generateAccessToken(): string {
    return randomBytes(32).toString('base64url');
}

export function isValidAccessToken(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function tokensMatch(expected: string, candidate: string): boolean {
    const left = createHash('sha256').update(expected).digest();
    const right = createHash('sha256').update(candidate).digest();
    return timingSafeEqual(left, right);
}

export function normalizeMcpPort(value: unknown): number {
    const port = Number(value);
    return Number.isInteger(port) && port >= MCP_MIN_PORT && port <= MCP_MAX_PORT ? port : MCP_DEFAULT_PORT;
}

export function normalizeMcpPublicUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 300) return '';
    let url: URL;
    try { url = new URL(value.trim()); } catch { return ''; }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return '';
    const basePath = url.pathname.replace(/\/+$/, '').replace(new RegExp(MCP_ENDPOINT_PATH + '$'), '');
    return url.origin + basePath;
}

export interface McpAddresses { publicUrl: string; networkUrls: string[]; localUrl: string }

export function mcpCopyAddresses(addresses: McpAddresses): string[] {
    const publicAddress = addresses.publicUrl ? addresses.publicUrl + MCP_ENDPOINT_PATH : '';
    return [...new Set([publicAddress, ...addresses.networkUrls, addresses.localUrl].filter(Boolean))];
}

export function resolveMcpCopyAddress(addresses: McpAddresses, requested: unknown): string {
    const offered = mcpCopyAddresses(addresses);
    return typeof requested === 'string' && offered.includes(requested) ? requested : offered[0];
}

export interface RequestCredentials { endpoint: boolean; token: string | null; source: 'header' | 'path' | null }

export function readRequestCredentials(pathname: string, authorization: string | undefined): RequestCredentials {
    const normalized = pathname.replace(/\/+$/, '') || '/';
    const header = /^Bearer\s+(\S+)\s*$/i.exec(authorization || '')?.[1] ?? null;
    if (normalized === MCP_ENDPOINT_PATH) return { endpoint: true, token: header, source: header ? 'header' : null };
    if (normalized.startsWith(MCP_ENDPOINT_PATH + '/')) {
        const segment = normalized.slice(MCP_ENDPOINT_PATH.length + 1);
        if (!segment.includes('/')) return { endpoint: true, token: header ?? segment, source: header ? 'header' : 'path' };
    }
    return { endpoint: false, token: null, source: null };
}

function hostnameOf(value: string | undefined): string | null {
    if (!value) return null;
    try { return new URL('http://' + value).hostname.toLowerCase(); } catch { return null; }
}

export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
    if (origin === undefined || origin === '') return true;
    let url: URL;
    try { url = new URL(origin); } catch { return false; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase();
    if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
    if (hostname === hostnameOf(hostHeader)) return true;
    return url.protocol === 'https:' && TRUSTED_CLIENT_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
}

export function clientAddress(remoteAddress: string | undefined, forwardedFor: string | undefined): string {
    const remote = (remoteAddress || 'unknown').replace(/^::ffff:/, '');
    if (!LOOPBACK_HOSTNAMES.has(remote) || !forwardedFor) return remote;
    const forwarded = forwardedFor.split(',').map(entry => entry.trim()).filter(Boolean).at(-1);
    return forwarded && forwarded.length <= 64 ? forwarded : remote;
}

export class AuthFailureLimiter {
    private readonly failures = new Map<string, { count: number; resetAt: number }>();

    constructor(private readonly limit = 10, private readonly windowMs = 5 * 60 * 1000, private readonly now: () => number = Date.now) {}

    blocked(client: string): boolean {
        const entry = this.failures.get(client);
        if (!entry) return false;
        if (entry.resetAt <= this.now()) {
            this.failures.delete(client);
            return false;
        }
        return entry.count >= this.limit;
    }

    recordFailure(client: string): void {
        const now = this.now();
        for (const [key, entry] of this.failures) if (entry.resetAt <= now) this.failures.delete(key);
        if (!this.failures.has(client) && this.failures.size >= 2048) this.failures.delete(this.failures.keys().next().value!);
        const entry = this.failures.get(client);
        if (entry) entry.count += 1;
        else this.failures.set(client, { count: 1, resetAt: now + this.windowMs });
    }

    recordSuccess(client: string): void {
        this.failures.delete(client);
    }
}
