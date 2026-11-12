const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createManifest, validateVersion } = require('./create-macos-update-manifest');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-update-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = nodeCrypto.generateKeyPairSync('ed25519');
  const options = {
    version: '1.2.3', tag: 'mac-v1.2.3', publishedAt: '2026-11-11T12:00:00.000Z', releaseNotes: 'Test update',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
  for (const arch of ['arm64', 'x64']) {
    options[arch] = path.join(dir, `Twitch-VOD-Manager-1.2.3-mac-${arch}.zip`);
    // Generator tests only; packaged application and ZIP extraction tests run separately.
    fs.writeFileSync(options[arch], Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(`test-${arch}`)]));
  }
  return { options, keys, dir };
}

test('signs exact payload bytes and hashes both versioned architecture assets', async (t) => {
  const { options, keys } = fixture(t);
  const manifest = await createManifest(options);
  assert.deepEqual(Object.keys(manifest), ['payload', 'signature']);
  const raw = Buffer.from(manifest.payload, 'base64');
  assert.equal(nodeCrypto.verify(null, raw, keys.publicKey, Buffer.from(manifest.signature, 'base64')), true);
  const payload = JSON.parse(raw);
  assert.equal(payload.schema, 1);
  assert.equal(payload.version, options.version);
  assert.equal(payload.publishedAt, options.publishedAt);
  assert.deepEqual(Object.keys(payload.artifacts), ['arm64', 'x64']);
  for (const arch of ['arm64', 'x64']) {
    const file = fs.readFileSync(options[arch]);
    assert.equal(payload.artifacts[arch].size, file.length);
    assert.equal(payload.artifacts[arch].sha256, nodeCrypto.createHash('sha256').update(file).digest('hex'));
    assert.equal(payload.artifacts[arch].url, `https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v1.2.3/Twitch-VOD-Manager-1.2.3-mac-${arch}.zip`);
  }
  payload.version = '99.0.0';
  assert.equal(nodeCrypto.verify(null, Buffer.from(JSON.stringify(payload)), keys.publicKey, Buffer.from(manifest.signature, 'base64')), false);
  const mutatedAsset = Buffer.concat([fs.readFileSync(options.arm64), Buffer.from('tampered')]);
  assert.notEqual(nodeCrypto.createHash('sha256').update(mutatedAsset).digest('hex'), payload.artifacts.arm64.sha256);
});

test('rejects absent, wrong architecture, wrong version, symlink and malformed assets', async (t) => {
  const { options, dir } = fixture(t);
  await assert.rejects(createManifest({ ...options, x64: undefined }), /x64 artifact/);
  await assert.rejects(createManifest({ ...options, x64: options.arm64 }), /x64 artifact/);
  await assert.rejects(createManifest({ ...options, version: '1.2.4', tag: 'mac-v1.2.4' }), /artifact named/);
  await assert.rejects(createManifest({ ...options, tag: 'v1.2.3' }), /Release tag/);
  fs.unlinkSync(options.x64);
  await assert.rejects(createManifest(options), /ENOENT/);
  fs.symlinkSync(options.arm64, options.x64);
  await assert.rejects(createManifest(options), /regular ZIP/);
  fs.unlinkSync(options.x64);
  fs.writeFileSync(options.x64, 'not a ZIP');
  await assert.rejects(createManifest(options), /not a ZIP/);
  fs.unlinkSync(options.x64);
  fs.mkdirSync(options.x64);
  await assert.rejects(createManifest(options), /regular ZIP/);
  assert.ok(fs.existsSync(dir));
});

test('rejects missing, unrelated or non-Ed25519 signing keys without disclosing them', async (t) => {
  const { options } = fixture(t);
  await assert.rejects(createManifest({ ...options, privateKey: undefined }), /MAC_UPDATE_PRIVATE_KEY/);
  const other = nodeCrypto.generateKeyPairSync('ed25519');
  await assert.rejects(createManifest({ ...options, privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /matching/);
  const ec = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await assert.rejects(createManifest({ ...options,
    privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: ec.publicKey.export({ type: 'spki', format: 'pem' })
  }), /Ed25519/);
  await assert.rejects(createManifest({ ...options, privateKey: 'DO-NOT-LOG-THIS-SECRET' }), (error) => !error.message.includes('DO-NOT-LOG'));
});

test('requires strict versions, canonical timestamps and bounded release notes', async (t) => {
  for (const version of ['1.2.3', '0.0.0', '1.2.3-rc.1', '1.2.3-0.alpha']) validateVersion(version);
  for (const version of ['01.2.3', '1.2', 'v1.2.3', '1.2.3+meta', '1.2.3-01', '1.2.3-', '123456789.1.2', '1.2.3-a..b']) {
    assert.throws(() => validateVersion(version), /SemVer/);
  }
  const { options } = fixture(t);
  await assert.rejects(createManifest({ ...options, publishedAt: 'not-a-date' }), /ISO/);
  await assert.rejects(createManifest({ ...options, publishedAt: '2026-11-11' }), /ISO/);
  await assert.rejects(createManifest({ ...options, releaseNotes: 'a'.repeat(32769) }), /32768/);
});

test('CLI writes a verifiable envelope, refuses overwrites, and fails closed without its secret', (t) => {
  const { spawnSync } = require('node:child_process');
  const { options, keys, dir } = fixture(t);
  const { version } = require('../package.json');
  const publicKeyFile = path.join(dir, 'public.pem');
  const notesFile = path.join(dir, 'notes.txt');
  const output = path.join(dir, 'mac-update.json');
  fs.writeFileSync(publicKeyFile, options.publicKey);
  fs.writeFileSync(notesFile, options.releaseNotes);
  const args = [path.join(__dirname, 'create-macos-update-manifest.js'), '--version', version, '--tag', `mac-v${version}`];
  for (const arch of ['arm64', 'x64']) {
    const artifact = path.join(dir, `Twitch-VOD-Manager-${version}-mac-${arch}.zip`);
    if (artifact !== options[arch]) fs.renameSync(options[arch], artifact);
    args.push(`--${arch}`, artifact);
  }
  args.push('--public-key', publicKeyFile, '--notes-file', notesFile, '--output', output);
  const env = { ...process.env, MAC_UPDATE_PRIVATE_KEY: options.privateKey };
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(nodeCrypto.verify(null, Buffer.from(manifest.payload, 'base64'), keys.publicKey, Buffer.from(manifest.signature, 'base64')), true);
  assert.equal(JSON.parse(Buffer.from(manifest.payload, 'base64')).version, version);
  const original = fs.readFileSync(output, 'utf8');
  assert.equal(spawnSync(process.execPath, args, { env, encoding: 'utf8' }).status, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), original);
  fs.unlinkSync(output);
  delete env.MAC_UPDATE_PRIVATE_KEY;
  const missing = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /MAC_UPDATE_PRIVATE_KEY is required/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(`${result.stdout}${result.stderr}${missing.stdout}${missing.stderr}`.includes(options.privateKey), false);
});
