interface AppConfig {
    client_id?: string;
    download_path?: string;
    streamers?: string[];
    streamer_display_names?: Record<string, string>;
    theme?: string;
    download_mode?: 'parts' | 'full';
    part_minutes?: number;
    language?: 'de' | 'en';
    sidebar_split_view?: boolean;
    filename_template_vod?: string;
    filename_template_parts?: string;
    filename_template_clip?: string;
    smart_queue_scheduler?: boolean;
    performance_mode?: 'stability' | 'balanced' | 'speed';
    prevent_duplicate_downloads?: boolean;
    persist_queue_on_restart?: boolean;
    metadata_cache_minutes?: number;
    parallel_downloads?: number;
    auto_resume_queue_on_startup?: boolean;
    downloaded_vod_ids?: string[];
    streamlink_quality?: string;
    notify_on_each_completion?: boolean;
    streamlink_disable_ads?: boolean;
    download_policy?: DownloadPolicy;
    auto_record_streamers?: string[];
    auto_record_poll_seconds?: number;
    download_chat_replay?: boolean;
    capture_live_chat?: boolean;
    discord_notify_live_start?: boolean;
    discord_notify_live_end?: boolean;
    discord_notify_vod_complete?: boolean;
    discord_notify_vod_auto_queued?: boolean;
    auto_cleanup_enabled?: boolean;
    auto_cleanup_days?: number;
    auto_cleanup_target?: 'live_only' | 'all';
    auto_cleanup_action?: 'delete' | 'archive';
    log_stream_events?: boolean;
    auto_vod_download_streamers?: string[];
    auto_vod_download_poll_minutes?: number;
    auto_vod_max_age_hours?: number;
    auto_resume_live_recording?: boolean;
    auto_merge_resumed_parts?: boolean;
    delete_parts_after_merge?: boolean;
    [key: string]: unknown;
}

interface VOD {
    id: string;
    title: string;
    created_at: string;
    duration: string;
    thumbnail_url: string;
    url: string;
    view_count: number;
    stream_id?: string;
}

interface CustomClip {
    startSec: number;
    durationSec: number;
    startPart: number;
    filenameFormat: 'simple' | 'timestamp' | 'template' | 'parts';
    filenameTemplate?: string;
}

interface MergeGroupItem {
    url: string;
    title: string;
    date: string;
    streamer: string;
    duration_str: string;
}

interface MergeGroup {
    items: MergeGroupItem[];
    mergePhase: 'downloading' | 'merging' | 'splitting' | 'cleanup' | 'done';
    currentItemIndex: number;
    downloadedFiles: Record<number, string>;
    mergedFile?: string;
    splitFiles?: string[];
    totalDurationSec?: number;
}

interface QueueItem {
    id: string;
    title: string;
    url: string;
    date: string;
    streamer: string;
    duration_str: string;
    status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
    progress: number;
    currentPart?: number;
    totalParts?: number;
    speed?: string;
    eta?: string;
    downloadedBytes?: number;
    totalBytes?: number;
    progressStatus?: string;
    last_error?: string;
    customClip?: CustomClip;
    mergeGroup?: MergeGroup;
    outputFiles?: string[];
    isLive?: boolean;
    recordingHealth?: 'ok' | 'stale' | 'unknown';
}

interface DownloadProgress {
    id: string;
    progress: number;
    speed: string;
    speedBytesPerSec?: number;
    eta: string;
    status: string;
    currentPart?: number;
    totalParts?: number;
    downloadedBytes?: number;
    totalBytes?: number;
    recordingHealth?: 'ok' | 'stale' | 'unknown';
}

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
    rotation: 0 | 90 | 180 | 270;
    audioStreams: Array<{ index: number; codec: string; channels: number; language: string | null }>;
}

interface DownloadPolicy {
    throttle: { maxBytesPerSecond: number } | null;
    windows: Array<{ start: string; end: string }>;
}

interface DownloadPolicyStatus {
    waiting: boolean;
    reason: 'outside-window' | null;
    nextStart: string | null;
}

interface SecretStatus {
    encryptionAvailable: boolean;
    clientSecretConfigured: boolean;
    discordWebhookConfigured: boolean;
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
    profile?: 'quality' | 'balanced' | 'fast' | 'archive';
    encoder?: 'software' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox';
    audioStreamIndex?: number;
}

