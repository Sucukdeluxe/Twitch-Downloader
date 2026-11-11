// Reconstructed native release smoke: real packaged main/preload/renderer and DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEnvironment, launchElectron, assertIsolation, closeSession } = require('./release-test-harness.cjs');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const executable = path.join(root, 'release', 'win-unpacked', 'Twitch Downloader.exe');

async function verifyRuntime(session, expectedExecutable = executable) {
  const { app, page } = session;
  page.setDefaultTimeout(15000);
  const runtime = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    return { packaged: app.isPackaged, version: app.getVersion(), name: app.getName(),
      executable: process.execPath, appPath: app.getAppPath(), windows: BrowserWindow.getAllWindows().length,
      contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  assert.equal(runtime.packaged, true, 'Development Electron cannot verify the release');
  assert.equal(runtime.version, pkg.version, 'Runtime package version');
  assert.equal(fs.realpathSync(runtime.executable).toLowerCase(), fs.realpathSync(expectedExecutable).toLowerCase(), 'Must execute the selected real packaged binary');
  assert.ok(runtime.appPath.endsWith('app.asar'), 'Release must load its packaged archive');
  assert.equal(runtime.windows, 1, 'Expected one core application window');
  assert.equal(runtime.contextIsolation, true);
  assert.equal(runtime.nodeIntegration, false);
  await assertIsolation(session);
  assert.equal(await page.evaluate(() => window.api.getVersion()), pkg.version, 'Preload/main version IPC');
  assert.deepEqual(await page.evaluate(() => window.api.getQueue()), [], 'Fresh isolated queue');
  await page.waitForFunction(version => document.getElementById('versionText')?.textContent.includes(version), pkg.version);
  for (const tab of ['vods', 'clips', 'cutter', 'merge', 'stats', 'archive', 'settings']) {
    await page.locator(`.top-nav-item[data-tab="${tab}"]`).click();
    await page.locator(`#${tab}Tab`).waitFor({ state: 'visible' });
    assert.equal(await page.locator(`.top-nav-item[data-tab="${tab}"]`).getAttribute('aria-current'), 'page', `Active ${tab} navigation`);
  }
  assert.equal(await page.locator('#versionInfo').innerText(), `Version: v${pkg.version}`);
  assert.deepEqual(session.errors, [], 'Renderer uncaught errors');
}

async function cleanExit(app) {
  const child = app.process();
  assert.equal(child.exitCode, null, 'Packaged process must still be running before shutdown');
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged process failed to exit cleanly within 15 seconds')), 15000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const [, result] = await Promise.all([app.close(), exited]);
  assert.equal(result.code, 0, 'Native process exit code');
  assert.equal(result.signal, null, 'Native process must not need forced termination');
}

async function main() {
  assert.equal(process.platform, 'win32', 'Release package verification requires native Windows');
  assert.ok(fs.statSync(executable).isFile(), 'Build release/win-unpacked before package verification');
  const env = createEnvironment('packaged-release');
  const deadline = setTimeout(() => {
    console.error('Release package smoke exceeded its 170 second deadline');
    process.exitCode = 1;
    // The caller also enforces 180 seconds. Closing tracked resources prevents
    // an owned Electron process from surviving the bounded test on failure.
    void closeSession(env).catch(error => console.error(error.message));
  }, 170000);
  try {
    let session = await launchElectron(env, { packaged: true });
    await verifyRuntime(session);
    const saved = await session.page.evaluate(async () => {
      await window.api.saveConfig({ language: 'de', theme: 'light', player_seek_seconds: 30 });
      return window.api.getConfig();
    });
    assert.equal(saved.language, 'de');
    assert.equal(saved.theme, 'light');
    assert.equal(saved.player_seek_seconds, 30);
    await cleanExit(session.app);
    assert.ok(fs.statSync(path.join(env.appDataDir, 'app.db')).size > 0, 'Real persistent application database');
    session = await launchElectron(env, { packaged: true });
    await verifyRuntime(session);
    const restored = await session.page.evaluate(() => window.api.getConfig());
    assert.equal(restored.language, 'de', 'Language persisted across a real process restart');
    assert.equal(restored.theme, 'light', 'Theme persisted across a real process restart');
    assert.equal(restored.player_seek_seconds, 30, 'Playback preference persisted across a real process restart');
    assert.equal(restored.download_path, env.downloadsDir, 'Restart retains isolated storage');
    await cleanExit(session.app);
    console.log(`PASS packaged Windows ${pkg.version}: actual binary, runtime identity, core UI/IPC, DB restart persistence and clean exits`);
  } finally {
    clearTimeout(deadline);
    await closeSession(env);
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verifyRuntime, cleanExit };
