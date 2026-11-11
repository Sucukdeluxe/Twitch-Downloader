// Exercise the real app and bundled tools with no Homebrew/Python in PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron } = require('playwright');
const { createE2eEnvironment, getElectronLaunchOptions, verifyE2eIsolation, cleanupE2eEnvironment, closeElectronWindow, activateElectronWindow } = require('./e2e-test-environment');
const execute = promisify(execFile);

function offsetFragmentTimestamps(file) {
  // The fixture has one video track with a 1000 Hz clock. Reproduce a Twitch
  // excerpt that keeps its original VOD timestamps instead of starting at zero.
  const data = fs.readFileSync(file);
  let fragments = 0;
  const walk = (start, end) => {
    for (let at = start; at + 8 <= end;) {
      const size = data.readUInt32BE(at);
      const type = data.toString('ascii', at + 4, at + 8);
      assert(size >= 8 && at + size <= end);
      if (type === 'moof' || type === 'traf') walk(at + 8, at + size);
      if (type === 'tfdt') {
        if (data[at + 8] === 1) data.writeBigUInt64BE(data.readBigUInt64BE(at + 12) + 120000n, at + 12);
        else data.writeUInt32BE(data.readUInt32BE(at + 12) + 120000, at + 12);
        fragments += 1;
      }
      at += size;
    }
  };
  walk(0, data.length);
  assert(fragments > 0);
  fs.writeFileSync(file, data);
}

