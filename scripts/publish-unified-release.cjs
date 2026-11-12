#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { validateVersion } = require('./create-macos-update-manifest.js');
const CANONICAL_REPO = 'Sucukdeluxe/Twitch-Downloader';
const MAC_REPO = 'Sucukdeluxe/Twitch-Downloader-macos';
const WORKFLOW_PATH = '.github/workflows/windows-release.yml';
const macNames = version => ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `Twitch-VOD-Manager-${version}-mac-${arch}.${ext}`));
const windowsNames = version => [`Twitch-Downloader-Setup-${version}.exe`, `Twitch-Downloader-Setup-${version}.exe.blockmap`, 'latest.yml'];
const equalNames = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
function identity() {
  const commit = head();
  if (process.env.GITHUB_SHA !== commit || !/^\d+$/.test(process.env.GITHUB_RUN_ID || '') || !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT || '')) throw Error('Missing or mismatched Actions identity');
  return { commit, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
}
async function describe(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size <= 0) throw Error(`Invalid asset: ${path.basename(file)}`);
  const sha256 = nodeCrypto.createHash('sha256'); const sha512 = nodeCrypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) { sha256.update(chunk); sha512.update(chunk); }
  return { name: path.basename(file), size: stat.size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}
function validateProvenance(proof, { version, commit }) {
  validateVersion(version);
  if (proof?.schema !== 1 || proof.version !== version || proof.commit !== commit || !/^[a-f0-9]{40}$/.test(commit) || proof.repository !== CANONICAL_REPO || proof.workflow !== WORKFLOW_PATH || proof.event !== 'push' || typeof proof.runId !== 'string' || typeof proof.runAttempt !== 'string' || !/^[1-9]\d*$/.test(proof.runId) || !/^[1-9]\d*$/.test(proof.runAttempt)) throw Error('Unverified release provenance');
  if (!Array.isArray(proof.assets) || !equalNames(proof.assets.map(a => a.name), [...windowsNames(version), ...macNames(version)]) || proof.assets.some(a => !Number.isSafeInteger(a.size) || a.size <= 0 || !/^[a-f0-9]{64}$/.test(a.sha256))) throw Error('Incomplete release provenance assets');
  return proof;
}
function authHeaders(extra = {}) {
  if (!process.env.GH_TOKEN) throw Error('GH_TOKEN is required');
  return { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
}
async function api(route, { method = 'GET', body, allow404 = false } = {}) {
  if (typeof route !== 'string' || !/^\/?repos\/[\w.-]+\/[\w.-]+\//.test(route)) throw Error('Invalid GitHub API route');
  const response = await fetch(`https://api.github.com/${route.replace(/^\//, '')}`, { method, headers: authHeaders({ 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  if (response.status === 404 && allow404) return null;
  if (!response.ok) { const error = Error(`GitHub API ${method} failed (${response.status})`); error.status = response.status; throw error; }
  return response.status === 204 ? null : response.json();
}
async function downloadAsset(asset, destination) {
  if (!/^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases\/assets\/\d+$/.test(asset.url)) throw Error('Untrusted release asset URL');
  const response = await fetch(asset.url, { headers: authHeaders({ Accept: 'application/octet-stream' }), signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw Error(`Asset download failed (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
  if (fs.statSync(destination).size !== asset.size) throw Error('Downloaded asset size mismatch');
}
async function listAssets(repo, id) {
  const assets = [];
  for (let page = 1; ; page++) { const batch = await api(`repos/${repo}/releases/${id}/assets?per_page=100&page=${page}`); assets.push(...batch); if (batch.length < 100) return assets; }
}
async function sameRemoteAsset(asset, local, dir) {
  if (asset.state !== 'uploaded' || asset.size !== local.size) return false;
  const temp = path.join(dir, `.download-${nodeCrypto.randomUUID()}`);
  try { await downloadAsset(asset, temp); return (await describe(temp)).sha256 === local.sha256; }
  finally { fs.rmSync(temp, { force: true }); }
}
function assertReleaseIdentity(release, { tag, commit, body, name }) {
  if (release.tag_name !== tag || release.target_commitish !== commit || release.prerelease || release.body !== body || release.name !== name) throw Error('Existing release identity or notes differ; never overwrite a published version');
}
async function assertTag(repo, tag, commit) {
  let object = (await api(`repos/${repo}/git/ref/tags/${tag}`)).object;
  for (let n = 0; object.type === 'tag' && n < 5; n++) object = (await api(`repos/${repo}/git/tags/${object.sha}`)).object;
  if (object.type !== 'commit' || object.sha !== commit) throw Error('Remote release tag does not match tested commit');
}
function advances(version, previousTag, prefix) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(previousTag.slice(prefix.length));
  if (!previousTag.startsWith(prefix) || !match) throw Error('Unknown latest stable release tag');
  const before = match.slice(1).map(Number); const after = version.split('.').map(Number);
  const differing = after.findIndex((v, i) => v !== before[i]);
  return differing >= 0 && after[differing] > before[differing];
}
async function publishImmutable({ repo, tag, version, commit, name, body, dir, names, previousPrefix }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Only stable releases are supported');
  await assertTag(repo, tag, commit);
  const local = await Promise.all(names.map(n => describe(path.join(dir, n))));
  let release = await api(`repos/${repo}/releases/tags/${tag}`, { allow404: true });
  if (release) assertReleaseIdentity(release, { tag, commit, body, name });
  else release = await api(`repos/${repo}/releases`, { method: 'POST', body: { tag_name: tag, target_commitish: commit, name, body, draft: true, prerelease: false, make_latest: 'false' } });
  let remote = await listAssets(repo, release.id);
  if (remote.some(a => !names.includes(a.name))) throw Error('Unexpected release asset; refusing to remove it');
  if (!release.draft) {
    if (!equalNames(remote.map(a => a.name), names)) throw Error('Published release asset set is immutable');
    for (const asset of local) if (!await sameRemoteAsset(remote.find(a => a.name === asset.name), asset, dir)) throw Error(`Published asset is immutable: ${asset.name}`);
    return release;
  }
  for (const asset of local) {
    const existing = remote.find(a => a.name === asset.name);
    if (existing && await sameRemoteAsset(existing, asset, dir)) continue;
    const current = await api(`repos/${repo}/releases/${release.id}`);
    assertReleaseIdentity(current, { tag, commit, body, name });
    if (!current.draft) throw Error('Release became public during upload');
    if (existing) await api(`repos/${repo}/releases/assets/${existing.id}`, { method: 'DELETE' });
    const uploadUrl = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
    const response = await fetch(uploadUrl, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) }), body: fs.createReadStream(path.join(dir, asset.name)), duplex: 'half', signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw Error(`Asset upload failed (${response.status}): ${asset.name}`);
  }
  remote = await listAssets(repo, release.id);
  if (!equalNames(remote.map(a => a.name), names)) throw Error('Incomplete draft assets');
  for (const asset of local) if (!await sameRemoteAsset(remote.find(a => a.name === asset.name), asset, dir)) throw Error(`Uploaded asset hash mismatch: ${asset.name}`);
  const latest = await api(`repos/${repo}/releases/latest`, { allow404: true });
  if (latest && !advances(version, latest.tag_name, previousPrefix)) throw Error('Stable latest must advance monotonically');
  const current = await api(`repos/${repo}/releases/${release.id}`);
  assertReleaseIdentity(current, { tag, commit, body, name });
  if (!current.draft) throw Error('Release became public before finalization');
  await assertTag(repo, tag, commit);
  return api(`repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, prerelease: false, make_latest: 'true' } });
}
async function recordMac() {
  const version = require('../package.json').version; const arch = process.env.RELEASE_ARCH;
  if (!['arm64', 'x64'].includes(arch)) throw Error('Invalid Mac architecture');
  const assets = await Promise.all(macNames(version).filter(n => n.includes(`-mac-${arch}.`)).map(n => describe(path.join('release', n))));
  fs.writeFileSync(`release/mac-proof-${arch}.json`, JSON.stringify({ schema: 1, version, ...identity(), arch, assets }, null, 2) + '\n');
}
async function verifyCandidate(version, id, dir) {
  const proof = JSON.parse(fs.readFileSync(path.join(dir, 'verification/package.json')));
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'verification/receipt.json')));
  if (proof.version !== version || proof.candidate !== false || receipt.success !== true || (!Number.isSafeInteger(receipt.tests) || receipt.tests <= 0) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || receipt.commit !== id.commit || proof.fingerprint !== receipt.fingerprint || !Array.isArray(receipt.checks) || receipt.checks.length === 0 || receipt.checks.some(c => c.success !== true)) throw Error('Unverified Windows release provenance');
  if (!Array.isArray(proof.files) || !equalNames(proof.files.map(f => f.name), windowsNames(version))) throw Error('Unexpected Windows assets');
  const assets = [];
  for (const file of proof.files) { const actual = await describe(path.join(dir, file.name)); if (actual.size !== file.bytes || actual.sha256 !== file.sha256 || actual.sha512 !== file.sha512) throw Error(`Windows asset integrity mismatch: ${file.name}`); assets.push(actual); }
  for (const arch of ['arm64', 'x64']) {
    const mac = JSON.parse(fs.readFileSync(path.join(dir, `mac-proof-${arch}.json`)));
    if (mac.schema !== 1 || mac.arch !== arch || mac.version !== version || mac.commit !== id.commit || mac.runId !== id.runId || Number(mac.runAttempt) > Number(id.runAttempt) || !/^[1-9]\d*$/.test(mac.runAttempt) || !Array.isArray(mac.assets) || !equalNames(mac.assets.map(a => a.name), macNames(version).filter(n => n.includes(`-mac-${arch}.`)))) throw Error('Unverified Mac release provenance');
    for (const file of mac.assets) { const actual = await describe(path.join(dir, file.name)); if (actual.size !== file.size || actual.sha256 !== file.sha256) throw Error(`Mac transport hash mismatch: ${file.name}`); assets.push(actual); }
  }
  return assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })).sort((a, b) => a.name.localeCompare(b.name));
}
async function main() {
  if (process.argv.includes('--record-mac')) return recordMac();
  if (process.env.GITHUB_REPOSITORY !== CANONICAL_REPO || process.env.GITHUB_EVENT_NAME !== 'push') throw Error('Canonical tag pushes only');
  const version = require('../package.json').version; validateVersion(version);
  if (process.env.GITHUB_REF !== `refs/tags/v${version}`) throw Error('Release tag/package mismatch');
  const id = identity(); const dir = 'release'; const assets = await verifyCandidate(version, id, dir);
  const { dispatchMacRelease } = require('./dispatch-macos-release.cjs');
  // Authenticate the scoped deploy key before exposing any public release.
  await dispatchMacRelease({ version, commit: id.commit, preflight: true });
  let proof = { schema: 1, version, ...id, repository: CANONICAL_REPO, workflow: WORKFLOW_PATH, event: 'push', assets };
  const proofPath = path.join(dir, 'unified-release.json');
  const existing = await api(`repos/${CANONICAL_REPO}/releases/tags/v${version}`, { allow404: true });
  if (existing && !existing.draft) {
    const publishedProof = (await listAssets(CANONICAL_REPO, existing.id)).find(a => a.name === 'unified-release.json');
    if (!publishedProof) throw Error('Published release has no provenance');
    fs.rmSync(proofPath, { force: true }); await downloadAsset(publishedProof, proofPath);
    proof = validateProvenance(JSON.parse(fs.readFileSync(proofPath)), { version, commit: id.commit });
    if (proof.runId !== id.runId || Number(proof.runAttempt) > Number(id.runAttempt) || JSON.stringify(proof.assets) !== JSON.stringify(assets)) throw Error('Published release cannot be rebuilt or overwritten');
  } else fs.writeFileSync(proofPath, JSON.stringify(validateProvenance(proof, { version, commit: id.commit }), null, 2) + '\n');
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8'); const section = changelog.split(`## ${version} - `)[1];
  if (!section) throw Error('Release notes missing');
  const body = section.slice(section.indexOf('\n') + 1).split('\n## ')[0].trim() + '\n';
  if (Buffer.byteLength(body) > 32768) throw Error('Release notes too large');
  await publishImmutable({ repo: CANONICAL_REPO, tag: `v${version}`, version, commit: id.commit, name: `Twitch Downloader ${version}`, body, dir, names: [...assets.map(a => a.name), 'unified-release.json'], previousPrefix: 'v' });
  await dispatchMacRelease({ version, commit: id.commit });
}
module.exports = { CANONICAL_REPO, MAC_REPO, WORKFLOW_PATH, macNames, windowsNames, validateProvenance, api, downloadAsset, publishImmutable, assertReleaseIdentity, assertTag, advances, describe, verifyCandidate };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
