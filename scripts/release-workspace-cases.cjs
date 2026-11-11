/* global window: readonly, document: readonly, getComputedStyle: readonly, innerWidth: readonly */
'use strict';
// Public-contract reconstruction: native scenarios exercise production IPC and owned files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const h = require('./release-test-harness.cjs');
const browserCases = new Set(['layout-consistency', 'insights-integrated', 'full-workspace-audit', 'audit-regressions', 'sidebar-layout', 'roadmap-archive', 'roadmap-clips']);
const tabs = ['vods', 'clips', 'cutter', 'merge', 'stats', 'archive', 'settings'];
const api = (s, method, ...args) => s.page.evaluate(({ method, args }) => window.api[method](...args), { method, args });
async function nav(s, tab) {
  await s.page.locator(`.top-nav button[data-tab="${tab}"]`).click();
  await s.page.waitForFunction(tab => document.querySelector(`.top-nav button[data-tab="${tab}"]`)?.getAttribute('aria-current') === 'page', tab);
}
async function geometry(s, tab) {
  const state = await s.page.evaluate(() => {
    const visible = e => !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    return { current: [...document.querySelectorAll('.top-nav button[aria-current="page"]')].map(e => e.dataset.tab),
      content: [...document.querySelectorAll('.tab-content')].filter(visible).map(e => e.id),
      contexts: [...document.querySelectorAll('[data-context-for]')].filter(visible).map(e => e.dataset.contextFor),
      width: innerWidth, scroll: document.documentElement.scrollWidth,
      shell: document.querySelector('.workspace-shell').getBoundingClientRect().toJSON(),
      topbar: document.querySelector('.app-topbar').getBoundingClientRect().toJSON() };
  });
  assert.deepEqual(state.current, [tab]); assert.deepEqual(state.content, [`${tab}Tab`]);
  assert.ok(state.scroll <= state.width + 1, `${tab} document overflow: ${JSON.stringify(state)}`);
  assert.ok(state.shell.right <= state.width + 1 && state.shell.width > 300, 'Workspace outside viewport');
  assert.ok(state.topbar.height >= 40 && state.topbar.height <= 90, 'Persistent topbar collapsed');
  assert.deepEqual(state.contexts, ['vods', 'settings'].includes(tab) ? [tab] : []);
}
async function layout(s) {
  for (const width of [1280, 1600, 2048]) {
    await s.page.setViewportSize({ width, height: 900 });
    for (const tab of tabs) { await nav(s, tab); await geometry(s, tab); }
  }
}
async function localization(s) {
  s.page.setDefaultTimeout(15000);
  await nav(s, 'settings');
  const en = await s.page.evaluate(() => { window.changeLanguage('en'); return document.getElementById('settingsStorageNav').textContent; });
  const de = await s.page.evaluate(() => { window.changeLanguage('de'); return document.getElementById('settingsStorageNav').textContent; });
  assert.notEqual(en, de); assert.match(de, /Speicher/);
  await s.page.evaluate(() => window.changeLanguage('en'));
  for (const pane of ['general', 'storage', 'system']) {
    await s.page.locator(`[data-context-for="settings"] [data-settings-pane="${pane}"]`).click();
    assert.ok(await s.page.locator(`.settings-card[data-settings-group="${pane}"]:visible`).count(), `Settings ${pane} absent`);
  }
}
async function sidebar(s) {
  await nav(s, 'vods');
  const rows = ['pending', 'paused', 'completed', 'error'].map((status, i) => ({ id: `workspace-${i}`, status, progress: status === 'completed' ? 100 : 0,
    title: `Workspace queue ${status}`, url: `https://www.twitch.tv/videos/${100000 + i}`, streamer: 'fixture_streamer', quality: 'best', mode: 'full', createdAt: new Date().toISOString() }));
  await s.emit('queue-updated', rows);
  await s.page.waitForFunction(() => document.querySelectorAll('#queueList .queue-item').length === 4);
  for (const width of [1280, 1600]) {
    await s.page.setViewportSize({ width, height: 800 });
    await geometry(s, 'vods');
    const data = await s.page.evaluate(() => {
      const side = document.querySelector('.context-sidebar').getBoundingClientRect();
      return { side: side.toJSON(), rows: [...document.querySelectorAll('#queueList .queue-item')].map(e => e.getBoundingClientRect().toJSON()),
        scroll: document.getElementById('queueList').scrollWidth, client: document.getElementById('queueList').clientWidth };
    });
    assert.ok(data.side.width > 200 && data.side.width < width / 2, 'Sidebar has unusable width');
    assert.ok(data.scroll <= data.client + 1, 'Queue horizontally overflows');
    for (const row of data.rows) assert.ok(row.left >= data.side.left - 1 && row.right <= data.side.right + 1 && row.height > 0, 'Queue row outside sidebar');
  }
}
function statsFixture(env) {
  const day = new Date().toISOString().slice(0, 10);
  return { totalFiles: 6, totalBytes: 6000000, liveCount: 1, liveBytes: 1000000, vodCount: 3, vodBytes: 3000000,
    clipCount: 2, clipBytes: 2000000, chatCount: 0, chatBytes: 0, eventsCount: 0, streamerCount: 1, avgRecordingSizeBytes: 1000000,
    channels: [{ streamer: 'fixture_streamer', fileCount: 6, bytes: 6000000, liveBytes: 1000000, vodBytes: 3000000, clipBytes: 2000000, chatBytes: 0 }],
    topStreamers: [{ streamer: 'fixture_streamer', fileCount: 6, bytes: 6000000, liveBytes: 1000000, vodBytes: 3000000, clipBytes: 2000000, chatBytes: 0 }],
    dailyActivity: [{ date: day, count: 6, bytes: 6000000 }], sizeBuckets: [{ label: '< 1 GB', count: 6, bytes: 6000000 }],
    scannedAt: new Date().toISOString(), downloadPath: env.downloadsDir, rootExists: true,
    lifetime: { available: true, trackedSince: day, totalDownloads: 26, completedJobs: 26, vodDownloads: 13, clipDownloads: 11, liveRecordings: 2,
      outputFiles: 26, totalBytes: 26000000, recoveredDownloads: 0, unknownDateDownloads: 0, dailyActivity: [{ date: day, count: 26, bytes: 26000000 }] } };
}
async function insights(s) {
  await s.replaceIpc('getArchiveStats', statsFixture(s.env));
  await s.replaceIpc('searchDownloadHistory', filter => ({ entries: filter?.query ? [] : [{ id: 'history-release', title: 'Historical release download',
    kind: 'vod', sourceIds: ['123456789'], completedAt: new Date().toISOString(), filePresence: 'missing', availablePaths: [],
    channel: 'fixture_streamer', totalBytes: 1000000 }], total: filter?.query ? 0 : 1, offset: 0, limit: filter?.limit || 10 }));
  await nav(s, 'stats');
  await s.page.waitForFunction(() => document.querySelector('.stats-kpi-vod .stats-kpi-value')?.textContent === '13');
  assert.equal(await s.page.locator('.stats-kpi-clips .stats-kpi-value').textContent(), '11');
  assert.equal(await s.page.locator('.stats-kpi-live .stats-kpi-value').textContent(), '2');
  await s.page.locator('#statsChannelNav [data-channel="fixture_streamer"]').click();
  await s.page.waitForFunction(() => document.getElementById('statsTab').getAttribute('aria-busy') === 'false');
  assert.ok(s.calls.some(c => c.method === 'getArchiveStats' && c.args[0]?.channel === 'fixture_streamer'), 'Channel selection was not sent to statistics');
  await s.page.locator('#statsRange').selectOption('7');
  await s.page.waitForFunction(() => document.getElementById('statsTab').getAttribute('aria-busy') === 'false');
  assert.ok(s.calls.some(c => c.method === 'getArchiveStats' && c.args[0]?.days === 7), 'Date range not forwarded');
  await s.page.waitForFunction(() => document.querySelector('#downloadHistory .download-history-row')?.textContent.includes('Historical release download'));
  assert.match(await s.page.locator('#downloadHistory').textContent(), /File missing/);
  await s.page.locator('#historyQuery').fill('not-in-history');
  await s.page.waitForFunction(() => document.querySelector('#downloadHistory .insights-empty')?.textContent.includes('No downloads'));
  assert.ok(s.calls.some(c => c.method === 'searchDownloadHistory' && c.args[0]?.query === 'not-in-history' && c.args[0]?.channel === 'fixture_streamer'), 'History filter and channel were not forwarded');
  await geometry(s, 'stats');
}
async function refined(s) {
  await nav(s, 'cutter');
  assert.equal(await s.page.locator('link[href*="workspace-refinements."]').count(), 1);
  await nav(s, 'settings');
  const state = await s.page.evaluate(() => ({ buttons: document.querySelectorAll('.top-nav button[data-tab]').length,
    storage: !!document.querySelector('[data-context-for="settings"] [data-settings-pane="storage"]'),
    fields: ['playerSeekSeconds', 'statsChannelNav', 'cleanupPreview'].filter(id => document.getElementById(id)) }));
  assert.equal(state.buttons, 7); assert.ok(state.storage); assert.deepEqual(state.fields, ['playerSeekSeconds', 'statsChannelNav', 'cleanupPreview']);
  const style = await s.page.evaluate(() => ({ topbar: document.querySelector('.app-topbar').getBoundingClientRect().height, nav: getComputedStyle(document.querySelector('.top-nav')).display }));
  assert.equal(style.topbar, 58); assert.equal(style.nav, 'grid');
  await localization(s); await sidebar(s);
}
async function archiveBrowser(s) {
  const hits = ['vod', 'clip'].map((type, i) => ({ fullPath: path.join(s.env.downloadsDir, `release-${type}.mp4`),
    relativePath: `release-${type}.mp4`, fileName: `release-${type}.mp4`, streamer: 'fixture_streamer', type,
    size: 10000 + i, mtimeMs: Date.now() - i * 1000 }));
  await s.replaceIpc('searchArchive', filter => {
    const selected = hits.filter(hit => (filter.type === 'all' || hit.type === filter.type)
      && (!filter.query || hit.fileName.includes(filter.query)));
    return { totalScanned: hits.length, matchCount: selected.length, truncated: false, hits: selected,
      scannedAt: new Date().toISOString(), rootExists: true, streamers: ['fixture_streamer'], offset: 0 };
  });
  await nav(s, 'archive');
  await s.page.waitForFunction(() => document.querySelectorAll('.archive-result-row').length === 2);
  await s.page.locator('#archiveSelectPage').check();
  assert.equal(await s.page.locator('.archive-row-select:checked').count(), 2);
  assert.equal(await s.page.locator('#archiveMergeSelected').isDisabled(), false);
  await s.page.locator('#archiveClearSelection').click();
  assert.equal(await s.page.locator('.archive-row-select:checked').count(), 0);
  await s.page.locator('#archiveSearchType').selectOption('clip');
  await s.page.waitForFunction(() => document.querySelectorAll('.archive-result-row').length === 1);
  assert.match(await s.page.locator('#archiveSearchResults').textContent(), /release-clip/);
  assert.ok(s.calls.some(call => call.method === 'searchArchive' && call.args[0].type === 'clip'));
  await s.page.locator('#archiveSearchQuery').fill('missing-file');
  await s.page.waitForFunction(() => document.querySelector('#archiveSearchResults .archive-empty'));
  await s.page.locator('#archiveSearchQuery').fill('release');
  await s.page.locator('#btnArchiveSearch').click();
  await s.page.waitForFunction(() => document.querySelectorAll('.archive-result-row').length === 1);
  assert.ok(s.calls.some(call => call.method === 'searchArchive' && call.args[0].query === 'release' && call.args[0].refresh));
  await geometry(s, 'archive');
}
async function clipsBrowser(s) {
  const files = Array.from({ length: 101 }, (_, i) => ({ fullPath: path.join(s.env.downloadsDir, `saved-${i}.mp4`),
    fileName: `saved-${i}.mp4`, streamer: 'fixture_streamer', size: 10000, mtimeMs: Date.now() }));
  await s.replaceIpc('getClipLibrary', (offset = 0) => ({ directory: s.env.downloadsDir, rootExists: true,
    total: files.length, offset, files: files.slice(offset, offset + 100) }));
  await nav(s, 'clips');
  await s.page.locator('#clipsSavedTitle').click();
  await s.page.waitForFunction(() => document.querySelectorAll('#clipsSavedList .clip-result-row').length === 100);
  assert.equal(await s.page.locator('#clipsLibraryPrevious').isDisabled(), true);
  await s.page.locator('#clipsLibraryNext').click();
  await s.page.waitForFunction(() => document.querySelectorAll('#clipsSavedList .clip-result-row').length === 1);
  assert.match(await s.page.locator('#clipsSavedList').textContent(), /saved-100/);
  assert.equal(await s.page.locator('#clipsLibraryNext').isDisabled(), true);
  assert.ok(s.calls.some(call => call.method === 'getClipLibrary' && call.args[0] === 100));
  await s.page.locator('#clipsLibraryPrevious').click();
  await s.page.waitForFunction(() => document.querySelectorAll('#clipsSavedList .clip-result-row').length === 100);
  await s.page.locator('#clipsLibraryRefresh').click();
  await s.page.waitForFunction(() => !document.getElementById('clipsLibraryRefresh').disabled);
  assert.ok(s.calls.some(call => call.method === 'getClipLibrary' && call.args[1] === true));
  await s.replaceIpc('getClipLibrary', { directory: s.env.downloadsDir, rootExists: true, total: 0, offset: 0, files: [] });
  await s.page.locator('#clipsLibraryRefresh').click();
  await s.page.waitForFunction(() => document.querySelector('#clipsSavedList .clips-list-empty'));
  assert.equal(await s.page.locator('#clipsLibraryNext').isDisabled(), true);
  assert.equal(await s.page.locator('#clipsLibraryPrevious').isDisabled(), true);
  await geometry(s, 'clips');
}
async function dialogs(s, openFile, saveFile) {
  for (const file of [openFile, saveFile].filter(Boolean)) assert.ok(path.resolve(file).startsWith(s.env.rootDir + path.sep), 'Dialog fixture escaped owned directory');
  await s.app.evaluate(({ dialog }, { openFile, saveFile }) => {
    dialog.showOpenDialog = async () => ({ canceled: !openFile, filePaths: openFile ? [openFile] : [] });
    dialog.showSaveDialog = async () => ({ canceled: !saveFile, filePath: saveFile });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { openFile, saveFile });
}
async function selectMedia(s, filename) {
  await dialogs(s, filename);
  const ref = await api(s, 'selectVideoFile'); assert.ok(ref?.token, 'Production selection did not issue a capability');
  const media = await api(s, 'prepareVideoEditorMedia', ref.token); assert.ok(media?.info?.duration > 0, 'Real media preparation failed');
  return { ref, media };
}
const edit = duration => ({ trimStart: 0.2, trimEnd: duration - 0.2, cuts: [{ id: 'middle', start: 1, end: 1.4 }], profile: 'fast', encoder: 'software', audioStreamIndex: 0, colorMode: 'source' });
async function projects(s, mediaFile) {
  const selected = await selectMedia(s, mediaFile);
  const project = edit(selected.media.info.duration);
  assert.equal(await api(s, 'saveCutterProject', selected.ref.token, project), true);
  const recovered = await api(s, 'getCutterProjectRecovery', selected.ref.token);
  assert.deepEqual(recovered.cuts, project.cuts); assert.equal(recovered.trimStart, project.trimStart);
  const destination = path.join(s.env.mediaDir, 'release-project.tvmcut');
  await dialogs(s, mediaFile, destination);
  const saved = await api(s, 'saveNamedCutterProject', selected.ref.token, project, 'Release project', true);
  assert.equal(saved.success, true, JSON.stringify(saved));
  const document = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(document.format, 'twitch-vod-manager/cutter-project'); assert.match(document.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(document.edit.cuts, project.cuts);
  const listed = await api(s, 'listNamedCutterProjects'); assert.equal(listed.projects.length, 1);
  return { selected, project, id: listed.projects[0].id };
}
async function reopen(s, options) { await s.app.close(); return h.launchElectron(s.env, { packaged: options.packaged }); }
async function verifyReopenedProject(s, id, file) {
  const opened = await api(s, 'openNamedCutterProject', id); assert.equal(opened.success, true, JSON.stringify(opened));
  assert.equal(opened.name, 'Release project'); assert.deepEqual(opened.project.cuts, [{ id: 'middle', start: 1, end: 1.4 }]);
  assert.ok(opened.source.token);
  const selected = await selectMedia(s, file);
  assert.equal((await api(s, 'getCutterProjectRecovery', selected.ref.token)).trimStart, 0.2);
  return selected;
}
async function probe(file, o) {
  const { stdout } = await execute(o.ffprobe || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 30000, windowsHide: true });
  return JSON.parse(stdout);
}
async function exportEdit(s, selected, project, name, o) {
  const output = path.join(s.env.downloadsDir, name);
  await dialogs(s, undefined, output);
  const queued = await api(s, 'enqueueCutterExport', selected.ref.token, project);
  assert.equal(queued.success, true, JSON.stringify(queued));
  assert.equal((await api(s, 'exportJobAction', 'start')).success, true);
  await s.page.waitForFunction(async id => {
    const jobs = await window.api.listExportJobs(); return jobs.jobs.some(job => job.id === id && ['completed', 'failed', 'cancelled'].includes(job.status));
  }, queued.job.id, { timeout: 120000, polling: 250 });
  const job = (await api(s, 'listExportJobs')).jobs.find(job => job.id === queued.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const result = await probe(output, o);
  const duration = project.trimEnd - project.trimStart - project.cuts.reduce((n, c) => n + c.end - c.start, 0);
  assert.ok(Math.abs(Number(result.format.duration) - duration) < 0.25, 'Export duration does not match edits');
  return { output, probe: result };
}
async function inventory(s, mediaFile) {
  const folder = path.join(s.env.downloadsDir, 'fixture_streamer'); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'release-library.mp4'); fs.copyFileSync(mediaFile, file);
  await api(s, 'saveConfig', { streamers: ['fixture_streamer'] });
  const result = await api(s, 'searchArchive', { query: 'release-library', refresh: true });
  const hit = result.hits.find(h => h.fullPath === file); assert.ok(hit, JSON.stringify(result)); assert.equal(hit.size, fs.statSync(file).size);
  const refs = await api(s, 'prepareArchiveVideos', [file], 'cutter'); assert.ok(refs[0]?.token);
  const info = await api(s, 'getVideoInfo', refs[0].token); assert.ok(info.duration > 2 && info.width === 320);
  await assert.rejects(api(s, 'prepareArchiveVideos', [mediaFile], 'cutter'), /denied|access/i);
  return file;
}
async function libraryMarker(s) {
  const state = await api(s, 'changeVodLibrary', { collection: 'markers', item: { name: 'Release marker', vodId: '123456789', seconds: 12.25, duration: 90 } });
  const marker = state.markers.find(m => m.name === 'Release marker'); assert.ok(marker?.id); return marker;
}
async function cleanupFixture(s, mediaFile) {
  const folder = path.join(s.env.downloadsDir, 'fixture_streamer', 'live'); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'old-release.mp4'); fs.copyFileSync(mediaFile, file);
  const sidecar = file.replace('.mp4', '.chat.json'); fs.writeFileSync(sidecar, '{"messages":[]}');
  const old = new Date(Date.now() - 60 * 86400000); fs.utimesSync(file, old, old); fs.utimesSync(sidecar, old, old);
  const fresh = path.join(folder, 'fresh-release.mp4'); fs.copyFileSync(mediaFile, fresh);
  await api(s, 'saveConfig', { streamers: ['fixture_streamer'], auto_cleanup_days: 30, auto_cleanup_target: 'live_only', auto_cleanup_action: 'archive' });
  return { file, sidecar, fresh, bytes: fs.readFileSync(file) };
}
function descendants(folder) { return fs.readdirSync(folder, { withFileTypes: true }).flatMap(e => e.isDirectory() ? descendants(path.join(folder, e.name)) : [path.join(folder, e.name)]); }
function verifyCleanup(s, files) {
  assert.equal(fs.existsSync(files.file), false); assert.equal(fs.existsSync(files.sidecar), false); assert.equal(fs.existsSync(files.fresh), true);
  const archived = descendants(path.join(s.env.downloadsDir, 'archived'));
  assert.equal(archived.length, 2); assert.deepEqual(fs.readFileSync(archived.find(f => f.endsWith('.mp4'))), files.bytes);
}
async function cleanup(s, mediaFile, ui) {
  const files = await cleanupFixture(s, mediaFile);
  if (ui) {
    await s.page.reload(); await s.page.waitForFunction(() => typeof window.showTab === 'function'); await nav(s, 'settings');
    await s.page.locator('[data-context-for="settings"] [data-settings-pane="storage"]').click();
    await s.page.locator('details').filter({ has: s.page.locator('#cleanupTitle') }).locator('summary').click();
    assert.equal(await s.page.locator('#btnCleanupRunNow').isDisabled(), true);
    await s.page.locator('#btnCleanupDryRun').click(); await s.page.waitForFunction(() => !document.getElementById('btnCleanupRunNow').disabled);
    assert.match(await s.page.locator('#cleanupPreview').textContent(), /old-release/); assert.ok(fs.existsSync(files.file));
    await s.page.locator('#btnCleanupRunNow').click(); await s.page.waitForFunction(() => document.getElementById('cleanupReport').textContent.includes('1 videos archived'));
    assert.equal(await s.page.locator('#btnCleanupRunNow').isDisabled(), true);
  } else {
    await assert.rejects(api(s, 'runStorageCleanup', { dryRun: false }), /preview-required/);
    const plan = await api(s, 'runStorageCleanup', { dryRun: true }); assert.equal(plan.candidates, 1); assert.equal(plan.items[0].videoPath, files.file);
    assert.deepEqual(plan.items[0].sidecarPaths, [files.sidecar]); assert.ok(fs.existsSync(files.file));
    const result = await api(s, 'runStorageCleanup', { dryRun: false, token: plan.token }); assert.equal(result.processed, 1); assert.equal(result.failed, 0);
    await assert.rejects(api(s, 'runStorageCleanup', { dryRun: false, token: plan.token }), /preview-required/);
  }
  verifyCleanup(s, files);
}
async function audio(s, mediaFile, o) {
  const selected = await selectMedia(s, mediaFile);
  const project = { ...edit(selected.media.info.duration), trimStart: 0, trimEnd: 3, cuts: [], audioProcessing: { fadeInSeconds: 0.8, fadeOutSeconds: 0.8, normalize: true } };
  const result = await exportEdit(s, selected, project, 'audio-processed.mp4', o);
  assert.equal(result.probe.streams.filter(stream => stream.codec_type === 'audio').length, 1);
  const rms = async (file, start, duration) => {
    const { stdout } = await execute(o.ffmpeg || 'ffmpeg', ['-v', 'error', '-ss', String(start), '-i', file, '-t', String(duration), '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2000000, timeout: 30000, windowsHide: true });
    let sum = 0; for (let i = 0; i + 4 <= stdout.length; i += 4) sum += stdout.readFloatLE(i) ** 2;
    assert.ok(stdout.length > 1000); return Math.sqrt(sum / (stdout.length / 4));
  };
  const [head, middle, tail, original] = await Promise.all([rms(result.output, 0.02, 0.08), rms(result.output, 1.2, 0.4), rms(result.output, 2.9, 0.08), rms(mediaFile, 1.2, 0.4)]);
  assert.ok(middle > head * 3 && middle > tail * 3, `Fades missing: ${head}/${middle}/${tail}`);
  assert.ok(middle > original * 1.25, `Normalization did not raise quiet source: ${middle}/${original}`);
}
async function hdr(s, o) {
  const source = path.join(s.env.mediaDir, 'hdr-fixture.mkv');
  await execute(o.ffmpeg || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-t', '3', '-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv', '-c:v', 'ffv1', source], { timeout: 30000, windowsHide: true });
  const selected = await selectMedia(s, source);
  assert.equal(selected.media.info.sourceFormat.hdr, true); assert.equal(selected.media.info.sourceFormat.bitDepth, 10);
  const project = { ...edit(3), profile: 'archive' };
  const preserved = await exportEdit(s, selected, project, 'hdr-preserved.mkv', o);
  const video = preserved.probe.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.color_transfer, 'smpte2084'); assert.equal(video.color_primaries, 'bt2020'); assert.match(video.pix_fmt, /10/);
  const converted = await exportEdit(s, selected, { ...project, profile: 'fast', colorMode: 'sdr' }, 'hdr-to-sdr.mp4', o);
  const sdr = converted.probe.streams.find(stream => stream.codec_type === 'video'); assert.equal(sdr.color_transfer, 'bt709'); assert.equal(sdr.pix_fmt, 'yuv420p');
}
async function run(name) {
  const o = h.parseOptions();
  const allowed = new Set(browserCases.has(name) ? ['--webkit', ...(name === 'full-workspace-audit' ? ['--expect-refined'] : [])] : name === 'roadmap-native' ? ['--packaged'] : []);
  for (const arg of process.argv.slice(2)) if (!allowed.has(arg)) throw new Error(`Unsupported ${name} option: ${arg}`);
  if (!browserCases.has(name) && process.platform !== 'win32') throw new Error(`Unsupported platform ${process.platform}: ${name} requires actual Windows production Electron`);
  const env = h.createEnvironment(name); let s;
  // The packaged gate has an outer 240 s budget, including process and fixture cleanup.
  const timeout = setTimeout(() => { console.error(`${name}: exceeded 220 second scenario budget`); process.exitCode = 1; void h.closeSession(s || env).finally(() => process.exit(1)); }, 220000);
  try {
    if (browserCases.has(name)) {
      s = await h.launchBrowser(env, { engine: o.webkit ? 'webkit' : 'chromium' });
      if (name === 'layout-consistency') await layout(s);
      else if (name === 'insights-integrated') await insights(s);
      else if (name === 'sidebar-layout') await sidebar(s);
      else if (name === 'roadmap-archive') await archiveBrowser(s);
      else if (name === 'roadmap-clips') await clipsBrowser(s);
      else if (name === 'audit-regressions') { await localization(s); await insights(s); await sidebar(s); }
      else { await layout(s); await insights(s); if (o.expectRefined) await refined(s); }
      assert.deepEqual(s.errors, [], 'Renderer or fixture runtime errors');
    } else {
      const media = await h.createMediaFixture(env, { duration: 3 });
      s = await h.launchElectron(env, { packaged: o.packaged });
      const preflight = await api(s, 'runPreflight', false);
      assert.ok(preflight.checks.ffmpeg && preflight.checks.ffprobe, 'Native media checks require runnable real ffmpeg and ffprobe on PATH');
      if (name === 'roadmap-projects') {
        const p = await projects(s, media.path); s = await reopen(s, o); await verifyReopenedProject(s, p.id, media.path);
      } else if (name === 'roadmap-library') {
        await inventory(s, media.path); const marker = await libraryMarker(s); s = await reopen(s, o); assert.deepEqual((await api(s, 'getVodLibrary')).markers, [marker]);
      } else if (name === 'roadmap-audio') await audio(s, media.path, o);
      else if (name === 'roadmap-hdr') await hdr(s, o);
      else if (name === 'roadmap-index') {
        const file = await inventory(s, media.path); fs.appendFileSync(file, Buffer.alloc(128));
        const updated = await api(s, 'searchArchive', { query: 'release-library', refresh: true }); assert.equal(updated.hits[0].size, fs.statSync(file).size);
        fs.unlinkSync(file); assert.equal((await api(s, 'searchArchive', { query: 'release-library', refresh: true })).matchCount, 0);
      } else if (name === 'roadmap-cleanup' || name === 'roadmap-cleanup-ui') await cleanup(s, media.path, name.endsWith('-ui'));
      else if (name === 'roadmap-clips') {
        const folder = path.join(env.downloadsDir, 'Clips'); fs.mkdirSync(folder); const file = path.join(folder, 'release-clip.mp4'); fs.copyFileSync(media.path, file);
        const clips = await api(s, 'getClipLibrary', 0, true); assert.ok(clips.files.some(f => f.fullPath === file));
        const result = await api(s, 'searchArchive', { type: 'clip', query: 'release-clip', refresh: true }); assert.ok(result.hits.some(h => h.fullPath === file && h.type === 'clip'));
        const refs = await api(s, 'prepareArchiveVideos', [file], 'merge'); assert.ok(refs[0]?.id && refs[0]?.token);
        assert.equal(await api(s, 'saveMergeWorkspace', refs.map(r => r.id)), true); s = await reopen(s, o);
        assert.equal((await api(s, 'getWorkspaceSession')).mergeFiles.length, 1);
      } else if (name === 'roadmap-native') {
        if (o.packaged) assert.equal(await s.app.evaluate(({ app }) => app.isPackaged), true);
        const p = await projects(s, media.path); const marker = await libraryMarker(s);
        s = await reopen(s, o); const selected = await verifyReopenedProject(s, p.id, media.path);
        assert.deepEqual((await api(s, 'getVodLibrary')).markers, [marker]); await exportEdit(s, selected, p.project, 'packaged-export.mp4', o);
      } else if (name === 'roadmap-archive-native') {
        const file = await inventory(s, media.path); const marker = await libraryMarker(s); const backup = path.join(env.mediaDir, 'release.tvmbackup');
        await dialogs(s, undefined, backup); const saved = await api(s, 'exportApplicationBackup'); assert.equal(saved.success, true, JSON.stringify(saved)); assert.ok(fs.statSync(backup).size > 0);
        await api(s, 'changeVodLibrary', { collection: 'markers', remove: marker.id });
        await dialogs(s, backup); // Suppress only the unmanaged relaunch; next launch keeps the same isolated arguments.
        await s.app.evaluate(({ app }) => { app.relaunch = () => {}; });
        const closed = s.app.waitForEvent('close', { timeout: 30000 });
        const restoring = api(s, 'restoreApplicationBackup').then(result => assert.equal(result.success, true), error => { if (!/closed|destroyed/i.test(String(error))) throw error; });
        await Promise.all([closed, restoring]); s = await h.launchElectron(env, { packaged: o.packaged });
        assert.deepEqual((await api(s, 'getVodLibrary')).markers, [marker]);
        assert.ok((await api(s, 'searchArchive', { query: 'release-library', refresh: true })).hits.some(h => h.fullPath === file));
      } else throw new Error(`Unknown workspace scenario: ${name}`);
      await h.assertIsolation(s);
    }
  } finally { try { await h.closeSession(s || env); } finally { clearTimeout(timeout); } }
  console.log(JSON.stringify({ scenario: name, result: 'passed', engine: browserCases.has(name) ? o.webkit ? 'webkit' : 'chromium' : o.packaged ? 'packaged-windows' : 'windows-electron' }));
}
module.exports = { run };
