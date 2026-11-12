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
  const environment = createE2eEnvironment('compact-trim-layout', { language: 'en', theme: 'twitch' });
  const artifacts = path.resolve(process.env.TVM_TRIM_ARTIFACTS || 'artifacts/mac-trim-layout');
  fs.mkdirSync(artifacts, { recursive: true });
  let app;
  const issues = [], checks = {};
  try {
    const media = path.join(environment.mediaDir, 'trim.mp4');
    const staged = path.resolve(`.cache/macos-tools/stage-${process.arch}/ffmpeg/ffmpeg`);
    const ffmpeg = process.env.FFMPEG_PATH || (process.platform === 'darwin' && fs.existsSync(staged) ? staged : 'ffmpeg');
    execFileSync(ffmpeg, [
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
        vodId: '123456789', title: 'Compact trim layout', started: Date.parse('2026-11-11T12:00:00Z'), duration: 120, login: 'fixture',
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
      await win.evaluate(() => window.openClipDialog('https://www.twitch.tv/videos/123456789', 'Compact trim layout', '2026-11-11T12:00:00Z', 'fixture', '2m0s'));
      await win.waitForFunction(() => document.querySelector('#clipPlayer video')?.readyState >= 2);
      await win.evaluate(() => document.querySelector('#clipPlayer video').pause());
      await win.locator('#clipModal.is-compact-trim .vod-selection-track').waitFor();
      await settle();
    };
    const assertFooter = async () => {
      await settle();
      assert.equal(await win.locator('#clipFooterFields > #clipRangeFields').count(), 1);
      const controls = win.locator('#clipRangeFields input[type="text"], #clipRangeFields button, #clipDurationDisplay, #clipCancelBtn, #clipDialogConfirmBtn');
      const footer = await win.locator('.vod-cut-footer').boundingBox();
      assert(await win.locator('.vod-cut-footer').evaluate(element => element.firstElementChild.id === 'clipCancelBtn'),
        'Close must remain the first footer action');
      for (const control of await controls.all()) {
        assert(await control.isVisible(), 'Compact time and queue controls must stay visible');
        const box = await control.boundingBox();
        assert(box.x >= footer.x - 1 && box.x + box.width <= footer.x + footer.width + 1
          && box.y >= footer.y - 1 && box.y + box.height <= footer.y + footer.height + 1, 'Footer controls must stay in bounds');
      }
      assert(await win.locator('.vod-cut-footer').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Footer must not overflow');
      for (const side of ['Start', 'End']) {
        const input = await win.locator(`#clip${side}Time`).boundingBox();
        const setHere = await win.locator(`#clipMark${side} button`).boundingBox();
        assert(side === 'Start' ? setHere.x > input.x + input.width : setHere.x + setHere.width < input.x,
          'Set here buttons must sit between the start/end entries');
      }
      if ((await win.viewportSize()).width > 1200) {
        assert(footer.height <= 50, 'Desktop compact footer must stay one line high');
        for (const side of ['Start', 'End']) {
          const label = await win.locator(`#clipDialog${side}TimeLabel`).boundingBox();
          const input = await win.locator(`#clip${side}Time`).boundingBox();
          const setHere = await win.locator(`#clipMark${side} button`).boundingBox();
          const aligned = Math.abs(label.y + label.height / 2 - input.y - input.height / 2) < 2
            && Math.abs(setHere.y + setHere.height / 2 - input.y - input.height / 2) < 2;
          if (!aligned) await screenshot('footer-alignment-failed');
          assert(aligned, `Label, input and Set here must share a row: ${JSON.stringify({ label, input, setHere })}`);
          assert(input.width < 110, 'Time entry must not stretch across the footer');
        }
      }
      assert(await win.locator('#clipModal').evaluate(element => {
        const ids = [...element.querySelectorAll('[id]')].map(node => node.id);
        return new Set(ids).size === ids.length;
      }), 'Moving fields must not duplicate IDs');
    };
    const assertLabels = async language => {
      const labels = language === 'de' ? ['Startzeit', 'Endzeit', 'Videolänge', 'Hier setzen'] : ['Start time', 'End time', 'Video length', 'Set here'];
      for (const [index, id] of ['clipDialogStartTimeLabel', 'clipDialogEndTimeLabel', 'clipDialogDurationLabel'].entries()) {
        assert.equal((await win.locator(`#${id}`).textContent()).trim(), labels[index]);
      }
      assert.deepEqual(await win.locator('#clipRangeFields .vod-set-boundary').allTextContents(), [labels[3], labels[3]]);
    };
    await win.waitForFunction(() => typeof window.openClipDialog === 'function');
    for (const [width, height] of [[1280, 800], [1000, 700], [800, 700], [1512, 950], [1920, 1080], [1400, 868]]) {
      await win.setViewportSize({ width, height });
      await open();
      const state = await geometry();
      checks[`${width}x${height}`] = state;
      assert.equal(state.collapsed, true, 'Trim defaults to compact at every viewport height');
      await assertFooter();
      assert(state.footer.bottom <= height && state.footer.y > 0, 'Queue actions must stay visible');
      assert(state.panel.scrollWidth <= state.panel.clientWidth + 1, 'No horizontal scrolling in range controls');
      if (width > 800) {
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
    const fields = await win.locator('#clipRangeFields').elementHandle();
    const markStart = await win.locator('#clipMarkStart button').elementHandle();
    const toggle = win.locator('#clipDetailsToggle');
    await assertLabels('en');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert(await fields.evaluate(element => element.parentElement.id === 'clipCutPanel' && element.nextElementSibling.id === 'clipOmissionPanel'));
    assert.equal(await win.locator('.vod-time-heading > #clipMarkStart, .vod-time-heading > #clipMarkEnd').count(), 2, 'Expanded layout keeps its original heading buttons');
    checks.expanded = await geometry();
    assert(checks.compact.video.height > checks.expanded.video.height + 100);
    await screenshot('expanded');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await assertFooter();
    assert(await fields.evaluate(element => element === document.getElementById('clipRangeFields')), 'Toggling must move the same fields');
    assert(await markStart.evaluate(element => element === document.querySelector('#clipMarkStart button')), 'React portal controls must survive moving');
    assert(await video.evaluate(element => element === document.querySelector('#clipPlayer video')), 'Toggling must not reload playback');
    await win.locator('#clipStartTime').fill('00:00:10');
    await win.locator('#clipEndTime').fill('00:01:40');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:10');
    assert.equal(await win.locator('#clipEndTime').inputValue(), '00:01:40');
    for (const [id, input, expected] of [
      ['clipStartLater', 'clipStartTime', '00:00:11'], ['clipStartEarlier', 'clipStartTime', '00:00:10'],
      ['clipEndEarlier', 'clipEndTime', '00:01:39'], ['clipEndLater', 'clipEndTime', '00:01:40']
    ]) {
      await win.locator(`#${id}`).click();
      assert.equal(await win.locator(`#${input}`).inputValue(), expected);
    }
    assert.equal(await win.locator('#clipDurationTime').textContent(), '00:01:30');
    // Expanded filename options used to float over Hide details, swallowing
    // its clicks. Exercise the real controls, including scrolling, without
    // force-clicks or programmatically closing the filename section first.
    for (const [width, height] of [[1400, 868], [1000, 700], [800, 700]]) {
      await win.setViewportSize({ width, height });
      await toggle.click();
      const options = win.locator('#clipFilenameOptions');
      if (!(await options.evaluate(element => element.open))) await options.locator('summary').click();
      await win.locator('input[name="filenameFormat"][value="template"]').check();
      await win.locator('#clipFilenameTemplate').fill('Trim-Test-{part}.mp4');
      await screenshot(`filename-details-${width}x${height}`);
      await toggle.click({ timeout: 5000 });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:10');
      assert.equal(await win.locator('#clipEndTime').inputValue(), '00:01:40');
      await toggle.click();
      assert.equal(await win.locator('#clipFilenameTemplate').inputValue(), 'Trim-Test-{part}.mp4');
      await options.locator('summary').click();
      await toggle.click();
    }
    checks.filenameDetails = { collapseWhileOpen: true, selectionAndTemplatePreserved: true };
    await win.setViewportSize({ width: 1400, height: 868 });
    for (const [from, to] of [['#clipStartLater', '#clipMarkStart button'], ['#clipMarkEnd button', '#clipEndEarlier']]) {
      await win.locator(from).focus();
      await win.keyboard.press('Tab');
      assert(await win.locator(to).evaluate(element => element === document.activeElement), 'Keyboard order must match the mirrored Set here buttons');
    }
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
    await win.locator('#clipMarkStart button').click();
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:36', 'Set start here uses playback position');
    await win.locator('.vod-selection-track').click({ position: { x: track.width * .6, y: track.height / 2 } });
    await win.waitForFunction(() => Math.abs(document.querySelector('#clipPlayer video').currentTime - 72) < 1);
    await win.locator('#clipMarkEnd button').click();
    assert.equal(await win.locator('#clipEndTime').inputValue(), '00:01:12', 'Set end here uses playback position');
    assert.equal(await win.locator('#clipDurationTime').textContent(), '00:00:36');
    await win.locator('#clipStartTime').fill('00:00:11');
    await win.locator('#clipEndTime').fill('00:01:29');
    checks.compactInput = { keyboard: true, pointer: true, seek: true, nudge: true, setHere: true, duration: true, playbackPreserved: true };

    await win.getByRole('button', { name: 'Cinema mode', exact: true }).click();
    await win.locator('.archive-player.cinema').waitFor();
    assert((await win.locator('#clipPlayer .archive-screen').boundingBox()).height > checks.compact.video.height);
    await win.getByRole('button', { name: 'Cinema mode', exact: true }).click();
    await win.getByRole('button', { name: 'Exclude ranges', exact: true }).click();
    await win.locator('#clipModal.is-omitting').waitFor();
    assert(await fields.evaluate(element => element.parentElement.id === 'clipCutPanel' && element.nextElementSibling.id === 'clipOmissionPanel'));
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
    await assertFooter();
    assert(await fields.evaluate(element => element === document.querySelector('#clipFooterFields > #clipRangeFields')), 'Returning from omissions reuses the footer fields');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:11');
    assert.equal(await win.locator('#clipEndTime').inputValue(), '00:01:29');
    assert((await win.locator('#clipQueueHint').textContent()).includes('00:01:13'));
    assert.equal(await win.locator('#clipDurationTime').textContent(), '00:01:13');
    checks.omissions = { selectionPreserved: true, correctOutputDuration: true };

    await win.locator('#clipEndTime').fill('invalid');
    assert(await toggle.isEnabled());
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert(await win.locator('#clipDialogConfirmBtn').isDisabled());
    assert(await win.locator('#clipEndTime').evaluate(element => element === document.activeElement && Boolean(element.closest('#clipFooterFields'))), 'Invalid typing must retain focus in the footer');
    await assertFooter();
    await win.locator('#clipEndTime').fill('00:01:29');
    assert(await toggle.isEnabled());
    assert(!(await win.locator('#clipStartPart').isVisible()));
    await win.locator('#clipStartPart').evaluate(element => { element.value = '0'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Invalid hidden filename controls must expand details');
    assert(await win.locator('#clipFilenameOptions summary').isVisible());
    assert(await toggle.isDisabled());
    assert(await win.locator('#clipDialogConfirmBtn').isDisabled());
    await win.locator('#clipFilenameOptions summary').click();
    await win.locator('#clipStartPart').fill('1');
    await win.locator('#clipFilenameOptions summary').click();
    await toggle.click();
    await win.evaluate(() => { window.closeClipDialog(); config.language = 'de'; window.setLanguage('de'); });
    await open();
    await assertLabels('de');
    await assertFooter();
    await screenshot('compact-de');
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
      document.querySelector('.vod-cut-footer').insertBefore(document.getElementById('clipCancelBtn'), document.getElementById('clipDialogConfirmBtn'));
      for (const side of ['Start', 'End']) {
        const mark = document.getElementById(`clipMark${side}`);
        const row = mark.closest('.clip-modal-time-row');
        const heading = row.querySelector('.vod-time-heading');
        heading.appendChild(mark);
        row.prepend(heading);
      }
      document.getElementById('clipCutPanel').insertBefore(document.getElementById('clipRangeFields'), document.getElementById('clipOmissionPanel'));
      document.getElementById('clipModal').classList.remove('is-compact-trim', 'is-range-collapsed');
      document.getElementById('clipDetailsToggle').hidden = true;
    });
    checks.before = await geometry();
    await screenshot('before');
    assert(checks.compact.video.height >= checks.before.video.height * 2.5, 'Compact preview gain regressed');
    assert.deepEqual(issues, []);
    fs.writeFileSync(path.join(artifacts, 'checks.json'), JSON.stringify(checks, null, 2));
    console.log(JSON.stringify({ success: true, checks }, null, 2));
  } finally {
    if (app) await app.close();
    cleanupE2eEnvironment(environment);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
