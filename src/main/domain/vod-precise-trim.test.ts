import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildVodSnapshotDownloadArgs } from './vod-live-snapshot';
import { buildPreciseVodTrimArgs, buildVodConcatArgs, probeVodMedia, readVodPlaylistSeekOffset, readVodPlaylistTimeline, vodPlaylistSeekOffset, vodPlaylistTimeline, verifyPreciseVodOutput } from './vod-precise-trim';

function mediaTool(name: 'ffmpeg' | 'ffprobe'): string {
    const value = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
    // The fixture generator changes cwd; resolve configured paths now while
    // preserving bare executable names for normal PATH lookup.
    const configured = value && (/[\\/]/.test(value) || /^[a-z]:/i.test(value)) ? path.resolve(value) : value;
    const staged = path.resolve(`.cache/macos-tools/stage-${process.arch}/ffmpeg/${name}`);
    const candidates = configured ? [configured] : [...(process.platform === 'darwin' && existsSync(staged) ? [staged] : []), name];
    for (const candidate of candidates) {
        if (spawnSync(candidate, ['-version'], { windowsHide: true }).status === 0) return candidate;
    }
    throw new Error(`Required media test tool unavailable: ${name}. Provision it or set ${name.toUpperCase()}_PATH.`);
}
const ffmpeg = mediaTool('ffmpeg');
const ffprobe = mediaTool('ffprobe');
function run(command: string, args: string[], cwd?: string): Buffer {
    const result = spawnSync(command, args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr?.toString() || String(result.error));
    return result.stdout;
}
function lumaFrames(filename: string): number[] {
    const bytes = run(ffmpeg, ['-v', 'error', '-i', filename, '-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1']);
    const result: number[] = [];
    for (let offset = 0; offset < bytes.length; offset += 64 * 48 * 1.5) result.push(bytes[offset]);
    return result;
}

