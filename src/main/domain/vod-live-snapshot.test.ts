import { describe, expect, it } from 'vitest';
import { buildVodSnapshotDownloadArgs, buildVodSnapshotPlaylist, parseHlsMediaPlaylist } from './vod-live-snapshot';

describe('precise live snapshot', () => {
    it('seeks relative to the first retained segment, not the original VOD', () => {
        const playlist = parseHlsMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n0.ts\n#EXTINF:4,\n1.ts\n#EXTINF:4,\n2.ts\n', 'https://vod.ttvnw.net/archive/index.m3u8');
        const snapshot = buildVodSnapshotPlaylist(playlist, 9.137, 1.436);
        expect(snapshot.seekSeconds).toBe(5.137);
        expect(snapshot.segmentCount).toBe(2);
        const args = buildVodSnapshotDownloadArgs('/tmp/snapshot.m3u8', snapshot.seekSeconds, snapshot.durationSeconds, '/tmp/output.mp4');
        expect(args[args.indexOf('-ss') + 1]).toBe('5.137000');
        expect(args[args.indexOf('-t') + 1]).toBe('1.436000');
        expect(args[args.indexOf('-protocol_whitelist') + 1]).toContain('file');
        expect(args).toContain('libx264');
        expect(args).not.toContain('mpegts');
    });
    it('retains lossless copy for whole snapshots', () => {
        const args = buildVodSnapshotDownloadArgs('/tmp/snapshot.m3u8', 0, 12);
        expect(args).toContain('copy');
        expect(args).toContain('pipe:1');
    });
});

describe('byte-range playlist snapshots', () => {
    const url = 'https://vod.ttvnw.net/archive/index.m3u8';
    const list = (ranges: string[], names = ranges.map(() => 'media.ts')): string => '#EXTM3U\n#EXT-X-TARGETDURATION:1\n'
        + ranges.map((range, i) => `#EXTINF:1,\n${range ? '#EXT-X-BYTERANGE:' + range + '\n' : ''}${names[i]}\n`).join('') + '#EXT-X-ENDLIST\n';
    it('resolves implicit offsets before earlier segments are removed', () => {
        const parsed = parseHlsMediaPlaylist(list(['100@0', '200', '300', '400']), url);
        expect(parsed.segments.map(segment => segment.byteRange)).toEqual(['100@0', '200@100', '300@300', '400@600']);
        const snapshot = buildVodSnapshotPlaylist(parsed, 3.1, .5);
        expect(snapshot.text).toContain('#EXT-X-BYTERANGE:300@300');
        expect(snapshot.text).toContain('#EXT-X-BYTERANGE:400@600');
        expect(snapshot.text).not.toContain('#EXT-X-BYTERANGE:100@0');
        expect(parseHlsMediaPlaylist(snapshot.text, url).segments.map(segment => segment.byteRange)).toEqual(['300@300', '400@600']);
    });
    it('rejects implicit offsets without an immediately preceding range of the same resource', () => {
        for (const playlist of [list(['100']), list(['', '100']), list(['100@0', '100'], ['first.ts', 'second.ts'])]) {
            expect(() => parseHlsMediaPlaylist(playlist, url)).toThrow('no preceding offset');
        }
    });
    it('rejects malformed, empty and overflowing ranges instead of reading the wrong bytes', () => {
        for (const range of ['0@0', '-1@0', '100@-1', '100@9007199254740991', '9007199254740992@0', 'a@0']) {
            expect(() => parseHlsMediaPlaylist(list([range]), url)).toThrow('byte range');
        }
        expect(() => parseHlsMediaPlaylist('#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:\nmedia.ts', url)).toThrow('byte range');
    });
});
