import { test, expect, describe } from 'vitest';
import { parseFfprobeJson, assessIntegrity, verifyIntegrityFromJson } from './integrity-check';

const FIXTURE_GOOD = JSON.stringify({
    streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '600.5' },
        { index: 1, codec_type: 'audio', codec_name: 'aac', duration: '600.5' },
    ],
    format: { duration: '600.5', size: '50000000' },
});

const FIXTURE_NO_VIDEO = JSON.stringify({
    streams: [
        { index: 0, codec_type: 'audio', codec_name: 'aac', duration: '10' },
    ],
    format: { duration: '10', size: '500000' },
});

const FIXTURE_EMPTY = JSON.stringify({
    streams: [],
    format: { duration: '0.04', size: '1234' },
});

describe('parseFfprobeJson', () => {
    test('parses streams + format', () => {
        const r = parseFfprobeJson(FIXTURE_GOOD);
        expect(r.streams).toHaveLength(2);
        expect(r.streams[0].codecType).toBe('video');
        expect(r.streams[0].codecName).toBe('h264');
        expect(r.streams[0].width).toBe(1920);
        expect(r.durationSeconds).toBe(600.5);
        expect(r.sizeBytes).toBe(50000000);
    });

    test('handles missing format gracefully', () => {
        const r = parseFfprobeJson(JSON.stringify({ streams: [] }));
        expect(r.durationSeconds).toBe(0);
        expect(r.sizeBytes).toBe(0);
    });

    test('throws on malformed JSON', () => {
        expect(() => parseFfprobeJson('{not-valid')).toThrow(/parse failed/);
    });

    test('coerces numeric strings to numbers', () => {
        const r = parseFfprobeJson(JSON.stringify({
            streams: [{ codec_type: 'video', duration: '12.34' }],
            format: { duration: '12.34', size: '987654' },
        }));
        expect(r.durationSeconds).toBe(12.34);
        expect(r.streams[0].durationSeconds).toBe(12.34);
        expect(r.sizeBytes).toBe(987654);
    });
});

describe('assessIntegrity', () => {
    test('valid file: ok=true, no reasons', () => {
        const probe = parseFfprobeJson(FIXTURE_GOOD);
        const v = assessIntegrity(probe);
        expect(v.ok).toBe(true);
        expect(v.reasons).toEqual([]);
        expect(v.hasVideo).toBe(true);
        expect(v.hasAudio).toBe(true);
        expect(v.durationSeconds).toBe(600.5);
    });

    test('no-video stream rejected', () => {
        const v = assessIntegrity(parseFfprobeJson(FIXTURE_NO_VIDEO));
        expect(v.ok).toBe(false);
        expect(v.reasons).toContain('no-video-stream');
        expect(v.hasVideo).toBe(false);
    });

    test('zero-duration rejected as too-short', () => {
        const v = assessIntegrity(parseFfprobeJson(FIXTURE_EMPTY));
        expect(v.ok).toBe(false);
        expect(v.reasons.some(r => r.startsWith('duration-too-short'))).toBe(true);
    });

    test('expected-duration mismatch outside tolerance flagged', () => {
        const v = assessIntegrity(parseFfprobeJson(FIXTURE_GOOD), {
            expectedDurationSeconds: 700,
            durationToleranceSeconds: 5,
        });
        expect(v.ok).toBe(false);
        expect(v.reasons.some(r => r.startsWith('duration-mismatch'))).toBe(true);
    });

    test('expected-duration within tolerance accepted', () => {
        const v = assessIntegrity(parseFfprobeJson(FIXTURE_GOOD), {
            expectedDurationSeconds: 598,
            durationToleranceSeconds: 5,
        });
        expect(v.ok).toBe(true);
    });

    test('custom minDurationSeconds threshold', () => {
        const v = assessIntegrity(parseFfprobeJson(FIXTURE_GOOD), {
            minDurationSeconds: 700,
        });
        expect(v.ok).toBe(false);
        expect(v.reasons.some(r => r.startsWith('duration-too-short'))).toBe(true);
    });
});

describe('verifyIntegrityFromJson', () => {
    test('one-shot parse + assess', () => {
        const v = verifyIntegrityFromJson(FIXTURE_GOOD);
        expect(v.ok).toBe(true);
    });

    test('propagates parse errors', () => {
        expect(() => verifyIntegrityFromJson('{broken')).toThrow();
    });
});
