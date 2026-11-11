// Real Mac renderer -> queue -> bundled FFmpeg -> MP4. Only Twitch discovery
// and preview media are replaced; downloads use a local HLS server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron } = require('playwright');
const { createE2eEnvironment, getElectronLaunchOptions, verifyE2eIsolation, cleanupE2eEnvironment } = require('./e2e-test-environment');
const execute = promisify(execFile);

async function waitFor(predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Trim workflow did not finish in time');
}

async function run() {
  assert.equal(process.platform, 'darwin');
  const environment = createE2eEnvironment('mac-trim-download', { language: 'en', performance_mode: 'balanced' });
  let app, server;
  const pageErrors = [];
  try {
    const launch = getElectronLaunchOptions(environment);
    launch.env.PATH = '/usr/bin:/bin';
    // Only the fixture server bypasses the offline proxy for child FFmpeg.
    launch.env.NO_PROXY = launch.env.no_proxy = '127.0.0.1';
    if (process.env.PACKAGED_APP_PATH) {
      launch.executablePath = path.resolve(process.env.PACKAGED_APP_PATH);
      launch.args = launch.args.filter(arg => arg !== '.');
    }
    app = await electron.launch(launch);
    const win = await app.firstWindow();
    win.on('pageerror', error => pageErrors.push(error.message));
    await verifyE2eIsolation(app, win, environment);
    const preflight = await win.evaluate(() => window.api.runPreflight(true));
    for (const tool of ['ffmpeg', 'ffprobe', 'streamlink']) assert(preflight.checks[tool], `${tool} must work without host tools`);
    const ffmpeg = path.join(environment.appDataDir, 'tools/ffmpeg/ffmpeg');
    const ffprobe = path.join(environment.appDataDir, 'tools/ffmpeg/ffprobe');
    const source = path.join(environment.mediaDir, 'Source with spaces ä.mp4');
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '18', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-crf', '18', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-y', source]);
    const playlist = path.join(environment.mediaDir, 'index.m3u8');
    await execute(ffmpeg, ['-v', 'error', '-i', source, '-c', 'copy', '-hls_time', '2', '-hls_list_size', '0', '-y', playlist]);
    server = http.createServer((request, response) => {
      const file = path.join(environment.mediaDir, path.basename(new URL(request.url, 'http://localhost').pathname));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Length': fs.statSync(file).size,
        'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
      fs.createReadStream(file).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await app.evaluate(({ app: nativeApp, ipcMain }, fixture) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      const mediaUrl = 'https://fixture.ttvnw.net/index.m3u8';
      // Ordinary Twitch renditions used to bypass FFmpeg seeking and use
      // Streamlink's segment-rounded offsets instead.
      appRequire('./dist/main/domain/vod-quality.js').resolveVodQualitySource = async () => null;
      appRequire('./dist/main/domain/vod-quality.js').resolveVodPlaybackSource = async () => mediaUrl;
      appRequire('./dist/main/domain/vod-live-snapshot.js').fetchHlsMediaPlaylist = async () => ({ ended: true });
      const childProcess = appRequire('node:child_process'), spawn = childProcess.spawn;
      childProcess.spawn = (command, args, options) => spawn(command, args.map(arg => arg === mediaUrl ? fixture.playlist : arg), options);
      const handle = (name, callback) => { ipcMain.removeHandler(name); ipcMain.handle(name, callback); };
      handle('open-vod-playback', (_event, request) => ({ id: request.id, sourceUrl: fixture.preview, quality: 'source' }));
      handle('close-vod-playback', () => {});
      handle('get-vod-timeline', () => null);
      let qualityAttempts = 0;
      handle('get-vod-qualities', () => ++qualityAttempts === 1 ? null : [{ id: 'source', label: 'Source · 360p · 25 fps · H.264' }]);
    }, { preview: pathToFileURL(source).href, playlist: `http://127.0.0.1:${server.address().port}/index.m3u8` });
    await win.waitForFunction(() => typeof window.openClipDialog === 'function');
    await win.evaluate(() => window.openClipDialog('https://www.twitch.tv/videos/2222222', 'Trim workflow fixture', '2026-11-11T12:00:00Z', 'fixture', '18s'));
    await win.waitForFunction(() => document.querySelector('#clipPlayer video')?.readyState >= 2);
    await win.evaluate(() => document.querySelector('#clipPlayer video').pause());
    assert.equal(await win.locator('#clipDetailsToggle').getAttribute('aria-expanded'), 'false');
    for (const [seconds, text, button] of [[4, '00:00:04', '#clipMarkStart button'], [10, '00:00:10', '#clipMarkEnd button']]) {
      await win.getByRole('button', { name: 'Exact playback time', exact: true }).click();
      await win.locator('.player-exact-time input').fill(text);
      await win.locator('.player-exact-time input').press('Enter');
      await win.waitForFunction(time => Math.abs(document.querySelector('#clipPlayer video').currentTime - time) < .1, seconds);
      await win.locator(button).click();
    }
    await win.locator('.vod-selection .vod-range-handle.is-start').press('ArrowRight');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:05');
    await win.locator('#clipStartEarlier').click();
    assert.equal(await win.locator('#clipDurationTime').textContent(), '00:00:06');
    await win.locator('#clipEndTime').fill('00:00:03');
    assert(await win.locator('#clipDialogConfirmBtn').isDisabled(), 'Reversed ranges must not be queued');
    await win.locator('#clipEndTime').fill('00:00:10');
    await win.locator('#clipDetailsToggle').click();
    await win.locator('#clipFilenameOptions summary').click();
    await win.locator('#clipStartPart').fill('7');
    await win.locator('input[name="filenameFormat"][value="template"]').check();
    await win.locator('#clipFilenameTemplate').fill('Trim Ä Test-{part}.mp4');
    await win.locator('#clipDetailsToggle').click({ timeout: 5000 });
    await win.locator('#clipDialogConfirmBtn').click();
    const quality = win.locator('.vod-quality-dialog');
    await quality.getByRole('button', { name: 'Retry', exact: true }).click();
    await quality.locator('input[value="source"]').check();
    await quality.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await win.evaluate(() => window.api.getQueue())).length, 0, 'Cancel must not add a job');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:04');
    await win.locator('#clipDialogConfirmBtn').click();
    await quality.locator('input[value="source"]').check();
    await quality.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await waitFor(async () => (await win.evaluate(() => window.api.getQueue())).length === 1);
    const queued = (await win.evaluate(() => window.api.getQueue()))[0];
    assert.equal(queued.customClip.startSec, 4);
    assert.equal(queued.customClip.durationSec, 6);
    assert.equal(queued.customClip.startPart, 7);
    assert.equal(queued.customClip.filenameTemplate, 'Trim Ä Test-{part}.mp4');
    assert.equal(queued.quality, 'source');
    assert.equal(queued.status, 'pending');
    await win.locator('#btnStart').click();
    let completed;
    await waitFor(async () => {
      completed = (await win.evaluate(() => window.api.getQueue()))[0];
      assert.notEqual(completed.status, 'error', completed.last_error);
      return completed.status === 'completed';
    });
    assert.equal(completed.outputFiles.length, 1);
    const output = completed.outputFiles[0];
    assert.equal(path.basename(output), 'Trim Ä Test-7.mp4');
    assert(output.startsWith(environment.downloadsDir + path.sep));
    const probe = JSON.parse((await execute(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])).stdout);
    assert.deepEqual(probe.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
    assert(Number(probe.format.duration) >= 6 && Number(probe.format.duration) < 8.2);
    await execute(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
    const hashes = async file => (await execute(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { maxBuffer: 1024 * 1024 })).stdout
      .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
    const originalFrames = await hashes(source), downloadedFrames = await hashes(output);
    const first = originalFrames.indexOf(downloadedFrames[0]);
    // Stream-copy may include the previous keyframe, but must cover the selected
    // range, end at the requested boundary, and preserve every decoded frame.
    assert(first >= 50 && first <= 100, `Unexpected first source frame: ${first}`);
    assert(first + downloadedFrames.length >= 250 && first + downloadedFrames.length <= 252);
    assert.deepEqual(downloadedFrames, originalFrames.slice(first, first + downloadedFrames.length));
    await win.reload();
    await win.waitForFunction(() => Boolean(window.api));
    const restored = await win.evaluate(() => window.api.getQueue());
    assert.equal(restored.length, 1);
    assert.equal(restored[0].status, 'completed');
    assert.deepEqual(restored[0].outputFiles, [output]);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ success: true, markers: true, invalidRange: true, filenameAndCollapse: true,
      qualityRetryAndCancel: true, queue: true, download: true, audioVideoDecode: true,
      identicalSourceFrames: downloadedFrames.length, firstSourceFrame: first, persistedCompletion: true }));
  } finally {
    if (app) await app.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    cleanupE2eEnvironment(environment);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
