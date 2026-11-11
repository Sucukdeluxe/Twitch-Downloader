import type { RefreshOutcome } from './refresh-result';

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseGraphqlDataEnvelope(value: unknown): RefreshOutcome<Record<string, unknown>> {
    const envelope = asRecord(value);
    if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data')) return { status: 'unavailable' };
    const data = asRecord(envelope.data);
    return data ? { status: 'success', value: data } : { status: 'unavailable' };
}

export function parseGraphqlUser(value: unknown): RefreshOutcome<Record<string, unknown>> {
    const data = asRecord(value);
    if (!data || !Object.prototype.hasOwnProperty.call(data, 'user')) return { status: 'unavailable' };
    if (data.user === null) return { status: 'not-found' };
    const user = asRecord(data.user);
    return user ? { status: 'success', value: user } : { status: 'unavailable' };
}

export function parseHelixDataArray(value: unknown): RefreshOutcome<unknown[]> {
    const envelope = asRecord(value);
    if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data') || !Array.isArray(envelope.data)) return { status: 'unavailable' };
    return { status: 'success', value: envelope.data };
}
