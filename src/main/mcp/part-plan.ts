import { MAX_EDITED_VOD_SECONDS, parseOmissionConfig, planEditedVod, type OmissionConfig } from '../domain/vod-edit-plan';
import { snapTime } from '../domain/vod-segments';
import { sanitizeFilenamePart } from '../infra/format-helpers';

export interface TimeRange { start: number; end: number }
export interface PlannedPart { number: number; name: string; ranges: TimeRange[]; duration: number }
export interface CoverageOverlap extends TimeRange { parts: [number, number] }
export interface CoverageReport { duration: number; coveredSeconds: number; gaps: TimeRange[]; overlaps: CoverageOverlap[]; complete: boolean }
export interface PartPlan { parts: PlannedPart[]; coverage: CoverageReport }
export interface PartDraft { name: string; ranges: TimeRange[] }
export interface MovedCut { requested: number; actual: number }
export interface AlignedParts { drafts: PartDraft[]; duration: number; moved: MovedCut[] }
export interface ChapterLike { start: number; end: number; name: string }
export interface PartFilenameContext { date: Date; part: number; name: string; title: string; channel: string; vodId: string }

export class PartPlanError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PartPlanError';
    }
}

export const MIN_RANGE_SECONDS = 10;
export const COVERAGE_TOLERANCE_SECONDS = 1;
export const MAX_PARTS = 100;
export const MAX_RANGES_PER_PART = 64;
export const MAX_PART_SOURCE_SECONDS = MAX_EDITED_VOD_SECONDS;
export const DEFAULT_PART_FILENAME_TEMPLATE = '{date}_Part{part_padded}_{name}.mp4';
export const PART_FILENAME_PLACEHOLDERS = ['date', 'date_iso', 'part', 'part_padded', 'name', 'title', 'channel', 'vod_id'] as const;

const MAX_PART_NAME_LENGTH = 120;
const MAX_FILENAME_LENGTH = 200;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

function milliseconds(seconds: number): number {
    return Math.round(seconds * 1000);
}

function roundSeconds(seconds: number): number {
    return milliseconds(seconds) / 1000;
}

export function parseTimeValue(value: unknown): number {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) throw new PartPlanError('Time values must be finite seconds of 0 or more.');
        return roundSeconds(value);
    }
    if (typeof value !== 'string') throw new PartPlanError('Time values must be seconds or an HH:MM:SS string.');
    const text = value.trim();
    if (text.length > 32) throw new PartPlanError('Time values must be seconds or an HH:MM:SS string.');
    const plain = decimalNumber(text);
    if (plain !== null) return roundSeconds(plain);
    const clock = text.split(':');
    if (clock.length === 2 || clock.length === 3) {
        const [seconds, minutes, hours = 0] = clock.map(decimalNumber).reverse();
        const [secondsText, minutesText, hoursText = '0'] = [...clock].reverse();
        const valid = seconds !== null && minutes !== null && hours !== null && !minutesText.includes('.') && !hoursText.includes('.')
            && minutesText.length <= 2 && secondsText.split('.')[0].length <= 2 && (secondsText.split('.')[1]?.length ?? 0) <= 3;
        if (!valid) throw new PartPlanError(`Invalid time value "${text}". Use seconds, HH:MM:SS or 1h2m3s.`);
        if (minutes >= 60 || seconds >= 60) throw new PartPlanError(`Invalid time value "${text}". Minutes and seconds must be below 60.`);
        return roundSeconds(hours * 3600 + minutes * 60 + seconds);
    }
    const compact = text.toLowerCase().split(' ').join('');
    const tokens = compact.match(/[0-9.]+[hms]/g) ?? [];
    const order = tokens.map(token => 'hms'.indexOf(token.slice(-1)));
    const amounts = tokens.map(token => decimalNumber(token.slice(0, -1)));
    const validUnits = tokens.length > 0 && tokens.join('') === compact && order.every((unit, index) => index === 0 || unit > order[index - 1])
        && amounts.every((amount, index) => amount !== null && (order[index] === 2 || Number.isInteger(amount)));
    if (!validUnits) throw new PartPlanError(`Invalid time value "${text}". Use seconds, HH:MM:SS or 1h2m3s.`);
    return roundSeconds(amounts.reduce<number>((sum, amount, index) => sum + (amount as number) * [3600, 60, 1][order[index]], 0));
}

