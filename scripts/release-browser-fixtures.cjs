'use strict';

// Reconstructed public UI fixtures, not recovered private release tests.
const fs = require('node:fs');
const path = require('node:path');
const clone = value => value === undefined ? undefined : structuredClone(value);
const timestamp = '2026-01-01T00:00:00.000Z';

function readContract(root) {
  const source = fs.readFileSync(path.join(root, 'src/preload.ts'), 'utf8');
  const body = source.slice(source.indexOf("contextBridge.exposeInMainWorld('api'"));
  const entries = [...body.matchAll(/^ {4}(\w+):/gm)];
  const methods = {};
  const channels = {};
  const events = {};
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i][1];
    const section = body.slice(entries[i].index, entries[i + 1]?.index ?? body.length);
    const event = /ipcRenderer\.on\('([^']+)'/.exec(section);
    if (event) { events[name] = event[1]; continue; }
    const invokes = [...section.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map(match => match[1]);
    if (!invokes.length) throw new Error(`Unrecognized preload method: ${name}`);
    methods[name] = invokes;
    for (const channel of invokes) if (channel !== 'authorize-managed-path') channels[channel] = name;
  }
  return { methods, channels, events };
}

function createFixtureState(config, fixture = {}) {
  return {
    queue: [], library: { version: 1, filters: [], groups: [], markers: [], excerpts: [] },
    workspace: { clips: [], mergeFiles: [], automationPaused: false },
    vods: [{ id: '999999999999999', user_id: 'fixture-user', user_login: 'fixture_streamer',
      user_name: 'Fixture Streamer', title: 'Offline fixture VOD', created_at: timestamp,
      published_at: timestamp, duration: '1h0m0s', thumbnail_url: '',
      url: 'https://www.twitch.tv/videos/999999999999999', view_count: 123, type: 'archive' }],
    live: {}, downloading: false, sequence: 0, ...clone(fixture.state || {}),
    config: { ...clone(config), ...clone(fixture.state?.config || {}) },
  };
}

