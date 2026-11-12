'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { parseOptions, createEnvironment, createHttpFixture, createMediaFixture, assertIsolation, closeSession, launchElectron, waitForAsync } = require('./release-test-harness.cjs');
const { readContract, createFixtureState, createDispatcher } = require('./release-browser-fixtures.cjs');
const root = path.resolve(__dirname, '..');
const contract = readContract(root);
const get = (url, options = {}) => new Promise((resolve, reject) => http.get(url, options, response => {
  let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
}).on('error', reject));

test('all supported command flags and two tool paths parse without consuming positional values', () => {
  assert.deepEqual(parseOptions(['--webkit', '--expect-refined', '--packaged', '--two-omissions', '--de', '--light', '--parts', '--cancel', '/tools/ffmpeg', '/tools/ffprobe']), {
    webkit: true, expectRefined: true, packaged: true, twoOmissions: true, de: true, light: true, parts: true, cancel: true,
    ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe',
  });
  assert.equal(parseOptions([]).webkit, false);
  assert.throws(() => parseOptions(['--wekbit']), /Unknown/);
  assert.throws(() => parseOptions(['ffmpeg', 'ffprobe', 'extra']), /at most two/);
});

test('environment uses Windows production data directory and disables unattended activity', async () => {
  const env = createEnvironment('../../unsafe name', { language: 'de', auto_cleanup_enabled: true, auto_resume_queue_on_startup: true });
  try {
    assert.equal(env.appDataDir, path.join(env.programDataDir, 'Twitch_Downloader'));
    for (const key of ['programDataDir', 'appDataDir', 'userDataDir', 'downloadsDir', 'mediaDir']) assert.ok(fs.statSync(env[key]).isDirectory());
    const config = JSON.parse(fs.readFileSync(env.configFile));
    assert.equal(config.language, 'de'); assert.equal(config.download_path, env.downloadsDir);
    assert.equal(config.auto_cleanup_enabled, false); assert.equal(config.auto_resume_queue_on_startup, false);
    assert.equal(config.client_id, ''); assert.deepEqual(config.auto_record_streamers, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.queueFile)), []);
  } finally { await closeSession(env); }
  assert.equal(fs.existsSync(env.rootDir), false);
  await closeSession(env);
});

test('credentials cannot enter config even through arbitrary override keys', () => {
  assert.throws(() => createEnvironment('credential-rejection', { twitch_client_secret: 'test-value' }), /Credentials forbidden/);
});

test('cleanup rejects forged ownership and does not delete an unrelated directory', async () => {
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'release-unrelated-'));
  fs.writeFileSync(path.join(unrelated, 'sentinel'), 'retained');
  try {
    await assert.rejects(closeSession({ rootDir: unrelated }), /unowned/);
    assert.equal(fs.readFileSync(path.join(unrelated, 'sentinel'), 'utf8'), 'retained');
    const env = createEnvironment('ownership');
    const originalRoot = env.rootDir;
    env.rootDir = unrelated;
    await assert.rejects(closeSession(env), /unowned/);
    env.rootDir = originalRoot;
    await closeSession(env);
  } finally { fs.rmSync(unrelated, { recursive: true, force: true }); }
});

test('altered ownership marker prevents deletion', async () => {
  const env = createEnvironment('marker');
  const marker = path.join(env.rootDir, '.release-test-owner');
  const value = fs.readFileSync(marker);
  try {
    fs.writeFileSync(marker, 'altered');
    await assert.rejects(closeSession(env), /unowned/);
    assert.ok(fs.existsSync(env.downloadsDir));
  } finally { fs.writeFileSync(marker, value); await closeSession(env); }
});

