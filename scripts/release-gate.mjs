import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseFingerprint, validateWebkitReceipt, validateUnitReport } from './release-tools.mjs';
import { checks, webkitChecks } from './release-checks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'release/verification');
const execute = promisify(execFile);
const webkitOnly = process.argv.slice(2).join(' ') === '--webkit-only';
if (process.argv.length > 2 && !webkitOnly) throw new Error('Unknown release gate option');
if (webkitOnly && process.platform !== 'darwin') throw new Error('WebKit shard requires macOS media codecs');
async function checkoutIdentity() {
    const git = async args => (await execute('git', args, { cwd: root, windowsHide: true })).stdout.trim();
    if (await git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Cross-platform verification requires an unchanged checkout');
    if (!process.env.GITHUB_RUN_ID || !process.env.GITHUB_RUN_ATTEMPT) throw new Error('Cross-platform verification requires a GitHub Actions run identity');
    return { commit: await git(['rev-parse', 'HEAD']), tree: await git(['rev-parse', 'HEAD^{tree}']),
        runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
}

await mkdir(output, { recursive: true });
await rm(resolve(output, webkitOnly ? 'webkit.json' : 'receipt.json'), { force: true });
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
        const webkitCompletedChecks = name.endsWith('-webkit') && /\bPASS\b|"status":"passed"/.test(String(error.stdout || '')) && !String(error.stderr || '').trim();
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
let units;
if (!webkitOnly) {
    await run('lint', ['node_modules/eslint/bin/eslint.js', '.']);
    await run('unit', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--reporter=json', '--outputFile=' + resolve(output, 'unit.json')]);
    units = JSON.parse(await readFile(resolve(output, 'unit.json'), 'utf8'));
    const unitEvidence = validateUnitReport(units);
    console.log('Passed ' + unitEvidence.passed + ' unit tests; ' + unitEvidence.platformSpecific.length + ' tests belong to the other native platform.');
    await run('electron-native-dependencies', ['node_modules/electron-builder/cli.js', 'install-app-deps']);
}
const failures = [];
let importedWebkit;
if (!webkitOnly && process.env.RELEASE_WEBKIT_RECEIPT) {
    importedWebkit = JSON.parse(await readFile(resolve(process.env.RELEASE_WEBKIT_RECEIPT), 'utf8'));
    validateWebkitReceipt(importedWebkit, await checkoutIdentity());
    results.push(...importedWebkit.checks);
    console.log('Verified ' + importedWebkit.checks.length + ' WebKit checks from macOS for this exact checkout and CI attempt');
}
const selectedChecks = webkitOnly ? webkitChecks : importedWebkit ? checks.filter(([name]) => !name.endsWith('-webkit')) : checks;
for (const [name, args] of selectedChecks) {
    try { await run(name, args); }
    catch (error) {
        console.error(String(error.stdout || '') + String(error.stderr || '') + String(error));
        failures.push(new Error(name + ' failed; see release/verification/' + name + '.log', { cause: error }));
        console.error('Failed ' + name + '; continuing independent checks for complete diagnostics');
    }
}
if (failures.length) throw new AggregateError(failures, 'Release verification failed: ' + failures.length + ' required checks');
if (fingerprint !== await releaseFingerprint(root)) throw new Error('Sources changed during verification');
if (webkitOnly) {
    const identity = await checkoutIdentity();
    const receipt = { version: 1, ...identity, platform: process.platform, success: true,
        completedAt: new Date().toISOString(), checks: results.filter(check => check.name !== 'build') };
    validateWebkitReceipt(receipt, identity);
    await writeFile(resolve(output, 'webkit.json'), JSON.stringify(receipt, null, 2));
    console.log('WebKit verification passed: ' + webkitChecks.length + ' checks on macOS');
} else {
    if (importedWebkit) validateWebkitReceipt(importedWebkit, await checkoutIdentity());
    const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
    await writeFile(resolve(output, 'receipt.json'), JSON.stringify({ version: 1, commit, fingerprint, tests: units.numPassedTests, success: true, completedAt: new Date().toISOString(), checks: results }, null, 2));
    console.log('Release verification passed: ' + units.numPassedTests + ' unit tests and ' + checks.length + ' checks');
}
