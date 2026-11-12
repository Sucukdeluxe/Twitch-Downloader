// Verify that native regression gates and transported artifact proofs precede publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const load = name => yaml.load(read(`.github/workflows/${name}.yml`));
const pkg = require('../package.json');
const release = load('windows-release');
const mac = load('macos-ci');
const relay = load('macos-release');
const ordinary = load('windows-ci');
const publisher = read('scripts/publish-unified-release.cjs');
const relayScript = read('scripts/publish-macos-relay.cjs');
const dispatch = read('scripts/dispatch-macos-release.cjs');
const commands = job => (job.steps || []).map(step => step.run || '').join('\n');
const publication = /(?:gh\s+release\s+(?:create|upload)|publish-(?:unified-release|macos-relay)\.cjs(?! --record-mac))/;
function failsClosed(job) {
  assert.ok(!job['continue-on-error']);
  for (const step of job.steps || []) assert.ok(!step['continue-on-error']);
}
assert.equal(pkg.scripts['test:unit'], 'vitest run', 'A missing unit suite must fail');
for (const name of ['test:security', 'test:lint-config', 'test:ci-contract', 'test:unified-release', 'test:e2e:release', 'test:mac', 'test:mac-update']) {
  assert.ok(pkg.scripts[name] && !pkg.scripts[name].includes('run-local-check'), `${name} must run directly`);
}
assert.match(read('scripts/release-checks.mjs'), /scripts\/unified-release\.test\.cjs/);
assert.match(read('scripts/release-checks.mjs'), /scripts\/smoke-test-precise-trim\.js/);
for (const command of Object.values(pkg.scripts)) {
  for (const match of command.matchAll(/\b(scripts\/[\w./-]+\.(?:js|mjs|cjs))\b/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])), `Required script missing: ${match[1]}`);
  }
}
for (const workflow of [ordinary, mac]) {
  assert.ok(Object.hasOwn(workflow.on, 'push') && Object.hasOwn(workflow.on, 'pull_request'));
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(!publication.test(commands(job)), 'Ordinary CI cannot publish');
    failsClosed(job);
  }
}
assert.match(String(ordinary.jobs.verify['runs-on']), /^windows-/);
for (const cmd of ['npm ci', 'npm run build', 'npm run test:unit', 'npm run test:security', 'npm run test:lint-config', 'npm run test:ci-contract', 'npm run rebuild:electron', 'npm run test:e2e:focused']) {
  assert.ok(commands(ordinary.jobs.verify).includes(cmd), `Windows CI needs ${cmd}`);
}
assert.deepEqual(release.on.push.tags, ['v*']);
assert.deepEqual(release.on.pull_request.branches, ['main']);
assert.equal(release.concurrency['cancel-in-progress'], false);
for (const job of Object.values(release.jobs)) failsClosed(job);
const win = release.jobs['verify-package'];
assert.match(String(win['runs-on']), /^windows-/);
assert.match(commands(win), /npm run release:build/);
assert.match(pkg.scripts['release:build'], /npm run release:verify\s*&&\s*npm run release:package/);
assert.doesNotMatch(commands(win), /--ci-candidate|npm run dist:ci|\|\|\s*(?:true|exit\s+0)/);
assert.ok([win.needs].flat().includes('verify-webkit'));
const webkit = release.jobs['verify-webkit'];
assert.match(String(webkit['runs-on']), /^macos-/);
assert.match(commands(webkit), /node scripts\/release-gate\.mjs --webkit-only/);
const download = win.steps.find(step => String(step.uses || '').startsWith('actions/download-artifact@'));
assert.equal(download.with.name, 'webkit-verification-${{ github.sha }}');
assert.equal(download.with['run-id'], undefined, 'Do not import another run');
assert.ok(win.steps.some(step => /npm run release:build/.test(step.run || '') && step.env?.RELEASE_WEBKIT_RECEIPT === 'release/webkit/webkit.json'));
for (const [name, verify, pack] of [['ordinary', mac.jobs.verify, mac.jobs.package], ['release', release.jobs['verify-macos'], release.jobs['package-macos']]]) {
  for (const job of [verify, pack]) {
    assert.deepEqual(job.strategy.matrix.include.map(row => row.runner).sort(), ['macos-15', 'macos-15-intel']);
    assert.deepEqual(job.strategy.matrix.include.map(row => row.arch).sort(), ['arm64', 'x64']);
  }
  for (const cmd of ['npm ci', 'npm run lint', 'npm run security:check', 'npm run test:security', 'npm run test:lint-config', 'npm run test:ci-contract', 'npm run test:unit', 'npm run rebuild:electron', 'npm run test:mac-update', 'npm run test:mac', 'npm run test:e2e:release']) {
    assert.ok(commands(verify).includes(cmd), `${name} Mac checks need ${cmd}`);
  }
  for (const cmd of ['npm run dist:mac', '-c.mac.identity=-', 'codesign --verify --deep --strict', 'npm run test:mac', 'scripts/smoke-test-macos-update.js', 'mac-v1.0.10']) assert.ok(commands(pack).includes(cmd), `${name} Mac packaging needs ${cmd}`);
  const build = pack.steps.find(step => /npm run dist:mac/.test(step.run || ''));
  assert.equal(build.env.CSC_FOR_PULL_REQUEST, 'true');
  assert.equal(build.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.ok(pack.steps.some(step => step.env?.PACKAGED_APP_PATH));
  assert.ok(pack.steps.some(step => step.env?.MAC_UPDATE_FROM_APP));
}
const publish = release.jobs.publish;
assert.deepEqual([...publish.needs].sort(), ['prepare', 'verify-webkit', 'verify-package', 'verify-macos', 'package-macos'].sort());
assert.match(publish.if, /github\.repository == 'Sucukdeluxe\/Twitch-Downloader'/);
assert.match(publish.if, /github\.event_name == 'push'/);
assert.match(publish.if, /refs\/tags\/v/);
assert.doesNotMatch(publish.if, /always\s*\(/);
assert.match(commands(publish), /node scripts\/publish-unified-release\.cjs/);
for (const term of ['verification/package.json', 'verification/receipt.json', 'proof.candidate !== false', 'receipt.success !== true', 'receipt.tests <= 0', 'receipt.commit !== id.commit', 'proof.fingerprint !== receipt.fingerprint', "createHash('sha256')", "createHash('sha512')", 'mac-proof-', 'actual.sha256 !== file.sha256', 'actual.sha512 !== file.sha512']) assert.ok(publisher.includes(term), `Missing publication proof check: ${term}`);
assert.ok(publisher.indexOf('preflight: true') < publisher.lastIndexOf('await publishImmutable'), 'Authenticate relay before public release');
assert.deepEqual(relay.on.push.tags, ['mac-v*']);
assert.equal(relay.concurrency['cancel-in-progress'], false);
assert.match(relay.jobs.relay.if, /github\.repository == 'Sucukdeluxe\/Twitch-Downloader-macos'/);
failsClosed(relay.jobs.relay);
assert.match(commands(relay.jobs.relay), /node scripts\/publish-macos-relay\.cjs/);
assert.ok(relay.jobs.relay.steps.some(step => step.env?.MAC_UPDATE_PRIVATE_KEY));
for (const term of ['validateProvenance', 'resolveTag', 'publishImmutable', 'conclusion', 'success', 'sha256']) assert.ok(relayScript.includes(term), `Relay must verify ${term}`);
assert.ok(dispatch.includes('StrictHostKeyChecking=yes') && dispatch.includes('refs/tags/${tag}') && dispatch.includes('`mac-v${version}`'), 'Use pinned SSH transport and immutable compatibility tags');
assert.doesNotMatch(commands(publish), /--ci-candidate|npm run dist:ci/);
console.log('CI contracts passed: Windows, both native Macs, precise trim, artifact integrity and compatibility update relay');
