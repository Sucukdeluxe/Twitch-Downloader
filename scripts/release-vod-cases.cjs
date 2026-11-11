'use strict';

// Reconstructed public release checks, not the missing private Windows suite.
// Twitch/CDN responses are fixtures; the player, timeline, source resolver,
// FFmpeg arguments, media process and partial-file registry are production code.
/* global window, document */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const harness = require('./release-test-harness.cjs');
const productionModules = {
  'update-version-utils': () => require('../dist/main/domain/update-version-utils.js'),
  'media-process': () => require('../dist/main/domain/media-process.js'),
  'vod-playback-service': () => require('../dist/main/domain/vod-playback-service.js'),
  'vod-timeline': () => require('../dist/main/domain/vod-timeline.js'),
  'vod-source-download': () => require('../dist/main/domain/vod-source-download.js'),
};
const production = name => productionModules[name]();
const VOD = 'https://www.twitch.tv/videos/999999999999999';
const CDN = 'https://fixture.cloudfront.net';
const STARTED = '2026-01-01T00:00:00.000Z';

function optionsFor(name, argv) {
  const native = name.startsWith('stall-');
  for (const arg of argv) {
    if (arg.startsWith('-') && !(arg === '--webkit' && !native && name !== 'update-version')) {
      throw new Error(`Unsupported option for ${name}: ${arg}`);
    }
  }
  const options = harness.parseOptions(argv);
  if (name === 'update-version' && argv.length) throw new Error('update-version takes no arguments');
  if (native && process.platform !== 'win32') throw new Error(`Unsupported platform ${process.platform}: ${name} requires native Windows (win32)`);
  if (native && !options.ffmpeg) throw new Error(`${name} requires positional ffmpeg [ffprobe] paths`);
  return options;
}

function updateVersion() {
  const { normalizeUpdateVersion, compareUpdateVersions, isNewerUpdateVersion } = production('update-version-utils');
  for (const [left, right, expected] of [
    ['1.0.2', '1.0.1', 1], ['1.0.1', '1.0.2', -1], ['v1.0.1', '1.0.1', 0],
    ['1.0.1', '1.0.1.1', -1], ['2.0.0', '1.99.999', 1], ['1.0.1-beta', '1.0.1', 0],
    ['1.1.21', '1.1.20', 1], ['1.10.0', '1.9.99', 1], ['1.1.21.0', '1.1.21', 0],
    [null, undefined, 0], ['', '1.1.21', -1], ['1.1.21', '', 1],
  ]) {
    assert.equal(compareUpdateVersions(left, right), expected, `${left} versus ${right}`);
    assert.equal(isNewerUpdateVersion(left, right), expected > 0);
  }
  assert.equal(normalizeUpdateVersion(' V1.1.21 '), '1.1.21');
  assert.equal(normalizeUpdateVersion(null), '');
  // A stale downloaded installer must not suppress the newer release.
  assert.equal(isNewerUpdateVersion('1.1.21', '1.1.20'), true);
  assert.equal(isNewerUpdateVersion('1.1.21', '1.1.21'), false);
  assert.equal(isNewerUpdateVersion('1.1.20', '1.1.21'), false);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function media(env, options, duration = 16, native = false) {
  const fixture = await harness.createMediaFixture(env, { ffmpeg: options.ffmpeg || 'ffmpeg', ffprobe: options.ffprobe || 'ffprobe',
    duration, width: native ? 640 : 160, height: native ? 360 : 90, fps: native ? 30 : 10 });
  const playlist = path.join(env.mediaDir, 'index.m3u8');
  await production('media-process').runMediaProcess(options.ffmpeg || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', fixture.path,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', native ? '60' : '20', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(env.mediaDir, 'segment-%03d.ts'), playlist,
  ]);
  const routes = {};
  for (const filename of fs.readdirSync(env.mediaDir)) {
    if (!/\.(m3u8|ts)$/.test(filename)) continue;
    routes[`/${filename}`] = { file: path.join(env.mediaDir, filename), headers: {
      'Content-Type': filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
    } };
  }
  for (const [route, value] of Object.entries(routes)) routes[`/chunked${route}`] = value;
  const server = await harness.createHttpFixture(env, routes);
  return { ...fixture, server, url: `${server.url}/index.m3u8` };
}

