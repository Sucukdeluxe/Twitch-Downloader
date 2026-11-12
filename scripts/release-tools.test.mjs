// Reconstructed public contracts; these are not the omitted original tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runtimeFiles, releaseFingerprint, verifyReceipt, validateWebkitReceipt, validateUnitReport } from './release-tools.mjs';

import { webkitChecks } from './release-checks.mjs';

const rendererAssets = ['app.js', 'player.js', 'app.css', 'player.css', 'workspace.css'];
const runtime = ['dist/main.js', 'dist/preload.js', 'dist/main/domain/example.js',
    'dist/renderer/index.html', 'dist/renderer/check.webp', ...rendererAssets.map(name => `dist/renderer/${name}`)].sort();

async function put(root, name, value = `fixture:${name}`) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), value);
}

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'twitch-release-contract-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of [...runtime, 'src/main.ts', 'scripts/build.mjs', 'package.json',
        'package-lock.json', 'tsconfig.json', 'build/icon.ico', 'build/installer.nsh',
        'build/close-installed-app.ps1', 'scripts/package-release.mjs', 'scripts/release-gate.mjs',
        'scripts/release-tools.mjs', 'scripts/public-release-files.json']) await put(root, name);
    await put(root, 'dist/renderer/index.html', rendererAssets.map(name =>
        name.endsWith('.js') ? `<script src="./${name}"></script>` : `<link href="./${name}" rel="stylesheet">`).join('\n'));
    return root;
}

async function receipt(root, overrides = {}) {
    const result = { version: 1, commit: 'a'.repeat(40), fingerprint: await releaseFingerprint(root),
        success: true, tests: 27, completedAt: new Date().toISOString(),
        checks: [{ name: 'fixture-check', milliseconds: 1, success: true }], ...overrides };
    await put(root, 'release/verification/receipt.json', JSON.stringify(result));
    return result;
}

test('runtimeFiles includes referenced bundles and runtime modules, excluding stale and development outputs', async t => {
    const root = await fixture(t);
    for (const name of ['dist/main/example.test.js', 'dist/main/example.spec.js', 'dist/main/dev-executable.js',
        'dist/main/index.js', 'dist/types.js', 'dist/main.js.map', 'dist/main.d.ts',
        'dist/renderer/stale.js', 'dist/renderer/stale.css', 'dist/renderer/nested/app.js']) await put(root, name);
    assert.deepEqual(await runtimeFiles(root), runtime);
});

test('runtimeFiles rejects incomplete renderer manifests', async t => {
    const root = await fixture(t);
    await put(root, 'dist/renderer/index.html', '<script src="./app.js"></script>');
    await assert.rejects(runtimeFiles(root), /manifest is incomplete/);
});

test('runtimeFiles rejects absent referenced assets and assets replaced with directories', async t => {
    const root = await fixture(t);
    await rm(join(root, 'dist/renderer/player.js'));
    await assert.rejects(runtimeFiles(root), /ENOENT|Missing renderer asset/);
    await mkdir(join(root, 'dist/renderer/player.js'));
    await assert.rejects(runtimeFiles(root), /Missing renderer asset/);
});

