import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ComposeError, concatListEntry, formatDifferences, planCompose, type ComposeSourceInfo } from './lossless-compose';

function source(name: string, duration: number, overrides: { video?: Record<string, unknown>; audio?: Array<Record<string, unknown>>; size?: number } = {}): ComposeSourceInfo {
    return {
        path: path.resolve('/videos', name),
        duration,
        size: overrides.size ?? duration * 1000000,
        probe: {
            format: { duration: String(duration) },
            streams: [
                { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080, pix_fmt: 'yuv420p', avg_frame_rate: '60/1', extradata_hash: 'SHA256:video', ...overrides.video },
                ...(overrides.audio ?? [{ codec_type: 'audio', codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2, channel_layout: 'stereo', extradata_hash: 'SHA256:audio' }]),
            ],
        },
    };
}

describe('formatDifferences', () => {
    it('accepts parts of the same stream whose measured frame rate differs slightly', () => {
        const first = source('a.mp4', 60, { video: { avg_frame_rate: '5400000/180001' } });
        const second = source('b.mp4', 40, { video: { avg_frame_rate: '3600000/120001' } });
        expect(formatDifferences([first, second])).toEqual([]);
    });

    it('refuses sources whose time bases differ', () => {
        const first = source('a.mp4', 60, { video: { time_base: '1/90000' } });
        expect(formatDifferences([first, source('b.mp4', 60, { video: { time_base: '1/90000' } })])).toEqual([]);
        expect(formatDifferences([first, source('c.mp4', 60, { video: { time_base: '1/600' } })])).toEqual(['video time base']);
    });

    it('names every property that prevents joining without re-encoding', () => {
        const base = source('a.mp4', 60);
        expect(formatDifferences([base, source('b.mp4', 60, { video: { height: 720, width: 1280, extradata_hash: 'SHA256:other' } })])).toEqual(['video width', 'video height', 'video encoder settings']);
        expect(formatDifferences([base, source('c.mp4', 60, { video: { avg_frame_rate: '30/1' } })])).toEqual(['frame rate']);
        expect(formatDifferences([base, source('d.mp4', 60, { video: { codec_name: 'hevc' } })])).toEqual(['video codec']);
        expect(formatDifferences([base, source('e.mp4', 60, { audio: [] })])).toEqual(['number of audio tracks']);
        expect(formatDifferences([base, source('f.mp4', 60, { audio: [{ codec_type: 'audio', codec_name: 'aac', profile: 'LC', sample_rate: '44100', channels: 2, channel_layout: 'stereo', extradata_hash: 'SHA256:audio' }] })])).toEqual(['audio sample rate']);
    });
});

describe('planCompose', () => {
    const a = source('a.mp4', 3600), b = source('b.mp4', 1800);

    it('uses complete files directly and marks time ranges for extraction', () => {
        const plan = planCompose([{ path: a.path }, { path: b.path, start: 600, end: 1200 }, { path: a.path, start: 0, end: 3600.03 }], [a, b]);
        expect(plan.segments).toEqual([
            { path: a.path, start: 0, end: 3600, whole: true },
            { path: b.path, start: 600, end: 1200, whole: false },
            { path: a.path, start: 0, end: 3600, whole: true },
        ]);
        expect(plan.duration).toBe(7800);
        expect(plan.temporaryBytes).toBe(600 * 1000000);
        expect(plan.estimatedBytes).toBe(7800 * 1000000);
    });

    it('rejects ranges outside a source and unknown or mismatching sources', () => {
        expect(() => planCompose([{ path: a.path, start: 0, end: 4000 }], [a])).toThrow(/ends after the end of a\.mp4/);
        expect(() => planCompose([{ path: a.path, start: 100, end: 100.5 }], [a])).toThrow(/shorter than 1 second/);
        expect(() => planCompose([{ path: path.resolve('/videos/x.mp4') }], [a])).toThrow(/unknown source/);
        expect(() => planCompose([], [a])).toThrow(ComposeError);
        expect(() => planCompose([{ path: a.path }, { path: b.path }], [a, source('b.mp4', 1800, { video: { height: 720 } })])).toThrow(/formats differ \(video height\)/);
    });
});

describe('concatListEntry', () => {
    it('writes Windows paths with forward slashes and escaped quotes', () => {
        expect(concatListEntry("C:\\Videos\\It's here\\a.mp4")).toBe("file 'C:/Videos/It'\\''s here/a.mp4'");
    });
});
