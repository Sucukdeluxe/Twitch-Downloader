// Original released application (MAC_UPDATE_FROM_APP) -> unmodified release ZIP.
// Without an original bundle, use an explicitly reported synthetic updater fixture.
// Every process and data directory is isolated from user data and Keychain.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron } = require('playwright');
const asar = require('@electron/asar');
const { createE2eEnvironment, getElectronLaunchOptions, verifyE2eIsolation, cleanupE2eEnvironment } = require('./e2e-test-environment');
const execute = promisify(execFile);
const repository = path.resolve(__dirname, '..');
const feed = 'https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/latest/download/mac-update.json';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(read, description, timeout = 180000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readIfExists(file) { return fs.existsSync(file) ? readJson(file) : null; }

async function sha256(file) {
  const hash = nodeCrypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function makeOldBundle(source, target, scratch, version, publicKey) {
  await execute('/usr/bin/ditto', [source, target]);
  const resources = path.join(target, 'Contents', 'Resources');
  const archive = path.join(resources, 'app.asar');
  asar.extractAll(archive, scratch);
  const packageFile = path.join(scratch, 'package.json');
  const metadata = readJson(packageFile);
  metadata.version = version;
  fs.writeFileSync(packageFile, JSON.stringify(metadata));
  fs.rmSync(archive);
  fs.rmSync(`${archive}.unpacked`, { force: true, recursive: true });
  asar.uncache(archive);
  await asar.createPackageWithOptions(scratch, archive, { unpack: '**/*.node', unpackDir: '**/better-sqlite3' });
  asar.uncache(archive);
  const headerHash = nodeCrypto.createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  const plist = path.join(target, 'Contents', 'Info.plist');
  await execute('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', version, plist]);
  await execute('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', version, plist]);
  await execute('/usr/bin/plutil', ['-replace', 'ElectronAsarIntegrity', '-json', JSON.stringify({ 'Resources/app.asar': { algorithm: 'SHA256', hash: headerHash } }), plist]);
  fs.writeFileSync(path.join(resources, 'mac-update-public-key.pem'), publicKey);
  await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target], { timeout: 120000 });
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { timeout: 120000 });
}

async function ownedProcesses(executable, helperPrefix) {
  const output = await execute('/bin/ps', ['-axo', 'pid=,command=']);
  return output.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    const command = match[2];
    return command === executable || command.startsWith(`${executable} `) || command.startsWith(helperPrefix)
      ? [{ pid: Number(match[1]), command }] : [];
  });
}

