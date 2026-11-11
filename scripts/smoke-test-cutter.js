const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const { requireFileCapability } = require('./file-capability-contract');
const {
  createE2eEnvironment,
  getElectronLaunchOptions,
  verifyE2eIsolation,
  installOfflineFixtures,
  cleanupE2eEnvironment
} = require('./e2e-test-environment');

async function captureCutterScreenshot(app, win, options) {
  if (process.platform !== 'darwin') return win.screenshot(options);
  // CDP Page.captureScreenshot can stall after viewport emulation on macOS Electron.
  // Capture the actual compositor surface through Electron, preserving visual QA.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  fs.writeFileSync(options.path, Buffer.from(png, 'base64'));
}

function findFileRecursive(rootDir, fileName) {
  if (!fs.existsSync(rootDir)) return null;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return fullPath;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(fullPath, fileName);
      if (nested) return nested;
    }
  }
  return null;
}

function resolveBinary(environment, name) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const direct = spawnSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
  if (direct.status === 0) return name;
  const bundled = findFileRecursive(path.join(environment.appDataDir, 'tools', 'ffmpeg'), executable);
  if (bundled) return bundled;
  throw new Error(`${name} not found`);
}

function runBinary(binary, args) {
  const result = spawnSync(binary, args, { windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.slice(0, 1000) || `${binary} exited with ${result.status}`);
  return result.stdout;
}


async function createCutterCapability(win, filePath) {
  const inputId = `cutter-capability-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await win.evaluate((id) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = id;
    document.body.appendChild(input);
  }, inputId);
  await win.locator(`#${inputId}`).setInputFiles(filePath);
  const capability = await win.evaluate(async (id) => {
    const input = document.getElementById(id);
    const file = input instanceof HTMLInputElement ? input.files?.[0] : null;
    const capability = file ? await window.api.selectDroppedVideo(file) : null;
    input?.remove();
    if (!capability || typeof capability.token !== 'string' || !capability.token) throw new Error('Cutter capability was not issued');
    return capability;
  }, inputId);
  return requireFileCapability(capability);
}

async function loadCutterCapability(win, filePath) {
  const capability = await createCutterCapability(win, filePath);
  await win.evaluate((selection) => window.loadCutterFromPath(selection), capability);
  return capability;
}

function createTestVideo(environment) {
  const filePath = path.join(environment.mediaDir, 'Cutter Test #ä 01.mp4');
  runBinary(resolveBinary(environment, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', filePath
  ]);
  return filePath;
}

function createScrubStressVideo(environment) {
  const filePath = path.join(environment.mediaDir, 'Scrub Stress 60fps.mp4');
  runBinary(resolveBinary(environment, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '8.746667', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', '180', '-keyint_min', '180', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '32k', '-shortest', '-y', filePath
  ]);
  return filePath;
}

function createMediumVideo(environment) {
  const filePath = path.join(environment.mediaDir, 'Medium Cutter Test 60fps.mp4');
  runBinary(resolveBinary(environment, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x202632:size=1920x1080:rate=60',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', '58.020333', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-g', '360', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', '-y', filePath
  ]);
  return filePath;
}

function createSilentPortraitVideo(environment) {
  const filePath = path.join(environment.mediaDir, 'Silent Portrait.mp4');
  runBinary(resolveBinary(environment, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30',
    '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', filePath
  ]);
  return filePath;
}

function createAdditionalContainerVideos(environment, sourceFile) {
  const mkv = path.join(environment.mediaDir, 'Additional container.mkv');
  runBinary(resolveBinary(environment, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-i', sourceFile, '-c', 'copy', '-y', mkv
  ]);
  const ts = path.join(environment.mediaDir, 'Additional container.ts');
  runBinary(resolveBinary(environment, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-i', sourceFile, '-c', 'copy', '-f', 'mpegts', '-y', ts
  ]);
  const avi = path.join(environment.mediaDir, 'Additional container.avi');
  runBinary(resolveBinary(environment, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-i', sourceFile, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'libmp3lame', '-y', avi
  ]);
  return { mkv, ts, avi };
}


function createLongVideo(environment) {
  const filePath = path.join(environment.mediaDir, 'Long Cutter Test.mp4');
  runBinary(resolveBinary(environment, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x151515:size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
    '-t', '1800', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '16k', '-shortest', '-y', filePath
  ]);
  return filePath;
}

async function run() {
  const environment = createE2eEnvironment('cutter', { language: 'en', theme: 'twitch' });
  const inputFile = createTestVideo(environment);
  const scrubStressInputFile = process.env.TWITCH_VOD_MANAGER_SCRUB_MEDIA && fs.existsSync(process.env.TWITCH_VOD_MANAGER_SCRUB_MEDIA)
    ? process.env.TWITCH_VOD_MANAGER_SCRUB_MEDIA
    : createScrubStressVideo(environment);
  const mediumInputFile = process.env.TWITCH_VOD_MANAGER_MEDIUM_MEDIA && fs.existsSync(process.env.TWITCH_VOD_MANAGER_MEDIUM_MEDIA)
    ? process.env.TWITCH_VOD_MANAGER_MEDIUM_MEDIA
    : createMediumVideo(environment);
  const additionalContainerFiles = createAdditionalContainerVideos(environment, inputFile);
  const silentInputFile = createSilentPortraitVideo(environment);
  const longInputFile = createLongVideo(environment);
  const outputFile = path.join(environment.mediaDir, 'Cutter Test #ä 01 edited.mp4');
  const silentOutputFile = path.join(environment.mediaDir, 'Silent Portrait edited.mp4');
  const failures = [];
  const runtimeIssues = [];
  const staleCutterDirectories = ['media', 'waveform', 'preview'].map((kind) => path.join(os.tmpdir(), `tvm-editor-${kind}-2147483647-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  staleCutterDirectories.forEach((directory) => fs.mkdirSync(directory));
  let app;
  const check = (condition, message) => { if (!condition) failures.push(message); };
  try {
    const launchOptions = getElectronLaunchOptions(environment);
    launchOptions.env = {
      ...launchOptions.env,
      TWITCH_VOD_MANAGER_E2E_CUTTER_OUTPUT_ROOT: environment.mediaDir
    };
    app = await electron.launch(launchOptions);
    const win = await app.firstWindow();
    // Keep CDP viewport emulation at the native display density on macOS.
    // Forcing a Retina window to scale 1 changes the delivered wheel deltas.
    const nativeDisplayScale = process.platform === 'darwin'
      ? await app.evaluate(({ screen, BrowserWindow }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).scaleFactor)
      : 1;
    const macViewportSession = process.platform === 'darwin' ? await win.context().newCDPSession(win) : null;
    const setViewportSize = async (viewport) => {
      await win.setViewportSize(viewport);
      if (macViewportSession) {
        await macViewportSession.send('Emulation.setDeviceMetricsOverride', {
          ...viewport, deviceScaleFactor: nativeDisplayScale, mobile: false
        });
      }
    };
    check(staleCutterDirectories.every((directory) => !fs.existsSync(directory)), `Startup left stale cutter directories: ${JSON.stringify(staleCutterDirectories.filter((directory) => fs.existsSync(directory)))}`);
    const minimumWindowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMinimumSize() || [0, 0]);
    const isolation = await verifyE2eIsolation(app, win, environment);
    const fixtures = await installOfflineFixtures(app);
    check(isolation.userDataIsolated && isolation.downloadPathIsolated, 'Cutter smoke is not isolated');
    check(fixtures.network === 'blocked', 'Cutter smoke network is not blocked');
    check(minimumWindowSize[0] >= 1200 && minimumWindowSize[1] >= 700, `Cutter window minimum is too small for the editor: ${JSON.stringify(minimumWindowSize)}`);
    win.on('pageerror', (error) => runtimeIssues.push(`pageerror: ${String(error)}`));
    win.on('console', (message) => { if (message.type() === 'error') runtimeIssues.push(`console.error: ${message.text()}`); });
    await win.waitForFunction(() => typeof window.loadCutterFromPath === 'function');
    await setViewportSize({ width: 1440, height: 900 });
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await win.evaluate(() => window.showTab('cutter'));
    const additionalContainerCapabilities = await Promise.all(Object.entries(additionalContainerFiles).map(async ([extension, filePath]) => ({
      extension,
      capability: await createCutterCapability(win, filePath),
      sourceUrl: pathToFileURL(filePath).href
    })));
    const additionalContainerSupport = await win.evaluate(async (entries) => {
      const probe = (sourceUrl) => new Promise((resolve) => {
        const video = document.createElement('video');
        const finish = (playable) => {
          video.removeAttribute('src');
          video.load();
          resolve(playable);
        };
        const timer = window.setTimeout(() => finish(false), 5000);
        video.addEventListener('loadedmetadata', () => {
          window.clearTimeout(timer);
          finish(video.duration > 0);
        }, { once: true });
        video.addEventListener('error', () => {
          window.clearTimeout(timer);
          finish(false);
        }, { once: true });
        video.preload = 'metadata';
        video.src = sourceUrl;
        video.load();
      });
      const results = [];
      for (const entry of entries) {
        const nativePlayable = await probe(entry.sourceUrl);
        const media = await window.api.prepareVideoEditorMedia(entry.capability.token);
        results.push({
          extension: entry.extension,
          nativePlayable,
          prepared: Boolean(media),
          editorPlayable: media ? await probe(media.sourceUrl) : false
        });
      }
      return results;
    }, additionalContainerCapabilities);
    check(additionalContainerSupport.every((entry) => entry.prepared && entry.editorPlayable), `Additional video containers are not usable in the editor: ${JSON.stringify(additionalContainerSupport)}`);
    const cutterArtifactDir = path.join(process.cwd(), 'artifacts', 'ui-overhaul', 'cutter');
    fs.mkdirSync(cutterArtifactDir, { recursive: true });
    const checks = { additionalContainerSupport };
    const waitForMedia = async () => {
      await win.waitForFunction(() => cutterControlsEnabled && document.getElementById('cutterVideo').readyState >= HTMLMediaElement.HAVE_METADATA, null, { timeout: 90000 });
      await win.locator('#cutterTrimStartHandle').waitFor();
    };
    const captureLayout = () => win.evaluate(() => {
      const ids = ['cutterPreview', 'cutterEditPanel', 'timelineContainer'];
      return { width: innerWidth, bodyWidth: document.body.scrollWidth,
        panels: ids.map(id => { const bounds = document.getElementById(id).getBoundingClientRect(); return { id, width: bounds.width, height: bounds.height, left: bounds.left, right: bounds.right }; }),
        controls: document.querySelectorAll('#cutterPlayerControls .player-button').length,
      };
    });
    checks.empty = await win.evaluate(() => ({
      emptyVisible: !document.getElementById('cutterPreviewEmpty').hidden,
      exportDisabled: document.getElementById('btnCut').disabled,
      noPlayerControls: document.querySelectorAll('#cutterPlayerControls .player-button').length === 0,
    }));
    check(checks.empty.emptyVisible && checks.empty.exportDisabled && checks.empty.noPlayerControls, 'Empty editor exposes active media controls');
    await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'empty.png') });
    await loadCutterCapability(win, inputFile);
    await waitForMedia();
    await win.waitForFunction(() => cutterWaveformStatus === 'complete' && !document.getElementById('cutterWaveform').hidden && Number(document.getElementById('cutterThumbnailStrip').dataset.thumbnailCount) > 0, null, { timeout: 90000 });
    checks.loaded = await win.evaluate(() => ({
      duration: cutterEditorState.duration, fps: cutterEditorState.fps,
      waveformBins: cutterWaveformPeaks[0]?.length || 0,
      waveformPixels: document.getElementById('cutterWaveform').width,
      thumbnails: Number(document.getElementById('cutterThumbnailStrip').dataset.thumbnailCount),
      sourceName: document.getElementById('cutterFilePath').value,
      exportEnabled: !document.getElementById('btnCut').disabled,
    }));
    check(Math.abs(checks.loaded.duration - 10) < .1 && checks.loaded.fps === 25 && checks.loaded.exportEnabled, 'Loaded editor metadata or export readiness is incorrect');
    check(checks.loaded.waveformBins > 0 && checks.loaded.waveformPixels > 0 && checks.loaded.thumbnails > 0, 'Progressive waveform or thumbnail rendering failed');
    check(checks.loaded.sourceName === path.basename(inputFile), 'Unicode source filename was not preserved');

    // Exercise actual React player controls and native menu accelerators.
    const player = win.locator('#cutterPlayerControls');
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await win.waitForFunction(() => !document.getElementById('cutterVideo').paused && document.getElementById('cutterVideo').currentTime > .1);
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    const frameBefore = await win.evaluate(() => document.getElementById('cutterVideo').currentTime);
    await player.getByRole('button', { name: 'Next frame', exact: true }).click();
    await win.waitForFunction(before => document.getElementById('cutterVideo').currentTime > before, frameBefore);
    const frameAfter = await win.evaluate(() => document.getElementById('cutterVideo').currentTime);
    check(Math.abs(frameAfter - frameBefore - 1 / 25) < .045, `Frame stepping is not frame-accurate: ${frameBefore}/${frameAfter}`);
    await player.getByRole('button', { name: 'Mute', exact: true }).click();
    check(await win.evaluate(() => document.getElementById('cutterVideo').muted), 'React mute control does not mute the video');
    await player.getByRole('button', { name: 'Unmute', exact: true }).click();
    await player.getByRole('button', { name: 'Playback speed', exact: true }).click();
    await win.getByRole('slider', { name: 'Playback speed', exact: true }).press('ArrowRight');
    await win.waitForFunction(() => document.getElementById('cutterVideo').playbackRate === 1.25);
    await win.getByRole('slider', { name: 'Playback speed', exact: true }).press('ArrowRight');
    await win.waitForFunction(() => document.getElementById('cutterVideo').playbackRate === 1.5);
    check(await win.evaluate(() => document.getElementById('cutterVideo').playbackRate === 1.5), 'React playback rate control did not update video');
    await win.keyboard.press('Escape');
    await win.evaluate(() => { document.getElementById('cutterVideo').playbackRate = 1; });

    await win.locator('#startTime').fill('00:00:01:00');
    await win.locator('#startTime').press('Tab');
    await win.locator('#endTime').fill('00:00:09:00');
    await win.locator('#endTime').press('Tab');
    check(await win.evaluate(() => cutterEditorState.trimStart === 1 && cutterEditorState.trimEnd === 9), 'Timecode inputs do not update the trim');
    await win.locator('#cutterTrimStartHandle').press('ArrowRight');
    const keyboardTrim = await win.evaluate(() => cutterEditorState.trimStart);
    check(Math.abs(keyboardTrim - 1.04) < .001, `React trim slider did not advance a frame: ${keyboardTrim}`);
    await win.locator('#cutterTrimStartHandle').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    check(await win.evaluate(() => Math.abs(cutterEditorState.trimStart - 1) < .001), 'Native undo did not restore the trim');
    await win.locator('#cutterTrimStartHandle').press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
    check(await win.evaluate(() => Math.abs(cutterEditorState.trimStart - 1.04) < .001), 'Native redo did not restore the trim');
    await win.evaluate(() => undoCutterEdit());
    const handle = await win.locator('#cutterTrimStartHandle').boundingBox();
    await win.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await win.mouse.down();
    await win.mouse.move(handle.x + handle.width / 2 + 45, handle.y + handle.height / 2, { steps: 8 });
    await win.mouse.up();
    check(await win.evaluate(() => cutterEditorState.trimStart > 1.04), 'Pointer dragging the React trim marker did not change the range');
    await win.evaluate(() => undoCutterEdit());

    await win.locator('#cutterOmitMode').click();
    await win.locator('#cutterNewCutBtn').click();
    await win.locator('#cutterOmitStartHandle').waitFor();
    checks.draft = await win.evaluate(() => ({ draft: !!cutterCutDraft, exportDisabled: document.getElementById('btnCut').disabled, trimDisabled: document.getElementById('startTime').disabled }));
    check(checks.draft.draft && checks.draft.exportDisabled && checks.draft.trimDisabled, 'Omission draft does not protect export and trim controls');
    await win.evaluate(() => { changeCutterPlayerRange(3, 5, cutterCutDraft.id, { source: 'keyboard', boundary: 'start' }); confirmCutterCut(); });
    check(await win.evaluate(() => cutterEditorState.cuts.length === 1 && !cutterCutDraft && getCutterPlayableDuration() === 6), 'Confirmed omission has incorrect output duration');
    await win.locator('#cutterNewCutBtn').click();
    await win.keyboard.press('Escape');
    check(await win.evaluate(() => cutterEditorState.cuts.length === 1 && !cutterCutDraft), 'Escape did not cancel the new omission draft');
    check(await win.evaluate(() => findCutterPreviewTime(3.5, 2.9) >= 5), 'Preview navigation does not skip omitted time');

    const preserved = await win.evaluate(() => JSON.stringify(cutterEditorState));
    await win.evaluate(() => { void requestCutterVideoReplacement({ token: 'replacement-fixture', name: 'replacement.mp4' }); });
    await win.locator('#cutterDiscardModal.show').waitFor();
    await win.keyboard.press('Escape');
    check(await win.evaluate(before => JSON.stringify(cutterEditorState) === before, preserved), 'Cancelling source replacement lost edits');
    check(await win.evaluate(() => persistCutterProject(false)), 'Cutter autosave could not persist');
    const recovery = await win.evaluate(() => window.api.getCutterProjectRecovery(cutterFile.token));
    check(recovery && recovery.trimStart === 1 && recovery.trimEnd === 9 && recovery.cuts.length === 1, 'Saved project did not preserve trim and omissions');
    await win.locator('#editingProjectName').fill('Mac 1.1.20 regression');
    await app.evaluate(({ dialog }, filePath) => { globalThis.__cutterOriginalSaveDialog = dialog.showSaveDialog; dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path.join(environment.mediaDir, 'Mac regression.tvmcut'));
    try { await win.evaluate(() => saveNamedEditingProject(true)); }
    finally { await app.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.__cutterOriginalSaveDialog; }); }
    await win.evaluate(() => showRecentEditingProjects());
    await win.locator('#editingRecentProjects[open]').waitFor();
    check(await win.getByRole('button', { name: /Mac 1.1.20 regression/ }).count() === 1, 'Named project is missing from recent projects');
    await win.keyboard.press('Escape');

    checks.responsiveLayouts = [];
    for (const size of [{ width: 2048, height: 1152 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
      await setViewportSize(size);
      await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await captureLayout(); checks.responsiveLayouts.push(layout);
      check(layout.bodyWidth <= layout.width + 1 && layout.panels.every(panel => panel.width > 0 && panel.height > 0 && panel.left >= 0 && panel.right <= layout.width + 1), `Cutter panels overflow at ${size.width}: ${JSON.stringify(layout)}`);
      check(layout.controls >= 6, 'React cutter controls disappeared at a supported size');
    }
    await setViewportSize({ width: 1440, height: 900 });
    await win.evaluate(() => { window.__cutterWaveformBeforeZoom = cutterWaveformPeaks; updateCutterZoom(4); });
    await win.waitForFunction(() => cutterAssetRefreshTimer === null && cutterAssetsInFlightJobId === null && document.getElementById('timeline').getBoundingClientRect().width >= document.getElementById('cutterTimelineScroll').clientWidth * 3.9);
    checks.zoom = await win.evaluate(() => ({
      width: document.getElementById('timeline').getBoundingClientRect().width,
      viewport: document.getElementById('cutterTimelineScroll').getBoundingClientRect().width,
      reusedWaveform: cutterWaveformPeaks === window.__cutterWaveformBeforeZoom,
    }));
    check(checks.zoom.width >= checks.zoom.viewport * 3.9 && checks.zoom.reusedWaveform, 'Timeline zoom fails to expand tracks or unnecessarily replaces waveform');
    await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'maximum-zoom.png') });
    await win.evaluate(() => updateCutterZoom(1));

    // Decode and seek high frame-rate media, then verify stale asynchronous jobs
    // cannot replace the last requested source or its progressive waveform.
    await loadCutterCapability(win, scrubStressInputFile);
    await waitForMedia();
    for (const time of [1.05, 6.5, .25, 7.75]) {
      await win.evaluate(position => seekCutterVideo(position), time);
      await win.waitForFunction(position => Math.abs(document.getElementById('cutterVideo').currentTime - position) < .05 && !document.getElementById('cutterVideo').seeking, time);
    }
    check(await win.evaluate(() => cutterEditorState.fps === 60), '60 fps source metadata was lost');
    await loadCutterCapability(win, mediumInputFile);
    await waitForMedia();
    await win.waitForFunction(() => cutterWaveformStatus === 'complete', null, { timeout: 90000 });
    checks.mediumWaveform = await win.evaluate(() => ({ duration: cutterEditorState.duration, bins: cutterWaveformPeaks[0]?.length || 0 }));
    check(checks.mediumWaveform.duration > 58 && checks.mediumWaveform.bins > 1000, 'Medium-length progressive waveform is incomplete');
    const rapidSources = await Promise.all([longInputFile, inputFile].map(file => createCutterCapability(win, file)));
    await win.evaluate(sources => Promise.all(sources.map(source => loadCutterFromPath(source))), rapidSources);
    await waitForMedia();
    check(await win.evaluate(() => Math.abs(cutterEditorState.duration - 10) < .1), 'Stale source preparation replaced the newest source');
    await win.evaluate(() => { cutterRecoveryDecisionPending = false; renderCutterProjectRecovery(null); applyCutterProject({ version: 1, duration: cutterEditorState.duration, fps: cutterEditorState.fps, trimStart: 1, trimEnd: 9, cuts: [{ id: 'export-cut', start: 3, end: 5 }], profile: 'balanced', encoder: 'software', audioStreamIndex: 0 }); });
    await win.evaluate(() => updateCutterZoom(2));
    const editorState = await win.evaluate(() => ({
      trimStart: cutterEditorState.trimStart,
      trimEnd: cutterEditorState.trimEnd,
      cuts: cutterEditorState.cuts.map((cut) => ({ ...cut }))
    }));
    const sourceProtection = await win.evaluate(({ outputName, editorState }) => window.api.exportVideoEdit({
      inputCapability: cutterFile.token,
      outputName,
      trimStart: editorState.trimStart,
      trimEnd: editorState.trimEnd,
      cuts: editorState.cuts
    }), { outputName: path.basename(inputFile).toUpperCase(), editorState });
    check(!sourceProtection.success && fs.existsSync(inputFile) && fs.statSync(inputFile).size > 256, `Source overwrite protection failed: ${JSON.stringify(sourceProtection)}`);
    const invalidOutputFile = path.join(environment.mediaDir, 'Invalid request.mp4');
    const invalidRequest = await win.evaluate(({ outputName, editorState }) => window.api.exportVideoEdit({
      inputCapability: cutterFile.token,
      outputName,
      trimStart: Number.NaN,
      trimEnd: editorState.trimEnd,
      cuts: editorState.cuts
    }), { outputName: path.basename(invalidOutputFile), editorState });
    check(!invalidRequest.success && !fs.existsSync(invalidOutputFile), `Invalid numeric request was accepted: ${JSON.stringify(invalidRequest)}`);
    const cancelledOutputFile = path.join(environment.mediaDir, 'Cancelled export.mp4');
    const cancelledExport = await win.evaluate(async ({ outputName, capability }) => {
      await window.api.prepareVideoEditorMedia(capability.token);
      const exportPromise = window.api.exportVideoEdit({
        inputCapability: capability.token,
        outputName,
        trimStart: 0,
        trimEnd: 1800,
        cuts: []
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const cancelAccepted = await window.api.cancelVideoEdit();
      return { cancelAccepted, result: await exportPromise };
    }, { outputName: path.basename(cancelledOutputFile), capability: rapidSources[0] });
    check(cancelledExport.cancelAccepted && !cancelledExport.result.success && cancelledExport.result.cancelled === true && !fs.existsSync(cancelledOutputFile), `Export cancellation did not return a clean cancelled result or published a file: ${JSON.stringify(cancelledExport)}`);
    await win.evaluate(() => window.api.prepareVideoEditorMedia(cutterFile.token));
    fs.writeFileSync(outputFile, 'previous-output', 'utf8');
    const exportResult = await win.evaluate(({ outputName, editorState }) => window.api.exportVideoEdit({
      inputCapability: cutterFile.token,
      outputName,
      trimStart: editorState.trimStart,
      trimEnd: editorState.trimEnd,
      cuts: editorState.cuts
    }), { outputName: path.basename(outputFile), editorState });
    check(exportResult.success && fs.existsSync(outputFile), `Export failed: ${JSON.stringify(exportResult)}`);
    if (fs.existsSync(outputFile)) {
      const probe = JSON.parse(runBinary(resolveBinary(environment, 'ffprobe'), ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', outputFile]));
      const duration = Number(probe.format.duration);
      const streams = probe.streams.map((stream) => stream.codec_type);
      check(Math.abs(duration - 6) < 0.3, `Unexpected export duration: ${duration}`);
      check(streams.includes('video') && streams.includes('audio'), `Export streams are incomplete: ${streams.join(', ')}`);
      check(fs.statSync(outputFile).size > 256, 'Export file is empty');
    }
    const manyCutsOutputFile = path.join(environment.mediaDir, 'Many cuts edited.mp4');
    const manyCuts = Array.from({ length: 32 }, (_, index) => ({
      id: `stress-cut-${index}`,
      start: 1.2 + index * 0.2,
      end: 1.28 + index * 0.2
    }));
    const manyCutsExport = await win.evaluate(({ outputName, cuts }) => window.api.exportVideoEdit({
      inputCapability: cutterFile.token,
      outputName,
      trimStart: 1,
      trimEnd: 9.5,
      cuts
    }), { outputName: path.basename(manyCutsOutputFile), cuts: manyCuts });
    check(manyCutsExport.success && fs.existsSync(manyCutsOutputFile) && fs.statSync(manyCutsOutputFile).size > 256, `Many-cut export failed: ${JSON.stringify(manyCutsExport)}`);
    const sourceStatBeforeMutation = fs.statSync(inputFile);
    fs.utimesSync(inputFile, sourceStatBeforeMutation.atime, new Date(sourceStatBeforeMutation.mtimeMs + 5000));
    const changedSourceOutputFile = path.join(environment.mediaDir, 'Changed source rejected.mp4');
    const changedSourceExport = await win.evaluate(({ outputName }) => window.api.exportVideoEdit({
      inputCapability: cutterFile.token,
      outputName,
      trimStart: 0,
      trimEnd: 10,
      cuts: []
    }), { outputName: path.basename(changedSourceOutputFile) });
    check(!changedSourceExport.success && !fs.existsSync(changedSourceOutputFile), `Changed source identity was accepted: ${JSON.stringify(changedSourceExport)}`);
    await win.evaluate(() => {
      window.updateCutterZoom(1);
      document.getElementById('cutterTab').scrollTop = 0;
    });
    await win.waitForTimeout(250);
    await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'editor.png'), fullPage: true });
    await loadCutterCapability(win, silentInputFile);
    await win.waitForFunction(() => {
      const video = document.getElementById('cutterVideo');
      return video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth === 360;
    }, null, { timeout: 90000 });
    const silentState = await win.evaluate(() => ({
      trimStart: cutterEditorState.trimStart,
      trimEnd: cutterEditorState.trimEnd,
      cuts: cutterEditorState.cuts.map((cut) => ({ ...cut })),
      waveformHidden: document.getElementById('cutterWaveform').hidden,
      emptyVisible: !document.getElementById('cutterAudioEmpty').hidden
    }));
    check(silentState.waveformHidden && silentState.emptyVisible, `Silent video does not show the no-audio state: ${JSON.stringify(silentState)}`);
    const silentExportResult = await win.evaluate(({ outputName, state }) => window.api.exportVideoEdit({
      inputCapability: cutterFile.token,
      outputName,
      trimStart: state.trimStart,
      trimEnd: state.trimEnd,
      cuts: state.cuts
    }), { outputName: path.basename(silentOutputFile), state: silentState });
    check(silentExportResult.success && fs.existsSync(silentOutputFile), `Silent export failed: ${JSON.stringify(silentExportResult)}`);
    if (fs.existsSync(silentOutputFile)) {
      const silentProbe = JSON.parse(runBinary(resolveBinary(environment, 'ffprobe'), ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', silentOutputFile]));
      const silentStreams = silentProbe.streams.map((stream) => stream.codec_type);
      check(JSON.stringify(silentStreams) === JSON.stringify(['video']), `Silent export streams are unexpected: ${silentStreams.join(', ')}`);
      check(Math.abs(Number(silentProbe.format.duration) - 4) < 0.3, `Silent export duration is unexpected: ${silentProbe.format.duration}`);
    }
    check(fs.existsSync(inputFile) && fs.statSync(inputFile).size > 256, 'Source video was modified or removed');
    check(runtimeIssues.length === 0, runtimeIssues.join('\n'));
    const cutterTempDirectoriesBeforeShutdown = new Set(fs.readdirSync(os.tmpdir()).filter((name) => /^tvm-editor-(?:media|waveform|preview)-/.test(name)));
    const shutdownOutputFile = path.join(environment.mediaDir, 'Shutdown export.mp4');
    await loadCutterCapability(win, longInputFile);
    await win.waitForFunction(() => document.getElementById('cutterVideo').readyState >= HTMLMediaElement.HAVE_METADATA, null, { timeout: 15000 });
    await win.evaluate(({ outputName }) => {
      void window.api.exportVideoEdit({ inputCapability: cutterFile.token, outputName, trimStart: 0, trimEnd: 1800, cuts: [] });
    }, { outputName: path.basename(shutdownOutputFile) });
    await win.waitForTimeout(150);
    const appClosed = app.waitForEvent('close', { timeout: 15000 });
    try { await app.evaluate(({ app: electronApp }) => electronApp.quit()); } catch { }
    await appClosed;
    app = null;
    const cutterTempDirectoriesAfterShutdown = fs.readdirSync(os.tmpdir())
      .filter((name) => /^tvm-editor-(?:media|waveform|preview)-/.test(name) && !cutterTempDirectoriesBeforeShutdown.has(name));
    const shutdownArtifacts = fs.readdirSync(environment.mediaDir)
      .filter((name) => name.includes('.tvm-edit.mp4') || name.includes('.tvm-backup') || name === path.basename(shutdownOutputFile));
    check(cutterTempDirectoriesAfterShutdown.length === 0 && shutdownArtifacts.length === 0, `Shutdown left cutter artifacts: ${JSON.stringify({ cutterTempDirectoriesAfterShutdown, shutdownArtifacts })}`);
    console.log(JSON.stringify({ failures, runtimeIssues, checks, sourceProtection, invalidRequest, cancelledExport, exportResult, manyCutsExport, changedSourceExport, silentState, silentExportResult, cutterTempDirectoriesAfterShutdown, shutdownArtifacts }, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ failures, runtimeIssues }, null, 2));
    throw error;
  } finally {
    if (app) await app.close();
    staleCutterDirectories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
    cleanupE2eEnvironment(environment);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