describe('precise VOD command', () => {
    it('encodes accurate seeks directly into MP4 without rate or timestamp shifts', () => {
        const args = buildPreciseVodTrimArgs({ input: 'source', output: 'part.mp4.tvm-part', start: 1.137, duration: 1.436 });
        expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
        expect(args).toContain('-accurate_seek');
        expect(args).toContain('libx264');
        expect(args).toContain('192k');
        expect(args).not.toContain('copy');
        expect(args).not.toContain('-avoid_negative_ts');
        expect(args).not.toContain('-r');
        expect(args.slice(-4)).toEqual(['-f', 'mp4', '-y', 'part.mp4.tvm-part']);
    });
    it('preserves negative HLS offsets while padding the original audio timeline', () => {
        const args = buildPreciseVodTrimArgs({ input: 'source', output: 'part.mp4', start: 0,
            duration: 1, seekOffset: -0.012033, seekAfterInput: true });
        expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'));
        expect(args[args.indexOf('-ss') + 1]).toBe('-0.012033');
        expect(args[args.indexOf('-af') + 1]).toBe('asetpts=PTS-(-0.012033)/TB,aresample=first_pts=0,asetpts=PTS+(-0.012033)/TB');
    });
    it('uses first decoding time, with a bounded audio fallback and wrap normalization', () => {
        const probe = { format: { start_time: '1.412033' }, streams: [
            { index: 0, codec_type: 'video', start_time: '1.433367' },
            { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', start_time: '1.412033' },
        ], packets: [{ stream_index: 0, dts_time: '1.400000', pts_time: '1.433367' }] };
        expect(vodPlaylistSeekOffset(probe)).toBeCloseTo(-0.012033, 6);
        expect(vodPlaylistTimeline(probe)).toEqual({ seekOffset: 1.4 - 1.412033, originSeconds: 1.4, formatStartSeconds: 1.412033 });
        probe.packets[0].dts_time = String(1.4 - 2 ** 33 / 90000);
        expect(vodPlaylistSeekOffset(probe)).toBeCloseTo(-0.012033, 6);
    });
    it('rejects missing decoding timestamps rather than substituting presentation time', () => {
        const probe = { format: { start_time: '1.4' }, streams: [{ index: 0, codec_type: 'video', start_time: '1.48' }],
            packets: [{ stream_index: 0, pts_time: '1.48' }] };
        expect(() => vodPlaylistSeekOffset(probe)).toThrow('decoding timeline unavailable');
        expect(() => vodPlaylistSeekOffset({ ...probe, packets: [{ stream_index: 0, dts_time: 'N/A' }] })).toThrow('decoding timeline unavailable');
    });
    it('rejects nonseekable output which cannot preserve the AAC edit list', () => {
        expect(() => buildPreciseVodTrimArgs({ input: 'source', output: 'pipe:1' })).toThrow('seekable');
    });
});

describe('precise VOD decoded media', () => {
    let folder: string, source: string;
    beforeAll(() => {
        folder = mkdtempSync(path.join(os.tmpdir(), 'tvm-precise-test-'));
        source = path.join(folder, 'source.mp4');
        run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=64x48:r=25:d=4,geq=lum=16+N*2:cb=128:cr=128',
            '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=4', '-c:v', 'libx264', '-crf', '0',
            '-g', '100', '-bf', '3', '-c:a', 'aac', '-y', source]);
    });
    afterAll(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

    it.each([[1.137, 1.436], [0, 0.44], [3.137, 0.863]])('includes only source frames in [%s, +%s)', async (start, duration) => {
        const output = path.join(folder, `trim-${start}.mp4`);
        run(ffmpeg, buildPreciseVodTrimArgs({ input: source, output, start, duration }));
        const first = Math.ceil(start * 25 - 1e-7), end = Math.ceil((start + duration) * 25 - 1e-7);
        const expected = Array.from({ length: end - first }, (_, index) => 16 + (first + index) * 2);
        const actual = lumaFrames(output);
        expect(actual).toHaveLength(expected.length);
        actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(1));
        const info = await verifyPreciseVodOutput(ffprobe, output, duration);
        expect(info.width).toBe(64); expect(info.height).toBe(48); expect(info.frameSeconds).toBe(0.04);
        const metadata = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output]).toString());
        const audio = metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
        expect(Number(audio.start_time)).toBe(0);
        // AAC's final coded packet can pad container duration (notably FFmpeg 9).
        // Decoded marker alignment and selected video frames stay sample/frame strict.
        expect(Math.abs(Number(audio.duration) - duration)).toBeLessThanOrEqual(1024 / 48000 + 0.001);
        if (start === 1.137) {
            const decodeAudio = (filename: string): Float32Array => {
                const bytes = run(ffmpeg, ['-v', 'error', '-i', filename, '-map', '0:a:0', '-f', 'f32le', 'pipe:1']);
                return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            };
            const original = decodeAudio(source), clipped = decodeAudio(output), offset = Math.round(start * 48000);
            const errors = Array.from({ length: 41 }, (_, index) => {
                const lag = index - 20;
                let error = 0;
                for (let sample = 1024; sample < 4096; sample++) error += (clipped[sample] - original[offset + sample + lag]) ** 2;
                return { lag, error };
            });
            errors.sort((a, b) => a.error - b.error);
            expect(Math.abs(errors[0].lag)).toBeLessThanOrEqual(1);
        }
    });

    it.each(['60', '30000/1001', '60000/1001'])('retains source frame sampling at %s fps', async fps => {
        const input = path.join(folder, `source-${fps.replace('/', '-')}.mp4`);
        run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=64x48:r=${fps}:d=3`,
            '-c:v', 'libx264', '-g', '240', '-y', input]);
        const output = input + '.trim.mp4';
        run(ffmpeg, buildPreciseVodTrimArgs({ input, output, start: 0.537, duration: 1.234 }));
        const original = await probeVodMedia(ffprobe, input), clipped = await verifyPreciseVodOutput(ffprobe, output, 1.234);
        expect(clipped.frameSeconds).toBeCloseTo(original.frameSeconds, 5);
        const expectedCount = Math.ceil(1.771 / original.frameSeconds) - Math.ceil(0.537 / original.frameSeconds);
        expect(lumaFrames(output)).toHaveLength(expectedCount);
    });

    it('trims local HLS snapshots on their presentation timeline', async () => {
        const playlist = path.join(folder, 'snapshot.m3u8');
        run(ffmpeg, ['-v', 'error', '-i', source, '-c:v', 'libx264', '-crf', '18', '-g', '25', '-sc_threshold', '0',
            '-bf', '3', '-c:a', 'aac', '-hls_time', '1', '-hls_list_size', '0', '-f', 'hls', '-y', playlist]);
        const output = path.join(folder, 'snapshot-trim.mp4');
        const seekOffset = await readVodPlaylistSeekOffset(ffprobe, playlist, {}, true);
        run(ffmpeg, buildVodSnapshotDownloadArgs(playlist, 1.137, 1.436, output, seekOffset));
        const frames = lumaFrames(output);
        // The player rebases at DTS: the fixture's first picture is at 0.08s.
        expect(seekOffset).toBeCloseTo(-0.058667, 5);
        expect(frames).toEqual(Array.from({ length: 36 }, (_, index) => 70 + index * 2));
        await verifyPreciseVodOutput(ffprobe, output, 1.436);
    });

    it.each(['25', '60000/1001'])('keeps the first HLS frame and fractional boundaries at %s fps', async fps => {
        const input = path.join(folder, `hls-input-${fps.replace('/', '-')}.mp4`);
        const playlist = input + '.m3u8';
        run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `nullsrc=s=64x48:r=${fps}:d=2,geq=lum=16+N:cb=128:cr=128`,
            '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=2', '-c:v', 'libx264', '-crf', '18',
            '-g', '150', '-bf', '3', '-c:a', 'aac', '-y', input]);
        run(ffmpeg, ['-v', 'error', '-i', input, '-c', 'copy', '-hls_time', '1', '-hls_list_size', '0', '-f', 'hls', '-y', playlist]);
        const seekOffset = await readVodPlaylistSeekOffset(ffprobe, playlist, {}, true);
        const rate = fps === '25' ? 25 : 60000 / 1001;
        for (const [start, end] of [[0, 1.013], [0.537, 1.771]]) {
            const output = input + `-${start}.mp4`;
            run(ffmpeg, buildVodSnapshotDownloadArgs(playlist, start, end - start, output, seekOffset));
            // Encoder's two reordered frames remain an initial presentation delay.
            const first = Math.max(0, Math.ceil(start * rate - 2 - 1e-7)), until = Math.ceil(end * rate - 2 - 1e-7);
            const actual = lumaFrames(output);
            if (start === 0) {
                const streams = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output]).toString()).streams;
                expect(Number(streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio').start_time)).toBe(0);
            }
            expect(actual).toHaveLength(until - first);
            actual.forEach((luma, index) => expect(Math.abs(luma - (16 + first + index))).toBeLessThanOrEqual(1));
        }
    });

    it.each([
        ['mpegts', true], ['mpegts', false], ['fmp4', true], ['fmp4', false],
    ] as const)('probes %s HLS with audio=%s and preserves its first frame', async (container, audio) => {
        const input = path.join(folder, `${container}-${audio}.mp4`), playlist = (input + '.m3u8').replaceAll('\\', '/');
        run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=64x48:r=25:d=2,geq=lum=16+N*2:cb=128:cr=128',
            ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=2'] : []),
            '-c:v', 'libx264', '-crf', '18', '-g', '50', '-bf', '3', ...(audio ? ['-c:a', 'aac'] : ['-an']), '-y', input]);
        // HLS references are URL paths. Generate relative references inside the
        // fixture directory; a Windows C:\ path must not become a playlist URI.
        run(ffmpeg, ['-v', 'error', '-i', path.basename(input), '-c', 'copy', '-hls_time', '1', '-hls_list_size', '0',
            '-hls_segment_type', container, '-hls_segment_filename', `${container}-${audio}-%d.${container === 'fmp4' ? 'm4s' : 'ts'}`,
            ...(container === 'fmp4' ? ['-hls_fmp4_init_filename', `${container}-${audio}-init.mp4`] : []), '-y', path.basename(playlist)], folder);
        const playlistText = readFileSync(playlist, 'utf8');
        const references = [...playlistText.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].map(match => match[1])
            .concat(playlistText.split(/\r?\n/).filter(line => line && !line.startsWith('#')));
        expect(references.length).toBeGreaterThan(container === 'fmp4' ? 1 : 0);
        for (const reference of references) {
            expect(reference).toBe(path.basename(reference));
            expect(existsSync(path.join(folder, reference)), `Missing HLS fixture resource: ${reference}`).toBe(true);
        }
        const timeline = await readVodPlaylistTimeline(ffprobe, playlist, {}, true);
        expect(Number.isFinite(timeline.originSeconds)).toBe(true);
        const output = input + '.trim.mp4';
        run(ffmpeg, buildPreciseVodTrimArgs({ input: playlist, output, start: 0, duration: 1.013,
            seekAfterInput: true, seekOffset: timeline.seekOffset }));
        const frames = lumaFrames(output);
        expect(frames).toHaveLength(24);
        frames.forEach((luma, index) => expect(Math.abs(luma - (16 + index * 2))).toBeLessThanOrEqual(1));
    });

    it('preserves a real delayed audio track when joining decoded inputs', async () => {
        const delayed = path.join(folder, 'delayed-audio.mp4');
        run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=25:d=1',
            '-itsoffset', '0.4', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=0.6',
            '-c:v', 'mpeg4', '-c:a', 'aac', '-y', delayed]);
        const info = await probeVodMedia(ffprobe, delayed);
        expect(info.audioStartSeconds).toBeGreaterThan(0.35);
        const output = path.join(folder, 'delayed-join.mp4');
        run(ffmpeg, buildVodConcatArgs([{ filename: delayed, info, duration: 1 }, { filename: delayed, info, duration: 1 }], output));
        const bytes = run(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
        const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const rms = (start: number, end: number): number => {
            let energy = 0;
            for (let i = Math.round(start * 48000); i < Math.round(end * 48000); i++) energy += samples[i] ** 2;
            return Math.sqrt(energy / Math.round((end - start) * 48000));
        };
        for (const offset of [0, 1]) {
            expect(rms(offset + 0.1, offset + 0.3)).toBeLessThan(0.001);
            expect(rms(offset + 0.5, offset + 0.7)).toBeGreaterThan(0.05);
        }
    });

    it('preserves original A/V timing with a sub-packet AAC gap at the start and after seeking', async () => {
        const input = path.join(folder, 'aac-phase.mp4'), playlist = input + '.m3u8';
        run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=60000/1001:d=22',
            '-f', 'lavfi', '-i', 'aevalsrc=0.12*sin(2*PI*(317*t+37*t*t))+0.10*sin(2*PI*(733*t+53*t*t)):s=48000:d=22',
            '-c:v', 'libx264', '-g', '150', '-bf', '3', '-c:a', 'aac', '-y', input]);
        run(ffmpeg, ['-v', 'error', '-i', input, '-c', 'copy', '-hls_time', '2', '-hls_list_size', '0', '-y', playlist]);
        const timeline = await readVodPlaylistTimeline(ffprobe, playlist, {}, true);
        // Two reordered video frames minus AAC's priming packet leave a 12ms
        // gap. Export must retain that gap even if a player smooths it away.
        expect(timeline.formatStartSeconds - timeline.originSeconds).toBeCloseTo(0.012033, 5);
        const audio = (filename: string): Float32Array => {
            const bytes = run(ffmpeg, ['-v', 'error', '-i', filename, '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
            return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        };
        const sourceAudio = audio(input);
        const frameDelay = 2 * 1001 / 60000;
        for (const start of [0, 0.537, 18.537]) {
            const output = input + `.${start}.trim.mp4`;
            run(ffmpeg, buildPreciseVodTrimArgs({ input: playlist, output, start, duration: 1,
                seekOffset: timeline.seekOffset, seekAfterInput: true }));
            const actual = audio(output);
            // Source MP4 audio and video both begin at zero; TS preserves that
            // relation after adding the same presentation delay to both tracks.
            const sourceOffset = Math.round((start - frameDelay) * 48000);
            for (const at of [0.08, 0.5, 0.82]) {
                let best = { error: Infinity, lag: 0 };
                const first = Math.round(at * 48000);
                for (let lag = -1200; lag <= 1200; lag++) {
                    let error = 0;
                    for (let sample = first; sample < first + 2400; sample += 3) error += (actual[sample] - sourceAudio[sourceOffset + sample + lag]) ** 2;
                    if (error < best.error) best = { error, lag };
                }
                expect(Math.abs(best.lag), `raw audio marker at ${start}+${at}`).toBeLessThanOrEqual(2);
            }
            const metadata = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output]).toString());
            expect(Number(metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio').start_time)).toBe(0);
        }
    });

    it('joins independently decoded codecs and synthesizes missing audio', async () => {
        const other = path.join(folder, 'mpeg4.mp4');
        run(ffmpeg, ['-v', 'error', '-i', source, '-an', '-c:v', 'mpeg4', '-t', '0.8', '-y', other]);
        const trimmed = path.join(folder, 'fragment.mp4');
        run(ffmpeg, buildPreciseVodTrimArgs({ input: source, output: trimmed, start: 1.2, duration: 0.8 }));
        const output = path.join(folder, 'joined.mp4');
        const inputs = await Promise.all([other, trimmed].map(async filename => ({ filename, info: await probeVodMedia(ffprobe, filename) })));
        expect(inputs[0].info.signature).not.toBe(inputs[1].info.signature);
        run(ffmpeg, buildVodConcatArgs(inputs, output));
        const frames = lumaFrames(output);
        expect(frames).toHaveLength(40);
        expect(frames[0]).toBeCloseTo(16, 0);
        expect(Math.abs(frames[20] - 76)).toBeLessThanOrEqual(1);
        await verifyPreciseVodOutput(ffprobe, output, 1.6);
    });
});