function metadata(duration, revision = 0, live = false) {
  const chapter = (at, end, name, id) => ({ cursor: `cursor-${id}`, node: { id, type: 'GAME_CHANGE',
    positionMilliseconds: at * 1000, durationMilliseconds: (end - at) * 1000,
    details: { game: { id, displayName: name } } } });
  return { data: { video: { id: '999999999999999', title: 'Release fixture VOD', status: live ? 'RECORDING' : 'RECORDED',
    createdAt: STARTED, lengthSeconds: duration, owner: { login: 'fixture_streamer' },
    moments: { edges: [chapter(0, duration / 2, 'Fixture Adventure', '1'),
      ...(revision ? [chapter(duration / 2, duration, 'Fixture Strategy', '2')] : [])], pageInfo: { hasNextPage: false } },
  } } };
}

async function context(name, options, { duration = 16, live = false, delayOpen = false } = {}) {
  const env = harness.createEnvironment(name);
  let session;
  const { VodPlaybackService } = production('vod-playback-service');
  const { VodTimelineService } = production('vod-timeline');
  let playback, timeline;
  try {
    const source = await media(env, options, duration);
    let revision = live ? 0 : 1;
    const metadataServer = await harness.createHttpFixture(env, {
      '/gql': request => { assert.equal(request.method, 'POST'); return { body: metadata(duration, revision, live) }; },
      '/history': { body: { source: 'streamrecorder', login: 'fixture_streamer', streamId: '999',
        started: Date.parse(STARTED), ended: Date.parse(STARTED) + duration * 1000,
        titleHistory: [{ id: 'title-1', at: Date.parse(STARTED), until: Date.parse(STARTED) + duration * 1000,
          title: 'Fixture title history', kind: 'initial', precision: 'source' }], viewerHistory: [] } },
    });
    playback = new VodPlaybackService((url, init) => {
      assert.equal(new URL(url).origin, CDN, 'No real CDN requests are permitted');
      return fetch(source.server.url + new URL(url).pathname, init);
    });
    timeline = new VodTimelineService((url, init) => {
      assert.equal(url, 'https://gql.twitch.tv/gql');
      return fetch(`${metadataServer.url}/gql`, init);
    }, (url, init) => {
      assert.ok(url.startsWith('https://streamrecorder.eu/api/streamers/fixture_streamer/'));
      return fetch(`${metadataServer.url}/history`, init);
    });
    const opening = deferred(), released = deferred(), cancelled = deferred();
    let openCount = 0;
    const fixture = { overrides: {
      openVodPlayback: request => playback.open(request, {
        quality: 'source',
        async resolveSource(signal) {
          openCount++;
          opening.resolve(request);
          if (delayOpen && openCount === 1) {
            signal.addEventListener('abort', () => cancelled.resolve(request.id), { once: true });
            await released.promise;
          }
          return `${CDN}/index.m3u8`;
        },
        prepare: () => { throw new Error('Direct CDN source must not install tools'); },
        streamlink: () => { throw new Error('Direct CDN source must not invoke Streamlink'); },
      }).catch(error => {
        if (delayOpen && /abort|cancel/i.test(String(error))) return null;
        throw error;
      }),
      closeVodPlayback: async id => { timeline.close(id); await playback.close(id); return true; },
      getVodTimeline: request => timeline.load(request, env.downloadsDir),
    } };
    session = await harness.launchBrowser(env, { engine: options.webkit ? 'webkit' : 'chromium', fixture });
    // Electron's file renderer sends Origin:null. Relay only this real loopback
    // service's media requests with that origin; keep its host/path checks intact.
    let closing = false;
    const routeErrors = [];
    await session.page.route(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\//, async route => {
      try {
        const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'null' } });
        await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
      } catch (error) {
        if (!closing && !route.request().failure()) routeErrors.push(String(error));
        await route.abort().catch(() => {});
      }
    });
    return { env, session, source, playback, timeline, opening, released, cancelled, metadataServer, routeErrors,
      revise: () => { revision++; },
      async close() { closing = true; released.resolve(); await session.page.close(); timeline.close(); await playback.close(); await harness.closeSession(session); },
    };
  } catch (error) { timeline?.close(); await playback?.close(); await harness.closeSession(session || env); throw error; }
}

