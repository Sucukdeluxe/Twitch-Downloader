export interface SafeExternalError {
    provider: string;
    message: string;
    code?: string;
    status?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decodeRepeatedURIComponent(value: string): string {
    let decoded = value;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            break;
        }
    }
    return decoded;
}

function keyWords(key: string): string[] {
    return decodeRepeatedURIComponent(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function isSensitiveLogKey(key: string): boolean {
    const words = keyWords(key);
    const compact = words.join('');
    if (compact === 'notasecret' || compact === 'tokencount' || compact === 'cookieconsent') return false;
    if (
        compact === 'apikey'
        || compact === 'xapikey'
        || compact === 'sessionid'
        || compact === 'discordwebhookurl'
        || compact === 'authorizationheader'
        || compact === 'cookieheader'
        || compact === 'setcookie'
        || compact === 'accesstoken'
        || compact === 'refreshtoken'
        || compact === 'clientsecret'
    ) return true;
    return words.some((word, index) => {
        if (word === 'authorization' || word === 'password' || word === 'passwd' || word === 'secret' || word === 'credential' || word === 'credentials') return true;
        if (word === 'token') return words[index + 1] !== 'count';
        if (word === 'cookie' || word === 'cookies') return words[index + 1] !== 'consent';
        if (word === 'api' && words[index + 1] === 'key') return true;
        return word === 'session' && words[index + 1] === 'id';
    });
}

function decodeUrlSegment(value: string): string {
    return decodeRepeatedURIComponent(value).toLowerCase();
}

function normalizeUrl(rawUrl: string): string {
    return decodeRepeatedURIComponent(rawUrl);
}

function redactExternalUrl(rawUrl: string): string {
    try {
        const parsed = new URL(normalizeUrl(rawUrl));
        const hostname = parsed.hostname.toLowerCase();
        const pathSegments = parsed.pathname.split('/').filter(Boolean).map(decodeUrlSegment);
        const webhookSegment = /^v\d+$/.test(pathSegments[1] ?? '') ? 2 : 1;
        const isDiscordWebhook = (
            hostname === 'discord.com'
            || hostname === 'discordapp.com'
            || hostname === 'canary.discord.com'
            || hostname === 'canary.discordapp.com'
            || hostname === 'ptb.discord.com'
            || hostname === 'ptb.discordapp.com'
        ) && pathSegments[0]?.toLowerCase() === 'api'
            && pathSegments[webhookSegment]?.toLowerCase() === 'webhooks';
        if (isDiscordWebhook) return '[REDACTED]';
        for (const key of Array.from(parsed.searchParams.keys())) {
            if (isSensitiveLogKey(key)) parsed.searchParams.set(key, '[REDACTED]');
        }
        const safeUrl = parsed.toString();
        if (!parsed.username && !parsed.password) return safeUrl;
        const authorityStart = safeUrl.indexOf('//') + 2;
        const authorityEnd = ['/', '?', '#']
            .map((separator) => safeUrl.indexOf(separator, authorityStart))
            .filter((index) => index >= 0)
            .reduce((minimum, index) => Math.min(minimum, index), safeUrl.length);
        const userInfoEnd = safeUrl.lastIndexOf('@', authorityEnd);
        if (userInfoEnd < authorityStart) return safeUrl;
        return `${safeUrl.slice(0, authorityStart)}[REDACTED]@${safeUrl.slice(userInfoEnd + 1)}`;
    } catch {
        return rawUrl;
    }
}

function decodeEscapedSyntax(value: string): string {
    let normalized = '';
    for (let index = 0; index < value.length; index += 1) {
        const current = value[index];
        const next = value[index + 1];
        const unicodeValue = value.slice(index + 2, index + 6);
        if (current === '\\' && next === 'u' && /^[0-9a-f]{4}$/i.test(unicodeValue)) {
            normalized += String.fromCharCode(Number.parseInt(unicodeValue, 16));
            index += 5;
        } else if (current === '\\' && (next === '\\' || next === '/')) {
            normalized += next;
            index += 1;
        } else {
            normalized += current;
        }
    }
    return normalized;
}

function findQuotedValueEnd(value: string, start: number, quote: string): number {
    for (let index = start + 1; index < value.length; index += 1) {
        if (value[index] !== quote) continue;
        let backslashes = 0;
        for (let cursor = index - 1; cursor >= start && value[cursor] === '\\'; cursor -= 1) backslashes += 1;
        if (backslashes % 2 === 0) return index + 1;
    }
    return value.length;
}

function findUnquotedValueEnd(value: string, start: number): number {
    for (let index = start; index < value.length; index += 1) {
        if (/\s/.test(value[index]) || value[index] === ',' || value[index] === '}') return index;
    }
    return value.length;
}

function redactAssignments(value: string): string {
    const assignment = /(?<![A-Za-z0-9_./%-])([A-Za-z][A-Za-z0-9%_. -]{0,63})(?:["'])?[ \t]*[:=][ \t]*/g;
    let output = '';
    let copiedUntil = 0;
    let match: RegExpExecArray | null;
    while ((match = assignment.exec(value)) !== null) {
        if (!isSensitiveLogKey(match[1].trim())) continue;
        const valueStart = assignment.lastIndex;
        const openingQuote = value[valueStart];
        const valueEnd = openingQuote === '"' || openingQuote === "'"
            ? findQuotedValueEnd(value, valueStart, openingQuote)
            : findUnquotedValueEnd(value, valueStart);
        const replacement = openingQuote === '"' || openingQuote === "'"
            ? `${openingQuote}[REDACTED]${valueEnd <= value.length && value[valueEnd - 1] === openingQuote ? openingQuote : ''}`
            : '[REDACTED]';
        output += value.slice(copiedUntil, valueStart) + replacement;
        copiedUntil = valueEnd;
        assignment.lastIndex = valueEnd;
    }
    return output + value.slice(copiedUntil);
}

function redactHeaderLines(value: string): string {
    const header = /(\b(?:proxy-authorization|authorization|set-cookie|cookie)[ \t]*[:=][ \t]*)/i;
    let redactContinuation = false;
    return value.split(/(\r\n|\n|\r)/).map((line, index) => {
        if (index % 2 === 1) return line;
        const match = header.exec(line);
        if (match) {
            redactContinuation = true;
            return `${line.slice(0, match.index)}${match[1]}[REDACTED]`;
        }
        if (redactContinuation && /^[ \t]+/.test(line)) return `${line.match(/^[ \t]+/)?.[0] ?? ''}[REDACTED]`;
        redactContinuation = false;
        return line;
    }).join('');
}

const SAFE_EXTERNAL_ERROR_CODES = new Set([
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'EAI_AGAIN',
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'ERR_BAD_OPTION',
    'ERR_BAD_OPTION_VALUE',
    'ERR_BAD_REQUEST',
    'ERR_BAD_RESPONSE',
    'ERR_CANCELED',
    'ERR_DEPRECATED',
    'ERR_FR_TOO_MANY_REDIRECTS',
    'ERR_INVALID_URL',
    'ERR_NETWORK',
    'ERR_NOT_SUPPORT',
    'ETIMEDOUT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
]);

function isSafeExternalErrorCode(value: string): boolean {
    return SAFE_EXTERNAL_ERROR_CODES.has(value);
}

function sanitizeSerializedText(value: string): string | null {
    const candidates = [value];
    if (value.includes('\\"') || value.includes('\\/')) candidates.push(`"${value}"`);
    for (const candidate of candidates) {
        let current: unknown = candidate;
        for (let layer = 0; layer < 3 && typeof current === 'string'; layer += 1) {
            try {
                current = JSON.parse(current) as unknown;
            } catch {
                break;
            }
            if (current !== null && typeof current === 'object') {
                return JSON.stringify(sanitizeValue(current, new WeakSet<object>(), 0));
            }
        }
    }
    return null;
}

export function redactSensitiveText(value: string): string {
    const structured = sanitizeSerializedText(value);
    if (structured !== null) return structured.slice(0, 1000);
    const withRedactedUrls = decodeEscapedSyntax(value)
        .replace(/\bhttps%(?:25){0,3}3a%(?:25){0,3}2f%(?:25){0,3}2f[^\s"'<>]+/gi, redactExternalUrl)
        .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, redactExternalUrl);
    return redactAssignments(redactHeaderLines(withRedactedUrls))
        .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
        .slice(0, 1000);
}

export function projectExternalError(provider: string, error: unknown): SafeExternalError {
    const record = asRecord(error);
    const response = asRecord(record?.response);
    const rawMessage = error instanceof Error
        ? error.message
        : typeof record?.message === 'string'
            ? record.message
            : typeof error === 'string'
                ? error
                : 'External request failed';
    const projected: SafeExternalError = {
        provider,
        message: redactSensitiveText(rawMessage),
    };
    if (typeof record?.code === 'string' && isSafeExternalErrorCode(record.code)) projected.code = record.code;
    if (typeof response?.status === 'number' && Number.isInteger(response.status)) projected.status = response.status;
    return projected;
}

function isExternalErrorRecord(value: Record<string, unknown>): boolean {
    return value.isAxiosError === true || value.name === 'AxiosError' || value instanceof Error;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (typeof value === 'string') return redactSensitiveText(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    if (depth >= 6) return '[Truncated]';
    seen.add(value);
    if (value instanceof Error) return projectExternalError('external', value);
    if (Array.isArray(value)) {
        const entries = value.slice(0, 100);
        if (typeof entries[0] === 'string' && isSensitiveLogKey(entries[0])) {
            return entries.map((entry, index) => index === 1 ? '[REDACTED]' : sanitizeValue(entry, seen, depth + 1));
        }
        return entries.map((entry) => sanitizeValue(entry, seen, depth + 1));
    }
    const record = value as Record<string, unknown>;
    if (isExternalErrorRecord(record)) return projectExternalError('external', record);
    const redactedNamedValue = typeof record.name === 'string' && isSensitiveLogKey(record.name) && Object.hasOwn(record, 'value');
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record).slice(0, 100)) {
        if (isSensitiveLogKey(key)) continue;
        result[key] = redactedNamedValue && key === 'value' ? '[REDACTED]' : sanitizeValue(entry, seen, depth + 1);
    }
    return result;
}

export function sanitizeLogDetails(value: unknown): unknown {
    return sanitizeValue(value, new WeakSet<object>(), 0);
}
