// Pure normalizer-Helpers fuer Config-Felder. Keine Side-Effects, keine Globals.

export type PerformanceMode = 'stability' | 'balanced' | 'speed';

export const VALID_STREAMLINK_QUALITIES = ['source'] as const;

const AUTO_RECORD_POLL_MIN_SECONDS = 30;
const AUTO_RECORD_POLL_MAX_SECONDS = 1800;
export const DEFAULT_METADATA_CACHE_MINUTES = 10;
export const DEFAULT_PERFORMANCE_MODE: PerformanceMode = 'balanced';

/** trim + strip leading @ + lowercase. Verbatim aus altem main.ts. */
export function normalizeLogin(input: string): string {
    return input.trim().replace(/^@+/, '').toLowerCase();
}

export function normalizeAutoRecordPollSeconds(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 90;
    return Math.max(AUTO_RECORD_POLL_MIN_SECONDS, Math.min(AUTO_RECORD_POLL_MAX_SECONDS, Math.floor(parsed)));
}

export function normalizeAutoRecordList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of value) {
        if (typeof v !== 'string') continue;
        const cleaned = normalizeLogin(v);
        if (cleaned && !seen.has(cleaned)) {
            seen.add(cleaned);
            out.push(cleaned);
        }
    }
    return out;
}

export function normalizeStreamlinkQuality(_value: unknown): 'source' {
    return 'source';
}

export function normalizeFilenameTemplate(template: string | undefined, fallback: string): string {
    const value = (template || '').trim();
    return value || fallback;
}

export function normalizeMetadataCacheMinutes(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_METADATA_CACHE_MINUTES;
    }
    return Math.max(1, Math.min(120, Math.floor(parsed)));
}

export function normalizePerformanceMode(mode: unknown): PerformanceMode {
    if (mode === 'stability' || mode === 'balanced' || mode === 'speed') {
        return mode;
    }
    return DEFAULT_PERFORMANCE_MODE;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
