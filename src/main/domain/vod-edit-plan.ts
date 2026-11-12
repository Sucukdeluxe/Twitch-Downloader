export interface OmittedRange { start: number; end: number }
export interface OmissionConfig { version: 1; partDurationSec: number; ranges: OmittedRange[]; selection?: OmittedRange }
export interface EditedVodPart { number: number; start: number; duration: number; ranges: OmittedRange[] }
export interface EditedVodPlan { duration: number; omittedDuration: number; ranges: OmittedRange[]; omitted: OmittedRange[]; skippedNumbers: number[]; parts: EditedVodPart[] }

export function normalizeOmissions(ranges: OmittedRange[], duration: number): OmittedRange[] {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400 || !Array.isArray(ranges) || ranges.length > 256) throw new Error('Invalid VOD exclusion range');
    const total = Math.round(duration * 1000);
    const normalized = ranges.map(range => {
        if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end > duration || range.end <= range.start) throw new Error('Invalid VOD exclusion range');
        const start = Math.round(range.start * 1000), end = Math.min(total, Math.round(range.end * 1000));
        if (start >= end) throw new Error('Invalid VOD exclusion range');
        return { start, end };
    }).sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: OmittedRange[] = [];
    for (const range of normalized) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push({ ...range });
    }
    return merged.map(range => ({ start: range.start / 1000, end: range.end / 1000 }));
}

export function planEditedVod(duration: number, partDuration: number, omissions: OmittedRange[], startPart = 1, selection?: OmittedRange): EditedVodPlan {
    if (!Number.isFinite(partDuration) || partDuration < .1 || partDuration > 86400 || !Number.isInteger(startPart) || startPart < 1 || startPart > 100000) throw new Error('Invalid VOD part settings');
    const normalized = normalizeOmissions(omissions, duration);
    const selected = selection === undefined ? { start: 0, end: duration } : normalizeOmissions([selection], duration)[0];
    const omitted = normalized.map(range => ({ start: Math.max(selected.start, range.start), end: Math.min(selected.end, range.end) })).filter(range => range.end > range.start);
    const from = Math.round(selected.start * 1000), total = Math.round(selected.end * 1000), size = Math.round(partDuration * 1000);
    if (Math.ceil((total - from) / size) > 2000) throw new Error('Too many VOD parts');
    const excluded = omitted.map(range => ({ start: Math.round(range.start * 1000), end: Math.round(range.end * 1000) }));
    const kept: OmittedRange[] = [];
    let cursor = from;
    for (const range of excluded) {
        if (range.start > cursor) kept.push({ start: cursor, end: range.start });
        cursor = range.end;
    }
    if (cursor < total) kept.push({ start: cursor, end: total });
    const skippedNumbers: number[] = [];
    for (let start = from, index = 0; start < total; start += size, index++) {
        if (excluded.some(range => range.start <= start && range.end >= Math.min(total, start + size))) skippedNumbers.push(startPart + index);
    }
    const parts: EditedVodPart[] = [];
    let number = startPart, outputStart = 0;
    for (const range of kept) {
        let position = range.start;
        while (position < range.end) {
            let part = parts.at(-1);
            if (!part || Math.round(part.duration * 1000) === size) {
                while (skippedNumbers.includes(number)) number++;
                part = { number: number++, start: outputStart / 1000, duration: 0, ranges: [] };
                parts.push(part);
            }
            const length = Math.min(range.end - position, size - Math.round(part.duration * 1000));
            part.ranges.push({ start: position / 1000, end: (position + length) / 1000 });
            part.duration = (Math.round(part.duration * 1000) + length) / 1000;
            outputStart += length;
            position += length;
        }
    }
    return { duration: outputStart / 1000, omittedDuration: (total - from - outputStart) / 1000, omitted, skippedNumbers, parts,
        ranges: kept.map(range => ({ start: range.start / 1000, end: range.end / 1000 })) };
}

export function parseOmissionConfig(value: unknown, duration: number): OmissionConfig | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Partial<OmissionConfig>;
    if (raw.version !== 1 || !Number.isInteger(raw.partDurationSec) || raw.partDurationSec! < 60 || raw.partDurationSec! > 86400 || !Array.isArray(raw.ranges)) return null;
    try {
        const ranges = normalizeOmissions(raw.ranges, duration);
        const selection = raw.selection === undefined ? undefined : normalizeOmissions([raw.selection], duration)[0];
        const plan = planEditedVod(duration, raw.partDurationSec!, ranges, 1, selection);
        return plan.parts.length ? { version: 1, partDurationSec: raw.partDurationSec!, ranges, ...(selection ? { selection } : {}) } : null;
    } catch { return null; }
}
