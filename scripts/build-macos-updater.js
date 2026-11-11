'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--arch')) {
  throw new Error('Usage: node scripts/build-macos-updater.js [--arch arm64|x64]');
}
const arch = args[1] || process.arch;
if (process.platform !== 'darwin') throw new Error('The macOS updater must be built on macOS with Xcode Command Line Tools.');
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported macOS updater architecture: ${arch}`);
const output = path.join(root, 'build', `macos-updater-${arch}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync('/usr/bin/xcrun', [
  'swiftc', '-O', '-whole-module-optimization', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx12.0`,
  path.join(root, 'native', 'macos-updater.swift'), '-o', output,
], { stdio: 'inherit' });
fs.chmodSync(output, 0o755);
// The surrounding application is signed again by electron-builder. A standalone
// ad-hoc signature also permits direct helper integration tests and local builds.
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
console.log(`Built macOS updater: ${output}`);
