import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DownloadProgress, QueueAdditionResult, QueueItem } from './types';

let developmentStyleRevision = -1;

function applyDevelopmentStyles(update: import('./main/development-live').DevelopmentStyleUpdate): void {
    if (new URLSearchParams(window.location.search).get('development') !== '1') return;
    if (update.revision <= developmentStyleRevision) return;
    document.documentElement.dataset.developmentUpdate = update.status;
    const badge = document.getElementById('developmentBadge');
    if (badge) {
        const de = document.documentElement.lang !== 'en';
        badge.title = update.status === 'error'
            ? (de ? 'Änderung nicht geladen. Bisheriger Stand bleibt aktiv.' : 'Change not loaded. Previous state remains active.')
            : update.status === 'restart' || update.status === 'reload'
                ? (de ? 'Änderung bereit. Wird automatisch übernommen, sobald keine Bearbeitung läuft.' : 'Change ready. Applies automatically when editing is idle.')
                : (de ? 'Änderungen werden automatisch übernommen.' : 'Changes apply automatically.');
    }
    if (update.status !== 'ready') return;
    const replacements = update.styles.map(({ name, css }) => {
        const link = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).find(element => {
            const filename = new URL(element.href).pathname.split('/').pop() || '';
            return filename === name + '.css' || filename.startsWith(name + '.') && /^[a-f0-9]{16}\.css$/.test(filename.slice(name.length + 1));
        });
        return { name, css, link };
    });
    if (replacements.some(item => !item.link)) return;
    for (const { name, css, link } of replacements) {
        let style = Array.from(document.querySelectorAll<HTMLStyleElement>('style[data-development-style]')).find(element => element.dataset.developmentStyle === name);
        if (!style) {
            style = document.createElement('style');
            style.dataset.developmentStyle = name;
            style.textContent = css;
            link!.after(style);
        } else if (style.textContent !== css) {
            style.textContent = css;
        }
        link!.disabled = true;
    }
    developmentStyleRevision = update.revision;
}

ipcRenderer.on('development-style-update', (_event, update: import('./main/development-live').DevelopmentStyleUpdate) => {
    applyDevelopmentStyles(update);
});
window.addEventListener('DOMContentLoaded', () => {
    if (new URLSearchParams(window.location.search).get('development') === '1') {
        ipcRenderer.send('development-style-ready');
    }
}, { once: true });

let chatReadSequence = 0;

// Types
interface RuntimeMetricsSnapshot {
    cacheHits: number;
    cacheMisses: number;
    duplicateSkips: number;
    retriesScheduled: number;
    retriesExhausted: number;
    integrityFailures: number;
    downloadsStarted: number;
    downloadsCompleted: number;
    downloadsFailed: number;
    downloadedBytesTotal: number;
    lastSpeedBytesPerSec: number;
    avgSpeedBytesPerSec: number;
    activeItemId: string | null;
    activeItemTitle: string | null;
    lastErrorClass: string | null;
    lastRetryDelaySeconds: number;
    timestamp: string;
    queue: {
        pending: number;
        downloading: number;
        paused: number;
        completed: number;
        error: number;
        total: number;
    };
    caches: {
        loginToUserId: number;
        vodList: number;
        clipInfo: number;
    };
    config: {
        performanceMode: 'stability' | 'balanced' | 'speed';
        smartScheduler: boolean;
        metadataCacheMinutes: number;
        duplicatePrevention: boolean;
    };
}

interface VideoInfo {
    sourceFormat?: import('./main/domain/media-format').VideoSourceFormat;
    duration: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
    videoCodec: string;
    audioCodec: string | null;
    previewCompatible: boolean;
    variableFrameRate: boolean;
}

interface VideoEditorMedia {
    sourceUrl: string;
    info: VideoInfo;
    jobId: number;
    thumbnails: string[];
    waveform: string | null;
}

interface VideoEditorAssets {
    jobId: number;
    thumbnails: string[];
    thumbnailSprite: string | null;
    thumbnailCount: number;
    pixelWidth: number;
    pixelHeight: number;
}

interface VideoEditorWaveform {
    channels?: number;
    jobId: number;
    waveform: string | null;
    pixelWidth: number;
    pixelHeight: number;
}

interface VideoEditorAssetProfile {
    timelineWidth: number;
    trackHeight: number;
    pixelRatio: number;
}

