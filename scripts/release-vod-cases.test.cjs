'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./release-test-harness.cjs');
const { installNativeVodTransport, stalledServer, sourceReference, assertLosslessRange } = require('./release-vod-cases.cjs');
const { createTemporalFixture, assertPreciseRange } = require('./smoke-test-precise-trim');
const { resolveVodPlaybackSource } = require('../dist/main/domain/vod-quality.js');
const { fetchHlsMediaPlaylist } = require('../dist/main/domain/vod-live-snapshot.js');
const { planVodTrimEpochs, buildVodSpoolArgs, transferVodSource, vodSpoolSeekOffset } = require('../dist/main/domain/vod-trim-transfer.js');
const { readVodPlaylistTimeline, buildPreciseVodTrimArgs } = require('../dist/main/domain/vod-precise-trim.js');
const { runMediaProcess } = require('../dist/main/domain/media-process.js');
const { remuxMp4 } = require('../dist/main/domain/mp4-remux.js');
const { isVodSourceReadTimeout, buildVodSourceDownloadArgs } = require('../dist/main/domain/vod-source-download.js');
const CDN = 'https://fixture.cloudfront.net/chunked/index.m3u8';
const resolveTool = value => /[\\/]/.test(value) && !path.isAbsolute(value) ? path.resolve(value) : value;
const ffmpeg = resolveTool(process.env.FFMPEG_PATH || 'ffmpeg');
const ffprobe = resolveTool(process.env.FFPROBE_PATH || 'ffprobe');
let nextVod = 999999999990000;

async function fixture() {
  const env = harness.createEnvironment('native-vod-transport-contract');
  try {
    const source = await createTemporalFixture(env.mediaDir, { ffmpeg, ffprobe, duration: 16, fps: '25', name: 'index' });
    const routes = {};
    for (const filename of fs.readdirSync(env.mediaDir).filter(file => /\.(m3u8|ts)$/.test(file))) {
      const file = path.join(env.mediaDir, filename);
      routes[`/chunked/${filename}`] = { file, headers: { 'Content-Length': fs.statSync(file).size,
        'Content-Type': filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        'Access-Control-Allow-Origin': '*' } };
    }
    const server = await harness.createHttpFixture(env, routes);
    source.url = `${server.url}/chunked/index.m3u8`; source.server = server;
    return { env, source, ffmpeg, ffprobe };
  } catch (error) { await harness.closeSession(env); throw error; }
}
async function sourcePlaylist(url) {
  globalThis.__vodFixtureSource = url;
  const resolved = await resolveVodPlaybackSource(`https://www.twitch.tv/videos/${++nextVod}`, 'source');
  assert.equal(resolved, CDN, 'The real unavailable-variant resolver must return a trusted HTTPS source');
  const playlist = await fetchHlsMediaPlaylist(resolved);
  assert(playlist.ended && playlist.segments.length > 0);
  assert(playlist.segments.every(segment => segment.uri.startsWith('https://fixture.cloudfront.net/chunked/')));
  return playlist;
}
function snapshot(ctx, text, name) {
  const file = path.join(ctx.env.tempDir, `${name}.m3u8`);
  fs.writeFileSync(file, text);
  return file;
}
async function spool(ctx, playlist, name) {
  const file = path.join(ctx.env.tempDir, `${name}.ts`);
  await transferVodSource({ command: ffmpeg, args: buildVodSpoolArgs(playlist), outputPath: file });
  return file;
}
function restore() {
  globalThis.__restoreNativeVodTransport?.();
  for (const name of ['__restoreNativeVodTransport', '__vodFixtureSource', '__vodNetworkCalls', '__vodProcesses', '__vodSnapshotTransports']) delete globalThis[name];
}

