import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { downloadEditedVod, editedVodWorkspace, type EditedVodOptions } from './vod-edit-download';
import { buildPreciseVodTrimArgs } from './vod-precise-trim';
import { planEditedVod } from './vod-edit-plan';

const staged = path.resolve(`.cache/macos-tools/stage-${process.arch}/ffmpeg`);
const ffmpeg = process.env.FFMPEG_PATH ?? (process.platform === 'darwin' && existsSync(path.join(staged, 'ffmpeg')) ? path.join(staged, 'ffmpeg') : 'ffmpeg');
const ffprobe = process.env.FFPROBE_PATH ?? (path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
const run = (command: string, args: string[]): Buffer => {
    const result = spawnSync(command, args, { maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr?.toString() || String(result.error));
    return result.stdout;
};

describe('edited VOD precise parts and recovery', () => {
    let root: string, source: string;
    beforeAll(() => {
        root = mkdtempSync(path.join(os.tmpdir(), 'tvm-edit-test-'));
        source = path.join(root, 'source.mp4');
        run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=64x48:r=25:d=4,geq=lum=16+N*2:cb=128:cr=128',
            '-f', 'lavfi', '-i', 'aevalsrc=0.12*sin(2*PI*(317*t+37*t*t))+0.10*sin(2*PI*(733*t+53*t*t)):s=48000:d=4', '-c:v', 'libx264', '-crf', '0',
            '-g', '100', '-c:a', 'aac', '-y', source]);
    });
    afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
    function options(id: string): EditedVodOptions {
        return { id, url: 'https://www.twitch.tv/videos/1', folder: root, duration: 4, startPart: 1,
            omissions: { version: 1, partDurationSec: 1.1, ranges: [{ start: 0.73, end: 1.11 }, { start: 2.65, end: 3.05 }] },
            namingIdentity: 'test', ffmpegPath: ffmpeg, ffprobePath: ffprobe,
            async download(range, output) { run(ffmpeg, buildPreciseVodTrimArgs({ input: source, output, start: range.start, duration: range.end - range.start })); },
            filename: part => path.join(root, `${id}-${part.number}.mp4`), wait: async () => true,
            checkSpace: () => undefined, progress: () => undefined };
    }
    it('preserves every selected source frame across omissions and non-keyframe part boundaries', async () => {
        const config = options('1731450000000');
        const output = await downloadEditedVod(config);
        const plan = planEditedVod(config.duration, config.omissions.partDurationSec, config.omissions.ranges);
        expect(output).toHaveLength(plan.parts.length);
        output.forEach((filename, index) => {
            const decoded = run(ffmpeg, ['-v', 'error', '-i', filename, '-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1']);
            const actual = Array.from({ length: decoded.length / (64 * 48 * 1.5) }, (_, frame) => decoded[frame * 64 * 48 * 1.5]);
            const expected = plan.parts[index].ranges.flatMap(range => {
                const first = Math.ceil(range.start * 25 - 1e-7), end = Math.ceil(range.end * 25 - 1e-7);
                return Array.from({ length: end - first }, (_, frame) => 16 + (first + frame) * 2);
            });
            expect(actual).toHaveLength(expected.length);
            actual.forEach((value, frame) => expect(Math.abs(value - expected[frame])).toBeLessThanOrEqual(1));
        });
        const decodeAudio = (filename: string): Float32Array => {
            const bytes = run(ffmpeg, ['-v', 'error', '-i', filename, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', 'pipe:1']);
            return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        };
        const originalAudio = decodeAudio(source);
        for (let index = 0; index < output.length; index++) {
            const audio = decodeAudio(output[index]);
            let offset = 0;
            for (const range of plan.parts[index].ranges) {
                const at = Math.min(0.08, (range.end - range.start) / 3);
                const count = Math.min(960, Math.floor((range.end - range.start - at) * 48000 / 2));
                let best = { score: -1, lag: 0 };
                for (let lag = -1200; lag <= 1200; lag++) {
                    let dot = 0, xx = 0, yy = 0;
                    for (let sample = 0; sample < count; sample += 4) {
                        const x = audio[Math.round((offset + at) * 48000) + sample];
                        const y = originalAudio[Math.round((range.start + at) * 48000) + sample + lag];
                        dot += x * y; xx += x * x; yy += y * y;
                    }
                    const score = dot / Math.sqrt(xx * yy);
                    if (score > best.score) best = { score, lag };
                }
                expect(best.score).toBeGreaterThan(0.94);
                expect(Math.abs(best.lag)).toBeLessThanOrEqual(48);
                offset += range.end - range.start;
            }
        }
        let downloads = 0;
        expect(await downloadEditedVod({ ...config, download: async () => { downloads++; } })).toEqual(output);
        expect(downloads).toBe(0);
    });
    it('does not rewrite an already published hard link when resuming assembly', async () => {
        const config = options('1731450000002');
        let paused = false;
        await expect(downloadEditedVod({ ...config, wait: async () => !paused,
            progress: (_percent, phase) => { if (phase === 'publish') paused = true; },
        })).rejects.toThrow('cancelled');
        const published = path.join(root, `${config.id}-1.mp4`);
        const before = statSync(published);
        const content = readFileSync(published);
        await downloadEditedVod(config);
        expect(statSync(published).mtimeMs).toBe(before.mtimeMs);
        expect(readFileSync(published)).toEqual(content);
    });
    it('retains exact source downloads across interruption and invalidates old copy journals', async () => {
        const config = options('1731450000001');
        let cancelled = false, downloads = 0;
        await expect(downloadEditedVod({ ...config,
            wait: async () => !cancelled,
            async download(...args) { await config.download(...args); downloads++; cancelled = true; },
        })).rejects.toThrow('cancelled');
        const workspace = editedVodWorkspace(root, config.id);
        const old = JSON.parse(readFileSync(path.join(workspace, 'journal.json'), 'utf8'));
        expect(Object.keys(old.inputs)).toHaveLength(1);
        await downloadEditedVod({ ...config, async download(...args) { await config.download(...args); downloads++; } });
        const expectedSources = planEditedVod(config.duration, config.omissions.partDurationSec, config.omissions.ranges).parts.flatMap(part => part.ranges).length;
        expect(downloads).toBe(expectedSources);
        old.version = 1;
        writeFileSync(path.join(workspace, 'journal.json'), JSON.stringify(old));
        let regenerated = 0;
        await downloadEditedVod({ ...config,
            filename: part => path.join(root, `regenerated-${part.number}.mp4`),
            async download(...args) { regenerated++; await config.download(...args); },
        });
        expect(regenerated).toBe(expectedSources);
    });
});
