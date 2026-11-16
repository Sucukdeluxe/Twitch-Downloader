import { describe, expect, it } from 'vitest';
import { nearestBoundaryIndex, parseSegmentBoundaries, segmentSpan, segmentWindow, snapTime } from './vod-segments';

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
        expect(first).toEqual({ start: 0, end: 31.466, firstSegment: 0, segmentCount: 3 });
    });

    it('requests whole segments by placing the start offset inside the previous segment and the limit inside the last one', () => {
        expect(segmentWindow(boundaries, 0, 20)).toEqual({ start: 0, end: 20, offset: 0, limit: 15, lead: 0, tail: 0 });
        const window = segmentWindow(boundaries, 20, 42.233)!;
        expect(window.offset).toBe(19);
        expect(window.limit).toBeCloseTo(22.233 - 10.767 / 2, 6);
        expect([window.lead, window.tail]).toEqual([0, 0]);
        const tail = segmentWindow(boundaries, 31.466, 42.301)!;
        expect(tail.offset).toBe(31);
        expect(tail.limit).toBeCloseTo(10.835 - 0.034, 6);
        expect(tail.limit).toBeGreaterThan(10.767);
    });

    it('covers a requested range with the segments that contain it and reports what has to be trimmed', () => {
        const window = segmentWindow(boundaries, 23.5, 40)!;
        expect([window.start, window.end]).toEqual([20, 42.233]);
        expect(window.offset).toBe(19);
        expect(window.lead).toBeCloseTo(3.5, 6);
        expect(window.tail).toBeCloseTo(2.233, 6);
        expect(segmentWindow(boundaries, 9.9995, 20.0004)).toMatchObject({ start: 10, end: 20, lead: 0, tail: 0 });
        expect(segmentWindow(boundaries, 41, 500)).toMatchObject({ start: 31.466, end: 42.301, tail: 0 });
        expect(segmentWindow(boundaries, 4, 5)).toMatchObject({ start: 0, end: 10, offset: 0, lead: 4, tail: 5 });
    });

    it('uses whole seconds for the start offset because Streamlink drops the fraction', () => {
        const uneven = [0, 10, 10.4, 10.9, 20, 30, 40.001, 50];
        for (let index = 1; index < uneven.length - 1; index++) {
            const window = segmentWindow(uneven, uneven[index], uneven[index] + 5)!;
            expect(Number.isInteger(window.offset)).toBe(true);
            const reached = uneven.find(boundary => boundary >= window.offset)!;
            expect(reached).toBe(window.start);
            expect(window.start).toBeLessThanOrEqual(uneven[index]);
            expect(window.lead).toBeCloseTo(uneven[index] - window.start, 6);
        }
        expect(segmentWindow(uneven, 10.9, 20)).toMatchObject({ start: 10, offset: 9, end: 20 });
        expect(segmentWindow(uneven, 10.9, 20)!.lead).toBeCloseTo(0.9, 6);
        expect(segmentWindow(uneven, 10.9, 20)!.limit).toBeCloseTo(10 - 9.1 / 2, 6);
        expect(segmentWindow(uneven, 20, 30)).toMatchObject({ start: 20, offset: 19, lead: 0 });
        expect(segmentWindow(uneven, 40.001, 50)).toMatchObject({ start: 40.001, offset: 39, lead: 0 });
    });

    it('rejects ranges outside the media', () => {
        expect(segmentWindow(boundaries, 42.301, 50)).toBeNull();
        expect(segmentWindow(boundaries, 10, 10)).toBeNull();
        expect(segmentWindow(boundaries, -1, 10)).toBeNull();
    });

    it('reports a range that contains no complete segment', () => {
        expect(segmentSpan(boundaries, 1, 4)).toBeNull();
        expect(segmentSpan(boundaries, 22, 24)).toBeNull();
        expect(segmentSpan(boundaries, 30, 20)).toBeNull();
    });
});
