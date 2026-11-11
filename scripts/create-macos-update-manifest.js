#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const REPOSITORY = 'Sucukdeluxe/Twitch-Downloader-macos';
// SemVer without build metadata: every published version has one release tag.
const VERSION = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;

function validateVersion(version) {
  if (typeof version !== 'string' || version.length > 128) throw new Error('Version must be strict SemVer.');
  const separator = version.indexOf('-');
  const base = separator < 0 ? version : version.slice(0, separator);
  const prerelease = separator < 0 ? null : version.slice(separator + 1);
  const validPrerelease = prerelease === null || prerelease.split('.').every((part) =>
    /^[0-9A-Za-z-]+$/.test(part) && !(/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')));
  if (!VERSION.test(base) || !validPrerelease) {
    throw new Error('Version must be strict SemVer (x.y.z, optional prerelease, at most 8 digits per version component).');
  }
}

async function describeArtifact(file, arch, version, tag) {
  const filename = `Twitch-VOD-Manager-${version}-mac-${arch}.zip`;
  if (typeof file !== 'string' || path.basename(file) !== filename) {
    throw new Error(`Expected the ${arch} artifact named ${filename}.`);
  }
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.size < 4 || !Number.isSafeInteger(stat.size)) {
    throw new Error(`The ${arch} artifact must be a nonempty regular ZIP file.`);
  }
  const hash = nodeCrypto.createHash('sha256');
  let size = 0;
  let signature = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
    if (signature.length < 4) signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)]);
  }
  if (size !== stat.size || !signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error(`The ${arch} artifact changed while hashing or is not a ZIP archive.`);
  }
  return {
    url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${filename}`,
    size,
    sha256: hash.digest('hex')
  };
}

async function createManifest(options) {
  const { version, tag, arm64, x64, releaseNotes = '', publicKey, privateKey } = options;
  validateVersion(version);
  if (tag !== `mac-v${version}`) throw new Error('Release tag must be mac-v followed by the exact version.');
  if (typeof releaseNotes !== 'string' || Buffer.byteLength(releaseNotes, 'utf8') > 32768) {
    throw new Error('Release notes must be UTF-8 text no larger than 32768 bytes.');
  }
  const publishedAt = options.publishedAt || new Date().toISOString();
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt)) || new Date(publishedAt).toISOString() !== publishedAt) {
    throw new Error('publishedAt must be a canonical UTC ISO timestamp.');
  }
  let signingKey;
  let verificationKey;
  try {
    signingKey = nodeCrypto.createPrivateKey(privateKey);
    verificationKey = nodeCrypto.createPublicKey(publicKey);
    if (signingKey.asymmetricKeyType !== 'ed25519' || verificationKey.asymmetricKeyType !== 'ed25519') throw new Error();
    const actual = nodeCrypto.createPublicKey(signingKey).export({ type: 'spki', format: 'der' });
    const expected = verificationKey.export({ type: 'spki', format: 'der' });
    if (!actual.equals(expected)) throw new Error();
  } catch {
    throw new Error('MAC_UPDATE_PRIVATE_KEY must be an Ed25519 PEM private key matching the bundled public key.');
  }
  const [appleSilicon, intel] = await Promise.all([
    describeArtifact(arm64, 'arm64', version, tag),
    describeArtifact(x64, 'x64', version, tag)
  ]);
  const payload = Buffer.from(JSON.stringify({
    schema: 1, version, publishedAt, releaseNotes,
    artifacts: { arm64: appleSilicon, x64: intel }
  }), 'utf8');
  const signature = nodeCrypto.sign(null, payload, signingKey);
  if (!nodeCrypto.verify(null, payload, verificationKey, signature)) throw new Error('Manifest signature self-check failed.');
  return { payload: payload.toString('base64'), signature: signature.toString('base64') };
}

async function main(argv) {
  const allowed = new Set(['version', 'tag', 'arm64', 'x64', 'notes-file', 'output', 'public-key', 'published-at']);
  const args = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.has(name) || !argv[i + 1] || args[name]) throw new Error('Invalid or duplicate command-line option.');
    args[name] = argv[i + 1];
  }
  for (const name of ['version', 'tag', 'arm64', 'x64', 'notes-file', 'output']) {
    if (!args[name]) throw new Error(`Required option: --${name}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  if (args.version !== packageJson.version) throw new Error('Manifest version must match package.json.');
  if (!process.env.MAC_UPDATE_PRIVATE_KEY) throw new Error('MAC_UPDATE_PRIVATE_KEY is required.');
  const manifest = await createManifest({
    version: args.version, tag: args.tag, arm64: args.arm64, x64: args.x64,
    releaseNotes: fs.readFileSync(args['notes-file'], 'utf8'),
    publicKey: fs.readFileSync(args['public-key'] || path.resolve(__dirname, '../build/mac-update-public-key.pem'), 'utf8'),
    privateKey: process.env.MAC_UPDATE_PRIVATE_KEY,
    publishedAt: args['published-at']
  });
  fs.writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(`Created signed macOS update manifest for ${args.version}.`);
}

module.exports = { createManifest, validateVersion };
if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  console.error(`Manifest generation failed: ${error.message}`);
  process.exitCode = 1;
});
