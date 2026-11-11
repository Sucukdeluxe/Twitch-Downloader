// Fault injection against the real Electron main process and private Mac tools.
// Only Twitch HTTP responses and its stream URL are redirected to a local fixture.
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
  const environment = createE2eEnvironment('macos-recovery');
  const failures = [];
  const checks = {};
  let app;
  let server;
  const check = async (name, operation) => {
    try { checks[name] = await operation(); console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  };
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
    const initial = await win.evaluate(() => window.api.runPreflight(true));
    assert(initial.checks.ffmpeg && initial.checks.streamlink);
    const toolRoot = path.join(environment.appDataDir, 'tools');
    const ffmpeg = path.join(toolRoot, 'ffmpeg', 'ffmpeg');
    const ffprobe = path.join(toolRoot, 'ffmpeg', 'ffprobe');
    await check('lost-executable-permission-auto-repair', async () => {
      fs.chmodSync(ffmpeg, 0o644);
      const result = await win.evaluate(() => window.api.runPreflight(true));
      assert.equal(result.checks.ffmpeg, true, 'Auto-fix left FFmpeg non-executable');
      await execute(ffmpeg, ['-version']);
      return true;
    });
    await win.evaluate(() => window.api.repairManagedTools());
    await check('damaged-python-module-auto-repair', async () => {
      const moduleFile = path.join(toolRoot, 'streamlink', 'python', 'lib', 'python3.13', 'site-packages', 'streamlink', '__main__.py');
      assert(fs.existsSync(moduleFile));
      fs.writeFileSync(moduleFile, 'raise RuntimeError("isolated audit corruption")\n');
      const result = await win.evaluate(() => window.api.runPreflight(true));
      assert.equal(result.checks.streamlink, true, 'Auto-fix left the private Python runtime broken');
      return true;
    });
    await win.evaluate(() => window.api.repairManagedTools());

    const media = path.join(environment.mediaDir, 'clip.mp4');
    const playlist = path.join(environment.mediaDir, 'index.m3u8');
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-t', '3', '-c:v', 'libx264', '-y', media]);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, media);
    await win.evaluate(async () => {
      const input = await window.api.selectVideoFile();
      window.showTab('cutter');
      await window.loadCutterFromPath(input);
      const before = cloneCutterState(cutterEditorState);
      cutterEditorState.trimStart = 0.5;
      commitCutterChange(before);
      renderCutterEditor();
      document.activeElement?.blur();
    });
    await check('native-menu-undo-redo-and-text-focus', async () => {
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('editor-undo').click());
      await win.waitForFunction(() => cutterEditorState.trimStart === 0);
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('editor-redo').click());
      await win.waitForFunction(() => cutterEditorState.trimStart === 0.5);
      const input = win.locator('#startTime');
      const original = await input.inputValue();
      await input.focus();
      await input.press('End');
      await input.press('Backspace');
      assert.notEqual(await input.inputValue(), original);
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('editor-undo').click());
      await win.waitForFunction((value) => document.getElementById('startTime').value === value, original);
      assert.equal(await win.evaluate(() => cutterEditorState.trimStart), 0.5);
      return true;
    });
    await check('videotoolbox-project-survives-immediate-window-close', async () => {
      await win.evaluate(() => {
        const before = cloneCutterState(cutterEditorState);
        cutterEditorState.trimStart = 0.24;
        cutterExportEncoder = 'h264_videotoolbox';
        commitCutterChange(before);
      });
      const closed = win.waitForEvent('close');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await closed;
      const reopened = app.waitForEvent('window');
      await app.evaluate(({ app: nativeApp }) => nativeApp.emit('activate'));
      win = await reopened;
      await win.waitForLoadState('domcontentloaded');
      const recovered = await win.evaluate(async () => {
        const input = await window.api.selectVideoFile();
        return window.api.getCutterProjectRecovery(input.token);
      });
      assert.equal(recovered?.trimStart, 0.24);
      assert.equal(recovered?.encoder, 'h264_videotoolbox');
      return true;
    });
    await check('failed-autosave-keeps-window-open-and-can-be-retried', async () => {
      await win.evaluate(async () => {
        const input = await window.api.selectVideoFile();
        await window.loadCutterFromPath(input);
        await window.recoverCutterProject();
      });
      const blockedTemporaryFile = path.join(environment.appDataDir, 'cutter-projects.json.tmp');
      fs.mkdirSync(blockedTemporaryFile);
      try {
        await win.evaluate(() => {
          const before = cloneCutterState(cutterEditorState);
          cutterEditorState.trimStart = 0.4;
          commitCutterChange(before);
        });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await win.waitForFunction(() => document.body.textContent.includes('Projekt konnte nicht gespeichert werden'));
        assert.equal(win.isClosed(), false);
        fs.rmdirSync(blockedTemporaryFile);
        const closed = win.waitForEvent('close');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await closed;
        const reopened = app.waitForEvent('window');
        await app.evaluate(({ app: nativeApp }) => nativeApp.emit('activate'));
        win = await reopened;
        await win.waitForLoadState('domcontentloaded');
        const recovered = await win.evaluate(async () => {
          const input = await window.api.selectVideoFile();
          return window.api.getCutterProjectRecovery(input.token);
        });
        assert.equal(recovered.trimStart, 0.4);
      } finally {
        if (fs.existsSync(blockedTemporaryFile)) fs.rmdirSync(blockedTemporaryFile);
      }
      return true;
    });
    await execute(ffmpeg, ['-v', 'error', '-i', media, '-c', 'copy', '-hls_time', '1', '-hls_list_size', '0', '-y', playlist]);
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:a', 'aac', '-hls_time', '1', '-hls_list_size', '0', '-y', path.join(environment.mediaDir, 'audio.m3u8')]);
    fs.writeFileSync(path.join(environment.mediaDir, 'muxed.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x240,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="audio"\nindex.m3u8\n');
    fs.writeFileSync(path.join(environment.mediaDir, 'invalid.ts'), Buffer.alloc(32768, 42));
    fs.writeFileSync(path.join(environment.mediaDir, 'invalid.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:3,\ninvalid.ts\n#EXT-X-ENDLIST\n');
    server = http.createServer((request, response) => {
      const file = path.join(environment.mediaDir, path.basename(new URL(request.url, 'http://localhost').pathname));
      if (!fs.existsSync(file)) { response.writeHead(404).end(); return; }
      fs.createReadStream(file).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await app.evaluate(({ app: nativeApp, safeStorage }, port) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      const axios = appRequire('axios').default;
      const childProcess = appRequire('node:child_process');
      const original = { get: axios.get, post: axios.post, spawn: childProcess.spawn, encrypt: safeStorage.encryptString, available: safeStorage.isEncryptionAvailable };
      // Credentials are dummy test data; avoid touching the real login keychain.
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (text) => Buffer.from(text);
      axios.post = async (url, ...args) => String(url).includes('/oauth2/token')
        ? { data: { access_token: 'audit-fixture-token' } } : original.post.call(axios, url, ...args);
      axios.get = async (url, ...args) => String(url).includes('/helix/clips')
        ? { data: { data: [{ broadcaster_name: 'audit', title: 'Local fixture' }] } } : original.get.call(axios, url, ...args);
      childProcess.spawn = (command, args, spawnOptions) => {
        if (args.some((arg) => String(arg).startsWith('https://clips.twitch.tv/'))) {
          args = args.map((arg) => String(arg).startsWith('https://clips.twitch.tv/') ? `hls://http://localhost:${port}/${String(arg).endsWith('AuditInvalid') ? 'invalid' : String(arg).endsWith('AuditMuxed') ? 'muxed' : 'index'}.m3u8` : arg);
          spawnOptions = { ...spawnOptions, env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' } };
        }
        return original.spawn(command, args, spawnOptions);
      };
      globalThis.__restoreAudit = () => {
        axios.get = original.get; axios.post = original.post; childProcess.spawn = original.spawn;
        safeStorage.encryptString = original.encrypt; safeStorage.isEncryptionAvailable = original.available;
      };
    }, server.address().port);
    await win.evaluate(async () => {
      await window.api.saveConfig({ ...(await window.api.getConfig()), client_id: 'audit-fixture-client' });
      await window.api.setClientSecret('audit-fixture-secret');
      await window.api.resetManagedTools();
    });
    await check('clip-as-first-download', async () => {
      assert.equal(fs.existsSync(ffmpeg), false);
      const result = await win.evaluate(() => window.api.downloadClip('https://clips.twitch.tv/AuditFixture'));
      assert.equal(result.success, true, JSON.stringify(result));
      assert(fs.existsSync(ffprobe), 'First clip must install its integrity checker');
      const probe = await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', result.filename]);
      assert(Number(probe.stdout.trim()) >= 2.9);
      return { seconds: Number(probe.stdout.trim()) };
    });
    // The negative case must have working tools even when the first-use test failed.
    await win.evaluate(() => window.api.runPreflight(true));
    await check('separate-audio-video-streams-use-private-ffmpeg', async () => {
      const result = await win.evaluate(() => window.api.downloadClip('https://clips.twitch.tv/AuditMuxed'));
      assert.equal(result.success, true, JSON.stringify(result));
      const probe = await execute(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', result.filename]);
      assert.deepEqual(JSON.parse(probe.stdout).streams.map((stream) => stream.codec_type).sort(), ['audio', 'video']);
      return true;
    });
    await check('invalid-video-is-not-published', async () => {
      const result = await win.evaluate(() => window.api.downloadClip('https://clips.twitch.tv/AuditInvalid'));
      assert.equal(result.success, false, 'Streamlink exit 0 published bytes that FFprobe cannot parse');
      const files = fs.readdirSync(path.join(environment.downloadsDir, 'Clips', 'audit'));
      assert(!files.some((file) => file.includes('.part')));
      return true;
    });
    await win.evaluate(() => window.api.clearClientSecret());
    await app.evaluate(() => globalThis.__restoreAudit());

    await check('reopening-window-does-not-start-queue', async () => {
      await win.evaluate(async () => {
        await window.api.saveConfig({ ...(await window.api.getConfig()), auto_resume_queue_on_startup: true, persist_queue_on_restart: true, theme: 'light' });
        await window.api.addToQueue({ url: 'https://www.twitch.tv/videos/123456', title: 'Do not auto-start on reopen', date: '2026-11-11', streamer: 'audit', duration_str: '3s' });
      });
      // Count scheduling itself rather than relying on a network request failing.
      await app.evaluate(({ app: nativeApp }) => {
        const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
        const { QueueRunLifecycle } = appRequire('./dist/main/queue/process-registry.js');
        const original = QueueRunLifecycle.prototype.schedule;
        globalThis.__unexpectedSchedules = 0;
        QueueRunLifecycle.prototype.schedule = function () { globalThis.__unexpectedSchedules += 1; return false; };
        globalThis.__restoreSchedule = () => { QueueRunLifecycle.prototype.schedule = original; };
      });
      const closed = win.waitForEvent('close');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await closed;
      const reopened = app.waitForEvent('window');
      await app.evaluate(({ app: nativeApp }) => nativeApp.emit('activate'));
      win = await reopened;
      await win.waitForLoadState('domcontentloaded');
      await new Promise((resolve) => setTimeout(resolve, 5600));
      const schedules = await app.evaluate(() => globalThis.__unexpectedSchedules);
      await app.evaluate(() => globalThis.__restoreSchedule());
      assert.equal(schedules, 0, 'Reopening a Mac window scheduled a new queue run');
      assert.equal((await win.evaluate(() => window.api.getQueue()))[0].status, 'pending');
      return true;
    });
    // Prepare a persisted encrypted secret, then simulate macOS refusing to decrypt
    // it on the next startup. Config/queue must remain usable and stored ciphertext intact.
    await win.evaluate(async () => {
      await window.api.saveConfig({ ...(await window.api.getConfig()), auto_resume_queue_on_startup: false });
    });
    await app.evaluate(({ app: nativeApp }) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      appRequire('./dist/main.js').getAppDb().run("INSERT INTO app_secrets(key,version,encrypted_value,updated_at) VALUES ('twitch_client_secret',1,'not-decryptable-fixture',0)");
    });
    await app.close(); app = null;
    app = await electron.launch(options);
    win = await app.firstWindow();
    await check('keychain-denial-preserves-config-and-queue', async () => {
      const config = await win.evaluate(() => window.api.getConfig());
      assert.equal(config.theme, 'light', 'Failed secret decryption reset ordinary preferences');
      assert.equal(config.download_path, environment.downloadsDir);
      assert.equal((await win.evaluate(() => window.api.getQueue())).length, 1, 'Failed secret decryption discarded the queue');
      const stored = await app.evaluate(({ app: nativeApp }) => {
        const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
        return appRequire('./dist/main.js').getAppDb()?.get("SELECT encrypted_value FROM app_secrets WHERE key='twitch_client_secret'");
      });
      assert.equal(stored.encrypted_value, 'not-decryptable-fixture');
      await win.evaluate(async () => { await window.api.saveConfig({ ...(await window.api.getConfig()), theme: 'dark' }); });
      assert.equal((await win.evaluate(() => window.api.getConfig())).theme, 'dark');
      return true;
    });
    await app.close(); app = null;
    console.log(JSON.stringify({ failures, checks }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    if (app) await app.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanupE2eEnvironment(environment);
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
