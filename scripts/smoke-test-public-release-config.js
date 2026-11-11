// Reconstructed from the public Windows production contract, not recovered private tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const html = read('src/index.html');
const manifest = JSON.parse(read('scripts/public-release-files.json')).files;

assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Public release must have a stable semantic version');
assert.equal(lock.version, pkg.version, 'Lockfile root version');
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile package version');
assert.equal(html.match(/id="versionInfo"[^>]*>\s*Version:\s*v([^<\s]+)/)?.[1], pkg.version, 'Visible HTML version');
assert.equal(pkg.name, 'twitch-downloader');
assert.equal(pkg.main, 'dist/main.js');
assert.equal(pkg.build.productName, 'Twitch Downloader');
assert.equal(pkg.build.appId, 'io.github.sucukdeluxe.twitch-downloader');
assert.equal(pkg.build.nsis.guid, '08429788-303d-53b6-a4f9-894401712c7e', 'Preserve Windows upgrade identity');
assert.equal(pkg.build.nsis.shortcutName, pkg.build.productName);
assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
assert.equal(pkg.build.win.target, 'nsis');
assert.equal(pkg.build.win.artifactName, 'Twitch-Downloader-Setup-${version}.${ext}');
assert.equal(pkg.build.publish.provider, 'generic');
assert.equal(pkg.build.publish.url, 'https://github.com/Sucukdeluxe/Twitch-Downloader/releases/latest/download/');
assert.equal(pkg.build.publish.useMultipleRangeRequest, false);
assert.ok(pkg.build.extraResources.some(entry => entry.from === 'build/icon.ico' && entry.to === 'app-icons/icon-${version}.ico'));
assert.match(read('src/main/domain/app-identity.ts'), /io\.github\.sucukdeluxe\.twitch-downloader/);
assert.match(read('src/main.ts'), /https:\/\/api\.github\.com\/repos\/Sucukdeluxe\/Twitch-Downloader\/releases\/latest/);

assert.ok(Array.isArray(manifest) && manifest.length > 0);
const publicFiles = new Set(manifest);
assert.equal(publicFiles.size, manifest.length, 'Public manifest must not contain duplicates');
for (const file of manifest) {
  assert.equal(typeof file, 'string');
  assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), `Unsafe public path: ${file}`);
  assert.ok(fs.statSync(path.join(root, file)).isFile(), `Missing public source: ${file}`);
}

// Discover verification dependencies rather than maintaining another partial
// list: helper modules and newly reconstructed gate checks must ship together.
function collectVerificationFiles(directory, pattern) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return collectVerificationFiles(file, pattern);
    return pattern.test(entry.name) ? [file] : [];
  });
}
const verificationFiles = [
  ...collectVerificationFiles('scripts', /\.[cm]?js$/),
  ...collectVerificationFiles('src', /\.(?:test|spec)\.[cm]?[jt]sx?$/)
];
const missingVerificationFiles = verificationFiles.filter(file => !publicFiles.has(file)).sort();
assert.deepEqual(missingVerificationFiles, [],
  `Public checkout omits verification dependencies: ${missingVerificationFiles.join(', ')}`);

for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'src/main.ts', 'src/preload.ts',
  'src/index.html', 'src/renderer.ts', 'src/vod-player/workspace.jsx', 'src/vod-downloaded-check.webp',
  'build/icon.ico', 'build/icon.png', 'build/installer.nsh', 'build/close-installed-app.ps1',
  'scripts/build.mjs', 'scripts/build-renderer.mjs', 'scripts/build-player.mjs', 'scripts/build-state.mjs',
  'scripts/release-tools.mjs', 'scripts/release-gate.mjs', 'scripts/package-release.mjs',
  'scripts/release-tools.test.mjs', 'scripts/smoke-test-public-release-config.js', 'scripts/smoke-test-ci-contract.js',
  'scripts/smoke-test-installer.js', 'scripts/smoke-test-installer.test.js', 'scripts/smoke-test-installer-process-scope.cjs',
  'scripts/smoke-test-release-package.js', '.github/workflows/windows-ci.yml', '.github/workflows/windows-release.yml']) {
  assert.ok(manifest.includes(file), `Public checkout cannot reproduce release without ${file}`);
}
for (const file of pkg.build.files.filter(value => !value.startsWith('!') && !value.includes('*'))) {
  assert.ok(manifest.includes(file), `Packaged source asset missing from public manifest: ${file}`);
}
assert.match(pkg.scripts['release:build'], /npm run release:verify\s*&&\s*npm run release:package/);
assert.equal(pkg.scripts['release:verify'], 'node scripts/release-gate.mjs');
assert.equal(pkg.scripts['release:package'], 'node scripts/package-release.mjs');
console.log(`PASS public Windows release contract ${pkg.version}: identities, versions and ${manifest.length} source files`);
