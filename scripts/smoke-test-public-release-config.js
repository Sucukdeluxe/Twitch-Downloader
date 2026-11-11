const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const manifest = require('./public-release-files.json');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].version, pkg.version);
assert.equal(pkg.build.appId, 'io.github.sucukdeluxe.twitch-vod-manager');
assert.equal(pkg.build.productName, 'Twitch VOD Manager');
assert.equal(pkg.build.mac.artifactName, 'Twitch-VOD-Manager-${version}-mac-${arch}.${ext}');
assert.equal(pkg.build.mac.publish.url, 'https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/latest/download/');
assert.equal(pkg.build.mac.minimumSystemVersion, '13.0', 'Electron 44 requires macOS Ventura or later');
assert.equal(pkg.build.beforePack, 'scripts/before-pack-macos.js');
for (const file of ['dist/**/*', 'src/styles-workflows.css', 'src/styles-overlays.css', 'src/workspace-refinements.css', 'src/editing-workflows.css', 'src/workspace-insights.css']) {
  assert(pkg.build.files.includes(file), `Missing packaged renderer asset: ${file}`);
}
for (const resource of ['macos-tools', 'macos-updater', 'mac-update-public-key.pem']) {
  assert(pkg.build.mac.extraResources.some(entry => entry.to === resource), `Missing Mac resource: ${resource}`);
}
const files = new Set(manifest.files);
assert.equal(files.size, manifest.files.length, 'Duplicate public release manifest entries');
for (const file of files) {
  assert(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), `Unsafe release path: ${file}`);
  const stat = fs.lstatSync(path.join(root, file));
  assert(stat.isFile() && !stat.isSymbolicLink(), `Not a regular release file: ${file}`);
}
function checkTree(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) checkTree(file);
    else if (entry.isFile() && !/^macos-updater-(arm64|x64)$/.test(entry.name)) assert(files.has(file), `Missing public source: ${file}`);
  }
}
for (const directory of ['src', 'build', 'scripts', 'native']) checkTree(directory);
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
assert(html.includes(`Version: v${pkg.version}`));
assert(html.includes('renderer-vod-player.js'), 'New React/HLS workspace is not loaded');
console.log(`Release contracts passed: ${pkg.version} renderer, stable Mac identity, tools and signed updater`);
