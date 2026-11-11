export interface LocalDownloadWindow {
    start: string;
    end: string;
}

export interface DownloadThrottle {
    maxBytesPerSecond: number;
}

export interface DownloadPolicy {
    throttle: DownloadThrottle | null;
    windows: LocalDownloadWindow[];
}

export interface DownloadStartDecision {
    allowed: boolean;
    reason: 'unrestricted' | 'within-window' | 'outside-window' | 'manual-override';
    maxBytesPerSecond: number | null;
    nextStart: Date | null;
}

interface ParsedLocalDownloadWindow extends LocalDownloadWindow {
    startMinute: number;
    endMinute: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseLocalTime(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
}

function parseWindow(value: unknown): ParsedLocalDownloadWindow | null {
    const record = asRecord(value);
    if (!record) return null;
    const startMinute = parseLocalTime(record.start);
    const endMinute = parseLocalTime(record.end);
    if (startMinute === null || endMinute === null || startMinute === endMinute) return null;
    return { start: record.start as string, end: record.end as string, startMinute, endMinute };
}

function parseThrottle(value: unknown): DownloadThrottle | null {
    const record = asRecord(value);
    const maxBytesPerSecond = record?.maxBytesPerSecond;
    if (typeof maxBytesPerSecond !== 'number' || !Number.isSafeInteger(maxBytesPerSecond) || maxBytesPerSecond <= 0) return null;
    return { maxBytesPerSecond };
}

function toLocalDateAtMinute(reference: Date, minuteOfDay: number, dayOffset = 0): Date {
    return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + dayOffset, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
}

function localMinuteOfDay(value: Date): number {
    return value.getHours() * 60 + value.getMinutes();
}

function isWithinParsedWindow(nowMinute: number, window: ParsedLocalDownloadWindow): boolean {
    if (window.startMinute < window.endMinute) return nowMinute >= window.startMinute && nowMinute < window.endMinute;
    return nowMinute >= window.startMinute || nowMinute < window.endMinute;
}

function nextWindowStart(now: Date, windows: ParsedLocalDownloadWindow[]): Date {
    return windows.reduce<Date | null>((earliest, window) => {
        let candidate = toLocalDateAtMinute(now, window.startMinute);
        if (candidate.getTime() <= now.getTime()) candidate = toLocalDateAtMinute(now, window.startMinute, 1);
        return earliest === null || candidate.getTime() < earliest.getTime() ? candidate : earliest;
    }, null) ?? now;
}

export function normalizeDownloadPolicy(value: unknown): DownloadPolicy {
    const record = asRecord(value);
    const seen = new Set<string>();
    const windows: LocalDownloadWindow[] = [];
    if (Array.isArray(record?.windows)) {
        for (const candidate of record.windows) {
            const parsed = parseWindow(candidate);
            if (!parsed) continue;
            const key = `${parsed.start}-${parsed.end}`;
            if (seen.has(key)) continue;
            seen.add(key);
            windows.push({ start: parsed.start, end: parsed.end });
        }
    }
    return { throttle: parseThrottle(record?.throttle), windows };
}

export function isWithinLocalDownloadWindow(now: Date, window: LocalDownloadWindow): boolean {
    const parsed = parseWindow(window);
    return parsed !== null && isWithinParsedWindow(localMinuteOfDay(now), parsed);
}

export function decideDownloadStart(policy: DownloadPolicy, now: Date, manualOverride = false): DownloadStartDecision {
    const parsedWindows = policy.windows.map(parseWindow).filter((window): window is ParsedLocalDownloadWindow => window !== null);
    const maxBytesPerSecond = policy.throttle?.maxBytesPerSecond ?? null;
    if (parsedWindows.length === 0) return { allowed: true, reason: 'unrestricted', maxBytesPerSecond, nextStart: null };
    if (manualOverride) return { allowed: true, reason: 'manual-override', maxBytesPerSecond, nextStart: null };
    if (parsedWindows.some((window) => isWithinParsedWindow(localMinuteOfDay(now), window))) {
        return { allowed: true, reason: 'within-window', maxBytesPerSecond, nextStart: null };
    }
    return { allowed: false, reason: 'outside-window', maxBytesPerSecond, nextStart: nextWindowStart(now, parsedWindows) };
}

export function decideStandaloneDownloadStart(policy: DownloadPolicy, now: Date): DownloadStartDecision {
    return decideDownloadStart(policy, now, false);
}
