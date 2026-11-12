#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateVersion } = require('./create-macos-update-manifest.js');
const {
  CANONICAL_REPO, MAC_REPO, WORKFLOW_PATH, macNames,
  validateProvenance, api, downloadAsset, publishImmutable,
} = require('./publish-unified-release.cjs');

const ROOT = path.resolve(__dirname, '..');
const MAX_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 15000;

// A successful later attempt may finish dispatch after the immutable artifacts were published.
// The run ID, source commit and approved workflow remain pinned to their producer.
function validateRun(run, proof) {
  if (!run || String(run.id) !== String(proof.runId)
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < Number(proof.runAttempt)
      || run.repository?.full_name !== CANONICAL_REPO
      || run.head_repository?.full_name !== CANONICAL_REPO
      || run.path !== WORKFLOW_PATH || run.event !== 'push'
      || run.head_sha !== proof.commit || !Number.isSafeInteger(run.workflow_id)) {
    throw new Error('Canonical Actions provenance does not match the approved workflow, commit and producing attempt.');
  }
  if (run.status === 'completed') {
    if (run.conclusion !== 'success') throw new Error('Canonical Actions run did not complete successfully.');
    return true;
  }
  if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)) {
    throw new Error('Canonical Actions run has an unexpected status.');
  }
  return false;
}

async function resolveTag(repo, tag, request = api) {
  let object = (await request(`repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let depth = 0; depth < 8 && object?.type === 'tag'; depth += 1) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Invalid annotated tag object.');
    object = (await request(`repos/${repo}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) {
    throw new Error('Release tag must resolve to a commit.');
  }
  return object.sha;
}

function validateCanonicalRelease(release, version, commit) {
  if (!release || release.tag_name !== `v${version}` || release.draft !== false
      || release.prerelease !== false || release.target_commitish !== commit
      || typeof release.body !== 'string' || Buffer.byteLength(release.body, 'utf8') > 32768
      || !Number.isFinite(Date.parse(release.published_at)) || !Array.isArray(release.assets)) {
    throw new Error('Canonical release must be public, stable and pinned to the tested commit.');
  }
  return release;
}

function validateReleaseAssets(assets, proof) {
  const expected = [...proof.assets.map(asset => asset.name), 'unified-release.json'].sort();
  if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(expected)) {
    throw new Error('Canonical release asset set is incomplete or unexpected.');
  }
  for (const descriptor of proof.assets) {
    const asset = assets.find(item => item.name === descriptor.name);
    if (asset.state !== 'uploaded' || asset.size !== descriptor.size) {
      throw new Error(`Canonical release asset metadata mismatch: ${descriptor.name}`);
    }
  }
}

async function verifyDownloadedAsset(filename, descriptor) {
  const stat = await fs.promises.lstat(filename);
  if (!stat.isFile() || stat.size !== descriptor.size) {
    throw new Error(`Downloaded asset size mismatch: ${descriptor.name}`);
  }
  const hash = nodeCrypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== descriptor.sha256) {
    throw new Error(`Downloaded asset hash mismatch: ${descriptor.name}`);
  }
}