interface CutterProject {
    source: { path: string; size: number; mtimeMs: number };
    duration: number;
    fps: number;
    trimStart: number;
    trimEnd: number;
    cuts: Array<{ id: string; start: number; end: number }>;
    profile: 'quality' | 'balanced' | 'fast' | 'archive';
    encoder: 'software' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox';
    audioStreamIndex: number;
}

interface CutterExportOptions {
    profiles: Array<{ id: 'quality' | 'balanced' | 'fast' | 'archive'; label: string; container: 'mp4' | 'mkv' }>;
    hardwareEncoders: Array<'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox'>;
}

interface FileCapabilityReference {
    token: string;
    name: string;
    displayPath?: string;
}

interface ClipDialogData {
    url: string;
    title: string;
    date: string;
    streamer: string;
    duration: string;
}

interface UpdateInfo {
    version: string;
    releaseDate?: string;
    releaseName?: string;
    releaseNotes?: string;
}

interface UpdateDownloadProgress {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
}

interface PreflightChecks {
    internet: boolean;
    streamlink: boolean;
    ffmpeg: boolean;
    ffprobe: boolean;
    downloadPathWritable: boolean;
}

interface PreflightResult {
    ok: boolean;
    autoFixApplied: boolean;
    checks: PreflightChecks;
    messages: string[];
    timestamp: string;
}

interface ManagedToolStatus {
    id: 'streamlink' | 'ffmpeg';
    version: string;
    sourceUrl: string;
    archiveName: string;
    state: 'missing' | 'installing' | 'verified' | 'unverified' | 'corrupt';
    verified: boolean;
}

interface ManagedToolStatuses {
    streamlink: ManagedToolStatus;
    ffmpeg: ManagedToolStatus;
}

interface StreamerStorageEntry {
    name: string;
    fileCount: number;
    totalBytes: number;
    liveBytes: number;
    chatBytes: number;
    folderPath: string;
}
interface CleanupReport {
    enabled: boolean;
    dryRun: boolean;
    cutoffDays: number;
    target: 'live_only' | 'all';
    action: 'delete' | 'archive';
    scannedAt: string;
    candidates: number;
    processed: number;
    failed: number;
    bytesFreed: number;
    failures: Array<{ path: string; error: string }>;
}
interface StorageStatsResult {
    downloadPath: string;
    rootExists: boolean;
    freeBytes: number | null;
    totalFiles: number;
    totalBytes: number;
    streamers: StreamerStorageEntry[];
    extras: StreamerStorageEntry[];
    scannedAt: string;
}

interface StreamerProfile {
    login: string;
    displayName: string;
    avatarUrl: string;
    bannerUrl: string;
    description: string;
    broadcasterType: '' | 'partner' | 'affiliate';
    followerCount: number | null;
    vodCount: number;
    lastStreamAt: string | null;
    isLive: boolean;
    currentTitle: string | null;
    currentGame: string | null;
    currentStreamPreviewUrl: string;
    currentStreamViewers: number | null;
    twitchUrl: string;
    fetchedAt: number;
}

interface VodStoryboard {
    vodId: string;
    spriteDataUrl: string;
    frameDataUrls: string[];
    frameWidth: number;
    frameHeight: number;
    cols: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    framesInSprite: number;
}

interface ArchiveSearchHit {
    fullPath: string;
    fileName: string;
    streamer: string;
    type: 'live' | 'vod' | 'chat' | 'events' | 'other';
    size: number;
    mtimeMs: number;
    chatPath: string | null;
    eventsPath: string | null;
}
interface ArchiveSearchResult {
    totalScanned: number;
    matchCount: number;
    truncated: boolean;
    hits: ArchiveSearchHit[];
    scannedAt: string;
    rootExists: boolean;
}

interface ArchiveStatsTopStreamer {
    streamer: string;
    bytes: number;
    fileCount: number;
    liveBytes: number;
    vodBytes: number;
    chatBytes: number;
}
interface ArchiveStatsDay { date: string; count: number; bytes: number }
interface ArchiveStatsBucket { label: string; count: number; bytes: number }
interface ArchiveStats {
    totalFiles: number;
    totalBytes: number;
    liveCount: number;
    liveBytes: number;
    vodCount: number;
    vodBytes: number;
    chatCount: number;
    chatBytes: number;
    eventsCount: number;
    streamerCount: number;
    avgRecordingSizeBytes: number;
    topStreamers: ArchiveStatsTopStreamer[];
    dailyActivity: ArchiveStatsDay[];
    sizeBuckets: ArchiveStatsBucket[];
    scannedAt: string;
    downloadPath: string;
    rootExists: boolean;
}

