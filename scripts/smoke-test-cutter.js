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

function getProcessTreeMemoryMb(rootPid) {
  if (process.platform !== 'win32') return 0;
  const script = `$rootPid=${Number(rootPid)};$all=Get-CimInstance Win32_Process;$ids=@($rootPid);do{$before=$ids.Count;$ids+=@($all|Where-Object{$ids -contains $_.ParentProcessId}|ForEach-Object ProcessId);$ids=@($ids|Select-Object -Unique)}while($ids.Count -gt $before);$sum=($ids|ForEach-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue}|Measure-Object WorkingSet64 -Sum).Sum;[math]::Round(($sum/1MB),2)`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  const value = Number(String(result.stdout || '').trim().replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
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

function createUnsupportedVideo(environment, sourceFile) {
  const filePath = path.join(environment.mediaDir, 'Unsupported preview.txt');
  fs.copyFileSync(sourceFile, filePath);
  return filePath;
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
  const unsupportedInputFile = createUnsupportedVideo(environment, inputFile);
  const silentInputFile = createSilentPortraitVideo(environment);
  const longInputFile = createLongVideo(environment);
  const outputFile = path.join(environment.mediaDir, 'Cutter Test #ä 01 edited.mp4');
  const silentOutputFile = path.join(environment.mediaDir, 'Silent Portrait edited.mp4');
  const failures = [];
  const runtimeIssues = [];
  const staleCutterDirectories = ['media', 'waveform', 'preview'].map((kind) => path.join(os.tmpdir(), `tvm-editor-${kind}-2147483647-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  staleCutterDirectories.forEach((directory) => fs.mkdirSync(directory));
  let realMaximumZoomState = null;
  let replacementPromptState;
  let replacementPlaybackState = null;
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
    // Hosted Mac runners have fewer CPU cores than the interactive reference
    // machine. Keep strict local budgets and report actual CI times below.
    const mediaTimingScale = process.platform === 'darwin' && process.env.CI === 'true' ? 3 : 1;
    await win.evaluate(() => {
      document.addEventListener('pointermove', (event) => {
        window.__cutterLatestPointerX = event.clientX;
      }, { capture: true });
    });
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
    const emptyLayout = await win.evaluate(() => {
      const source = document.querySelector('.cutter-source-bar').getBoundingClientRect();
      const preview = document.getElementById('cutterPreview').getBoundingClientRect();
      const placeholder = document.getElementById('cutterPreviewEmpty').getBoundingClientRect();
      const tab = document.getElementById('cutterTab').getBoundingClientRect();
      return {
        sourceHeight: source.height,
        previewWidth: preview.width,
        previewHeight: preview.height,
        previewRatio: preview.width / preview.height,
        placeholderCenterError: Math.max(
          Math.abs(placeholder.left + placeholder.width / 2 - (preview.left + preview.width / 2)),
          Math.abs(placeholder.top + placeholder.height / 2 - (preview.top + preview.height / 2))
        ),
        contained: source.top >= tab.top && preview.bottom <= Math.min(tab.bottom, window.innerHeight) + 1
      };
    });
    check(
      emptyLayout.sourceHeight <= 80
        && emptyLayout.previewHeight >= 280
        && emptyLayout.previewWidth > emptyLayout.previewHeight
        && Math.abs(emptyLayout.previewRatio - 16 / 9) <= 0.03
        && emptyLayout.placeholderCenterError <= 2
        && emptyLayout.contained,
      `Empty cutter layout is stretched or displaced: ${JSON.stringify(emptyLayout)}`
    );
    await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'empty.png') });
    await setViewportSize({ width: 2048, height: 1152 });
    const emptyFullscreenLayout = await win.evaluate(() => {
      const preview = document.getElementById('cutterPreview').getBoundingClientRect();
      const placeholder = document.getElementById('cutterPreviewEmpty').getBoundingClientRect();
      const tab = document.getElementById('cutterTab').getBoundingClientRect();
      return {
        previewWidth: preview.width,
        previewHeight: preview.height,
        previewRatio: preview.width / preview.height,
        placeholderCenterError: Math.max(
          Math.abs(placeholder.left + placeholder.width / 2 - (preview.left + preview.width / 2)),
          Math.abs(placeholder.top + placeholder.height / 2 - (preview.top + preview.height / 2))
        ),
        contained: preview.bottom <= Math.min(tab.bottom, window.innerHeight) + 1
      };
    });
    check(
      emptyFullscreenLayout.previewHeight >= 500
        && emptyFullscreenLayout.previewWidth > emptyFullscreenLayout.previewHeight
        && Math.abs(emptyFullscreenLayout.previewRatio - 16 / 9) <= 0.03
        && emptyFullscreenLayout.placeholderCenterError <= 2
        && emptyFullscreenLayout.contained,
      `Fullscreen empty cutter layout is stretched or displaced: ${JSON.stringify(emptyFullscreenLayout)}`
    );
    await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'empty-fullscreen.png') });
    await setViewportSize({ width: 1440, height: 900 });
    const emptyVolumeBefore = await win.evaluate(() => ({
      width: document.getElementById('cutterVolume').getBoundingClientRect().width,
      timeLeft: document.querySelector('.cutter-player-time').getBoundingClientRect().left,
      disabled: document.getElementById('cutterVolume').disabled,
      containerDisabled: document.querySelector('.cutter-volume-control').getAttribute('aria-disabled')
    }));
    const emptyMuteButton = await win.locator('#cutterMuteBtn').boundingBox();
    await win.mouse.move(emptyMuteButton.x + emptyMuteButton.width / 2, emptyMuteButton.y + emptyMuteButton.height / 2);
    await win.waitForTimeout(260);
    const emptyVolumeAfter = await win.evaluate(() => ({
      width: document.getElementById('cutterVolume').getBoundingClientRect().width,
      timeLeft: document.querySelector('.cutter-player-time').getBoundingClientRect().left
    }));
    check(
      emptyVolumeBefore.disabled
        && emptyVolumeBefore.containerDisabled === 'true'
        && emptyVolumeAfter.width <= emptyVolumeBefore.width + 0.5
        && Math.abs(emptyVolumeAfter.timeLeft - emptyVolumeBefore.timeLeft) <= 0.5,
      `Disabled empty-player volume control still expands on hover: ${JSON.stringify({ emptyVolumeBefore, emptyVolumeAfter })}`
    );
    if (process.env.TWITCH_VOD_MANAGER_CUTTER_EMPTY_ONLY === '1') {
      console.log(JSON.stringify({ failures, runtimeIssues, emptyLayout, emptyFullscreenLayout, emptyVolumeBefore, emptyVolumeAfter }, null, 2));
      if (failures.length > 0) process.exitCode = 1;
      return;
    }
    const firstAssetsStartedAt = Date.now();
    const inputCapability = await createCutterCapability(win, inputFile);
    const initialOriginalDevicePixelRatio = await win.evaluate((fileCapability) => {
      const originalDevicePixelRatio = window.devicePixelRatio;
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
      const workspace = document.getElementById('cutterWorkspace');
      const preview = document.getElementById('cutterPreview');
      const previewPanel = document.querySelector('.cutter-preview-panel');
      const sidebar = document.querySelector('.cutter-sidebar');
      const timeline = document.getElementById('timelineContainer');
      const info = document.getElementById('cutterInfo');
      window.__cutterRevealFrames = [];
      window.__cutterAssetAudit = { thumbnailSets: [], waveformLoads: [] };
      const sampleReveal = () => {
        const rect = preview.getBoundingClientRect();
        const animations = [previewPanel, sidebar, timeline, info].flatMap((element) => element.getAnimations());
        window.__cutterRevealFrames.push({
          width: rect.width,
          height: rect.height,
          left: rect.left,
          top: rect.top,
          running: animations.some((animation) => animation.playState === 'running')
        });
        if ((animations.some((animation) => animation.playState === 'running') || window.__cutterRevealFrames.length < 4) && window.__cutterRevealFrames.length < 90) {
          requestAnimationFrame(sampleReveal);
        }
      };
      const workspaceObserver = new MutationObserver(() => {
        if (!workspace.classList.contains('shown')) return;
        workspaceObserver.disconnect();
        requestAnimationFrame(sampleReveal);
      });
      workspaceObserver.observe(workspace, { attributes: true, attributeFilter: ['class'] });
      let thumbnailAuditFrame = null;
      const thumbnailObserver = new MutationObserver(() => {
        if (thumbnailAuditFrame !== null) cancelAnimationFrame(thumbnailAuditFrame);
        thumbnailAuditFrame = requestAnimationFrame(async () => {
          thumbnailAuditFrame = null;
          const strip = document.getElementById('cutterThumbnailStrip');
          const images = [...strip.querySelectorAll('img')];
          if (images.length === 0) return;
          await Promise.all(images.map((image) => image.decode()));
          const signature = images.map((image) => `${image.src.length}:${image.src.slice(-24)}`).join('|');
          if (window.__cutterAssetAudit.thumbnailSets.at(-1)?.signature === signature) return;
          window.__cutterAssetAudit.thumbnailSets.push({
            signature,
            count: Number(strip.dataset.thumbnailCount || images.length),
            imageNodes: images.length,
            minimumWidth: Math.min(...images.map((image) => image.naturalWidth)),
            minimumHeight: Math.min(...images.map((image) => image.naturalHeight))
          });
        });
      });
      thumbnailObserver.observe(document.getElementById('cutterThumbnailStrip'), { childList: true });
      document.getElementById('cutterWaveform').addEventListener('load', (event) => {
        const image = event.currentTarget;
        const signature = `${image.src.length}:${image.src.slice(-24)}`;
        if (window.__cutterAssetAudit.waveformLoads.at(-1)?.signature === signature) return;
        window.__cutterAssetAudit.waveformLoads.push({ signature, width: image.naturalWidth, height: image.naturalHeight });
      });
      window.__cutterLoadPromise = window.loadCutterFromPath(fileCapability);
      return originalDevicePixelRatio;
    }, inputCapability);
    await win.waitForFunction(() => document.getElementById('cutterWorkspace').classList.contains('shown'), null, { timeout: 15000 });
    await win.evaluate(() => window.__cutterLoadPromise);
    await win.waitForFunction(() => {
      const video = document.getElementById('cutterVideo');
      return video instanceof HTMLVideoElement
        && video.readyState >= HTMLMediaElement.HAVE_METADATA
        && document.querySelectorAll('#cutterThumbnailStrip img').length > 0
        && window.__cutterAssetAudit.waveformLoads.length > 0;
    }, null, { timeout: 90000 });
    await win.waitForTimeout(480);
    const revealAnimation = await win.evaluate(() => {
      const preview = document.getElementById('cutterPreview').getBoundingClientRect();
      const frames = window.__cutterRevealFrames;
      return {
        frames: frames.length,
        runningFrames: frames.filter((frame) => frame.running).length,
        distinctWidths: new Set(frames.map((frame) => frame.width.toFixed(1))).size,
        distinctHeights: new Set(frames.map((frame) => frame.height.toFixed(1))).size,
        intermediate: frames.some((frame) => {
          const widthMin = Math.min(frames[0].width, preview.width);
          const widthMax = Math.max(frames[0].width, preview.width);
          const heightMin = Math.min(frames[0].height, preview.height);
          const heightMax = Math.max(frames[0].height, preview.height);
          return frame.width > widthMin + 2 && frame.width < widthMax - 2
            && frame.height > heightMin + 2 && frame.height < heightMax - 2;
        }),
        finalWidth: preview.width,
        finalHeight: preview.height,
        lastWidth: frames.at(-1)?.width ?? null,
        lastHeight: frames.at(-1)?.height ?? null
      };
    });
    check(
      revealAnimation.frames >= 4
        && revealAnimation.runningFrames >= 3
        && revealAnimation.distinctWidths >= 3
        && revealAnimation.distinctHeights >= 3
        && revealAnimation.intermediate
        && Math.abs(revealAnimation.lastWidth - revealAnimation.finalWidth) <= 2
        && Math.abs(revealAnimation.lastHeight - revealAnimation.finalHeight) <= 2,
      `Empty-to-editor geometry does not glide through visible frames: ${JSON.stringify(revealAnimation)}`
    );
    const firstAssetQuality = await win.evaluate(async () => {
      const images = [...document.querySelectorAll('#cutterThumbnailStrip img')];
      const strip = document.getElementById('cutterThumbnailStrip');
      const tiles = [...strip.querySelectorAll('img:not(.cutter-thumbnail-sprite), .cutter-thumbnail-tile')];
      const waveform = document.getElementById('cutterWaveform');
      await Promise.all([...images, waveform].map((image) => image.decode()));
      const timeline = document.getElementById('timeline');
      const targetWidth = Math.min(32000, Math.ceil(timeline.getBoundingClientRect().width * window.devicePixelRatio));
      const firstFrameRect = images[0].getBoundingClientRect();
      return {
        targetWidth,
        devicePixelRatio: window.devicePixelRatio,
        thumbnailCount: Number(strip.dataset.thumbnailCount || images.length),
        imageNodes: images.length,
        renderedFrames: Number(strip.dataset.renderedFrameCount || 0),
        renderedFrameIndexes: (strip.dataset.renderedFrameIndexes || '').split(',').filter(Boolean).map(Number),
        framePixelWidth: Number(strip.dataset.framePixelWidth || 0),
        canvasPixelWidth: Number(strip.dataset.renderedPixelWidth || 0),
        canvasCssWidth: tiles.reduce((total, tile) => total + tile.getBoundingClientRect().width, 0),
        thumbnailPixelWidth: images.length === 1 ? images[0].naturalWidth : images.reduce((total, image) => total + image.naturalWidth, 0),
        thumbnailPixelHeight: images.length === 1 ? images[0].naturalHeight : Math.min(...images.map((image) => image.naturalHeight)),
        minimumThumbnailWidth: Math.min(...images.map((image) => image.naturalWidth)),
        minimumThumbnailHeight: Math.min(...images.map((image) => image.naturalHeight)),
        frameCssWidth: firstFrameRect.width,
        frameCssHeight: firstFrameRect.height,
        frameCssRatio: firstFrameRect.width / firstFrameRect.height,
        frameNaturalRatio: images[0].naturalWidth / images[0].naturalHeight,
        frameFractionalWidth: Math.abs(firstFrameRect.width - Math.round(firstFrameRect.width)),
        waveformWidth: waveform.naturalWidth,
        waveformHeight: waveform.naturalHeight,
        videoTrackHeight: document.getElementById('cutterVideoTrack').getBoundingClientRect().height,
        audioTrackHeight: document.getElementById('cutterAudioTrack').getBoundingClientRect().height
      };
    });
    check(
      firstAssetQuality.devicePixelRatio === 2
        && firstAssetQuality.thumbnailCount >= 190
        && firstAssetQuality.imageNodes === firstAssetQuality.renderedFrames
        && firstAssetQuality.renderedFrames >= 8
        && firstAssetQuality.renderedFrames < 30
        && firstAssetQuality.framePixelWidth > 0
        && firstAssetQuality.framePixelWidth <= 320
        && firstAssetQuality.canvasPixelWidth >= firstAssetQuality.canvasCssWidth * 2 - 1
        && firstAssetQuality.thumbnailPixelWidth >= firstAssetQuality.renderedFrames * 320
        && firstAssetQuality.thumbnailPixelHeight >= 180
        && firstAssetQuality.minimumThumbnailHeight >= firstAssetQuality.videoTrackHeight * 2
        && firstAssetQuality.frameCssWidth >= 95
        && Math.abs(firstAssetQuality.frameCssRatio - firstAssetQuality.frameNaturalRatio) <= 0.02
        && firstAssetQuality.frameFractionalWidth <= 0.05
        && firstAssetQuality.waveformWidth >= 31900
        && firstAssetQuality.waveformHeight >= firstAssetQuality.audioTrackHeight * 2,
      `The first visible timeline assets are not final DPR2 quality: ${JSON.stringify(firstAssetQuality)}`
    );
    const firstAssetsReadyMs = Date.now() - firstAssetsStartedAt;
    check(firstAssetsReadyMs < 2000 * mediaTimingScale, `Short video kept the first sharp timeline empty for ${firstAssetsReadyMs}ms`);
    const initialAssetStability = await win.evaluate(() => {
      const audit = window.__cutterAssetAudit;
      return {
        thumbnailSets: audit.thumbnailSets.length,
        waveformLoads: audit.waveformLoads.length,
        thumbnailCounts: audit.thumbnailSets.map((entry) => entry.count),
        waveformWidths: audit.waveformLoads.map((entry) => entry.width)
      };
    });
    check(
      initialAssetStability.thumbnailSets === 1 && initialAssetStability.waveformLoads === 1,
      `Timeline assets visibly switch quality before an explicit zoom: ${JSON.stringify(initialAssetStability)}`
    );
    await win.evaluate(() => window.updateCutterZoom(Number(document.getElementById('cutterZoom').max)));
    await win.waitForFunction(() => {
      const waveform = document.getElementById('cutterWaveform');
      const scroll = document.getElementById('cutterTimelineScroll');
      const targetWidth = Math.min(32000, Math.ceil(scroll.clientWidth * Number(document.getElementById('cutterZoom').max) * window.devicePixelRatio));
      return waveform.complete && waveform.naturalWidth >= targetWidth - 1;
    }, null, { timeout: 90000 });
    await win.waitForTimeout(500);
    await win.evaluate((originalDevicePixelRatio) => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: originalDevicePixelRatio });
      window.updateCutterZoom(1);
    }, initialOriginalDevicePixelRatio);
    await setViewportSize({ width: 1060, height: 700 });
    await win.evaluate(() => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
      window.updateCutterZoom(1);
    });
    await win.waitForFunction(() => {
      const image = document.querySelector('#cutterThumbnailStrip img');
      const waveform = document.getElementById('cutterWaveform');
      const track = document.getElementById('cutterVideoTrack');
      const audioTrack = document.getElementById('cutterAudioTrack');
      return typeof cutterAssetsPixelHeight === 'number'
        && cutterAssetsPixelHeight >= track.getBoundingClientRect().height * window.devicePixelRatio
        && image?.complete
        && image.naturalHeight >= track.getBoundingClientRect().height * window.devicePixelRatio
        && waveform.complete
        && waveform.naturalHeight >= audioTrack.getBoundingClientRect().height * window.devicePixelRatio;
    }, null, { timeout: 15000 });
    const verticalProfileQuality = await win.evaluate(() => {
      const image = document.querySelector('#cutterThumbnailStrip img');
      const waveform = document.getElementById('cutterWaveform');
      const targetHeight = Math.ceil(document.getElementById('cutterVideoTrack').getBoundingClientRect().height * window.devicePixelRatio);
      const waveformTargetHeight = Math.ceil(document.getElementById('cutterAudioTrack').getBoundingClientRect().height * window.devicePixelRatio);
      return {
        targetHeight,
        waveformTargetHeight,
        assetHeight: cutterAssetsPixelHeight,
        imageHeight: image?.naturalHeight || 0,
        waveformHeight: waveform.naturalHeight
      };
    });
    check(verticalProfileQuality.assetHeight >= verticalProfileQuality.targetHeight && verticalProfileQuality.imageHeight >= verticalProfileQuality.targetHeight && verticalProfileQuality.waveformHeight >= verticalProfileQuality.waveformTargetHeight, `Timeline assets do not refresh for a taller DPR3 track: ${JSON.stringify(verticalProfileQuality)}`);
    await win.evaluate((originalDevicePixelRatio) => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: originalDevicePixelRatio });
    }, initialOriginalDevicePixelRatio);
    await setViewportSize({ width: 1440, height: 900 });
    await win.evaluate(() => window.updateCutterZoom(1));
    const loaded = await win.evaluate(() => {
      const video = document.getElementById('cutterVideo');
      const container = document.querySelector('.cutter-container').getBoundingClientRect();
      const tab = document.getElementById('cutterTab').getBoundingClientRect();
      const workspace = document.getElementById('cutterWorkspace').getBoundingClientRect();
      const preview = document.getElementById('cutterPreview').getBoundingClientRect();
      return {
        readyState: video.readyState,
        error: video.error?.message || null,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        thumbnails: Number(document.getElementById('cutterThumbnailStrip').dataset.thumbnailCount || document.querySelectorAll('#cutterThumbnailStrip img').length),
        waveform: !document.getElementById('cutterWaveform').hidden,
        widthRatio: container.width / tab.width,
        previewWidth: preview.width,
        previewWidthRatio: preview.width / workspace.width
      };
    });
    check(loaded.readyState >= 1 && !loaded.error, `Player failed to load: ${JSON.stringify(loaded)}`);
    check(Math.abs(loaded.duration - 10) < 0.1 && loaded.width === 640 && loaded.height === 360, `Unexpected media metadata: ${JSON.stringify(loaded)}`);
    check(loaded.thumbnails >= 30 && loaded.waveform, `Timeline media is incomplete: ${JSON.stringify(loaded)}`);
    check(loaded.widthRatio > 0.9, `Cutter does not use the workspace width: ${loaded.widthRatio}`);
    check(loaded.previewWidth >= 700 && loaded.previewWidthRatio >= 0.65, `Loaded player is unexpectedly narrow: ${JSON.stringify(loaded)}`);
    const edgeGeometry = await win.evaluate(() => {
      const timeline = document.getElementById('timeline').getBoundingClientRect();
      const startHandle = document.getElementById('cutterTrimStartHandle').getBoundingClientRect();
      const endHandle = document.getElementById('cutterTrimEndHandle').getBoundingClientRect();
      const ticks = [...document.querySelectorAll('.cutter-ruler-tick')];
      const firstTick = ticks[0].getBoundingClientRect();
      const lastTick = ticks[ticks.length - 1].getBoundingClientRect();
      const trackLabels = [...document.querySelectorAll('.cutter-track-label')].map((label) => ({
        left: label.getBoundingClientRect().left,
        text: label.textContent
      }));
      return {
        startHandle: { left: startHandle.left, right: startHandle.right, width: startHandle.width },
        endHandle: { left: endHandle.left, right: endHandle.right, width: endHandle.width },
        firstTick: { left: firstTick.left, right: firstTick.right, text: ticks[0].textContent },
        lastTick: { left: lastTick.left, right: lastTick.right, text: ticks[ticks.length - 1].textContent },
        trackLabels,
        timeline: { left: timeline.left, right: timeline.right }
      };
    });
    check(
      edgeGeometry.startHandle.width >= 12
        && edgeGeometry.endHandle.width >= 12
        && edgeGeometry.startHandle.left >= edgeGeometry.timeline.left - 0.5
        && edgeGeometry.endHandle.right <= edgeGeometry.timeline.right + 0.5
        && edgeGeometry.firstTick.left >= edgeGeometry.timeline.left - 0.5
        && edgeGeometry.lastTick.right <= edgeGeometry.timeline.right + 0.5,
      `Timeline edge controls or labels are clipped: ${JSON.stringify(edgeGeometry)}`
    );
    check(
      edgeGeometry.trackLabels.length === 2
        && edgeGeometry.trackLabels.map((label) => label.text).join('|') === 'VIDEO|AUDIO'
        && edgeGeometry.trackLabels.every((label) => label.left >= edgeGeometry.startHandle.right + 7),
      `Timeline track labels overlap the left trim handle: ${JSON.stringify(edgeGeometry)}`
    );
    const timestampTypography = await win.evaluate(() => {
      const player = getComputedStyle(document.querySelector('.cutter-player-time'));
      const ruler = getComputedStyle(document.querySelector('.cutter-ruler-tick'));
      return {
        playerFontSize: Number.parseFloat(player.fontSize),
        playerLineHeight: Number.parseFloat(player.lineHeight),
        rulerFontSize: Number.parseFloat(ruler.fontSize),
        rulerLineHeight: Number.parseFloat(ruler.lineHeight)
      };
    });
    check(
      timestampTypography.playerFontSize >= 12
        && timestampTypography.playerLineHeight >= 16
        && timestampTypography.rulerFontSize >= 12
        && timestampTypography.rulerLineHeight >= 14,
      `Cutter timestamps are too small: ${JSON.stringify(timestampTypography)}`
    );
    const playerControlGeometry = await win.evaluate(() => {
      const buttons = [...document.querySelectorAll('.cutter-player-button')].map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      const skipNumber = getComputedStyle(document.querySelector('.cutter-skip-button span'));
      const skipButtons = [...document.querySelectorAll('.cutter-skip-button')].map((button) => {
        const icon = button.querySelector('svg').getBoundingClientRect();
        const number = button.querySelector('span').getBoundingClientRect();
        return {
          iconWidth: icon.width,
          iconHeight: icon.height,
          centerErrorX: Math.abs(icon.left + icon.width / 2 - (number.left + number.width / 2)),
          centerErrorY: Math.abs(icon.top + icon.height / 2 - (number.top + number.height / 2))
        };
      });
      return {
        buttons,
        skipButtons,
        skipNumberFontSize: Number.parseFloat(skipNumber.fontSize),
        skipNumberLineHeight: Number.parseFloat(skipNumber.lineHeight)
      };
    });
    check(
      playerControlGeometry.buttons.every((button) => button.height >= 34.5 && button.width >= 34.5)
        && playerControlGeometry.skipButtons.every((button) => button.iconWidth >= 25.4 && button.iconHeight >= 25.4 && button.centerErrorX <= 0.75 && button.centerErrorY <= 0.75)
        && playerControlGeometry.skipNumberFontSize >= 8
        && playerControlGeometry.skipNumberLineHeight >= 8,
      `Player controls are not clearly legible: ${JSON.stringify(playerControlGeometry)}`
    );
    const cutterInfoAlignment = await win.evaluate(() => {
      const items = [...document.querySelectorAll('.cutter-info-item')];
      const labels = items.map((item) => item.querySelector('.cutter-info-label').getBoundingClientRect());
      const values = items.map((item) => item.querySelector('.cutter-info-value').getBoundingClientRect());
      const labelStyles = items.map((item) => getComputedStyle(item.querySelector('.cutter-info-label')));
      const valueStyles = items.map((item) => getComputedStyle(item.querySelector('.cutter-info-value')));
      const spread = (values) => Math.max(...values) - Math.min(...values);
      return {
        labelTopSpread: spread(labels.map((rect) => rect.top)),
        labelHeightSpread: spread(labels.map((rect) => rect.height)),
        valueTopSpread: spread(values.map((rect) => rect.top)),
        valueHeightSpread: spread(values.map((rect) => rect.height)),
        labelLineHeights: labelStyles.map((style) => Number.parseFloat(style.lineHeight)),
        valueLineHeights: valueStyles.map((style) => Number.parseFloat(style.lineHeight))
      };
    });
    check(
      cutterInfoAlignment.labelTopSpread <= 0.25
        && cutterInfoAlignment.labelHeightSpread <= 0.25
        && cutterInfoAlignment.valueTopSpread <= 0.25
        && cutterInfoAlignment.valueHeightSpread <= 0.25
        && cutterInfoAlignment.labelLineHeights.every(Number.isFinite)
        && cutterInfoAlignment.valueLineHeights.every(Number.isFinite),
      `Cutter information labels and values are not aligned to common rows: ${JSON.stringify(cutterInfoAlignment)}`
    );
    const replacementCapability = await createCutterCapability(win, scrubStressInputFile);
    await app.evaluate(({ ipcMain }, nextFile) => {
      ipcMain.removeHandler('select-video-file');
      ipcMain.handle('select-video-file', () => nextFile);
    }, replacementCapability);
    await win.evaluate(() => {
      cutterEditorState.trimStart = 1;
      renderCutterEditor();
    });
    const editorBeforeReplacement = await win.evaluate(() => ({
      trimStart: cutterEditorState.trimStart,
      trimEnd: cutterEditorState.trimEnd,
      cuts: JSON.stringify(cutterEditorState.cuts),
      historyPast: cutterHistoryPast.length,
      historyFuture: cutterHistoryFuture.length
    }));
    await win.locator('#cutterPlayBtn').click();
    await win.waitForFunction(() => !document.getElementById('cutterVideo').paused);
    const originalCutterPath = await win.locator('#cutterFilePath').inputValue();
    await win.locator('.toolbar-context[data-toolbar-for="cutter"] .toolbar-primary').click();
    await win.waitForTimeout(250);
    replacementPromptState = await win.evaluate((originalPath) => {
      const modal = document.getElementById('cutterDiscardModal');
      const cancelStyle = getComputedStyle(document.getElementById('cutterDiscardCancelBtn'));
      const confirmStyle = getComputedStyle(document.getElementById('cutterDiscardConfirmBtn'));
      return {
        exists: Boolean(modal),
        shown: Boolean(modal?.classList.contains('show')),
        pathPreserved: document.getElementById('cutterFilePath').value === originalPath,
        videoPlaying: !document.getElementById('cutterVideo').paused,
        backgroundInert: document.querySelector('.workspace-shell').inert,
        focusInside: modal?.contains(document.activeElement) || false,
        cancelBackground: cancelStyle.backgroundColor,
        cancelText: cancelStyle.color,
        confirmBackground: confirmStyle.backgroundColor,
        confirmText: confirmStyle.color
      };
    }, originalCutterPath);
    check(replacementPromptState.exists && replacementPromptState.shown && replacementPromptState.pathPreserved && replacementPromptState.backgroundInert && replacementPromptState.focusInside, `Replacing a loaded video does not wait in an accessible discard confirmation: ${JSON.stringify(replacementPromptState)}`);
    check(replacementPromptState.cancelBackground === 'rgb(186, 208, 252)' && replacementPromptState.cancelText === 'rgb(0, 0, 0)' && replacementPromptState.confirmBackground === 'rgb(239, 125, 125)' && replacementPromptState.confirmText === 'rgb(0, 0, 0)', `Discard dialog actions do not use the requested blue/red surfaces with black text: ${JSON.stringify(replacementPromptState)}`);
    if (replacementPromptState.exists && replacementPromptState.shown) {
      await win.keyboard.press('Shift+Tab');
      const reverseTrapped = await win.evaluate(() => document.activeElement === document.getElementById('cutterDiscardConfirmBtn'));
      await win.keyboard.press('Tab');
      const forwardTrapped = await win.evaluate(() => document.activeElement === document.getElementById('cutterDiscardCancelBtn'));
      check(reverseTrapped && forwardTrapped, `Discard dialog does not trap keyboard focus: ${JSON.stringify({ reverseTrapped, forwardTrapped })}`);
      await win.locator('#cutterDiscardCancelBtn').click();
      await win.waitForFunction((originalPath) => !document.getElementById('cutterDiscardModal').classList.contains('show') && document.getElementById('cutterFilePath').value === originalPath, originalCutterPath);
      await win.waitForTimeout(100);
      const editorAfterCancel = await win.evaluate(() => ({
        trimStart: cutterEditorState.trimStart,
        trimEnd: cutterEditorState.trimEnd,
        cuts: JSON.stringify(cutterEditorState.cuts),
        historyPast: cutterHistoryPast.length,
        historyFuture: cutterHistoryFuture.length,
        videoPlaying: !document.getElementById('cutterVideo').paused,
        backgroundInert: document.querySelector('.workspace-shell').inert,
        focusReturned: Boolean(document.activeElement?.closest('.toolbar-context[data-toolbar-for="cutter"] .toolbar-primary'))
      }));
      check(JSON.stringify({ ...editorAfterCancel, videoPlaying: undefined, backgroundInert: undefined, focusReturned: undefined }) === JSON.stringify({ ...editorBeforeReplacement, videoPlaying: undefined, backgroundInert: undefined, focusReturned: undefined }) && editorAfterCancel.videoPlaying && !editorAfterCancel.backgroundInert && editorAfterCancel.focusReturned, `Cancelling video replacement changed the current edit or focus: ${JSON.stringify({ editorBeforeReplacement, editorAfterCancel })}`);
      await win.locator('.toolbar-context[data-toolbar-for="cutter"] .toolbar-primary').click();
      await win.waitForFunction(() => document.getElementById('cutterDiscardModal').classList.contains('show'));
      await win.locator('#cutterDiscardConfirmBtn').click();
      await win.waitForFunction((nextName) => document.getElementById('cutterFilePath').value === nextName && document.getElementById('cutterVideo').readyState >= HTMLMediaElement.HAVE_METADATA, path.basename(scrubStressInputFile));
      replacementPlaybackState = await win.evaluate(() => {
        const preview = document.getElementById('cutterPreview');
        const playIcon = document.querySelector('#cutterPlayBtn .cutter-play-icon');
        const pauseIcon = document.querySelector('#cutterPlayBtn .cutter-pause-icon');
        return {
          paused: document.getElementById('cutterVideo').paused,
          playingClass: preview.classList.contains('playing'),
          playIconVisible: getComputedStyle(playIcon).display !== 'none',
          pauseIconVisible: getComputedStyle(pauseIcon).display !== 'none',
          ariaLabel: document.getElementById('cutterPlayBtn').getAttribute('aria-label')
        };
      });
      check(replacementPlaybackState.paused && !replacementPlaybackState.playingClass && replacementPlaybackState.playIconVisible && !replacementPlaybackState.pauseIconVisible, `Replacing a playing video leaves stale playback UI: ${JSON.stringify(replacementPlaybackState)}`);
    }
    const scrubFirstAssetsStartedAt = Date.now();
    await loadCutterCapability(win, scrubStressInputFile);
    await win.waitForFunction(() => {
      const video = document.getElementById('cutterVideo');
      return video.readyState >= HTMLMediaElement.HAVE_METADATA && video.duration >= 8 && video.duration <= 10;
    }, null, { timeout: 15000 });
    const scrubMediaInfo = await win.evaluate(() => ({
      duration: document.getElementById('cutterVideo').duration,
      fps: cutterVideoInfo?.fps || 0
    }));
    check(
      Math.abs(scrubMediaInfo.duration - 8.746667) < 0.02 && Math.abs(scrubMediaInfo.fps - 60) < 0.1,
      `The required 8.75-second 60 FPS scrub clip was not loaded: ${JSON.stringify(scrubMediaInfo)}`
    );
    await win.waitForFunction(() => {
      const waveform = document.getElementById('cutterWaveform');
      const image = document.querySelector('#cutterThumbnailStrip img');
      return cutterAssetsPixelWidth > 0
        && Number(document.getElementById('cutterThumbnailStrip').dataset.thumbnailCount || document.querySelectorAll('#cutterThumbnailStrip img').length) >= 30
        && image?.complete
        && image.naturalWidth > 0
        && waveform.complete
        && waveform.naturalWidth > 0;
    }, null, { timeout: 15000 });
    await win.evaluate(async () => Promise.all([
      document.querySelector('#cutterThumbnailStrip img').decode(),
      document.getElementById('cutterWaveform').decode()
    ]));
    const scrubFirstAssetsReadyMs = Date.now() - scrubFirstAssetsStartedAt;
    const scrubFirstAssetQuality = await win.evaluate(() => {
      const timeline = document.getElementById('timeline');
      const waveform = document.getElementById('cutterWaveform');
      const images = [...document.querySelectorAll('#cutterThumbnailStrip img')];
      const targetWidth = Math.min(32000, Math.ceil(timeline.getBoundingClientRect().width * window.devicePixelRatio));
      const expectedPixelWidth = Math.max(1800, targetWidth);
      return {
        targetWidth,
        expectedPixelWidth,
        pixelWidth: cutterAssetsPixelWidth,
        waveformWidth: waveform.naturalWidth,
        imageNodes: images.length,
        thumbnailPixelWidth: images[0]?.naturalWidth || 0,
        thumbnailPixelHeight: images[0]?.naturalHeight || 0,
        thumbnailCount: Number(document.getElementById('cutterThumbnailStrip').dataset.thumbnailCount || document.querySelectorAll('#cutterThumbnailStrip img').length)
      };
    });
    check(
      scrubFirstAssetsReadyMs < 2000 * mediaTimingScale
        && scrubFirstAssetQuality.imageNodes >= 8
        && scrubFirstAssetQuality.pixelWidth >= 31900
        && scrubFirstAssetQuality.thumbnailPixelWidth >= 320
        && scrubFirstAssetQuality.thumbnailPixelHeight >= 180
        && scrubFirstAssetQuality.waveformWidth >= 31900,
      `Short moving media did not show a sharp timeline quickly: ${JSON.stringify({ scrubFirstAssetsReadyMs, scrubFirstAssetQuality })}`
    );
    if (process.env.TWITCH_VOD_MANAGER_SCRUB_MEDIA) {
      await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'real-clip-ready.png') });
      await win.evaluate(() => window.updateCutterZoom(Number(document.getElementById('cutterZoom').max)));
      await win.waitForTimeout(500);
      realMaximumZoomState = await win.evaluate(() => {
        const strip = document.getElementById('cutterThumbnailStrip');
        const images = [...strip.querySelectorAll('img')];
        return {
          zoom: Number(document.getElementById('cutterZoom').value),
          sourceCount: Number(strip.dataset.thumbnailCount || 0),
          renderedCount: Number(strip.dataset.renderedFrameCount || 0),
          imageNodes: images.length,
          stripWidth: strip.getBoundingClientRect().width,
          firstImageWidth: images[0]?.getBoundingClientRect().width || 0
        };
      });
      check(realMaximumZoomState.renderedCount >= 150 && realMaximumZoomState.imageNodes === realMaximumZoomState.renderedCount && realMaximumZoomState.firstImageWidth <= 100, `Real maximum zoom still stretches thumbnail frames: ${JSON.stringify(realMaximumZoomState)}`);
      await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'real-clip-maximum-zoom.png') });
      await win.evaluate(() => window.updateCutterZoom(1));
    }
    await win.evaluate(async () => {
      const video = document.getElementById('cutterVideo');
      video.pause();
      await new Promise((resolve) => {
        video.requestVideoFrameCallback(() => resolve());
        video.currentTime = video.duration * 0.86;
      });
      window.__cutterScrubSyncSamples = [];
      window.__cutterScrubSyncRecording = true;
      const parseTimecode = (value, fps) => {
        const fields = value.split(':').map(Number);
        return fields[0] * 60 + fields[1] + fields[2] / fps;
      };
      const recordFrame = (_now, metadata) => {
        if (!window.__cutterScrubSyncRecording) return;
        requestAnimationFrame(() => {
          if (!window.__cutterScrubSyncRecording) return;
          window.__cutterScrubSyncSamples.push({
            mediaTime: metadata.mediaTime,
            uiTime: parseTimecode(document.getElementById('cutterCurrentTime').textContent, 60)
          });
        });
        video.requestVideoFrameCallback(recordFrame);
      };
      video.requestVideoFrameCallback(recordFrame);
    });
    const scrubStressTimeline = await win.locator('#timeline').boundingBox();
    const scrubStressY = scrubStressTimeline.y + scrubStressTimeline.height * 0.45;
    const scrubStressStartX = scrubStressTimeline.x + scrubStressTimeline.width * 0.86;
    const scrubStressEndX = scrubStressTimeline.x + scrubStressTimeline.width * 0.2;
    const scrubCursorErrors = [];
    await win.mouse.move(scrubStressStartX, scrubStressY);
    await win.mouse.down();
    for (let step = 1; step <= 60; step += 1) {
      const targetX = scrubStressStartX + (scrubStressEndX - scrubStressStartX) * step / 60;
      await win.mouse.move(targetX, scrubStressY);
      // Measure response after Chromium receives the injected pointer event.
      await win.waitForFunction((x) => Math.abs(window.__cutterLatestPointerX - x) <= 1, targetX);
      await win.waitForTimeout(15);
      const cursorX = await win.locator('#timelineCurrent').evaluate((element) => element.getBoundingClientRect().left);
      scrubCursorErrors.push(Math.abs(cursorX - targetX));
    }
    await win.mouse.up();
    await win.waitForTimeout(1500);
    const scrubSyncProbe = await win.evaluate(() => {
      window.__cutterScrubSyncRecording = false;
      const samples = window.__cutterScrubSyncSamples;
      const backwardFrames = samples.slice(1).filter((sample, index) => sample.mediaTime < samples[index].mediaTime - 1 / 120).length;
      const maximumDesync = samples.length ? Math.max(...samples.map((sample) => Math.abs(sample.mediaTime - sample.uiTime))) : null;
      const result = {
        frames: samples.length,
        backwardFrames,
        maximumDesync,
        firstMediaTime: samples[0]?.mediaTime ?? null,
        lastMediaTime: samples.at(-1)?.mediaTime ?? null,
        finalUiTime: samples.at(-1)?.uiTime ?? null,
        expectedEnd: document.getElementById('cutterVideo').duration * 0.2
      };
      delete window.__cutterScrubSyncSamples;
      delete window.__cutterScrubSyncRecording;
      return result;
    });
    scrubCursorErrors.sort((left, right) => left - right);
    scrubSyncProbe.maximumCursorError = scrubCursorErrors.at(-1) ?? null;
    scrubSyncProbe.p95CursorError = scrubCursorErrors[Math.min(scrubCursorErrors.length - 1, Math.floor(scrubCursorErrors.length * 0.95))] ?? null;
    scrubSyncProbe.finalCursorError = Math.abs((await win.locator('#timelineCurrent').evaluate((element) => element.getBoundingClientRect().left)) - scrubStressEndX);
    check(
      scrubSyncProbe.frames >= 8
        && scrubSyncProbe.backwardFrames >= 6
        && scrubSyncProbe.maximumDesync !== null
        && scrubSyncProbe.maximumDesync <= 2 / 60
        && Math.abs(scrubSyncProbe.lastMediaTime - scrubSyncProbe.expectedEnd) <= 2 / 60,
      `Backward scrubbing is not synchronized to presented frames: ${JSON.stringify(scrubSyncProbe)}`
    );
    check(
      scrubSyncProbe.maximumCursorError !== null
        && scrubSyncProbe.maximumCursorError <= 3
        && scrubSyncProbe.finalCursorError <= 2,
      `Scrub cursor does not follow the pointer immediately: ${JSON.stringify(scrubSyncProbe)}`
    );
    await win.evaluate(() => {
      const video = document.getElementById('cutterVideo');
      window.__cutterTrimSyncSamples = [];
      window.__cutterTrimSyncRecording = true;
      const parseTimecode = (value, fps) => {
        const fields = value.split(':').map(Number);
        return fields[0] * 60 + fields[1] + fields[2] / fps;
      };
      const recordFrame = (_now, metadata) => {
        if (!window.__cutterTrimSyncRecording) return;
        requestAnimationFrame(() => {
          if (!window.__cutterTrimSyncRecording) return;
          window.__cutterTrimSyncSamples.push({
            mediaTime: metadata.mediaTime,
            uiTime: parseTimecode(document.getElementById('cutterCurrentTime').textContent, 60)
          });
        });
        video.requestVideoFrameCallback(recordFrame);
      };
      video.requestVideoFrameCallback(recordFrame);
    });
    const trimStressHandle = await win.locator('#cutterTrimStartHandle').boundingBox();
    const trimStressY = trimStressHandle.y + trimStressHandle.height / 2;
    const trimStressStartX = trimStressHandle.x + trimStressHandle.width / 2;
    const trimStressTurnX = scrubStressTimeline.x + scrubStressTimeline.width * 0.72;
    const trimStressEndX = scrubStressTimeline.x + scrubStressTimeline.width * 0.2;
    const trimCursorErrors = [];
    await win.mouse.move(trimStressStartX, trimStressY);
    await win.mouse.down();
    for (let step = 1; step <= 24; step += 1) {
      await win.mouse.move(trimStressStartX + (trimStressTurnX - trimStressStartX) * step / 24, trimStressY);
      await win.waitForTimeout(15);
    }
    for (let step = 1; step <= 60; step += 1) {
      const targetX = trimStressTurnX + (trimStressEndX - trimStressTurnX) * step / 60;
      await win.mouse.move(targetX, trimStressY);
      await win.waitForFunction((x) => Math.abs(window.__cutterLatestPointerX - x) <= 1, targetX);
      await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      const handleCenter = await win.locator('#cutterTrimStartHandle').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left + rect.width / 2;
      });
      trimCursorErrors.push(Math.abs(handleCenter - targetX));
    }
    await win.mouse.up();
    await win.waitForTimeout(1500);
    const trimScrubProbe = await win.evaluate(() => {
      window.__cutterTrimSyncRecording = false;
      const samples = window.__cutterTrimSyncSamples;
      const backwardFrames = samples.slice(1).filter((sample, index) => sample.mediaTime < samples[index].mediaTime - 1 / 120).length;
      const maximumDesync = samples.length ? Math.max(...samples.map((sample) => Math.abs(sample.mediaTime - sample.uiTime))) : null;
      const result = {
        frames: samples.length,
        backwardFrames,
        maximumDesync,
        lastMediaTime: samples.at(-1)?.mediaTime ?? null,
        finalUiTime: samples.at(-1)?.uiTime ?? null,
        trimStart: cutterEditorState.trimStart
      };
      delete window.__cutterTrimSyncSamples;
      delete window.__cutterTrimSyncRecording;
      return result;
    });
    trimCursorErrors.sort((left, right) => left - right);
    trimScrubProbe.maximumCursorError = trimCursorErrors.at(-1) ?? null;
    trimScrubProbe.p95CursorError = trimCursorErrors[Math.min(trimCursorErrors.length - 1, Math.floor(trimCursorErrors.length * 0.95))] ?? null;
    check(
      trimScrubProbe.frames >= 8
        && trimScrubProbe.backwardFrames >= 6
        && trimScrubProbe.maximumDesync !== null
        && trimScrubProbe.maximumDesync <= 2 / 60
        && trimScrubProbe.maximumCursorError !== null
        && trimScrubProbe.maximumCursorError <= 3,
      `Trim handles are not as immediate and frame-synchronized as the playhead: ${JSON.stringify(trimScrubProbe)}`
    );
    const mediumLoadStarted = Date.now();
    await loadCutterCapability(win, mediumInputFile);
    await win.waitForFunction(() => {
      const video = document.getElementById('cutterVideo');
      const waveform = document.getElementById('cutterWaveform');
      return video.readyState >= HTMLMediaElement.HAVE_METADATA
        && Math.abs(video.duration - 58.020333) < 0.02
        && waveform.complete
        && waveform.naturalWidth >= 31900;
    }, null, { timeout: 15000 });
    await win.evaluate(() => document.getElementById('cutterWaveform').decode());
    const mediumWaveformReadyMs = Date.now() - mediumLoadStarted;
    await win.waitForFunction(() => {
      const video = document.getElementById('cutterVideo');
      const image = document.querySelector('#cutterThumbnailStrip img');
      const waveform = document.getElementById('cutterWaveform');
      return video.readyState >= HTMLMediaElement.HAVE_METADATA
        && Math.abs(video.duration - 58.020333) < 0.02
        && Number(document.getElementById('cutterThumbnailStrip').dataset.thumbnailCount || 0) >= 190
        && Number(document.getElementById('cutterThumbnailStrip').dataset.renderedFrameCount || 0) > 0
        && image?.complete
        && image.naturalWidth >= 320
        && image.naturalHeight >= 180
        && waveform.complete
        && waveform.naturalWidth >= 31900;
    }, null, { timeout: 15000 });
    await win.evaluate(async () => Promise.all([
      document.querySelector('#cutterThumbnailStrip img').decode(),
      document.getElementById('cutterWaveform').decode()
    ]));
    const mediumFirstAssetsReadyMs = Date.now() - mediumLoadStarted;
    if (process.env.TWITCH_VOD_MANAGER_MEDIUM_MEDIA) {
      await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'medium-clip-ready.png') });
    }
    check(mediumWaveformReadyMs < 1000 * mediaTimingScale, `The full-resolution 58-second waveform exceeded its waveform readiness budget: ${mediumWaveformReadyMs}ms`);
    const mediumZoomReuseBefore = await win.evaluate(() => ({
      thumbnailSource: document.querySelector('#cutterThumbnailStrip img').src,
      waveformSource: document.getElementById('cutterWaveform').src,
      thumbnailSets: window.__cutterAssetAudit.thumbnailSets.length,
      waveformLoads: window.__cutterAssetAudit.waveformLoads.length,
      requestGeneration: cutterAssetsRequestGeneration
    }));
    await win.evaluate(() => window.updateCutterZoom(Number(document.getElementById('cutterZoom').max)));
    await win.waitForTimeout(500);
    if (process.env.TWITCH_VOD_MANAGER_MEDIUM_MEDIA) {
      await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'medium-clip-maximum-zoom.png') });
    }
    const mediumZoomReuseAfter = await win.evaluate(() => ({
      thumbnailSource: document.querySelector('#cutterThumbnailStrip img').src,
      waveformSource: document.getElementById('cutterWaveform').src,
      thumbnailSets: window.__cutterAssetAudit.thumbnailSets.length,
      waveformLoads: window.__cutterAssetAudit.waveformLoads.length,
      requestGeneration: cutterAssetsRequestGeneration,
      assetsInFlight: cutterAssetsInFlightJobId
    }));
    check(mediumFirstAssetsReadyMs < 2500 * mediaTimingScale, `The 58-second timeline exceeded its sharp timeline readiness budget: ${mediumFirstAssetsReadyMs}ms`);
    check(
      mediumZoomReuseAfter.thumbnailSource === mediumZoomReuseBefore.thumbnailSource
        && mediumZoomReuseAfter.waveformSource === mediumZoomReuseBefore.waveformSource
        && mediumZoomReuseAfter.waveformLoads === mediumZoomReuseBefore.waveformLoads
        && mediumZoomReuseAfter.requestGeneration === mediumZoomReuseBefore.requestGeneration
        && mediumZoomReuseAfter.assetsInFlight === null,
      `The 58-second timeline regenerated assets after zoom: ${JSON.stringify({ mediumZoomReuseBefore, mediumZoomReuseAfter })}`
    );
    const memoryBeforeStressMb = getProcessTreeMemoryMb(app.process().pid);
    const longLoadStarted = Date.now();
    const longCapability = await loadCutterCapability(win, longInputFile);
    await win.waitForFunction(() => {
      const video = document.getElementById('cutterVideo');
      return video.readyState >= HTMLMediaElement.HAVE_METADATA && Math.abs(video.duration - 1800) < 1;
    }, null, { timeout: 15000 });
    const longPlayerReadyMs = Date.now() - longLoadStarted;
    check(longPlayerReadyMs < 10000, `Long video blocked player readiness for ${longPlayerReadyMs}ms`);
    await win.evaluate(() => window.showTab('vods'));
    await win.waitForTimeout(80);
    await win.evaluate(() => window.showTab('cutter'));
    const unsupportedCapability = { token: 'forged-unsupported-capability', name: path.basename(unsupportedInputFile) };
    await win.evaluate((capability) => window.loadCutterFromPath(capability), unsupportedCapability);
    await win.waitForFunction(() => !document.getElementById('cutterWorkspace').classList.contains('loading'));
    const longPreservedAfterAssetInterruptions = await win.evaluate((expectedToken) => cutterFile?.token === expectedToken, longCapability.token);
    check(longPreservedAfterAssetInterruptions, 'Long editor was replaced after an interrupted asset load and unsupported file selection');
    await win.waitForFunction(() => Number(document.getElementById('cutterThumbnailStrip').dataset.thumbnailCount || document.querySelectorAll('#cutterThumbnailStrip img').length) >= 30, null, { timeout: 90000 });
    const longAssetsReadyMs = Date.now() - longLoadStarted;
    const longAssetTopology = await win.evaluate(() => {
      const strip = document.getElementById('cutterThumbnailStrip');
      const images = [...strip.querySelectorAll('img')];
      return {
        semanticCount: Number(strip.dataset.thumbnailCount || images.length),
        imageNodes: images.length,
        sprite: Boolean(strip.querySelector('.cutter-thumbnail-sprite'))
      };
    });
    check(
      longAssetTopology.semanticCount >= 30
        && longAssetTopology.imageNodes >= 8
        && longAssetTopology.imageNodes <= longAssetTopology.semanticCount
        && !longAssetTopology.sprite,
      `Long-video seek thumbnails did not preserve the bounded fallback: ${JSON.stringify(longAssetTopology)}`
    );
    const longTimeline = await win.locator('#timeline').boundingBox();
    await win.evaluate(() => {
      const video = document.getElementById('cutterVideo');
      video.pause();
      window.__cutterLongScrubFrames = [];
      window.__cutterLongScrubRecording = true;
      const recordFrame = (_now, metadata) => {
        if (!window.__cutterLongScrubRecording) return;
        window.__cutterLongScrubFrames.push(metadata.mediaTime);
        video.requestVideoFrameCallback(recordFrame);
      };
      video.requestVideoFrameCallback(recordFrame);
    });
    const longScrubY = longTimeline.y + longTimeline.height * 0.45;
    const longScrubStartX = longTimeline.x + longTimeline.width * 0.2;
    await win.mouse.move(longScrubStartX, longScrubY);
    await win.mouse.down();
    for (let step = 1; step <= 24; step += 1) {
      await win.mouse.move(longScrubStartX + step, longScrubY);
      await win.waitForTimeout(35);
    }
    await win.mouse.up();
    await win.waitForTimeout(180);
    const longScrubPresentation = await win.evaluate(() => {
      window.__cutterLongScrubRecording = false;
      const frames = [...new Set(window.__cutterLongScrubFrames.map((value) => Number(value.toFixed(3))))];
      const gaps = frames.slice(1).map((value, index) => Math.abs(value - frames[index]));
      delete window.__cutterLongScrubFrames;
      delete window.__cutterLongScrubRecording;
      return {
        frames: frames.length,
        first: frames[0] ?? null,
        last: frames.at(-1) ?? null,
        maximumGap: gaps.length ? Math.max(...gaps) : null
      };
    });
    check(
      longScrubPresentation.frames >= 12 && longScrubPresentation.maximumGap !== null && longScrubPresentation.maximumGap <= 0.75,
      `Long-video scrubbing skips too much visible media: ${JSON.stringify(longScrubPresentation)}`
    );
    const rapidSwitchCapabilities = await Promise.all([inputFile, longInputFile, silentInputFile, longInputFile, inputFile, silentInputFile, longInputFile, silentInputFile].map((filePath) => createCutterCapability(win, filePath)));
    const rapidSwitch = await win.evaluate(async (files) => {
      await Promise.allSettled(files.map((file) => window.loadCutterFromPath(file)));
      return cutterFile?.token || null;
    }, rapidSwitchCapabilities);
    const expectedRapidSwitchToken = rapidSwitchCapabilities.at(-1).token;
    await win.waitForFunction((expectedToken) => cutterFile?.token === expectedToken && document.getElementById('cutterVideo').readyState >= HTMLMediaElement.HAVE_METADATA, expectedRapidSwitchToken, { timeout: 15000 });
    check(rapidSwitch === expectedRapidSwitchToken, `Rapid file switching committed stale media: ${rapidSwitch}`);
    await win.evaluate((capability) => window.loadCutterFromPath(capability), inputCapability);
    await win.waitForFunction(() => document.getElementById('cutterVideo').readyState >= HTMLMediaElement.HAVE_METADATA && Number(document.getElementById('cutterThumbnailStrip').dataset.thumbnailCount || document.querySelectorAll('#cutterThumbnailStrip img').length) >= 30, null, { timeout: 90000 });
    const memoryAfterStressMb = getProcessTreeMemoryMb(app.process().pid);
    const stressMemoryDeltaMb = memoryBeforeStressMb && memoryAfterStressMb ? memoryAfterStressMb - memoryBeforeStressMb : 0;
    check(stressMemoryDeltaMb < 350, `Rapid media switching retained too much process memory: ${stressMemoryDeltaMb.toFixed(1)} MB`);
    const probedMedia = await win.evaluate((capability) => window.api.getVideoInfo(capability.token), inputCapability);
    check(probedMedia?.videoCodec === 'h264' && probedMedia?.audioCodec === 'aac' && probedMedia?.previewCompatible && !probedMedia?.variableFrameRate, `Media capability probe is inconsistent: ${JSON.stringify(probedMedia)}`);
    await win.evaluate((capability) => window.loadCutterFromPath(capability), unsupportedCapability);
    await win.waitForFunction(() => !document.getElementById('cutterWorkspace').classList.contains('loading'));
    const preservedAfterUnsupported = await win.evaluate((expectedFile) => ({
      filePreserved: cutterFile?.token === expectedFile,
      statePreserved: Boolean(cutterEditorState) && cutterEditorState.duration === 10,
      playerPreserved: document.getElementById('cutterVideo').readyState >= HTMLMediaElement.HAVE_METADATA,
      waveformPreserved: !document.getElementById('cutterWaveform').hidden && document.getElementById('cutterWaveform').naturalWidth === 32000,
      exportEnabled: !document.getElementById('btnCut').disabled
    }), inputCapability.token);
    check(Object.values(preservedAfterUnsupported).every(Boolean), `Unsupported replacement corrupted the loaded editor: ${JSON.stringify(preservedAfterUnsupported)}`);
    await win.locator('#timelineContainer').scrollIntoViewIfNeeded();
    const timeline = await win.locator('#timeline').boundingBox();
    const trimHandle = await win.locator('#cutterTrimStartHandle').boundingBox();
    await win.mouse.move(trimHandle.x + trimHandle.width / 2, trimHandle.y + trimHandle.height / 2);
    await win.mouse.down();
    await win.mouse.move(timeline.x + timeline.width * 0.1, trimHandle.y + trimHandle.height / 2, { steps: 8 });
    await win.mouse.up();
    const trimStart = await win.evaluate(() => cutterEditorState.trimStart);
    const expectedTrimStart = (timeline.width * 0.1 - trimHandle.width / 2) / timeline.width * 10;
    check(Math.abs(trimStart - expectedTrimStart) < 0.05, `Trim handle did not preserve its grabbed point: ${JSON.stringify({ trimStart, expectedTrimStart })}`);
    await win.evaluate(() => {
      const video = document.getElementById('cutterVideo');
      video.currentTime = 2;
      window.addCutterCut();
    });
    const firstInputs = win.locator('.cutter-cut-row').first().locator('input');
    await firstInputs.nth(0).fill('00:02:00');
    await firstInputs.nth(1).fill('00:04:00');
    await firstInputs.nth(1).press('Enter');
    await win.evaluate(() => {
      const video = document.getElementById('cutterVideo');
      video.currentTime = 6;
      window.addCutterCut();
    });
    const secondInputs = win.locator('.cutter-cut-row').nth(1).locator('input');
    await secondInputs.nth(0).fill('00:06:00');
    await secondInputs.nth(1).fill('00:07:00');
    await secondInputs.nth(1).press('Enter');
    const edited = await win.evaluate(() => ({
      cuts: cutterEditorState.cuts.map((cut) => ({ start: cut.start, end: cut.end })),
      rows: document.querySelectorAll('.cutter-cut-row').length,
      overlays: document.querySelectorAll('.cutter-cut-overlay').length,
      output: document.getElementById('infoSelection').textContent
    }));
    check(JSON.stringify(edited.cuts) === JSON.stringify([{ start: 2, end: 4 }, { start: 6, end: 7 }]), `Unexpected cut ranges: ${JSON.stringify(edited)}`);
    check(edited.rows === 2 && edited.overlays === 2, `Cut UI is incomplete: ${JSON.stringify(edited)}`);
    const cutHandleVisualGeometry = await win.evaluate(() => {
      const trim = document.getElementById('cutterTrimStartHandle');
      const overlay = document.querySelector('.cutter-cut-overlay');
      const start = overlay.querySelector('.cutter-cut-handle.start');
      const end = overlay.querySelector('.cutter-cut-handle.end');
      const trimRect = trim.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const startRect = start.getBoundingClientRect();
      const endRect = end.getBoundingClientRect();
      const trimStyle = getComputedStyle(trim);
      const startStyle = getComputedStyle(start);
      const endStyle = getComputedStyle(end);
      const trimGrip = getComputedStyle(trim, '::after');
      const startGrip = getComputedStyle(start, '::after');
      const endGrip = getComputedStyle(end, '::after');
      return {
        trim: { width: trimRect.width, height: trimRect.height, radius: trimStyle.borderRadius, border: trimStyle.borderLeftWidth, gripWidth: trimGrip.width, gripHeight: trimGrip.height },
        cut: { width: startRect.width, height: startRect.height, radius: startStyle.borderRadius, border: startStyle.borderLeftWidth, gripWidth: startGrip.width, gripHeight: startGrip.height },
        cutEnd: { width: endRect.width, height: endRect.height, radius: endStyle.borderRadius, border: endStyle.borderLeftWidth, gripWidth: endGrip.width, gripHeight: endGrip.height },
        contained: startRect.left >= overlayRect.left - 0.5 && endRect.right <= overlayRect.right + 0.5
      };
    });
    check(
      Math.abs(cutHandleVisualGeometry.cut.width - cutHandleVisualGeometry.trim.width) <= 0.5
        && Math.abs(cutHandleVisualGeometry.trim.height - 108) <= 0.5
        && Math.abs(cutHandleVisualGeometry.cut.height - cutHandleVisualGeometry.trim.height) <= 0.5
        && cutHandleVisualGeometry.cut.radius === cutHandleVisualGeometry.trim.radius
        && cutHandleVisualGeometry.cut.border === cutHandleVisualGeometry.trim.border
        && cutHandleVisualGeometry.cut.gripWidth === cutHandleVisualGeometry.trim.gripWidth
        && cutHandleVisualGeometry.cut.gripHeight === cutHandleVisualGeometry.trim.gripHeight
        && cutHandleVisualGeometry.cutEnd.width === cutHandleVisualGeometry.cut.width
        && cutHandleVisualGeometry.cutEnd.height === cutHandleVisualGeometry.cut.height
        && cutHandleVisualGeometry.cutEnd.radius === cutHandleVisualGeometry.cut.radius
        && cutHandleVisualGeometry.cutEnd.border === cutHandleVisualGeometry.cut.border
        && cutHandleVisualGeometry.cutEnd.gripWidth === cutHandleVisualGeometry.cut.gripWidth
        && cutHandleVisualGeometry.cutEnd.gripHeight === cutHandleVisualGeometry.cut.gripHeight
        && cutHandleVisualGeometry.contained,
      `Cut handles do not match the global trim handles: ${JSON.stringify(cutHandleVisualGeometry)}`
    );
    const cutHandleLayering = await win.evaluate(() => {
      const saved = JSON.parse(JSON.stringify(cutterEditorState));
      cutterEditorState = { ...cutterEditorState, trimStart: cutterEditorState.cuts[0].start };
      window.renderCutterEditor();
      const handle = document.querySelector('.cutter-cut-overlay .cutter-cut-handle.start');
      const rect = handle.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const redHandleOnTop = Boolean(top?.closest('.cutter-cut-handle'));
      cutterEditorState = saved;
      window.renderCutterEditor();
      return redHandleOnTop;
    });
    check(cutHandleLayering, 'A cut handle touching the global trim boundary is hidden behind the blue handle');
    const tinyCutBaseline = await win.evaluate(() => {
      window.__tinyCutSavedState = JSON.parse(JSON.stringify(cutterEditorState));
      const start = 5;
      const end = start + 1 / cutterEditorState.fps;
      cutterEditorState = { ...cutterEditorState, cuts: [{ id: 'tiny-cut', start, end }] };
      window.renderCutterEditor();
      const rect = document.querySelector('.cutter-cut-overlay').getBoundingClientRect();
      return { start, end, left: rect.left, right: rect.right, top: rect.top, height: rect.height };
    });
    await win.mouse.move(tinyCutBaseline.left + 1, tinyCutBaseline.top + tinyCutBaseline.height / 2);
    await win.mouse.down();
    await win.mouse.move(tinyCutBaseline.left - 40, tinyCutBaseline.top + tinyCutBaseline.height / 2, { steps: 8 });
    await win.mouse.up();
    const tinyCutAfterStartDrag = await win.evaluate(() => ({ ...cutterEditorState.cuts[0] }));
    await win.evaluate(() => {
      const saved = window.__tinyCutSavedState;
      const start = 5;
      const end = start + 1 / saved.fps;
      cutterEditorState = { ...saved, cuts: [{ id: 'tiny-cut', start, end }] };
      window.renderCutterEditor();
    });
    const tinyCutEndBox = await win.locator('.cutter-cut-overlay').boundingBox();
    await win.mouse.move(tinyCutEndBox.x + tinyCutEndBox.width - 1, tinyCutEndBox.y + tinyCutEndBox.height / 2);
    await win.mouse.down();
    await win.mouse.move(tinyCutEndBox.x + tinyCutEndBox.width + 40, tinyCutEndBox.y + tinyCutEndBox.height / 2, { steps: 8 });
    await win.mouse.up();
    const tinyCutAfterEndDrag = await win.evaluate(() => ({ ...cutterEditorState.cuts[0] }));
    await win.evaluate(() => {
      const saved = window.__tinyCutSavedState;
      const start = 5;
      const end = start + 1 / saved.fps;
      cutterEditorState = { ...saved, cuts: [{ id: 'tiny-cut', start, end }] };
      window.renderCutterEditor();
    });
    const tinyCutMoveBox = await win.locator('.cutter-cut-overlay').boundingBox();
    await win.mouse.move(tinyCutMoveBox.x + tinyCutMoveBox.width / 2, tinyCutMoveBox.y + tinyCutMoveBox.height / 2);
    await win.mouse.down();
    await win.mouse.move(tinyCutMoveBox.x + tinyCutMoveBox.width / 2 + 40, tinyCutMoveBox.y + tinyCutMoveBox.height / 2, { steps: 8 });
    await win.mouse.up();
    const tinyCutAfterMove = await win.evaluate(() => ({ ...cutterEditorState.cuts[0] }));
    await win.evaluate(() => {
      cutterEditorState = window.__tinyCutSavedState;
      delete window.__tinyCutSavedState;
      window.renderCutterEditor();
    });
    check(
      tinyCutAfterStartDrag.start < tinyCutBaseline.start - 0.1
        && Math.abs(tinyCutAfterStartDrag.end - tinyCutBaseline.end) < 0.001
        && tinyCutAfterEndDrag.end > tinyCutBaseline.end + 0.1
        && Math.abs(tinyCutAfterEndDrag.start - tinyCutBaseline.start) < 0.001
        && tinyCutAfterMove.start > tinyCutBaseline.start + 0.1
        && tinyCutAfterMove.end > tinyCutBaseline.end + 0.1
        && Math.abs((tinyCutAfterMove.end - tinyCutAfterMove.start) - (tinyCutBaseline.end - tinyCutBaseline.start)) < 0.001,
      `One-frame cut handles are not independently reachable: ${JSON.stringify({ tinyCutBaseline, tinyCutAfterStartDrag, tinyCutAfterEndDrag, tinyCutAfterMove })}`
    );
    const cutterAria = await win.evaluate(() => ({
      trimStartRole: document.getElementById('cutterTrimStartHandle').getAttribute('role'),
      trimStartNow: document.getElementById('cutterTrimStartHandle').getAttribute('aria-valuenow'),
      trimEndRole: document.getElementById('cutterTrimEndHandle').getAttribute('role'),
      trimEndNow: document.getElementById('cutterTrimEndHandle').getAttribute('aria-valuenow'),
      trimStart: cutterEditorState.trimStart,
      trimEnd: cutterEditorState.trimEnd,
      filePathLabel: document.getElementById(document.getElementById('cutterFilePath').getAttribute('aria-labelledby'))?.textContent?.trim() || null
    }));
    check(cutterAria.trimStartRole === 'slider' && cutterAria.trimEndRole === 'slider' && Number(cutterAria.trimStartNow) === cutterAria.trimStart && Number(cutterAria.trimEndNow) === cutterAria.trimEnd && Boolean(cutterAria.filePathLabel), `Global trim or file accessibility state is incomplete: ${JSON.stringify(cutterAria)}`);
    await win.evaluate(() => window.setLanguage('de'));
    const germanCutLabels = await win.evaluate(() => ({
      heading: document.querySelector('.cutter-cut-row-heading strong')?.textContent || '',
      overlay: document.querySelector('.cutter-cut-overlay')?.getAttribute('aria-label') || ''
    }));
    check(germanCutLabels.heading.startsWith('Schnitt ') && germanCutLabels.overlay.startsWith('Schnitt '), `Existing cuts were not relocalized: ${JSON.stringify(germanCutLabels)}`);
    await win.evaluate(() => window.setLanguage('en'));
    await win.evaluate(() => window.undoCutterEdit());
    const undoneEdit = await win.evaluate(() => cutterEditorState.cuts.map((cut) => ({ start: cut.start, end: cut.end })));
    check(JSON.stringify(undoneEdit) !== JSON.stringify(edited.cuts), 'Undo did not restore the previous edit state');
    await win.evaluate(() => window.redoCutterEdit());
    const redoneEdit = await win.evaluate(() => cutterEditorState.cuts.map((cut) => ({ start: cut.start, end: cut.end })));
    check(JSON.stringify(redoneEdit) === JSON.stringify(edited.cuts), 'Redo did not restore the edited ranges');
    const firstCutHandle = await win.locator('.cutter-cut-overlay').first().locator('.cutter-cut-handle.start').boundingBox();
    const firstCutGrabOffset = firstCutHandle.width - 2;
    await win.mouse.move(firstCutHandle.x + firstCutGrabOffset, firstCutHandle.y + firstCutHandle.height / 2);
    await win.mouse.down();
    await win.mouse.move(timeline.x + timeline.width * 0.25, firstCutHandle.y + firstCutHandle.height / 2, { steps: 12 });
    await win.mouse.up();
    const draggedCutStart = await win.evaluate(() => cutterEditorState.cuts[0].start);
    const expectedDraggedCutStart = 2.5 - firstCutGrabOffset / timeline.width * 10;
    const draggedCutGrabPoint = await win.locator('.cutter-cut-overlay').first().locator('.cutter-cut-handle.start').evaluate((element, offset) => element.getBoundingClientRect().left + offset, firstCutGrabOffset);
    check(Math.abs(draggedCutStart - expectedDraggedCutStart) < 0.05 && Math.abs(draggedCutGrabPoint - (timeline.x + timeline.width * 0.25)) <= 3, `Cut handle did not preserve its off-centre grabbed point: ${JSON.stringify({ draggedCutStart, expectedDraggedCutStart, draggedCutGrabPoint })}`);
    await win.evaluate(() => window.undoCutterEdit());
    check(Math.abs(await win.evaluate(() => cutterEditorState.cuts[0].start) - 2) < 0.05, 'Undo did not restore the dragged cut boundary');
    await win.evaluate(() => window.redoCutterEdit());
    check(Math.abs(await win.evaluate(() => cutterEditorState.cuts[0].start) - expectedDraggedCutStart) < 0.05, 'Redo did not restore the dragged cut boundary');
    await win.evaluate(() => window.undoCutterEdit());
    const firstCutOverlay = await win.locator('.cutter-cut-overlay').first().boundingBox();
    await win.mouse.move(firstCutOverlay.x + firstCutOverlay.width / 2, firstCutOverlay.y + firstCutOverlay.height / 2);
    await win.mouse.down();
    await win.mouse.move(timeline.x + timeline.width * 0.85, firstCutOverlay.y + firstCutOverlay.height / 2, { steps: 12 });
    await win.mouse.up();
    const collisionBoundedCut = await win.evaluate(() => cutterEditorState.cuts.map((cut) => ({ start: cut.start, end: cut.end })));
    check(collisionBoundedCut[0].end <= collisionBoundedCut[1].start + 0.001 && collisionBoundedCut[0].start < collisionBoundedCut[1].start, `Whole-cut drag crossed a neighbouring cut: ${JSON.stringify(collisionBoundedCut)}`);
    await win.evaluate(() => window.undoCutterEdit());
    await win.evaluate(() => {
      cutterActiveCutId = cutterEditorState.cuts[0].id;
      window.renderCutterEditor();
    });
    const trimStartHandle = await win.locator('#cutterTrimStartHandle').boundingBox();
    await win.mouse.move(trimStartHandle.x + trimStartHandle.width / 2, trimStartHandle.y + trimStartHandle.height / 2);
    await win.mouse.down();
    await win.mouse.move(timeline.x + timeline.width * 0.3, trimStartHandle.y + trimStartHandle.height / 2, { steps: 6 });
    await win.mouse.move(timeline.x + timeline.width * 0.15, trimStartHandle.y + trimStartHandle.height / 2, { steps: 6 });
    await win.mouse.up();
    const reversibleTrimStart = await win.evaluate(() => ({ trimStart: cutterEditorState.trimStart, firstCut: { ...cutterEditorState.cuts[0] }, activeCutId: cutterActiveCutId }));
    const expectedReversibleTrimStart = (timeline.width * 0.15 - trimStartHandle.width / 2) / timeline.width * 10;
    check(Math.abs(reversibleTrimStart.trimStart - expectedReversibleTrimStart) < 0.05 && Math.abs(reversibleTrimStart.firstCut.start - 2) < 0.05 && reversibleTrimStart.activeCutId === reversibleTrimStart.firstCut.id, `Trim drag destroyed cut data or selection before pointer-up: ${JSON.stringify({ reversibleTrimStart, expectedReversibleTrimStart })}`);
    await win.evaluate(() => window.undoCutterEdit());
    const trimEndHandle = await win.locator('#cutterTrimEndHandle').boundingBox();
    await win.mouse.move(trimEndHandle.x + trimEndHandle.width / 2, trimEndHandle.y + trimEndHandle.height / 2);
    await win.mouse.down();
    await win.mouse.move(timeline.x + timeline.width * 0.65, trimEndHandle.y + trimEndHandle.height / 2, { steps: 6 });
    const trimEndTargetX = timeline.x + timeline.width * 0.95;
    await win.mouse.move(trimEndTargetX, trimEndHandle.y + trimEndHandle.height / 2, { steps: 6 });
    await win.mouse.up();
    const reversibleTrimEnd = await win.evaluate(() => ({ trimEnd: cutterEditorState.trimEnd, secondCut: { ...cutterEditorState.cuts[1] } }));
    const trimEndCenter = await win.locator('#cutterTrimEndHandle').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    reversibleTrimEnd.cursorError = Math.abs(trimEndCenter - trimEndTargetX);
    const expectedReversibleTrimEnd = (timeline.width * 0.95 + trimEndHandle.width / 2) / timeline.width * 10;
    check(Math.abs(reversibleTrimEnd.trimEnd - expectedReversibleTrimEnd) < 0.05 && Math.abs(reversibleTrimEnd.secondCut.end - 7) < 0.05 && reversibleTrimEnd.cursorError <= 3, `Out-point drag destroyed cut data or lost its grabbed point: ${JSON.stringify({ reversibleTrimEnd, expectedReversibleTrimEnd })}`);
    await win.evaluate(() => window.undoCutterEdit());
    await win.locator('#cutterTrimStartHandle').focus();
    const trimBeforeKeyboard = await win.evaluate(() => cutterEditorState.trimStart);
    await win.locator('#cutterTrimStartHandle').press('ArrowRight');
    const trimAfterKeyboard = await win.evaluate(() => cutterEditorState.trimStart);
    check(trimAfterKeyboard > trimBeforeKeyboard, `Keyboard did not move the trim boundary: ${trimBeforeKeyboard} -> ${trimAfterKeyboard}`);
    await win.locator('#cutterTrimStartHandle').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    check(Math.abs(await win.evaluate(() => cutterEditorState.trimStart) - trimBeforeKeyboard) < 0.001, 'Ctrl+Z did not work while a cutter control was focused');
    const cutStartHandle = win.locator('.cutter-cut-overlay').first().locator('.cutter-cut-handle.start');
    await cutStartHandle.focus();
    const cutStartBeforeKeyboard = await win.evaluate(() => cutterEditorState.cuts[0].start);
    await cutStartHandle.press('ArrowRight');
    await win.waitForTimeout(30);
    await cutStartHandle.press('ArrowRight');
    await win.waitForTimeout(30);
    const repeatedCutKeyboard = await win.evaluate(() => ({ start: cutterEditorState.cuts[0].start, focused: document.activeElement?.classList.contains('start') }));
    check(repeatedCutKeyboard.start > cutStartBeforeKeyboard + 1 / 25 && repeatedCutKeyboard.focused, `Cut handle lost focus after keyboard rerender: ${JSON.stringify(repeatedCutKeyboard)}`);
    await cutStartHandle.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await win.evaluate(() => window.undoCutterEdit());
    const cutInput = win.locator('.cutter-cut-row').first().locator('input').first();
    const stateBeforeTextUndo = await win.evaluate(() => JSON.stringify(cutterEditorState));
    await cutInput.focus();
    await cutInput.fill('00:02:01');
    await cutInput.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    const textUndoState = await win.evaluate((before) => ({ stateUnchanged: JSON.stringify(cutterEditorState) === before, activeTag: document.activeElement?.tagName }), stateBeforeTextUndo);
    check(textUndoState.stateUnchanged && textUndoState.activeTag === 'INPUT', `Text-field undo changed the whole editor: ${JSON.stringify(textUndoState)}`);
    const crossedCutTime = await win.evaluate(() => window.findCutterPreviewTime(4.2, 1.9));
    check(crossedCutTime >= 6.2, `Preview did not compensate for fully crossed cuts: ${crossedCutTime}`);
    await win.evaluate(async () => {
      const video = document.getElementById('cutterVideo');
      video.currentTime = 2.5;
      await video.play();
    });
    await win.waitForFunction(() => document.getElementById('cutterVideo').currentTime >= 4, null, { timeout: 5000 });
    const skippedTime = await win.evaluate(() => {
      const video = document.getElementById('cutterVideo');
      video.pause();
      return video.currentTime;
    });
    check(skippedTime >= 4, `Preview did not skip the removed range: ${skippedTime}`);
    const smoothTimecodeFrames = await win.evaluate(async () => {
      const video = document.getElementById('cutterVideo');
      video.currentTime = 7.1;
      const values = new Set();
      await video.play();
      await new Promise((resolve) => {
        const started = performance.now();
        const sample = (now) => {
          values.add(document.getElementById('cutterCurrentTime').textContent);
          if (now - started >= 800) {
            video.pause();
            resolve();
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      return values.size;
    });
    check(smoothTimecodeFrames >= 10, `Player timecode updates are not frame-smooth: ${smoothTimecodeFrames}`);
    const playbackPerformance = await win.evaluate(async () => {
      const video = document.getElementById('cutterVideo');
      const results = [];
      for (const rate of [0.5, 2]) {
        video.currentTime = 7.1;
        video.playbackRate = rate;
        const frameDeltas = [];
        const timecodes = new Set();
        let previous = performance.now();
        await video.play();
        await new Promise((resolve) => {
          const started = performance.now();
          const sample = (now) => {
            frameDeltas.push(now - previous);
            previous = now;
            timecodes.add(document.getElementById('cutterCurrentTime').textContent);
            if (now - started >= 900) {
              video.pause();
              resolve();
              return;
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        frameDeltas.sort((left, right) => left - right);
        results.push({
          rate,
          timecodes: timecodes.size,
          p95FrameMs: frameDeltas[Math.min(frameDeltas.length - 1, Math.floor(frameDeltas.length * 0.95))],
          maxFrameMs: frameDeltas[frameDeltas.length - 1]
        });
      }
      video.playbackRate = 1;
      return results;
    });
    check(playbackPerformance.every((entry) => entry.timecodes >= 6 && entry.p95FrameMs < 40 && entry.maxFrameMs < 180), `Playback frame pacing is unstable: ${JSON.stringify(playbackPerformance)}`);
    await win.evaluate(async () => {
      const video = document.getElementById('cutterVideo');
      video.currentTime = 7.1;
      await video.play();
    });
    await win.mouse.move(timeline.x + timeline.width * 0.74, timeline.y + timeline.height * 0.45);
    await win.mouse.down();
    await win.mouse.move(timeline.x + timeline.width * 0.8, timeline.y + timeline.height * 0.45, { steps: 8 });
    await win.waitForTimeout(250);
    await win.mouse.up();
    const dragReleaseTime = await win.evaluate(() => document.getElementById('cutterVideo').currentTime);
    await win.waitForTimeout(350);
    const playbackAfterDrag = await win.evaluate(() => ({
      currentTime: document.getElementById('cutterVideo').currentTime,
      timecode: document.getElementById('cutterCurrentTime').textContent,
      paused: document.getElementById('cutterVideo').paused
    }));
    check(!playbackAfterDrag.paused && playbackAfterDrag.currentTime > dragReleaseTime + 0.15, `Playback synchronization stopped after drag: ${JSON.stringify({ dragReleaseTime, playbackAfterDrag })}`);
    await win.evaluate(() => document.getElementById('cutterVideo').pause());
    await win.evaluate(() => window.stopCutterPlayback());
    const stoppedTime = await win.evaluate(() => document.getElementById('cutterVideo').currentTime);
    check(Math.abs(stoppedTime - 1) < 0.05, `Stop did not return to the global in point: ${stoppedTime}`);
    await win.locator('#cutterSettingsBtn').click();
    const settingsMenuLayout = await win.evaluate(() => {
      const menu = document.getElementById('cutterSettingsMenu');
      const preview = document.getElementById('cutterPreview').getBoundingClientRect();
      const rect = menu.getBoundingClientRect();
      return {
        visible: !menu.hidden,
        contained: rect.left >= preview.left && rect.right <= preview.right && rect.top >= preview.top && rect.bottom <= preview.bottom
      };
    });
    check(settingsMenuLayout.visible && settingsMenuLayout.contained, `Player settings menu is not contained: ${JSON.stringify(settingsMenuLayout)}`);
    await win.keyboard.press('Escape');
    const escapedSettings = await win.evaluate(() => ({
      hidden: document.getElementById('cutterSettingsMenu').hidden,
      focusReturned: document.activeElement === document.getElementById('cutterSettingsBtn')
    }));
    check(escapedSettings.hidden && escapedSettings.focusReturned, `Player settings did not close accessibly: ${JSON.stringify(escapedSettings)}`);
    await win.locator('#cutterSettingsBtn').click();
    await win.locator('.cutter-speed-options button[data-rate="1.5"]').click();
    const playbackRateState = await win.evaluate(() => ({
      rate: document.getElementById('cutterVideo').playbackRate,
      pressed: document.querySelector('.cutter-speed-options button[data-rate="1.5"]').getAttribute('aria-pressed'),
      focusReturned: document.activeElement === document.getElementById('cutterSettingsBtn')
    }));
    check(playbackRateState.rate === 1.5 && playbackRateState.pressed === 'true' && playbackRateState.focusReturned, `Playback speed state is incomplete: ${JSON.stringify(playbackRateState)}`);
    await win.evaluate(() => window.setCutterPlaybackRate(1));
    await win.evaluate(async () => {
      const video = document.getElementById('cutterVideo');
      await video.play();
      window.toggleCutterSettingsMenu();
      window.showTab('vods');
    });
    const tabLeaveState = await win.evaluate(() => ({
      paused: document.getElementById('cutterVideo').paused,
      settingsHidden: document.getElementById('cutterSettingsMenu').hidden
    }));
    check(tabLeaveState.paused && tabLeaveState.settingsHidden, `Cutter kept playing after tab leave: ${JSON.stringify(tabLeaveState)}`);
    await win.evaluate(() => window.showTab('cutter'));
    const layoutAudit = await win.evaluate(() => {
      const tab = document.getElementById('cutterTab').getBoundingClientRect();
      const protruding = [...document.querySelectorAll('#cutterTab *')]
        .filter((element) => {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.left < tab.left - 2 || rect.right > tab.right + 2);
        })
        .map((element) => `${element.tagName.toLowerCase()}#${element.id}.${element.className}`);
      return {
        protruding,
        skipIcons: document.querySelectorAll('.cutter-skip-button svg').length,
        gearIcons: document.querySelectorAll('#cutterSettingsBtn svg').length,
        playerButtons: [...document.querySelectorAll('.cutter-player-button')].map((button) => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        })
      };
    });
    check(layoutAudit.protruding.length === 0, `Cutter controls protrude from the workspace: ${layoutAudit.protruding.join(', ')}`);
    check(layoutAudit.skipIcons === 2 && layoutAudit.gearIcons === 1, `Player reference icons are incomplete: ${JSON.stringify(layoutAudit)}`);
    check(layoutAudit.playerButtons.every((size) => size.height <= 36 && size.width <= 42), `Player icon buttons have inconsistent bounds: ${JSON.stringify(layoutAudit.playerButtons)}`);
    const responsiveLayouts = [];
    for (const viewport of [{ width: 1060, height: 700 }, { width: 1280, height: 700 }, { width: 1280, height: 720 }, { width: 1280, height: 800 }, { width: 1400, height: 860 }, { width: 1600, height: 900 }, { width: 2048, height: 1152 }]) {
      await setViewportSize(viewport);
      await win.evaluate(() => document.getElementById('cutterTab').scrollTo(0, 0));
      await win.waitForTimeout(150);
      responsiveLayouts.push(await win.evaluate((size) => {
        const workspace = document.getElementById('cutterWorkspace');
        const preview = document.getElementById('cutterPreview').getBoundingClientRect();
        const tab = document.getElementById('cutterTab');
        const tabRect = tab.getBoundingClientRect();
        const timelineRect = document.getElementById('timelineContainer').getBoundingClientRect();
        const actionsRect = document.querySelector('.cutter-actions').getBoundingClientRect();
        const visibleBottom = Math.min(tabRect.bottom, window.innerHeight);
        return {
          size,
          columns: getComputedStyle(workspace).gridTemplateColumns.split(' ').length,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          tabOverflow: tab.scrollWidth - tab.clientWidth,
          tabScrollTop: tab.scrollTop,
          timelineVisible: timelineRect.top >= tabRect.top - 1 && timelineRect.bottom <= visibleBottom + 1,
          actionsVisible: actionsRect.top >= tabRect.top - 1 && actionsRect.bottom <= visibleBottom + 1,
          previewWidth: preview.width,
          playerControlsWidth: document.getElementById('cutterPlayerControls').scrollWidth,
          playerControlsClientWidth: document.getElementById('cutterPlayerControls').clientWidth
        };
      }, viewport));
    }
    const compactLayout = responsiveLayouts[0];
    check(compactLayout.columns === 1, `Compact cutter does not stack cleanly: ${JSON.stringify(compactLayout)}`);
    check(responsiveLayouts.every((layout) => layout.documentOverflow <= 1 && layout.tabOverflow <= 1), `Responsive cutter has horizontal overflow: ${JSON.stringify(responsiveLayouts)}`);
    check(responsiveLayouts.every((layout) => layout.playerControlsWidth <= layout.playerControlsClientWidth + 1), `Responsive player controls protrude: ${JSON.stringify(responsiveLayouts)}`);
    const supportedWindowLayouts = responsiveLayouts.filter((layout) => layout.size.width >= 1280 && layout.size.height >= 700);
    check(supportedWindowLayouts.every((layout) => layout.tabScrollTop === 0 && layout.timelineVisible && layout.actionsVisible), `Cutter timeline or export controls require scrolling in a supported window: ${JSON.stringify(supportedWindowLayouts)}`);
    const mediumWindowLayout = responsiveLayouts.find((layout) => layout.size.width === 1600);
    const fullWindowLayout = responsiveLayouts.find((layout) => layout.size.width === 2048);
    check(mediumWindowLayout.previewWidth >= 900 && fullWindowLayout.previewWidth >= 1300, `Loaded player does not expand with available window width: ${JSON.stringify({ mediumWindowLayout, fullWindowLayout })}`);
    await setViewportSize({ width: 1060, height: 700 });
    await win.emulateMedia({ reducedMotion: 'reduce' });
    const collapsedVolumeLayout = await win.evaluate(() => ({
      volumeWidth: document.getElementById('cutterVolume').getBoundingClientRect().width,
      timeLeft: document.querySelector('.cutter-player-time').getBoundingClientRect().left
    }));
    await win.locator('#cutterMuteBtn').hover();
    await win.waitForTimeout(70);
    const expandingVolumeLayout = await win.evaluate(() => ({
      volumeWidth: document.getElementById('cutterVolume').getBoundingClientRect().width,
      timeLeft: document.querySelector('.cutter-player-time').getBoundingClientRect().left
    }));
    await win.waitForTimeout(220);
    await win.locator('#cutterVolume').click({ position: { x: 40, y: 5 } });
    const focusedVolumeAppearance = await win.evaluate(() => {
      const input = document.getElementById('cutterVolume');
      const style = getComputedStyle(input);
      return {
        active: document.activeElement === input,
        appearance: style.appearance,
        borderTopWidth: Number.parseFloat(style.borderTopWidth) || 0,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth) || 0
      };
    });
    const expandedVolumeLayout = await win.evaluate(() => ({
      controlsWidth: document.getElementById('cutterPlayerControls').scrollWidth,
      clientWidth: document.getElementById('cutterPlayerControls').clientWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      volumeWidth: document.getElementById('cutterVolume').getBoundingClientRect().width,
      timeLeft: document.querySelector('.cutter-player-time').getBoundingClientRect().left
    }));
    await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'volume-expanded.png') });
    check(expandedVolumeLayout.controlsWidth <= expandedVolumeLayout.clientWidth + 1 && expandedVolumeLayout.documentOverflow <= 1, `Expanded volume control causes overflow: ${JSON.stringify(expandedVolumeLayout)}`);
    check(focusedVolumeAppearance.active && focusedVolumeAppearance.appearance === 'none' && focusedVolumeAppearance.borderTopWidth === 0 && (focusedVolumeAppearance.outlineStyle === 'none' || focusedVolumeAppearance.outlineWidth === 0), `Focused volume control shows a rectangular native outline: ${JSON.stringify(focusedVolumeAppearance)}`);
    check(
      expandingVolumeLayout.volumeWidth > collapsedVolumeLayout.volumeWidth + 2
        && expandingVolumeLayout.volumeWidth < expandedVolumeLayout.volumeWidth - 2
        && expandingVolumeLayout.timeLeft > collapsedVolumeLayout.timeLeft + 2
        && expandingVolumeLayout.timeLeft < expandedVolumeLayout.timeLeft - 2,
      `Volume and timecode do not glide open together: ${JSON.stringify({ collapsedVolumeLayout, expandingVolumeLayout, expandedVolumeLayout })}`
    );
    await win.mouse.move(4, 4);
    await win.waitForTimeout(70);
    const collapsingVolumeLayout = await win.evaluate(() => ({
      volumeWidth: document.getElementById('cutterVolume').getBoundingClientRect().width,
      timeLeft: document.querySelector('.cutter-player-time').getBoundingClientRect().left
    }));
    await win.waitForTimeout(220);
    const closedVolumeLayout = await win.evaluate(() => ({
      volumeWidth: document.getElementById('cutterVolume').getBoundingClientRect().width,
      timeLeft: document.querySelector('.cutter-player-time').getBoundingClientRect().left
    }));
    check(
      collapsingVolumeLayout.volumeWidth < expandedVolumeLayout.volumeWidth - 2
        && collapsingVolumeLayout.volumeWidth > closedVolumeLayout.volumeWidth + 2
        && collapsingVolumeLayout.timeLeft < expandedVolumeLayout.timeLeft - 2
        && collapsingVolumeLayout.timeLeft > closedVolumeLayout.timeLeft + 2,
      `Volume and timecode do not glide closed together: ${JSON.stringify({ expandedVolumeLayout, collapsingVolumeLayout, closedVolumeLayout })}`
    );
    await win.evaluate(() => document.getElementById('cutterMuteBtn').focus());
    await win.keyboard.press('Tab');
    const keyboardVolumeFocus = await win.evaluate(() => ({
      inputFocused: document.activeElement === document.getElementById('cutterVolume'),
      focusVisible: document.getElementById('cutterVolume').matches(':focus-visible'),
      indicator: getComputedStyle(document.getElementById('cutterMuteBtn')).boxShadow
    }));
    check(keyboardVolumeFocus.inputFocused && keyboardVolumeFocus.focusVisible && keyboardVolumeFocus.indicator !== 'none', `Keyboard-focused volume control has no visible focus indicator: ${JSON.stringify(keyboardVolumeFocus)}`);
    await win.evaluate(() => document.getElementById('cutterVolume').blur());
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    await setViewportSize({ width: 1440, height: 900 });
    const actualDevicePixelRatio = await win.evaluate(() => {
      const actual = window.devicePixelRatio;
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
      return actual;
    });
    await win.waitForTimeout(200);
    await win.evaluate(() => window.updateCutterZoom(1));
    await win.waitForFunction(() => cutterAssetRefreshTimer === null && cutterAssetsInFlightJobId === null);
    await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const timelineScroll = await win.locator('#cutterTimelineScroll').boundingBox();
    const zoomAnchorX = timelineScroll.x + timelineScroll.width * 0.68;
    const zoomAnchorY = timelineScroll.y + Math.min(70, timelineScroll.height * 0.45);
    const wheelZoomBefore = await win.evaluate((clientX) => {
      const scroll = document.getElementById('cutterTimelineScroll');
      const timelineElement = document.getElementById('timeline');
      const rect = scroll.getBoundingClientRect();
      const localX = clientX - rect.left;
      const preview = document.getElementById('cutterPreview').getBoundingClientRect();
      const previewPanel = document.querySelector('.cutter-preview-panel').getBoundingClientRect();
      const info = document.getElementById('cutterInfo').getBoundingClientRect();
      const timelineContainer = document.getElementById('timelineContainer').getBoundingClientRect();
      return {
        zoom: Number(document.getElementById('cutterZoom').value),
        anchorTime: (scroll.scrollLeft + localX) / timelineElement.scrollWidth * cutterEditorState.duration,
        tabScrollTop: document.getElementById('cutterTab').scrollTop,
        geometry: {
          preview: { left: preview.left, top: preview.top, width: preview.width, height: preview.height },
          previewPanel: { left: previewPanel.left, top: previewPanel.top, width: previewPanel.width, height: previewPanel.height },
          info: { left: info.left, top: info.top, width: info.width, height: info.height },
          timelineContainer: { left: timelineContainer.left, top: timelineContainer.top, width: timelineContainer.width, height: timelineContainer.height }
        },
        waveformSource: document.getElementById('cutterWaveform').src,
        waveformLoads: window.__cutterAssetAudit.waveformLoads.length,
        assetRequestGeneration: cutterAssetsRequestGeneration
      };
    }, zoomAnchorX);
    await win.evaluate(() => {
      window.__cutterWheelPrevented = false;
      document.getElementById('cutterTimelineScroll').addEventListener('wheel', (event) => {
        window.__cutterWheelPrevented = event.defaultPrevented;
      }, { once: true });
    });
    await win.mouse.move(zoomAnchorX, zoomAnchorY);
    await win.mouse.wheel(0, -120);
    await win.waitForTimeout(80);
    const wheelZoomAfter = await win.evaluate((clientX) => {
      const scroll = document.getElementById('cutterTimelineScroll');
      const timelineElement = document.getElementById('timeline');
      const rect = scroll.getBoundingClientRect();
      const localX = clientX - rect.left;
      const preview = document.getElementById('cutterPreview').getBoundingClientRect();
      const previewPanel = document.querySelector('.cutter-preview-panel').getBoundingClientRect();
      const info = document.getElementById('cutterInfo').getBoundingClientRect();
      const timelineContainer = document.getElementById('timelineContainer').getBoundingClientRect();
      return {
        zoom: Number(document.getElementById('cutterZoom').value),
        max: Number(document.getElementById('cutterZoom').max),
        prevented: window.__cutterWheelPrevented,
        anchorTime: (scroll.scrollLeft + localX) / timelineElement.scrollWidth * cutterEditorState.duration,
        tabScrollTop: document.getElementById('cutterTab').scrollTop,
        geometry: {
          preview: { left: preview.left, top: preview.top, width: preview.width, height: preview.height },
          previewPanel: { left: previewPanel.left, top: previewPanel.top, width: previewPanel.width, height: previewPanel.height },
          info: { left: info.left, top: info.top, width: info.width, height: info.height },
          timelineContainer: { left: timelineContainer.left, top: timelineContainer.top, width: timelineContainer.width, height: timelineContainer.height }
        }
      };
    }, zoomAnchorX);
    const wheelZoom = { before: wheelZoomBefore, after: wheelZoomAfter };
    check(
      wheelZoomAfter.zoom >= 1.15
        && wheelZoomAfter.zoom <= 1.35
        && wheelZoomAfter.max >= 8
        && wheelZoomAfter.prevented
        && Math.abs(wheelZoomAfter.anchorTime - wheelZoomBefore.anchorTime) <= 0.01
        && wheelZoomAfter.tabScrollTop === wheelZoomBefore.tabScrollTop,
      `Timeline wheel zoom is not precise and pointer-centred: ${JSON.stringify(wheelZoom)}`
    );
    const zoomGeometryDelta = Math.max(...Object.keys(wheelZoomBefore.geometry).flatMap((key) => {
      const before = wheelZoomBefore.geometry[key];
      const after = wheelZoomAfter.geometry[key];
      return ['left', 'top', 'width', 'height'].map((property) => Math.abs(before[property] - after[property]));
    }));
    check(zoomGeometryDelta <= 0.5, `Timeline zoom shifts the player or surrounding UI by ${zoomGeometryDelta}px: ${JSON.stringify(wheelZoom)}`);
    if (wheelZoomAfter.zoom > wheelZoomBefore.zoom) {
      for (let index = 0; index < 24; index += 1) await win.mouse.wheel(0, -120);
      await win.waitForTimeout(250);
      await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      try {
        await win.waitForFunction(() => {
          const timelineElement = document.getElementById('timeline');
          const targetWidth = Math.min(32000, Math.ceil(timelineElement.getBoundingClientRect().width * window.devicePixelRatio));
          const strip = document.getElementById('cutterThumbnailStrip');
          const images = [...document.querySelectorAll('#cutterThumbnailStrip img')];
          const waveform = document.getElementById('cutterWaveform');
          return Number(strip.dataset.thumbnailCount || images.length) >= 30
            && images.every((image) => image.complete && image.naturalWidth > 0)
            && waveform.complete
            && waveform.naturalWidth >= targetWidth * 0.95;
        }, null, { timeout: 90000 });
      } catch { }
    }
    const assetDensity = await win.evaluate(async () => {
      const timelineElement = document.getElementById('timeline');
      const strip = document.getElementById('cutterThumbnailStrip');
      const images = [...document.querySelectorAll('#cutterThumbnailStrip img')];
      const tiles = [...strip.querySelectorAll('img:not(.cutter-thumbnail-sprite), .cutter-thumbnail-tile')];
      const waveform = document.getElementById('cutterWaveform');
      await Promise.all([...images, waveform].map((image) => image.decode()));
      const targetWidth = Math.min(32000, Math.ceil(timelineElement.getBoundingClientRect().width * window.devicePixelRatio));
      const stripRect = strip.getBoundingClientRect();
      const waveformRect = waveform.getBoundingClientRect();
      const cut = cutterEditorState.cuts[0];
      const cutRect = document.querySelector('.cutter-cut-overlay').getBoundingClientRect();
      const preview = document.getElementById('cutterPreview').getBoundingClientRect();
      const previewPanel = document.querySelector('.cutter-preview-panel').getBoundingClientRect();
      const info = document.getElementById('cutterInfo').getBoundingClientRect();
      const timelineContainer = document.getElementById('timelineContainer').getBoundingClientRect();
      return {
        zoom: Number(document.getElementById('cutterZoom').value),
        devicePixelRatio: window.devicePixelRatio,
        thumbnailCount: Number(strip.dataset.thumbnailCount || images.length),
        imageNodes: images.length,
        renderedFrames: Number(strip.dataset.renderedFrameCount || 0),
        renderedFrameIndexes: (strip.dataset.renderedFrameIndexes || '').split(',').filter(Boolean).map(Number),
        framePixelWidth: Number(strip.dataset.framePixelWidth || 0),
        canvasPixelWidth: Number(strip.dataset.renderedPixelWidth || 0),
        canvasCssWidth: tiles.reduce((total, tile) => total + tile.getBoundingClientRect().width, 0),
        sourceFrameWidth: images.length === 1 ? images[0].naturalWidth / 10 : Math.min(...images.map((image) => image.naturalWidth)),
        sourceFrameHeight: images.length === 1 ? images[0].naturalHeight / 10 : Math.min(...images.map((image) => image.naturalHeight)),
        waveformNaturalWidth: waveform.naturalWidth,
        waveformVerticalDensity: waveform.naturalHeight / Math.max(1, waveformRect.height * window.devicePixelRatio),
        waveformFilter: getComputedStyle(waveform).filter,
        waveformOpacity: Number(getComputedStyle(waveform).opacity),
        targetWidth,
        trackEdgeError: Math.max(Math.abs(stripRect.left - waveformRect.left), Math.abs(stripRect.right - waveformRect.right)),
        cutTimeError: Math.abs(cutRect.left - (waveformRect.left + cut.start / cutterEditorState.duration * waveformRect.width)),
        geometry: {
          preview: { left: preview.left, top: preview.top, width: preview.width, height: preview.height },
          previewPanel: { left: previewPanel.left, top: previewPanel.top, width: previewPanel.width, height: previewPanel.height },
          info: { left: info.left, top: info.top, width: info.width, height: info.height },
          timelineContainer: { left: timelineContainer.left, top: timelineContainer.top, width: timelineContainer.width, height: timelineContainer.height }
        }
      };
    });
    check(assetDensity.zoom >= 8 && assetDensity.devicePixelRatio === 2 && assetDensity.thumbnailCount >= 190 && assetDensity.imageNodes === assetDensity.renderedFrames && assetDensity.renderedFrames >= 150 && assetDensity.renderedFrameIndexes.length === assetDensity.renderedFrames && assetDensity.renderedFrameIndexes[0] === 0 && assetDensity.renderedFrameIndexes.at(-1) === assetDensity.thumbnailCount - 1 && new Set(assetDensity.renderedFrameIndexes).size === assetDensity.renderedFrames && assetDensity.framePixelWidth > 0 && assetDensity.framePixelWidth <= assetDensity.sourceFrameWidth && assetDensity.sourceFrameWidth >= 320 && assetDensity.sourceFrameHeight >= 180 && assetDensity.canvasPixelWidth >= assetDensity.canvasCssWidth * 2 - 1 && assetDensity.waveformNaturalWidth >= assetDensity.targetWidth * 0.95 && assetDensity.waveformVerticalDensity >= 1 && assetDensity.waveformFilter === 'none' && assetDensity.waveformOpacity === 1 && assetDensity.trackEdgeError <= 1 && assetDensity.cutTimeError <= 1.5, `Timeline media is being upscaled, filtered or misaligned: ${JSON.stringify(assetDensity)}`);
    await captureCutterScreenshot(app, win, { path: path.join(cutterArtifactDir, 'maximum-zoom.png') });
    const maximumZoomGeometryDelta = Math.max(...Object.keys(wheelZoomBefore.geometry).flatMap((key) => {
      const before = wheelZoomBefore.geometry[key];
      const after = assetDensity.geometry[key];
      return ['left', 'top', 'width', 'height'].map((property) => Math.abs(before[property] - after[property]));
    }));
    check(maximumZoomGeometryDelta <= 0.5, `Maximum timeline zoom shifts the player or surrounding UI by ${maximumZoomGeometryDelta}px: ${JSON.stringify({ before: wheelZoomBefore.geometry, after: assetDensity.geometry })}`);
    const zoomWaveformReuse = await win.evaluate((before) => ({
      sameSource: document.getElementById('cutterWaveform').src === before.waveformSource,
      loadsBefore: before.waveformLoads,
      loadsAfter: window.__cutterAssetAudit.waveformLoads.length,
      requestGenerationBefore: before.assetRequestGeneration,
      requestGenerationAfter: cutterAssetsRequestGeneration,
      assetsInFlight: cutterAssetsInFlightJobId
    }), wheelZoomBefore);
    check(zoomWaveformReuse.sameSource && zoomWaveformReuse.loadsAfter === zoomWaveformReuse.loadsBefore && zoomWaveformReuse.requestGenerationAfter === zoomWaveformReuse.requestGenerationBefore && zoomWaveformReuse.assetsInFlight === null, `Timeline zoom regenerated or replaced media assets: ${JSON.stringify(zoomWaveformReuse)}`);
    const maximumZoom = await win.evaluate(() => Number(document.getElementById('cutterZoom').max));
    await win.mouse.wheel(0, -120);
    await win.waitForTimeout(80);
    const maximumZoomAfterExtraWheel = await win.evaluate(() => Number(document.getElementById('cutterZoom').value));
    check(Math.abs(maximumZoomAfterExtraWheel - maximumZoom) <= 0.01, `Timeline wheel zoom exceeded its maximum: ${JSON.stringify({ maximumZoom, maximumZoomAfterExtraWheel })}`);
    const wheelBurst = await win.evaluate(async (clientX) => {
      window.updateCutterZoom(1);
      const ruler = document.getElementById('cutterRuler');
      const scroll = document.getElementById('cutterTimelineScroll');
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(ruler, { childList: true });
      for (let index = 0; index < 32; index += 1) {
        scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX, deltaY: -4 }));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      observer.disconnect();
      return { mutations, zoom: Number(document.getElementById('cutterZoom').value) };
    }, zoomAnchorX);
    check(wheelBurst.mutations <= 3 && wheelBurst.zoom > 1, `Trackpad wheel events are not frame-batched: ${JSON.stringify(wheelBurst)}`);
    for (let index = 0; index < 40; index += 1) await win.mouse.wheel(0, 120);
    await win.waitForTimeout(100);
    const minimumZoom = await win.evaluate(() => Number(document.getElementById('cutterZoom').value));
    await win.mouse.wheel(0, 120);
    await win.waitForTimeout(80);
    const minimumZoomAfterExtraWheel = await win.evaluate(() => Number(document.getElementById('cutterZoom').value));
    check(Math.abs(minimumZoom - 1) <= 0.01 && Math.abs(minimumZoomAfterExtraWheel - 1) <= 0.01, `Timeline wheel zoom exceeded its minimum: ${JSON.stringify({ minimumZoom, minimumZoomAfterExtraWheel })}`);
    await win.evaluate((devicePixelRatio) => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: devicePixelRatio });
      window.updateCutterZoom(2);
    }, actualDevicePixelRatio);
    await win.waitForTimeout(80);
    const zoom = await win.evaluate(() => ({
      timeline: document.getElementById('timeline').getBoundingClientRect().width,
      viewport: document.getElementById('cutterTimelineScroll').getBoundingClientRect().width
    }));
    check(zoom.timeline >= zoom.viewport * 1.9, `Timeline zoom did not expand the tracks: ${JSON.stringify(zoom)}`);
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
    const cancelledExport = await win.evaluate(async ({ outputName, editorState }) => {
      const exportPromise = window.api.exportVideoEdit({
        inputCapability: cutterFile.token,
        outputName,
        trimStart: editorState.trimStart,
        trimEnd: editorState.trimEnd,
        cuts: editorState.cuts
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const cancelAccepted = await window.api.cancelVideoEdit();
      return { cancelAccepted, result: await exportPromise };
    }, { outputName: path.basename(cancelledOutputFile), editorState });
    check(cancelledExport.cancelAccepted && !cancelledExport.result.success && cancelledExport.result.cancelled === true && !fs.existsSync(cancelledOutputFile), `Export cancellation did not return a clean cancelled result or published a file: ${JSON.stringify(cancelledExport)}`);
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
    console.log(JSON.stringify({ failures, runtimeIssues, mediaTimingScale, additionalContainerSupport, emptyLayout, emptyFullscreenLayout, emptyVolumeBefore, emptyVolumeAfter, revealAnimation, firstAssetQuality, firstAssetsReadyMs, initialAssetStability, verticalProfileQuality, loaded, edgeGeometry, timestampTypography, playerControlGeometry, cutterInfoAlignment, replacementPromptState, replacementPlaybackState, scrubMediaInfo, scrubFirstAssetsReadyMs, scrubFirstAssetQuality, realMaximumZoomState, scrubSyncProbe, trimScrubProbe, mediumWaveformReadyMs, mediumFirstAssetsReadyMs, mediumZoomReuseBefore, mediumZoomReuseAfter, longPlayerReadyMs, longAssetsReadyMs, longAssetTopology, longPreservedAfterAssetInterruptions, longScrubPresentation, rapidSwitch, memoryBeforeStressMb, memoryAfterStressMb, stressMemoryDeltaMb, preservedAfterUnsupported, edited, cutHandleVisualGeometry, cutterAria, germanCutLabels, draggedCutStart, collisionBoundedCut, reversibleTrimStart, reversibleTrimEnd, crossedCutTime, skippedTime, smoothTimecodeFrames, playbackPerformance, playbackAfterDrag, stoppedTime, settingsMenuLayout, escapedSettings, playbackRateState, tabLeaveState, layoutAudit, responsiveLayouts, expandedVolumeLayout, wheelZoom, zoomGeometryDelta, maximumZoomGeometryDelta, assetDensity, zoomWaveformReuse, zoom, sourceProtection, invalidRequest, cancelledExport, exportResult, manyCutsExport, changedSourceExport, silentState, silentExportResult, cutterTempDirectoriesAfterShutdown, shutdownArtifacts }, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    if (app) await app.close();
    staleCutterDirectories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
    cleanupE2eEnvironment(environment);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