async function openDialog(ctx) {
  await ctx.session.page.evaluate(({ url, date, duration }) => {
    window.openClipDialog(url, 'Release fixture VOD', date, 'fixture_streamer', `${duration}s`);
  }, { url: VOD, date: STARTED, duration: ctx.source.duration });
  await ctx.session.page.locator('#clipModal[aria-hidden="false"]').waitFor();
}
async function ready(ctx) {
  await ctx.session.page.waitForFunction(() => {
    const video = document.querySelector('#clipPlayer video.active');
    return video && video.readyState >= 2 && video.videoWidth > 0 && !video.error;
  }, null, { timeout: 30000 });
  await ctx.session.page.locator('#clipHistory .chapter-seek').first().waitFor();
}
async function seek(ctx, seconds) {
  const page = ctx.session.page;
  await page.evaluate(() => document.querySelector('#clipPlayer video.active').pause());
  await page.locator('#clipPlayer .player-time-button').click();
  await page.locator('.player-exact-time input').fill(String(seconds));
  await page.locator('.player-exact-time button[type="submit"]').click();
  await ctx.session.page.waitForFunction(value => {
    const video = document.querySelector('#clipPlayer video.active');
    return video && !video.seeking && Math.abs(video.currentTime - value) < .35;
  }, seconds);
}
async function cleanBrowser(ctx) {
  await harness.assertIsolation(ctx.session);
  assert.deepEqual(ctx.routeErrors, [], 'Unexpected playback proxy failure');
  assert.deepEqual(ctx.session.errors, [], 'Unexpected renderer/IPC errors');
  assert.deepEqual(ctx.session.blockedRequests, [], 'Attempted external network access');
}