async function waitForSuccessfulRun(proof, options = {}) {
  const request = options.request || api;
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now || Date.now;
  const deadline = now() + (options.maxWaitMs ?? MAX_WAIT_MS);
  let validatedWorkflow = false;
  while (true) {
    const run = await request(`repos/${CANONICAL_REPO}/actions/runs/${proof.runId}`);
    const complete = validateRun(run, proof);
    if (!validatedWorkflow) {
      const workflow = await request(`repos/${CANONICAL_REPO}/actions/workflows/${run.workflow_id}`);
      if (workflow.id !== run.workflow_id || workflow.path !== WORKFLOW_PATH) {
        throw new Error('The producing workflow is not the canonical release workflow.');
      }
      validatedWorkflow = true;
    }
    if (complete) return;
    if (now() >= deadline) throw new Error('Timed out waiting for the canonical release workflow to succeed.');
    await sleep(Math.min(POLL_MS, deadline - now()));
  }
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== MAC_REPO) throw new Error('The Mac relay only runs in the compatibility repository.');
  if (!['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) {
    throw new Error('The Mac relay requires a tag push or an explicit retry.');
  }
  if (!process.env.MAC_UPDATE_PRIVATE_KEY?.trim()) throw new Error('MAC_UPDATE_PRIVATE_KEY is required.');
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  validateVersion(version);
  if (version.includes('-')) throw new Error('The unified compatibility feed only publishes stable versions.');
  const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  if (tag !== `mac-v${version}`) throw new Error('The Mac tag must match package.json exactly.');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid checkout commit.');
  if (await resolveTag(MAC_REPO, tag) !== commit
      || await resolveTag(CANONICAL_REPO, `v${version}`) !== commit) {
    throw new Error('Canonical tag, Mac tag and checkout must identify the same tested commit.');
  }

  const release = validateCanonicalRelease(
    await api(`repos/${CANONICAL_REPO}/releases/tags/v${version}`), version, commit,
  );
  const proofAsset = release.assets.find(asset => asset.name === 'unified-release.json');
  if (!proofAsset || proofAsset.state !== 'uploaded' || proofAsset.size <= 0 || proofAsset.size > 1024 * 1024) {
    throw new Error('Canonical release provenance is missing or invalid.');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-mac-relay-'));
  try {
    const proofPath = path.join(temp, 'unified-release.json');
    await downloadAsset(proofAsset, proofPath);
    if (fs.statSync(proofPath).size !== proofAsset.size) throw new Error('Provenance download size mismatch.');
    const proof = validateProvenance(JSON.parse(fs.readFileSync(proofPath, 'utf8')), { version, commit });
    validateReleaseAssets(release.assets, proof);
    await waitForSuccessfulRun(proof);

    const dir = path.join(temp, 'assets');
    fs.mkdirSync(dir);
    const names = macNames(version);
    for (const name of names) {
      const descriptor = proof.assets.find(asset => asset.name === name);
      if (!descriptor) throw new Error(`Provenance is missing Mac asset: ${name}`);
      const destination = path.join(dir, name);
      await downloadAsset(release.assets.find(asset => asset.name === name), destination);
      await verifyDownloadedAsset(destination, descriptor);
    }
    // Revalidate tags after the bounded wait, before producing a signed feed.
    if (await resolveTag(MAC_REPO, tag) !== commit
        || await resolveTag(CANONICAL_REPO, `v${version}`) !== commit) {
      throw new Error('A release tag moved during relay verification.');
    }
    const notes = path.join(temp, 'release-notes.txt');
    fs.writeFileSync(notes, release.body);
    execFileSync(process.execPath, [path.join(__dirname, 'create-macos-update-manifest.js'),
      '--version', version, '--tag', tag,
      '--arm64', path.join(dir, `Twitch-VOD-Manager-${version}-mac-arm64.zip`),
      '--x64', path.join(dir, `Twitch-VOD-Manager-${version}-mac-x64.zip`),
      '--notes-file', notes,
      '--published-at', new Date(release.published_at).toISOString(),
      '--output', path.join(dir, 'mac-update.json'),
    ], { cwd: ROOT, stdio: 'inherit' });
    await publishImmutable({
      repo: MAC_REPO, tag, version, commit, name: `macOS ${version}`,
      body: release.body, dir, names: [...names, 'mac-update.json'], previousPrefix: 'mac-v',
    });
    console.log(`Verified Mac compatibility release ${tag} at ${commit}.`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = {
  validateRun, resolveTag, validateCanonicalRelease, validateReleaseAssets,
  verifyDownloadedAsset, waitForSuccessfulRun, main,
};
if (require.main === module) main().catch(error => {
  console.error(`Mac release relay failed: ${error.message}`);
  process.exitCode = 1;
});
