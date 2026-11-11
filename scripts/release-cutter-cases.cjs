/* eslint-disable no-undef -- page.evaluate executes against the production renderer globals. */
'use strict';

// Reconstructed release checks against public production behavior, not recovered private tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const harness = require('./release-test-harness.cjs');

const FPS = 25;
const RATE = 48000;
const DURATION = 12;

async function binary(command, args, raw = false) {
  const result = await execFile(command, args, { encoding: raw ? 'buffer' : 'utf8',
    timeout: 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return result.stdout;
}

async function probe(file, options) {
  return JSON.parse(await binary(options.ffprobe || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

// Each second carries a different gray level/frequency, plus a synchronized 200 ms flash/tone.
// The low amplitude carrier stays present between pulses, exposing silence at edit boundaries.
async function markerMedia(env, options) {
  const file = path.join(env.mediaDir, 'Cutter markers #ä stereo.mp4');
  await binary(options.ffmpeg || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', `nullsrc=s=320x180:r=${FPS},geq=lum='30+10*floor(N/25)+80*lt(mod(N,25),5)':cb=128:cr=128`,
    '-f', 'lavfi', '-i', `aevalsrc=exprs='(0.12+0.42*lt(mod(t,1),0.2))*sin(2*PI*(300+40*floor(t))*t)|(0.10+0.30*lt(mod(t,1),0.2))*sin(2*PI*(700+30*floor(t))*t)':s=${RATE}:c=stereo`,
    '-t', String(DURATION), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p',
    '-g', '25', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', file]);
  const metadata = await probe(file, options);
  assert.equal(metadata.streams.find(s => s.codec_type === 'audio').channels, 2);
  assert.ok(Math.abs(Number(metadata.format.duration) - DURATION) < .05);
  return { file, metadata };
}

async function decodeAudio(file, options) {
  const raw = await binary(options.ffmpeg || 'ffmpeg', ['-v', 'error', '-nostdin', '-i', file,
    '-map', '0:a:0', '-ac', '2', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], true);
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

async function browserFixture(env, media, options) {
  const pcm = await decodeAudio(media.file, options);
  const bins = 1200;
  const peaks = [[], []];
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * pcm.length / 2 / bins);
    const end = Math.floor((bin + 1) * pcm.length / 2 / bins);
    for (let channel = 0; channel < 2; channel++) {
      let amplitude = 0;
      for (let i = start; i < end; i++) amplitude = Math.max(amplitude, Math.abs(pcm[i * 2 + channel]));
      peaks[channel].push(Math.round(Math.sqrt(amplitude) * 255));
    }
  }
  const jpg = await binary(options.ffmpeg || 'ffmpeg', ['-v', 'error', '-nostdin', '-ss', '1', '-i', media.file,
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], true);
  const thumbnail = `data:image/jpeg;base64,${jpg.toString('base64')}`;
  const bytes = fs.readFileSync(media.file);
  const server = await harness.createHttpFixture(env, { '/markers.mp4': request => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    if (!match) return { body: bytes, headers: { ...headers, 'Content-Length': String(bytes.length) } };
    const start = Number(match[1]), end = Math.min(Number(match[2] || bytes.length - 1), bytes.length - 1);
    return { status: 206, body: bytes.subarray(start, end + 1), headers: { ...headers,
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) } };
  } });
  let saved = null;
  const capability = { token: 'release-generated-cutter', name: path.basename(media.file) };
  const info = { duration: DURATION, width: 320, height: 180, fps: FPS, hasAudio: true,
    audioStreams: [{ index: 0, channels: 2, codec: 'aac', language: null, title: 'Stereo markers' }],
    videoCodec: 'h264', audioCodec: 'aac', previewCompatible: true, variableFrameRate: false };
  return { capability, peaks, fixture: { overrides: {
    selectVideoFile: () => capability,
    prepareVideoEditorMedia: token => { assert.equal(token, capability.token); return {
      sourceUrl: `${server.url}/markers.mp4`, info, jobId: 41, thumbnails: [thumbnail], waveform: null }; },
    prepareVideoEditorWaveform: (token, jobId) => { assert.equal(token, capability.token); assert.equal(jobId, 41);
      return { jobId, peaks, channels: 2, waveform: null, pixelWidth: bins, pixelHeight: 80 }; },
    prepareVideoEditorAssets: (_token, jobId) => ({ jobId, thumbnails: [thumbnail], thumbnailSprite: null,
      thumbnailCount: 1, pixelWidth: 32000, pixelHeight: 180 }),
    cancelVideoEditorAssets: () => true,
    getCutterExportOptions: () => ({ profiles: ['quality', 'balanced', 'fast', 'archive'].map(id => ({ id,
      label: id, container: id === 'archive' ? 'mkv' : 'mp4' })), hardwareEncoders: [] }),
    saveCutterProject: (token, project) => { assert.equal(token, capability.token); saved = structuredClone(project); return true; },
    getCutterProjectRecovery: () => saved,
    discardCutterProject: () => { saved = null; return true; },
  } } };
}

async function load(session, file, fixture) {
  const { page } = session;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.showTab('cutter'));
  assert.equal(await page.locator('#btnCut').isDisabled(), true, 'Empty editor must disable export');
  if (fixture) await page.locator('#cutterBrowseBtn').click();
  else {
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file';
      input.id = 'release-cutter-input'; document.body.append(input); });
    await page.locator('#release-cutter-input').setInputFiles(file);
    await page.evaluate(async () => {
      const input = document.getElementById('release-cutter-input');
      const capability = await window.api.selectDroppedVideo(input.files[0]); input.remove();
      if (!capability?.token) throw new Error('Production file capability was not issued');
      await window.loadCutterFromPath(capability);
    });
  }
  await page.waitForFunction(() => cutterControlsEnabled && !cutterRecoveryDecisionPending
    && document.getElementById('cutterVideo').readyState >= 2, null, { timeout: 90000 });
  await page.locator('#cutterTrimStartHandle').waitFor();
  assert.equal(await page.evaluate(() => document.getElementById('cutterVideo').videoWidth), 320, 'Generated video must decode');
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function seek(page, time) {
  await page.evaluate(time => seekCutterVideo(time), time);
  await page.waitForFunction(time => { const video = document.getElementById('cutterVideo');
    return !video.seeking && Math.abs(video.currentTime - time) < .021 && video.readyState >= 2; }, time);
}

async function trim(page, start = '00:00:01:00', end = '00:00:11:00') {
  await page.locator('#startTime').fill(start); await page.locator('#startTime').press('Tab');
  await page.locator('#endTime').fill(end); await page.locator('#endTime').press('Tab');
}

async function omission(page, start, end) {
  await page.locator('#cutterOmitMode').click();
  await page.locator('#cutterNewCutBtn').click();
  await page.locator('#cutterOmitStartHandle').waitFor();
  assert.equal(await page.locator('#btnCut').isDisabled(), true, 'Unconfirmed omission must block export');
  assert.equal(await page.locator('#startTime').isDisabled(), true, 'Unconfirmed omission must protect trim');
  await page.evaluate(({ start, end }) => changeCutterPlayerRange(start, end, cutterCutDraft.id,
    { source: 'keyboard', boundary: 'start' }), { start, end });
  await page.locator('.cutter-cut-row.active .cutter-cut-actions .btn-secondary').click();
  await page.waitForFunction(() => !cutterCutDraft);
}

async function core(session) {
  const { page } = session;
  for (const time of [1.2, 9.4, .4, 5.2]) await seek(page, time);
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.getElementById('cutterVideo').currentTime - 5.24) < .015);
  await page.getByRole('button', { name: 'Previous frame', exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.getElementById('cutterVideo').currentTime - 5.2) < .015);
  await trim(page);
  assert.deepEqual(await page.evaluate(() => [cutterEditorState.trimStart, cutterEditorState.trimEnd]), [1, 11]);
  await page.locator('#cutterTrimStartHandle').press('ArrowRight');
  await page.waitForFunction(() => Math.abs(cutterEditorState.trimStart - 1.04) < .001);
  await page.locator('#cutterUndoBtn').click();
  await page.waitForFunction(() => cutterEditorState.trimStart === 1);
  await page.locator('#cutterRedoBtn').click();
  await page.waitForFunction(() => Math.abs(cutterEditorState.trimStart - 1.04) < .001);
  await page.locator('#cutterUndoBtn').click();
  await page.waitForFunction(() => Number(document.getElementById('cutterTrimStartHandle').getAttribute('aria-valuenow')) === 1);
  const handle = page.locator('#cutterTrimStartHandle');
  await handle.hover(); const rect = await handle.boundingBox();
  await page.mouse.down();
  await page.waitForFunction(() => cutterRangeDrag !== null);
  await page.mouse.move(rect.x + rect.width / 2 + 45, rect.y + rect.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => cutterRangeDrag === null && cutterEditorState.trimStart > 1.04);
  assert.equal(await page.evaluate(() => cutterEditorState.trimEnd), 11);
  await page.locator('#cutterUndoBtn').click();
  await page.waitForFunction(() => cutterEditorState.trimStart === 1);
  await omission(page, 3, 5);
  assert.equal(await page.evaluate(() => getCutterPlayableDuration()), 8);
  await page.locator('#cutterNewCutBtn').click(); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => !cutterCutDraft && cutterEditorState.cuts.length === 1), true);
  assert.equal(await page.evaluate(() => persistCutterProject(false)), true);
  const saved = await page.evaluate(() => window.api.getCutterProjectRecovery(cutterFile.token));
  assert.equal(saved.trimStart, 1); assert.equal(saved.trimEnd, 11);
  assert.deepEqual(saved.cuts.map(({ start, end }) => [start, end]), [[3, 5]]);
  await previewRange(page, 1, 11, [{ start: 3, end: 5 }]);
}