function decimalNumber(text: string): number | null {
    if (!/^[0-9.]+$/.test(text) || text.startsWith('.') || text.endsWith('.') || text.split('.').length > 2) return null;
    return Number(text);
}

export function formatTimecode(seconds: number): string {
    const total = Math.max(0, milliseconds(Number.isFinite(seconds) ? seconds : 0));
    const whole = Math.floor(total / 1000), fraction = total % 1000;
    const clock = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60].map(value => String(value).padStart(2, '0')).join(':');
    return fraction ? `${clock}.${String(fraction).padStart(3, '0')}` : clock;
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
    const sorted = ranges.map(range => ({ start: milliseconds(range.start), end: milliseconds(range.end) })).sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: TimeRange[] = [];
    for (const range of sorted) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push({ ...range });
    }
    return merged.map(range => ({ start: range.start / 1000, end: range.end / 1000 }));
}

function rangeSeconds(ranges: TimeRange[]): number {
    return ranges.reduce((sum, range) => sum + milliseconds(range.end) - milliseconds(range.start), 0) / 1000;
}

function normalizePartName(value: unknown, position: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new PartPlanError(`Part ${position} needs a name.`);
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.length > MAX_PART_NAME_LENGTH) throw new PartPlanError(`The name of part ${position} is longer than ${MAX_PART_NAME_LENGTH} characters.`);
    return name;
}

function normalizeRange(value: unknown, duration: number, label: string): TimeRange {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PartPlanError(`${label} must be an object with start and end.`);
    const raw = value as Record<string, unknown>;
    const start = parseTimeValue(raw.start);
    let end = parseTimeValue(raw.end);
    if (end > duration && end <= duration + COVERAGE_TOLERANCE_SECONDS) end = duration;
    if (start >= duration) throw new PartPlanError(`${label} starts at ${formatTimecode(start)}, after the end of the source (${formatTimecode(duration)}).`);
    if (end > duration) throw new PartPlanError(`${label} ends at ${formatTimecode(end)}, after the end of the source (${formatTimecode(duration)}).`);
    if (end <= start) throw new PartPlanError(`${label} must end after it starts.`);
    if (end - start < MIN_RANGE_SECONDS) throw new PartPlanError(`${label} is shorter than ${MIN_RANGE_SECONDS} seconds. Merge it into a neighbouring range.`);
    return { start, end };
}

export function analyzeCoverage(parts: PlannedPart[], duration: number): CoverageReport {
    const entries = parts.flatMap(part => part.ranges.map(range => ({ ...range, part: part.number }))).sort((a, b) => a.start - b.start || a.end - b.end);
    const gaps: TimeRange[] = [];
    const overlaps: CoverageOverlap[] = [];
    let cursor = 0, coveringPart = 0;
    for (const entry of entries) {
        if (entry.start > cursor + COVERAGE_TOLERANCE_SECONDS) gaps.push({ start: cursor, end: entry.start });
        if (coveringPart && Math.min(cursor, entry.end) - entry.start > COVERAGE_TOLERANCE_SECONDS) {
            overlaps.push({ start: entry.start, end: Math.min(cursor, entry.end), parts: [coveringPart, entry.part] });
        }
        if (entry.end > cursor || !coveringPart) {
            cursor = Math.max(cursor, entry.end);
            coveringPart = entry.part;
        }
    }
    if (duration > cursor + COVERAGE_TOLERANCE_SECONDS) gaps.push({ start: cursor, end: duration });
    return {
        duration,
        coveredSeconds: rangeSeconds(mergeRanges(entries)),
        gaps,
        overlaps,
        complete: gaps.length === 0 && overlaps.length === 0,
    };
}

