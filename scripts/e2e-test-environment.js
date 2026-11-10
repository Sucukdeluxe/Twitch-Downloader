const fs = require('fs');
const os = require('os');
const path = require('path');

const OFFLINE_PROXY = 'http://127.0.0.1:1';

function buildSafeConfig(downloadsDir, overrides = {}) {
  return {
    theme: 'twitch',
    download_mode: 'full',
    part_minutes: 120,
    language: 'en',
    filename_template_vod: '{title}.mp4',
    filename_template_parts: '{date}_Part{part_padded}.mp4',
    filename_template_clip: '{date}_{part}.mp4',
    smart_queue_scheduler: false,
    performance_mode: 'balanced',
    prevent_duplicate_downloads: true,
    persist_queue_on_restart: false,
    metadata_cache_minutes: 10,
    parallel_downloads: 1,
    downloaded_vod_ids: [],
    streamlink_quality: 'best',
    notify_on_each_completion: false,
    streamlink_disable_ads: true,
    auto_record_poll_seconds: 90,
    auto_cleanup_days: 30,
    auto_cleanup_target: 'live_only',
    auto_cleanup_action: 'archive',
    log_stream_events: false,
    auto_vod_download_poll_minutes: 15,
    auto_vod_max_age_hours: 24,
    ...overrides,
    client_id: '',
    download_path: downloadsDir,
    streamers: [],
    auto_resume_queue_on_startup: false,
    auto_record_streamers: [],
    download_chat_replay: false,
    capture_live_chat: false,
    discord_notify_live_start: false,
    discord_notify_live_end: false,
    discord_notify_vod_complete: false,
    discord_notify_vod_auto_queued: false,
    auto_cleanup_enabled: false,
    auto_vod_download_streamers: [],
    auto_resume_live_recording: false,
    auto_merge_resumed_parts: false,
    delete_parts_after_merge: false
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createE2eEnvironment(name, configOverrides = {}) {
  const safeName = String(name || 'smoke').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `twitch-vod-manager-${safeName}-`));
  const programDataDir = path.join(rootDir, 'programdata');
  const userDataDir = path.join(rootDir, 'userdata');
  const downloadsDir = path.join(rootDir, 'downloads');
  const appDataDir = path.join(programDataDir, 'Twitch_VOD_Manager');
  const mediaDir = path.join(rootDir, 'media');
  const configFile = path.join(appDataDir, 'config.json');
  const queueFile = path.join(appDataDir, 'download_queue.json');

  for (const directory of [programDataDir, userDataDir, downloadsDir, appDataDir, mediaDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  writeJson(configFile, buildSafeConfig(downloadsDir, configOverrides));
  writeJson(queueFile, []);

  return {
    rootDir,
    programDataDir,
    userDataDir,
    downloadsDir,
    appDataDir,
    mediaDir,
    configFile,
    queueFile
  };
}

function writeE2eConfig(environment, overrides = {}) {
  const config = buildSafeConfig(environment.downloadsDir, overrides);
  writeJson(environment.configFile, config);
  return config;
}

function readE2eConfig(environment) {
  const databasePath = path.join(environment.appDataDir, 'app.db');
  if (fs.existsSync(databasePath)) {
    const Database = require('better-sqlite3');
    const database = new Database(databasePath, { readonly: true });
    try {
      const rows = database.prepare('SELECT key, value FROM config_kv').all();
      return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    } finally {
      database.close();
    }
  }
  return JSON.parse(fs.readFileSync(environment.configFile, 'utf8'));
}

function getElectronLaunchOptions(environment, extraArgs = []) {
  return {
    executablePath: require('electron'),
    args: [
      `--user-data-dir=${environment.userDataDir}`,
      `--proxy-server=${OFFLINE_PROXY}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      ...extraArgs,
      '.'
    ],
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROGRAMDATA: environment.programDataDir,
      TWITCH_VOD_MANAGER_DATA_DIR: environment.appDataDir,
      HTTP_PROXY: OFFLINE_PROXY,
      HTTPS_PROXY: OFFLINE_PROXY,
      ALL_PROXY: OFFLINE_PROXY,
      NO_PROXY: '',
      http_proxy: OFFLINE_PROXY,
      https_proxy: OFFLINE_PROXY,
      all_proxy: OFFLINE_PROXY,
      no_proxy: ''
    }
  };
}

function isSamePath(left, right) {
  const canonical = (value) => {
    const resolved = fs.realpathSync(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return canonical(left) === canonical(right);
}

async function verifyE2eIsolation(app, win, environment) {
  const main = await app.evaluate(({ app: electronApp }) => ({
    programData: process.env.PROGRAMDATA || '',
    userData: electronApp.getPath('userData')
  }));
  const rendererDownloadPath = await win.evaluate(async () => {
    const currentConfig = await window.api.getConfig();
    return currentConfig.download_path;
  });
  const verification = {
    rootDir: environment.rootDir,
    programData: main.programData,
    userData: main.userData,
    downloadPath: rendererDownloadPath,
    programDataIsolated: isSamePath(main.programData, environment.programDataDir),
    userDataIsolated: isSamePath(main.userData, environment.userDataDir),
    downloadPathIsolated: isSamePath(rendererDownloadPath, environment.downloadsDir)
  };

  if (!verification.programDataIsolated || !verification.userDataIsolated || !verification.downloadPathIsolated) {
    throw new Error(`E2E isolation verification failed: ${JSON.stringify(verification)}`);
  }

  return verification;
}

async function installOfflineFixtures(app) {
  return app.evaluate(({ app: electronApp, ipcMain }) => {
    const offlineState = {
      httpProxy: process.env.HTTP_PROXY || '',
      httpsProxy: process.env.HTTPS_PROXY || '',
      allProxy: process.env.ALL_PROXY || '',
      noProxy: process.env.NO_PROXY ?? null,
      chromiumProxy: electronApp.commandLine.getSwitchValue('proxy-server')
    };
    const guardsActive =
      offlineState.httpProxy === offlineState.httpsProxy &&
      offlineState.httpProxy === offlineState.allProxy &&
      offlineState.httpProxy.startsWith('http://127.0.0.1:') &&
      offlineState.noProxy === '' &&
      offlineState.chromiumProxy === offlineState.httpProxy;
    if (!guardsActive) {
      throw new Error(`Offline bootstrap verification failed: ${JSON.stringify(offlineState || null)}`);
    }
    const vods = [{
      id: '999999999999999',
      title: 'Offline fixture VOD',
      created_at: '2026-02-01T00:00:00Z',
      duration: '1h0m0s',
      thumbnail_url: '',
      url: 'https://www.twitch.tv/videos/999999999999999',
      view_count: 123,
      stream_id: 'offline-fixture-stream'
    }];
    const replaceHandler = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };

    replaceHandler('get-user-id', async () => 'offline-fixture-user');
    replaceHandler('get-vods', async () => vods);
    replaceHandler('get-streamer-profile', async () => null);
    replaceHandler('run-preflight', async () => ({
      ok: true,
      autoFixApplied: false,
      checks: {
        internet: true,
        streamlink: true,
        ffmpeg: true,
        ffprobe: true,
        downloadPathWritable: true
      },
      messages: ['Offline fixture'],
      timestamp: '2026-01-01T00:00:00Z'
    }));
    replaceHandler('check-update', async () => ({ checking: true, offlineFixture: true }));

    return {
      network: 'blocked',
      twitch: 'fixture',
      updater: 'fixture',
      guards: offlineState
    };
  });
}

function cleanupE2eEnvironment(environment) {
  if (!environment?.rootDir) {
    return;
  }

  fs.rmSync(environment.rootDir, { recursive: true, force: true });
}

module.exports = {
  buildSafeConfig,
  createE2eEnvironment,
  writeE2eConfig,
  readE2eConfig,
  getElectronLaunchOptions,
  verifyE2eIsolation,
  installOfflineFixtures,
  cleanupE2eEnvironment
};