async function previewRange(page, start, end, cuts) {
  for (const cut of cuts.slice(0, 4)) {
    await seek(page, Math.max(start, cut.start - .12));
    await page.evaluate(() => { const video = document.getElementById('cutterVideo'); video.muted = true; return video.play(); });
    await page.waitForFunction(cut => document.getElementById('cutterVideo').currentTime >= cut.end, cut, { timeout: 5000 });
    const time = await page.evaluate(() => { const video = document.getElementById('cutterVideo'); video.pause(); return video.currentTime; });
    assert.ok(time < cut.end + .5, `Preview failed to skip omission promptly: ${JSON.stringify({ cut, time })}`);
  }
  await seek(page, end - .12);
  await page.evaluate(() => document.getElementById('cutterVideo').play());
  await page.waitForFunction(end => { const video = document.getElementById('cutterVideo');
    return video.paused && video.currentTime >= end - .05; }, end, { timeout: 5000 });
  assert.ok(await page.evaluate(end => document.getElementById('cutterVideo').currentTime <= end + .08, end), 'Preview exceeds trim endpoint');
}

async function layout(session, compact = false) {
  const { page } = session;
  const sizes = compact ? [[1280, 720], [1440, 900]] : [[1024, 768], [1280, 800], [1600, 900], [2048, 1152]];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height }); await settle(page);
    const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      overflow: document.documentElement.scrollWidth,
      panels: ['cutterPreview', 'cutterEditPanel', 'timelineContainer'].map(id => {
        const box = document.getElementById(id).getBoundingClientRect(); return { id, x: box.x, right: box.right,
          width: box.width, height: box.height, top: box.top, bottom: box.bottom }; }),
      buttons: document.querySelectorAll('#cutterPlayerControls .player-button').length }));
    assert.ok(geometry.overflow <= width + 1, `Horizontal overflow at ${width}: ${JSON.stringify(geometry)}`);
    for (const box of geometry.panels) assert.ok(box.width > 20 && box.height > 10 && box.x >= -1 && box.right <= width + 1,
      `Offscreen ${box.id} at ${width}: ${JSON.stringify(box)}`);
    assert.ok(geometry.buttons >= 6, 'Playback controls disappeared');
    if (compact) assert.ok(geometry.panels.find(box => box.id === 'cutterPreview').height <= height * .65,
      'Compact preview consumes more than 65% of the viewport');
    for (const id of ['cutterBrowseBtn', 'startTime', 'endTime', 'cutterZoomInBtn', 'cutterZoomOutBtn', 'btnCut']) {
      const control = page.locator(`#${id}`); await control.scrollIntoViewIfNeeded();
      assert.equal(await control.isVisible(), true, `Missing ${id} at ${width}`);
      const reachable = await control.evaluate(element => { const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.width >= 16 && r.height >= 16 && (hit === element || element.contains(hit)); });
      assert.equal(reachable, true, `Covered/unreachable ${id} at ${width}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#cutterZoomInBtn').click();
  assert.ok(await page.evaluate(() => cutterZoom > 1), 'Zoom control did not work after resizing');
  await page.locator('#cutterZoomOverviewBtn').click();
  await page.waitForFunction(() => cutterZoom === 1);
  if (compact) {
    await page.locator('input[name="cutterProfile"][value="fast"]').check();
    assert.equal(await page.evaluate(() => cutterExportProfile), 'fast');
    await trim(page, '00:00:02:00', '00:00:10:00');
    assert.equal(await page.evaluate(() => getCutterPlayableDuration()), 8);
  }
}

async function zoom(session) {
  const { page } = session;
  await page.waitForFunction(() => cutterWaveformStatus === 'complete');
  for (const motion of ['reduce', 'no-preference']) {
    await page.emulateMedia({ reducedMotion: motion });
    await page.evaluate(async () => { window.__releasePeaks = cutterWaveformPeaks; updateCutterZoom(2);
      await Promise.all(document.getElementById('timeline').getAnimations().map(animation => animation.finished)); });
    for (const value of [3, 5, 2, 4, 1.5]) {
      const result = await page.evaluate(async value => {
        const scroll = document.getElementById('cutterTimelineScroll');
        const timeline = document.getElementById('timeline');
        const localX = scroll.clientWidth * .37;
        const before = (scroll.scrollLeft + localX) / timeline.scrollWidth;
        const y = timeline.getBoundingClientRect().top;
        updateCutterZoom(value, false, scroll.getBoundingClientRect().left + localX);
        await Promise.all(timeline.getAnimations().map(animation => animation.finished));
        return { before, after: (scroll.scrollLeft + localX) / timeline.scrollWidth, y,
          nextY: timeline.getBoundingClientRect().top, width: timeline.scrollWidth, viewport: scroll.clientWidth,
          samePeaks: cutterWaveformPeaks === window.__releasePeaks, zoom: cutterZoom };
      }, value);
      assert.ok(Math.abs(result.before - result.after) <= 2 / result.width, `Zoom lost focal point (${motion}): ${JSON.stringify(result)}`);
      assert.ok(Math.abs(result.y - result.nextY) < 1, 'Zoom moved timeline vertically');
      assert.ok(Math.abs(result.width / result.viewport - result.zoom) < .02, `Zoom scale and track disagree (${motion}): ${JSON.stringify(result)}`);
      assert.equal(result.samePeaks, true, 'Zoom unnecessarily regenerated waveform');
      await settle(page);
    }
    await page.locator('#cutterZoomOverviewBtn').click();
    await page.waitForFunction(() => cutterZoom === 1 && document.getElementById('cutterTimelineScroll').scrollLeft === 0);
  }
}

async function waveform(session, fixture) {
  const { page } = session;
  await page.waitForFunction(() => cutterWaveformStatus === 'complete' && !document.getElementById('cutterWaveform').hidden);
  const peaks = await page.evaluate(() => cutterWaveformPeaks.map(channel => Array.from(channel)));
  assert.deepEqual(peaks, fixture.peaks, 'Renderer lost/changed decoded stereo waveform data');
  assert.notDeepEqual(peaks[0], peaks[1], 'Fixture must discriminate channels');
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('cutterWaveform');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const lanes = [0, 0];
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (data[i] === 154 && data[i + 1] === 200 && data[i + 2] === 187 && data[i + 3]) lanes[y < canvas.height / 2 ? 0 : 1]++;
    }
    return { lanes, width: canvas.width, height: canvas.height, empty: document.getElementById('cutterAudioEmpty').hidden };
  });
  assert.ok(painted.width > 100 && painted.height >= 20);
  assert.ok(painted.lanes.every(pixels => pixels > painted.width * 2), `Both waveform channels must be painted: ${JSON.stringify(painted)}`);
  assert.equal(painted.empty, true);
  const before = await page.evaluate(() => JSON.stringify(cutterWaveformPeaks.map(channel => Array.from(channel))));
  await session.emit('onVideoEditorWaveformProgress', { jobId: -1, startIndex: 0, totalBins: 1200, completedBins: 1200,
    peaks: [Array(1200).fill(255), Array(1200).fill(255)] });
  assert.equal(await page.evaluate(() => JSON.stringify(cutterWaveformPeaks.map(channel => Array.from(channel)))), before,
    'Stale waveform job overwrote active media');
}

function segmentsFor(start, end, cuts) {
  const segments = []; let cursor = start;
  for (const cut of cuts) { if (cut.start > cursor) segments.push({ start: cursor, end: cut.start }); cursor = cut.end; }
  if (cursor < end) segments.push({ start: cursor, end });
  return segments;
}

function sourceAt(time, segments) {
  for (const segment of segments) {
    const duration = segment.end - segment.start;
    if (time < duration - 1e-7) return segment.start + time;
    time -= duration;
  }
  return segments.at(-1).end;
}

async function verifyDecoded(file, segments, options) {
  const metadata = await probe(file, options);
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  const audio = metadata.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(video && audio, 'Export needs both A/V streams'); assert.equal(audio.channels, 2);
  const duration = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  for (const stream of [video, audio]) {
    assert.ok(Math.abs(Number(stream.start_time || 0)) < .045, 'Export stream starts with a timestamp gap');
    assert.ok(Math.abs(Number(stream.duration) - duration) < .085, `A/V duration drift: ${JSON.stringify(stream)}`);
  }
  const frames = await binary(options.ffmpeg || 'ffmpeg', ['-v', 'error', '-nostdin', '-i', file,
    '-map', '0:v:0', '-vf', 'crop=2:2,extractplanes=y', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], true);
  const frameCount = frames.length / 4;
  assert.ok(Math.abs(frameCount - duration * FPS) <= 1, 'Dropped or duplicated video frames');
  for (let i = 0; i < frameCount; i++) {
    const source = sourceAt((i + .1) / FPS, segments);
    const n = Math.floor(source * FPS + .0001);
    const y = 30 + 10 * Math.floor(n / FPS) + 80 * (n % FPS < 5 ? 1 : 0);
    const expected = y; // Inspect native luma samples without a color-range conversion.
    assert.ok(Math.abs(frames[i * 4] - expected) < 7,
      `Wrong decoded video marker at output frame ${i}, source ${source.toFixed(3)}: ${frames[i * 4]} vs ${expected.toFixed(1)}`);
  }
  const pcm = await decodeAudio(file, options);
  assert.ok(Math.abs(pcm.length / 2 / RATE - duration) < .085, 'Decoded PCM duration disagrees with edit');
  let windows = 0;
  // 20 ms RMS/zero-crossing windows inspect the full export, including each splice.
  for (let time = .04; time + .02 < duration - .02; time += .02) {
    const a = sourceAt(time, segments), b = sourceAt(time + .02, segments);
    for (let channel = 0; channel < 2; channel++) {
      let energy = 0, crossings = 0;
      const from = Math.round(time * RATE), count = Math.round(.02 * RATE);
      for (let i = from; i < from + count; i++) {
        const sample = pcm[i * 2 + channel]; energy += sample * sample;
        if (i > from && pcm[(i - 1) * 2 + channel] <= 0 && sample > 0) crossings++;
      }
      const rms = Math.sqrt(energy / count);
      assert.ok(rms > .035 && rms < .5, `Silence/clipping at splice ${time.toFixed(3)} channel ${channel}: ${rms}`);
      // Avoid encoder ringing exactly on pulse/second boundaries, but do not exempt continuity there.
      if (Math.abs((b - a) - .02) < .0001 && Math.floor(a) === Math.floor(b)
        && Math.abs(a % 1 - .2) > .04 && Math.abs(b % 1 - .2) > .04 && a % 1 > .04 && b % 1 < .96) {
        const pulse = a % 1 < .2;
        assert.equal(rms > .19, pulse, `A/V pulse desync at ${time.toFixed(3)} (source ${a.toFixed(3)}), channel ${channel}`);
        const frequency = (channel === 0 ? 300 + 40 * Math.floor(a) : 700 + 30 * Math.floor(a));
        assert.ok(Math.abs(crossings / .02 - frequency) < 90,
          `Wrong audio segment at ${time.toFixed(3)}: ${crossings / .02} Hz vs ${frequency} Hz`);
        windows++;
      }
    }
  }
  assert.ok(windows >= 20, 'Too few measured audio marker windows');
  return { duration, frames: frameCount, audioWindows: windows, segments: segments.length };
}

async function nativeExport(session, request, target, cancel = false) {
  const { app, page } = session;
  await app.evaluate(({ dialog }, target) => { globalThis.__releaseOriginalSave = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, target);
  try {
    return await page.evaluate(async ({ request, cancel }) => {
      let cancelPromise;
      let resolveProgress;
      const progress = new Promise(resolve => { resolveProgress = resolve; });
      let armed = true;
      if (cancel) window.api.onCutProgress(percent => { if (armed && percent < 100) {
        armed = false; cancelPromise = window.api.cancelVideoEdit(); resolveProgress(); } });
      const pending = window.api.exportVideoEdit({ inputCapability: cutterFile.token, ...request });
      if (!cancel) return pending;
      const outcome = await Promise.race([progress.then(() => 'progress'), pending.then(() => 'finished')]);
      armed = false;
      if (outcome !== 'progress') throw new Error('Export finished without an observable cancellable progress event');
      return { accepted: await cancelPromise, result: await pending };
    }, { request, cancel });
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.__releaseOriginalSave; delete globalThis.__releaseOriginalSave; });
  }
}

async function nativeAudio(session, options, many = false) {
  const cuts = many ? Array.from({ length: 32 }, (_, index) => ({ id: `cut-${index}`,
    start: Number((1.2 + index * .28).toFixed(2)), end: Number((1.28 + index * .28).toFixed(2)) }))
    : [{ id: 'first', start: 3.4, end: 5.08 }, { id: 'second', start: 7.6, end: 8.32 }];
  const trimStart = 1.04, trimEnd = 11.2;
  await session.page.evaluate(({ trimStart, trimEnd, cuts }) => {
    if (!applyCutterProject({ version: 1, duration: cutterEditorState.duration, fps: cutterEditorState.fps,
      trimStart, trimEnd, cuts, profile: 'balanced', encoder: 'software', audioStreamIndex: 0 })) throw new Error('Project rejected');
  }, { trimStart, trimEnd, cuts });
  await previewRange(session.page, trimStart, trimEnd, cuts);
  const target = path.join(session.env.mediaDir, many ? 'Many cuts verified.mp4' : 'A V sync verified.mp4');
  const request = { trimStart, trimEnd, cuts, profile: 'balanced', encoder: 'software', outputName: path.basename(target) };
  const result = await nativeExport(session, request, target);
  assert.equal(result.success, true, `Production export failed: ${JSON.stringify(result)}`);
  const measurements = await verifyDecoded(target, segmentsFor(trimStart, trimEnd, cuts), options);
  if (!many) {
    const cancelled = path.join(session.env.mediaDir, 'Cancelled export.mp4');
    const cancellation = await nativeExport(session, { ...request, outputName: path.basename(cancelled) }, cancelled, true);
    assert.equal(cancellation.accepted, true);
    assert.equal(cancellation.result.cancelled, true); assert.equal(cancellation.result.success, false);
    assert.equal(fs.existsSync(cancelled), false, 'Cancelled export was published');
    assert.equal(fs.readdirSync(session.env.mediaDir).some(name => /\.tvm-(edit|backup)/.test(name)), false, 'Cancellation left transaction artifacts');
  }
  return measurements;
}

const cases = {
  'v2-regression': { run: core },
  'compact-verified': { run: session => layout(session, true) },
  'zoom-stability': { run: zoom },
  waveform: { run: (session, _options, fixture) => waveform(session, fixture) },
  'layout-regressions': { run: session => layout(session) },
  'v2-native': { native: true, run: async (session, options) => {
    await core(session);
    await session.page.waitForFunction(() => cutterWaveformStatus === 'complete', null, { timeout: 90000 });
    assert.equal(await session.page.evaluate(() => cutterWaveformPeaks.length), 2, 'Native FFmpeg waveform lost stereo channel');
    const target = path.join(session.env.mediaDir, 'Core export.mp4');
    const result = await nativeExport(session, { trimStart: 1, trimEnd: 11, cuts: [{ id: 'cut', start: 3, end: 5 }], outputName: path.basename(target) }, target);
    assert.equal(result.success, true);
    return verifyDecoded(target, segmentsFor(1, 11, [{ start: 3, end: 5 }]), options);
  } },
  'audio-sync-native': { native: true, run: (session, options) => nativeAudio(session, options) },
  'audio-many-cuts': { native: true, run: (session, options) => nativeAudio(session, options, true) },
};

async function run(name, argv = process.argv.slice(2)) {
  assert.ok(Object.hasOwn(cases, name), `Unknown cutter case ${name}`);
  const options = harness.parseOptions(argv);
  const definition = cases[name];
  const allowed = new Set(definition.native ? ['--packaged'] : ['--webkit']);
  for (const arg of argv) if (arg.startsWith('-') && !allowed.has(arg)) throw new Error(`Unsupported cutter option: ${arg}`);
  if (definition.native && process.platform !== 'win32') throw new Error(`${name}: unsupported platform ${process.platform}; actual Windows Electron is required`);
  const env = harness.createEnvironment(`cutter-${name}`, { language: 'en' });
  let session;
  const previousPath = process.env.PATH;
  try {
    if (definition.native) {
      const directories = [options.ffmpeg, options.ffprobe].filter(Boolean).filter(file => path.isAbsolute(file)).map(file => path.dirname(file));
      if (directories.length) process.env.PATH = [...new Set(directories), previousPath || ''].join(path.delimiter);
    }
    const media = await markerMedia(env, options);
    // Verify the marker oracle against its generated source before judging any output.
    if (definition.native) await verifyDecoded(media.file, [{ start: 0, end: DURATION }], options);
    const fixture = definition.native ? null : await browserFixture(env, media, options);
    session = definition.native ? await harness.launchElectron(env, { packaged: options.packaged })
      : await harness.launchBrowser(env, { engine: options.webkit ? 'webkit' : 'chromium', fixture: fixture.fixture });
    session.page.setDefaultTimeout(15000);
    await load(session, media.file, fixture);
    const measurements = await definition.run(session, options, fixture);
    await harness.assertIsolation(session);
    assert.deepEqual(session.errors, [], 'Renderer/fixture runtime errors');
    console.log(JSON.stringify({ case: name, status: 'passed', engine: definition.native ? 'windows-electron' : options.webkit ? 'webkit' : 'chromium', measurements }));
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await harness.closeSession(session || env);
  }
}

module.exports = { run };
