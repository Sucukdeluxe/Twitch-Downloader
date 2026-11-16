import { describe, expect, it } from 'vitest';
import { frameInputArgs, segmentFrameLocator } from './frame-grab';

function segments(durations: number[], extra: Record<number, { map?: string; byteRange?: string }> = {}) {
    let start = 0;
    return durations.map((duration, index) => {
        const segment = { uri: `https://vod.example.ttvnw.net/160p30/${index}.ts`, duration, start, ...extra[index] };
        start += duration;
        return segment;
    });
}

describe('segmentFrameLocator', () => {
    it('names the segment that holds a time and the position inside it', () => {
        const locate = segmentFrameLocator(segments([10, 10, 6.5, 10]))!;
        expect(locate(0)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/0.ts', seek: 0 });
        expect(locate(9.999)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/0.ts', seek: 9.75 });
        expect(locate(10)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/1.ts', seek: 0 });
        expect(locate(23.25)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/2.ts', seek: 3.25 });
        expect(locate(26.5)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/3.ts', seek: 0 });
    });

    it('finds positions far behind the point where the timestamps of a long VOD start again', () => {
        const day = Array.from({ length: 17282 }, () => 10);
        const locate = segmentFrameLocator(segments(day))!;
        expect(locate(95400)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/9540.ts', seek: 0 });
        expect(locate(171016.4)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/17101.ts', seek: 6.4 });
    });

    it('keeps a time at or behind the end inside the last segment', () => {
        const locate = segmentFrameLocator(segments([10, 4]))!;
        expect(locate(14)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/1.ts', seek: 3.75 });
        expect(locate(500)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/1.ts', seek: 3.75 });
        expect(locate(-3)).toEqual({ input: 'https://vod.example.ttvnw.net/160p30/0.ts', seek: 0 });
    });

    it('is not offered for playlists whose segments cannot be read on their own', () => {
        expect(segmentFrameLocator([])).toBeNull();
        expect(segmentFrameLocator(segments([10, 10], { 1: { map: 'https://vod.example.ttvnw.net/init.mp4' } }))).toBeNull();
        expect(segmentFrameLocator(segments([10, 10], { 0: { byteRange: '1000@0' } }))).toBeNull();
    });
});

describe('frameInputArgs', () => {
    it('seeks in the whole input when no segment is known', () => {
        expect(frameInputArgs({ input: 'C:/videos/a.mp4', inputArgs: ['-rw_timeout', '1'] }, 83.5)).toEqual(['-rw_timeout', '1', '-ss', '83.500', '-i', 'C:/videos/a.mp4']);
        expect(frameInputArgs({ input: 'https://vod.example.ttvnw.net/index.m3u8', locate: () => null }, 5)).toEqual(['-ss', '5.000', '-i', 'https://vod.example.ttvnw.net/index.m3u8']);
    });

    it('reads the segment from its beginning and seeks behind the input', () => {
        const locate = segmentFrameLocator(segments([10, 10]))!;
        expect(frameInputArgs({ input: 'https://vod.example.ttvnw.net/index.m3u8', inputArgs: ['-rw_timeout', '1'], locate }, 13.2))
            .toEqual(['-rw_timeout', '1', '-i', 'https://vod.example.ttvnw.net/160p30/1.ts', '-ss', '3.200']);
        expect(frameInputArgs({ input: 'https://vod.example.ttvnw.net/index.m3u8', locate }, 10)).toEqual(['-i', 'https://vod.example.ttvnw.net/160p30/1.ts']);
    });
});
