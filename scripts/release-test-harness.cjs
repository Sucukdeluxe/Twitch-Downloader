'use strict';

// Reconstructed from the public Windows application contract. No private tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const nodeCrypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { readContract, createFixtureState, createDispatcher } = require('./release-browser-fixtures.cjs');
const projectRoot = path.resolve(__dirname, '..');
const owned = new WeakMap();
const OFFLINE_PROXY = 'http://127.0.0.1:1';
const externalMethods = new Set(['getUserId', 'getVODs', 'getVodQualities', 'cancelVodQualities',
  'getStreamerProfile', 'getStreamerDisplayNames', 'searchTwitchChannels', 'getVodStoryboard', 'getClipInfo',
  'openClipPlayback', 'closeClipPlayback', 'openVodPlayback', 'closeVodPlayback', 'getVodTimeline',
  'discoverClips', 'checkUpdate', 'downloadUpdate']);

function parseOptions(argv = process.argv.slice(2)) {
  const flags = { '--webkit': 'webkit', '--expect-refined': 'expectRefined', '--packaged': 'packaged',
    '--two-omissions': 'twoOmissions', '--de': 'de', '--light': 'light', '--parts': 'parts', '--cancel': 'cancel' };
  const result = Object.fromEntries(Object.values(flags).map(name => [name, false]));
  const positional = [];
  for (const arg of argv) {
    if (Object.hasOwn(flags, arg)) result[flags[arg]] = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown release test option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2) throw new Error('Expected at most two positional tool paths: ffmpeg ffprobe');
  result.ffmpeg = positional[0]; result.ffprobe = positional[1];
  return result;
}

function inside(root, filename) {
  const relative = path.relative(root, path.resolve(filename));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function canonical(filename) { const value = fs.realpathSync(filename); return process.platform === 'win32' ? value.toLowerCase() : value; }
function ownedRecord(env) {
  const record = owned.get(env);
  if (!record || env.rootDir !== record.root || !fs.existsSync(record.root) || fs.lstatSync(record.root).isSymbolicLink()
    || canonical(record.root) !== record.canonical || fs.readFileSync(path.join(record.root, '.release-test-owner'), 'utf8') !== record.id) {
    throw new Error('Refusing unowned or altered release test environment');
  }
  return record;
}
function validateConfig(env, config) {
  ownedRecord(env);
  for (const key of ['download_path', 'clip_download_path']) {
    const filename = config[key];
    if (key === 'clip_download_path' && !filename) continue;
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || !inside(env.rootDir, filename)) throw new Error(`Unsafe fixture ${key}`);
    let existing = filename;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (!inside(canonical(env.rootDir), canonical(existing))) throw new Error(`Symlink escapes fixture ${key}`);
  }
  for (const [key, value] of Object.entries(config)) {
    if (/(secret|token|password|webhook)/i.test(key) && value) throw new Error(`Credentials forbidden in fixture config: ${key}`);
  }
  if (config.client_id) throw new Error('Fixture client_id must be empty');
}
function createEnvironment(name, config = {}) {
  const safeName = String(name || 'release').replace(/[^a-z0-9_-]/gi, '-').slice(0, 70);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `twitch-release-${safeName}-`));
  const env = { rootDir, programDataDir: path.join(rootDir, 'programdata'), userDataDir: path.join(rootDir, 'userdata'),
    downloadsDir: path.join(rootDir, 'downloads'), mediaDir: path.join(rootDir, 'media'),
    roamingDir: path.join(rootDir, 'home', 'AppData', 'Roaming'), localAppDataDir: path.join(rootDir, 'home', 'AppData', 'Local'),
    tempDir: path.join(rootDir, 'temp'), homeDir: path.join(rootDir, 'home') };
  env.appDataDir = path.join(env.programDataDir, 'Twitch_Downloader');
  for (const directory of Object.values(env)) fs.mkdirSync(directory, { recursive: true });
  // Windows expands shell folders from USERPROFILE and requires them to exist.
  for (const directory of ['Desktop', 'Documents', 'Downloads']) fs.mkdirSync(path.join(env.homeDir, directory));
  env.configFile = path.join(env.appDataDir, 'config.json');
  env.queueFile = path.join(env.appDataDir, 'download_queue.json');
  const id = nodeCrypto.randomUUID();
  fs.writeFileSync(path.join(rootDir, '.release-test-owner'), id, { mode: 0o600 });
  owned.set(env, { root: rootDir, canonical: canonical(rootDir), id, resources: [], closed: false });
  try {
    env.config = {
      theme: 'twitch', language: 'en', download_mode: 'full', part_minutes: 120, sidebar_split_view: true, player_seek_seconds: 10,
      filename_template_vod: '{title}.mp4', filename_template_parts: '{date}_Part{part_padded}.mp4', filename_template_clip: '{date}_{part}.mp4',
      smart_queue_scheduler: false, performance_mode: 'balanced', prevent_duplicate_downloads: true,
      persist_queue_on_restart: false, metadata_cache_minutes: 10, parallel_downloads: 1, downloaded_vod_ids: [],
      streamer_display_names: {}, streamlink_quality: 'source', streamlink_disable_ads: true,
      download_policy: { throttle: null, windows: [] }, auto_record_poll_seconds: 90,
      auto_cleanup_days: 30, auto_cleanup_target: 'live_only', auto_cleanup_action: 'archive',
      auto_vod_download_poll_minutes: 15, auto_vod_max_age_hours: 24, ...config,
      client_id: '', download_path: env.downloadsDir, clip_download_path: '', streamers: [],
      auto_resume_queue_on_startup: false, auto_record_streamers: [], auto_vod_download_streamers: [], auto_vod_rules: {},
      download_chat_replay: false, capture_live_chat: false, notify_on_each_completion: false,
      discord_notify_live_start: false, discord_notify_live_end: false, discord_notify_vod_complete: false,
      discord_notify_vod_auto_queued: false, auto_cleanup_enabled: false, log_stream_events: false,
      auto_resume_live_recording: false, auto_merge_resumed_parts: false, delete_parts_after_merge: false,
    };
    validateConfig(env, env.config);
    fs.writeFileSync(env.configFile, JSON.stringify(env.config, null, 2));
    fs.writeFileSync(env.queueFile, '[]');
    return env;
  } catch (error) { fs.rmSync(rootDir, { recursive: true, force: true }); throw error; }
}

