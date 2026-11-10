// Exercise the real app and bundled tools with no Homebrew/Python in PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron } = require('playwright');
const { createE2eEnvironment, getElectronLaunchOptions, verifyE2eIsolation, cleanupE2eEnvironment } = require('./e2e-test-environment');
const execute = promisify(execFile);

async function run() {
  assert.equal(process.platform, 'darwin');
  const environment = createE2eEnvironment('macos', { language: 'en' });
  let app;
  let server;
  const checks = {};
  try {
    const options = getElectronLaunchOptions(environment);
    options.env.PATH = '/usr/bin:/bin';
    if (process.env.PACKAGED_APP_PATH) {
      options.executablePath = path.resolve(process.env.PACKAGED_APP_PATH);
      options.args = options.args.filter((arg) => arg !== '.');
    }
    app = await electron.launch(options);
    let win = await app.firstWindow();
    await verifyE2eIsolation(app, win, environment);
    checks.initialTools = await win.evaluate(() => window.api.getManagedToolStatus());
    assert.equal(checks.initialTools.streamlink.state, 'missing');
    checks.preflight = await win.evaluate(() => window.api.runPreflight(true));
    for (const name of ['streamlink', 'ffmpeg', 'ffprobe', 'downloadPathWritable']) {
      assert.equal(checks.preflight.checks[name], true, `${name} unavailable in clean macOS install`);
    }
    checks.installedTools = await win.evaluate(() => window.api.getManagedToolStatus());
    assert.equal(checks.installedTools.streamlink.verified, true);
    assert.equal(checks.installedTools.ffmpeg.verified, true);
    checks.desktop = await app.evaluate(({ app: nativeApp, Menu }) => ({
      name: nativeApp.getName(),
      menuRoles: Menu.getApplicationMenu().items.map((item) => item.role),
      dataDirectory: process.env.TWITCH_VOD_MANAGER_DATA_DIR,
      packaged: nativeApp.isPackaged,
    }));
    assert(checks.desktop.menuRoles.includes('editmenu'));
    assert(checks.desktop.menuRoles.includes('appmenu'));
    assert(fs.existsSync(path.join(environment.appDataDir, 'app.db')), 'SQLite store was not created');

    const toolRoot = path.join(environment.appDataDir, 'tools');
    const ffmpeg = path.join(toolRoot, 'ffmpeg', 'ffmpeg');
    const ffprobe = path.join(toolRoot, 'ffmpeg', 'ffprobe');
    const streamlink = path.join(toolRoot, 'streamlink', 'streamlink');
    const cleanEnv = { ...options.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
    const media = path.join(environment.mediaDir, 'Mac Test ä $ literal.mp4');
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', media], { env: cleanEnv });
    const playlist = path.join(environment.mediaDir, 'index.m3u8');
    await execute(ffmpeg, ['-v', 'error', '-i', media, '-c', 'copy', '-hls_time', '1', '-hls_list_size', '0', '-y', playlist], { env: cleanEnv });
    server = http.createServer((request, response) => {
      const file = path.join(environment.mediaDir, path.basename(new URL(request.url, 'http://localhost').pathname));
      if (!fs.existsSync(file)) { response.writeHead(404).end(); return; }
      fs.createReadStream(file).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const downloaded = path.join(environment.mediaDir, 'downloaded.ts');
    await execute(streamlink, [`hls://http://127.0.0.1:${server.address().port}/index.m3u8`, 'best', '--output', downloaded, '--force'], { env: cleanEnv, timeout: 30000 });
    const probe = await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', downloaded], { env: cleanEnv });
    checks.hlsDownloadSeconds = Number(probe.stdout.trim());
    assert(checks.hlsDownloadSeconds >= 2.9);

    // A real native file selection capability, then the unchanged cutter IPC.
    const cut = path.join(environment.mediaDir, 'cut.mp4');
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.media] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.cut });
    }, { media, cut });
    checks.cut = await win.evaluate(async () => {
      const input = await window.api.selectVideoFile();
      return window.api.cutVideo(input.token, 0.5, 2);
    });
    assert.equal(checks.cut.success, true);
    assert(fs.statSync(path.join(environment.mediaDir, checks.cut.outputName)).size > 0);

    // Verify repair replaces corrupted executables using only the offline bundle.
    fs.appendFileSync(ffmpeg, 'corruption');
    checks.corruption = await win.evaluate(() => window.api.getManagedToolStatus());
    assert.equal(checks.corruption.ffmpeg.verified, false);
    checks.repair = await win.evaluate(() => window.api.repairManagedTools());
    assert.equal(checks.repair.success, true);
    await execute(ffmpeg, ['-version'], { env: cleanEnv });
    const reset = await win.evaluate(() => window.api.resetManagedTools());
    assert.equal(reset.success, true);
    assert.equal(reset.statuses.ffmpeg.state, 'missing');
    checks.reinstall = await win.evaluate(() => window.api.runPreflight(true));
    assert.equal(checks.reinstall.checks.ffmpeg, true);
    assert.equal(checks.reinstall.checks.streamlink, true);

    // Closing a Mac window must preserve the background app and persisted settings.
    await win.evaluate(async () => {
      const config = await window.api.getConfig();
      await window.api.saveConfig({ ...config, language: 'en', theme: 'light' });
    });
    const closed = win.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    const reopened = app.waitForEvent('window');
    await app.evaluate(({ app: nativeApp }) => nativeApp.emit('activate'));
    win = await reopened;
    await win.waitForLoadState('domcontentloaded');
    const config = await win.evaluate(() => window.api.getConfig());
    assert.equal(config.theme, 'light');
    assert.equal(config.language, 'en');
    checks.reopen = true;
    await app.close();
    app = null;
    console.log(JSON.stringify({ failures: [], checks }, null, 2));
  } finally {
    if (app) await app.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanupE2eEnvironment(environment);
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
