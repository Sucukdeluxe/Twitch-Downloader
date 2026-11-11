/* global window, document, cutterControlsEnabled, cutterRecoveryDecisionPending, currentLanguage, changeCutterPlayerRange, cutterCutDraft, getCutterProjectPayload, cutterFile */
'use strict';
// Reconstructed public release checks. Browser transport fixtures test renderer behavior;
// native cases retain production persistence, capability, queue and media handlers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const delay = require('node:timers/promises').setTimeout;
const h = require('./release-test-harness.cjs');
const URL_A = 'https://clips.twitch.tv/ReleaseFixtureAlpha';
const URL_B = 'https://clips.twitch.tv/ReleaseFixtureBeta';
const vod = (id, extra = {}) => ({ id, url: 'https://www.twitch.tv/videos/' + (100000000 + Number(id.replace(/\D/g, '') || 1)), title: 'Fixture ' + id, streamer: 'fixture', date: '2026-01-01T00:00:00Z', duration_str: '12s', status: 'pending', progress: 0, ...extra });
const fixture = () => ({ overrides: { getClipInfo: { title: 'Fixture clip', broadcaster_name: 'fixture', thumbnail_url: '' } } });
async function readyClips(s) {
  await s.page.evaluate(() => window.showTab('clips'));
  await s.page.waitForFunction(() => !document.getElementById('clipUrl').disabled);
}
async function addClips(s, text) {
  await s.page.locator('#clipUrl').fill(text);
  await s.page.locator('#btnClipQueue').click();
  await s.page.waitForFunction(() => !document.getElementById('clipUrl').disabled);
}
async function countClips(s, count) {
  await s.page.waitForFunction(count => document.querySelectorAll('#clipsDownloadList .clip-result-row').length === count, count);
}
async function removeClips(s) {
  while (await s.page.locator('#clipsDownloadList .clip-result-row').count()) {
    const row = s.page.locator('#clipsDownloadList .clip-result-row').first();
    await row.getByRole('button', { name: /remove|entfernen/i }).click();
  }
}
async function clipsQueue(s) {
  await readyClips(s);
  await addClips(s, URL_A + '\nhttps://www.twitch.tv/fixture/clip/ReleaseFixtureAlpha?filter=clips\n' + URL_B + '\ninvalid link');
  await countClips(s, 2);
  assert.equal(await s.page.locator('#clipUrl').inputValue(), 'invalid link', 'Only invalid links remain in draft');
  assert.deepEqual(s.state.workspace.clips.map(row => row.url), [URL_A, URL_B], 'Canonical duplicate links must not create duplicate jobs');
  await s.page.waitForFunction(() => /invalid|ungültig/i.test(document.getElementById('clipStatus').textContent));
  await addClips(s, URL_A);
  await countClips(s, 2);
  await s.page.waitForFunction(() => /already|bereits/i.test(document.getElementById('clipStatus').textContent));
}
async function clipsWorkspace(s) {
  await readyClips(s);
  await addClips(s, URL_A);
  await countClips(s, 1);
  await s.page.locator('#clipUrl').fill(URL_B);
  await s.page.locator('#clipsHeading').click();
  await s.page.evaluate(() => window.showTab('vods'));
  await readyClips(s);
  assert.equal(await s.page.locator('#clipUrl').inputValue(), '/clip/ReleaseFixtureBeta');
  await s.page.reload();
  await readyClips(s);
  await countClips(s, 1);
  assert.equal(await s.page.locator('#clipUrl').inputValue(), '/clip/ReleaseFixtureBeta', 'Draft survives renderer reload');
  await s.page.locator('#clipsSavedTitle').click();
  assert.equal(await s.page.locator('#clipsSavedTitle').getAttribute('aria-selected'), 'true');
  assert.equal(await s.page.locator('#clipsDownloadsView').isVisible(), false);
  await s.page.locator('#clipsResultsTitle').click();
  await countClips(s, 1);
  assert.equal(await s.page.locator('#clipsDownloadsView').isVisible(), true);
}
async function clipsFourFixes(s) {
  await readyClips(s);
  // Draft selection remains editable and undo restores the complete pre-clear draft.
  await s.page.locator('#clipUrl').fill(URL_A + '\n' + URL_B);
  await s.page.locator('#clipsClearBtn').click();
  assert.equal(await s.page.locator('#clipUrl').inputValue(), '');
  await s.page.locator('#clipUrl').press('Control+z');
  assert.equal(await s.page.locator('#clipUrl').inputValue(), '/clip/ReleaseFixtureAlpha\n/clip/ReleaseFixtureBeta');
  await s.page.locator('#btnClipQueue').click();
  await countClips(s, 2);
  let attempts = [];
  await s.replaceIpc('downloadClip', async url => { attempts.push(url); return url === URL_A ? { success: true, filename: path.join(s.env.downloadsDir, 'clip.mp4') } : { success: false, error: 'Fixture transfer failed' }; });
  await s.page.locator('#btnClip').click();
  await s.page.waitForFunction(() => document.querySelectorAll('.clip-result-row.failed').length === 1 && document.querySelectorAll('.clip-result-row.done').length === 1);
  assert.equal(await s.page.locator('#clipsBatchProgress').getAttribute('aria-valuenow'), '100');
  assert.match(await s.page.locator('.clip-result-row.failed').innerText(), /Fixture transfer failed/);
  await s.replaceIpc('downloadClip', async url => { attempts.push(url); return { success: true, filename: path.join(s.env.downloadsDir, 'retry.mp4') }; });
  await s.page.locator('#clipsRetryBtn').click();
  await s.page.waitForFunction(() => document.querySelectorAll('.clip-result-row.done').length === 2);
  assert.deepEqual(attempts, [URL_A, URL_B, URL_B], 'Retry must select only failed clip');
  await removeClips(s);
  await countClips(s, 0);
  assert.equal(await s.page.locator('#clipsBatchProgress').getAttribute('aria-valuenow'), '0');
}
async function clipsEmptyReset(s) {
  await readyClips(s);
  await addClips(s, URL_A);
  await countClips(s, 1);
  await removeClips(s);
  await countClips(s, 0);
  assert.equal(await s.page.locator('#clipsResults').getAttribute('data-empty'), 'true');
  assert.equal(await s.page.locator('#btnClip').isDisabled(), true);
  assert.equal(await s.page.locator('#clipsRetryBtn').isVisible(), false);
  assert.equal(await s.page.locator('#clipsBatchProgress').getAttribute('aria-valuenow'), '0');
  await s.page.waitForFunction(async () => (await window.api.getWorkspaceSession()).clips.length === 0);
  await s.page.reload();
  await readyClips(s);
  await countClips(s, 0);
  await addClips(s, URL_B);
  await countClips(s, 1);
  assert.equal(await s.page.locator('#btnClip').isDisabled(), false, 'Fresh queue remains usable after empty reset');
}
async function fullQueue(s) {
  const rows = [vod('1'), vod('2', { status: 'downloading', progress: 35 }), vod('3', { status: 'paused', progress: 25 }), vod('4', { status: 'error', error: 'Fixture network error' }), vod('5', { status: 'completed', progress: 100, outputFiles: [path.join(s.env.downloadsDir, 'done.mp4')] })];
  await s.emit('queue-updated', rows);
  await s.page.evaluate(() => { window.showTab('vods'); window.setVodsWorkspace('queue'); });
  await s.page.waitForFunction(() => document.querySelectorAll('#queueList .queue-item').length === 5);
  for (const row of rows) assert.equal(await s.page.locator(`.queue-item[data-id="${row.id}"] .status.${row.status}`).count(), 1);
  const pending = s.page.locator('.queue-item[data-id="1"]');
  await pending.locator('[data-queue-action="details"]').click();
  assert.equal(await pending.locator('[data-queue-action="details"]').getAttribute('aria-expanded'), 'true');
  assert.equal(await pending.locator('[data-queue-action="output"]').isVisible(), true);
  await s.page.locator('.queue-item[data-id="4"] [data-queue-action="retry"]').click();
  await s.page.waitForFunction(() => document.querySelector('.queue-item[data-id="4"] .status.pending'));
  assert.equal(s.state.queue.find(row => row.id === '4').status, 'pending');
  await s.page.locator('.queue-item[data-id="3"] [data-queue-action="remove"]').click();
  await s.page.waitForFunction(() => !document.querySelector('.queue-item[data-id="3"]'));
  await s.page.locator('#btnClear').click();
  await s.page.waitForFunction(() => !document.querySelector('.queue-item[data-id="5"]'));
  assert.deepEqual(s.state.queue.map(row => row.id), ['1', '2', '4']);
  assert.equal(s.state.queue.find(row => row.id === '2').progress, 35, 'Clearing completed must preserve active progress');
}
async function queueStartup(s, options) {
  const startup = await s.page.evaluate(() => window.api.getQueue());
  assert.equal(startup.length, 1, 'Startup must clear completed persisted items and keep pending work');
  const expected = vod('startup-pending');
  assert.equal(startup[0].url, expected.url);
  assert.equal(startup[0].title, expected.title);
  assert.equal(startup[0].status, 'pending');
  assert.ok(startup[0].id, 'Restored work must have a usable runtime ID');
  await s.page.evaluate(id => window.api.removeFromQueue(id), startup[0].id);
  const item = vod('11'); delete item.id; delete item.status; delete item.progress;
  const accepted = await s.page.evaluate(item => window.api.addToQueueWithResult(item), item);
  assert.equal(accepted.accepted, true);
  await s.app.close();
  // The environment owns all launched processes, including cleanup on assertions.
  const reopened = await h.launchElectron(s.env, { packaged: options.packaged });
  const restored = await reopened.page.evaluate(() => window.api.getQueue());
  assert.equal(restored.length, 1, 'Pending queue survives a real process restart');
  assert.equal(restored[0].url, item.url);
  assert.equal(restored[0].title, item.title);
  assert.equal(restored[0].status, 'pending');
  await reopened.page.evaluate(async () => window.api.saveConfig({ ...(await window.api.getConfig()), persist_queue_on_restart: false }));
  assert.deepEqual(reopened.errors, [], 'Restarted renderer has no errors');
  await reopened.app.close();
  const next = await h.launchElectron(s.env, { packaged: options.packaged });
  assert.deepEqual(await next.page.evaluate(() => window.api.getQueue()), [], 'Disabling persistence clears the next startup queue');
  assert.deepEqual(next.errors, [], 'Final restarted renderer has no errors');
  await next.app.close();
}
async function queueMergeControls(s) {
  const rows = [vod('21'), vod('22'), vod('23')].map(({ id: _id, status: _status, progress: _progress, ...item }) => item);
  for (const item of rows) assert.equal((await s.page.evaluate(item => window.api.addToQueueWithResult(item), item)).accepted, true);
  await s.page.evaluate(() => { window.showTab('vods'); window.setVodsWorkspace('queue'); });
  await s.page.waitForFunction(() => document.querySelectorAll('#queueList .queue-item').length === 3);
  const queue = await s.page.evaluate(() => window.api.getQueue());
  for (const index of [1, 0]) await s.page.locator(`.queue-item[data-id="${queue[index].id}"] [data-queue-action="merge-select"]`).click();
  assert.equal(await s.page.locator('#btnMergeGroup').isVisible(), true);
  await s.page.locator('#btnMergeGroup').click();
  await s.page.waitForFunction(async () => (await window.api.getQueue()).length === 2);
  const merged = (await s.page.evaluate(() => window.api.getQueue())).find(item => item.mergeGroup);
  assert.deepEqual(merged.mergeGroup.items.map(item => item.title), [rows[1].title, rows[0].title], 'Selection order must survive production merge creation');
  assert.equal(merged.mergeGroup.totalDurationSec, 24);
  assert.equal(await s.page.locator(`.queue-item[data-id="${merged.id}"] [data-queue-action="merge-select"]`).count(), 0);
}
async function saveDialog(s, file) { await s.app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file); }
async function probe(file, options) {
  const { stdout } = await execFile(options.ffprobe || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { timeout: 30000, windowsHide: true });
  return JSON.parse(stdout);
}
function segments(project) {
  const ranges = []; let start = project.trimStart;
  for (const cut of [...project.cuts].sort((a, b) => a.start - b.start)) {
    if (cut.start > start) ranges.push({ start, end: cut.start });
    start = cut.end;
  }
  if (start < project.trimEnd) ranges.push({ start, end: project.trimEnd });
  return ranges;
}
async function verifyContent(output, source, ranges, options) {
  const frame = async (file, time) => {
    const { stdout } = await execFile(options.ffmpeg || 'ffmpeg', ['-v', 'error', '-i', file, '-ss', String(time),
      '-frames:v', '1', '-vf', 'scale=80:46', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { timeout: 30000, windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 });
    assert.equal(stdout.length, 80 * 46, 'Expected one complete decoded frame'); return stdout;
  };
  let offset = 0;
  for (const range of ranges) {
    const middle = (range.end - range.start) / 2;
    const [actual, expected] = await Promise.all([frame(output, offset + middle), frame(source, range.start + middle)]);
    const meanError = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length;
    assert.ok(meanError < 7, `Decoded segment at ${offset + middle}s does not match source ${range.start + middle}s (MAE ${meanError})`);
    offset += range.end - range.start;
  }
  await execFile(options.ffmpeg || 'ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeout: 30000, windowsHide: true });
}
async function waitJobs(s, ids) {
  await s.page.waitForFunction(async ids => { const { jobs } = await window.api.listExportJobs(); return ids.every(id => jobs.some(job => job.id === id && ['completed', 'failed', 'cancelled'].includes(job.status))); }, ids, { timeout: 120000 });
  const { jobs } = await s.page.evaluate(() => window.api.listExportJobs());
  return ids.map(id => jobs.find(job => job.id === id));
}
function cancellationArtifacts(target) {
  const extension = path.extname(target);
  const prefix = '.' + path.basename(target, extension) + '.';
  return fs.readdirSync(path.dirname(target))
    .filter(name => name.startsWith(prefix) && (name.endsWith('.export' + extension) || name.endsWith('.export' + extension + '.ffconcat')))
    .map(name => path.join(path.dirname(target), name));
}
async function cancelDuringEncode(s, id, target) {
  assert.deepEqual(cancellationArtifacts(target), [], 'Cancellation destination must start without temporary artifacts');
  assert.equal(fs.existsSync(target), false, 'Cancellation destination must start empty');
  assert.equal((await s.page.evaluate(() => window.api.exportJobAction('start'))).success, true);
  const deadline = Date.now() + 60000;
  let observed;
  while (Date.now() < deadline) {
    const state = await s.page.evaluate(() => window.api.listExportJobs());
    const job = state.jobs.find(job => job.id === id);
    assert.ok(job, 'Cancellation job disappeared');
    assert.ok(!['completed', 'failed', 'cancelled'].includes(job.status),
      'Export finished before a real in-flight encode could be cancelled: ' + JSON.stringify(job));
    const partials = cancellationArtifacts(target).filter(file => file.endsWith('.export.mp4'));
    const partial = partials.find(file => fs.statSync(file).size > 256);
    // The queue emits running before spawning FFmpeg. Positive encoder progress AND
    // encoded bytes in its unpublished output establish that cancellation is mid-encode.
    if (job.status === 'running' && job.progress > 0 && job.progress < 99 && partial) {
      observed = { progress: job.progress, bytes: fs.statSync(partial).size, partial };
      break;
    }
    await delay(25);
  }
  assert.ok(observed, 'No positive FFmpeg progress with an owned encoded partial within 60 seconds');
  const result = await s.page.evaluate(id => window.api.exportJobAction('cancel', id), id);
  assert.equal(result.success, true, JSON.stringify(result));
  const [job] = await waitJobs(s, [id]);
  assert.equal(job.status, 'cancelled', JSON.stringify(job));
  assert.equal(job.outputName, null, 'Cancelled export must not claim a completed output');
  const cleanupDeadline = Date.now() + 5000;
  while (cancellationArtifacts(target).length && Date.now() < cleanupDeadline) await delay(25);
  assert.deepEqual(cancellationArtifacts(target), [], 'Cancelled encode must remove its .export.mp4 and .ffconcat artifacts');
  assert.equal(fs.existsSync(target), false, 'Cancelled encode must not publish its output');
  return observed;
}
async function trimMergeRepair(s, options) {
  const media = await h.createMediaFixture(s.env, { duration: 12, ffmpeg: options.ffmpeg || 'ffmpeg', ffprobe: options.ffprobe || 'ffprobe' });
  await s.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, media.path);
  await s.page.evaluate(() => window.showTab('cutter'));
  await s.page.locator('#cutterBrowseBtn').click();
  await s.page.waitForFunction(() => cutterControlsEnabled && !cutterRecoveryDecisionPending, null, { timeout: 90000 });
  assert.equal(await s.page.evaluate(() => currentLanguage), options.de ? 'de' : 'en');
  if (options.light) assert.equal(await s.page.locator('body').evaluate(element => element.classList.contains('theme-light')), true);
  const cuts = [{ id: 'omission-one', start: 3, end: 4 }, ...(options.twoOmissions ? [{ id: 'omission-two', start: 7, end: 8 }] : [])];
  await s.page.locator('#startTime').fill('00:00:01:00');
  await s.page.locator('#startTime').press('Tab');
  await s.page.locator('#endTime').fill('00:00:11:00');
  await s.page.locator('#endTime').press('Tab');
  for (const cut of cuts) {
    await s.page.locator('#cutterOmitMode').click();
    await s.page.locator('#cutterNewCutBtn').click();
    await s.page.locator('#cutterOmitStartHandle').waitFor();
    await s.page.evaluate(({ start, end }) => changeCutterPlayerRange(start, end, cutterCutDraft.id,
      { source: 'keyboard', boundary: 'start' }), cut);
    await s.page.locator('.cutter-cut-row.active .cutter-cut-actions .btn-secondary').click();
    await s.page.waitForFunction(() => !cutterCutDraft);
  }
  const project = await s.page.evaluate(() => getCutterProjectPayload());
  assert.equal(project.trimStart, 1); assert.equal(project.trimEnd, 11);
  assert.deepEqual(project.cuts.map(({ start, end }) => ({ start, end })), cuts.map(({ start, end }) => ({ start, end })));
  project.profile = 'fast'; project.encoder = 'software';
  const outputs = [];
  const ids = [];
  // Parts mode queues two real output sections, retaining exclusions in their section.
  const projects = options.parts ? [{ ...project, trimEnd: 6, cuts: cuts.filter(cut => cut.start < 6) }, { ...project, trimStart: 6, cuts: cuts.filter(cut => cut.start >= 6) }] : [project];
  for (let i = 0; i < projects.length; i++) {
    const file = path.join(s.env.downloadsDir, `trim-Part${i + 1}.mp4`); outputs.push(file);
    await saveDialog(s, file);
    const result = await s.page.evaluate(project => window.api.enqueueCutterExport(cutterFile.token, project), projects[i]);
    assert.equal(result.success, true, JSON.stringify(result)); ids.push(result.job.id);
  }
  await s.page.evaluate(() => window.api.exportJobAction('start'));
  const jobs = await waitJobs(s, ids);
  for (let i = 0; i < jobs.length; i++) {
    assert.equal(jobs[i].status, 'completed', JSON.stringify(jobs[i]));
    const metadata = await probe(outputs[i], options);
    const duration = projects[i].trimEnd - projects[i].trimStart - projects[i].cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0);
    assert.ok(Math.abs(Number(metadata.format.duration) - duration) < .25, 'Trim export duration must account for exclusions');
    assert.ok(metadata.streams.some(stream => stream.codec_type === 'video') && metadata.streams.some(stream => stream.codec_type === 'audio'), 'Trim export must preserve video and audio');
    await verifyContent(outputs[i], media.path, segments(projects[i]), options);
  }
  await s.page.evaluate(() => window.api.exportJobAction('pause'));
  const mergeInputs = outputs.length === 2 ? outputs : [outputs[0], media.path];
  await s.app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, mergeInputs);
  const selected = await s.page.evaluate(() => window.api.selectMultipleVideos());
  assert.equal(selected.length, 2);
  const target = path.join(s.env.downloadsDir, 'merged.mp4');
  await saveDialog(s, target);
  const merged = await s.page.evaluate(ids => window.api.enqueueMergeExport(ids, 'encode'), selected.map(row => row.id));
  assert.equal(merged.success, true, JSON.stringify(merged));
  await s.page.evaluate(() => window.api.exportJobAction('start'));
  assert.equal((await waitJobs(s, [merged.job.id]))[0].status, 'completed');
  const duration = (options.parts ? 10 : 22) - cuts.length;
  assert.ok(Math.abs(Number((await probe(target, options)).format.duration) - duration) < .3, 'Merged output duration must preserve all edited sections');
  const mergedSegments = options.parts ? projects.flatMap(segments) : [...segments(project), { start: 0, end: 12 }];
  await verifyContent(target, media.path, mergedSegments, options);
  if (options.cancel) {
    await s.page.evaluate(() => window.api.exportJobAction('pause'));
    // A separate, long high-resolution fixture prevents fast hosts from finishing
    // before the first observable FFmpeg progress/packet write.
    const longMedia = await h.createMediaFixture(s.env, { name: 'cancel-source.mp4', duration: 45,
      width: 1280, height: 720, fps: 30, ffmpeg: options.ffmpeg || 'ffmpeg', ffprobe: options.ffprobe || 'ffprobe' });
    const secondSource = path.join(s.env.mediaDir, 'cancel-source-second.mp4');
    fs.copyFileSync(longMedia.path, secondSource, fs.constants.COPYFILE_EXCL);
    await s.app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [longMedia.path, secondSource]);
    const cancellationSources = await s.page.evaluate(() => window.api.selectMultipleVideos());
    assert.equal(cancellationSources.length, 2);
    const cancelledPath = path.join(s.env.downloadsDir, 'cancelled.mp4');
    await saveDialog(s, cancelledPath);
    const queued = await s.page.evaluate(ids => window.api.enqueueMergeExport(ids, 'encode'), cancellationSources.map(row => row.id));
    assert.equal(queued.success, true, JSON.stringify(queued));
    const observation = await cancelDuringEncode(s, queued.job.id, cancelledPath);
    console.log(JSON.stringify({ cancellation: 'mid-encode', progress: observation.progress, encodedBytes: observation.bytes }));
  }
}
const cases = {
  'clips-queue': { run: clipsQueue }, 'clips-workspace': { run: clipsWorkspace },
  'clips-four-fixes': { run: clipsFourFixes }, 'clips-empty-reset': { run: clipsEmptyReset },
  'full-queue-audit': { run: fullQueue },
  'queue-startup': { native: true, run: queueStartup },
  'clips-empty-reset-native': { native: true, run: clipsEmptyReset },
  'queue-merge-controls': { native: true, run: queueMergeControls },
  'trim-merge-repair': { native: true, run: trimMergeRepair },
};
async function run(name, argv = process.argv.slice(2)) {
  const definition = cases[name]; assert.ok(definition, 'Unknown queue case: ' + name);
  const options = h.parseOptions(argv);
  const allowed = new Set(definition.native ? ['--packaged'] : ['--webkit']);
  if (name === 'trim-merge-repair') for (const flag of ['--two-omissions', '--de', '--light', '--parts', '--cancel']) allowed.add(flag);
  for (const arg of argv) if (!allowed.has(arg) && !(name === 'trim-merge-repair' && !arg.startsWith('-'))) throw new Error(`Unsupported option for ${name}: ${arg}`);
  if (definition.native && process.platform !== 'win32') throw new Error(`${name}: unsupported platform ${process.platform}; real Windows Electron is required`);
  const env = h.createEnvironment(name, { persist_queue_on_restart: true, language: options.de ? 'de' : 'en', theme: options.light ? 'light' : 'twitch' });
  if (name === 'queue-startup') fs.writeFileSync(env.queueFile, JSON.stringify([vod('startup-pending'), vod('startup-completed', { status: 'completed', progress: 100 })]));
  const previousPath = process.env.PATH;
  if (definition.native) {
    const directories = [options.ffmpeg, options.ffprobe].filter(Boolean).filter(file => path.isAbsolute(file)).map(file => path.dirname(file));
    if (directories.length) process.env.PATH = [...new Set(directories), previousPath || ''].join(path.delimiter);
  }
  let session;
  try {
    session = definition.native ? await h.launchElectron(env, { packaged: options.packaged, fixture: fixture() })
      : await h.launchBrowser(env, { engine: options.webkit ? 'webkit' : 'chromium', fixture: fixture() });
    await definition.run(session, options);
    if (name !== 'queue-startup') await h.assertIsolation(session);
    assert.deepEqual(session.errors, [], 'Unexpected renderer/fixture failures');
    console.log(JSON.stringify({ case: name, status: 'passed', engine: definition.native ? 'windows-electron' : options.webkit ? 'webkit' : 'chromium' }));
  } finally {
    try { await h.closeSession(session || env); }
    finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  }
}
module.exports = { run };