interface VideoEditExportRequest {
    allAudioStreams?: boolean;
    colorMode?: 'source' | 'sdr';
    inputCapability: string;
    outputName?: string;
    trimStart: number;
    trimEnd: number;
    cuts: Array<{ id: string; start: number; end: number }>;
}

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('api', {
    // Config
    getConfig: () => ipcRenderer.invoke('get-config'),
    getDownloadPolicyStatus: () => ipcRenderer.invoke('get-download-policy-status'),
    saveConfig: (config: any, fileCapability?: string) => ipcRenderer.invoke('save-config', config, fileCapability),
    getSecretStatus: () => ipcRenderer.invoke('get-secret-status'),
    setClientSecret: (value: string) => ipcRenderer.invoke('set-client-secret', value),
    clearClientSecret: () => ipcRenderer.invoke('clear-client-secret'),
    setDiscordWebhook: (value: string) => ipcRenderer.invoke('set-discord-webhook', value),
    clearDiscordWebhook: () => ipcRenderer.invoke('clear-discord-webhook'),

    // Auth
    login: () => ipcRenderer.invoke('login'),

    // Twitch API
    getUserId: (username: string) => ipcRenderer.invoke('get-user-id', username),
    getVODs: (userId: string, forceRefresh: boolean = false) => ipcRenderer.invoke('get-vods', userId, forceRefresh),
    getVodQualities: (request: { id: string; url: string }): Promise<import('./main/domain/vod-quality').VodQualityOption[] | null> => ipcRenderer.invoke('get-vod-qualities', request),
    cancelVodQualities: (id: string): Promise<void> => ipcRenderer.invoke('cancel-vod-qualities', id),
    openClipPlayback: (request: { id: string; url: string }) => ipcRenderer.invoke('open-clip-playback', request),
    closeClipPlayback: (id: string) => ipcRenderer.invoke('close-clip-playback', id),
    openVodPlayback: (request: { id: string; url: string }) => ipcRenderer.invoke('open-vod-playback', request),
    getVodTimeline: (request: { id: string; url: string }) => ipcRenderer.invoke('get-vod-timeline', request),
    closeVodPlayback: (id: string) => ipcRenderer.invoke('close-vod-playback', id),

    // Queue
    getQueue: () => ipcRenderer.invoke('get-queue'),
    addToQueue: (item: Pick<QueueItem, 'url' | 'title' | 'date' | 'streamer' | 'duration_str' | 'customClip' | 'quality' | 'qualityLabel'>) => ipcRenderer.invoke('add-to-queue', item),
    addToQueueWithResult: (item: Pick<QueueItem, 'url' | 'title' | 'date' | 'streamer' | 'duration_str' | 'customClip' | 'quality' | 'qualityLabel'>): Promise<QueueAdditionResult> => ipcRenderer.invoke('add-to-queue-with-result', item),
    startLiveRecording: (streamerName: string) => ipcRenderer.invoke('start-live-recording', streamerName),
    removeFromQueue: (id: string) => ipcRenderer.invoke('remove-from-queue', id),
    reorderQueue: (orderIds: string[]) => ipcRenderer.invoke('reorder-queue', orderIds),
    clearCompleted: () => ipcRenderer.invoke('clear-completed'),
    retryFailedDownloads: () => ipcRenderer.invoke('retry-failed-downloads'),
    retryQueueItem: (id: string) => ipcRenderer.invoke('retry-queue-item', id),
    createMergeGroup: (itemIds: string[]) => ipcRenderer.invoke('create-merge-group', itemIds),

    // Download
    startDownload: (manualOverride: boolean = true) => ipcRenderer.invoke('start-download', manualOverride),
    pauseDownload: () => ipcRenderer.invoke('pause-download'),
    cancelDownload: () => ipcRenderer.invoke('cancel-download'),
    isDownloading: () => ipcRenderer.invoke('is-downloading'),
    downloadClip: (url: string, requestId: string) => ipcRenderer.invoke('download-clip', url, requestId),
    cancelClipDownload: (requestId: string) => ipcRenderer.invoke('cancel-clip-download', requestId),
    onClipProgress: (callback: (progress: import('./main/domain/workspace-session').ClipTransferProgress) => void) => {
        ipcRenderer.on('clip-progress', (_, progress) => callback(progress));
    },
    getWorkspaceSession: () => ipcRenderer.invoke('get-workspace-session'),
    saveClipWorkspace: (items: import('./main/domain/workspace-session').WorkspaceClip[]) => ipcRenderer.invoke('save-clip-workspace', items),
    saveMergeWorkspace: (ids: string[]) => ipcRenderer.invoke('save-merge-workspace', ids),
    getMergeVideoInfo: (id: string) => ipcRenderer.invoke('get-merge-video-info', id),
    getClipInfo: (url: string): Promise<{ title: string; broadcaster_name: string } | null> => ipcRenderer.invoke('get-clip-info', url),

    // Files
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    saveQueueOutputDialog: (defaultName: string) => ipcRenderer.invoke('save-queue-output-dialog', defaultName),
    setQueueOutput: (id: string, capability: string) => ipcRenderer.invoke('set-queue-output', id, capability),
    selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
    selectMultipleVideos: () => ipcRenderer.invoke('select-multiple-videos'),
    selectDroppedVideo: (file: File) => ipcRenderer.invoke('grant-dropped-video', webUtils.getPathForFile(file)),
    saveVideoDialog: (defaultName: string) => ipcRenderer.invoke('save-video-dialog', defaultName),
    openFolder: async (pathOrCapability: string) => {
        const capability = await ipcRenderer.invoke('authorize-managed-path', 'selected-folder', pathOrCapability);
        if (capability) return ipcRenderer.invoke('open-folder', capability.token);
    },
    openFile: async (pathOrCapability: string) => {
        const capability = await ipcRenderer.invoke('authorize-managed-path', 'open-file', pathOrCapability);
        return capability ? ipcRenderer.invoke('open-file', capability.token) : false;
    },
    showInFolder: async (pathOrCapability: string) => {
        const capability = await ipcRenderer.invoke('authorize-managed-path', 'show-in-folder', pathOrCapability);
        return capability ? ipcRenderer.invoke('show-in-folder', capability.token) : false;
    },
    openDebugLogFile: () => ipcRenderer.invoke('open-debug-log-file'),
    checkFolderWritable: (capability: string) => ipcRenderer.invoke('check-folder-writable', capability),
    getStorageStats: () => ipcRenderer.invoke('get-storage-stats'),
    getArchiveStats: (range?: import('./main/domain/download-history-store').DownloadHistoryRange) => ipcRenderer.invoke('get-archive-stats', range),
    prepareArchiveVideos: (paths: string[], target: 'cutter' | 'merge') => ipcRenderer.invoke('prepare-archive-videos', paths, target),
    searchDownloadHistory: (filter?: import('./main/domain/download-history-store').DownloadHistoryFilter) => ipcRenderer.invoke('search-download-history', filter),
    hasDownloadedClip: (clipId: string) => ipcRenderer.invoke('has-downloaded-clip', clipId),
    exportStatistics: (range?: import('./main/domain/download-history-store').DownloadHistoryRange) => ipcRenderer.invoke('export-statistics', range),
    getStreamerProfile: (login: string, forceRefresh?: boolean) => ipcRenderer.invoke('get-streamer-profile', login, forceRefresh),
    getStreamerDisplayNames: (logins: string[]) => ipcRenderer.invoke('get-streamer-display-names', logins),
    getVodStoryboard: (vodId: string) => ipcRenderer.invoke('get-vod-storyboard', vodId),
    searchTwitchChannels: (query: string) => ipcRenderer.invoke('search-twitch-channels', query),
    getLiveStatusSnapshot: () => ipcRenderer.invoke('get-live-status-snapshot'),
    getLiveVodStatusSnapshot: () => ipcRenderer.invoke('get-live-status-snapshot', true),
    onLiveStatusBatchUpdate: (callback: (info: { changes: Array<import('./types').LiveVodStatus & { login: string }> }) => void) => {
        ipcRenderer.on('live-status-batch-update', (_, info) => callback(info));
    },
    searchArchive: (filter: Record<string, unknown>) => ipcRenderer.invoke('search-archive', filter),
    getArchiveThumbnail: (filename: string): Promise<string | null> => ipcRenderer.invoke('get-archive-thumbnail', filename),
    recoverStorageCleanup: () => ipcRenderer.invoke('recover-storage-cleanup'),
    runStorageCleanup: (options?: { dryRun?: boolean; token?: string }) => ipcRenderer.invoke('run-storage-cleanup', options),
    readChatFile: async (filePath: string, signal?: AbortSignal) => {
        const capability = await ipcRenderer.invoke('authorize-managed-path', 'chat-input', filePath);
        if (!capability) return { success: false, error: 'File access denied' };
        if (signal?.aborted) return { success: false, cancelled: true };
        const requestId = `chat-${Date.now()}-${++chatReadSequence}`;
        const cancel = () => ipcRenderer.send('cancel-chat-read', requestId);
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            return await ipcRenderer.invoke('read-chat-file', capability.token, requestId);
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
    },
    getAutomationStatus: () => ipcRenderer.invoke('get-automation-status'),
    triggerAutoVodScan: () => ipcRenderer.invoke('trigger-auto-vod-scan'),
    triggerAutoRecordScan: () => ipcRenderer.invoke('trigger-auto-record-scan'),
    onAutoVodScanCompleted: (callback: (info: { queuedCount: number }) => void) => {
        ipcRenderer.on('auto-vod-scan-completed', (_, info) => callback(info));
    },

    // Video Cutter
    getVideoInfo: (capability: string): Promise<VideoInfo | null> => ipcRenderer.invoke('get-video-info', capability),
    extractFrame: (capability: string, timeSeconds: number): Promise<string | null> => ipcRenderer.invoke('extract-frame', capability, timeSeconds),
    prepareVideoEditorMedia: (capability: string): Promise<VideoEditorMedia | null> => ipcRenderer.invoke('prepare-video-editor-media', capability),
    prepareVideoEditorWaveform: (capability: string, jobId: number): Promise<VideoEditorWaveform | null> => ipcRenderer.invoke('prepare-video-editor-waveform', capability, jobId),
    prepareVideoEditorAssets: (capability: string, jobId: number, profile: VideoEditorAssetProfile): Promise<VideoEditorAssets | null> => ipcRenderer.invoke('prepare-video-editor-assets', capability, jobId, profile),
    cancelVideoEditorAssets: (jobId: number): Promise<boolean> => ipcRenderer.invoke('cancel-video-editor-assets', jobId),
    getCutterProjectRecovery: (capability: string): Promise<CutterProject | null> => ipcRenderer.invoke('get-cutter-project-recovery', capability),
    saveCutterProject: (capability: string, project: Omit<CutterProject, 'source' | 'duration' | 'fps'>): Promise<boolean> => ipcRenderer.invoke('save-cutter-project', capability, project),
    discardCutterProject: (capability: string): Promise<boolean> => ipcRenderer.invoke('discard-cutter-project', capability),
    openCutterProject: (capability: string): Promise<CutterProject | null> => ipcRenderer.invoke('open-cutter-project', capability),
    getCutterExportOptions: (): Promise<CutterExportOptions | null> => ipcRenderer.invoke('get-cutter-export-options'),
    exportVideoEdit: (request: VideoEditExportRequest): Promise<{ success: boolean; outputCapability?: string; outputName: string | null; cancelled?: boolean }> => ipcRenderer.invoke('export-video-edit', request),
    cancelVideoEdit: (): Promise<boolean> => ipcRenderer.invoke('cancel-video-edit'),
    cutVideo: (inputCapability: string, startTime: number, endTime: number): Promise<{ success: boolean; outputName: string | null }> =>
        ipcRenderer.invoke('cut-video', inputCapability, startTime, endTime),

    // Merge Videos
    mergeVideos: (inputCapabilities: string[], outputCapability: string): Promise<{ success: boolean; outputName: string | null }> =>
        ipcRenderer.invoke('merge-videos', inputCapabilities, outputCapability),

    // App
    getVersion: () => ipcRenderer.invoke('get-version'),
    notifyRendererReady: () => ipcRenderer.send('renderer-ready'),
    checkUpdate: () => ipcRenderer.invoke('check-update'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
    runPreflight: (autoFix: boolean) => ipcRenderer.invoke('run-preflight', autoFix),
    getManagedToolStatus: () => ipcRenderer.invoke('get-managed-tool-status'),
    getManagedToolExecutionDiagnostics: (): Promise<{ ffmpeg: { path: string | null; count: number }; ffprobe: { path: string | null; count: number }; streamlink: { path: string | null; count: number } } | null> => ipcRenderer.invoke('get-managed-tool-execution-diagnostics'),
    repairManagedTools: () => ipcRenderer.invoke('repair-managed-tools'),
    resetManagedTools: () => ipcRenderer.invoke('reset-managed-tools'),
    getDebugLog: (lines: number) => ipcRenderer.invoke('get-debug-log', lines),
    getRuntimeMetrics: (): Promise<RuntimeMetricsSnapshot> => ipcRenderer.invoke('get-runtime-metrics'),
    exportRuntimeMetrics: (): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }> =>
        ipcRenderer.invoke('export-runtime-metrics'),
    resetDownloadedVodIds: (): Promise<{ success: boolean; removedCount: number }> =>
        ipcRenderer.invoke('reset-downloaded-vod-ids'),
    markVodDownloaded: (vodId: string, mark: boolean): Promise<{ success: boolean }> =>
        ipcRenderer.invoke('mark-vod-downloaded', vodId, mark),
    listNamedCutterProjects: () => ipcRenderer.invoke('editing-projects-list'),
    saveNamedCutterProject: (token: string, project: unknown, name: string, saveAs = false) => ipcRenderer.invoke('editing-project-save', token, project, name, saveAs),
    openNamedCutterProject: (id?: string) => ipcRenderer.invoke('editing-project-open', id),
    listExportJobs: () => ipcRenderer.invoke('editing-jobs-list'),
    enqueueCutterExport: (token: string, project: unknown) => ipcRenderer.invoke('editing-job-cut', token, project),
    inspectMergeExport: (ids: string[]) => ipcRenderer.invoke('editing-merge-inspect', ids),
    enqueueMergeExport: (ids: string[], mode: 'copy' | 'encode') => ipcRenderer.invoke('editing-job-merge', ids, mode),
    exportJobAction: (action: string, id?: string) => ipcRenderer.invoke('editing-job-action', action, id),
    onExportJobsChanged: (callback: (state: unknown) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
        ipcRenderer.on('editing-jobs-changed', listener);
        return () => ipcRenderer.removeListener('editing-jobs-changed', listener);
    },

    previewAutoVodRule: (channel: string, rule: unknown) => ipcRenderer.invoke('preview-auto-vod-rule', channel, rule),
    getVodLibrary: () => ipcRenderer.invoke('get-vod-library'),
    changeVodLibrary: (change: unknown) => ipcRenderer.invoke('change-vod-library', change),
    discoverClips: (request: import('./main/domain/clip-discovery').ClipDiscoveryRequest) => ipcRenderer.invoke('discover-clips', request),
    exportApplicationBackup: () => ipcRenderer.invoke('export-application-backup'),
    restoreApplicationBackup: () => ipcRenderer.invoke('restore-application-backup'),
    exportConfig: (): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }> =>
        ipcRenderer.invoke('export-config'),
    importConfig: (): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }> =>
        ipcRenderer.invoke('import-config'),

    // Events
    onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
        ipcRenderer.on('download-progress', (_, progress) => callback(progress));
    },
    onArchiveIndexUpdated: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('archive-index-updated', listener);
        return () => ipcRenderer.removeListener('archive-index-updated', listener);
    },
    onQueueUpdated: (callback: (queue: QueueItem[]) => void) => {
        ipcRenderer.on('queue-updated', (_, queue) => callback(queue));
    },
    onQueueDuplicateSkipped: (callback: (payload: { title: string; streamer: string; url: string }) => void) => {
        ipcRenderer.on('queue-duplicate-skipped', (_, payload) => callback(payload));
    },
    onDownloadStarted: (callback: () => void) => {
        ipcRenderer.on('download-started', () => callback());
    },
    onDownloadPaused: (callback: () => void) => {
        ipcRenderer.on('download-paused', () => callback());
    },
    onDownloadFinished: (callback: () => void) => {
        ipcRenderer.on('download-finished', () => callback());
    },
    onDownloadPolicyStatus: (callback: (status: DownloadPolicyStatus) => void) => {
        ipcRenderer.on('download-policy-status', (_, status) => callback(status));
    },
    onCutProgress: (callback: (percent: number) => void) => {
        ipcRenderer.on('cut-progress', (_, percent) => callback(percent));
    },
    onMergeFinished: (callback: (result: { success: boolean }) => void) => { ipcRenderer.on('merge-finished', (_, result) => callback(result)); },
    onMergeProgress: (callback: (percent: number) => void) => {
        ipcRenderer.on('merge-progress', (_, percent) => callback(percent));
    },

    // Auto-Update Events
    onUpdateChecking: (callback: () => void) => {
        ipcRenderer.on('update-checking', () => callback());
    },
    onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string; releaseName?: string; releaseNotes?: string }) => void) => {
        ipcRenderer.on('update-available', (_, info) => callback(info));
    },
    onUpdateNotAvailable: (callback: () => void) => {
        ipcRenderer.on('update-not-available', () => callback());
    },
    onUpdateDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => {
        ipcRenderer.on('update-download-progress', (_, progress) => callback(progress));
    },
    onUpdateDownloaded: (callback: (info: { version: string; releaseDate?: string; releaseName?: string; releaseNotes?: string }) => void) => {
        ipcRenderer.on('update-downloaded', (_, info) => callback(info));
    },
    onUpdateError: (callback: (payload: { message: string; kind: 'check' | 'download'; version?: string }) => void) => {
        ipcRenderer.on('update-error', (_, payload) => callback(payload));
    }
});