export function planParts(value: unknown, duration: number, startNumber = 1): PartPlan {
    if (!Number.isFinite(duration) || duration <= 0) throw new PartPlanError('The source duration is unknown.');
    if (!Number.isInteger(startNumber) || startNumber < 1 || startNumber > 9999) throw new PartPlanError('The first part number must be between 1 and 9999.');
    if (!Array.isArray(value) || value.length === 0) throw new PartPlanError('At least one part is required.');
    if (value.length > MAX_PARTS) throw new PartPlanError(`No more than ${MAX_PARTS} parts are supported.`);
    const parts = value.map((entry, index): PlannedPart => {
        const position = index + 1;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new PartPlanError(`Part ${position} must be an object with name and ranges.`);
        const raw = entry as Record<string, unknown>;
        const name = normalizePartName(raw.name, position);
        if (!Array.isArray(raw.ranges) || raw.ranges.length === 0) throw new PartPlanError(`Part ${position} ("${name}") needs at least one range.`);
        if (raw.ranges.length > MAX_RANGES_PER_PART) throw new PartPlanError(`Part ${position} ("${name}") has more than ${MAX_RANGES_PER_PART} ranges.`);
        const ranges = mergeRanges(raw.ranges.map((range, rangeIndex) => normalizeRange(range, duration, `Range ${rangeIndex + 1} of part ${position} ("${name}")`)));
        return { number: startNumber + index, name, ranges, duration: rangeSeconds(ranges) };
    });
    return { parts, coverage: analyzeCoverage(parts, duration) };
}

export function describeCoverageProblems(coverage: CoverageReport): string[] {
    return [
        ...coverage.gaps.map(gap => `Not covered: ${formatTimecode(gap.start)}–${formatTimecode(gap.end)} (${formatTimecode(gap.end - gap.start)})`),
        ...coverage.overlaps.map(overlap => `Covered twice by parts ${overlap.parts[0]} and ${overlap.parts[1]}: ${formatTimecode(overlap.start)}–${formatTimecode(overlap.end)}`),
    ];
}

export function alignPartsToSegments(parts: PlannedPart[], boundaries: number[], declaredDuration: number): AlignedParts {
    const total = boundaries[boundaries.length - 1];
    const moved = new Map<number, number>(), cuts = new Map<number, number>();
    let anchor = Number.NEGATIVE_INFINITY, anchorCut = 0;
    for (const time of [...new Set(parts.flatMap(part => part.ranges.flatMap(range => [range.start, range.end])))].sort((a, b) => a - b)) {
        if (time >= declaredDuration - COVERAGE_TOLERANCE_SECONDS) { cuts.set(time, total); continue; }
        if (time - anchor > COVERAGE_TOLERANCE_SECONDS) { anchor = time; anchorCut = snapTime(boundaries, time); }
        cuts.set(time, anchorCut);
    }
    const snap = (time: number): number => {
        const actual = cuts.get(time)!;
        if (Math.abs(actual - time) >= 0.5) moved.set(time, actual);
        return actual;
    };
    const drafts = parts.map(part => ({
        name: part.name,
        ranges: part.ranges.map((range, index) => {
            const start = snap(range.start), end = snap(range.end);
            if (end <= start) {
                throw new PartPlanError(`Range ${index + 1} of part ${part.number} ("${part.name}") (${formatTimecode(range.start)}–${formatTimecode(range.end)}) is shorter than one segment of the VOD at that position. Cuts are possible about every 10 seconds; extend the range or merge it into a neighbouring part.`);
            }
            return { start, end };
        }),
    }));
    return { drafts, duration: total, moved: [...moved].map(([requested, actual]) => ({ requested, actual })).sort((a, b) => a.requested - b.requested) };
}

