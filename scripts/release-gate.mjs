import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseFingerprint } from './release-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'release/verification');
const execute = promisify(execFile);
const checks = [
    ['release-receipt', ['--test', 'scripts/release-tools.test.mjs']],
    ['security', ['scripts/security-check.js']],
    ['release-contract', ['scripts/smoke-test-public-release-config.js']],
    ['ci-contract', ['scripts/smoke-test-ci-contract.js']],
    ['installer-contract', ['--test', 'scripts/smoke-test-installer.test.js']],
    ['installer-process-scope', ['scripts/smoke-test-installer-process-scope.cjs']],
    ['queue-startup', ['scripts/smoke-test-queue-startup.cjs']],
    ['update-version', ['scripts/smoke-test-update-version-logic.js']],
    ...['clips-queue', 'clips-workspace', 'clips-four-fixes', 'clips-empty-reset', 'cutter-v2-regression', 'cutter-compact-verified', 'cutter-zoom-stability', 'cutter-waveform', 'full-queue-audit', 'layout-consistency', 'insights-integrated', 'full-workspace-audit', 'audit-regressions', 'cutter-layout-regressions'].flatMap(name => ['chromium', 'webkit'].map(browser => [name + '-' + browser, ['scripts/smoke-test-' + name + '.js', ...(browser === 'webkit' ? ['--webkit'] : []), ...(name === 'full-workspace-audit' ? ['--expect-refined'] : [])]])),
    ['cutter-layout-native', ['scripts/smoke-test-cutter-v2-native.js']],
    ['cutter-audio-sync', ['scripts/smoke-test-cutter-audio-sync-native.js']],
    ['cutter-audio-many-cuts', ['scripts/smoke-test-cutter-audio-many-cuts.js']],
    ['clips-empty-reset-native', ['scripts/smoke-test-clips-empty-reset-native.js']],
    ['roadmap-projects', ['scripts/smoke-test-roadmap-projects.js']],
    ['roadmap-library', ['scripts/smoke-test-roadmap-library.js']],
    ['roadmap-audio', ['scripts/smoke-test-roadmap-audio.js']],
    ['roadmap-hdr', ['scripts/smoke-test-roadmap-hdr.js']],
    ['roadmap-index', ['scripts/smoke-test-roadmap-index.js']],
    ['roadmap-cleanup', ['scripts/smoke-test-roadmap-cleanup.js']],
    ['roadmap-cleanup-ui', ['scripts/smoke-test-roadmap-cleanup-ui.js']],
    ['roadmap-native', ['scripts/smoke-test-roadmap-native.js']],
    ...['archive', 'clips'].flatMap(name => ['chromium', 'webkit'].map(browser => ['roadmap-' + name + '-' + browser, ['scripts/smoke-test-roadmap-' + name + '.js', ...(browser === 'webkit' ? ['--webkit'] : [])]])),
    ['vod-playback', ['scripts/smoke-test-full-vod-audit.js']],
    ['player-seek-preference', ['scripts/smoke-test-player-seek-preference.cjs']],
    ['vod-loading-lifecycle', ['scripts/smoke-test-vod-loading-lifecycle.cjs']],
    ['vod-opening-source', ['scripts/smoke-test-vod-opening-source.cjs']],
    ['vod-read-timeout', ['scripts/smoke-test-vod-stall-production-timeout.js', 'ffmpeg']],
    ['vod-stall-queue', ['scripts/smoke-test-vod-stall-native.js', 'ffmpeg', 'ffprobe']],
    ['vod-healthy-ranges', ['scripts/smoke-test-vod-stall-healthy.js', 'ffmpeg', 'ffprobe']],
];
await mkdir(output, { recursive: true });
await rm(resolve(output, 'receipt.json'), { force: true });
for (const [, args] of checks) for (const arg of args.filter(value => value.startsWith('scripts/'))) await access(resolve(root, arg));
const results = [];
async function run(name, args, attempt = 1) {
    const started = Date.now();
    console.log('Checking ' + name);
    try {
        const result = await execute(process.execPath, args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 600000 });
        await writeFile(resolve(output, name + '.log'), result.stdout + result.stderr);
        if (/Local check unavailable|No test files found/.test(result.stdout)) throw new Error('Required check was skipped: ' + name);
        results.push({ name, milliseconds: Date.now() - started, success: true });
    } catch (error) {
        await writeFile(resolve(output, name + '.log'), String(error.stdout || '') + String(error.stderr || '') + String(error));
        const webkitProcessFailure = error.code === 1073807364 || /Target (?:page, context or browser has been closed|crashed)/.test(String(error.stderr || ''));
        const webkitCompletedChecks = name.endsWith('-webkit') && /\bPASS\b/.test(String(error.stdout || '')) && !String(error.stderr || '').trim();
        if (name.endsWith('-webkit') && attempt < 3 && (webkitProcessFailure || webkitCompletedChecks)) {
            await writeFile(resolve(output, name + '-attempt-' + attempt + '.log'), String(error.stdout || '') + String(error.stderr || '') + String(error));
            console.warn('Retrying crashed WebKit process: ' + name + ' (attempt ' + (attempt + 1) + ')');
            return run(name, args, attempt + 1);
        }
        throw error;
    }
}
await run('build', ['scripts/build.mjs']);
const fingerprint = await releaseFingerprint(root);
await run('lint', ['node_modules/eslint/bin/eslint.js', '.']);
await run('unit', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--reporter=json', '--outputFile=' + resolve(output, 'unit.json')]);
const units = JSON.parse(await readFile(resolve(output, 'unit.json'), 'utf8'));
if (!units.success || !(units.numTotalTests > 0) || units.numFailedTests > 0 || units.numPendingTests > 0) throw new Error('Unit test suite is incomplete');
for (const [name, args] of checks) await run(name, args);
if (fingerprint !== await releaseFingerprint(root)) throw new Error('Sources changed during verification');
const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
await writeFile(resolve(output, 'receipt.json'), JSON.stringify({ version: 1, commit, fingerprint, tests: units.numTotalTests, success: true, completedAt: new Date().toISOString(), checks: results }, null, 2));
console.log('Release verification passed: ' + units.numTotalTests + ' unit tests and ' + checks.length + ' checks');