async function run() {
  assert.equal(process.platform, 'darwin', 'This acceptance test requires macOS.');
  assert.ok(['arm64', 'x64'].includes(process.arch));
  const version = require('../package.json').version;
  const parts = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  assert.ok(parts, 'A stable packaged version is required.');
  const originalApp = process.env.MAC_UPDATE_FROM_APP ? path.resolve(process.env.MAC_UPDATE_FROM_APP) : null;
  if (originalApp && process.env.CI !== 'true') throw new Error('Original 1.0.10 may activate its window. Run the original-release upgrade on CI; local tests use the background-capable fixture.');
  const originalVersion = originalApp ? JSON.parse(asar.extractFile(path.join(originalApp, 'Contents', 'Resources', 'app.asar'), 'package.json')).version : null;
  const previous = originalVersion || process.env.MAC_UPDATE_FROM_VERSION || `${parts[1]}.${parts[2]}.${Number(parts[3]) - 1}`;
  assert.ok(/^\d+\.\d+\.\d+$/.test(previous), 'Set MAC_UPDATE_FROM_VERSION to a lower stable version.');
  const oldParts = previous.split('.').map(Number);
  const newParts = version.split('.').map(Number);
  const difference = oldParts.findIndex((part, index) => part !== newParts[index]);
  assert.ok(difference >= 0 && oldParts[difference] < newParts[difference], 'Original application must be older than the target release');
  const source = process.env.PACKAGED_APP_PATH
    ? path.dirname(path.dirname(path.dirname(path.resolve(process.env.PACKAGED_APP_PATH))))
    : path.join(repository, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Twitch VOD Manager.app');
  const zip = path.resolve(process.env.MAC_UPDATE_ZIP || path.join(repository, 'release', `Twitch-VOD-Manager-${version}-mac-${process.arch}.zip`));
  assert.ok(fs.statSync(zip).isFile(), 'Build the matching release ZIP first.');
  assert.ok(fs.existsSync(path.join(source, 'Contents', 'Resources', 'macos-updater')), 'Build the packaged updater first.');
  const environment = createE2eEnvironment('macos-update', { theme: 'twitch' });
  const directory = fs.realpathSync(environment.rootDir);
  const target = path.join(directory, 'Twitch VOD Manager.app');
  const executable = path.join(target, 'Contents', 'MacOS', 'Twitch VOD Manager');
  const state = path.join(environment.userDataDir, 'mac-updates');
  const helperPrefix = path.join(fs.realpathSync(environment.userDataDir), 'mac-updates', 'installer-');
  const checks = { previous, version, arch: process.arch, source: originalApp ? 'original released application with isolated test signing key' : 'synthetic older-version fixture with current updater', destination: 'unmodified packaged release' };
  let app;
  let phase = 'preparing isolated bundle';
  let token;
  try {
    const keys = nodeCrypto.generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
    console.log('[macos-update] Preparing isolated older application');
    if (originalApp) {
      // Never mutate the user's installed app. Only the copied fixture trusts the ephemeral test key.
      await execute('/usr/bin/ditto', [originalApp, target]);
      const resources = path.join(target, 'Contents', 'Resources');
      fs.writeFileSync(path.join(resources, 'mac-update-public-key.pem'), publicKey);
      // Keep the original released code intact while suppressing a test-only Dock item.
      await execute('/usr/bin/plutil', ['-replace', 'LSUIElement', '-bool', 'true', path.join(target, 'Contents', 'Info.plist')]);
      await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target], { timeout: 120000 });
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { timeout: 120000 });
      assert.equal(await sha256(path.join(resources, 'app.asar')), await sha256(path.join(originalApp, 'Contents', 'Resources', 'app.asar')), 'Original release code must remain unchanged');
    } else {
      await makeOldBundle(source, target, path.join(directory, 'old-asar'), previous, publicKey);
    }
    const fileHash = await sha256(zip);
    const size = fs.statSync(zip).size;
    const artifacts = Object.fromEntries(['arm64', 'x64'].map((arch) => [arch, {
      url: `https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v${version}/Twitch-VOD-Manager-${version}-mac-${arch}.zip`,
      size, sha256: fileHash
    }]));
    // Only this process architecture is requested. The other descriptor cannot be downloaded by the test transport.
    const payload = Buffer.from(JSON.stringify({ schema: 1, version, publishedAt: new Date().toISOString(), releaseNotes: 'Isolated real application update acceptance', artifacts }));
    const envelope = JSON.stringify({ payload: payload.toString('base64'), signature: nodeCrypto.sign(null, payload, keys.privateKey).toString('base64') });
    phase = 'launching older application';
    const options = getElectronLaunchOptions(environment);
    // Only remote CI may run the unchanged legacy release, which predates background tests.
    if (originalApp) options.env.TVM_E2E_BACKGROUND = '0';
    options.executablePath = executable;
    options.args = options.args.filter((arg) => arg !== '.');
    app = await electron.launch({ ...options, timeout: 60000 });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    checks.isolation = await verifyE2eIsolation(app, win, environment);
    assert.equal(await win.evaluate(() => window.api.getVersion()), previous);
    phase = 'rejecting a second instance using the same profile';
    const second = spawn(executable, options.args, { cwd: options.cwd, env: options.env, stdio: 'ignore' });
    try {
      const exited = new Promise((resolve, reject) => {
        second.once('error', reject);
        second.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const timeout = delay(10000).then(() => { throw new Error('Second instance did not exit within 10 seconds'); });
      const exit = await Promise.race([exited, timeout]);
      assert.equal(exit.code, 0, `Second instance exited with signal ${exit.signal}`);
      assert.equal(exit.signal, null);
      assert.equal(app.process().exitCode, null, 'Original app must remain running');
      assert.equal(await win.evaluate(() => window.api.getVersion()), previous);
      await verifyE2eIsolation(app, win, environment);
      checks.singleInstance = true;
    } finally {
      if (second.exitCode === null && second.signalCode === null) second.kill('SIGTERM');
    }
    await win.evaluate(async () => {
      const config = await window.api.getConfig();
      await window.api.saveConfig({ ...config, theme: 'light', language: 'en' });
      window.__macUpdateEvents = { available: [], downloaded: [], errors: [], progress: [] };
      window.api.onUpdateAvailable((info) => window.__macUpdateEvents.available.push(info));
      window.api.onUpdateDownloaded((info) => window.__macUpdateEvents.downloaded.push(info));
      window.api.onUpdateError((error) => window.__macUpdateEvents.errors.push(error));
      window.api.onUpdateDownloadProgress((progress) => window.__macUpdateEvents.progress.push(progress.percent));
    });
    const sentinel = nodeCrypto.randomBytes(16).toString('hex');
    await app.evaluate(({ app: nativeApp }, fixture) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      const axios = appRequire('axios').default;
      const fs = process.getBuiltinModule('fs');
      const Database = appRequire('better-sqlite3');
      const database = new Database(fixture.database);
      database.exec('CREATE TABLE mac_update_acceptance (value TEXT NOT NULL)');
      database.prepare('INSERT INTO mac_update_acceptance (value) VALUES (?)').run(fixture.sentinel);
      database.close();
      const original = axios.get;
      globalThis.__macUpdateRequests = [];
      axios.get = async (url, ...args) => {
        globalThis.__macUpdateRequests.push(String(url));
        if (url === fixture.feed) return { data: Buffer.from(fixture.envelope), status: 200 };
        if (url === fixture.url) return { data: fs.createReadStream(fixture.zip), status: 200 };
        return original.call(axios, url, ...args);
      };
    }, { database: path.join(environment.appDataDir, 'app.db'), sentinel, feed, envelope, url: artifacts[process.arch].url, zip });
    phase = 'checking signed manifest';
    console.log('[macos-update] Checking signed manifest through renderer IPC');
    checks.checkResponse = await win.evaluate(() => window.api.checkUpdate());
    assert.notEqual(checks.checkResponse?.error, true);
    await win.waitForFunction((expected) => window.__macUpdateEvents.available.some((info) => info.version === expected), version, { timeout: 30000 });
    phase = 'downloading actual release ZIP';
    checks.downloadResponse = await win.evaluate(() => window.api.downloadUpdate());
    assert.notEqual(checks.downloadResponse?.error, true);
    await win.waitForFunction((expected) => window.__macUpdateEvents.downloaded.some((info) => info.version === expected), version, { timeout: 60000 });
    checks.events = await win.evaluate(() => window.__macUpdateEvents);
    assert.deepEqual(checks.events.errors, []);
    assert.ok(checks.events.progress.includes(100));
    checks.requests = await app.evaluate(() => globalThis.__macUpdateRequests);
    assert.ok(checks.requests.includes(feed));
    assert.equal(checks.requests.filter((url) => url === artifacts[process.arch].url).length, 1);
    assert.equal(await sha256(path.join(state, 'update.zip')), fileHash);
    phase = 'preparing native installer and orderly shutdown';
    console.log('[macos-update] Installing through renderer IPC and waiting for new-app health');
    const closed = app.waitForEvent('close', { timeout: 180000 });
    // Successful installation closes this renderer; a lost context is expected only after the helper plan exists.
    const install = win.evaluate(() => window.api.installUpdate()).then((result) => ({ result }), (error) => ({ error: String(error) }));
    const planFile = await waitFor(() => fs.readdirSync(state).find((name) => /^plan-[a-f0-9]{64}\.json$/.test(name)), phase, 120000);
    const plan = readJson(path.join(state, planFile));
    token = plan.healthToken;
    assert.equal(plan.targetApp, target);
    assert.equal(plan.expectedVersion, version);
    assert.equal(plan.userDataDirectory, fs.realpathSync(environment.userDataDir));
    await closed;
    checks.installResponse = await install;
    assert.notEqual(checks.installResponse.result?.error, true, JSON.stringify(checks.installResponse));
    app = null;
    phase = 'native replacement and new-app health acknowledgment';
    const result = await waitFor(() => {
      const marker = readIfExists(path.join(state, `result-${token}.json`));
      return marker && ['installed', 'rolled-back', 'failed'].includes(marker.status) ? marker : null;
    }, phase, 180000);
    checks.result = result;
    assert.equal(result.status, 'installed', result.message);
    const health = readJson(path.join(state, `health-${token}.json`));
    checks.health = health;
    assert.equal(health.schema, 1);
    assert.equal(health.token, token);
    assert.equal(health.version, version);
    assert.ok(Number.isSafeInteger(health.pid) && health.pid > 1);
    assert.ok((await ownedProcesses(executable, helperPrefix)).some((item) => item.pid === health.pid && item.command.startsWith(executable)));
    assert.equal((await execute('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(target, 'Contents', 'Info.plist')])).stdout.trim(), version);
    asar.uncache(path.join(target, 'Contents', 'Resources', 'app.asar'));
    assert.equal(JSON.parse(asar.extractFile(path.join(target, 'Contents', 'Resources', 'app.asar'), 'package.json')).version, version);
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { timeout: 120000 });
    assert.equal(await sha256(path.join(target, 'Contents', 'Resources', 'app.asar')), await sha256(path.join(source, 'Contents', 'Resources', 'app.asar')));
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(path.join(environment.appDataDir, 'app.db'), { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT value FROM mac_update_acceptance').get().value, sentinel);
      const settings = Object.fromEntries(database.prepare('SELECT key, value FROM config_kv').all().map((row) => [row.key, JSON.parse(row.value)]));
      assert.equal(settings.theme, 'light');
      assert.equal(settings.language, 'en');
      assert.equal(settings.download_path, environment.downloadsDir);
    } finally { database.close(); }
    checks.configurationAndDatabasePreserved = true;
    assert.equal(fs.existsSync(plan.stagedApp), false, 'Old application backup should be removed only after health succeeds.');
    console.log(JSON.stringify({ failures: [], checks }, null, 2));
  } catch (error) {
    const diagnostics = { phase, message: String(error) };
    if (fs.existsSync(state)) diagnostics.markers = Object.fromEntries(fs.readdirSync(state).filter((name) => /^(ready|armed|result|health)-.*\.json$/.test(name)).map((name) => [name, readIfExists(path.join(state, name))]));
    console.error(JSON.stringify(diagnostics, null, 2));
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    // Scope cleanup to exact temporary paths; never signal an unrelated installed app.
    for (const owned of await ownedProcesses(executable, helperPrefix)) {
      try { process.kill(owned.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
    await waitFor(async () => (await ownedProcesses(executable, helperPrefix)).length === 0, 'isolated application exit', 15000).catch(() => {});
    const remaining = await ownedProcesses(executable, helperPrefix);
    if (remaining.length) {
      console.error(`[macos-update] Retained isolated files because test-owned processes remain: ${directory}`);
      process.exitCode = 1;
    } else cleanupE2eEnvironment(environment);
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
