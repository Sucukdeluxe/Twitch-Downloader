import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { sourceFingerprint } from './build-state.mjs';
import { webkitChecks } from './release-checks.mjs';

export async function runtimeFiles(root) {
    const html = await readFile(resolve(root, 'dist/renderer/index.html'), 'utf8');
    const assets = new Set([...html.matchAll(/(?:src|href)="\.\/([^"/]+\.(?:js|css))"/g)].map(match => match[1]));
    if (assets.size < 5) throw new Error('Renderer manifest is incomplete');
    const files = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const full = resolve(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Unexpected runtime symlink');
            if (entry.isDirectory()) { await visit(full); continue; }
            const name = relative(root, full).replaceAll('\\', '/');
            if (!/\.(js|css|html|webp)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
            if (name.startsWith('dist/renderer/') && name !== 'dist/renderer/index.html' && !name.endsWith('.webp') && !assets.has(name.slice('dist/renderer/'.length))) continue;
            if (['dist/main/dev-executable.js', 'dist/main/index.js', 'dist/types.js'].includes(name)) continue;
            files.push(name);
        }
    }
    await visit(resolve(root, 'dist'));
    for (const asset of assets) if (!(await stat(resolve(root, 'dist/renderer', asset))).isFile()) throw new Error('Missing renderer asset: ' + asset);
    return files.sort();
}

export async function releaseFingerprint(root) {
    const hash = createHash('sha256');
    hash.update(await sourceFingerprint(root));
    const verificationInputs = [];
    async function visit(directory) {
        for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
            const file = `${directory}/${entry.name}`;
            if (entry.isSymbolicLink()) throw new Error('Unexpected verification symlink');
            if (entry.isDirectory()) await visit(file);
            else if ((directory.startsWith('scripts') && /\.(?:cjs|mjs|js)$/.test(file)) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) verificationInputs.push(file);
        }
    }
    await visit('scripts');
    await visit('src');
    const files = new Set([...await runtimeFiles(root), ...verificationInputs, 'build/installer.nsh', 'build/close-installed-app.ps1', 'scripts/public-release-files.json']);
    for (const file of [...files].sort()) { hash.update(file); hash.update(await readFile(resolve(root, file))); }
    return hash.digest('hex');
}

export async function verifyReceipt(root) {
    const receipt = JSON.parse(await readFile(resolve(root, 'release/verification/receipt.json'), 'utf8'));
    const checks = receipt.checks;
    const complete = Array.isArray(checks) && checks.length > 0
        && checks.every(check => check && typeof check.name === 'string' && check.name.split('-').every(part => /^[a-z0-9]+$/i.test(part)) && check.success === true)
        && new Set(checks.map(check => check.name)).size === checks.length;
    if (receipt.fingerprint !== await releaseFingerprint(root) || receipt.success !== true || !(receipt.tests > 0) || !complete) throw new Error('Release checks are missing or outdated. Run npm run release:verify.');
    return receipt;
}

// Transport is restricted to an artifact from this same GitHub Actions run.
// Require every WebKit case and bind it to an unchanged source tree and attempt.
export function validateWebkitReceipt(receipt, identity) {
    const expected = webkitChecks.map(([name]) => name).sort();
    const actual = receipt?.checks;
    if (receipt?.version !== 1 || receipt.platform !== 'darwin' || receipt.success !== true
        || !/^[a-f0-9]{40}$/.test(receipt.commit || '') || !/^[a-f0-9]{40}$/.test(receipt.tree || '')
        || !/^\d+$/.test(receipt.runId || '') || !/^\d+$/.test(receipt.runAttempt || '')
        || ['commit', 'tree', 'runId', 'runAttempt'].some(key => receipt[key] !== identity[key])
        || !Array.isArray(actual) || actual.length !== expected.length
        || actual.some(check => !check || check.success !== true || !Number.isFinite(check.milliseconds) || check.milliseconds < 0)
        || JSON.stringify(actual.map(check => check.name).sort()) !== JSON.stringify(expected)) {
        throw new Error('Missing, incomplete or stale macOS WebKit verification for this checkout and CI attempt');
    }
    return receipt;
}

// A unified suite contains explicitly platform-specific tests. Only those exact
// suites may be pending on the other OS; a missing media tool is never allowed.
export function validateUnitReport(report, platform = process.platform) {
    if (!report?.success || !(report.numPassedTests > 0) || report.numFailedTests !== 0 || (report.numTodoTests ?? 0) !== 0 || !Array.isArray(report.testResults)) {
        throw new Error('Unit test suite is incomplete');
    }
    const pending = [];
    let passed = 0;
    for (const file of report.testResults) {
        for (const assertion of file.assertionResults || []) {
            if (assertion.status === 'passed') { passed++; continue; }
            const name = String(file.name).replaceAll('\\', '/');
            const title = assertion.title;
            const ancestors = assertion.ancestorTitles || [];
            const macSuite = ['macOS updater authenticated transport and cache', 'macOS update startup health acknowledgement', 'macOS update recovery notification', 'macOS installation cancellation'];
            const allowed = platform === 'win32' && name.endsWith('/src/main/infra/mac-updater.test.ts') && macSuite.some(suite => ancestors.includes(suite))
                || platform === 'win32' && name.endsWith('/src/main/infra/mac-updater.test.ts') && ancestors.includes('macOS update system compatibility')
                    && ['rejects an incompatible authenticated archive before staging (cleanup failure: false)', 'rejects an incompatible authenticated archive before staging (cleanup failure: true)'].includes(title)
                || platform === 'win32' && name.endsWith('/src/main/infra/download-process.test.ts') && ancestors.includes('download process cancellation')
                    && ['kills an uncooperative descendant with inherited stdio before cleanup', 'kills an uncooperative descendant with private stdio before cleanup'].includes(title)
                || platform === 'win32' && name.endsWith('/src/main/domain/portable-cutter-project.test.ts') && ancestors.includes('portable Mac cutter projects')
                    && title === 'keeps distinct case-sensitive project paths when remembering and removing recents'
                || platform !== 'win32' && name.endsWith('/src/main/dev-executable.test.ts') && ancestors.includes('prepareWindowsDevExecutable')
                || name.endsWith('/src/main/infra/executable-identity.test.ts') && (platform !== 'darwin' && title === 'invalidates same-size changes even if mtime is restored'
                    || platform === 'win32' && title === 'refuses lost executable permission');
            if (!allowed || !['pending', 'skipped'].includes(assertion.status)) throw new Error('Required unit test did not pass: ' + name + ': ' + assertion.fullName);
            pending.push(assertion.fullName);
        }
    }
    if (pending.length !== report.numPendingTests || passed !== report.numPassedTests) throw new Error('Unit test count mismatch');
    return { passed: report.numPassedTests, platformSpecific: pending };
}
