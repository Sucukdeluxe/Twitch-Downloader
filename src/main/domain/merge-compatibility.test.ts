import { describe, expect, test } from 'vitest';
import { compareMergeMedia } from './merge-compatibility';
const base = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', avg_frame_rate: '30/1', extradata_hash: 'hash-a' }, { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'deu' } }], format: { duration: '30' } };
const pair = (change: (probe: any) => void) => { const second = structuredClone(base); change(second); return compareMergeMedia([base, second], ['first.mp4', 'second.mp4']); };
describe('merge compatibility', () => {
    test('preserves compatible streams and accepts equivalent fps fractions', () => { const report = pair(p => p.streams[0].avg_frame_rate = '60/2'); expect(report.copyAllowed).toBe(true); expect(report.files[0].audioTracks).toBe(1); });
    test('accepts the measured frame-rate drift of parts of one stream and rejects different nominal rates', () => {
        expect(pair(p => p.streams[0].avg_frame_rate = '1230234000/41247818').copyAllowed).toBe(true);
        expect(pair(p => p.streams[0].avg_frame_rate = '30000/1001').copyAllowed).toBe(true);
        for (const rate of ['25/1', '24/1', '60/1', '0/0']) expect(pair(p => p.streams[0].avg_frame_rate = rate).differences).toContain('frame_rate');
        expect(pair(p => p.streams[1].avg_frame_rate = '0/0').copyAllowed).toBe(true);
    });
    test('uses matching base frame rates when dropped frames change the averages', () => {
        const first = structuredClone(base), second = structuredClone(base);
        Object.assign(first.streams[0], { r_frame_rate: '60000/1001', avg_frame_rate: '5771/100' });
        Object.assign(second.streams[0], { r_frame_rate: '60000/1001', avg_frame_rate: '5994/100' });
        const report = compareMergeMedia([first, second], ['first.mp4', 'second.mp4']);
        expect(report.copyAllowed).toBe(true);
        expect(report.files.map(file => file.fps)).toEqual([57.71, 59.94]);
        Object.assign(second.streams[0], { r_frame_rate: '50/1', avg_frame_rate: '5771/100' });
        expect(compareMergeMedia([first, second], ['first.mp4', 'second.mp4']).differences).toContain('frame_rate');
    });
    test.each(['0/0', '0/1', '-30/1', 'NaN', 'Infinity', '30/0', '30/1/2'])('falls back to average FPS for invalid base rate %s', rate => {
        expect(pair(p => Object.assign(p.streams[0], { r_frame_rate: rate, avg_frame_rate: '30/1' })).copyAllowed).toBe(true);
        expect(pair(p => Object.assign(p.streams[0], { r_frame_rate: rate, avg_frame_rate: '25/1' })).differences).toContain('frame_rate');
    });
    test('requires an explicit encoding choice for differing dimensions', () => { const report = pair(p => p.streams[0].width = 1280); expect(report.copyAllowed).toBe(false); expect(report.encodeAllowed).toBe(true); expect(report.differences).toContain('width'); });
    test('does not concatenate different bitstream headers', () => { expect(pair(p => p.streams[0].extradata_hash = 'hash-b').copyAllowed).toBe(false); });
    test('refuses implicit HDR and bitdepth conversion', () => { const report = pair(p => { p.streams[0].pix_fmt = 'yuv420p10le'; p.streams[0].color_transfer = 'smpte2084'; }); expect(report.copyAllowed).toBe(false); expect(report.encodeAllowed).toBe(false); });
    test('refuses to discard extra audio or subtitle tracks', () => { for (const codec_type of ['audio', 'subtitle']) { const report = pair(p => p.streams.push({ codec_type })); expect(report.copyAllowed).toBe(false); expect(report.encodeAllowed).toBe(false); } });
    test('rotation and language mismatch are visible', () => { const report = pair(p => { p.streams[0].tags = { rotate: '90' }; p.streams[1].tags.language = 'eng'; }); expect(report.differences).toContain('rotation'); expect(report.differences).toContain('language'); });
});
