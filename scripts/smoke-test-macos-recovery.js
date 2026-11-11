// Fault injection against the real Electron main process and private Mac tools.
// Only Twitch HTTP responses and its stream URL are redirected to a local fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron } = require('playwright');
const { createE2eEnvironment, getElectronLaunchOptions, verifyE2eIsolation, cleanupE2eEnvironment, closeElectronWindow, activateElectronWindow } = require('./e2e-test-environment');
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
    await check('encrypted-test-secret-without-keychain-access', async () => {
      await win.evaluate(() => window.api.setClientSecret('synthetic-audit-secret'));
      const encrypted = await app.evaluate(({ app: nativeApp }) => {
        const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
        const row = appRequire('./dist/main.js').getAppDb().get("SELECT encrypted_value FROM app_secrets WHERE key='twitch_client_secret'");
        return row?.encrypted_value.startsWith('e2e-v1:') && !row.encrypted_value.includes('synthetic-audit-secret');
      });
      assert.equal(encrypted, true);
      await win.evaluate(() => window.api.clearClientSecret());
      return true;
    });
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
    await check('same-size-ffmpeg-change-invalidates-verification', async () => {
      const stat = fs.statSync(ffmpeg);
      const descriptor = fs.openSync(ffmpeg, 'r+');
      const byte = Buffer.alloc(1);
      try {
        fs.readSync(descriptor, byte, 0, 1, stat.size - 1);
        byte[0] ^= 1;
        fs.writeSync(descriptor, byte, 0, 1, stat.size - 1);
      } finally { fs.closeSync(descriptor); }
      fs.utimesSync(ffmpeg, stat.atime, stat.mtime);
      const repaired = await app.evaluate(({ app: nativeApp }) => {
        const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
        return appRequire('./dist/tools.js').ensureFfmpegInstalled();
      });
      assert.equal(repaired, true);
      const restored = fs.openSync(ffmpeg, 'r');
      const actual = Buffer.alloc(1);
      try { fs.readSync(restored, actual, 0, 1, stat.size - 1); }
      finally { fs.closeSync(restored); }
      assert.equal(actual[0], byte[0] ^ 1, 'A changed binary reused stale verification');
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
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-y', media]);
    assert(fs.statSync(media).size > 256 * 1024, 'Fixture must exceed the VOD minimum file size');
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
      await closeElectronWindow(app, win);
      win = await activateElectronWindow(app);
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
      });
      await win.waitForFunction(() => Boolean(cutterPendingProject) && cutterRecoveryDecisionPending);
      await win.evaluate(() => window.recoverCutterProject());
      await win.waitForFunction(() => !cutterRecoveryDecisionPending);
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
        await closeElectronWindow(app, win);
        win = await activateElectronWindow(app);
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
    await app.evaluate(({ app: nativeApp }, port) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      const axios = appRequire('axios').default;
      const childProcess = appRequire('node:child_process');
      const original = { get: axios.get, post: axios.post, spawn: childProcess.spawn };
      axios.post = async (url, ...args) => String(url).includes('/oauth2/token')
        ? { data: { access_token: 'audit-fixture-token' } } : original.post.call(axios, url, ...args);
      axios.get = async (url, ...args) => String(url).includes('/helix/clips')
        ? { data: { data: [{ broadcaster_name: 'audit', title: 'Local fixture' }] } } : original.get.call(axios, url, ...args);
      childProcess.spawn = (command, args, spawnOptions) => {
        const isFixture = (arg) => String(arg).startsWith('https://clips.twitch.tv/') || arg === 'https://www.twitch.tv/videos/2222222';
        if (args.some(isFixture)) {
          args = args.map((arg) => isFixture(arg) ? `hls://http://localhost:${port}/${String(arg).endsWith('AuditInvalid') ? 'invalid' : String(arg).endsWith('AuditMuxed') ? 'muxed' : 'index'}.m3u8` : arg);
          spawnOptions = { ...spawnOptions, env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' } };
        }
        return original.spawn(command, args, spawnOptions);
      };
      globalThis.__restoreAudit = () => {
        axios.get = original.get; axios.post = original.post; childProcess.spawn = original.spawn;
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
    await check('vod-excerpt-as-first-download', async () => {
      await win.evaluate(async () => {
        await window.api.resetManagedTools();
        await window.api.addToQueue({ url: 'https://www.twitch.tv/videos/2222222', title: 'First VOD excerpt', date: '2026-11-11', streamer: 'audit', duration_str: '3s', customClip: { startSec: 0, durationSec: 3, startPart: 1, filenameFormat: 'simple' } });
      });
      assert.equal(fs.existsSync(ffprobe), false);
      await win.evaluate(() => window.api.startDownload());
      const deadline = Date.now() + 90000;
      let item;
      do {
        item = (await win.evaluate(() => window.api.getQueue()))[0];
        if (item && ['completed', 'error'].includes(item.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.equal(item?.status, 'completed', JSON.stringify(item));
      assert(fs.existsSync(ffprobe));
      assert(item.outputFiles?.length > 0);
      const probe = await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', item.outputFiles[0]]);
      assert(Number(probe.stdout.trim()) >= 2.9);
      await win.evaluate((id) => window.api.removeFromQueue(id), item.id);
      return true;
    });
    await win.evaluate(async () => {
      for (const item of await window.api.getQueue()) await window.api.removeFromQueue(item.id);
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
      await closeElectronWindow(app, win);
      win = await activateElectronWindow(app);
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
    await check('secret-read-failure-preserves-config-and-queue', async () => {
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
    const encryption = await app.evaluate(({ app: nativeApp }) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      return appRequire('./dist/main/infra/secure-storage.js').getSecureStorageDiagnostics();
    });
    assert.equal(encryption.backend, 'isolated-test');
    assert.equal(encryption.blockedNativeCalls, 0, 'App attempted to bypass test encryption');
    checks.nativeKeychainCalls = 0;
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
