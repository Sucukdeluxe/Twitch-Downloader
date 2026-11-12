import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideDownloadStart, normalizeDownloadPolicy } from './download-policy';

describe('download policy integration contract', () => {
    it('keeps a normalized persisted policy after a config-shaped restart payload', () => {
        const persisted = JSON.parse(JSON.stringify({
            download_policy: {
                throttle: { maxBytesPerSecond: 1_572_864 },
                windows: [{ start: '22:00', end: '06:00' }, { start: '22:00', end: '06:00' }, { start: 'bad', end: '12:00' }]
            }
        }));

        expect(normalizeDownloadPolicy(persisted.download_policy)).toEqual({
            throttle: { maxBytesPerSecond: 1_572_864 },
            windows: [{ start: '22:00', end: '06:00' }]
        });

        const mainSource = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        expect(mainSource).toContain('download_policy: { throttle: null, windows: [] }');
        expect(mainSource).toContain('download_policy: normalizeDownloadPolicy(input.download_policy)');
    });

    it('blocks automatic queue starts outside the local window but allows a manual override', () => {
        const policy = normalizeDownloadPolicy({
            throttle: { maxBytesPerSecond: 1_048_576 },
            windows: [{ start: '22:00', end: '06:00' }]
        });
        const now = new Date(2026, 0, 13, 13, 0);

        expect(decideDownloadStart(policy, now)).toMatchObject({
            allowed: false,
            reason: 'outside-window',
            nextStart: new Date(2026, 0, 13, 22, 0)
        });
        expect(decideDownloadStart(policy, now, true)).toMatchObject({
            allowed: true,
            reason: 'manual-override',
            maxBytesPerSecond: 1_048_576
        });

        const mainSource = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        expect(mainSource).toContain('function scheduleQueueProcessing(manualOverride = false)');
        expect(mainSource).toContain('scheduleQueueProcessing(manualOverride === true)');
        expect(mainSource).toContain('scheduleDownloadPolicyWake(decision.nextStart)');
    });

    it('uses the app-side stdout transform and retains the existing Streamlink argument pipeline', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const start = source.indexOf('function downloadVODPart(');
        const end = source.indexOf('const outputFinished = output.finished', start);
        const section = source.slice(start, end);

        expect(section).toContain('createDownloadThrottleTransform()');
        expect(section).toContain("const args = [...streamlinkCmd.prefixArgs, ...TWITCH_VIDEO_CODEC_ARGS, url, getStreamlinkStreamArg(quality), '--stdout', '--ffmpeg-ffmpeg', ffmpegPath!];");
        expect(section).not.toMatch(/args\.push\([^\n]*(?:bandwidth|rate-limit|max-rate|throttle)/i);
    });

    it('routes queue, precise trim and clip stdout through one app-wide token bucket budget', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');

        expect(source).toContain('const downloadThrottleBudget = createTokenBucketBudget(null);');
        expect(source).toContain('function createDownloadThrottleTransform(): Transform | undefined');
        expect(source.match(/createDownloadThrottleTransform\(\)/g)).toHaveLength(4);
        const preciseTransfer = source.slice(source.indexOf('async function downloadPreciseVodPart('), source.indexOf('async function downloadVODPart('));
        expect(preciseTransfer).toContain('throttle: createDownloadThrottleTransform()');
        expect(preciseTransfer).toContain('pause: () => output.pause()');
        expect(preciseTransfer).toContain('resume: () => output.resume()');
    });
});
