const SECRET_TERMS = ['authorization', 'cookie', 'password', 'secret', 'token'];

export function isSecretBearingKey(key: string): boolean {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return SECRET_TERMS.some((term) => normalized.includes(term)) || normalized === 'discordwebhookurl';
}

function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (isSecretBearingKey(key)) continue;
        result[key] = redact(entry);
    }
    return result;
}

export function createExportableConfig(config: Record<string, unknown>, exportedAt = new Date()): Record<string, unknown> {
    return {
        ...(redact(config) as Record<string, unknown>),
        __exportVersion: 2,
        __exportedAt: exportedAt.toISOString(),
    };
}