async function createHttpFixture(env, routes) {
  const record = ownedRecord(env);
  if (!routes || typeof routes !== 'object') throw new Error('HTTP fixture requires a route dictionary');
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    calls.push({ method: request.method, path: url.pathname, url: request.url, headers: { ...request.headers } });
    const route = Object.hasOwn(routes, `${request.method} ${url.pathname}`) ? routes[`${request.method} ${url.pathname}`] : routes[url.pathname];
    try {
      if (route === undefined) { response.writeHead(404); response.end('Unconfigured fixture route'); return; }
      const value = typeof route === 'function' ? await route(request, calls) : route;
      if (value?.file) {
        if (!inside(env.rootDir, value.file) || !inside(canonical(env.rootDir), canonical(value.file))) throw new Error('HTTP fixture file escapes environment');
        response.writeHead(value.status || 200, value.headers || {}); response.end(fs.readFileSync(value.file));
      } else {
        const payload = value?.body ?? value;
        const json = typeof payload === 'object' && !Buffer.isBuffer(payload);
        response.writeHead(value?.status || 200, { 'Content-Type': json ? 'application/json' : 'text/plain', ...value?.headers });
        response.end(json ? JSON.stringify(payload) : payload === undefined ? '' : payload);
      }
    } catch { response.writeHead(500); response.end('Fixture route failed'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let closed = false;
  const fixture = { server, calls, url: `http://127.0.0.1:${server.address().port}`,
    async close() { if (closed) return; closed = true; server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
  record.resources.push(fixture.close);
  return fixture;
}

function sessionFor(env) {
  ownedRecord(env);
  const session = { env, calls: [], errors: [], blockedRequests: [], cleanup: () => closeSession(session) };
  return session;
}
function checkOverrides(contract, overrides, native = false) {
  for (const method of Object.keys(overrides)) {
    if (['setClientSecret', 'setDiscordWebhook', 'login'].includes(method)) throw new Error(`Credential fixture forbidden: ${method}`);
    if (!Object.hasOwn(contract.methods, method)) throw new Error(`Unknown fixture API override: ${method}`);
    if (native && !externalMethods.has(method)) throw new Error(`Native fixture cannot replace real backend API: ${method}`);
  }
}

async function launchBrowser(env, { engine = 'chromium', fixture = {} } = {}) {
  const session = sessionFor(env);
  try {
    if (!['chromium', 'webkit'].includes(engine)) throw new Error(`Unsupported release browser: ${engine}`);
    const contract = readContract(projectRoot);
    const overrides = { ...(fixture.overrides || {}) }; checkOverrides(contract, overrides);
    const state = createFixtureState(env.config, fixture); validateConfig(env, state.config);
    session.state = state;
    // Serve only the built renderer and explicit visual resources, never project sources or secrets.
    const assetRoot = path.join(projectRoot, 'dist', 'renderer');
    if (!fs.existsSync(path.join(assetRoot, 'index.html'))) throw new Error('Missing dist/renderer/index.html; run the production build first');
    const routes = {};
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
    const addAssets = (directory, prefix) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) addAssets(file, `${prefix}${entry.name}/`);
        else if (entry.isFile() && mime[path.extname(file)]) routes[`${prefix}${entry.name}`] = { body: fs.readFileSync(file), headers: { 'Content-Type': mime[path.extname(file)] } };
      }
    };
    addAssets(assetRoot, '/dist/renderer/');
    for (const file of ['icon.png', 'icon.ico']) {
      const filename = path.join(projectRoot, 'build', file);
      if (fs.existsSync(filename)) routes[`/build/${file}`] = { body: fs.readFileSync(filename), headers: { 'Content-Type': mime[path.extname(filename)] } };
    }
    const server = await createHttpFixture(env, routes);
    const playwright = require('playwright');
    session.browser = await playwright[engine].launch({ headless: true });
    ownedRecord(env).resources.push(() => session.browser.close());
    session.context = await session.browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await session.context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' && url.protocol === 'http:') return route.continue();
      session.blockedRequests.push(url.href); return route.abort('blockedbyclient');
    });
    session.page = await session.context.newPage();
    session.page.on('pageerror', error => session.errors.push(error.message));
    session.emit = async (event, payload) => {
      const channel = contract.events[event] || event;
      if (!Object.values(contract.events).includes(channel)) throw new Error(`Unknown fixture event: ${event}`);
      if (channel === 'queue-updated') state.queue = structuredClone(payload);
      await session.page.evaluate(({ channel, payload }) => globalThis.__releaseEmit(channel, payload), { channel, payload });
    };
    session.replaceIpc = async (method, response) => {
      checkOverrides(contract, { [method]: response }); overrides[method] = response;
      await session.page.evaluate(method => globalThis.__releaseOverridden.add(method), method);
    };
    const dispatch = createDispatcher({ state, overrides, contract, calls: session.calls, emit: session.emit,
      validateConfig: value => validateConfig(env, value), version: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'))).version });
    await session.page.exposeBinding('__releaseOverride', async (_source, method, args) => {
      checkOverrides(contract, { [method]: overrides[method] });
      const channel = contract.methods[method].at(-1);
      session.calls.push({ method, channel, args: structuredClone(args), override: true });
      const handler = overrides[method];
      try { return typeof handler === 'function' ? await handler(...args) : handler; }
      catch (error) { session.errors.push(error.message); throw error; }
    });
    await session.page.exposeBinding('__releaseInvoke', async (_source, channel, args) => {
      try { return await dispatch(channel, args); } catch (error) { session.errors.push(error.message); throw error; }
    });
    // Execute the built production preload with a narrow Electron IPC transport shim.
    const preload = fs.readFileSync(path.join(projectRoot, 'dist', 'preload.js'), 'utf8');
    await session.page.addInitScript({ content: `(() => {
      const listeners = new Map();
      globalThis.__releaseOverridden = new Set(${JSON.stringify(Object.keys(overrides))});
      const ipcRenderer = {
        invoke: (channel, ...args) => globalThis.__releaseInvoke(channel, args),
        send: (channel, ...args) => { void globalThis.__releaseInvoke(channel, args).catch(() => {}); },
        on: (channel, listener) => { const list = listeners.get(channel) || []; list.push(listener); listeners.set(channel, list); },
        removeListener: (channel, listener) => { listeners.set(channel, (listeners.get(channel) || []).filter(value => value !== listener)); }
      };
      globalThis.__releaseEmit = (channel, payload) => { for (const listener of [...(listeners.get(channel) || [])]) listener({}, payload); };
      const require = name => { if (name !== 'electron') throw new Error('Unexpected preload module: ' + name); return {
        ipcRenderer, contextBridge: { exposeInMainWorld: (key, api) => {
          const wrapped = Object.fromEntries(Object.entries(api).map(([method, fn]) => [method,
            method.startsWith('on') ? fn : (...args) => globalThis.__releaseOverridden.has(method)
              ? globalThis.__releaseOverride(method, args) : fn(...args)]));
          globalThis[key] = Object.freeze(wrapped);
        } },
        webUtils: { getPathForFile: () => { throw new Error('Dropped files require an explicit browser fixture'); } }
      }; };
      const exports = {};
      ${preload}
    })();` });
    await session.page.goto(`${server.url}/dist/renderer/index.html`, { waitUntil: 'domcontentloaded' });
    await session.page.waitForFunction(() => globalThis.api && globalThis.document.getElementById('versionText')?.textContent.includes('v'));
    const actualMethods = await session.page.evaluate(() => Object.keys(globalThis.api).sort());
    assert.deepEqual(actualMethods, [...Object.keys(contract.methods), ...Object.keys(contract.events)].sort(), 'Built preload is stale; rebuild before release verification');
    await assertIsolation(session);
    return session;
  } catch (error) { await closeSession(session); throw error; }
}

function childEnvironment(env) {
  // An allowlist deliberately excludes tokens, NODE_OPTIONS, Electron overrides and inherited proxy credentials.
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return { ...result, PROGRAMDATA: env.programDataDir, APPDATA: env.roamingDir, LOCALAPPDATA: env.localAppDataDir,
    USERPROFILE: env.homeDir, HOME: env.homeDir, TEMP: env.tempDir, TMP: env.tempDir,
    HTTP_PROXY: OFFLINE_PROXY, HTTPS_PROXY: OFFLINE_PROXY, ALL_PROXY: OFFLINE_PROXY, NO_PROXY: '127.0.0.1,localhost',
    http_proxy: OFFLINE_PROXY, https_proxy: OFFLINE_PROXY, all_proxy: OFFLINE_PROXY, no_proxy: '127.0.0.1,localhost' };
}

async function launchElectron(env, { packaged = false, fixture = {}, executablePath: installedExecutable } = {}) {
  ownedRecord(env);
  if (process.platform !== 'win32') throw new Error(`Unsupported platform ${process.platform}: Windows production Electron tests require win32`);
  const session = sessionFor(env);
  try {
    validateConfig(env, JSON.parse(fs.readFileSync(env.configFile, 'utf8')));
    const contract = readContract(projectRoot);
    checkOverrides(contract, fixture.overrides || {}, true);
    if (installedExecutable !== undefined && (!packaged || typeof installedExecutable !== 'string'
      || !path.isAbsolute(installedExecutable) || !/\.exe$/i.test(installedExecutable)
      || !inside(env.rootDir, installedExecutable) || !fs.existsSync(installedExecutable)
      || !fs.statSync(installedExecutable).isFile() || !inside(canonical(env.rootDir), canonical(installedExecutable)))) {
      throw new Error('Installed executable must be an existing .exe inside the owned environment with packaged:true');
    }
    const executablePath = installedExecutable || (packaged ? path.join(projectRoot, 'release', 'win-unpacked', 'Twitch Downloader.exe') : require('electron'));
    const args = [`--user-data-dir=${env.userDataDir}`, `--proxy-server=${OFFLINE_PROXY}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--disable-background-networking'];
    if (!packaged) args.push('.');
    session.app = await require('playwright')._electron.launch({ executablePath, args, cwd: projectRoot, env: childEnvironment(env), timeout: 60000 });
    let appClosed = false;
    session.app.once('close', () => { appClosed = true; });
    ownedRecord(env).resources.push(async () => { if (!appClosed) await session.app.close(); });
    await session.app.evaluate(({ app, session: electronSession, safeStorage, shell, ipcMain }) => {
      const requireBuiltin = process.getBuiltinModule;
      const net = requireBuiltin('net');
      const originalConnect = net.Socket.prototype.connect;
      net.Socket.prototype.connect = function (...args) {
        if (Array.isArray(args[0])) args = args[0];
        const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
        if (options.path || !['localhost', '127.0.0.1', '::1'].includes(options.host || 'localhost')) throw new Error('Release fixture blocked external socket');
        return originalConnect.apply(this, args);
      };
      for (const name of ['encryptString', 'decryptString']) safeStorage[name] = () => { throw new Error('Release fixture forbids native credential access'); };
      for (const name of ['openExternal', 'openPath', 'showItemInFolder']) shell[name] = () => { throw new Error('Release fixture forbids external shell access'); };
      electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        callback({ cancel: !['file:', 'data:', 'blob:', 'devtools:'].includes(url.protocol) && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) });
      });
      const appRequire = requireBuiltin('module').createRequire(`${app.getAppPath()}/package.json`);
      // Updater is an external network dependency; media/database/queue handlers remain production code.
      const updater = appRequire('electron-updater').autoUpdater;
      updater.checkForUpdates = async () => null;
      updater.downloadUpdate = async () => { throw new Error('Release fixture forbids external updater downloads'); };
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      globalThis.__releaseCalls = [];
      // Electron exposes registered invoke handlers as a Map; preserve every original handler.
      if (!(ipcMain._invokeHandlers instanceof Map)) throw new Error('Unsupported Electron IPC instrumentation');
      for (const [channel, handler] of ipcMain._invokeHandlers) {
        ipcMain._invokeHandlers.set(channel, (event, ...args) => {
          if (/^(set-|clear-).*(secret|webhook)|^login$/.test(channel)) throw new Error('Release fixture forbids credential operations');
          globalThis.__releaseCalls.push({ channel, args });
          return handler(event, ...args);
        });
      }
    });
    session.replaceIpc = async (method, value) => {
      checkOverrides(contract, { [method]: value }, true);
      if (typeof value === 'function') throw new Error('Native overrides must be serializable values; exercise production handlers for backend behavior');
      await session.app.evaluate(({ ipcMain }, { channel, method, value }) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, ...args) => { globalThis.__releaseCalls.push({ channel, method, args }); return value; });
      }, { channel: contract.methods[method][0], method, value });
    };
    for (const [method, value] of Object.entries(fixture.overrides || {})) await session.replaceIpc(method, value);
    session.page = await session.app.firstWindow();
    session.page.on('pageerror', error => session.errors.push(error.message));
    await session.page.waitForLoadState('domcontentloaded');
    await session.page.waitForFunction(() => Boolean(globalThis.api));
    session.emit = async (event, payload) => {
      const channel = contract.events[event] || event;
      if (!Object.values(contract.events).includes(channel)) throw new Error(`Unknown fixture event: ${event}`);
      await session.app.evaluate(({ BrowserWindow }, { channel, payload }) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload);
      }, { channel, payload });
    };
    session.refreshCalls = async () => { session.calls.splice(0, session.calls.length, ...await session.app.evaluate(() => globalThis.__releaseCalls)); return session.calls; };
    await assertIsolation(session);
    return session;
  } catch (error) { await closeSession(session); throw error; }
}

async function createMediaFixture(env, options = {}) {
  ownedRecord(env);
  const { duration = 3, width = 320, height = 180, fps = 25, audio = true, name = 'fixture.mp4', ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = options;
  if (path.basename(name) !== name || !/\.(mp4|mkv|mov|webm|ts)$/.test(name)) throw new Error('Media fixture name must be a local video filename');
  if (![duration, width, height, fps].every(value => Number.isFinite(value) && value > 0) || duration > 120 || width > 3840 || height > 2160 || fps > 120) throw new Error('Invalid media fixture dimensions or duration');
  const file = path.join(env.mediaDir, name);
  if (fs.existsSync(file)) throw new Error('Refusing to overwrite an existing media fixture');
  if (!inside(canonical(env.rootDir), canonical(env.mediaDir))) throw new Error('Media directory escapes environment');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-t', String(duration), '-c:v', name.endsWith('.webm') ? 'libvpx-vp9' : 'libx264', '-pix_fmt', 'yuv420p');
  if (!name.endsWith('.webm')) args.push('-preset', 'ultrafast');
  if (audio) args.push('-c:a', name.endsWith('.webm') ? 'libopus' : 'aac', '-shortest');
  args.push(file);
  const execution = { env: childEnvironment(env), timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  await execFile(ffmpeg, args, execution);
  const { stdout } = await execFile(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], execution);
  const probe = JSON.parse(stdout);
  assert.ok(fs.statSync(file).size > 0, 'Empty media fixture');
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'), 'Missing video stream');
  assert.equal(probe.streams.some(stream => stream.codec_type === 'audio'), Boolean(audio));
  assert.ok(Math.abs(Number(probe.format.duration) - duration) < 0.3, 'Media fixture duration mismatch');
  return { path: file, file, probe, duration: Number(probe.format.duration) };
}

async function assertIsolation(session) {
  const { env } = session; ownedRecord(env);
  for (const key of ['programDataDir', 'appDataDir', 'userDataDir', 'downloadsDir', 'mediaDir', 'roamingDir', 'localAppDataDir', 'tempDir', 'homeDir']) {
    assert.ok(inside(canonical(env.rootDir), canonical(env[key])), `Escaped fixture directory: ${key}`);
  }
  const config = await session.page.evaluate(() => globalThis.api.getConfig()); validateConfig(env, config);
  assert.equal(canonical(config.download_path), canonical(env.downloadsDir), 'Production download path is not isolated');
  if (session.app) {
    const actual = await session.app.evaluate(({ app }) => ({ userData: app.getPath('userData'), appData: app.getPath('appData'),
      sessionData: app.getPath('sessionData'), userDataSwitch: app.commandLine.getSwitchValue('user-data-dir'),
      temp: app.getPath('temp'), programData: process.env.PROGRAMDATA, localAppData: process.env.LOCALAPPDATA }));
    // Windows' appData is an OS-known folder, not redirected by APPDATA. It is
    // reported as metadata only; the mandatory switch disables legacy migration
    // from it. Assert the actual writable profile/cache and production data paths.
    for (const [key, expected] of Object.entries({ userData: env.userDataDir, sessionData: env.userDataDir,
      userDataSwitch: env.userDataDir, temp: env.tempDir,
      programData: env.programDataDir, localAppData: env.localAppDataDir })) assert.equal(canonical(actual[key]), canonical(expected), `Native ${key} escaped isolation`);
    const secrets = await session.page.evaluate(() => globalThis.api.getSecretStatus());
    assert.equal(secrets.clientSecretConfigured, false); assert.equal(secrets.discordWebhookConfigured, false);
    return actual;
  }
  assert.ok(session.page.url().startsWith('http://127.0.0.1:'), 'Browser renderer is not loopback');
  return { rootDir: env.rootDir, downloadPath: config.download_path, browser: true };
}

async function closeSession(session) {
  const env = session.env || session;
  const record = owned.get(env);
  if (record?.closed) return;
  ownedRecord(env);
  const errors = [];
  for (const close of [...record.resources].reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  // Never remove files while an owned app/browser/server may still hold or use them.
  if (errors.length) throw new AggregateError(errors, 'Release fixture resources did not close; temporary files retained');
  ownedRecord(env);
  fs.rmSync(record.root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  record.closed = true;
}

module.exports = { parseOptions, createEnvironment, launchBrowser, launchElectron, createMediaFixture, createHttpFixture, assertIsolation, closeSession };