async function run() {
  assert.equal(process.platform, 'darwin');
  const environment = createE2eEnvironment('macos', { language: 'en' });
  let app;
  let server;
  const checks = {};
  try {
    const options = getElectronLaunchOptions(environment);
    const hostTools = path.join(environment.rootDir, 'host-tools');
    const hostToolCalls = path.join(environment.rootDir, 'host-tool-calls');
    fs.mkdirSync(hostTools);
    for (const name of ['python3', 'python', 'streamlink', 'ffmpeg', 'ffprobe']) {
      fs.writeFileSync(path.join(hostTools, name), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$MAC_HOST_TOOL_CALLS"\nexit 1\n', { mode: 0o755 });
    }
    options.env.PATH = `${hostTools}:/usr/bin:/bin`;
    options.env.MAC_HOST_TOOL_CALLS = hostToolCalls;
    if (process.env.PACKAGED_APP_PATH) {
      options.executablePath = path.resolve(process.env.PACKAGED_APP_PATH);
      options.args = options.args.filter((arg) => arg !== '.');
    }
    console.log('[macos] Launching isolated app');
    app = await electron.launch(options);
    let win = await app.firstWindow();
    await verifyE2eIsolation(app, win, environment);
    checks.initialTools = await win.evaluate(() => window.api.getManagedToolStatus());
    assert.equal(checks.initialTools.streamlink.state, 'missing');
    console.log('[macos] Installing private runtime');
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
    console.log('[macos] Downloading local HLS fixture');

    const toolRoot = path.join(environment.appDataDir, 'tools');
    const ffmpeg = path.join(toolRoot, 'ffmpeg', 'ffmpeg');
    const ffprobe = path.join(toolRoot, 'ffmpeg', 'ffprobe');
    const streamlink = path.join(toolRoot, 'streamlink', 'streamlink');
    const cleanEnv = { ...options.env, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' };
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
    await execute(streamlink, [`hls://http://localhost:${server.address().port}/index.m3u8`, 'best', '--output', downloaded, '--force'], { env: cleanEnv, timeout: 30000 });
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
    console.log('[macos] Checking timestamp normalization and export');

    const fragment = path.join(environment.mediaDir, 'Twitch excerpt.mp4');
    const fragmentExport = path.join(environment.mediaDir, 'Excerpt edit.mp4');
    await execute(ffmpeg, ['-v', 'error', '-i', media, '-an', '-c:v', 'copy', '-video_track_timescale', '1000', '-movflags', '+empty_moov+frag_keyframe+default_base_moof', '-y', fragment], { env: cleanEnv });
    offsetFragmentTimestamps(fragment);
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.fragment] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.fragmentExport });
    }, { fragment, fragmentExport });
    checks.fragment = await win.evaluate(async () => {
      const input = await window.api.selectVideoFile();
      const source = await window.api.getVideoInfo(input.token);
      window.showTab('cutter');
      await window.loadCutterFromPath(input);
      return { sourceDuration: source.duration, editorDuration: cutterEditorState.duration, token: input.token };
    });
    assert(checks.fragment.sourceDuration > 120, 'Fixture must retain its VOD timestamps');
    assert(checks.fragment.editorDuration >= 2.9 && checks.fragment.editorDuration < 3.2, 'Cutter must use the excerpt duration');
    await win.waitForFunction(() => document.getElementById('cutterVideo').readyState >= 2);
    checks.fragment.previewStart = await win.evaluate(() => document.getElementById('cutterVideo').currentTime);
    assert(checks.fragment.previewStart < 0.2, 'Cutter preview must start at zero');
    const fragmentEdit = await win.evaluate((inputCapability) => window.api.exportVideoEdit({
      inputCapability, trimStart: 0.5, trimEnd: 2, cuts: [], profile: 'balanced', encoder: 'software', audioStreamIndex: 0,
    }), checks.fragment.token);
    assert.equal(fragmentEdit.success, true);
    const exportedProbe = await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fragmentExport], { env: cleanEnv });
    checks.fragment.exportDuration = Number(exportedProbe.stdout.trim());
    assert(Math.abs(checks.fragment.exportDuration - 1.5) < 0.12);
    delete checks.fragment.token;
    console.log('[macos] Repairing and reinstalling private runtime');

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
    console.log('[macos] Checking empty update feed and window lifecycle');

    // A public repository containing only previews has no /latest release.
    // That must mean "no stable update", not a startup error or a broken feed.
    await app.evaluate(({ app: nativeApp }) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      const axios = appRequire('axios').default;
      const updater = appRequire('electron-updater').autoUpdater;
      const originalGet = axios.get;
      const originalCheck = updater.checkForUpdates;
      globalThis.__emptyReleaseFallbackCalls = 0;
      axios.get = async (url, ...args) => {
        if (String(url).endsWith('/releases/latest')) {
          throw Object.assign(new Error('No stable release'), { isAxiosError: true, response: { status: 404 } });
        }
        return originalGet.call(axios, url, ...args);
      };
      updater.checkForUpdates = async () => { globalThis.__emptyReleaseFallbackCalls += 1; throw new Error('Unexpected empty feed lookup'); };
      globalThis.__restoreReleaseCheck = () => { axios.get = originalGet; updater.checkForUpdates = originalCheck; };
    });
    await win.evaluate(() => {
      window.__emptyReleaseEvents = { unavailable: 0, errors: 0 };
      window.api.onUpdateNotAvailable(() => { window.__emptyReleaseEvents.unavailable += 1; });
      window.api.onUpdateError(() => { window.__emptyReleaseEvents.errors += 1; });
    });
    await win.evaluate(() => window.api.checkUpdate());
    await win.waitForFunction(() => window.__emptyReleaseEvents.unavailable > 0);
    checks.emptyRelease = await win.evaluate(() => window.__emptyReleaseEvents);
    assert.equal(checks.emptyRelease.errors, 0);
    assert.equal(await app.evaluate(() => globalThis.__emptyReleaseFallbackCalls), 0);
    await app.evaluate(() => { globalThis.__restoreReleaseCheck(); delete globalThis.__restoreReleaseCheck; });

    // Closing a Mac window must preserve the background app and persisted settings.
    await win.evaluate(async () => {
      const config = await window.api.getConfig();
      await window.api.saveConfig({ ...config, language: 'en', theme: 'light' });
    });
    await closeElectronWindow(app, win);
    win = await activateElectronWindow(app);
    const config = await win.evaluate(() => window.api.getConfig());
    assert.equal(config.theme, 'light');
    assert.equal(config.language, 'en');
    checks.reopen = true;
    assert.equal(fs.existsSync(hostToolCalls), false, 'The Mac app probed a system Python or external media tool');
    checks.privateRuntimeOnly = true;
    console.log('[macos] Closing isolated app');
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