async function compactTrim(ctx) {
  const page = ctx.session.page;
  const settle = () => page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
  const fields = await page.locator('#clipRangeFields').elementHandle();
  const marker = await page.locator('#clipMarkEnd button').elementHandle();
  const video = await page.locator('#clipPlayer video.active').elementHandle();
  const toggle = page.locator('#clipDetailsToggle');
  await page.evaluate(() => document.querySelector('#clipPlayer video.active').pause());
  await page.locator('#clipStartTime').fill('00:00:03');
  await page.locator('#clipEndTime').fill('00:00:13');
  for (const [width, height] of [[800, 700], [1000, 700], [1280, 800], [1400, 868]]) {
    await page.setViewportSize({ width, height }); await settle();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Trim must default to compact at every viewport');
    assert.equal(await page.locator('#clipFooterFields > #clipRangeFields').count(), 1);
    const geometry = await page.evaluate(() => {
      const bounds = selector => {
        const node = document.querySelector(selector), rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
          center: rect.y + rect.height / 2, overflow: node.scrollWidth - node.clientWidth };
      };
      return Object.fromEntries(Object.entries({ footer: '.vod-cut-footer', close: '#clipCancelBtn', add: '#clipDialogConfirmBtn',
        startHeading: '#clipDialogStartTimeLabel', startEntry: '#clipStartTime', startSet: '#clipMarkStart button',
        endHeading: '#clipDialogEndTimeLabel', endEntry: '#clipEndTime', endSet: '#clipMarkEnd button',
        duration: '#clipDurationTime', timeline: '.vod-selection-track' }).map(([key, selector]) => [key, bounds(selector)]));
    });
    const g = geometry;
    assert.ok(g.footer.bottom <= height + 1 && g.footer.y > 0, `Footer outside ${width}x${height}`);
    assert.ok(g.footer.overflow <= 1, `Footer overflow at ${width}`);
    assert.ok(g.close.right < g.add.x, 'Close must remain left of Add to queue');
    for (const control of await page.locator('#clipRangeFields input[type="text"], #clipRangeFields button, #clipDurationDisplay, #clipCancelBtn, #clipDialogConfirmBtn').all()) {
      assert.ok(await control.isVisible(), `Hidden compact control at ${width}`);
      const box = await control.boundingBox();
      assert.ok(box.x >= g.footer.x - 1 && box.x + box.width <= g.footer.right + 1
        && box.y >= g.footer.y - 1 && box.y + box.height <= g.footer.bottom + 1, `Compact control outside footer at ${width}`);
    }
    assert.ok(g.startEntry.right < g.startSet.x && g.endSet.right < g.endEntry.x, 'Set here controls must face inward');
    if (width > 800) assert.ok(g.timeline.bottom <= g.footer.y, `Trim timeline must remain above footer at ${width}: ${JSON.stringify(g)}`);
    if (width > 1200) {
      assert.ok(g.footer.height <= 50, 'Desktop compact footer must fit one row');
      assert.ok(g.startHeading.right < g.startEntry.x, 'Start heading must precede time entry');
      assert.ok(g.endEntry.right < g.endHeading.x, 'End heading must follow time entry');
      for (const key of ['startHeading', 'startSet', 'endHeading', 'endSet', 'endEntry', 'duration']) {
        assert.ok(Math.abs(g[key].center - g.startEntry.center) < 2, `${key} must align with the time entry row`);
      }
      assert.ok(g.startEntry.width < 110 && g.endEntry.width < 110, 'Time entries must retain compact width');
    }
    assert.ok(await page.locator('#clipDialogEndTimeLabel').evaluate(element => {
      const style = window.getComputedStyle(element);
      return style.flexDirection === 'row-reverse' && window.getComputedStyle(element, '::before').content.replace(/["']/g, '') === 'O';
    }), 'End keyboard cue O must sit outside the End heading');
  }
  assert.equal(await page.locator('#clipDurationTime').innerText(), '00:00:10');
  await toggle.click(); await settle();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(await fields.evaluate(element => element.parentElement.id === 'clipCutPanel' && element.nextElementSibling.id === 'clipOmissionPanel'));
  assert.equal(await page.locator('.vod-time-heading > #clipMarkStart, .vod-time-heading > #clipMarkEnd').count(), 2);
  await toggle.click(); await settle();
  assert.ok(await fields.evaluate(element => element === document.querySelector('#clipFooterFields > #clipRangeFields')));
  assert.ok(await marker.evaluate(element => element === document.querySelector('#clipMarkEnd button')));
  assert.ok(await video.evaluate(element => element === document.querySelector('#clipPlayer video.active')), 'Toggling details must not reload playback');
  assert.equal(await page.locator('#clipStartTime').inputValue(), '00:00:03');
  assert.equal(await page.locator('#clipEndTime').inputValue(), '00:00:13');
  for (const [id, input, expected] of [['clipStartLater', 'clipStartTime', '00:00:04'], ['clipStartEarlier', 'clipStartTime', '00:00:03'],
    ['clipEndEarlier', 'clipEndTime', '00:00:12'], ['clipEndLater', 'clipEndTime', '00:00:13']]) {
    await page.locator(`#${id}`).click(); assert.equal(await page.locator(`#${input}`).inputValue(), expected);
  }
  await page.getByRole('button', { name: 'Exclude ranges', exact: true }).click();
  await page.locator('#clipModal.is-omitting').waitFor();
  assert.ok(await fields.evaluate(element => element.parentElement.id === 'clipCutPanel'));
  assert.equal(await toggle.isVisible(), false, 'Omission mode must show its full controls');
  await page.locator('.vod-omission-new').click();
  await page.locator('.vod-omission-times input').nth(0).fill('00:00:05');
  await page.locator('.vod-omission-times input').nth(1).fill('00:00:07');
  await page.locator('.vod-omission-confirm').click();
  assert.equal(await page.locator('.vod-omission-row:not(.is-editing)').count(), 1);
  await page.locator('.vod-omission-modes button').first().click();
  await page.locator('#clipModal:not(.is-omitting)').waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(await fields.evaluate(element => element === document.querySelector('#clipFooterFields > #clipRangeFields')));
  assert.equal(await page.locator('#clipStartTime').inputValue(), '00:00:03');
  assert.equal(await page.locator('#clipEndTime').inputValue(), '00:00:13');
  assert.equal(await page.locator('#clipDurationTime').innerText(), '00:00:08');
  await page.locator('#clipEndTime').fill('invalid');
  assert.ok(await page.locator('#clipDialogConfirmBtn').isDisabled());
  assert.ok(await page.locator('#clipEndTime').evaluate(element => element === document.activeElement && !!element.closest('#clipFooterFields')));
  await page.locator('#clipEndTime').fill('00:00:13');
  assert.ok(await page.locator('#clipDialogConfirmBtn').isEnabled());
  assert.ok(await page.locator('#clipModal').evaluate(element => {
    const ids = [...element.querySelectorAll('[id]')].map(node => node.id);
    return ids.length === new Set(ids).size;
  }), 'Moving controls must not duplicate IDs');
}

async function fullVod(options) {
  const ctx = await context('full-vod', options);
  try {
    await openDialog(ctx); await ready(ctx);
    const page = ctx.session.page;
    assert.equal(await page.locator('#clipHistory .chapter-seek').count(), 2);
    assert.ok((await page.locator('#clipHistory').innerText()).includes('Fixture title history'));
    await page.locator('#clipHistory .chapter-seek').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#clipPlayer video.active').currentTime >= 7.8);
    await page.locator('#clipHistory .history-select-range').nth(1).click();
    assert.equal(await page.locator('#clipStartTime').inputValue(), '00:00:08');
    assert.equal(await page.locator('#clipEndTime').inputValue(), '00:00:16');
    await seek(ctx, 2);
    await page.evaluate(async () => { const video = document.querySelector('#clipPlayer video.active'); video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('#clipPlayer video.active').currentTime > 2.4);
    assert.ok(ctx.source.server.calls.some(call => call.path.endsWith('.ts')), 'Playback must consume actual HLS segments');
    await compactTrim(ctx);
    await page.locator('#clipCancelBtn').click();
    await page.waitForFunction(() => !document.querySelector('#clipPlayer video'));
    assert.ok(ctx.session.calls.some(call => call.method === 'closeVodPlayback'));
    await cleanBrowser(ctx);
  } finally { await ctx.close(); }
}

async function seekPreference(options) {
  const ctx = await context('seek-preference', options, { duration: 80 });
  try {
    const page = ctx.session.page;
    await page.locator('[data-tab="settings"]').click();
    await page.locator('[data-player-seek="30"]').click();
    await harness.waitForAsync(page, async () => (await window.api.getConfig()).player_seek_seconds === 30);
    assert.equal(ctx.session.state.config.player_seek_seconds, 30);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-player-seek="30"]')?.getAttribute('aria-pressed') === 'true');
    await openDialog(ctx); await ready(ctx); await seek(ctx, 2);
    const forward = page.getByRole('button', { name: /Forward 30 seconds/i });
    await forward.click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#clipPlayer video.active').currentTime - 32) < .5);
    await page.getByRole('button', { name: /Back 30 seconds/i }).click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#clipPlayer video.active').currentTime - 2) < .5);
    await cleanBrowser(ctx);
  } finally { await ctx.close(); }
}

async function liveCategories(options) {
  const ctx = await context('live-categories', options, { live: true });
  try {
    await openDialog(ctx); await ready(ctx);
    const page = ctx.session.page;
    assert.equal(await page.locator('#clipHistory .chapter-seek').count(), 1);
    const before = ctx.metadataServer.calls.filter(call => call.path === '/gql').length;
    ctx.revise();
    // Do not shorten the production refresh interval: the 30s timer and
    // refresh:true cache bypass are part of this check.
    await page.locator('#clipHistory .chapter-seek').nth(1).waitFor({ timeout: 40000 });
    assert.ok(ctx.metadataServer.calls.filter(call => call.path === '/gql').length > before);
    assert.ok(ctx.session.calls.some(call => call.method === 'getVodTimeline' && call.args[0].refresh === true));
    assert.ok((await page.locator('#clipHistory').innerText()).includes('Fixture Strategy'));
    await page.locator('#clipHistory .chapter-seek').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#clipPlayer video.active').currentTime >= 7.8);
    await cleanBrowser(ctx);
  } finally { await ctx.close(); }
}

async function loadingLifecycle(options) {
  const ctx = await context('loading-lifecycle', options, { delayOpen: true });
  try {
    await openDialog(ctx);
    const page = ctx.session.page;
    const first = await ctx.opening.promise;
    await page.locator('#clipPlayer .vod-player-loading').waitFor();
    await page.locator('#clipCancelBtn').click();
    await Promise.race([ctx.cancelled.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Production playback was not cancelled')), 5000); timer.unref(); })]);
    await openDialog(ctx); await ready(ctx);
    const requests = ctx.session.calls.filter(call => call.method === 'openVodPlayback');
    assert.equal(requests.length, 2); assert.notEqual(requests[1].args[0].id, first.id);
    const source = await page.locator('#clipPlayer video.active').getAttribute('src');
    ctx.released.resolve();
    // A stale completion must not close or replace the reopened session.
    await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#clipPlayer video.active').getAttribute('src'), source);
    await seek(ctx, 4);
    assert.equal(await page.locator('#clipPlayer .vod-player-error').count(), 0);
    await cleanBrowser(ctx);
  } finally { await ctx.close(); }
}

async function openingSource(options) {
  const ctx = await context('opening-source', options);
  try {
    await openDialog(ctx); await ready(ctx);
    assert.equal((await ctx.session.page.locator('.vod-player-source').innerText()).trim(), 'Source');
    const calls = ctx.session.calls.filter(call => call.method === 'openVodPlayback');
    assert.equal(calls.length, 1); assert.equal(calls[0].args[0].url, VOD);
    const { VodPlaybackService } = production('vod-playback-service');
    const service = new VodPlaybackService();
    try {
      let prepared = 0;
      const tools = { quality: 'source', sourceUrl: `${CDN}/index.m3u8`,
        prepare: async () => { prepared++; return false; }, streamlink: () => { throw new Error('Unexpected source fallback'); } };
      const opened = await service.open({ id: 'source-choice', url: VOD }, tools);
      assert.equal(prepared, 0);
      assert.equal(new URL(opened.sourceUrl).hostname, '127.0.0.1');
      assert.equal((await fetch(opened.sourceUrl, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
      assert.equal((await fetch(new URL('/not-authorized', opened.sourceUrl))).status, 403);
      await assert.rejects(service.open({ id: 'unsafe', url: VOD }, { ...tools, sourceUrl: 'http://127.0.0.1/private' }), /Invalid VOD media host/);
      assert.equal(prepared, 0, 'Invalid direct source must not silently fall back');
      await assert.rejects(service.open({ id: 'invalid-request', url: 'http://127.0.0.1/private' }, tools), /Invalid VOD playback request/);
    } finally { await service.close(); }
    await cleanBrowser(ctx);
  } finally { await ctx.close(); }
}

async function stalledServer() {
  const requested = deferred();
  const server = http.createServer((request, response) => {
    requested.resolve(request.url);
    // Keep the TCP socket open without headers/body: FFmpeg's production
    // rw_timeout must terminate the read, not a fixture timeout/HTTP error.
    request.on('error', () => {}); response.on('error', () => {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/chunked/index.m3u8`, requested,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

// These cases enter through the real renderer IPC, queue and downloader. Only
// Twitch's external access-token/master-playlist responses are replaced. The
// source resolver parses its normal unavailable-media metadata and FFmpeg reads
// the resulting loopback source without a process/downloader replacement.
function nativeTool(command) {
  const candidates = path.isAbsolute(command) || /[\\/]/.test(command) ? [path.resolve(command)]
    : (process.env.PATH || '').split(path.delimiter).flatMap(directory =>
      path.extname(command) ? [path.join(directory.replace(/^"|"$/g, ''), command)]
        : ['.exe', '.com', ''].map(extension => path.join(directory.replace(/^"|"$/g, ''), command + extension)));
  const found = candidates.find(filename => fs.existsSync(filename) && fs.statSync(filename).isFile());
  assert.ok(found, `Missing native media tool: ${command}`);
  return path.resolve(found);
}
async function nativeContext(options, name) {
  const env = harness.createEnvironment(name, { performance_mode: 'speed' });
  let session;
  try {
    const ffmpeg = nativeTool(options.ffmpeg);
    const ffprobe = nativeTool(options.ffprobe || (fs.existsSync(path.join(path.dirname(ffmpeg), 'ffprobe.exe')) ? path.join(path.dirname(ffmpeg), 'ffprobe.exe') : 'ffprobe'));
    for (const filename of [ffmpeg, ffprobe]) assert.ok(fs.statSync(filename).isFile(), `Missing native media tool: ${filename}`);
    const source = await media(env, { ffmpeg, ffprobe }, 16, true);
    const priorPath = process.env.PATH;
    try {
      process.env.PATH = [path.dirname(ffmpeg), path.dirname(ffprobe), priorPath].filter(Boolean).join(path.delimiter);
      session = await harness.launchElectron(env);
    } finally { process.env.PATH = priorPath; }
    await session.app.evaluate(async ({ app }, expected) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const tools = require('./dist/tools.js');
      const path = process.getBuiltinModule('path');
      if (path.resolve(await tools.getFFmpegPath()).toLowerCase() !== expected.ffmpeg.toLowerCase()
        || path.resolve(await tools.getFFprobePath()).toLowerCase() !== expected.ffprobe.toLowerCase()) throw new Error('Production selected different media tools than positional arguments');
      const streamlink = await tools.getStreamlinkCommand();
      if (!await tools.canExecuteCommand(streamlink.command, [...streamlink.prefixArgs, '--version'])) throw new Error('Native VOD queue requires a real installed Streamlink');
      const originalFetch = globalThis.fetch;
      globalThis.__vodFixtureSource = '';
      globalThis.__vodNetworkCalls = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url || input.href);
        if (url.origin === 'https://gql.twitch.tv') {
          globalThis.__vodNetworkCalls.push(url.href);
          return new Response(JSON.stringify({ data: { videoPlaybackAccessToken: { value: 'fixture-token', signature: 'fixture-signature' } } }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.origin === 'https://usher.ttvnw.net') {
          globalThis.__vodNetworkCalls.push(url.href);
          const unavailable = Buffer.from(JSON.stringify([{ 'STABLE-VARIANT-ID': '1080p', RESOLUTION: '1920x1080', 'FRAME-RATE': '30', 'IVS-VARIANT-SOURCE': 'source', CODECS: 'avc1.640028' }])).toString('base64');
          // The first reference supplies the unavailable source's base URL;
          // the ordinary HTTPS variant also exercises normal master parsing.
          const body = ['#EXTM3U', globalThis.__vodFixtureSource,
            `#EXT-X-SESSION-DATA:DATA-ID="com.amazon.ivs.unavailable-media",VALUE="${unavailable}"`,
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,FRAME-RATE=30,IVS-NAME="1080p"',
            'https://fixture.cloudfront.net/chunked/index.m3u8', ''].join('\n');
          return new Response(body);
        }
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return originalFetch(input, init);
        throw new Error(`Unexpected external fetch: ${url.origin}`);
      };
      const childProcess = process.getBuiltinModule('child_process');
      const originalSpawn = childProcess.spawn;
      globalThis.__vodProcesses = [];
      childProcess.spawn = function (command, args, ...rest) {
        const child = originalSpawn.call(this, command, args, ...rest);
        const record = { command, args, pid: child.pid, start: Date.now(), closed: false, stderr: '' };
        globalThis.__vodProcesses.push(record);
        child.stderr?.on('data', data => { record.stderr = (record.stderr + data.toString()).slice(-8192); });
        child.once('close', code => { record.closed = true; record.code = code; record.elapsed = Date.now() - record.start; });
        return child;
      };
    }, { ffmpeg, ffprobe });
    return { env, session, source, ffprobe, async close() { await harness.closeSession(session); } };
  } catch (error) { await harness.closeSession(session || env); throw error; }
}

let nativeVodId = 999999999999900;
async function queueNative(ctx, source, name, start, length, expectedStatus) {
  await ctx.session.app.evaluate((_electron, source) => { globalThis.__vodFixtureSource = source; }, source);
  const id = String(++nativeVodId);
  const result = await ctx.session.page.evaluate(async ({ id, name, start, length, date }) => {
    const added = await window.api.addToQueueWithResult({ url: `https://www.twitch.tv/videos/${id}`, title: name,
      date, streamer: 'fixture_streamer', duration_str: '16s', quality: 'source',
      ...(length ? { customClip: { startSec: start, durationSec: length, startPart: 1, filenameFormat: 'template', filenameTemplate: `${name}.mp4` } } : {}) });
    if (!added.accepted) throw new Error(`Fixture queue addition rejected: ${added.reason}`);
    const item = added.queue.find(item => item.url.endsWith(id));
    if (!item || !await window.api.startDownload()) throw new Error('Production queue did not start');
    return item.id;
  }, { id, name, start, length, date: STARTED });
  await harness.waitForAsync(ctx.session.page, async ({ id, expectedStatus }) => {
    const item = (await window.api.getQueue()).find(item => item.id === id);
    if (item?.status === 'error' && expectedStatus !== 'error') throw new Error(item.last_error || 'Production download failed');
    return item?.status === expectedStatus;
  }, { id: result, expectedStatus }, { timeout: 115000 });
  return (await ctx.session.page.evaluate(() => window.api.getQueue())).find(item => item.id === result);
}

function ownedFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? ownedFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
async function assertNativeClean(ctx) {
  const processes = await ctx.session.app.evaluate(() => globalThis.__vodProcesses);
  assert.ok(processes.length > 0, 'No production media processes observed');
  assert.ok(processes.every(child => child.closed), 'Production media child remains active');
  assert.deepEqual(ownedFiles(ctx.env.downloadsDir).filter(file => /tvm-part|partial/i.test(path.basename(file))), []);
  await harness.assertIsolation(ctx.session);
  assert.deepEqual(ctx.session.errors, []);
}
async function nativeStall(options, recover) {
  const ctx = await nativeContext(options, recover ? 'stall-recovery' : 'stall-timeout');
  let server;
  try {
    server = await stalledServer();
    const item = await queueNative(ctx, server.url, 'Stalled fixture', 0, 4, 'error');
    assert.match(item.last_error, /timeout|timed out|connection|Zeitüberschreitung/i);
    assert.notEqual(item.completionRecorded, true);
    assert.deepEqual(item.outputFiles || [], []);
    const processes = (await ctx.session.app.evaluate(() => globalThis.__vodProcesses)).filter(child => child.args.includes('-rw_timeout'));
    assert.equal(processes.length, 2, 'Speed mode must exhaust its two real attempts');
    for (const child of processes) {
      assert.equal(child.args[child.args.indexOf('-rw_timeout') + 1], '30000000');
      assert.equal(child.closed, true); assert.notEqual(child.code, 0);
      assert.ok(production('vod-source-download').isVodSourceReadTimeout(child.stderr), child.stderr);
      assert.ok(child.elapsed >= 27000 && child.elapsed < 50000, `Production read timeout took ${child.elapsed}ms`);
    }
    assert.equal(ownedFiles(ctx.env.downloadsDir).filter(file => /\.(mp4|ts)$/.test(file)).length, 0, 'Failed download published output');
    await assertNativeClean(ctx);
    if (recover) {
      await queueNative(ctx, `${ctx.source.server.url}/chunked/index.m3u8`, 'Recovered fixture', 4, 4, 'completed');
      const outputs = ownedFiles(ctx.env.downloadsDir).filter(file => file.endsWith('.mp4'));
      assert.equal(outputs.length, 1);
      await assertDuration(ctx.ffprobe, outputs[0], 4);
      await assertNativeClean(ctx);
    }
  } finally { await server?.close(); await ctx.close(); }
}

async function assertDuration(ffprobe, filename, expected) {
  const raw = await production('media-process').runMediaProcess(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filename]);
  const probe = JSON.parse(raw);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Math.abs(Number(probe.format.duration) - expected) < .6, `Selected ${expected}s range produced ${probe.format.duration}s`);
}

async function healthy(options) {
  const ctx = await nativeContext(options, 'healthy-vod-ranges');
  try {
    for (const [name, start, length] of [['middle', 4, 4], ['tail', 12, 4], ['full', 0, null]]) {
      const before = new Set(ownedFiles(ctx.env.downloadsDir));
      const item = await queueNative(ctx, `${ctx.source.server.url}/chunked/index.m3u8`, name, start, length, 'completed');
      assert.equal(item.completionRecorded, true);
      assert.ok(item.outputBytes > 0);
      const outputs = ownedFiles(ctx.env.downloadsDir).filter(file => file.endsWith('.mp4') && !before.has(file));
      assert.equal(outputs.length, 1, `Expected one real finalized ${name} export`);
      await assertDuration(ctx.ffprobe, outputs[0], length || 16);
    }
    assert.ok(ctx.source.server.calls.some(call => call.path.endsWith('.ts')));
    await assertNativeClean(ctx);
  } finally { await ctx.close(); }
}

const scenarios = {
  'update-version': updateVersion,
  'full-vod': fullVod,
  'seek-preference': seekPreference,
  'live-categories': liveCategories,
  'loading-lifecycle': loadingLifecycle,
  'opening-source': openingSource,
  'stall-production-timeout': options => nativeStall(options, false),
  'stall-native': options => nativeStall(options, true),
  'stall-healthy': healthy,
};
async function run(name, argv = process.argv.slice(2)) {
  assert.ok(Object.hasOwn(scenarios, name), `Unknown VOD release scenario: ${name}`);
  await scenarios[name](optionsFor(name, argv));
  console.log(`PASS ${name} (reconstructed public release check)`);
}
function main(name) { run(name).catch(error => { console.error(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1; }); }
module.exports = { run, main };