test('isolation checks actual renderer download path and rejects traversal and symlinks', async () => {
  const env = createEnvironment('paths');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'release-outside-'));
  let config = { ...env.config };
  const session = { env, page: { evaluate: async () => config, url: () => 'http://127.0.0.1:1234/dist/renderer/index.html' } };
  try {
    assert.equal((await assertIsolation(session)).browser, true);
    config = { ...env.config, download_path: outside };
    await assert.rejects(assertIsolation(session), /Unsafe fixture/);
    const link = path.join(env.rootDir, 'escape');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    config = { ...env.config, download_path: path.join(link, 'not-created') };
    await assert.rejects(assertIsolation(session), /Symlink escapes/);
    config = { ...env.config, clip_download_path: outside };
    await assert.rejects(assertIsolation(session), /Unsafe fixture/);
  } finally { await closeSession(env); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('native isolation checks writable profile and cache, while reporting OS appData as metadata', async () => {
  const env = createEnvironment('native-path-contract');
  const paths = { userData: env.userDataDir, sessionData: env.userDataDir, appData: os.tmpdir(), temp: env.tempDir };
  let userDataSwitch = env.userDataDir;
  const session = { env,
    page: { evaluate: callback => vm.runInNewContext(`(${callback})()`, { api: {
      getConfig: () => env.config,
      getSecretStatus: () => ({ clientSecretConfigured: false, discordWebhookConfigured: false }),
    } }) },
    app: { evaluate: callback => vm.runInNewContext(`(${callback})(electron)`, {
      electron: { app: { getPath: name => paths[name], commandLine: { getSwitchValue: () => userDataSwitch } } },
      process: { env: { PROGRAMDATA: env.programDataDir, LOCALAPPDATA: env.localAppDataDir } },
    }) },
  };
  try {
    assert.equal((await assertIsolation(session)).appData, os.tmpdir());
    paths.sessionData = os.tmpdir();
    await assert.rejects(assertIsolation(session), /Native sessionData escaped isolation/);
    paths.sessionData = env.userDataDir;
    userDataSwitch = os.tmpdir();
    await assert.rejects(assertIsolation(session), /Native userDataSwitch escaped isolation/);
  } finally { await closeSession(env); }
});

test('production OS appData access remains confined to disabled legacy migration', () => {
  const ts = require('typescript');
  const source = ts.createSourceFile('main.ts', fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const references = [];
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'app.getPath'
      && node.arguments[0]?.text === 'appData') references.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(references.length, 1, 'Review isolation before adding or changing OS appData access');
  let guard = references[0].parent;
  while (guard && !ts.isIfStatement(guard)) guard = guard.parent;
  assert.ok(guard, 'OS appData must have an explicit migration guard');
  assert.equal(guard.expression.getText(source), "!app.commandLine.hasSwitch('user-data-dir')");
  const touched = [];
  const app = { commandLine: { hasSwitch: name => name === 'user-data-dir' },
    getPath: name => { touched.push(name); return name; } };
  vm.runInNewContext(guard.getText(source), { app, path, migrateLegacyDirectory: () => assert.fail('Migration ran in isolated mode') });
  assert.deepEqual(touched, []);
});

test('HTTP fixtures serve explicit routes, track calls, and close active sockets on cleanup', async () => {
  const env = createEnvironment('http');
  const file = path.join(env.mediaDir, 'bytes.bin'); fs.writeFileSync(file, 'fixture bytes');
  const fixture = await createHttpFixture(env, { '/json': { body: { ok: true } }, '/file': { file }, '/outside': { file: __filename } });
  try {
    assert.deepEqual(await get(`${fixture.url}/json?query=1`), { status: 200, body: '{"ok":true}' });
    assert.equal((await get(`${fixture.url}/file`)).body, 'fixture bytes');
    assert.equal((await get(`${fixture.url}/missing`)).status, 404);
    assert.equal((await get(`${fixture.url}/outside`)).status, 500);
    assert.deepEqual(fixture.calls.map(call => call.path), ['/json', '/file', '/missing', '/outside']);
  } finally { await closeSession(env); }
  assert.equal(fixture.server.listening, false);
  assert.equal(fixture.server.address(), null);
  const connections = await new Promise((resolve, reject) => fixture.server.getConnections((error, count) => error ? reject(error) : resolve(count)));
  assert.equal(connections, 0);
  // A pooled keep-alive socket may report ECONNRESET after closeAllConnections on
  // Windows. Probe a fresh connection to verify the listener actually closed.
  await assert.rejects(get(fixture.url, { agent: false }), { code: 'ECONNREFUSED', syscall: 'connect' });
});

test('media generation rejects escaping output names before launching a process', async () => {
  const env = createEnvironment('media-guards');
  try {
    await assert.rejects(createMediaFixture(env, { name: '../outside.mp4' }), /local video filename/);
    await assert.rejects(createMediaFixture(env, { duration: Infinity }), /dimensions or duration/);
    fs.writeFileSync(path.join(env.mediaDir, 'fixture.mp4'), 'retain');
    await assert.rejects(createMediaFixture(env), /overwrite/);
    assert.equal(fs.readFileSync(path.join(env.mediaDir, 'fixture.mp4'), 'utf8'), 'retain');
  } finally { await closeSession(env); }
});

test('preload contract captures real channel aliases and unsubscribe event registrations', () => {
  assert.deepEqual(contract.constants, { platform: 'win32' });
  assert.equal(Object.hasOwn(contract.methods, 'platform'), false);
  assert.deepEqual(contract.methods.getConfig, ['get-config']);
  assert.deepEqual(contract.methods.openFile, ['authorize-managed-path', 'open-file']);
  assert.deepEqual(contract.methods.notifyRendererReady, ['renderer-ready']);
  assert.deepEqual(contract.methods.rendererReady, ['renderer-ready']);
  assert.equal(contract.events.onExportJobsChanged, 'editing-jobs-changed');
  assert.equal(contract.events.onVodTimelineProgress, 'vod-timeline-progress');
  assert.ok(Object.keys(contract.methods).length > 90);
});

test('preload constants require the exact reviewed platform expression', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'release-preload-contract-'));
  const source = path.join(folder, 'src');
  fs.mkdirSync(source);
  const fixture = entry => fs.writeFileSync(path.join(source, 'preload.ts'),
    `contextBridge.exposeInMainWorld('api', {\n    ${entry}\n});`);
  try {
    fixture('platform: process.platform,');
    assert.deepEqual(readContract(folder).constants, { platform: 'win32' });
    for (const entry of ["platform: 'darwin',", 'platform: process.env.TEST_PLATFORM,', 'unreviewed: 42,']) {
      fixture(entry);
      assert.throws(() => readContract(folder), /Unrecognized preload method/);
    }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('fixture dispatcher mutates queue, emits production events, and rejects unconfigured operations', async () => {
  const state = createFixtureState({ prevent_duplicate_downloads: true });
  const calls = []; const events = []; const overrides = {};
  const dispatch = createDispatcher({ state, contract, calls, overrides, emit: async (...args) => events.push(structuredClone(args)), validateConfig: () => {}, version: '1.1.21' });
  assert.equal(await dispatch('renderer-ready'), undefined);
  const item = { url: 'https://www.twitch.tv/videos/123', title: 'Fixture', streamer: 'fixture' };
  const first = await dispatch('add-to-queue-with-result', [item]);
  assert.equal(first.accepted, true); assert.equal(first.queue[0].status, 'pending');
  assert.equal((await dispatch('add-to-queue-with-result', [item])).reason, 'duplicate');
  assert.equal(events[0][0], 'queue-updated'); assert.equal(events.length, 1);
  await dispatch('add-to-queue', [item]);
  assert.equal(events[1][0], 'queue-duplicate-skipped');
  first.queue[0].title = 'external mutation';
  assert.equal(state.queue[0].title, 'Fixture');
  await dispatch('remove-from-queue', [first.addedId]); assert.equal(state.queue.length, 0);
  await assert.rejects(dispatch('invented-channel'), /Unexpected/);
  await assert.rejects(dispatch('export-video-edit', [{}]), /Unconfigured/);
  overrides.exportVideoEdit = { success: false, outputName: null, cancelled: true };
  assert.equal((await dispatch('export-video-edit', [{}])).cancelled, true);
  assert.equal(calls.at(-1).method, 'exportVideoEdit');
});

test('library fixtures persist changes and config defaults report unavailable native tools honestly', async () => {
  const state = createFixtureState({ download_path: '/fixture', performance_mode: 'balanced' });
  const dispatch = createDispatcher({ state, contract, calls: [], overrides: {}, emit: async () => {}, validateConfig: () => {}, version: '1' });
  const library = await dispatch('change-vod-library', [{ collection: 'groups', item: { name: 'Fixtures', channels: ['fixture'] } }]);
  assert.equal(library.groups.length, 1);
  await dispatch('change-vod-library', [{ collection: 'groups', remove: library.groups[0].id }]);
  assert.deepEqual((await dispatch('get-vod-library')).groups, []);
  assert.equal((await dispatch('run-preflight', [false])).checks.ffmpeg, false);
  assert.equal((await dispatch('get-managed-tool-status')).ffmpeg.verified, false);
  await assert.rejects(dispatch('run-preflight', [true]), /explicit fixture/);
});

test('queue ordering preserves omitted rows and retries preserve blocked recovery', async () => {
  const state = createFixtureState({}, { state: { queue: [
    { id: 'a', status: 'error', progress: 30, last_error: 'network' },
    { id: 'b', status: 'error', mergeRecoveryBlocked: true },
    { id: 'c', status: 'completed' },
  ] } });
  const dispatch = createDispatcher({ state, contract, calls: [], overrides: {}, emit: async () => {}, validateConfig: () => {}, version: '1' });
  assert.deepEqual((await dispatch('reorder-queue', [['c', 'c']])).map(item => item.id), ['c', 'a', 'b']);
  await dispatch('retry-failed-downloads');
  assert.equal(state.queue.find(item => item.id === 'a').status, 'pending');
  assert.equal(state.queue.find(item => item.id === 'a').progress, 0);
  assert.equal(state.queue.find(item => item.id === 'b').status, 'error');
  assert.equal(state.queue.find(item => item.id === 'c').status, 'completed');
});

test('fixture config merges safe defaults and downloaded VOD state is mutable', async () => {
  const state = createFixtureState({ download_path: '/fixture', language: 'en' }, { state: { config: { language: 'de' } } });
  assert.equal(state.config.download_path, '/fixture');
  assert.equal(state.config.language, 'de');
  const dispatch = createDispatcher({ state, contract, calls: [], overrides: {}, emit: async () => {}, validateConfig: () => {}, version: '1' });
  assert.equal((await dispatch('mark-vod-downloaded', ['123', true])).success, true);
  await dispatch('mark-vod-downloaded', ['123', true]);
  assert.deepEqual(state.config.downloaded_vod_ids, ['123']);
  assert.equal((await dispatch('mark-vod-downloaded', ['invalid', true])).success, false);
  assert.equal((await dispatch('reset-downloaded-vod-ids')).removedCount, 1);
  assert.deepEqual(state.config.downloaded_vod_ids, []);
  assert.deepEqual(await dispatch('search-download-history', [{ offset: 5, limit: 10 }]), { entries: [], total: 0, offset: 5, limit: 10 });
});

if (process.platform !== 'win32') test('native launching is explicitly unsupported off Windows', async () => {
  const env = createEnvironment('platform');
  try {
    await assert.rejects(launchElectron(env), /require win32/);
  } finally { await closeSession(env); }
});

test('asynchronous IPC polling awaits false results and retries until complete', async () => {
  let calls = 0;
  const page = { evaluate: async (_predicate, arg) => { assert.equal(arg, 42); return ++calls === 3 ? 'completed' : false; } };
  assert.equal(await waitForAsync(page, () => {}, 42, { polling: 1, timeout: 1000 }), 'completed');
  assert.equal(calls, 3);
});
test('asynchronous IPC polling rejects failures and bounds hung or false requests', async () => {
  await assert.rejects(waitForAsync({ evaluate: async () => { throw new Error('IPC failure'); } }, () => {}), /IPC failure/);
  await assert.rejects(waitForAsync({ evaluate: () => new Promise(() => {}) }, () => {}, null, { timeout: 15, polling: 1 }), /timed out/);
  await assert.rejects(waitForAsync({ evaluate: async () => false }, () => {}, null, { timeout: 15, polling: 1 }), /timed out/);
});