test('native VOD fixture preserves source validation, bounded transfer and precise HLS timing', { timeout: 45000 }, async () => {
  const ctx = await fixture();
  try {
    // Obtain an independent HLS.js video / original-source audio oracle without Electron.
    const reference = await sourceReference(ctx);
    installNativeVodTransport(null, { rootDir: ctx.env.rootDir });
    const playlist = await sourcePlaylist(ctx.source.url);
    await assert.rejects(fetchHlsMediaPlaylist(ctx.source.url), /Invalid VOD media host/);
    for (const [name, start, length] of [['middle', 4, 4], ['fractional', 4.513, 4.014], ['start-zero', 0, 1.013], ['tail', 12, 4]]) {
      const [plan] = planVodTrimEpochs(playlist, start, length);
      const input = await spool(ctx, snapshot(ctx, plan.text, name), name);
      const prefix = plan.originText ? await spool(ctx, snapshot(ctx, plan.originText, `${name}-origin`), `${name}-origin`) : input;
      const timeline = await readVodPlaylistTimeline(ffprobe, input), origin = await readVodPlaylistTimeline(ffprobe, prefix);
      const output = path.join(ctx.env.downloadsDir, name + '.mp4');
      await runMediaProcess(ffmpeg, buildPreciseVodTrimArgs({ input, output, start: plan.timelineStartSeconds, duration: plan.durationSeconds,
        seekOffset: vodSpoolSeekOffset(origin.originSeconds, timeline.formatStartSeconds, plan.timelineStartSeconds, false), seekAfterInput: true }));
      await assertPreciseRange(output, reference, [{ start, end: start + length }], ctx);
    }
    const wholeSource = path.join(ctx.env.tempDir, 'whole.ts');
    await transferVodSource({ command: ffmpeg, args: buildVodSourceDownloadArgs(CDN, null, null, 16), outputPath: wholeSource });
    const whole = path.join(ctx.env.downloadsDir, 'whole.mp4');
    await remuxMp4({ inputPath: wholeSource, outputPath: whole, ffmpegPath: ffmpeg, ffprobePath: ffprobe, durationSeconds: 16 });
    await assertLosslessRange(ctx, whole, 0, 16);
    assert(globalThis.__vodSnapshotTransports.length >= 4, 'Production snapshots must reach the transport redirect');
    assert(globalThis.__vodNetworkCalls.some(url => url.startsWith('https://gql.twitch.tv/')));
    assert(globalThis.__vodNetworkCalls.some(url => url.startsWith('https://usher.ttvnw.net/')));
    assert(globalThis.__vodProcesses.every(child => child.closed), 'No media process may remain active');
  } finally { restore(); await harness.closeSession(ctx.env); }
});

test('native stall fixture serves valid metadata then exercises the real 30 second media read timeout', { timeout: 55000 }, async () => {
  const ctx = await fixture();
  let server;
  try {
    server = await stalledServer(fs.readFileSync(ctx.source.playlist, 'utf8'));
    installNativeVodTransport(null, { rootDir: ctx.env.rootDir });
    const playlist = await sourcePlaylist(server.url);
    const [plan] = planVodTrimEpochs(playlist, 0, 4);
    const input = snapshot(ctx, plan.text, 'stall');
    const output = path.join(ctx.env.tempDir, 'stall.ts');
    const before = Date.now();
    await assert.rejects(transferVodSource({ command: ffmpeg, args: buildVodSpoolArgs(input), outputPath: output }),
      error => isVodSourceReadTimeout(String(error)));
    const elapsed = Date.now() - before;
    assert(elapsed >= 27000 && elapsed < 50000, `The production read timeout took ${elapsed}ms`);
    assert(server.calls.includes('/chunked/index.m3u8'));
    assert(server.calls.some(url => url.endsWith('.ts')), 'The stalled operation must be a media read');
    assert(!fs.existsSync(output), 'Failed source transfer must remove its partial output');
    assert.equal(globalThis.__vodProcesses.length, 1);
    const child = globalThis.__vodProcesses[0];
    assert(child.closed && child.code !== 0);
    assert.equal(child.args[child.args.indexOf('-rw_timeout') + 1], '30000000');
    assert(isVodSourceReadTimeout(child.stderr), child.stderr);
  } finally { restore(); await server?.close(); await harness.closeSession(ctx.env); }
});