export function partOmissions(part: PlannedPart, sourceDuration: number, cuts?: 'segments'): OmissionConfig {
    if (sourceDuration > MAX_PART_SOURCE_SECONDS) {
        throw new PartPlanError('Range-based parts support VODs of up to 50 hours. Download the VOD completely and build the parts from the downloaded files.');
    }
    const selection = { start: part.ranges[0].start, end: part.ranges[part.ranges.length - 1].end };
    const omitted = part.ranges.slice(1).map((range, index) => ({ start: part.ranges[index].end, end: range.start }));
    const config = parseOmissionConfig({
        version: 1,
        partDurationSec: Math.min(MAX_PART_SOURCE_SECONDS, Math.max(60, Math.ceil(part.duration))),
        ranges: omitted,
        selection,
        ...(cuts ? { cuts } : {}),
    }, sourceDuration);
    if (!config) throw new PartPlanError(`Part ${part.number} ("${part.name}") cannot be expressed as a download.`);
    const plan = planEditedVod(sourceDuration, config.partDurationSec, config.ranges, 1, config.selection);
    if (plan.parts.length !== 1 || Math.abs(plan.duration - part.duration) > 0.001) {
        throw new PartPlanError(`Part ${part.number} ("${part.name}") does not resolve to a single output file.`);
    }
    return config;
}

function safeFilenameValue(value: string, fallback: string): string {
    return sanitizeFilenamePart(value.normalize('NFC'), fallback).replace(/\s+/g, ' ');
}

export function renderPartFilename(template: string, context: PartFilenameContext): string {
    if (typeof template !== 'string' || !template.trim() || template.length > 300) throw new PartPlanError('The filename template must contain 1 to 300 characters.');
    const pad = (value: number): string => String(value).padStart(2, '0');
    const values: Record<(typeof PART_FILENAME_PLACEHOLDERS)[number], string> = {
        date: `${pad(context.date.getDate())}.${pad(context.date.getMonth() + 1)}.${context.date.getFullYear()}`,
        date_iso: `${context.date.getFullYear()}-${pad(context.date.getMonth() + 1)}-${pad(context.date.getDate())}`,
        part: String(context.part),
        part_padded: pad(context.part),
        name: safeFilenameValue(context.name, 'Part'),
        title: safeFilenameValue(context.title, 'untitled'),
        channel: safeFilenameValue(context.channel, 'unknown'),
        vod_id: safeFilenameValue(context.vodId, 'unknown'),
    };
    const unknown = [...template.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]).filter(key => !(PART_FILENAME_PLACEHOLDERS as readonly string[]).includes(key));
    if (unknown.length) {
        throw new PartPlanError(`Unknown filename placeholder ${unknown.map(key => `{${key}}`).join(', ')}. Available: ${PART_FILENAME_PLACEHOLDERS.map(key => `{${key}}`).join(', ')}.`);
    }
    const rendered = template.trim().replace(/\{([^{}]*)\}/g, (_, key: keyof typeof values) => values[key]);
    let stem = sanitizeFilenamePart(rendered.replace(/\.mp4$/i, ''), 'Part').replace(/[. ]+$/g, '');
    if (Array.from(stem).length > MAX_FILENAME_LENGTH) stem = Array.from(stem).slice(0, MAX_FILENAME_LENGTH).join('').replace(/[. ]+$/g, '');
    if (!stem) stem = 'Part';
    if (RESERVED_WINDOWS_NAME.test(stem)) stem = '_' + stem;
    return stem + '.mp4';
}

export function uniqueFilenames(filenames: string[]): string[] {
    const used = new Set<string>();
    return filenames.map(filename => {
        const stem = filename.replace(/\.mp4$/i, '');
        let candidate = filename, counter = 1;
        while (used.has(candidate.toLowerCase())) candidate = `${stem} (${++counter}).mp4`;
        used.add(candidate.toLowerCase());
        return candidate;
    });
}

function contiguousSegments(chapters: ChapterLike[], duration: number): Array<TimeRange & { name: string }> {
    const valid = chapters
        .filter(chapter => chapter && typeof chapter.name === 'string' && chapter.name.trim() && Number.isFinite(chapter.start) && chapter.start >= 0 && chapter.start < duration)
        .map(chapter => ({ start: roundSeconds(chapter.start), name: chapter.name.trim() }))
        .sort((a, b) => a.start - b.start);
    const segments: Array<TimeRange & { name: string }> = [];
    for (const [index, chapter] of valid.entries()) {
        const start = index === 0 ? 0 : chapter.start;
        const end = index === valid.length - 1 ? duration : valid[index + 1].start;
        if (end > start) segments.push({ start, end, name: chapter.name });
    }
    return segments;
}