function createDispatcher({ state, overrides, contract, calls, emit, validateConfig, version }) {
  const defaults = {
    getConfig: () => state.config,
    saveConfig: update => { const next = { ...state.config, ...clone(update) }; validateConfig(next); state.config = next; return next; },
    getSecretStatus: () => ({ encryptionAvailable: false, clientSecretConfigured: false, discordWebhookConfigured: false }),
    getVersion: () => version,
    getQueue: () => state.queue,
    isDownloading: () => state.downloading,
    notifyRendererReady: () => undefined,
    getDownloadPolicyStatus: () => ({ waiting: false, reason: null, nextStart: null }),
    getUserId: () => 'fixture-user', getVODs: () => state.vods,
    getStreamerProfile: () => null, getStreamerDisplayNames: logins => Object.fromEntries(logins.map(login => [login, login])),
    getLiveStatusSnapshot: () => state.live, getLiveVodStatusSnapshot: () => state.live,
    searchTwitchChannels: () => [], getVodStoryboard: () => null,
    getVodQualities: () => null, cancelVodQualities: () => undefined,
    getWorkspaceSession: () => state.workspace,
    saveClipWorkspace: items => { state.workspace.clips = clone(items); return true; },
    saveMergeWorkspace: ids => { state.workspace.mergeFiles = state.workspace.mergeFiles.filter(file => ids.includes(file.id)); return true; },
    getClipLibrary: (offset = 0) => ({ directory: state.config.clip_download_path || state.config.download_path,
      rootExists: true, total: 0, offset, files: [] }),
    getVodLibrary: () => state.library,
    changeVodLibrary: change => {
      if (!['filters', 'groups', 'markers', 'excerpts'].includes(change.collection)) throw new Error('Invalid fixture library collection');
      const rows = state.library[change.collection];
      if (change.remove) state.library[change.collection] = rows.filter(row => row.id !== change.remove);
      else {
        const item = { ...clone(change.item), id: change.item.id || `fixture-${++state.sequence}` };
        const index = rows.findIndex(row => row.id === item.id);
        if (index < 0) rows.push(item); else rows[index] = item;
      }
      return state.library;
    },
    listNamedCutterProjects: () => ({ success: true, projects: [] }), listExportJobs: () => ({ success: true, jobs: [], paused: true }),
    getAutomationStatus: () => ({ autoRecord: { watching: 0, lastRunAt: null, nextRunAt: null, lastTriggeredCount: 0, inFlight: false },
      autoVod: { watching: 0, lastRunAt: null, nextRunAt: null, lastQueuedCount: 0, inFlight: false } }),
    checkUpdate: () => ({ checking: false, offlineFixture: true }),
    getDebugLog: () => '',
    runPreflight: autoFix => {
      if (autoFix) throw new Error('Preflight repair requires an explicit fixture override');
      return { ok: false, autoFixApplied: false, checks: { internet: false, streamlink: false, ffmpeg: false,
        ffprobe: false, downloadPathWritable: true }, messages: ['Offline browser fixture: native tools unavailable'], timestamp };
    },
    getManagedToolStatus: () => Object.fromEntries(['streamlink', 'ffmpeg'].map(id => [id, {
      id, version: 'fixture-unavailable', sourceUrl: '', archiveName: '', state: 'missing', verified: false, fallbackRunnable: false,
    }])),
    getRuntimeMetrics: () => ({ cacheHits: 0, cacheMisses: 0, duplicateSkips: 0, retriesScheduled: 0, retriesExhausted: 0,
      integrityFailures: 0, downloadsStarted: 0, downloadsCompleted: 0, downloadsFailed: 0, downloadedBytesTotal: 0,
      lastSpeedBytesPerSec: 0, avgSpeedBytesPerSec: 0, activeItemId: null, activeItemTitle: null, lastErrorClass: null,
      lastRetryDelaySeconds: 0, timestamp,
      queue: { ...Object.fromEntries(['pending', 'downloading', 'paused', 'completed', 'error'].map(status =>
        [status, state.queue.filter(item => item.status === status).length])), total: state.queue.length },
      caches: { loginToUserId: 0, vodList: 0, clipInfo: 0 }, config: { performanceMode: state.config.performance_mode,
        smartScheduler: state.config.smart_queue_scheduler, metadataCacheMinutes: state.config.metadata_cache_minutes,
        duplicatePrevention: state.config.prevent_duplicate_downloads } }),
    getStorageStats: () => ({ downloadPath: state.config.download_path, rootExists: true, freeBytes: 10737418240,
      totalFiles: 0, totalBytes: 0, streamers: [], extras: [], scannedAt: timestamp }),
    searchArchive: (filter = {}) => ({ totalScanned: 0, matchCount: 0, truncated: false, hits: [], scannedAt: timestamp,
      rootExists: true, streamers: [], offset: filter.offset || 0 }),
    getArchiveThumbnail: () => null,
    getArchiveStats: () => ({ downloadPath: state.config.download_path, rootExists: true, scannedAt: timestamp,
      totalFiles: 0, totalBytes: 0, liveCount: 0, liveBytes: 0, vodCount: 0, vodBytes: 0, clipCount: 0, clipBytes: 0,
      chatCount: 0, chatBytes: 0, eventsCount: 0, streamerCount: 0, avgRecordingSizeBytes: 0,
      channels: [], topStreamers: [], dailyActivity: [], sizeBuckets: [],
      lifetime: { available: true, trackedSince: null, totalDownloads: 0, completedJobs: 0, vodDownloads: 0,
        clipDownloads: 0, liveRecordings: 0, outputFiles: 0, totalBytes: 0, recoveredDownloads: 0,
        unknownDateDownloads: 0, dailyActivity: [] } }),
    searchDownloadHistory: (filter = {}) => ({ entries: [], total: 0, offset: filter.offset || 0, limit: filter.limit || 50 }),
    hasDownloadedClip: () => false,
    markVodDownloaded: (id, mark) => {
      if (typeof id !== 'string' || !/^\d+$/.test(id) || typeof mark !== 'boolean') return { success: false };
      const ids = new Set(state.config.downloaded_vod_ids || []);
      if (mark) ids.add(id); else ids.delete(id);
      state.config.downloaded_vod_ids = [...ids];
      return { success: true };
    },
    resetDownloadedVodIds: () => {
      const removedCount = (state.config.downloaded_vod_ids || []).length;
      state.config.downloaded_vod_ids = [];
      return { success: true, removedCount };
    },
    selectFolder: () => null, selectVideoFile: () => null, selectMultipleVideos: () => [], saveVideoDialog: () => null,
    saveQueueOutputDialog: () => null,
    getCutterProjectRecovery: () => null,
  };
  const queueChanged = async () => { await emit('queue-updated', state.queue); return state.queue; };
  const addQueueItem = async (item, notifyDuplicate) => {
    if (!item || typeof item.url !== 'string' || !/^https:\/\/(?:www\.)?(?:twitch\.tv|clips\.twitch\.tv)\//.test(item.url)) {
      return { accepted: false, reason: 'invalid', queue: state.queue };
    }
    if (state.config.prevent_duplicate_downloads && state.queue.some(row => ['pending', 'downloading', 'paused'].includes(row.status)
      && row.url === item.url && row.quality === item.quality && JSON.stringify(row.customClip) === JSON.stringify(item.customClip))) {
      if (notifyDuplicate) await emit('queue-duplicate-skipped', { title: item.title, streamer: item.streamer, url: item.url });
      return { accepted: false, reason: 'duplicate', queue: state.queue };
    }
    const id = `fixture-queue-${++state.sequence}`;
    state.queue.push({ ...clone(item), id, status: 'pending', progress: 0, createdAt: timestamp });
    await queueChanged();
    return { accepted: true, addedId: id, queue: state.queue };
  };
  defaults.addToQueueWithResult = item => addQueueItem(item, false);
  defaults.addToQueue = async item => (await addQueueItem(item, true)).queue;
  defaults.removeFromQueue = async id => { state.queue = state.queue.filter(row => row.id !== id); return queueChanged(); };
  defaults.clearCompleted = async () => { state.queue = state.queue.filter(row => row.status !== 'completed'); return queueChanged(); };
  defaults.reorderQueue = async ids => {
    if (!Array.isArray(ids)) return state.queue;
    const order = new Map(ids.map((id, index) => [id, index]));
    state.queue.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    return queueChanged();
  };
  const retry = item => {
    if (item.status === 'error' && !item.mergeRecoveryBlocked) Object.assign(item, { status: 'pending', progress: 0, last_error: '' });
  };
  defaults.retryQueueItem = async id => { const item = state.queue.find(row => row.id === id); if (item) retry(item); return queueChanged(); };
  defaults.retryFailedDownloads = async () => {
    for (const item of state.queue) retry(item);
    return queueChanged();
  };
  return async (channel, args = []) => {
    const method = channel === 'get-live-status-snapshot' ? (args[0] ? 'getLiveVodStatusSnapshot' : 'getLiveStatusSnapshot') : contract.channels[channel];
    calls.push({ method: method || null, channel, args: clone(args) });
    if (!method) throw new Error(`Unexpected release fixture IPC: ${channel}`);
    const handler = Object.hasOwn(overrides, method) ? overrides[method] : defaults[method];
    if (handler === undefined && !Object.hasOwn(overrides, method)) throw new Error(`Unconfigured release fixture API: ${method} (${channel})`);
    return clone(typeof handler === 'function' ? await handler(...args) : handler);
  };
}

module.exports = { readContract, createFixtureState, createDispatcher };
