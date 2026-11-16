import { describe, expect, it } from 'vitest';
import { nearestBoundaryIndex, parseSegmentBoundaries, segmentSpan, snapTime } from './vod-segments';

const playlist = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:12', '#EXTINF:10.000,', '0.ts', '#EXTINF:10.000,', '1.ts', '#EXTINF:11.466,', '2.ts', '#EXTINF:10.767,', '3.ts', '#EXTINF:0.068,', '4.ts', '#EXT-X-ENDLIST'].join('\r\n');

describe('parseSegmentBoundaries', () => {
    it('adds up the segment lengths without rounding drift', () => {
        expect(parseSegmentBoundaries(playlist)).toEqual([0, 10, 20, 31.466, 42.233, 42.301]);
        const long = '#EXTM3U\n' + Array.from({ length: 17280 }, (_value, index) => `#EXTINF:10.001,\n${index}.ts`).join('\n');
        expect(parseSegmentBoundaries(long)!.at(-1)).toBe(172817.28);
    });

    it('rejects anything that is not a usable media playlist', () => {
        expect(parseSegmentBoundaries('')).toBeNull();
        expect(parseSegmentBoundaries('<html>')).toBeNull();
        expect(parseSegmentBoundaries('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunked.m3u8')).toBeNull();
        expect(parseSegmentBoundaries('#EXTM3U\n#EXTINF:abc,\n0.ts')).toBeNull();
        expect(parseSegmentBoundaries('#EXTM3U\n#EXTINF:-4,\n0.ts')).toBeNull();
        expect(parseSegmentBoundaries('#EXTM3U\n#EXTINF:900,\n0.ts')).toBeNull();
    });
});

describe('snapping', () => {
    const boundaries = parseSegmentBoundaries(playlist)!;

    it('moves a time to the nearest segment boundary', () => {
        expect([0, 4.9, 5, 5.1, 20, 25.7, 25.8, 42.26, 42.28, 500, -3].map(time => nearestBoundaryIndex(boundaries, time))).toEqual([0, 0, 0, 1, 2, 2, 3, 4, 5, 5, 0]);
        expect(snapTime(boundaries, 27)).toBe(31.466);
        expect(snapTime(boundaries, 31.466)).toBe(31.466);
    });

    it('gives neighbouring ranges the same cut so that every segment belongs to exactly one range', () => {
        const first = segmentSpan(boundaries, 0, 27)!, second = segmentSpan(boundaries, 27, 42)!;
        expect([first.start, first.end, second.start, second.end]).toEqual([0, 31.466, 31.466, 42.233]);
        expect([first.firstSegment, first.segmentCount, second.firstSegment, second.segmentCount]).toEqual([0, 3, 3, 1]);
    });

    it('places the start offset inside the previous segment and the limit inside the last one', () => {
        expect(segmentSpan(boundaries, 0, 20)).toEqual({ start: 0, end: 20, firstSegment: 0, segmentCount: 2, offset: 0, limit: 15 });
        const span = segmentSpan(boundaries, 20, 42.233)!;
        expect(span.offset).toBe(15);
        expect(span.limit).toBeCloseTo(22.233 - 10.767 / 2, 6);
        const tail = segmentSpan(boundaries, 31.466, 42.301)!;
        expect(tail.offset).toBeCloseTo(25.733, 6);
        expect(tail.limit).toBeCloseTo(10.835 - 0.034, 6);
        expect(tail.limit).toBeGreaterThan(10.767);
    });

    it('reports a range that contains no complete segment', () => {
        expect(segmentSpan(boundaries, 1, 4)).toBeNull();
        expect(segmentSpan(boundaries, 22, 24)).toBeNull();
        expect(segmentSpan(boundaries, 30, 20)).toBeNull();
    });
});
