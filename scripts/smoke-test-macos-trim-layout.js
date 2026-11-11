// Real Electron layout/input regression with isolated data and a local silent video.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const {
  createE2eEnvironment, getElectronLaunchOptions, verifyE2eIsolation,
  installOfflineFixtures, cleanupE2eEnvironment
} = require('./e2e-test-environment');

async function run() {
  assert.equal(process.platform, 'darwin');
  const environment = createE2eEnvironment('mac-trim-layout', { language: 'en', theme: 'twitch' });
  const artifacts = path.resolve(process.env.TVM_TRIM_ARTIFACTS || 'artifacts/mac-trim-layout');
  fs.mkdirSync(artifacts, { recursive: true });
  let app;
  const issues = [], checks = {};
  try {
    const media = path.join(environment.mediaDir, 'trim.mp4');
    const staged = path.resolve(`.cache/macos-tools/stage-${process.arch}/ffmpeg/ffmpeg`);
    execFileSync(fs.existsSync(staged) ? staged : 'ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=1',
      '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
      '-pix_fmt', 'yuv420p', '-an', '-y', media
    ]);
    const launch = getElectronLaunchOptions(environment);
    if (process.env.PACKAGED_APP_PATH) {
      launch.executablePath = path.resolve(process.env.PACKAGED_APP_PATH);
      launch.args = launch.args.filter(arg => arg !== '.');
    }
    app = await electron.launch(launch);
    const win = await app.firstWindow();
    win.on('pageerror', error => issues.push(error.message));
    await verifyE2eIsolation(app, win, environment);
    await installOfflineFixtures(app);
    await app.evaluate(({ ipcMain }, url) => {
      ipcMain.removeHandler('open-vod-playback');
      ipcMain.handle('open-vod-playback', (_event, request) => ({ id: request.id, sourceUrl: url, quality: 'source' }));
      ipcMain.removeHandler('close-vod-playback');
      ipcMain.handle('close-vod-playback', () => {});
      ipcMain.removeHandler('get-vod-timeline');
      ipcMain.handle('get-vod-timeline', () => ({
        vodId: '123456789', title: 'MacBook trim layout', started: Date.parse('2026-11-11T12:00:00Z'), duration: 120, login: 'fixture',
        chapters: [
          { id: 'one', start: 0, end: 40, name: 'Just Chatting', game_id: '509658', image: null, precision: 'source' },
          { id: 'two', start: 40, end: 90, name: 'Minecraft', game_id: '27471', image: null, precision: 'source' },
          { id: 'three', start: 90, end: 120, name: 'Just Chatting', game_id: '509658', image: null, precision: 'source' }
        ],
        titleHistory: [], viewerHistory: [], viewerGaps: [], chaptersStatus: 'available', titlesStatus: 'unavailable', refreshAfterMs: 0
      }));
    }, pathToFileURL(media).href);
    const settle = () => win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = async name => {
      await settle();
      // capturePage captures the Mac compositor; CDP screenshots can stall here.
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(artifacts, `${name}.png`), Buffer.from(png, 'base64'));
    };
    const geometry = () => win.evaluate(() => {
      const bounds = selector => {
        const element = document.querySelector(selector), rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      };
      return { viewport: { width: innerWidth, height: innerHeight }, video: bounds('#clipPlayer .archive-screen'),
        controls: bounds('#clipPlayer .archive-controls'), panel: bounds('#clipCutPanel'), timeline: bounds('.vod-selection-track'),
        footer: bounds('.vod-cut-footer'), collapsed: document.getElementById('clipModal').classList.contains('is-range-collapsed') };
    });
    const open = async () => {
      await win.evaluate(() => window.openClipDialog('https://www.twitch.tv/videos/123456789', 'MacBook trim layout', '2026-11-11T12:00:00Z', 'fixture', '2m0s'));
      await win.waitForFunction(() => document.querySelector('#clipPlayer video')?.readyState >= 2);
      await win.evaluate(() => document.querySelector('#clipPlayer video').pause());
      await win.locator('.vod-selection-track').waitFor();
      await settle();
    };
    await win.waitForFunction(() => typeof window.openClipDialog === 'function');
    for (const [width, height] of [[1280, 800], [1000, 700], [800, 700], [1512, 950], [1920, 1080], [1400, 868]]) {
      await win.setViewportSize({ width, height });
      await open();
      const state = await geometry();
      checks[`${width}x${height}`] = state;
      assert.equal(state.collapsed, height <= 1000);
      assert(state.footer.bottom <= height && state.footer.y > 0, 'Queue actions must stay visible');
      assert(state.panel.scrollWidth <= state.panel.clientWidth + 1, 'No horizontal scrolling in range controls');
      if (width > 800 && height <= 1000) {
        assert(state.timeline.bottom < state.footer.y, 'Marking timeline must stay visible');
        assert(state.video.height >= 300, `Preview too small at ${width}x${height}`);
      }
      if (width === 1400) break;
      await screenshot(`${width}x${height}`);
      await win.evaluate(() => window.closeClipDialog());
    }
    checks.compact = await geometry();
    await screenshot('compact');
    const video = await win.locator('#clipPlayer video.active').elementHandle();
    const toggle = win.locator('#clipDetailsToggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    checks.expanded = await geometry();
    assert(checks.compact.video.height > checks.expanded.video.height + 100);
    await screenshot('expanded');
    await win.locator('#clipStartTime').fill('00:00:10');
    await win.locator('#clipEndTime').fill('00:01:40');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert(await video.evaluate(element => element === document.querySelector('#clipPlayer video')), 'Toggling must not reload playback');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:10');
    assert.equal(await win.locator('#clipEndTime').inputValue(), '00:01:40');
    const start = win.locator('.vod-selection .vod-range-handle.is-start');
    const end = win.locator('.vod-selection .vod-range-handle.is-end');
    await start.press('ArrowRight');
    await end.press('ArrowLeft');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:11');
    assert.equal(await win.locator('#clipEndTime').inputValue(), '00:01:39');
    const handle = await end.boundingBox(), track = await win.locator('.vod-selection-track').boundingBox();
    await win.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await win.mouse.down();
    await win.mouse.move(handle.x + handle.width / 2 - track.width / 12, handle.y + handle.height / 2, { steps: 5 });
    await win.mouse.up();
    assert.equal(await win.locator('#clipEndTime').inputValue(), '00:01:29', 'Pointer marking works while compact');
    await win.locator('.vod-selection-track').click({ position: { x: track.width * .3, y: track.height / 2 } });
    await win.waitForFunction(() => Math.abs(document.querySelector('#clipPlayer video').currentTime - 36) < 1);
    checks.compactInput = { keyboard: true, pointer: true, seek: true, playbackPreserved: true };

    await win.getByRole('button', { name: 'Cinema mode', exact: true }).click();
    await win.locator('.archive-player.cinema').waitFor();
    assert((await win.locator('#clipPlayer .archive-screen').boundingBox()).height > checks.compact.video.height);
    await win.getByRole('button', { name: 'Cinema mode', exact: true }).click();
    await win.getByRole('button', { name: 'Exclude ranges', exact: true }).click();
    await win.locator('#clipModal.is-omitting').waitFor();
    assert(!(await toggle.isVisible()));
    await win.locator('.vod-omission-new').click();
    await win.locator('.vod-omission-times input').nth(0).fill('00:00:40');
    await win.locator('.vod-omission-times input').nth(1).fill('00:00:45');
    await win.locator('.vod-omission-confirm').click();
    assert.equal(await win.locator('.vod-omission-row:not(.is-editing)').count(), 1);
    await screenshot('omission');
    await win.locator('.vod-omission-modes button').first().click();
    await win.locator('#clipModal:not(.is-omitting)').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:11');
    assert.equal(await win.locator('#clipEndTime').inputValue(), '00:01:29');
    assert((await win.locator('#clipQueueHint').textContent()).includes('00:01:13'));
    checks.omissions = { selectionPreserved: true, correctOutputDuration: true };

    await toggle.click();
    await win.locator('#clipEndTime').fill('invalid');
    assert(await toggle.isDisabled());
    assert(await win.locator('#clipDialogConfirmBtn').isDisabled());
    assert(await win.locator('#clipEndTime').isVisible());
    await win.locator('#clipEndTime').fill('00:01:29');
    assert(await toggle.isEnabled());
    await win.locator('#clipFilenameOptions summary').click();
    await win.locator('#clipStartPart').fill('0');
    assert(await toggle.isDisabled());
    assert(await win.locator('#clipDialogConfirmBtn').isDisabled());
    await win.locator('#clipStartPart').fill('1');
    await win.locator('#clipFilenameOptions summary').click();
    await toggle.click();
    await win.evaluate(() => window.setLanguage('de'));
    assert.equal((await toggle.textContent()).trim(), 'Details einblenden');
    await toggle.press('Space');
    assert.equal((await toggle.textContent()).trim(), 'Details ausblenden');
    assert(await toggle.evaluate(element => element === document.activeElement));
    checks.validationAndAccessibility = true;
    await win.evaluate(() => window.closeClipDialog());
    await open();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Remember explicit expansion for next VOD');
    await toggle.click();
    await win.evaluate(() => window.closeClipDialog());
    await open();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Remember explicit collapse for next VOD');

    // Reproduce the unmodified layout to record the gain at the same viewport.
    await win.evaluate(() => {
      document.getElementById('clipModal').classList.remove('is-mac', 'is-range-collapsed');
      document.getElementById('clipDetailsToggle').hidden = true;
    });
    checks.before = await geometry();
    await screenshot('before');
    assert(checks.compact.video.height >= checks.before.video.height * 2.5, 'MacBook preview gain regressed');
    assert.deepEqual(issues, []);
    fs.writeFileSync(path.join(artifacts, 'checks.json'), JSON.stringify(checks, null, 2));
    console.log(JSON.stringify({ success: true, checks }, null, 2));
  } finally {
    if (app) await app.close();
    cleanupE2eEnvironment(environment);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
