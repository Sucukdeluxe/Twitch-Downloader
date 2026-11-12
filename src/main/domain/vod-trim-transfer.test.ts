import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { buildVodSpoolArgs, planVodTrimEpochs, planVodTrimSpools, transferVodSource, vodSpoolSeekOffset } from './vod-trim-transfer';
import { createTokenBucketBudget, createTokenBucketTransform } from './token-bucket-transform';
import { buildPreciseVodTrimArgs, buildVodConcatArgs, probeVodMedia, readVodPlaylistTimeline } from './vod-precise-trim';
import type { PausableOutput } from './pausable-output';
import type { HlsMediaPlaylist } from './vod-live-snapshot';

const roots: string[] = [];
const root = (): string => { const result = fs.mkdtempSync(path.join(os.tmpdir(), 'vod-transfer-test-')); roots.push(result); return result; };
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate: () => boolean): Promise<void> {
    const end = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > end) throw new Error('Transfer condition timed out'); await delay(10); }
}
const client = "require('node:http').get(process.argv[1],r=>r.pipe(process.stdout)).on('error',()=>process.exit(2))";
async function fixtureServer(bytes: number): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
    const server = http.createServer((_request, response) => response.end(Buffer.alloc(bytes, 73)));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return { server, url: `http://127.0.0.1:${address.port}/source`, close: async () => {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

describe('bounded precise VOD transport', () => {
    it('pauses actual network output without false stall and cancels process/partial file', async () => {
        const fixture = await fixtureServer(4 * 1024 * 1024);
        const file = path.join(root(), 'source.ts');
        const abort = new AbortController();
        let output: PausableOutput | undefined;
        const work = transferVodSource({ command: process.execPath, args: ['-e', client, fixture.url], outputPath: file,
            throttle: createTokenBucketTransform(64 * 1024), signal: abort.signal,
            intervalMs: 20, stallAfterMs: 50, stallTimeoutMs: 150,
            onReady: (_child, stream) => { output = stream; } });
        const outcome = work.then(() => null, error => error as Error);
        try {
            await waitFor(() => fs.existsSync(file) && fs.statSync(file).size > 0);
            output!.pause();
            await delay(80);
            const pausedSize = fs.statSync(file).size;
            await delay(250);
            expect(fs.statSync(file).size).toBe(pausedSize);
            expect(output!.isPaused()).toBe(true);
            output!.resume();
            await waitFor(() => fs.statSync(file).size > pausedSize);
            abort.abort();
            expect((await outcome)?.message).toMatch(/cancelled/);
            expect(fs.existsSync(file)).toBe(false);
        } finally { abort.abort(); await outcome; await fixture.close(); }
    }, 8000);

    it('shares the existing byte budget across concurrent source transfers', async () => {
        const bytes = 160 * 1024, rate = 128 * 1024;
        const fixture = await fixtureServer(bytes), directory = root();
        const budget = createTokenBucketBudget(rate), started = Date.now();
        try {
            const files = [path.join(directory, 'one.ts'), path.join(directory, 'two.ts')];
            expect(await Promise.all(files.map(outputPath => transferVodSource({ command: process.execPath,
                args: ['-e', client, fixture.url], outputPath, throttle: createTokenBucketTransform(rate, undefined, budget) })))).toEqual([bytes, bytes]);
            expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
            for (const file of files) expect(fs.readFileSync(file)).toEqual(Buffer.alloc(bytes, 73));
        } finally { await fixture.close(); }
    }, 8000);

    it('never removes an existing output and cleans a producer launch failure', async () => {
        const directory = root(), existing = path.join(directory, 'existing.ts');
        fs.writeFileSync(existing, 'keep me');
        await expect(transferVodSource({ command: process.execPath, args: [], outputPath: existing })).rejects.toThrow();
        expect(fs.readFileSync(existing, 'utf8')).toBe('keep me');
        const missing = path.join(directory, 'failed.ts');
        await expect(transferVodSource({ command: path.join(directory, 'missing-binary'), args: [], outputPath: missing })).rejects.toThrow();
        expect(fs.existsSync(missing)).toBe(false);
    });

    it('terminates a genuinely stalled source and removes its owned partial file', async () => {
        const server = http.createServer((_request, response) => { response.writeHead(200); response.flushHeaders(); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const file = path.join(root(), 'stalled.ts');
        try {
            const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/stalled`;
            await expect(transferVodSource({ command: process.execPath, args: ['-e', client, url], outputPath: file,
                intervalMs: 10, stallAfterMs: 30, stallTimeoutMs: 100 })).rejects.toThrow(/timeout/);
            expect(fs.existsSync(file)).toBe(false);
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });

    it('unwraps only the MPEG-TS clock around the bounded selected snapshot', () => {
        const wrap = 2 ** 33 / 90000;
        expect(vodSpoolSeekOffset(1.4, 101.4, 101.2, false) + 101.2).toBeCloseTo(1.2, 8);
        expect(vodSpoolSeekOffset(1.4, 101.4, wrap + 101.2, false) + wrap + 101.2).toBeCloseTo(1.2, 8);
        expect(vodSpoolSeekOffset(wrap + 1.4, 101.4, 101.2, false) + 101.2).toBeCloseTo(1.2, 8);
        expect(vodSpoolSeekOffset(1.4, 101.4, wrap + 101.2, true)).toBeCloseTo(-100, 8);
    });

    it('bounds late trims and obtains the presentation origin from one epoch prefix', () => {
        const playlist: HlsMediaPlaylist = { url: 'https://fixture.ttvnw.net/index.m3u8', ended: true, mediaSequence: 10,
            targetDuration: 10, totalSeconds: 1000, segments: Array.from({ length: 100 }, (_, index) => ({
                uri: `https://fixture.ttvnw.net/${index}.ts`, sequence: 10 + index, start: index * 10, duration: 10, discontinuity: index === 50,
            })) };
        const plan = planVodTrimSpools(playlist, 911, 3);
        expect(plan.text).toContain('/90.ts');
        expect(plan.text).toContain('/91.ts');
        expect(plan.text).not.toContain('/89.ts');
        expect(plan.originText).toContain('/50.ts');
        expect(plan.originText).not.toContain('/51.ts');
        expect(plan.timelineStartSeconds).toBe(411);
        expect(plan.durationSeconds).toBe(3);
        expect(planVodTrimEpochs(playlist, 499, 3).map(epoch => epoch.durationSeconds)).toEqual([1, 2]);
    });

    it.each(['ts', 'fmp4', 'av1'])('spools %s HLS without changing the source decoding timeline', async format => {
        const staged = path.resolve(`.cache/macos-tools/stage-${process.arch}/ffmpeg`);
        const ffmpeg = process.env.FFMPEG_PATH ?? (process.platform === 'darwin' && fs.existsSync(path.join(staged, 'ffmpeg')) ? path.join(staged, 'ffmpeg') : 'ffmpeg');
        const ffprobe = process.env.FFPROBE_PATH ?? (path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
        const directory = root(), playlist = path.join(directory, 'source.m3u8'), spool = path.join(directory, 'source.ts');
        const made = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=25:d=3',
            '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=3', '-c:v', format === 'av1' ? 'libaom-av1' : 'libx264', '-g', '25', ...(format === 'av1' ? ['-cpu-used', '8'] : ['-bf', '3']),
            '-c:a', 'aac', '-hls_time', '1', '-hls_list_size', '0', ...(format !== 'ts' ? ['-hls_segment_type', 'fmp4'] : []), '-y', playlist]);
        expect(made.status, made.stderr?.toString() || String(made.error)).toBe(0);
        const container = format === 'ts' ? 'mpegts' : 'fmp4';
        const original = await readVodPlaylistTimeline(ffprobe, playlist, {}, true, container);
        await transferVodSource({ command: ffmpeg, args: buildVodSpoolArgs(playlist, format !== 'ts'), outputPath: spool });
        const copied = await readVodPlaylistTimeline(ffprobe, spool, {}, false, container);
        expect(copied.originSeconds).toBeCloseTo(original.originSeconds, 4);
        expect(copied.formatStartSeconds).toBeCloseTo(original.formatStartSeconds, 4);
        expect(copied.audioShiftSeconds).toBeCloseTo(original.audioShiftSeconds, 4);
    });
    it('preserves selected frames across two timestamp-reset epochs in one final MP4', async () => {
        const staged = path.resolve(`.cache/macos-tools/stage-${process.arch}/ffmpeg`);
        const ffmpeg = process.env.FFMPEG_PATH ?? (process.platform === 'darwin' && fs.existsSync(path.join(staged, 'ffmpeg')) ? path.join(staged, 'ffmpeg') : 'ffmpeg');
        const ffprobe = process.env.FFPROBE_PATH ?? (path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
        const directory = root();
        const run = (args: string[]): Buffer => {
            const result = spawnSync(ffmpeg, args, { maxBuffer: 8 * 1024 * 1024 });
            expect(result.status, result.stderr?.toString()).toBe(0); return result.stdout;
        };
        const segments = [];
        for (let epoch = 0; epoch < 2; epoch++) {
            const playlist = path.join(directory, `epoch-${epoch}.m3u8`);
            run(['-v', 'error', '-f', 'lavfi', '-i', `nullsrc=s=64x48:r=25:d=2,geq=lum=${epoch ? '200-N*2' : '16+N*2'}:cb=128:cr=128`,
                '-f', 'lavfi', '-i', `aevalsrc=0.12*sin(2*PI*(${epoch ? 419 : 317}*t+37*t*t))+0.10*sin(2*PI*(733*t+53*t*t)):s=48000:d=2`, '-c:v', 'libx264', '-crf', '10',
                '-g', '50', '-bf', '3', '-c:a', 'aac', '-hls_time', '2', '-hls_list_size', '0', '-y', playlist]);
            segments.push({ uri: path.join(directory, `epoch-${epoch}0.ts`), duration: 2, start: epoch * 2, sequence: epoch, discontinuity: epoch > 0 });
        }
        const playlist: HlsMediaPlaylist = { url: 'fixture', ended: true, mediaSequence: 0, targetDuration: 2, totalSeconds: 4, segments };
        const plans = planVodTrimEpochs(playlist, 1.2, 1.6), encoded = [], audioReferences: Array<{ filename: string; sourceStart: number; outputStart: number }> = [];
        expect(plans).toHaveLength(2);
        for (const [index, plan] of plans.entries()) {
            const input = path.join(directory, `plan-${index}.m3u8`), spool = path.join(directory, `spool-${index}.ts`), output = path.join(directory, `trim-${index}.mp4`);
            fs.writeFileSync(input, plan.text);
            await transferVodSource({ command: ffmpeg, args: buildVodSpoolArgs(input), outputPath: spool });
            const timeline = await readVodPlaylistTimeline(ffprobe, spool, {}, false, 'mpegts');
            run(buildPreciseVodTrimArgs({ input: spool, output, start: plan.timelineStartSeconds, duration: plan.durationSeconds,
                seekOffset: timeline.seekOffset, audioShiftSeconds: timeline.audioShiftSeconds, seekAfterInput: true }));
            audioReferences.push({ filename: spool, sourceStart: plan.timelineStartSeconds + timeline.seekOffset,
                outputStart: encoded.reduce((sum, item) => sum + item.duration, 0) });
            encoded.push({ filename: output, info: await probeVodMedia(ffprobe, output), duration: plan.durationSeconds });
        }
        const output = path.join(directory, 'final.mp4');
        run(buildVodConcatArgs(encoded, output));
        const raw = run(['-v', 'error', '-i', output, '-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-']);
        const values = Array.from({ length: raw.length / (64 * 48 * 1.5) }, (_, index) => raw[index * 64 * 48 * 1.5]);
        const expected = [...Array.from({ length: 20 }, (_, index) => 16 + (28 + index) * 2), ...Array.from({ length: 18 }, (_, index) => 200 - index * 2)];
        expect(values).toHaveLength(expected.length);
        values.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(2));
        const info = await probeVodMedia(ffprobe, output);
        expect(info.hasAudio).toBe(true);
        expect(info.duration).toBeCloseTo(1.6, 2);
        const audio = (file: string): Buffer => run(['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
        const finalAudio = audio(output);
        for (const reference of audioReferences) {
            const originalAudio = audio(reference.filename);
            // Compare tone phase inside BOTH epochs, after the actual join. A
            // reset-to-zero concat would shift the second epoch's leading gap.
            const sourceSample = Math.round((reference.sourceStart + .2) * 48000);
            const outputSample = Math.round((reference.outputStart + .2) * 48000);
            let best = { score: -1, lag: 0 };
            for (let lag = -96; lag <= 96; lag++) {
                let cross = 0, xx = 0, yy = 0;
                for (let sample = 0; sample < 2048; sample++) {
                    const x = originalAudio.readFloatLE((sourceSample + sample + lag) * 4);
                    const y = finalAudio.readFloatLE((outputSample + sample) * 4);
                    cross += x * y; xx += x * x; yy += y * y;
                }
                const score = cross / Math.sqrt(xx * yy);
                if (score > best.score) best = { score, lag };
            }
            expect(best.score).toBeGreaterThan(.98);
            expect(Math.abs(best.lag)).toBeLessThanOrEqual(48);
        }
    });

});