interface ApiBridge {
    getConfig(): Promise<AppConfig>;
    getDownloadPolicyStatus(): Promise<DownloadPolicyStatus>;
    saveConfig(config: Partial<AppConfig>, fileCapability?: string): Promise<AppConfig>;
    getSecretStatus(): Promise<SecretStatus>;
    setClientSecret(value: string): Promise<SecretStatus>;
    clearClientSecret(): Promise<SecretStatus>;
    setDiscordWebhook(value: string): Promise<SecretStatus>;
    clearDiscordWebhook(): Promise<SecretStatus>;
    login(): Promise<boolean>;
    getUserId(username: string): Promise<string | null>;
    getVODs(userId: string, forceRefresh?: boolean): Promise<VOD[]>;
    getQueue(): Promise<QueueItem[]>;
    addToQueue(item: Pick<QueueItem, 'url' | 'title' | 'date' | 'streamer' | 'duration_str' | 'customClip'>): Promise<QueueItem[]>;
    startLiveRecording(streamerName: string): Promise<{ success: boolean; error?: string; streamer?: string; title?: string }>;
    removeFromQueue(id: string): Promise<QueueItem[]>;
    reorderQueue(orderIds: string[]): Promise<QueueItem[]>;
    clearCompleted(): Promise<QueueItem[]>;
    retryFailedDownloads(): Promise<QueueItem[]>;
    retryQueueItem(id: string): Promise<QueueItem[]>;
    createMergeGroup(itemIds: string[]): Promise<QueueItem[]>;
    startDownload(manualOverride?: boolean): Promise<boolean>;
    pauseDownload(): Promise<boolean>;
    cancelDownload(): Promise<boolean>;
    isDownloading(): Promise<boolean>;
    downloadClip(url: string): Promise<{ success: boolean; error?: string }>;
    selectFolder(): Promise<(FileCapabilityReference & { displayPath: string }) | null>;
    selectVideoFile(): Promise<FileCapabilityReference | null>;
    selectMultipleVideos(): Promise<FileCapabilityReference[] | null>;
    selectDroppedVideo(file: File): Promise<FileCapabilityReference | null>;
    saveVideoDialog(defaultName: string): Promise<FileCapabilityReference | null>;
    openFolder(pathOrCapability: string): Promise<void>;
    openFile(pathOrCapability: string): Promise<boolean>;
    showInFolder(pathOrCapability: string): Promise<boolean>;
    openDebugLogFile(): Promise<boolean>;
    checkFolderWritable(capability: string): Promise<boolean>;
    getStorageStats(): Promise<StorageStatsResult>;
    getArchiveStats(): Promise<ArchiveStats>;
    getStreamerProfile(login: string, forceRefresh?: boolean): Promise<StreamerProfile | null>;
    getStreamerDisplayNames(logins: string[]): Promise<Record<string, string>>;
    getVodStoryboard(vodId: string): Promise<VodStoryboard | null>;
    getLiveStatusSnapshot(): Promise<Record<string, boolean>>;
    onLiveStatusBatchUpdate(callback: (info: { changes: Array<{ login: string; isLive: boolean }> }) => void): void;
    searchArchive(filter: {
        query?: string;
        type?: 'all' | 'live' | 'vod' | 'chat' | 'events';
        streamer?: string;
        sinceMs?: number | null;
        untilMs?: number | null;
        sort?: 'date_desc' | 'date_asc' | 'size_desc' | 'size_asc' | 'name_asc';
        limit?: number;
    }): Promise<ArchiveSearchResult>;
    runStorageCleanup(options?: { dryRun?: boolean }): Promise<CleanupReport>;
    readChatFile(filePath: string, signal?: AbortSignal): Promise<{ success: boolean; error?: string; cancelled?: boolean; format?: 'replay' | 'live'; messages?: Array<Record<string, unknown>>; truncated?: boolean; total?: number }>;
    getAutomationStatus(): Promise<{
        autoRecord: { watching: number; lastRunAt: number; nextRunAt: number; lastTriggeredCount: number; inFlight: boolean };
        autoVod: { watching: number; lastRunAt: number; nextRunAt: number; lastQueuedCount: number; inFlight: boolean };
    }>;
    triggerAutoVodScan(): Promise<{ queuedCount: number }>;
    triggerAutoRecordScan(): Promise<{ triggered: number }>;
    onAutoVodScanCompleted(callback: (info: { queuedCount: number }) => void): void;
    getVideoInfo(capability: string): Promise<VideoInfo | null>;
    extractFrame(capability: string, timeSeconds: number): Promise<string | null>;
    prepareVideoEditorMedia(capability: string): Promise<VideoEditorMedia | null>;
    prepareVideoEditorWaveform(capability: string, jobId: number): Promise<VideoEditorWaveform | null>;
    prepareVideoEditorAssets(capability: string, jobId: number, profile: VideoEditorAssetProfile): Promise<VideoEditorAssets | null>;
    cancelVideoEditorAssets(jobId: number): Promise<boolean>;
    getCutterProjectRecovery(capability: string): Promise<CutterProject | null>;
    saveCutterProject(capability: string, project: Omit<CutterProject, 'source' | 'duration' | 'fps'>): Promise<boolean>;
    discardCutterProject(capability: string): Promise<boolean>;
    openCutterProject(capability: string): Promise<CutterProject | null>;
    getCutterExportOptions(): Promise<CutterExportOptions | null>;
    exportVideoEdit(request: VideoEditExportRequest): Promise<{ success: boolean; outputCapability?: string; outputName: string | null; cancelled?: boolean }>;
    cancelVideoEdit(): Promise<boolean>;
    cutVideo(inputCapability: string, startTime: number, endTime: number): Promise<{ success: boolean; outputName: string | null }>;
    mergeVideos(inputCapabilities: string[], outputCapability: string): Promise<{ success: boolean; outputName: string | null }>;
    getVersion(): Promise<string>;
    checkUpdate(): Promise<{ checking?: boolean; error?: boolean; skipped?: 'ready-to-install' | 'in-progress' | 'throttled' | 'timed-out' | 'error' | string }>;
    downloadUpdate(): Promise<{ downloading?: boolean; error?: boolean; skipped?: 'ready-to-install' | 'in-progress' | 'error' | string }>;
    installUpdate(): Promise<void>;
    openExternal(url: string): Promise<void>;
    runPreflight(autoFix: boolean): Promise<PreflightResult>;
    getManagedToolStatus(): Promise<ManagedToolStatuses | null>;
    repairManagedTools(): Promise<{ success: boolean; statuses: ManagedToolStatuses } | null>;
    resetManagedTools(): Promise<{ success: boolean; statuses: ManagedToolStatuses } | null>;
    getDebugLog(lines: number): Promise<string>;
    getRuntimeMetrics(): Promise<RuntimeMetricsSnapshot>;
    exportRuntimeMetrics(): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }>;
    resetDownloadedVodIds(): Promise<{ success: boolean; removedCount: number }>;
    markVodDownloaded(vodId: string, mark: boolean): Promise<{ success: boolean }>;
    exportConfig(): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }>;
    importConfig(): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }>;
    onDownloadProgress(callback: (progress: DownloadProgress) => void): void;
    onQueueUpdated(callback: (queue: QueueItem[]) => void): void;
    onQueueDuplicateSkipped(callback: (payload: { title: string; streamer: string; url: string }) => void): void;
    onDownloadStarted(callback: () => void): void;
    onDownloadPaused(callback: () => void): void;
    onDownloadFinished(callback: () => void): void;
    onDownloadPolicyStatus(callback: (status: DownloadPolicyStatus) => void): void;
    onCutProgress(callback: (percent: number) => void): void;
    onMergeProgress(callback: (percent: number) => void): void;
    onUpdateChecking(callback: () => void): void;
    onUpdateAvailable(callback: (info: UpdateInfo) => void): void;
    onUpdateNotAvailable(callback: () => void): void;
    onUpdateDownloadProgress(callback: (progress: UpdateDownloadProgress) => void): void;
    onUpdateDownloaded(callback: (info: UpdateInfo) => void): void;
    onUpdateError(callback: (payload: { message: string }) => void): void;
}

interface Window {
    api: ApiBridge;
}
