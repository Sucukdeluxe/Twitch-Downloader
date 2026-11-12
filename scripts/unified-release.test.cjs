'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const release = require('./publish-unified-release.cjs');
const relay = require('./publish-macos-relay.cjs');
const { validateRemoteTag } = require('./dispatch-macos-release.cjs');
const version = '1.1.23'; const commit = 'a'.repeat(40);
const hash = bytes => nodeCrypto.createHash('sha256').update(bytes).digest('hex');
function provenance() { return { schema: 1, version, commit, runId: '42', runAttempt: '1', repository: release.CANONICAL_REPO, workflow: release.WORKFLOW_PATH, event: 'push', assets: [...release.windowsNames(version), ...release.macNames(version)].map(name => ({ name, size: 4, sha256: hash('test') })) }; }
function run() { return { id: 42, run_attempt: 1, repository: { full_name: release.CANONICAL_REPO }, head_repository: { full_name: release.CANONICAL_REPO }, path: release.WORKFLOW_PATH, event: 'push', head_sha: commit, workflow_id: 4, status: 'completed', conclusion: 'success' }; }
test('provenance pins SHA, repository, workflow and complete unique artifact set', () => {
  assert.equal(release.validateProvenance(provenance(), { version, commit }).commit, commit);
  for (const patch of [{ commit: 'b'.repeat(40) }, { repository: release.MAC_REPO }, { workflow: 'fake.yml' }, { event: 'pull_request' }, { runAttempt: '0' }, { runId: 42 }, { assets: provenance().assets.slice(1) }, { assets: [...provenance().assets, provenance().assets[0]] }]) assert.throws(() => release.validateProvenance({ ...provenance(), ...patch }, { version, commit }));
});
test('remote tags accept exact direct or peeled commits and reject movement', () => {
  const tag = `mac-v${version}`; const ref = `refs/tags/${tag}`;
  assert.equal(validateRemoteTag('', { tag, commit }), false);
  assert.equal(validateRemoteTag(`${commit}\t${ref}`, { tag, commit }), true);
  assert.equal(validateRemoteTag(`${'b'.repeat(40)}\t${ref}\n${commit}\t${ref}^{}`, { tag, commit }), true);
  assert.throws(() => validateRemoteTag(`${'b'.repeat(40)}\t${ref}`, { tag, commit }));
  assert.throws(() => validateRemoteTag(`${commit}\trefs/heads/main`, { tag, commit }));
});
test('relay requires successful approved run and permits a later successful retry', () => {
  assert.equal(relay.validateRun(run(), provenance()), true);
  assert.equal(relay.validateRun({ ...run(), run_attempt: 2 }, provenance()), true);
  assert.equal(relay.validateRun({ ...run(), status: 'in_progress', conclusion: null }, provenance()), false);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { event: 'workflow_dispatch' }, { path: 'untrusted.yml' }, { conclusion: 'failure' }, { run_attempt: 0 }, { id: 43 }]) assert.throws(() => relay.validateRun({ ...run(), ...patch }, provenance()));
});
test('relay polling is bounded and validates the workflow registration', async () => {
  let now = 0;
  await assert.rejects(relay.waitForSuccessfulRun(provenance(), { now: () => now, maxWaitMs: 20, sleep: async ms => { now += ms; }, request: async route => route.includes('/workflows/') ? { id: 4, path: release.WORKFLOW_PATH } : { ...run(), status: 'in_progress' } }), /Timed out/);
});
test('relay rejects missing assets and corrupted transported bytes', async () => {
  const proof = provenance(); const assets = [...proof.assets.map(a => ({ name: a.name, size: a.size, state: 'uploaded' })), { name: 'unified-release.json' }];
  relay.validateReleaseAssets(assets, proof);
  assert.throws(() => relay.validateReleaseAssets(assets.slice(1), proof));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  try { const file = path.join(dir, 'asset'); fs.writeFileSync(file, 'test'); await relay.verifyDownloadedAsset(file, proof.assets[0]); fs.writeFileSync(file, 'evil'); await assert.rejects(relay.verifyDownloadedAsset(file, proof.assets[0]), /hash mismatch/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('publication completes draft before exposure, supports immutable retry and rejects changed bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-')); const originalFetch = global.fetch; const previousAuth = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  let state = null; let nextId = 1; let interruptSecondUpload = true; const stored = new Map(); const events = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const assets = () => [...stored].map(([id, data]) => ({ id, name: data.name, size: data.bytes.length, state: 'uploaded', url: `https://api.github.com/repos/${release.CANONICAL_REPO}/releases/assets/${id}` }));
  global.fetch = async (url, options = {}) => {
    const u = new URL(url); const method = options.method || 'GET'; events.push(`${method} ${u.pathname}`);
    if (u.hostname === 'uploads.github.com') { assert.equal(state.draft, true); if (interruptSecondUpload && u.searchParams.get('name') === 'two.zip') throw Error('Simulated interrupted upload'); const chunks = []; for await (const c of options.body) chunks.push(c); stored.set(nextId++, { name: u.searchParams.get('name'), bytes: Buffer.concat(chunks) }); return json({}); }
    if (u.pathname.includes('/git/ref/tags/')) return json({ object: { type: 'commit', sha: commit } });
    if (u.pathname.endsWith('/releases/latest')) return json({}, 404);
    if (/\/releases\/assets\/\d+$/.test(u.pathname)) { const id = Number(u.pathname.split('/').at(-1)); if (method === 'DELETE') { stored.delete(id); return new Response(null, { status: 204 }); } return new Response(stored.get(id).bytes); }
    if (u.pathname.endsWith('/releases/1/assets')) return json(assets());
    if (u.pathname.includes('/releases/tags/')) return state ? json(state) : json({}, 404);
    if (method === 'POST' && u.pathname.endsWith('/releases')) { state = { id: 1, ...JSON.parse(options.body) }; assert.equal(state.draft, true); return json(state); }
    if (u.pathname.endsWith('/releases/1')) { if (method === 'PATCH') { assert.equal(stored.size, 2); Object.assign(state, JSON.parse(options.body)); } return json(state); }
    throw Error(`Unexpected request ${method} ${url}`);
  };
  const args = { repo: release.CANONICAL_REPO, tag: `v${version}`, version, commit, name: 'Release', body: 'Notes', dir, names: ['one.zip', 'two.zip'], previousPrefix: 'v' };
  try {
    fs.writeFileSync(path.join(dir, 'one.zip'), 'one'); fs.writeFileSync(path.join(dir, 'two.zip'), 'two');
    await assert.rejects(release.publishImmutable(args), /interrupted upload/);
    assert.equal(state.draft, true); assert.equal(stored.size, 1);
    interruptSecondUpload = false;
    await release.publishImmutable(args); assert.equal(state.draft, false);
    const count = events.length; await release.publishImmutable(args);
    assert.equal(events.slice(count).some(e => /^(POST|PATCH|DELETE)/.test(e)), false);
    fs.writeFileSync(path.join(dir, 'one.zip'), 'bad'); await assert.rejects(release.publishImmutable(args), /immutable/);
    assert.equal(stored.get(1).bytes.toString(), 'one');
    await assert.rejects(release.publishImmutable({ ...args, commit: 'b'.repeat(40) }), /tested commit/);
  } finally { global.fetch = originalFetch; if (previousAuth === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previousAuth; fs.rmSync(dir, { recursive: true, force: true }); }
});
test('stable versions never move latest backwards', () => {
  assert.equal(release.advances('1.1.23', 'mac-v1.1.22', 'mac-v'), true);
  assert.equal(release.advances('1.1.23', 'v1.1.24', 'v'), false);
  assert.equal(release.advances('1.1.23', 'v1.1.23', 'v'), false);
  assert.throws(() => release.advances('1.1.23', 'surprise', 'v'));
});
test('production receipts and Mac transport proofs are required before publication', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-proof-test-'));
  const id = { commit, runId: '42', runAttempt: '2' };
  try {
    fs.mkdirSync(path.join(dir, 'verification'));
    const all = [...release.windowsNames(version), ...release.macNames(version)];
    for (const name of all) fs.writeFileSync(path.join(dir, name), `fixture:${name}`);
    const descriptions = await Promise.all(all.map(name => release.describe(path.join(dir, name))));
    const files = descriptions.slice(0, 3).map(({ size, ...asset }) => ({ ...asset, bytes: size }));
    const proof = { version, candidate: false, fingerprint: 'f'.repeat(64), files };
    const receipt = { commit, fingerprint: proof.fingerprint, success: true, tests: 68, checks: [{ name: 'native installer', success: true }] };
    fs.writeFileSync(path.join(dir, 'verification/package.json'), JSON.stringify(proof));
    fs.writeFileSync(path.join(dir, 'verification/receipt.json'), JSON.stringify(receipt));
    for (const arch of ['arm64', 'x64']) fs.writeFileSync(path.join(dir, `mac-proof-${arch}.json`), JSON.stringify({ schema: 1, version, arch, ...id, runAttempt: '1', assets: descriptions.filter(a => a.name.includes(`-mac-${arch}.`)) }));
    assert.equal((await release.verifyCandidate(version, id, dir)).length, 7);
    fs.writeFileSync(path.join(dir, 'verification/package.json'), JSON.stringify({ ...proof, candidate: true }));
    await assert.rejects(release.verifyCandidate(version, id, dir), /Windows release provenance/);
    fs.writeFileSync(path.join(dir, 'verification/package.json'), JSON.stringify(proof));
    fs.writeFileSync(path.join(dir, release.macNames(version)[0]), 'corrupted');
    await assert.rejects(release.verifyCandidate(version, id, dir), /Mac transport hash/);
    fs.rmSync(path.join(dir, 'mac-proof-arm64.json'));
    await assert.rejects(release.verifyCandidate(version, id, dir), /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('missing deploy key fails without attempting dispatch', () => {
  const prior = process.env.MAC_RELEASE_DEPLOY_KEY; delete process.env.MAC_RELEASE_DEPLOY_KEY;
  try { assert.throws(() => require('./dispatch-macos-release.cjs').dispatchMacRelease({ version, commit, preflight: true }), /required before publication/); }
  finally { if (prior !== undefined) process.env.MAC_RELEASE_DEPLOY_KEY = prior; }
});
