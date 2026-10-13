import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runtimeFiles, verifyReceipt, releaseFingerprint } from './release-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { build, Platform } = require('electron-builder');
const { NpmNodeModulesCollector } = require('app-builder-lib/out/node-module-collector/npmNodeModulesCollector');
const execute = promisify(execFile);
const ciCandidate = process.argv.includes('--ci-candidate');
if (ciCandidate && process.env.CI !== 'true') throw new Error('CI candidate packages require CI=true');
const verificationDirectory = resolve(root, 'release/verification');
await mkdir(verificationDirectory, { recursive: true });
await rm(resolve(verificationDirectory, 'package.json'), { force: true });
if (!ciCandidate) for (const file of ['scripts/smoke-test-release-package.js', 'scripts/smoke-test-roadmap-native.js']) await access(resolve(root, file));
const receipt = ciCandidate ? null : await verifyReceipt(root);
const fingerprint = await releaseFingerprint(root);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const runtime = await runtimeFiles(root);
const npm = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
NpmNodeModulesCollector.prototype.getDependenciesTree = async function () {
    const result = await execute(process.execPath, [npm, ...this.getArgs()], { cwd: this.rootDir, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const tree = this.parseDependenciesTree(result.stdout);
    if (!tree.dependencies || !Object.keys(tree.dependencies).length) throw new Error('Production dependencies are missing');
    return tree;
};
const configPath = resolve(verificationDirectory, 'builder.json');
await writeFile(configPath, JSON.stringify({ ...pkg.build, files: [...runtime, ...pkg.build.files.filter(file => file !== 'dist/**/*')] }));
await build({ projectDir: root, targets: Platform.WINDOWS.createTarget('nsis'), publish: 'never', config: configPath });
if (fingerprint !== await releaseFingerprint(root)) throw new Error('Sources changed during packaging');
const { listPackage, extractFile } = await import('@electron/asar');
const archive = resolve(root, 'release/win-unpacked/resources/app.asar');
const entries = listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
const actual = entries.filter(name => name.startsWith('dist/') && /\.(js|css|html|webp)$/.test(name)).sort();
if (JSON.stringify(actual) !== JSON.stringify(runtime)) throw new Error('Package runtime file list differs from the verified build');
for (const name of runtime) if (!extractFile(archive, normalize(name)).equals(await readFile(resolve(root, name)))) throw new Error('Package file mismatch: ' + name);
if (JSON.parse(extractFile(archive, 'package.json')).version !== pkg.version) throw new Error('Package version mismatch');
if (!ciCandidate) {
    const result = await execute(process.execPath, ['scripts/smoke-test-release-package.js'], { cwd: root, windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(resolve(verificationDirectory, 'native-package.log'), result.stdout + result.stderr);
    const roadmap = await execute(process.execPath, ['scripts/smoke-test-roadmap-native.js', '--packaged'], { cwd: root, windowsHide: true, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(resolve(verificationDirectory, 'native-roadmap-package.log'), roadmap.stdout + roadmap.stderr);
    await verifyReceipt(root);
}
const files = [];
for (const name of ['Twitch-VOD-Manager-Setup-' + pkg.version + '.exe', 'Twitch-VOD-Manager-Setup-' + pkg.version + '.exe.blockmap', 'latest.yml']) {
    const bytes = await readFile(resolve(root, 'release', name));
    files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64') });
}
const latest = require('js-yaml').load(await readFile(resolve(root, 'release/latest.yml'), 'utf8'));
if (latest.version !== pkg.version || latest.path !== files[0].name || latest.sha512 !== files[0].sha512 || latest.files[0].size !== files[0].bytes) throw new Error('Updater metadata mismatch');
await mkdir(resolve(root, 'release/verification'), { recursive: true });
await writeFile(resolve(root, 'release/verification/package.json'), JSON.stringify({ fingerprint, version: pkg.version, candidate: ciCandidate, verifiedTests: receipt?.tests ?? 0, runtimeFiles: runtime.length, files }, null, 2));
console.log('Package verified: ' + runtime.length + ' runtime files');