test('runtimeFiles rejects runtime directory symlinks, including unreferenced content', async t => {
    const root = await fixture(t);
    const target = join(root, 'outside-runtime');
    await mkdir(target);
    // Junctions need no Windows symlink privilege and are still symbolic links to Node.
    await symlink(target, join(root, 'dist/unexpected-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(runtimeFiles(root), /Unexpected runtime symlink/);
});

test('release fingerprint is stable and tracks every release-critical input category', async t => {
    const root = await fixture(t);
    const original = await releaseFingerprint(root);
    assert.match(original, /^[a-f0-9]{64}$/);
    assert.equal(await releaseFingerprint(root), original);
    for (const name of ['src/main.ts', 'scripts/build.mjs', 'package.json', 'package-lock.json', 'tsconfig.json',
        'build/icon.ico', 'dist/main.js', 'dist/preload.js', 'dist/renderer/app.css',
        'build/installer.nsh', 'build/close-installed-app.ps1', 'scripts/package-release.mjs',
        'scripts/release-gate.mjs', 'scripts/release-tools.mjs', 'scripts/public-release-files.json']) {
        const before = await readFile(join(root, name));
        await put(root, name, Buffer.concat([before, Buffer.from('\nchanged')]));
        assert.notEqual(await releaseFingerprint(root), original, `${name} must invalidate verification`);
        await put(root, name, before);
        assert.equal(await releaseFingerprint(root), original);
    }
});

test('release fingerprint excludes stale renderer bundles and verification output', async t => {
    const root = await fixture(t);
    const original = await releaseFingerprint(root);
    await put(root, 'dist/renderer/stale.js');
    await put(root, 'release/verification/native-package.log');
    assert.equal(await releaseFingerprint(root), original);
});

test('release fingerprint includes added or changed verification scripts and source unit tests', async t => {
    const root = await fixture(t);
    const original = await releaseFingerprint(root);
    for (const name of ['scripts/new-contract.test.cjs', 'src/main/new-domain.test.ts']) {
        await put(root, name, 'first contents');
        const added = await releaseFingerprint(root);
        assert.notEqual(added, original, `${name} must be covered when added`);
        await put(root, name, 'changed contents');
        assert.notEqual(await releaseFingerprint(root), added, `${name} must be covered when changed`);
        await rm(join(root, name));
        assert.equal(await releaseFingerprint(root), original);
    }
});

test('verifyReceipt rejects missing and malformed receipts', async t => {
    const root = await fixture(t);
    await assert.rejects(verifyReceipt(root), /ENOENT/);
    await put(root, 'release/verification/receipt.json', '{broken');
    await assert.rejects(verifyReceipt(root), SyntaxError);
});

test('verifyReceipt returns a current successful receipt', async t => {
    const root = await fixture(t);
    const expected = await receipt(root);
    assert.deepEqual(await verifyReceipt(root), expected);
});

test('verifyReceipt rejects tampered fingerprints, failed overall status and missing unit counts', async t => {
    const root = await fixture(t);
    for (const change of [{ fingerprint: '0'.repeat(64) }, { success: false }, { tests: 0 }, { tests: -1 }, { tests: null }]) {
        await receipt(root, change);
        await assert.rejects(verifyReceipt(root), /missing or outdated/);
    }
});

test('verifyReceipt rejects missing, failed, duplicated or malformed check records', async t => {
    const root = await fixture(t);
    for (const checks of [undefined, null, [], {},
        [{ name: 'fixture-check', milliseconds: 1, success: false }],
        [{ name: '', milliseconds: 1, success: true }],
        [{ name: 42, milliseconds: 1, success: true }],
        [{ name: '../escape', milliseconds: 1, success: true }],
        [{ name: 'fixture-check', milliseconds: 1, success: true },
            { name: 'fixture-check', milliseconds: 2, success: true }]]) {
        await receipt(root, { checks });
        await assert.rejects(verifyReceipt(root), /missing or outdated|invalid|check/i,
            `Must reject check records: ${JSON.stringify(checks)}`);
    }
});

test('verifyReceipt rejects formerly valid receipts after source, runtime or installer changes', async t => {
    const root = await fixture(t);
    for (const name of ['src/main.ts', 'dist/main.js', 'build/installer.nsh']) {
        await receipt(root);
        await put(root, name, `modified:${name}`);
        await assert.rejects(verifyReceipt(root), /missing or outdated/);
    }
});

function webkitReceipt() {
    return { version: 1, platform: 'darwin', success: true, commit: 'a'.repeat(40), tree: 'b'.repeat(40),
        runId: '12345', runAttempt: '1', checks: webkitChecks.map(([name]) => ({ name, success: true, milliseconds: 1 })) };
}
test('cross-platform receipt requires every WebKit result from the exact checkout and CI attempt', () => {
    const receipt = webkitReceipt();
    const identity = { commit: receipt.commit, tree: receipt.tree, runId: receipt.runId, runAttempt: receipt.runAttempt };
    assert.equal(validateWebkitReceipt(receipt, identity), receipt);
    for (const key of Object.keys(identity)) {
        assert.throws(() => validateWebkitReceipt(receipt, { ...identity, [key]: identity[key] + '0' }), /stale/);
    }
    for (const changes of [{ success: false }, { platform: 'win32' }, { version: 0 }, { checks: [] },
        { checks: receipt.checks.slice(1) }, { checks: [...receipt.checks, receipt.checks[0]] },
        { checks: receipt.checks.map((item, i) => i === 0 ? { ...item, success: false } : item) },
        { checks: receipt.checks.map((item, i) => i === 0 ? { ...item, name: '../wrong' } : item) },
        { checks: receipt.checks.map((item, i) => i === 0 ? { ...item, milliseconds: NaN } : item) }]) {
        assert.throws(() => validateWebkitReceipt({ ...receipt, ...changes }, identity), /incomplete|stale/);
    }
    assert.throws(() => validateWebkitReceipt(null, identity), /incomplete|stale/);
});

test('unit reports permit only explicit tests belonging to another native platform', () => {
    const report = { success: true, numPassedTests: 1, numFailedTests: 0, numTodoTests: 0, numPendingTests: 1,
        testResults: [{ name: '/repo/src/main/infra/mac-updater.test.ts', assertionResults: [{
            title: 'transport', fullName: 'macOS updater authenticated transport and cache transport',
            ancestorTitles: ['macOS updater authenticated transport and cache'], status: 'pending',
        }, { title: 'shared test', fullName: 'shared test', ancestorTitles: [], status: 'passed' }] }] };
    assert.equal(validateUnitReport(report, 'win32').passed, 1);
    assert.throws(() => validateUnitReport(report, 'darwin'), /did not pass/);
    assert.throws(() => validateUnitReport({ ...report, numPendingTests: 0 }, 'win32'), /count mismatch/);
    report.testResults[0].name = '/repo/src/main/domain/vod-precise-trim.test.ts';
    assert.throws(() => validateUnitReport(report, 'win32'), /did not pass/);
    assert.throws(() => validateUnitReport({ ...report, numPassedTests: 0 }, 'win32'), /incomplete/);
    assert.throws(() => validateUnitReport({ ...report, numFailedTests: 1 }, 'win32'), /incomplete/);
});

test('Windows reports retain the five explicitly Mac-only filesystem, process and archive cases', () => {
    const cases = [
        ['infra/mac-updater.test.ts', 'macOS update system compatibility', 'rejects an incompatible authenticated archive before staging (cleanup failure: false)'],
        ['infra/mac-updater.test.ts', 'macOS update system compatibility', 'rejects an incompatible authenticated archive before staging (cleanup failure: true)'],
        ['infra/download-process.test.ts', 'download process cancellation', 'kills an uncooperative descendant with inherited stdio before cleanup'],
        ['infra/download-process.test.ts', 'download process cancellation', 'kills an uncooperative descendant with private stdio before cleanup'],
        ['domain/portable-cutter-project.test.ts', 'portable Mac cutter projects', 'keeps distinct case-sensitive project paths when remembering and removing recents'],
    ];
    for (const [file, suite, title] of cases) {
        const pending = { title, fullName: `${suite} ${title}`, ancestorTitles: [suite], status: 'skipped' };
        const report = { success: true, numPassedTests: 1, numFailedTests: 0, numTodoTests: 0, numPendingTests: 1,
            testResults: [{ name: `/repo/src/main/${file}`, assertionResults: [pending,
                { title: 'shared test', fullName: 'shared test', ancestorTitles: [], status: 'passed' }] }] };
        assert.equal(validateUnitReport(report, 'win32').platformSpecific.length, 1);
        assert.throws(() => validateUnitReport(report, 'darwin'), /did not pass/);
        pending.status = 'failed';
        assert.throws(() => validateUnitReport(report, 'win32'), /did not pass/);
        pending.status = 'skipped'; pending.title = 'new shared regression';
        assert.throws(() => validateUnitReport(report, 'win32'), /did not pass/);
    }
});
