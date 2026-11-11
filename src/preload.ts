import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CustomClip, MergeGroupItem, MergeGroup, QueueItem, DownloadProgress } from './types';

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
    inputCapability: string;
    outputName?: string;
    trimStart: number;
    trimEnd: number;
    cuts: Array<{ id: string; start: number; end: number }>;
}

interface FileCapabilityReference {
    token: string;
    name: string;
    displayPath?: string;
}

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('api', {
    platform: process.platform,
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

    // Queue
    getQueue: () => ipcRenderer.invoke('get-queue'),
    addToQueue: (item: Pick<QueueItem, 'url' | 'title' | 'date' | 'streamer' | 'duration_str' | 'customClip'>) => ipcRenderer.invoke('add-to-queue', item),
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
    downloadClip: (url: string) => ipcRenderer.invoke('download-clip', url),

    // Files
    selectFolder: () => ipcRenderer.invoke('select-folder'),
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
    getArchiveStats: () => ipcRenderer.invoke('get-archive-stats'),
    getStreamerProfile: (login: string, forceRefresh?: boolean) => ipcRenderer.invoke('get-streamer-profile', login, forceRefresh),
    getStreamerDisplayNames: (logins: string[]) => ipcRenderer.invoke('get-streamer-display-names', logins),
    getVodStoryboard: (vodId: string) => ipcRenderer.invoke('get-vod-storyboard', vodId),
    getLiveStatusSnapshot: () => ipcRenderer.invoke('get-live-status-snapshot'),
    onLiveStatusBatchUpdate: (callback: (info: { changes: Array<{ login: string; isLive: boolean }> }) => void) => {
        ipcRenderer.on('live-status-batch-update', (_, info) => callback(info));
    },
    searchArchive: (filter: Record<string, unknown>) => ipcRenderer.invoke('search-archive', filter),
    runStorageCleanup: (options?: { dryRun?: boolean }) => ipcRenderer.invoke('run-storage-cleanup', options),
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
    onNativeEditCommand: (callback: (action: 'undo' | 'redo') => void) => {
        ipcRenderer.on('native-edit-command', (_, action) => callback(action));
    },
    performNativeEdit: (action: 'undo' | 'redo') => ipcRenderer.send('native-edit-default', action),
    onPrepareWindowClose: (callback: () => Promise<boolean>) => {
        ipcRenderer.on('prepare-window-close', (_, requestId: number) => {
            void callback().then(
                (saved) => ipcRenderer.send('window-close-ready', requestId, saved),
                () => ipcRenderer.send('window-close-ready', requestId, false),
            );
        });
    },
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
    checkUpdate: () => ipcRenderer.invoke('check-update'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    rendererReady: () => ipcRenderer.send('renderer-ready'),
    onUpdateInstallError: (callback: () => void) => { ipcRenderer.on('update-install-error', () => callback()); },
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
    runPreflight: (autoFix: boolean) => ipcRenderer.invoke('run-preflight', autoFix),
    getManagedToolStatus: () => ipcRenderer.invoke('get-managed-tool-status'),
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
    exportConfig: (): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }> =>
        ipcRenderer.invoke('export-config'),
    importConfig: (): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }> =>
        ipcRenderer.invoke('import-config'),

    // Events
    onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
        ipcRenderer.on('download-progress', (_, progress) => callback(progress));
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
    onUpdateError: (callback: (payload: { message: string }) => void) => {
        ipcRenderer.on('update-error', (_, payload) => callback(payload));
    }
});
