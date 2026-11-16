export interface SegmentSpan { start: number; end: number; firstSegment: number; segmentCount: number }
export interface SegmentWindow { start: number; end: number; offset: number; limit: number; lead: number; tail: number }

export const MAX_SEGMENT_PLAYLIST_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_SECONDS = 120;
const MAX_SEGMENTS = 200000;
const BOUNDARY_TOLERANCE_SECONDS = 0.001;

export function parseSegmentBoundaries(playlist: string): number[] | null {
    if (typeof playlist !== 'string' || !playlist.startsWith('#EXTM3U')) return null;
    const boundaries = [0];
    let position = 0;
    for (const line of playlist.split('\n')) {
        if (!line.startsWith('#EXTINF:')) continue;
        const length = Number.parseFloat(line.slice(8));
        if (!Number.isFinite(length) || length <= 0 || length > MAX_SEGMENT_SECONDS || boundaries.length > MAX_SEGMENTS) return null;
        position += Math.round(length * 1000);
        boundaries.push(position / 1000);
    }
    return boundaries.length > 1 ? boundaries : null;
}

function lastBoundaryAtOrBefore(boundaries: number[], time: number): number {
    let low = 0, high = boundaries.length - 1;
    if (boundaries[high] <= time) return high;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (boundaries[middle] <= time) low = middle;
        else high = middle;
    }
    return low;
}

export function nearestBoundaryIndex(boundaries: number[], time: number): number {
    const low = lastBoundaryAtOrBefore(boundaries, time), high = Math.min(boundaries.length - 1, low + 1);
    return time - boundaries[low] <= boundaries[high] - time ? low : high;
}

export function snapTime(boundaries: number[], time: number): number {
    return boundaries[nearestBoundaryIndex(boundaries, time)];
}

export function segmentSpan(boundaries: number[], start: number, end: number): SegmentSpan | null {
    const first = nearestBoundaryIndex(boundaries, start), last = nearestBoundaryIndex(boundaries, end);
    if (last <= first) return null;
    return { start: boundaries[first], end: boundaries[last], firstSegment: first, segmentCount: last - first };
}

export function segmentWindow(boundaries: number[], start: number, end: number): SegmentWindow | null {
    const final = boundaries.length - 1;
    if (!(end > start) || start < 0 || start >= boundaries[final] - BOUNDARY_TOLERANCE_SECONDS) return null;
    const first = Math.min(final - 1, lastBoundaryAtOrBefore(boundaries, start + BOUNDARY_TOLERANCE_SECONDS));
    const before = lastBoundaryAtOrBefore(boundaries, end - BOUNDARY_TOLERANCE_SECONDS);
    const last = Math.max(first + 1, boundaries[before] >= end - BOUNDARY_TOLERANCE_SECONDS ? before : Math.min(final, before + 1));
    return {
        start: boundaries[first], end: boundaries[last],
        offset: first === 0 ? 0 : (boundaries[first - 1] + boundaries[first]) / 2,
        limit: boundaries[last] - boundaries[first] - (boundaries[last] - boundaries[last - 1]) / 2,
        lead: Math.max(0, start - boundaries[first]),
        tail: Math.max(0, boundaries[last] - end),
    };
}
