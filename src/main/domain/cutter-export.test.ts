import { describe, expect, test } from 'vitest';
import { calculateCutterExportProgress, createCutterExportPlan, parseCutterHardwareEncoders, probeCutterHardwareEncoders } from './cutter-export';

describe('cutter export segments', () => {
    test('sorts playable segments and preserves the caller input', () => {
        const segments = [
            { start: 30, end: 45 },
            { start: 5, end: 20 },
        ];

        const plan = createCutterExportPlan({
            inputFile: 'D:\\media\\source.mp4',
            outputFile: 'D:\\media\\result.mp4',
            segments,
            hasAudio: true,
        });

        expect(plan.segments).toEqual([
            { start: 5, end: 20 },
            { start: 30, end: 45 },
        ]);
        expect(plan.remainingDuration).toBe(30);
        expect(segments).toEqual([
            { start: 30, end: 45 },
            { start: 5, end: 20 },
        ]);
    });

    test('builds an audio and video concat filter with a separated argument list', () => {
        const plan = createCutterExportPlan({
            inputFile: 'D:\\media folder\\source.mp4',
            outputFile: 'D:\\exports\\result.mp4',
            segments: [
                { start: 5, end: 20 },
                { start: 30.5, end: 45.25 },
            ],
            hasAudio: true,
        });

        expect(plan.filterComplex).toBe('[0:v]trim=start=5:end=20,setpts=PTS-STARTPTS[v0];[0:a]atrim=start=5:end=20,asetpts=PTS-STARTPTS[a0];[0:v]trim=start=30.5:end=45.25,setpts=PTS-STARTPTS[v1];[0:a]atrim=start=30.5:end=45.25,asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]');
        expect(plan.ffmpegArgs).toEqual([
            '-i', 'D:\\media folder\\source.mp4',
            '-filter_complex', plan.filterComplex,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '160k',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-y', 'D:\\exports\\result.mp4',
        ]);
    });

    test('builds a video-only concat filter without audio mappings or codecs', () => {
        const plan = createCutterExportPlan({
            inputFile: 'input.mkv',
            outputFile: 'output.mp4',
            segments: [
                { start: 0, end: 10 },
                { start: 12, end: 18 },
            ],
            hasAudio: false,
        });

        expect(plan.filterComplex).toBe('[0:v]trim=start=0:end=10,setpts=PTS-STARTPTS[v0];[0:v]trim=start=12:end=18,setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0[outv]');
        expect(plan.ffmpegArgs).toEqual([
            '-i', 'input.mkv',
            '-filter_complex', plan.filterComplex,
            '-map', '[outv]',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-an',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-y', 'output.mp4',
        ]);
    });

    test.each([
        { name: 'empty segment list', segments: [] },
        { name: 'negative start', segments: [{ start: -1, end: 2 }] },
        { name: 'zero duration', segments: [{ start: 2, end: 2 }] },
        { name: 'reversed range', segments: [{ start: 3, end: 2 }] },
        { name: 'non-finite start', segments: [{ start: Number.NaN, end: 2 }] },
        { name: 'non-finite end', segments: [{ start: 1, end: Number.POSITIVE_INFINITY }] },
        { name: 'range below export precision', segments: [{ start: 1, end: 1.0000000001 }] },
        { name: 'overlap after sorting', segments: [{ start: 10, end: 20 }, { start: 5, end: 12 }] },
    ])('rejects $name', ({ segments }) => {
        expect(() => createCutterExportPlan({
            inputFile: 'input.mp4',
            outputFile: 'output.mp4',
            segments,
            hasAudio: true,
        })).toThrow();
    });

    test('calculates progress against the remaining segment duration and clamps it', () => {
        const plan = createCutterExportPlan({
            inputFile: 'input.mp4',
            outputFile: 'output.mp4',
            segments: [{ start: 10, end: 20 }, { start: 50, end: 70 }],
            hasAudio: true,
        });

        expect(calculateCutterExportProgress(0, plan)).toBe(0);
        expect(calculateCutterExportProgress(15, plan)).toBe(50);
        expect(calculateCutterExportProgress(45, plan)).toBe(100);
        expect(calculateCutterExportProgress(-5, plan)).toBe(0);
    });

    test('builds a rotated quality MP4 profile for an explicitly selected audio stream', () => {
        const plan = createCutterExportPlan({
            inputFile: 'input.mov',
            outputFile: 'output.mp4',
            segments: [{ start: 0, end: 20 }],
            hasAudio: true,
            profile: 'quality',
            encoder: 'software',
            audioStreamIndex: 1,
            rotation: 90,
        });

        expect(plan.filterComplex).toContain('[0:v]trim=start=0:end=20,setpts=PTS-STARTPTS,transpose=1[v0]');
        expect(plan.filterComplex).toContain('[0:a:1]atrim=start=0:end=20,asetpts=PTS-STARTPTS[a0]');
        expect(plan.ffmpegArgs).toContain('-noautorotate');
        expect(plan.ffmpegArgs).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']));
    });

    test('falls back to a compatible software encoder when the requested hardware encoder is absent', () => {
        const plan = createCutterExportPlan({
            inputFile: 'input.mp4',
            outputFile: 'output.mp4',
            segments: [{ start: 0, end: 20 }],
            hasAudio: true,
            profile: 'fast',
            encoder: 'h264_nvenc',
            availableHardwareEncoders: [],
        });

        expect(plan.selectedEncoder).toBe('libx264');
        expect(plan.hardwareFallback).toBe(true);
        expect(plan.ffmpegArgs).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']));
    });

    test('requires the lossless archive profile to use its compatible MKV container', () => {
        expect(() => createCutterExportPlan({
            inputFile: 'input.mp4',
            outputFile: 'archive.mp4',
            segments: [{ start: 0, end: 20 }],
            hasAudio: true,
            profile: 'archive',
            encoder: 'software',
        })).toThrow('MKV');

        const plan = createCutterExportPlan({
            inputFile: 'input.mp4',
            outputFile: 'archive.mkv',
            segments: [{ start: 0, end: 20 }],
            hasAudio: true,
            profile: 'archive',
            encoder: 'software',
        });

        expect(plan.ffmpegArgs).toEqual(expect.arrayContaining(['-c:v', 'ffv1', '-c:a', 'flac', '-pix_fmt', 'yuv420p']));
        expect(plan.ffmpegArgs).not.toContain('+faststart');
    });

    test('recognizes only offered H.264 hardware encoders from an ffmpeg probe', () => {
        expect(parseCutterHardwareEncoders(' V..... h264_nvenc NVIDIA NVENC H.264 encoder\n V..... h264_qsv H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration)\n V..... hevc_amf AMD AMF HEVC encoder')).toEqual(['h264_nvenc', 'h264_qsv']);
    });

    test('uses Apple VideoToolbox only when its capability probe succeeded', () => {
        const options = {
            inputFile: 'input.mp4', outputFile: 'output.mp4',
            segments: [{ start: 0, end: 2 }], hasAudio: true,
            encoder: 'h264_videotoolbox' as const,
        };
        expect(parseCutterHardwareEncoders(' V..... h264_videotoolbox')).toEqual(['h264_videotoolbox']);
        const hardware = createCutterExportPlan({ ...options, availableHardwareEncoders: ['h264_videotoolbox'] });
        expect(hardware.selectedEncoder).toBe('h264_videotoolbox');
        expect(hardware.ffmpegArgs).toEqual(expect.arrayContaining(['-b:v', '8M', '-allow_sw', '0']));
        expect(hardware.ffmpegArgs).not.toContain('-qp_i');
        const fallback = createCutterExportPlan(options);
        expect(fallback.selectedEncoder).toBe('libx264');
        expect(fallback.hardwareFallback).toBe(true);
    });

    test('offers only hardware encoders that pass a one-frame encode capability test', async () => {
        const probes: Array<{ encoder: string; args: readonly string[] }> = [];

        const verified = await probeCutterHardwareEncoders(['h264_nvenc', 'h264_qsv', 'h264_amf'], async (encoder, args) => {
            probes.push({ encoder, args });
            return encoder !== 'h264_qsv';
        });

        expect(verified).toEqual(['h264_nvenc', 'h264_amf']);
        expect(probes).toHaveLength(3);
        expect(probes[0]).toMatchObject({
            encoder: 'h264_nvenc',
            args: expect.arrayContaining(['-f', 'lavfi', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-']),
        });
    });
});