function absorbShortSegments(segments: Array<TimeRange & { name: string }>, minimum: number): Array<TimeRange & { name: string }> {
    const result = segments.map(segment => ({ ...segment }));
    let index = 0;
    while (result.length > 1 && index < result.length) {
        const segment = result[index];
        if (segment.end - segment.start >= minimum) { index++; continue; }
        const previous = result[index - 1], next = result[index + 1];
        if (previous) previous.end = segment.end;
        else next.start = segment.start;
        result.splice(index, 1);
        index = Math.max(0, index - 1);
    }
    const joined: Array<TimeRange & { name: string }> = [];
    for (const segment of result) {
        const previous = joined.at(-1);
        if (previous && previous.name.toLowerCase() === segment.name.toLowerCase()) previous.end = segment.end;
        else joined.push({ ...segment });
    }
    return joined;
}

export function suggestPartsFromChapters(chapters: ChapterLike[], duration: number, options: { minSegmentSeconds?: number; groupByCategory?: boolean; fallbackName?: string } = {}): PartDraft[] {
    if (!Number.isFinite(duration) || duration <= 0) throw new PartPlanError('The source duration is unknown.');
    const minimum = Math.max(MIN_RANGE_SECONDS, options.minSegmentSeconds ?? 300);
    const segments = absorbShortSegments(contiguousSegments(chapters, duration), minimum);
    if (!segments.length) return [{ name: options.fallbackName || 'Stream', ranges: [{ start: 0, end: duration }] }];
    if (options.groupByCategory === false) return segments.map(segment => ({ name: segment.name, ranges: [{ start: segment.start, end: segment.end }] }));
    const groups = new Map<string, PartDraft>();
    for (const segment of segments) {
        const key = segment.name.toLowerCase();
        const group = groups.get(key) ?? { name: segment.name, ranges: [] };
        group.ranges.push({ start: segment.start, end: segment.end });
        groups.set(key, group);
    }
    return [...groups.values()];
}

export function splitLongParts(parts: PartDraft[], maxPartSeconds: number): PartDraft[] {
    if (!Number.isFinite(maxPartSeconds) || maxPartSeconds < 60) throw new PartPlanError('The maximum part length must be at least 60 seconds.');
    return parts.flatMap(part => {
        const total = rangeSeconds(part.ranges);
        const count = Math.ceil(total / maxPartSeconds - 1e-9);
        if (count <= 1) return [part];
        const ranges = mergeRanges(part.ranges).map(range => ({ start: milliseconds(range.start), end: milliseconds(range.end) }));
        const totalMs = milliseconds(total), minimum = MIN_RANGE_SECONDS * 1000;
        const offsets: number[] = [];
        ranges.reduce((offset, range) => { offsets.push(offset); return offset + range.end - range.start; }, 0);
        const cuts = new Set<number>();
        for (let index = 1; index < count; index++) {
            let cut = Math.round(index * totalMs / count);
            const containing = ranges.findIndex((range, rangeIndex) => cut >= offsets[rangeIndex] && cut < offsets[rangeIndex] + range.end - range.start);
            const from = offsets[containing], to = from + ranges[containing].end - ranges[containing].start;
            if (cut - from < minimum) cut = from;
            else if (to - cut < minimum) cut = to;
            if (cut > 0 && cut < totalMs) cuts.add(cut);
        }
        const bounds = [0, ...[...cuts].sort((a, b) => a - b), totalMs];
        return bounds.slice(1).map((end, index): PartDraft => {
            const start = bounds[index];
            return {
                name: `${part.name} (${index + 1}/${bounds.length - 1})`,
                ranges: ranges.flatMap((range, rangeIndex) => {
                    const from = Math.max(start, offsets[rangeIndex]), to = Math.min(end, offsets[rangeIndex] + range.end - range.start);
                    return to > from ? [{ start: (range.start + from - offsets[rangeIndex]) / 1000, end: (range.start + to - offsets[rangeIndex]) / 1000 }] : [];
                }),
            };
        });
    });
}
