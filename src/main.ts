import { resolveArchiveFilePaths } from './main/domain/archive-path-access';
import { MediaDownloadProgress, aggregateDownloadProgress } from './main/domain/download-progress';
import { buildVodSourceDownloadArgs } from './main/domain/vod-source-download';
import { VodQualityService, normalizeVodQuality, resolveVodQualitySource, vodQualityStreamArg, TWITCH_VIDEO_CODEC_ARGS } from './main/domain/vod-quality';
import { createIndexedArchiveReader } from './main/domain/archive-index';
import { normalizeAutoVodRules, normalizeAutoVodRule, evaluateAutoVodRule, type AutoVodRules } from './main/domain/auto-vod-rules';
import { validAudioProcessing, type AudioProcessingOptions } from './main/domain/audio-processing';
import { VodLibraryStore, type VodLibraryChange } from './main/domain/vod-library';
import { createStorageCleanupService, type StorageCleanupPreview, type StorageCleanupResult } from './main/domain/storage-cleanup';
import { discoverClips, type ClipDiscoveryRequest } from './main/domain/clip-discovery';
import { registerEditingWorkflows } from './main/editing-workflows';
import { createApplicationBackup, inspectApplicationBackup, queueApplicationRestore, applyPendingApplicationRestore } from './main/domain/application-backup';
import { cutterVideoFormat, readVideoSourceFormat, type VideoSourceFormat, type CutterColorMode } from './main/domain/media-format';
import { createDevelopmentLiveUpdates } from './main/development-live';
import { WorkspaceSessionStore, normalizeWorkspaceClips, type WorkspaceMergeFile, type MergeFileReference, type ClipTransferProgress } from './main/domain/workspace-session';
import { createArchiveInventoryReader, searchArchiveInventory, summarizeArchiveInventory, summarizeStorageInventory, type StorageStatsResult, type ArchiveStats, type ArchiveSearchFilter, type ArchiveSearchResult } from './main/domain/archive-inventory';
import { randomUUID } from 'node:crypto';
import { createDownloadHistoryStore, downloadOutputBytes, emptyLifetimeDownloadStats, type DownloadHistoryStore } from './main/domain/download-history-store';
import { requestPublicClipInfo } from './main/twitch/clip-info';
import { parseTwitchClipId } from './main/twitch/clip-url';
import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification, type IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'node:util';
import { connect as tlsConnect, TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';
import type { Transform } from 'node:stream';
import axios from 'axios';
import { autoUpdater } from 'electron-updater';
import { parseOmissionConfig, planEditedVod } from './main/domain/vod-edit-plan';
import { cleanupEditedVod, downloadEditedVod } from './main/domain/vod-edit-download';
import { remuxMp4 } from './main/domain/mp4-remux';
import { VodPlaybackService } from './main/domain/vod-playback-service';
import { VodTimelineService } from './main/domain/vod-timeline';
import { compareUpdateVersions, createUpdateCheckCoordinator, normalizeUpdateVersion, UpdateLifecycle } from './main/updates';
import { writeFileAtomicSync } from './main/infra/fs-atomic';
import { parseDuration, formatDuration, formatDurationDashed } from './main/infra/duration';
import {
    sanitizeFilenamePart,
    sanitizeClipFilename,
    formatDateWithPattern,
    getMergeGroupPhaseText as getMergeGroupPhaseTextCore,
} from './main/infra/format-helpers';
import { tBackend as tBackendCore, type BackendMessageKey } from './main/domain/i18n-backend';
import { createPausableOutput, type PausableOutput } from './main/domain/pausable-output';
import { createTokenBucketBudget, createTokenBucketTransform } from './main/domain/token-bucket-transform';
import { decideDownloadStart, decideStandaloneDownloadStart, normalizeDownloadPolicy, type DownloadPolicy } from './main/domain/download-policy';
import { PartialDownloadRegistry } from './main/domain/partial-download';
import {
    applyQueueSnapshotPreservingActiveItems,
    commitQueueAddition,
    commitQueueMutation,
    createPhaseBoundaryProcessResource,
    createRendererQueueItem,
    getMergeGroupCleanupPaths,
    persistStateChange,
    QueueProcessRegistry,
    QueueRunLifecycle,
    recoverInterruptedMergeArtifacts,
    resolveMergeArtifactRoot,
    waitForChildProcessExit,
    waitForPhaseBoundary,
    type QueueAdditionResult,
} from './main/queue';
import {
    normalizeLogin,
    normalizeAutoRecordPollSeconds,
    normalizeAutoRecordList,
    normalizeStreamlinkQuality,
    normalizeFilenameTemplate,
    normalizeMetadataCacheMinutes,
    normalizePerformanceMode,
    isPlainObject,
    DEFAULT_METADATA_CACHE_MINUTES,
    DEFAULT_PERFORMANCE_MODE,
    type PerformanceMode,
} from './main/domain/config-normalize';
import { CustomClip, MergeGroupItem, MergeGroup, QueueItem, DownloadProgress, DownloadResult, AutomationScanResult } from './types';
import {
    buildVodPreviewFrameUrls,
    parseGraphqlUser,
    refreshTwitchProviderData,
    requestPublicTwitchGraphql,
    requestPublicTwitchVodsByLogin,
    requestTwitchAppAccessToken,
    requestTwitchHelixUsers,
    requestTwitchHelixVideos,
    TwitchAppTokenService,
    type RefreshOutcome,
    type TwitchHelixUser,
    type TwitchVod,
} from './main/twitch';
import { createWindowsTaskbarDetails, getWindowsAppIdentity, resolveWindowsAppIconPath } from './main/domain/app-identity';
import {
    addCutAt,
    calculateCutterExportProgress,
    createCutterExportPlan,
    createCutterProjectAutosaveStore,
    createVideoEditorState,
    CUTTER_EXPORT_PROFILES,
    getPlayableSegments,
    getCutterExportProfile,
    parseCutterHardwareEncoders,
    probeCutterHardwareEncoders,
    setTrimRange,
    type CutterExportEncoder,
    type CutterExportProfile,
    type CutterHardwareEncoder,
    type CutterProject,
    type CutterProjectSource,
    type EditorCut,
} from './main/cutter';
import {
    CUTTER_SESSION_CAPABILITY_TTL_MS,
    FileCapabilityStore,
    isTrustedFileIpcSender,
    publishCapabilityOutput,
    type FileCapabilityPurpose,
    type FileCapabilityReference,
} from './main/domain/file-capability';
import { registerTrustedIpcHandler } from './main/domain/privileged-ipc';
import {
    createAppStateStore,
    createElectronSecureStorage,
    createExportableConfig,
    createSecretStore,
    migrateJsonToSqlite,
    normalizeStreamerLogins,
    openDatabase,
    resolveSecretInputUpdate,
    sanitizeConfigInput,
    sanitizeImportedConfig,
    type AppStateStore,
    type DbHandle,
    type SecretStore,
} from './main/storage';
import { projectExternalError, sanitizeLogDetails } from './main/domain/external-error';
import { LastGoodCache } from './main/domain/last-good-cache';
import { readChatFile } from './main/domain/chat-reader';
import {
    canonicalQueueItemIdentity,
    applyQueueTransferState,
    clearQueueTransferState,
    getQueueCreatedAtMs,
    isValidPersistedQueueId,
    mergeQueueProgressState,
    prepareQueueRetryProgress,
} from './main/domain/queue-runtime';
import { createManagedToolExecutionTracker, readSecretSafely, runResilientSteps, secureImportedConfigTransition, type ManagedToolExecutionKind } from './main/domain/runtime-safety';
import {
    setDebugLogFn, initToolDirs,
    getStreamlinkCommand, getFFmpegPath, getFFprobePath,
    refreshBundledToolPaths, ensureStreamlinkInstalled, ensureFfmpegInstalled,
    getManagedToolStatuses, repairManagedTools, resetManagedTools,
    canExecuteCommand, cancelPendingToolChecks,
    cacheVerifiedStreamlinkCommand,
    cacheVerifiedFfmpegCommands,
    setManagedToolExecutionObserver
} from './tools';

// ==========================================
// CONFIG & CONSTANTS
// ==========================================
const APP_VERSION = app.getVersion();
let applicationBackupBusy = false;
let applicationAutomationPaused = false;
let applicationWorkflowBusy: () => boolean = () => false;
let applicationWorkflowFlush: () => Promise<void> = async () => undefined;
const IS_HOT_DEVELOPMENT = process.env.TWITCH_VOD_MANAGER_DEV === '1';
const WINDOWS_APP_IDENTITY = getWindowsAppIdentity(IS_HOT_DEVELOPMENT);
app.setName(WINDOWS_APP_IDENTITY.name);
app.setAppUserModelId(WINDOWS_APP_IDENTITY.appUserModelId);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});
const WINDOWS_APP_ICON_PATH = process.platform === 'win32'
    ? resolveWindowsAppIconPath({
        isPackaged: app.isPackaged && !IS_HOT_DEVELOPMENT,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        version: APP_VERSION,
    })
    : null;
const GITHUB_REPO_OWNER = 'Sucukdeluxe';
const GITHUB_REPO_NAME = 'Twitch-VOD-Manager';
const GITHUB_RELEASES_API_LATEST_URL = 'https://api.github.com/repos/Sucukdeluxe/Twitch-VOD-Manager/releases/latest';
const GITHUB_RELEASES_DOWNLOAD_BASE_URL = 'https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download';

// Paths
const APPDATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Twitch_VOD_Manager');
const DEBUG_LOG_FILE = path.join(APPDATA_DIR, 'debug.log');
const PARTIAL_DOWNLOADS_FILE = path.join(APPDATA_DIR, 'partial-downloads.json');
const CUTTER_PROJECT_AUTOSAVE_FILE = path.join(APPDATA_DIR, 'cutter-projects.json');
const TOOLS_DIR = path.join(APPDATA_DIR, 'tools');
const TOOLS_STREAMLINK_DIR = path.join(TOOLS_DIR, 'streamlink');
const TOOLS_FFMPEG_DIR = path.join(TOOLS_DIR, 'ffmpeg');
const DEFAULT_DOWNLOAD_PATH = path.join(app.getPath('desktop'), 'Twitch_VODs');
const DEFAULT_FILENAME_TEMPLATE_VOD = '{title}.mp4';
const DEFAULT_FILENAME_TEMPLATE_PARTS = '{date}_Part{part_padded}.mp4';
const DEFAULT_FILENAME_TEMPLATE_CLIP = '{date}_{part}.mp4';
// DEFAULT_METADATA_CACHE_MINUTES + DEFAULT_PERFORMANCE_MODE kommen aus
// ./main/domain/config-normalize (Single-Source-Of-Truth, vermeidet
// Drift wenn man eine der Defaults aendert).
const STARTUP_TOOLS_PROVISION_DELAY_MS = 15 * 1000;
const MIN_FREE_DISK_BYTES = 128 * 1024 * 1024;
const DEBUG_LOG_FLUSH_INTERVAL_MS = 1000;
const DEBUG_LOG_BUFFER_FLUSH_LINES = 48;
const DEBUG_LOG_READ_TAIL_BYTES = 512 * 1024;
const DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;
const DEBUG_LOG_TRIM_TO_BYTES = 4 * 1024 * 1024;
const AUTO_UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_UPDATE_STARTUP_CHECK_DELAY_MS = 5000;
const AUTO_UPDATE_MIN_CHECK_GAP_MS = 45 * 1000;
const AUTO_UPDATE_AUTO_DOWNLOAD = false;
const AUTO_UPDATE_CHECK_TIMEOUT_MS = 30 * 1000;
const CACHE_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_LOGIN_TO_USER_ID_CACHE_ENTRIES = 4096;
const MAX_VOD_LIST_CACHE_ENTRIES = 512;
const MAX_CLIP_INFO_CACHE_ENTRIES = 4096;
const MAX_CONFIG_IMPORT_BYTES = 1024 * 1024;

// Timeouts
const API_TIMEOUT = 10000;
const DEFAULT_RETRY_DELAY_SECONDS = 5;
const MIN_FILE_BYTES = 256 * 1024;
const managedToolExecutionTracker = createManagedToolExecutionTracker(Boolean(process.env.TWITCH_VOD_MANAGER_E2E_CUTTER_OUTPUT_ROOT));

function managedToolKindFromCommand(command: string): ManagedToolExecutionKind | null {
    const executable = path.basename(command).toLowerCase();
    if (executable.startsWith('ffmpeg')) return 'ffmpeg';
    if (executable.startsWith('ffprobe')) return 'ffprobe';
    if (executable.startsWith('streamlink')) return 'streamlink';
    return null;
}

function recordManagedToolExecution(kind: ManagedToolExecutionKind, command: string): void {
    managedToolExecutionTracker.record(kind, command);
}

setManagedToolExecutionObserver((command) => {
    const kind = managedToolKindFromCommand(command);
    if (kind) recordManagedToolExecution(kind, command);
});

type RetryErrorClass = 'network' | 'rate_limit' | 'auth' | 'tooling' | 'integrity' | 'io' | 'validation' | 'unknown';
type UpdateCheckSource = 'startup' | 'interval' | 'manual';
type UpdateDownloadSource = 'auto' | 'manual';

function getMergeGroupPhaseText(phase: string): string {
    return getMergeGroupPhaseTextCore(phase, config?.language ?? 'de');
}

// ==========================================
// BACKEND I18N
// ==========================================
// Backend-Messages sind in src/main/domain/i18n-backend.ts.
// tBackend bleibt als 2-Arg-Adapter hier — pure Variante uebernimmt language
// als 3. Parameter, der hier aus config.language injected wird.
function tBackend(key: BackendMessageKey, params?: Record<string, string | number>): string {
    return tBackendCore(key, params, config?.language ?? 'de');
}

// Ensure directories exist
if (!fs.existsSync(APPDATA_DIR)) {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
}
const partialDownloadRegistry = new PartialDownloadRegistry(PARTIAL_DOWNLOADS_FILE);
const vodLibrary = new VodLibraryStore(path.join(APPDATA_DIR, 'vod-library.json'));
const cutterProjectAutosaves = createCutterProjectAutosaveStore(CUTTER_PROJECT_AUTOSAVE_FILE);

// ==========================================
// INTERFACES
// ==========================================
interface Config {
    client_id: string;
    download_path: string;
    streamers: string[];
    streamer_display_names: Record<string, string>;
    theme: string;
    download_mode: 'parts' | 'full';
    part_minutes: number;
    language: 'de' | 'en';
    sidebar_split_view: boolean;
    filename_template_vod: string;
    filename_template_parts: string;
    filename_template_clip: string;
    smart_queue_scheduler: boolean;
    performance_mode: PerformanceMode;
    prevent_duplicate_downloads: boolean;
    persist_queue_on_restart: boolean;
    metadata_cache_minutes: number;
    parallel_downloads: number;
    auto_resume_queue_on_startup: boolean;
    downloaded_vod_ids: string[];
    streamlink_quality: string;
    notify_on_each_completion: boolean;
    streamlink_disable_ads: boolean;
    download_policy: DownloadPolicy;
    auto_record_streamers: string[];
    auto_record_poll_seconds: number;
    download_chat_replay: boolean;
    capture_live_chat: boolean;
    discord_notify_live_start: boolean;
    discord_notify_live_end: boolean;
    discord_notify_vod_complete: boolean;
    discord_notify_vod_auto_queued: boolean;
    auto_cleanup_enabled: boolean;
    auto_cleanup_days: number;
    auto_cleanup_target: 'live_only' | 'all';
    auto_cleanup_action: 'delete' | 'archive';
    log_stream_events: boolean;
    auto_vod_download_streamers: string[];
    auto_vod_rules: AutoVodRules;
    auto_vod_download_poll_minutes: number;
    auto_vod_max_age_hours: number;
    auto_resume_live_recording: boolean;
    auto_merge_resumed_parts: boolean;
    delete_parts_after_merge: boolean;
}

interface DownloadPolicyStatus {
    waiting: boolean;
    reason: 'outside-window' | null;
    nextStart: string | null;
}

interface RuntimeMetrics {
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
    lastErrorClass: RetryErrorClass | null;
    lastRetryDelaySeconds: number;
}

interface RuntimeMetricsSnapshot extends RuntimeMetrics {
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
        performanceMode: PerformanceMode;
        smartScheduler: boolean;
        metadataCacheMinutes: number;
        duplicatePrevention: boolean;
    };
}

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

type VOD = TwitchVod;

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

interface VideoInfo {
    sourceFormat: VideoSourceFormat;
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
    colorMode?: CutterColorMode;
    audioProcessing?: AudioProcessingOptions;
    inputFile: string;
    outputFile: string;
    trimStart: number;
    trimEnd: number;
    cuts: EditorCut[];
    profile: CutterExportProfile;
    encoder: CutterExportEncoder;
    audioStreamIndex: number;
}

interface RendererVideoEditExportRequest {
    allAudioStreams?: boolean;
    colorMode?: CutterColorMode;
    audioProcessing?: AudioProcessingOptions;
    inputCapability: string;
    outputName?: string;
    trimStart: number;
    trimEnd: number;
    cuts: EditorCut[];
    profile?: CutterExportProfile;
    encoder?: CutterExportEncoder;
    audioStreamIndex?: number;
}

interface ReleaseUpdateInfo {
    tagName?: string;
    version?: string;
    releaseDate?: string;
    releaseName?: string;
    releaseNotes?: string;
}

// ==========================================
// CONFIG MANAGEMENT
// ==========================================
const defaultConfig: Config = {
    client_id: '',
    download_path: DEFAULT_DOWNLOAD_PATH,
    streamers: [],
    streamer_display_names: {},
    theme: 'twitch',
    download_mode: 'full',
    part_minutes: 120,
    language: 'en',
    sidebar_split_view: true,
    filename_template_vod: DEFAULT_FILENAME_TEMPLATE_VOD,
    filename_template_parts: DEFAULT_FILENAME_TEMPLATE_PARTS,
    filename_template_clip: DEFAULT_FILENAME_TEMPLATE_CLIP,
    smart_queue_scheduler: false,
    performance_mode: DEFAULT_PERFORMANCE_MODE,
    prevent_duplicate_downloads: true,
    persist_queue_on_restart: true,
    metadata_cache_minutes: DEFAULT_METADATA_CACHE_MINUTES,
    parallel_downloads: 1,
    auto_resume_queue_on_startup: false,
    downloaded_vod_ids: [],
    streamlink_quality: 'source',
    notify_on_each_completion: false,
    streamlink_disable_ads: true,
    download_policy: { throttle: null, windows: [] },
    auto_record_streamers: [],
    auto_record_poll_seconds: 90,
    download_chat_replay: false,
    capture_live_chat: false,
    discord_notify_live_start: false,
    discord_notify_live_end: false,
    discord_notify_vod_complete: false,
    discord_notify_vod_auto_queued: false,
    auto_cleanup_enabled: false,
    auto_cleanup_days: 30,
    auto_cleanup_target: 'live_only',
    auto_cleanup_action: 'archive',
    log_stream_events: true,
    auto_vod_download_streamers: [],
    auto_vod_rules: {},
    auto_vod_download_poll_minutes: 15,
    auto_vod_max_age_hours: 24,
    auto_resume_live_recording: true,
    auto_merge_resumed_parts: false,
    delete_parts_after_merge: false
};

function getStreamlinkStreamArg(quality?: string): string {
    return vodQualityStreamArg(quality);
}

function createDownloadThrottleTransform(): Transform | undefined {
    const maxBytesPerSecond = config.download_policy.throttle?.maxBytesPerSecond ?? null;
    downloadThrottleBudget.setMaxBytesPerSecond(maxBytesPerSecond);
    return maxBytesPerSecond ? createTokenBucketTransform(maxBytesPerSecond, undefined, downloadThrottleBudget) : undefined;
}

function normalizeConfigTemplates(input: Config): Config {
    // downloaded_vod_ids is bounded so a long-running app doesn't accumulate
    // an unbounded list across years of downloads. Latest entries kept.
    const DOWNLOADED_IDS_MAX = 4096;
    const rawIds = Array.isArray(input.downloaded_vod_ids) ? input.downloaded_vod_ids : [];
    const cleanIds = rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    const trimmedIds = cleanIds.length > DOWNLOADED_IDS_MAX
        ? cleanIds.slice(cleanIds.length - DOWNLOADED_IDS_MAX)
        : cleanIds;
    const displayNames: Record<string, string> = {};
    if (isPlainObject(input.streamer_display_names)) {
        for (const [login, displayName] of Object.entries(input.streamer_display_names)) {
            const normalizedLogin = normalizeLogin(login);
            const normalizedDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
            if (normalizedLogin && normalizedDisplayName) displayNames[normalizedLogin] = normalizedDisplayName;
        }
    }

    return {
        ...input,
        streamers: normalizeStreamerLogins(input.streamers) ?? [],
        streamer_display_names: displayNames,
        filename_template_vod: normalizeFilenameTemplate(input.filename_template_vod, DEFAULT_FILENAME_TEMPLATE_VOD),
        filename_template_parts: normalizeFilenameTemplate(input.filename_template_parts, DEFAULT_FILENAME_TEMPLATE_PARTS),
        filename_template_clip: normalizeFilenameTemplate(input.filename_template_clip, DEFAULT_FILENAME_TEMPLATE_CLIP),
        sidebar_split_view: input.sidebar_split_view !== false,
        smart_queue_scheduler: false,
        performance_mode: normalizePerformanceMode(input.performance_mode),
        prevent_duplicate_downloads: input.prevent_duplicate_downloads !== false,
        persist_queue_on_restart: input.persist_queue_on_restart !== false,
        metadata_cache_minutes: normalizeMetadataCacheMinutes(input.metadata_cache_minutes),
        auto_resume_queue_on_startup: input.auto_resume_queue_on_startup === true,
        downloaded_vod_ids: trimmedIds,
        streamlink_quality: normalizeStreamlinkQuality(input.streamlink_quality),
        notify_on_each_completion: input.notify_on_each_completion === true,
        // Default-true on first launch (most users hit this), but respect
        // an explicit `false` from the loaded config.
        streamlink_disable_ads: input.streamlink_disable_ads !== false,
        download_policy: normalizeDownloadPolicy(input.download_policy),
        auto_record_streamers: normalizeAutoRecordList(input.auto_record_streamers),
        auto_record_poll_seconds: normalizeAutoRecordPollSeconds(input.auto_record_poll_seconds),
        download_chat_replay: input.download_chat_replay === true,
        capture_live_chat: input.capture_live_chat === true,
        discord_notify_live_start: input.discord_notify_live_start === true,
        discord_notify_live_end: input.discord_notify_live_end === true,
        discord_notify_vod_complete: input.discord_notify_vod_complete === true,
        discord_notify_vod_auto_queued: input.discord_notify_vod_auto_queued === true,
        auto_cleanup_enabled: input.auto_cleanup_enabled === true,
        auto_cleanup_days: (() => {
            const n = Number(input.auto_cleanup_days);
            if (!Number.isFinite(n) || n < 1) return 30;
            return Math.min(3650, Math.floor(n));
        })(),
        auto_cleanup_target: input.auto_cleanup_target === 'all' ? 'all' : 'live_only',
        auto_cleanup_action: input.auto_cleanup_action === 'delete' ? 'delete' : 'archive',
        log_stream_events: input.log_stream_events !== false,
        auto_vod_download_streamers: normalizeAutoRecordList(input.auto_vod_download_streamers),
        auto_vod_rules: normalizeAutoVodRules(input.auto_vod_rules),
        auto_vod_download_poll_minutes: (() => {
            const n = Number(input.auto_vod_download_poll_minutes);
            if (!Number.isFinite(n)) return 15;
            return Math.max(5, Math.min(360, Math.floor(n)));
        })(),
        auto_vod_max_age_hours: (() => {
            const n = Number(input.auto_vod_max_age_hours);
            if (!Number.isFinite(n)) return 24;
            return Math.max(1, Math.min(720, Math.floor(n)));
        })(),
        auto_resume_live_recording: input.auto_resume_live_recording !== false,
        auto_merge_resumed_parts: input.auto_merge_resumed_parts === true,
        delete_parts_after_merge: input.delete_parts_after_merge === true
    };
}

function recordDownloadedVodId(vodId: string): void {
    readArchiveInventory.invalidate();
    if (!vodId) return;
    const downloadedVodIds = Array.isArray(config.downloaded_vod_ids) ? config.downloaded_vod_ids : [];
    if (downloadedVodIds.includes(vodId)) return;
    const DOWNLOADED_IDS_MAX = 4096;
    const nextDownloadedVodIds = [...downloadedVodIds, vodId].slice(-DOWNLOADED_IDS_MAX);
    config = persistStateChange(config, (current) => ({ ...current, downloaded_vod_ids: nextDownloadedVodIds }), saveConfig);
}

function cloneConfig(value: Config): Config {
    return JSON.parse(JSON.stringify(value)) as Config;
}

function loadConfig(): Config {
    try {
        const persisted = appStateStore?.loadConfig();
        if (persisted && isPlainObject(persisted)) {
            return normalizeConfigTemplates({ ...defaultConfig, ...persisted } as Config);
        }
    } catch (e) {
        console.error('Error loading config:', e);
    }
    return normalizeConfigTemplates(defaultConfig);
}

function saveConfig(nextConfig: Config): void {
    if (!appStateStore) throw new Error('Application state store is unavailable');
    try {
        appStateStore.saveConfig(nextConfig);
        lastPersistedConfig = cloneConfig(nextConfig);
    } catch (error) {
        if (nextConfig === config) config = cloneConfig(lastPersistedConfig);
        throw error;
    }
}

// ==========================================
// QUEUE MANAGEMENT
// ==========================================
const VALID_QUEUE_STATUSES: ReadonlyArray<QueueItem['status']> = ['pending', 'downloading', 'paused', 'completed', 'error'];
const VALID_MERGE_PHASES: ReadonlyArray<MergeGroup['mergePhase']> = ['downloading', 'merging', 'splitting', 'cleanup', 'done'];

function isValidQueueStatus(status: unknown): status is QueueItem['status'] {
    return typeof status === 'string' && (VALID_QUEUE_STATUSES as readonly string[]).includes(status);
}

function sanitizeMergeGroup(raw: unknown): MergeGroup | undefined {
    if (!isPlainObject(raw)) return undefined;
    if (!Array.isArray(raw.items) || raw.items.length < 2) return undefined;

    const items: MergeGroupItem[] = [];
    for (const mi of raw.items) {
        if (!isPlainObject(mi)) continue;
        if (typeof mi.url !== 'string' || typeof mi.title !== 'string'
            || typeof mi.date !== 'string' || typeof mi.streamer !== 'string'
            || typeof mi.duration_str !== 'string') continue;
        items.push({ url: mi.url, title: mi.title, date: mi.date, streamer: mi.streamer, duration_str: mi.duration_str, quality: normalizeVodQuality(mi.quality) || undefined, qualityLabel: typeof mi.qualityLabel === 'string' && mi.qualityLabel.length <= 200 ? mi.qualityLabel : undefined });
    }
    if (items.length < 2) return undefined;

    const phase: MergeGroup['mergePhase'] = (VALID_MERGE_PHASES as readonly string[]).includes(String(raw.mergePhase))
        ? raw.mergePhase as MergeGroup['mergePhase']
        : 'downloading';

    const downloadedFiles: Record<number, string> = {};
    if (isPlainObject(raw.downloadedFiles)) {
        for (const [k, v] of Object.entries(raw.downloadedFiles)) {
            const idx = Number(k);
            if (Number.isFinite(idx) && typeof v === 'string') downloadedFiles[idx] = v;
        }
    }

    return {
        items,
        mergePhase: phase,
        currentItemIndex: typeof raw.currentItemIndex === 'number' && Number.isFinite(raw.currentItemIndex) ? raw.currentItemIndex : 0,
        downloadedFiles,
        mergedFile: typeof raw.mergedFile === 'string' ? raw.mergedFile : undefined,
        splitFiles: Array.isArray(raw.splitFiles) ? raw.splitFiles.filter((f): f is string => typeof f === 'string') : undefined,
        splitTempFiles: Array.isArray(raw.splitTempFiles) ? raw.splitTempFiles.filter((f): f is string => typeof f === 'string') : undefined,
        totalDurationSec: typeof raw.totalDurationSec === 'number' && Number.isFinite(raw.totalDurationSec) ? raw.totalDurationSec : undefined
    };
}

function sanitizeCustomClip(raw: unknown): CustomClip | undefined {
    if (!isPlainObject(raw)) return undefined;
    const startSec = Number(raw.startSec);
    const durationSec = Number(raw.durationSec);
    const startPart = Number(raw.startPart);
    if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(startPart)) return undefined;

    const filenameFormat = raw.filenameFormat;
    if (filenameFormat !== 'simple' && filenameFormat !== 'timestamp' && filenameFormat !== 'template' && filenameFormat !== 'parts') return undefined;

    const omissions = raw.omissions === undefined ? undefined : parseOmissionConfig(raw.omissions, durationSec);
    if (raw.omissions !== undefined && (!omissions || startSec !== 0 || !Number.isInteger(startPart) || startPart < 1 || startPart > 100000)) return undefined;

    return {
        startSec: Math.max(0, startSec),
        durationSec: Math.max(1, durationSec),
        startPart: Math.max(1, Math.floor(startPart)),
        filenameFormat,
        filenameTemplate: typeof raw.filenameTemplate === 'string' ? raw.filenameTemplate : undefined,
        ...(omissions ? { omissions } : {})
    };
}

function sanitizeQueueItem(raw: unknown): QueueItem | null {
    if (!isPlainObject(raw)) return null;
    if (typeof raw.url !== 'string' || !raw.url) return null;
    if (!isValidQueueStatus(raw.status)) return null;

    // 'downloading' on cold start is stale — no download is actually running
    // and the user expects to resume from start, so map it back to 'pending'
    const isStaleDownloading = raw.status === 'downloading';
    const finalStatus: QueueItem['status'] = isStaleDownloading ? 'pending' : raw.status;

    const progressNum = Number(raw.progress);
    const safeProgress = Number.isFinite(progressNum) ? Math.max(0, Math.min(100, progressNum)) : 0;

    const id = isValidPersistedQueueId(raw.id) ? raw.id : generateQueueItemId();
    const createdAtMs = getQueueCreatedAtMs({
        id,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    }, Date.now());
    const item: QueueItem = {
        id,
        createdAt: new Date(createdAtMs).toISOString(),
        url: raw.url,
        quality: normalizeVodQuality(raw.quality) || undefined,
        qualityLabel: typeof raw.qualityLabel === 'string' && raw.qualityLabel.length <= 200 ? raw.qualityLabel : undefined,
        title: typeof raw.title === 'string' ? raw.title : '',
        date: typeof raw.date === 'string' ? raw.date : '',
        streamer: typeof raw.streamer === 'string' ? raw.streamer : '',
        duration_str: typeof raw.duration_str === 'string' ? raw.duration_str : '0s',
        status: finalStatus,
        progress: isStaleDownloading ? 0 : safeProgress
    };

    if (typeof raw.currentPart === 'number' && Number.isFinite(raw.currentPart)) item.currentPart = raw.currentPart;
    if (typeof raw.totalParts === 'number' && Number.isFinite(raw.totalParts)) item.totalParts = raw.totalParts;
    if (finalStatus === 'downloading' || finalStatus === 'paused') {
        if (typeof raw.speed === 'string') item.speed = raw.speed;
        if (typeof raw.eta === 'string') item.eta = raw.eta;
        if (typeof raw.progressStatus === 'string') item.progressStatus = raw.progressStatus;
        if (raw.progressPhase === 'downloading' || raw.progressPhase === 'finalizing') item.progressPhase = raw.progressPhase;
        if (raw.recordingHealth === 'ok' || raw.recordingHealth === 'stale' || raw.recordingHealth === 'unknown') {
            item.recordingHealth = raw.recordingHealth;
        }
    }
    if (typeof raw.last_error === 'string') item.last_error = raw.last_error;
    if (typeof raw.completedAt === 'string' && Number.isFinite(Date.parse(raw.completedAt))) item.completedAt = new Date(raw.completedAt).toISOString();
    if (raw.completionRecorded === true) item.completionRecorded = true;
    if (typeof raw.outputBytes === 'number' && Number.isSafeInteger(raw.outputBytes) && raw.outputBytes >= 0) item.outputBytes = raw.outputBytes;
    if (finalStatus === 'paused') {
        if (typeof raw.downloadedBytes === 'number' && Number.isFinite(raw.downloadedBytes)) item.downloadedBytes = raw.downloadedBytes;
        if (typeof raw.totalBytes === 'number' && Number.isFinite(raw.totalBytes)) item.totalBytes = raw.totalBytes;
    }

    if (Array.isArray(raw.outputFiles)) {
        const files = raw.outputFiles.filter((f): f is string => typeof f === 'string' && f.length > 0);
        if (files.length > 0) item.outputFiles = files;
    }

    if (raw.isLive === true) {
        item.isLive = true;
    }

    const customClip = sanitizeCustomClip(raw.customClip);
    if (isPlainObject(raw.customClip) && raw.customClip.omissions !== undefined && !customClip) return null;
    if (customClip) item.customClip = customClip;

    const mergeGroup = sanitizeMergeGroup(raw.mergeGroup);
    if (mergeGroup) item.mergeGroup = mergeGroup;
    if (raw.mergeRecoveryBlocked === true) item.mergeRecoveryBlocked = true;
    if (typeof raw.artifactRoot === 'string' && path.isAbsolute(raw.artifactRoot)) item.artifactRoot = path.resolve(raw.artifactRoot);

    return item;
}

interface QueueLoadResult {
    queue: QueueItem[];
    interruptedMergeItemIds: Set<string>;
}

function loadQueue(restored = false): QueueLoadResult {
    if (config.persist_queue_on_restart === false && !restored) {
        return { queue: [], interruptedMergeItemIds: new Set() };
    }

    try {
        const parsed = appStateStore?.loadQueue<Record<string, unknown>>() ?? [];
        const interruptedMergeItemIds = new Set<string>();
        const items: QueueItem[] = [];
        const loadedIds = new Set<string>();
        let droppedCount = 0;
        for (const raw of parsed) {
            const wasInterruptedMerge = isPlainObject(raw) && raw.status === 'downloading' && isPlainObject(raw.mergeGroup);
            const sanitized = sanitizeQueueItem(raw);
            if (sanitized) {
                if (loadedIds.has(sanitized.id)) {
                    do {
                        sanitized.id = generateQueueItemId();
                    } while (loadedIds.has(sanitized.id));
                    sanitized.createdAt = new Date().toISOString();
                }
                loadedIds.add(sanitized.id);
                if (wasInterruptedMerge) interruptedMergeItemIds.add(sanitized.id);
                items.push(sanitized);
            }
            else droppedCount++;
        }
        if (droppedCount > 0) {
            console.error(`loadQueue: dropped ${droppedCount} invalid queue item(s)`);
        }
        return { queue: items, interruptedMergeItemIds };
    } catch (e) {
        console.error('Error loading queue:', e);
    }
    return { queue: [], interruptedMergeItemIds: new Set() };
}

let queueSaveTimer: NodeJS.Timeout | null = null;
let pendingQueueSnapshot: QueueItem[] | null = null;

function cloneQueue(queue: QueueItem[]): QueueItem[] {
    return JSON.parse(JSON.stringify(queue)) as QueueItem[];
}

function clearQueueFileFromDisk(): void {
    if (!appStateStore) throw new Error('Application state store is unavailable');
    appStateStore.saveQueue([]);
    lastPersistedQueueSnapshot = [];
}

function writeQueueToDisk(queue: QueueItem[]): void {
    if (config.persist_queue_on_restart === false) {
        for (const item of queue) downloadHistoryStore?.recordQueueItem(item);
        clearQueueFileFromDisk();
        return;
    }

    if (!appStateStore) throw new Error('Application state store is unavailable');
    appStateStore.saveQueue(queue);
    lastPersistedQueueSnapshot = cloneQueue(queue);
}

function saveQueue(queue: QueueItem[], force = false): void {
    const snapshot = cloneQueue(queue);
    pendingQueueSnapshot = snapshot;

    if (appShutdownStarted && !force) {
        if (queueSaveTimer) {
            clearTimeout(queueSaveTimer);
            queueSaveTimer = null;
        }
        return;
    }

    if (queueSaveTimer) {
        clearTimeout(queueSaveTimer);
        queueSaveTimer = null;
    }

    try {
        writeQueueToDisk(snapshot);
        pendingQueueSnapshot = null;
    } catch (error) {
        pendingQueueSnapshot = null;
        if (queue === downloadQueue) downloadQueue = cloneQueue(lastPersistedQueueSnapshot);
        throw error;
    }
}

function flushQueueSave(): void {
    if (pendingQueueSnapshot) {
        saveQueue(pendingQueueSnapshot, true);
    } else {
        saveQueue(downloadQueue, true);
    }
}

// ==========================================
// GLOBAL STATE
// ==========================================
let mainWindow: BrowserWindow | null = null;
let appStateStore: AppStateStore | null = null;
let downloadHistoryStore: DownloadHistoryStore | null = null;
let appSecretStore: SecretStore | null = null;
let config = normalizeConfigTemplates(defaultConfig);
let lastPersistedConfig = cloneConfig(config);
let twitchClientSecret = '';
let discordWebhookUrl = '';
const twitchAppTokenService = new TwitchAppTokenService(
    (credentials) => requestTwitchAppAccessToken(axios, credentials, API_TIMEOUT),
    (error) => console.error('Login error:', error),
);
let downloadQueue: QueueItem[] = [];
let lastPersistedQueueSnapshot: QueueItem[] = [];
let queueIdCounter = 0;
let lastQueueBroadcastFingerprint = '';
let isDownloading = false;
let queuePaused = false;
const currentEditorProcesses = new Set<ChildProcess>();
let currentCutterProcess: ChildProcess | null = null;
let currentCutterPartialFile: string | null = null;
let cutterExportActive = false;
let cutterExportCancelled = false;
let cutterHardwareEncoderProbe: Promise<CutterHardwareEncoder[]> | null = null;
let cutterPreparedInput: { path: string; size: number; mtimeMs: number; dev: number; ino: number } | null = null;
let cutterMediaGeneration = 0;
let cutterMediaRequestGeneration = 0;
let cutterAssetRunGeneration = 0;
let cutterWaveformGeneration = 0;
let cutterMediaJob: {
    jobId: number;
    path: string;
    identity: { path: string; size: number; mtimeMs: number; dev: number; ino: number };
    info: VideoInfo;
    waveform: VideoEditorWaveform | null;
    waveformPromise: Promise<VideoEditorWaveform | null> | null;
    previewDirectory: string | null;
} | null = null;
let appShutdownStarted = false;
const currentCutterMediaProcesses = new Set<ChildProcess>();
const currentCutterWaveformProcesses = new Set<ChildProcess>();
const currentCutterProbeProcesses = new Set<ChildProcess>();
const currentCutterInfoProcesses = new Set<ChildProcess>();
const currentCutterExportProcesses = new Set<ChildProcess>();
const currentCutterPreviewProcesses = new Set<ChildProcess>();
const vodPlaybackService = new VodPlaybackService();
const clipPlaybackService = new VodPlaybackService();
const vodTimelineService = new VodTimelineService();
const currentCutterFrameProcesses = new Set<ChildProcess>();
const currentCutterFrameFiles = new Set<string>();
// Per-item cancellation lives in `cancelledItemIds`. The previous global
// `currentDownloadCancelled` flag was redundant once pause/cancel/remove
// started iterating activeDownloads and adding each item to that Set; it
// was removed in the 4.5.27 cleanup.
let activeQueueItemId: string | null = null;
let downloadedBytes = 0;
// Per-item tracking for parallel downloads
interface ActiveDownloadTracking {
    process: ChildProcess | null;
    cancelled: boolean;
    startTime: number;
    bytes: number;
    output: PausableOutput;
    partialFilename: string;
}
const activeDownloads = new Map<string, ActiveDownloadTracking>();
const cancelledItemIds = new Set<string>();
const queueProcessRegistry = new QueueProcessRegistry();
const queueRunLifecycle = new QueueRunLifecycle(queueProcessRegistry);
const downloadThrottleBudget = createTokenBucketBudget(null);
let downloadPolicyWakeTimer: NodeJS.Timeout | null = null;
let lastDownloadPolicyStatusFingerprint = '';

function registerQueuePartialFile(itemId: string, filePath: string): void {
    queueProcessRegistry.register(itemId, 'post-processing', {
        cleanup: () => { try { fs.rmSync(filePath, { force: true }); } catch { } },
    });
}

async function waitForQueuePhaseBoundary(itemId: string | null): Promise<boolean> {
    return await waitForPhaseBoundary(itemId, queueProcessRegistry, {
        onPaused: () => {
            if (!itemId) return;
            const item = downloadQueue.find((candidate) => candidate.id === itemId);
            if (!item) return;
            item.status = 'paused';
            item.speed = '';
            item.eta = '';
            item.progressStatus = tBackend('downloadPaused');
            saveQueue(downloadQueue);
            emitQueueUpdated(true);
        },
        onResumed: () => {
            if (!itemId) return;
            const item = downloadQueue.find((candidate) => candidate.id === itemId);
            if (!item) return;
            item.status = 'downloading';
            delete item.speed;
            delete item.eta;
            delete item.progressStatus;
            saveQueue(downloadQueue);
            emitQueueUpdated(true);
        },
    });
}
// userId -> login reverse map. Bounded via Map insertion-order eviction so
// a long-running session doesn't grow it unbounded across thousands of
// streamer lookups. Values are short (~20 char each) but accumulate.
const USER_ID_LOGIN_CACHE_MAX = 4096;
const userIdLoginCache = new Map<string, string>();
function setUserIdLogin(userId: string, login: string): void {
    if (!userId || !login) return;
    if (userIdLoginCache.has(userId)) {
        userIdLoginCache.delete(userId);
    }
    userIdLoginCache.set(userId, login);
    while (userIdLoginCache.size > USER_ID_LOGIN_CACHE_MAX) {
        const oldest = userIdLoginCache.keys().next().value as string | undefined;
        if (!oldest) break;
        userIdLoginCache.delete(oldest);
    }
}
const loginToUserIdCache = new Map<string, CacheEntry<string>>();
const vodListCache = new Map<string, CacheEntry<VOD[]>>();
const vodListLastGood = new LastGoodCache<VOD[]>(MAX_VOD_LIST_CACHE_ENTRIES);
const clipInfoCache = new Map<string, CacheEntry<any>>();
const inFlightUserIdRequests = new Map<string, Promise<string | null>>();
const inFlightVodRequests = new Map<string, Promise<VOD[]>>();
const inFlightClipRequests = new Map<string, Promise<any | null>>();
let cacheCleanupTimer: NodeJS.Timeout | null = null;
const runtimeMetrics: RuntimeMetrics = {
    cacheHits: 0,
    cacheMisses: 0,
    duplicateSkips: 0,
    retriesScheduled: 0,
    retriesExhausted: 0,
    integrityFailures: 0,
    downloadsStarted: 0,
    downloadsCompleted: 0,
    downloadsFailed: 0,
    downloadedBytesTotal: 0,
    lastSpeedBytesPerSec: 0,
    avgSpeedBytesPerSec: 0,
    activeItemId: null,
    activeItemTitle: null,
    lastErrorClass: null,
    lastRetryDelaySeconds: 0
};
let debugLogFlushTimer: NodeJS.Timeout | null = null;
let pendingDebugLogLines: string[] = [];
let autoUpdaterInitialized = false;
let autoUpdateCheckTimer: NodeJS.Timeout | null = null;
let autoUpdateStartupTimer: NodeJS.Timeout | null = null;
let autoUpdaterSetupTimer: NodeJS.Timeout | null = null;
const autoUpdateCheckCoordinator = createUpdateCheckCoordinator();
const autoUpdateLifecycle = new UpdateLifecycle();
let lastAutoUpdateCheckAt = 0;
let latestKnownUpdateVersion: string | null = null;
let latestReleaseUpdateInfo: ReleaseUpdateInfo | null = null;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDownloadPathWritable(targetPath: string): boolean {
    try {
        fs.mkdirSync(targetPath, { recursive: true });
        const probeFile = path.join(targetPath, `.write_test_${Date.now()}.tmp`);
        fs.writeFileSync(probeFile, 'ok');
        fs.unlinkSync(probeFile);
        return true;
    } catch {
        return false;
    }
}

async function hasInternetConnection(): Promise<boolean> {
    try {
        const res = await axios.get('https://id.twitch.tv/oauth2/validate', {
            timeout: 5000,
            validateStatus: () => true
        });
        return res.status > 0;
    } catch {
        return false;
    }
}

async function runPreflight(autoFix = false): Promise<PreflightResult> {
    appendDebugLog('preflight-start', { autoFix });

    refreshBundledToolPaths();
    const internetCheck = hasInternetConnection();

    const checks: PreflightChecks = {
        internet: false,
        streamlink: false,
        ffmpeg: false,
        ffprobe: false,
        downloadPathWritable: isDownloadPathWritable(config.download_path)
    };

    if (autoFix) {
        await ensureStreamlinkInstalled();
        await ensureFfmpegInstalled();
        refreshBundledToolPaths(true);
    }

    const ffmpegPath = await getFFmpegPath();
    const ffprobePath = await getFFprobePath();
    const streamlinkCheck = getStreamlinkCommand().then(async command => {
        const args = [...command.prefixArgs, '--version'];
        const runnable = await canExecuteCommand(command.command, args);
        if (runnable) cacheVerifiedStreamlinkCommand(command.command, args);
        return runnable;
    });
    [checks.internet, checks.streamlink, checks.ffmpeg, checks.ffprobe] = await Promise.all([
        internetCheck, streamlinkCheck,
        canExecuteCommand(ffmpegPath, ['-version']), canExecuteCommand(ffprobePath, ['-version']),
    ]);
    if (checks.ffmpeg && checks.ffprobe) cacheVerifiedFfmpegCommands(ffmpegPath, ffprobePath);

    const messages: string[] = [];
    if (!checks.internet) messages.push(tBackend('preflightNoInternet'));
    if (!checks.streamlink) messages.push(tBackend('preflightStreamlinkMissing'));
    if (!checks.ffmpeg) messages.push(tBackend('preflightFfmpegMissing'));
    if (!checks.ffprobe) messages.push(tBackend('preflightFfprobeMissing'));
    if (!checks.downloadPathWritable) messages.push(tBackend('preflightDownloadPathNotWritable'));

    const result: PreflightResult = {
        ok: messages.length === 0,
        autoFixApplied: autoFix,
        checks,
        messages,
        timestamp: new Date().toISOString()
    };

    appendDebugLog('preflight-finished', result);
    return result;
}

function flushPendingDebugLogLines(): void {
    if (!pendingDebugLogLines.length) {
        return;
    }

    try {
        const payload = pendingDebugLogLines.join('');
        pendingDebugLogLines = [];
        fs.appendFileSync(DEBUG_LOG_FILE, payload);
        trimDebugLogFileIfNeeded();
    } catch {
        // ignore debug log errors
    }
}

function trimDebugLogFileIfNeeded(): void {
    try {
        if (!fs.existsSync(DEBUG_LOG_FILE)) {
            return;
        }

        const stats = fs.statSync(DEBUG_LOG_FILE);
        if (stats.size <= DEBUG_LOG_MAX_BYTES) {
            return;
        }

        const bytesToKeep = Math.min(DEBUG_LOG_TRIM_TO_BYTES, stats.size);
        const startOffset = Math.max(0, stats.size - bytesToKeep);
        const buffer = Buffer.allocUnsafe(bytesToKeep);

        let fileHandle: number | null = null;
        try {
            fileHandle = fs.openSync(DEBUG_LOG_FILE, 'r');
            fs.readSync(fileHandle, buffer, 0, bytesToKeep, startOffset);
        } finally {
            if (fileHandle !== null) {
                fs.closeSync(fileHandle);
            }
        }

        const firstLineBreak = buffer.indexOf(0x0a);
        const trimmed = firstLineBreak >= 0 && firstLineBreak + 1 < buffer.length
            ? buffer.subarray(firstLineBreak + 1)
            : buffer;

        fs.writeFileSync(DEBUG_LOG_FILE, trimmed);
    } catch {
        // ignore debug log errors
    }
}

function readDebugLogTailFromDisk(): string {
    const stats = fs.statSync(DEBUG_LOG_FILE);
    if (stats.size <= 0) {
        return '';
    }

    const bytesToRead = Math.min(stats.size, DEBUG_LOG_READ_TAIL_BYTES);
    if (bytesToRead === stats.size) {
        return fs.readFileSync(DEBUG_LOG_FILE, 'utf-8');
    }

    const buffer = Buffer.allocUnsafe(bytesToRead);
    let fileHandle: number | null = null;
    try {
        fileHandle = fs.openSync(DEBUG_LOG_FILE, 'r');
        fs.readSync(fileHandle, buffer, 0, bytesToRead, stats.size - bytesToRead);
    } finally {
        if (fileHandle !== null) {
            fs.closeSync(fileHandle);
        }
    }

    const firstLineBreak = buffer.indexOf(0x0a);
    const slice = firstLineBreak >= 0 && firstLineBreak + 1 < buffer.length
        ? buffer.subarray(firstLineBreak + 1)
        : buffer;

    return slice.toString('utf-8');
}

function startDebugLogFlushTimer(): void {
    if (debugLogFlushTimer) {
        return;
    }

    debugLogFlushTimer = setInterval(() => {
        flushPendingDebugLogLines();
    }, DEBUG_LOG_FLUSH_INTERVAL_MS);

    debugLogFlushTimer.unref?.();
}

function stopDebugLogFlushTimer(flush = true): void {
    if (debugLogFlushTimer) {
        clearInterval(debugLogFlushTimer);
        debugLogFlushTimer = null;
    }

    if (flush) {
        flushPendingDebugLogLines();
    }
}

function readDebugLog(lines = 200): string {
    try {
        flushPendingDebugLogLines();

        if (!fs.existsSync(DEBUG_LOG_FILE)) {
            return 'Debug-Log ist leer.';
        }

        const text = readDebugLogTailFromDisk();
        const rows = text.split(/\r?\n/).filter(Boolean);
        return rows.slice(-lines).join('\n') || 'Debug-Log ist leer.';
    } catch (e) {
        return `Debug-Log konnte nicht gelesen werden: ${String(e)}`;
    }
}

function appendDebugLog(message: string, details?: unknown): void {
    try {
        const ts = new Date().toISOString();
        const sanitizedDetails = sanitizeLogDetails(details);
        const payload = details === undefined
            ? ''
            : ` | ${typeof sanitizedDetails === 'string' ? sanitizedDetails : JSON.stringify(sanitizedDetails)}`;

        pendingDebugLogLines.push(`[${ts}] ${message}${payload}\n`);

        if (pendingDebugLogLines.length >= DEBUG_LOG_BUFFER_FLUSH_LINES) {
            flushPendingDebugLogLines();
        } else {
            startDebugLogFlushTimer();
        }
    } catch {
        // ignore debug log errors
    }
}

// Wire up tools module with debug logging and directory paths
setDebugLogFn(appendDebugLog);
initToolDirs(TOOLS_STREAMLINK_DIR, TOOLS_FFMPEG_DIR, () => app.getPath('temp'));

const claimedFilenames = new Set<string>();
const itemClaimedFilenames = new Map<string, Set<string>>();

function ensureUniqueFilename(filePath: string, itemId: string | null = null): string {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    let candidate = filePath;
    let counter = 0;
    while (fs.existsSync(candidate) || claimedFilenames.has(candidate)) {
        counter++;
        candidate = path.join(dir, `${base}_${counter}${ext}`);
    }
    claimedFilenames.add(candidate);
    if (itemId) {
        let perItem = itemClaimedFilenames.get(itemId);
        if (!perItem) {
            perItem = new Set();
            itemClaimedFilenames.set(itemId, perItem);
        }
        perItem.add(candidate);
    }
    return candidate;
}

function releaseClaimedFilenamesForItem(itemId: string): void {
    const perItem = itemClaimedFilenames.get(itemId);
    if (!perItem) return;
    for (const f of perItem) claimedFilenames.delete(f);
    itemClaimedFilenames.delete(itemId);
}


function formatSecondsWithPattern(totalSeconds: number, pattern: string): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    const tokenMap: Record<string, string> = {
        HH: hours.toString().padStart(2, '0'),
        H: hours.toString(),
        hh: hours.toString().padStart(2, '0'),
        h: hours.toString(),
        mm: minutes.toString().padStart(2, '0'),
        m: minutes.toString(),
        ss: seconds.toString().padStart(2, '0'),
        s: seconds.toString()
    };

    return pattern
        .replace(/HH|H|hh|h|mm|m|ss|s/g, (token) => tokenMap[token] ?? token)
        .replace(/\\(.)/g, '$1');
}

function parseVodId(url: string): string {
    const match = url.match(/videos\/(\d+)/i);
    return match?.[1] || '';
}

function isLikelyVodUrl(url: string): boolean {
    return /twitch\.tv\/videos\/\d+/i.test(url || '');
}

function parseFrameRate(rawFrameRate: string | undefined): number {
    const fallback = 30;
    const parts = (rawFrameRate || '').trim().split('/');
    if (parts.length > 2 || parts.some(part => !/^\d+$/.test(part) && !/^\d+\.\d+$/.test(part))) return fallback;
    const numerator = Number(parts[0]);
    const denominator = parts.length === 2 ? Number(parts[1]) : 1;
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return fallback;
    const fps = numerator / denominator;
    return Number.isFinite(fps) && fps > 0 ? fps : fallback;
}

interface ClipTemplateContext {
    template: string;
    title: string;
    vodId: string;
    channel: string;
    date: Date;
    part: number;
    partPadded: string;
    trimStartSec: number;
    trimEndSec: number;
    trimLengthSec: number;
    fullLengthSec: number;
}

function renderClipFilenameTemplate(context: ClipTemplateContext): string {
    const baseDate = `${context.date.getDate().toString().padStart(2, '0')}.${(context.date.getMonth() + 1).toString().padStart(2, '0')}.${context.date.getFullYear()}`;
    let rendered = context.template
        .replace(/\{title\}/g, sanitizeFilenamePart(context.title, 'untitled'))
        .replace(/\{id\}/g, sanitizeFilenamePart(context.vodId, 'unknown'))
        .replace(/\{channel\}/g, sanitizeFilenamePart(context.channel, 'unknown'))
        .replace(/\{channel_id\}/g, '')
        .replace(/\{date\}/g, baseDate)
        .replace(/\{part\}/g, String(context.part))
        .replace(/\{part_padded\}/g, context.partPadded)
        .replace(/\{trim_start\}/g, formatDurationDashed(context.trimStartSec))
        .replace(/\{trim_end\}/g, formatDurationDashed(context.trimEndSec))
        .replace(/\{trim_length\}/g, formatDurationDashed(context.trimLengthSec))
        .replace(/\{length\}/g, formatDurationDashed(context.fullLengthSec))
        .replace(/\{ext\}/g, 'mp4')
        .replace(/\{random_string\}/g, Math.random().toString(36).slice(2, 10));

    rendered = rendered.replace(/\{date_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatDateWithPattern(context.date, pattern), 'date');
    });
    rendered = rendered.replace(/\{trim_start_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatSecondsWithPattern(context.trimStartSec, pattern), '00-00-00');
    });
    rendered = rendered.replace(/\{trim_end_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatSecondsWithPattern(context.trimEndSec, pattern), '00-00-00');
    });
    rendered = rendered.replace(/\{trim_length_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatSecondsWithPattern(context.trimLengthSec, pattern), '00-00-00');
    });
    rendered = rendered.replace(/\{length_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatSecondsWithPattern(context.fullLengthSec, pattern), '00-00-00');
    });

    const parts = rendered
        .split(/[\\/]+/)
        .map((segment) => sanitizeFilenamePart(segment, 'unnamed'))
        .filter((segment) => segment !== '.' && segment !== '..');

    if (parts.length === 0) {
        return 'clip.mp4';
    }

    const lastIdx = parts.length - 1;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(parts[lastIdx])) {
        parts[lastIdx] = `${parts[lastIdx]}.mp4`;
    }

    return path.join(...parts);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
    if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

function formatETA(seconds: number): string {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

function getFreeDiskBytes(targetPath: string): number | null {
    try {
        const statfsSync = (fs as unknown as { statfsSync?: (path: string) => { bsize?: number; frsize?: number; bavail?: number } }).statfsSync;
        if (!statfsSync) {
            return null;
        }

        const info = statfsSync(targetPath);
        const blockSize = Number(info?.bsize || info?.frsize || 0);
        const availableBlocks = Number(info?.bavail || 0);
        if (!Number.isFinite(blockSize) || !Number.isFinite(availableBlocks) || blockSize <= 0 || availableBlocks < 0) {
            return null;
        }

        return Math.floor(blockSize * availableBlocks);
    } catch {
        return null;
    }
}

function estimateRequiredDownloadBytes(item: QueueItem): number {
    const durationSeconds = item.customClip?.omissions
        ? planEditedVod(item.customClip.durationSec, item.customClip.omissions.partDurationSec, item.customClip.omissions.ranges, item.customClip.startPart, item.customClip.omissions.selection).duration
        : Math.max(1, item.customClip?.durationSec || parseDuration(item.duration_str || '0s'));

    const bytesPerSecondByMode: Record<PerformanceMode, number> = {
        stability: 900 * 1024,
        balanced: 700 * 1024,
        speed: 550 * 1024
    };

    const mode = normalizePerformanceMode(config.performance_mode);
    const baseEstimate = durationSeconds * bytesPerSecondByMode[mode];
    const withHeadroom = Math.ceil(baseEstimate * (item.customClip?.omissions ? 2.2 : item.customClip ? 1.2 : 1.35));

    return Math.max(64 * 1024 * 1024, Math.min(withHeadroom, (item.customClip?.omissions ? 160 : 40) * 1024 * 1024 * 1024));
}

function ensureDiskSpace(targetPath: string, requiredBytes: number, context: string): DownloadResult {
    const freeBytes = getFreeDiskBytes(targetPath);
    if (freeBytes === null) {
        appendDebugLog('disk-space-check-skipped', { targetPath, requiredBytes, context });
        return { success: true };
    }

    if (freeBytes < Math.max(requiredBytes, MIN_FREE_DISK_BYTES)) {
        const message = tBackend('diskSpaceShortFor', { context, free: formatBytes(freeBytes), required: formatBytes(requiredBytes) });
        appendDebugLog('disk-space-check-failed', {
            targetPath,
            requiredBytes,
            freeBytes,
            context
        });
        return { success: false, error: message };
    }

    return { success: true };
}

function getMetadataCacheTtlMs(): number {
    return normalizeMetadataCacheMinutes(config.metadata_cache_minutes) * 60 * 1000;
}

function getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const cached = cache.get(key);
    if (!cached) {
        return undefined;
    }

    if (cached.expiresAt <= Date.now()) {
        cache.delete(key);
        return undefined;
    }

    cache.delete(key);
    cache.set(key, cached);
    return cached.value;
}

function pruneExpiredCacheEntries<T>(cache: Map<string, CacheEntry<T>>): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of cache.entries()) {
        if (entry.expiresAt <= now) {
            cache.delete(key);
            removed += 1;
        }
    }

    return removed;
}

function enforceCacheEntryLimit<T>(cache: Map<string, CacheEntry<T>>, maxEntries: number): number {
    if (maxEntries <= 0) {
        const removed = cache.size;
        cache.clear();
        return removed;
    }

    let removed = 0;
    while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value as string | undefined;
        if (!oldest) {
            break;
        }
        cache.delete(oldest);
        removed += 1;
    }

    return removed;
}

function setCachedValue<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    maxEntries: number
): void {
    cache.set(key, {
        value,
        expiresAt: Date.now() + getMetadataCacheTtlMs()
    });

    if (cache.size > maxEntries) {
        pruneExpiredCacheEntries(cache);
        enforceCacheEntryLimit(cache, maxEntries);
    }
}

function cleanupMetadataCaches(reason: 'interval' | 'manual' | 'shutdown'): void {
    const before = {
        loginToUserId: loginToUserIdCache.size,
        vodList: vodListCache.size,
        clipInfo: clipInfoCache.size
    };

    const expired = {
        loginToUserId: pruneExpiredCacheEntries(loginToUserIdCache),
        vodList: pruneExpiredCacheEntries(vodListCache),
        clipInfo: pruneExpiredCacheEntries(clipInfoCache)
    };

    const evicted = {
        loginToUserId: enforceCacheEntryLimit(loginToUserIdCache, MAX_LOGIN_TO_USER_ID_CACHE_ENTRIES),
        vodList: enforceCacheEntryLimit(vodListCache, MAX_VOD_LIST_CACHE_ENTRIES),
        clipInfo: enforceCacheEntryLimit(clipInfoCache, MAX_CLIP_INFO_CACHE_ENTRIES)
    };

    const removedTotal =
        expired.loginToUserId + expired.vodList + expired.clipInfo +
        evicted.loginToUserId + evicted.vodList + evicted.clipInfo;

    if (removedTotal > 0) {
        appendDebugLog('metadata-cache-cleanup', {
            reason,
            before,
            after: {
                loginToUserId: loginToUserIdCache.size,
                vodList: vodListCache.size,
                clipInfo: clipInfoCache.size
            },
            expired,
            evicted,
            removedTotal
        });
    }
}

function clearMetadataCaches(): void {
    loginToUserIdCache.clear();
    vodListCache.clear();
    clipInfoCache.clear();
}

function startMetadataCacheCleanup(): void {
    if (cacheCleanupTimer) {
        return;
    }

    cacheCleanupTimer = setInterval(() => {
        cleanupMetadataCaches('interval');
    }, CACHE_CLEANUP_INTERVAL_MS);

    cacheCleanupTimer.unref?.();
}

function stopMetadataCacheCleanup(): void {
    if (!cacheCleanupTimer) {
        return;
    }

    clearInterval(cacheCleanupTimer);
    cacheCleanupTimer = null;
}

function withInFlightDedup<T>(
    store: Map<string, Promise<T>>,
    key: string,
    factory: () => Promise<T>
): Promise<T> {
    const existing = store.get(key);
    if (existing) {
        return existing;
    }

    const requestPromise: Promise<T> = factory().finally(() => {
        if (store.get(key) === requestPromise) {
            store.delete(key);
        }
    });

    store.set(key, requestPromise);
    return requestPromise;
}

function getRetryAttemptLimit(): number {
    switch (normalizePerformanceMode(config.performance_mode)) {
        case 'stability':
            return 5;
        case 'speed':
            return 2;
        case 'balanced':
        default:
            return 3;
    }
}

function classifyDownloadError(errorMessage: string): RetryErrorClass {
    const text = (errorMessage || '').toLowerCase();
    if (!text) return 'unknown';

    if (text.includes('ungültige vod-url') || text.includes('ungueltige vod-url') || text.includes('invalid vod url')) return 'validation';
    if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) return 'rate_limit';
    if (text.includes('401') || text.includes('403') || text.includes('unauthorized') || text.includes('forbidden') || text.includes('subscriber only') || text.includes('sub-only') || text.includes('not subscribed')) return 'auth';
    if (text.includes('timed out') || text.includes('timeout') || text.includes('network') || text.includes('connection') || text.includes('dns') || text.includes('http error') || text.includes('connectionerror') || text.includes('readerror')) return 'network';
    if (text.includes('streamlink nicht gefunden') || text.includes('streamlink not found') || text.includes('streamlink is missing') || text.includes('ffmpeg') || text.includes('ffprobe') || text.includes('enoent')) return 'tooling';
    if (text.includes('integrität') || text.includes('integritaet') || text.includes('integrity') || text.includes('kein videostream') || text.includes('no video stream')) return 'integrity';
    if (text.includes('access denied') || text.includes('permission') || text.includes('disk') || text.includes('file') || text.includes('ordner') || text.includes('folder')) return 'io';
    // Twitch-spezifische streamlink errors:
    //   "error: No playable streams found on this URL" — VOD weg / private / sub-only
    //   "error: Could not find any kind of stream" — gleich
    //   "error: Unable to validate session token" — Twitch-API rejected
    //   "error: Unable to fetch access token" — Auth pre-flight failed
    if (text.includes('no playable streams') || text.includes('could not find any kind of stream')) return 'validation';
    if (text.includes('access token') || text.includes('session token') || text.includes('signature') || text.includes('integrity token')) return 'auth';

    return 'unknown';
}

function getRetryDelaySeconds(errorClass: RetryErrorClass, attempt: number): number {
    const jitter = Math.floor(Math.random() * 3);

    switch (errorClass) {
        case 'rate_limit':
            return Math.min(45, 10 + attempt * 6 + jitter);
        case 'network':
            return Math.min(30, 4 * attempt + jitter);
        case 'auth':
            return Math.min(40, 8 + attempt * 5 + jitter);
        case 'integrity':
            return Math.min(20, 3 + attempt * 2 + jitter);
        case 'io':
            return Math.min(25, 5 + attempt * 3 + jitter);
        case 'tooling':
            return DEFAULT_RETRY_DELAY_SECONDS;
        case 'validation':
            return 0;
        case 'unknown':
        default:
            return Math.min(25, DEFAULT_RETRY_DELAY_SECONDS + attempt * 2 + jitter);
    }
}

function getQueueCounts(queueData: QueueItem[] = downloadQueue): RuntimeMetricsSnapshot['queue'] {
    const counts = {
        pending: 0,
        downloading: 0,
        paused: 0,
        completed: 0,
        error: 0,
        total: queueData.length
    };

    for (const item of queueData) {
        if (item.status === 'pending') counts.pending += 1;
        else if (item.status === 'downloading') counts.downloading += 1;
        else if (item.status === 'paused') counts.paused += 1;
        else if (item.status === 'completed') counts.completed += 1;
        else if (item.status === 'error') counts.error += 1;
    }

    return counts;
}

function generateQueueItemId(): string {
    queueIdCounter = (queueIdCounter + 1) % 1000;
    return `${Date.now()}-${queueIdCounter}`;
}

function getQueueBroadcastFingerprint(queueData: QueueItem[] = downloadQueue): string {
    return queueData.map((item) => [
        item.id,
        item.status,
        Math.round((Number(item.progress) || 0) * 10),
        item.currentPart || 0,
        item.totalParts || 0,
        item.speed || '',
        item.eta || '',
        item.last_error || '',
        item.recordingHealth || ''
    ].join(':')).join('|');
}

function emitQueueUpdated(force = false): void {
    if (!downloadQueue.some((item) => item.status === 'pending')) clearDownloadPolicyWakeTimer();
    emitDownloadPolicyStatus();
    const nextFingerprint = getQueueBroadcastFingerprint(downloadQueue);
    if (!force && nextFingerprint === lastQueueBroadcastFingerprint) {
        return;
    }

    lastQueueBroadcastFingerprint = nextFingerprint;
    rememberQueueFilePaths(downloadQueue);
    mainWindow?.webContents.send('queue-updated', downloadQueue);
    updateTaskbarProgress();
}

// Per-item taskbar progress is tracked here because main's downloadQueue
// items don't update their .progress field mid-download (only the renderer
// gets a stream of progress events). Map is cleared in processOneQueueItem.finally.
const activeDownloadProgress = new Map<string, number>();

function recordDownloadProgress(progress: DownloadProgress): void {
    if (queuePaused) return;
    const p = Number(progress.progress);
    const item = downloadQueue.find((candidate) => candidate.id === progress.id);
    if (item) mergeQueueProgressState(item, progress, false);
    const fraction = Number.isFinite(p) && p > 0 && p <= 100 ? p / 100 : 0.3;
    activeDownloadProgress.set(progress.id, fraction);
    updateTaskbarProgress();
}

function clearDownloadProgress(itemId: string): void {
    activeDownloadProgress.delete(itemId);
    updateTaskbarProgress();
}

// Aggregate progress across all currently-downloading items, mapped to the
// Windows taskbar progress indicator (-1 = no progress, 0..1 = fraction).
// Visible whenever the user has minimised / collapsed the window. Indeterminate
// downloads (no percentage yet) report a 30% bar so the taskbar still shows
// activity instead of going cold.
function updateTaskbarProgress(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const entries = Array.from(activeDownloadProgress.values());
    if (entries.length === 0) {
        try { mainWindow.setProgressBar(-1); } catch { /* unsupported on some platforms */ }
        return;
    }
    const avg = entries.reduce((s, v) => s + v, 0) / entries.length;
    try { mainWindow.setProgressBar(Math.max(0, Math.min(1, avg))); } catch { /* ignore */ }
}

function hasQueueItemId(id: string): boolean {
    return downloadQueue.some((item) => item.id === id);
}

function getRuntimeMetricsSnapshot(): RuntimeMetricsSnapshot {
    return {
        ...runtimeMetrics,
        timestamp: new Date().toISOString(),
        queue: getQueueCounts(downloadQueue),
        caches: {
            loginToUserId: loginToUserIdCache.size,
            vodList: vodListCache.size,
            clipInfo: clipInfoCache.size
        },
        config: {
            performanceMode: normalizePerformanceMode(config.performance_mode),
            smartScheduler: false,
            metadataCacheMinutes: normalizeMetadataCacheMinutes(config.metadata_cache_minutes),
            duplicatePrevention: config.prevent_duplicate_downloads !== false
        }
    };
}

function getQueueItemFingerprint(item: Pick<QueueItem, 'url' | 'streamer' | 'date' | 'customClip' | 'quality'>): string {
    return canonicalQueueItemIdentity(item);
}

function isQueueItemActive(item: QueueItem): boolean {
    return item.status === 'pending' || item.status === 'downloading' || item.status === 'paused';
}

function hasActiveDuplicate(candidate: Pick<QueueItem, 'url' | 'streamer' | 'date' | 'customClip' | 'quality'>): boolean {
    const candidateFingerprint = getQueueItemFingerprint(candidate);

    return downloadQueue.some((existing) => {
        if (!isQueueItemActive(existing)) return false;
        return getQueueItemFingerprint(existing) === candidateFingerprint;
    });
}

function pickNextPendingQueueItem(): QueueItem | null {
    return downloadQueue.find((item) => item.status === 'pending') || null;
}

function parseClockDurationSeconds(duration: string | null): number | null {
    if (!duration) return null;
    const parts = duration.split(':').map((part) => Number(part));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
        return null;
    }

    return Math.max(0, Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]));
}

const executeFile = promisify(execFile);

async function probeMediaFile(filePath: string): Promise<{ durationSeconds: number; hasVideo: boolean } | null> {
    try {
        const ffprobePath = await getFFprobePath();
        if (!await canExecuteCommand(ffprobePath, ['-version'])) {
            return null;
        }

        recordManagedToolExecution('ffprobe', ffprobePath);
        const res = await executeFile(ffprobePath, [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath
        ], {
            windowsHide: true,
            encoding: 'utf-8',
            timeout: 15000,
            maxBuffer: 4 * 1024 * 1024
        });

        if (!res.stdout) {
            return null;
        }

        const parsed = JSON.parse(res.stdout) as {
            format?: { duration?: string };
            streams?: Array<{ codec_type?: string }>;
        };

        const durationSeconds = Number(parsed?.format?.duration || 0);
        const hasVideo = Boolean(parsed?.streams?.some((stream) => stream.codec_type === 'video'));

        return {
            durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
            hasVideo
        };
    } catch {
        return null;
    }
}

async function validateDownloadedFileIntegrity(filePath: string, expectedDurationSeconds: number | null): Promise<DownloadResult> {
    const probed = await probeMediaFile(filePath);
    if (!probed) {
        appendDebugLog('integrity-probe-skipped', { filePath });
        return { success: true };
    }

    if (!probed.hasVideo) {
        runtimeMetrics.integrityFailures += 1;
        return { success: false, error: tBackend('integrityNoVideo') };
    }

    if (probed.durationSeconds <= 1) {
        runtimeMetrics.integrityFailures += 1;
        return { success: false, error: tBackend('integrityTooShort', { duration: probed.durationSeconds.toFixed(2) }) };
    }

    if (expectedDurationSeconds && expectedDurationSeconds > 4) {
        const minExpected = Math.max(2, expectedDurationSeconds * 0.45);
        if (probed.durationSeconds < minExpected) {
            runtimeMetrics.integrityFailures += 1;
            return {
                success: false,
                error: tBackend('integrityDurationMismatch', { actual: probed.durationSeconds.toFixed(1), expected: String(expectedDurationSeconds) })
            };
        }
    }

    return { success: true };
}

// ==========================================
// TWITCH API
// ==========================================
async function ensureTwitchAuth(forceRefresh = false): Promise<string | null> {
    return await twitchAppTokenService.ensure({
        clientId: config.client_id,
        clientSecret: twitchClientSecret,
    }, forceRefresh);
}

const TWITCH_GQL_RETRY_ATTEMPTS = 3;

async function fetchPublicTwitchGqlOutcome<T>(query: string, variables: Record<string, unknown>): Promise<RefreshOutcome<T>> {
    const outcome = await requestPublicTwitchGraphql<T>(
        axios,
        query,
        variables,
        API_TIMEOUT,
        TWITCH_GQL_RETRY_ATTEMPTS,
    );
    if (outcome.status === 'unavailable') appendDebugLog('public-gql-failed');
    return outcome;
}

async function fetchPublicTwitchGql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    const outcome = await fetchPublicTwitchGqlOutcome<T>(query, variables);
    return outcome.status === 'success' ? outcome.value : null;
}

async function getPublicUserId(username: string): Promise<string | null> {
    const login = normalizeLogin(username);
    if (!login) return null;

    const cachedUserId = getCachedValue(loginToUserIdCache, login);
    if (cachedUserId !== undefined) {
        runtimeMetrics.cacheHits += 1;
        return cachedUserId;
    }

    runtimeMetrics.cacheMisses += 1;

    type UserQueryResult = { user: { id: string; login: string } | null };
    const data = await fetchPublicTwitchGql<UserQueryResult>(
        'query($login:String!){ user(login:$login){ id login } }',
        { login }
    );

    const user = data?.user;
    if (!user?.id) return null;

    setCachedValue(loginToUserIdCache, login, user.id, MAX_LOGIN_TO_USER_ID_CACHE_ENTRIES);
    setUserIdLogin(user.id, user.login || login);
    return user.id;
}

async function getPublicVODsByLogin(loginName: string): Promise<RefreshOutcome<VOD[]>> {
    const login = normalizeLogin(loginName);
    if (!login) return { status: 'not-found' };
    return await requestPublicTwitchVodsByLogin(axios, login, 100, API_TIMEOUT, TWITCH_GQL_RETRY_ATTEMPTS);
}

async function getUserId(username: string): Promise<string | null> {
    const login = normalizeLogin(username);
    if (!login) return null;

    const cachedUserId = getCachedValue(loginToUserIdCache, login);
    if (cachedUserId !== undefined) {
        runtimeMetrics.cacheHits += 1;
        return cachedUserId;
    }

    return await withInFlightDedup(inFlightUserIdRequests, login, async () => {
        const refreshedCachedUserId = getCachedValue(loginToUserIdCache, login);
        if (refreshedCachedUserId !== undefined) {
            runtimeMetrics.cacheHits += 1;
            return refreshedCachedUserId;
        }

        runtimeMetrics.cacheMisses += 1;

        const getUserViaPublicApi = async () => {
            return await getPublicUserId(login);
        };

        let twitchAccessToken = await ensureTwitchAuth();
        if (!twitchAccessToken) return await getUserViaPublicApi();
        let outcome = await requestTwitchHelixUsers(axios, login, {
            clientId: config.client_id,
            accessToken: twitchAccessToken,
        }, API_TIMEOUT);
        if (outcome.status === 'unauthorized') {
            twitchAccessToken = await ensureTwitchAuth(true);
            if (twitchAccessToken) {
                outcome = await requestTwitchHelixUsers(axios, login, {
                    clientId: config.client_id,
                    accessToken: twitchAccessToken,
                }, API_TIMEOUT);
            }
        }
        if (outcome.status !== 'success' || !outcome.value[0]) return await getUserViaPublicApi();
        const user = outcome.value[0];
        setCachedValue(loginToUserIdCache, login, user.id, MAX_LOGIN_TO_USER_ID_CACHE_ENTRIES);
        setUserIdLogin(user.id, user.login || login);
        return user.id;
    });
}

async function getVODs(userId: string, forceRefresh = false, requireFresh = false): Promise<VOD[]> {
    const cacheKey = `user:${userId}`;
    if (!forceRefresh && !requireFresh) {
        const cachedVods = getCachedValue(vodListCache, cacheKey);
        if (cachedVods !== undefined) {
            runtimeMetrics.cacheHits += 1;
            return cachedVods;
        }
    }

    return await withInFlightDedup(inFlightVodRequests, requireFresh ? cacheKey + ':fresh' : cacheKey, async () => {
        if (!forceRefresh && !requireFresh) {
            const refreshedCachedVods = getCachedValue(vodListCache, cacheKey);
            if (refreshedCachedVods !== undefined) {
                runtimeMetrics.cacheHits += 1;
                return refreshedCachedVods;
            }
        }

        runtimeMetrics.cacheMisses += 1;
        let twitchAccessToken = await ensureTwitchAuth();
        const refreshed = await refreshTwitchProviderData(
            userId,
            vodListLastGood.get(cacheKey),
            {
                requestHelix: async () => {
                    if (!twitchAccessToken) return { status: 'unavailable' };
                    return await requestTwitchHelixVideos(axios, userId, {
                        clientId: config.client_id,
                        accessToken: twitchAccessToken,
                    }, API_TIMEOUT);
                },
                refreshToken: async () => {
                    twitchAccessToken = await ensureTwitchAuth(true);
                    return twitchAccessToken !== null;
                },
                requestPublic: async () => {
                    const login = userIdLoginCache.get(userId);
                    return login ? await getPublicVODsByLogin(login) : { status: 'unavailable' };
                },
            },
        );
        if (refreshed.source === 'helix' || refreshed.source === 'public') {
            const vods = refreshed.value ?? [];
            const login = vods[0]?.user_login;
            if (login) setUserIdLogin(userId, normalizeLogin(login));
            vodListLastGood.set(cacheKey, vods);
            setCachedValue(vodListCache, cacheKey, vods, MAX_VOD_LIST_CACHE_ENTRIES);
            return vods;
        }
        if (refreshed.source === 'not-found') {
            vodListLastGood.delete(cacheKey);
            vodListCache.delete(cacheKey);
            return [];
        }
        if (requireFresh) throw new Error('VOD refresh unavailable');
        if (refreshed.source === 'last-good') appendDebugLog('vod-refresh-kept-last-good', { userId });
        return refreshed.value ?? [];
    });
}

interface LiveStreamInfo {
    isLive: boolean;
    title?: string;
    gameName?: string;
}

// Returns whether the streamer is currently live + a little metadata if
// available. Tries Helix first (better data), falls back to public GQL when
// the user has no client_id/secret configured. A `null` return means we
// couldn't determine — caller should treat as "best-effort".
async function getLiveStreamInfo(login: string): Promise<LiveStreamInfo | null> {
    const normalized = normalizeLogin(login);
    if (!normalized) return null;

    const twitchAccessToken = await ensureTwitchAuth();
    if (twitchAccessToken) {
        try {
            const response = await axios.get('https://api.twitch.tv/helix/streams', {
                params: { user_login: normalized, first: 1 },
                headers: {
                    'Client-ID': config.client_id,
                    'Authorization': `Bearer ${twitchAccessToken}`
                },
                timeout: API_TIMEOUT
            });
            const entries = response.data?.data || [];
            if (entries.length === 0) return { isLive: false };
            const e = entries[0];
            return {
                isLive: e.type === 'live',
                title: typeof e.title === 'string' ? e.title : undefined,
                gameName: typeof e.game_name === 'string' ? e.game_name : undefined
            };
        } catch (e) {
            appendDebugLog('helix-streams-failed', { login: normalized, error: projectExternalError('twitch-helix-streams', e) });
            // fall through to public GQL
        }
    }

    type StreamQueryResult = {
        user: {
            stream: { id: string; type: string; title?: string; game?: { name?: string } } | null;
        } | null;
    };
    const data = await fetchPublicTwitchGql<StreamQueryResult>(
        'query($login:String!){ user(login:$login){ stream{ id type title game{ name } } } }',
        { login: normalized }
    );
    if (!data) return null;
    const stream = data.user?.stream;
    if (!stream) return { isLive: false };
    return {
        isLive: stream.type === 'live',
        title: stream.title,
        gameName: stream.game?.name
    };
}

// ==========================================
// STREAMER PROFILE — display-name, avatar, follower count, etc.
// ==========================================
// User-facing channel header data. Combines Helix /users (display name,
// avatar, bio, broadcaster type), public GQL (follower total — Helix
// requires moderator scope we don't have), the already-cached VOD list
// (vodCount + lastStreamAt come for free), and the live-status cache
// (isLive + currentTitle + currentGame). Cached for 30 min per login.
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

const MAX_STREAMER_PROFILE_CACHE_ENTRIES = 512;
const streamerProfileCache = new Map<string, CacheEntry<StreamerProfile>>();
const streamerProfileLastGood = new LastGoodCache<StreamerProfile>(MAX_STREAMER_PROFILE_CACHE_ENTRIES);
const inFlightProfileRequests = new Map<string, Promise<StreamerProfile | null>>();

// Avatar bytes get embedded as data URLs in the profile so the renderer
// doesn't have to do its own HTTPS fetch (Electron's renderer img loader
// has a habit of failing silently against the Twitch CDN — undocumented,
// but reproducibly: the same URL works in DevTools but not in the live
// page). Cached by source URL so a single avatar change across multiple
// streamer entries only downloads once.
const avatarDataUrlCache = new Map<string, string>();
const MAX_AVATAR_DATA_URL_CACHE = 256;

async function fetchAvatarAsDataUrl(url: string): Promise<string> {
    if (!url) return '';
    const cached = avatarDataUrlCache.get(url);
    if (cached !== undefined) return cached;
    try {
        const response = await axios.get<ArrayBuffer>(url, {
            responseType: 'arraybuffer',
            timeout: 8000,
            headers: { 'User-Agent': 'TwitchVODManager/1.0' }
        });
        const buf = Buffer.from(response.data);
        // Twitch CDN almost always serves PNG or JPEG. Detect from the
        // response content-type when available, fall back to PNG which is
        // the default for profile_image_url.
        const contentType = (response.headers['content-type'] as string | undefined)?.split(';')[0]?.trim() || 'image/png';
        const dataUrl = `data:${contentType};base64,${buf.toString('base64')}`;
        avatarDataUrlCache.set(url, dataUrl);
        if (avatarDataUrlCache.size > MAX_AVATAR_DATA_URL_CACHE) {
            // FIFO eviction — Map preserves insertion order.
            const firstKey = avatarDataUrlCache.keys().next().value as string | undefined;
            if (firstKey) avatarDataUrlCache.delete(firstKey);
        }
        return dataUrl;
    } catch (e) {
        appendDebugLog('avatar-fetch-failed', { url, error: String(e) });
        return '';
    }
}

type HelixUser = TwitchHelixUser;

async function fetchHelixUserInfo(login: string): Promise<RefreshOutcome<HelixUser>> {
    let twitchAccessToken = await ensureTwitchAuth();
    if (!twitchAccessToken) return { status: 'unavailable' };
    let outcome = await requestTwitchHelixUsers(axios, login, {
        clientId: config.client_id,
        accessToken: twitchAccessToken,
    }, API_TIMEOUT);
    if (outcome.status === 'unauthorized') {
        twitchAccessToken = await ensureTwitchAuth(true);
        if (!twitchAccessToken) return { status: 'unavailable' };
        outcome = await requestTwitchHelixUsers(axios, login, {
            clientId: config.client_id,
            accessToken: twitchAccessToken,
        }, API_TIMEOUT);
    }
    if (outcome.status === 'unauthorized' || outcome.status === 'unavailable') return { status: 'unavailable' };
    if (outcome.status === 'not-found') return outcome;
    return { status: 'success', value: outcome.value[0] };
}

interface PublicProfileQueryResult {
    user: {
        id: string;
        login: string;
        displayName: string;
        description: string | null;
        profileImageURL: string | null;
        bannerImageURL: string | null;
        roles?: { isPartner: boolean; isAffiliate: boolean } | null;
        followers?: { totalCount: number } | null;
        stream?: {
            id: string;
            type: string;
            title: string | null;
            viewersCount: number | null;
            previewImageURL: string | null;
            game: { name: string } | null;
        } | null;
    } | null;
}

interface PublicStreamerProfileResult {
    displayName: string;
    avatarUrl: string;
    bannerUrl: string;
    description: string;
    broadcasterType: '' | 'partner' | 'affiliate';
    followerCount: number | null;
    stream: PublicStreamInfo | null;
}

function getDownloadPolicyStatus(): DownloadPolicyStatus {
    const hasPendingItems = downloadQueue.some((item) => item.status === 'pending');
    const decision = decideDownloadStart(config.download_policy, new Date());
    const waiting = hasPendingItems && !isDownloading && !queuePaused && !decision.allowed;
    return {
        waiting,
        reason: waiting ? 'outside-window' : null,
        nextStart: waiting ? decision.nextStart?.toISOString() ?? null : null,
    };
}

function emitDownloadPolicyStatus(force = false): void {
    const status = getDownloadPolicyStatus();
    const fingerprint = JSON.stringify(status);
    if (!force && fingerprint === lastDownloadPolicyStatusFingerprint) return;
    lastDownloadPolicyStatusFingerprint = fingerprint;
    mainWindow?.webContents.send('download-policy-status', status);
}

function clearDownloadPolicyWakeTimer(): void {
    if (!downloadPolicyWakeTimer) return;
    clearTimeout(downloadPolicyWakeTimer);
    downloadPolicyWakeTimer = null;
}

function scheduleDownloadPolicyWake(nextStart: Date | null): void {
    clearDownloadPolicyWakeTimer();
    if (!nextStart || appShutdownStarted) return;
    const delayMs = Math.max(0, nextStart.getTime() - Date.now());
    downloadPolicyWakeTimer = setTimeout(() => {
        downloadPolicyWakeTimer = null;
        scheduleQueueProcessing();
    }, delayMs);
}

function canStartDownloadQueue(manualOverride: boolean): boolean {
    const decision = decideDownloadStart(config.download_policy, new Date(), manualOverride);
    if (!decision.allowed) {
        scheduleDownloadPolicyWake(decision.nextStart);
        emitDownloadPolicyStatus(true);
        return false;
    }
    clearDownloadPolicyWakeTimer();
    emitDownloadPolicyStatus(true);
    return true;
}

interface PublicDisplayNameQueryResult {
    user: {
        login: string;
        displayName: string;
    } | null;
}

async function getStreamerDisplayNames(logins: string[]): Promise<Record<string, string>> {
    const normalizedLogins = [...new Set(logins.map((login) => normalizeLogin(login)).filter(Boolean))];
    const displayNames = { ...config.streamer_display_names };
    const missing = normalizedLogins;
    let changed = false;
    let nextIndex = 0;

    const resolveNext = async (): Promise<void> => {
        while (nextIndex < missing.length) {
            const login = missing[nextIndex++];
            const data = await fetchPublicTwitchGql<PublicDisplayNameQueryResult>(
                'query($login: String!) { user(login: $login) { login displayName } }',
                { login }
            );
            const result = data?.user;
            const resolvedLogin = result?.login ? normalizeLogin(result.login) : login;
            const displayName = result?.displayName?.trim();
            if (displayName && displayNames[resolvedLogin] !== displayName) {
                displayNames[resolvedLogin] = displayName;
                changed = true;
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, () => resolveNext()));
    if (changed) {
        config.streamer_display_names = displayNames;
        saveConfig(config);
    }

    return normalizedLogins.reduce<Record<string, string>>((resolved, login) => {
        const displayName = displayNames[login];
        if (displayName) resolved[login] = displayName;
        return resolved;
    }, {});
}

interface PublicStreamInfo {
    previewUrl: string;
    viewers: number | null;
    title: string | null;
    game: string | null;
}

async function fetchPublicStreamerProfile(login: string): Promise<RefreshOutcome<PublicStreamerProfileResult>> {
    // Same query also pulls bannerImageURL and the current stream's
    // preview + viewer count when live — saves a separate roundtrip.
    const outcome = await fetchPublicTwitchGqlOutcome<PublicProfileQueryResult>(
        `query($login: String!) {
            user(login: $login) {
                id
                login
                displayName
                description
                profileImageURL(width: 150)
                bannerImageURL
                roles { isPartner isAffiliate }
                followers { totalCount }
                stream {
                    id
                    type
                    title
                    viewersCount
                    previewImageURL(width: 640, height: 360)
                    game { name }
                }
            }
        }`,
        { login }
    );
    if (outcome.status !== 'success') return outcome;
    const userOutcome = parseGraphqlUser(outcome.value);
    if (userOutcome.status !== 'success') return userOutcome;
    const user = userOutcome.value;
    if (typeof user.id !== 'string'
        || typeof user.login !== 'string'
        || typeof user.displayName !== 'string'
        || (user.description !== null && typeof user.description !== 'string')
        || (user.profileImageURL !== null && typeof user.profileImageURL !== 'string')
        || (user.bannerImageURL !== null && typeof user.bannerImageURL !== 'string')) return { status: 'unavailable' };
    const roles = isPlainObject(user.roles) ? user.roles : null;
    const broadcasterType: '' | 'partner' | 'affiliate' = roles?.isPartner
        ? 'partner'
        : (roles?.isAffiliate ? 'affiliate' : '');
    const s = isPlainObject(user.stream) ? user.stream : null;
    const game = s && isPlainObject(s.game) ? s.game : null;
    const stream = (s && s.type === 'live') ? {
        previewUrl: typeof s.previewImageURL === 'string' ? s.previewImageURL : '',
        viewers: typeof s.viewersCount === 'number' ? s.viewersCount : null,
        title: typeof s.title === 'string' ? s.title : null,
        game: typeof game?.name === 'string' ? game.name : null
    } : null;
    const followers = isPlainObject(user.followers) ? user.followers : null;
    return { status: 'success', value: {
        displayName: user.displayName || login,
        avatarUrl: typeof user.profileImageURL === 'string' ? user.profileImageURL : '',
        bannerUrl: typeof user.bannerImageURL === 'string' ? user.bannerImageURL : '',
        description: typeof user.description === 'string' ? user.description : '',
        broadcasterType,
        followerCount: typeof followers?.totalCount === 'number' ? followers.totalCount : null,
        stream
    } };
}

async function getStreamerProfile(login: string, forceRefresh = false): Promise<StreamerProfile | null> {
    const normalized = normalizeLogin(login);
    if (!normalized) return null;
    const previousProfile = streamerProfileLastGood.get(normalized);

    if (!forceRefresh) {
        const cached = getCachedValue(streamerProfileCache, normalized);
        if (cached !== undefined) {
            runtimeMetrics.cacheHits += 1;
            return cached;
        }
    }

    return await withInFlightDedup(inFlightProfileRequests, normalized, async () => {
        runtimeMetrics.cacheMisses += 1;

        // Public GQL is now the SOURCE for everything except some of the
        // core text fields when Helix is authenticated — because public
        // GQL is the only route that gives us the banner image + current
        // stream preview in one shot, and skipping it would mean two
        // extra roundtrips. Helix takes precedence for displayName /
        // description (those fields are sometimes richer there).
        let displayName = previousProfile?.displayName ?? normalized;
        let avatarUrl = previousProfile?.avatarUrl ?? '';
        let bannerUrl = previousProfile?.bannerUrl ?? '';
        let description = previousProfile?.description ?? '';
        let broadcasterType: '' | 'partner' | 'affiliate' = previousProfile?.broadcasterType ?? '';
        let followerCount = previousProfile?.followerCount ?? null;
        let vodCount = previousProfile?.vodCount ?? 0;
        let lastStreamAt = previousProfile?.lastStreamAt ?? null;
        let isLive = previousProfile?.isLive ?? false;
        let currentTitle = previousProfile?.currentTitle ?? null;
        let currentGame = previousProfile?.currentGame ?? null;
        let currentStreamPreviewRemoteUrl = previousProfile?.currentStreamPreviewUrl ?? '';
        let currentStreamViewers = previousProfile?.currentStreamViewers ?? null;
        let publicLiveResolved = false;
        let hasFreshSource = false;

        const publicOutcome = await fetchPublicStreamerProfile(normalized);
        if (publicOutcome.status === 'success') {
            const publicProfile = publicOutcome.value;
            hasFreshSource = true;
            displayName = publicProfile.displayName;
            avatarUrl = publicProfile.avatarUrl;
            bannerUrl = publicProfile.bannerUrl;
            description = publicProfile.description;
            broadcasterType = publicProfile.broadcasterType;
            followerCount = publicProfile.followerCount;
            publicLiveResolved = true;
            if (publicProfile.stream) {
                isLive = true;
                currentTitle = publicProfile.stream.title;
                currentGame = publicProfile.stream.game;
                currentStreamPreviewRemoteUrl = publicProfile.stream.previewUrl;
                currentStreamViewers = publicProfile.stream.viewers;
            } else {
                isLive = false;
                currentTitle = null;
                currentGame = null;
                currentStreamPreviewRemoteUrl = '';
                currentStreamViewers = null;
            }
        }

        const helixOutcome = await fetchHelixUserInfo(normalized);
        if (helixOutcome.status === 'success') {
            const helixUser = helixOutcome.value;
            hasFreshSource = true;
            displayName = helixUser.display_name || displayName;
            if (helixUser.profile_image_url) avatarUrl = helixUser.profile_image_url;
            if (helixUser.description) description = helixUser.description;
            const bt = (helixUser.broadcaster_type || '').toLowerCase();
            if (bt === 'partner' || bt === 'affiliate') broadcasterType = bt;
        }

        if (!hasFreshSource) {
            if (publicOutcome.status === 'unavailable' && helixOutcome.status === 'unavailable' && previousProfile) {
                appendDebugLog('profile-refresh-kept-last-good', { login: normalized });
                return previousProfile;
            }
            if (publicOutcome.status === 'not-found' || helixOutcome.status === 'not-found') {
                streamerProfileCache.delete(normalized);
                streamerProfileLastGood.delete(normalized);
            }
            return null;
        }

        // Derive vod count + last stream from the already-cached VOD list
        // when we have an id. No extra network hit.
        const userId = await getUserId(normalized);
        if (userId) {
            try {
                const vods = await getVODs(userId);
                vodCount = vods.length;
                // VOD list is sorted by Twitch newest-first; pick element 0.
                const newest = vods[0];
                if (newest?.created_at) lastStreamAt = newest.created_at;
            } catch (e) {
                appendDebugLog('profile-vod-derive-failed', { login: normalized, error: String(e) });
            }
        }

        if (!publicLiveResolved) {
            try {
                const live = await getLiveStreamInfo(normalized);
                if (live) {
                    isLive = live.isLive;
                    currentTitle = live.title || null;
                    currentGame = live.gameName || null;
                }
            } catch { /* best-effort */ }
        }

        // Embed the avatar AND banner bytes as data URLs in parallel.
        // Renderer can't reliably fetch Twitch CDN images directly from
        // an Electron renderer process, plus the data URL approach skips
        // any CSP/referer/CORS quirks. Live preview also goes through
        // this path — adds a cache-busting query string so a returning
        // user gets a fresh frame each time the profile refreshes.
        const livePreviewUrlForFetch = currentStreamPreviewRemoteUrl
            ? `${currentStreamPreviewRemoteUrl}${currentStreamPreviewRemoteUrl.includes('?') ? '&' : '?'}_=${Date.now()}`
            : '';
        const [avatarDataUrl, bannerDataUrl, livePreviewDataUrl] = await Promise.all([
            /^https?:\/\//i.test(avatarUrl) ? fetchAvatarAsDataUrl(avatarUrl) : Promise.resolve(''),
            /^https?:\/\//i.test(bannerUrl) ? fetchAvatarAsDataUrl(bannerUrl) : Promise.resolve(''),
            /^https?:\/\//i.test(livePreviewUrlForFetch) ? fetchAvatarAsDataUrl(livePreviewUrlForFetch) : Promise.resolve('')
        ]);

        const profile: StreamerProfile = {
            login: normalized,
            displayName,
            avatarUrl: avatarDataUrl || avatarUrl,
            bannerUrl: bannerDataUrl || bannerUrl,
            description,
            broadcasterType,
            followerCount,
            vodCount,
            lastStreamAt,
            isLive,
            currentTitle,
            currentGame,
            currentStreamPreviewUrl: livePreviewDataUrl || currentStreamPreviewRemoteUrl,
            currentStreamViewers,
            twitchUrl: `https://www.twitch.tv/${normalized}`,
            fetchedAt: Date.now()
        };

        setCachedValue(streamerProfileCache, normalized, profile, MAX_STREAMER_PROFILE_CACHE_ENTRIES);
        streamerProfileLastGood.set(normalized, profile);
        return profile;
    });
}

// ==========================================
// VOD STORYBOARD — animated hover preview
// ==========================================
// Twitch publishes a "storyboard" JSON per VOD with sprite-sheet URLs
// containing N preview thumbnails covering the full length of the
// recording. We pull the JSON via public GQL (seekPreviewsURL), then
// hand the renderer the first high-quality sprite as a data URL plus
// the grid metadata. The renderer animates background-position across
// 4 cells to produce a scrub-preview effect on hover, twitch.tv-style.
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

const MAX_VOD_STORYBOARD_CACHE_ENTRIES = 12;
const vodStoryboardCache = new Map<string, CacheEntry<VodStoryboard | null>>();
const inFlightStoryboardRequests = new Map<string, Promise<VodStoryboard | null>>();

interface StoryboardManifestEntry {
    count: number;
    width: number;
    height: number;
    cols: number;
    rows: number;
    images: string[];
    quality: string;
    interval: number;
}

async function getVodStoryboard(vodId: string): Promise<VodStoryboard | null> {
    if (!vodId) return null;

    const cached = getCachedValue(vodStoryboardCache, vodId);
    if (cached !== undefined) {
        runtimeMetrics.cacheHits += 1;
        return cached;
    }

    return await withInFlightDedup(inFlightStoryboardRequests, vodId, async () => {
        runtimeMetrics.cacheMisses += 1;

        // Step 1: GQL gives us the seekPreviewsURL pointing at a JSON
        // manifest. The manifest lists sprite images at multiple quality
        // levels; we pick the high-quality first sprite (covers the
        // beginning of the VOD with the most detail).
        const data = await fetchPublicTwitchGql<{ video: { seekPreviewsURL: string | null; previewThumbnailURL: string | null } | null }>(
            `query($id: ID!) { video(id: $id) { seekPreviewsURL previewThumbnailURL(width: 1920, height: 1080) } }`,
            { id: vodId }
        );
        const manifestUrl = data?.video?.seekPreviewsURL;
        if (!manifestUrl) {
            // Cache the negative result so a VOD without a storyboard
            // (private/unlisted/expired) doesn't get re-queried on every
            // subsequent hover.
            setCachedValue(vodStoryboardCache, vodId, null, MAX_VOD_STORYBOARD_CACHE_ENTRIES);
            return null;
        }

        let manifest: StoryboardManifestEntry[];
        try {
            const manifestResp = await axios.get<StoryboardManifestEntry[]>(manifestUrl, {
                timeout: 6000,
                responseType: 'json',
                headers: { 'User-Agent': 'TwitchVODManager/1.0' }
            });
            manifest = manifestResp.data;
        } catch (e) {
            appendDebugLog('storyboard-manifest-failed', { vodId, error: String(e) });
            setCachedValue(vodStoryboardCache, vodId, null, MAX_VOD_STORYBOARD_CACHE_ENTRIES);
            return null;
        }

        if (!Array.isArray(manifest) || manifest.length === 0) {
            setCachedValue(vodStoryboardCache, vodId, null, MAX_VOD_STORYBOARD_CACHE_ENTRIES);
            return null;
        }

        // Prefer the "high" quality entry — Twitch ships both "low" and
        // "high" alongside each other. Falls back to whichever is present.
        const entry = manifest.find((m) => m.quality === 'high') || manifest[0];
        if (!entry?.images?.length) {
            setCachedValue(vodStoryboardCache, vodId, null, MAX_VOD_STORYBOARD_CACHE_ENTRIES);
            return null;
        }

        // The manifest URL points at e.g. .../storyboards/{vodId}-info.json
        // and sprite filenames are relative (e.g. "{vodId}-high-0.jpg").
        // Strip the JSON filename to get the base, then append the sprite.
        const baseUrl = manifestUrl.replace(/\/[^/]+$/, '/');
        const frameUrls = buildVodPreviewFrameUrls(data?.video?.previewThumbnailURL || '');
        const frameDataUrls = (await Promise.all(frameUrls.map(async (url) => {
            try {
                const response = await axios.get<ArrayBuffer>(url, {
                    responseType: 'arraybuffer',
                    timeout: 8000,
                    headers: { 'User-Agent': 'TwitchVODManager/1.0' }
                });
                const contentType = String(response.headers['content-type'] || 'image/jpeg').split(';')[0];
                return `data:${contentType};base64,${Buffer.from(response.data).toString('base64')}`;
            } catch {
                return '';
            }
        }))).filter((url) => url.length > 0);
        const firstSpriteUrl = baseUrl + entry.images[0];
        const spriteDataUrl = frameDataUrls.length >= 2 ? '' : await fetchAvatarAsDataUrl(firstSpriteUrl);
        if (frameDataUrls.length < 2 && !spriteDataUrl) {
            setCachedValue(vodStoryboardCache, vodId, null, MAX_VOD_STORYBOARD_CACHE_ENTRIES);
            return null;
        }

        const storyboard: VodStoryboard = {
            vodId,
            spriteDataUrl,
            frameDataUrls: frameDataUrls.length >= 2 ? frameDataUrls : [],
            frameWidth: frameDataUrls.length >= 2 ? 1920 : 0,
            frameHeight: frameDataUrls.length >= 2 ? 1080 : 0,
            cols: entry.cols,
            rows: entry.rows,
            cellWidth: entry.width,
            cellHeight: entry.height,
            framesInSprite: entry.cols * entry.rows
        };
        setCachedValue(vodStoryboardCache, vodId, storyboard, MAX_VOD_STORYBOARD_CACHE_ENTRIES);
        return storyboard;
    });
}

async function getClipInfo(clipId: string): Promise<{ title: string; broadcaster_name: string } | null> {
    const cachedClip = getCachedValue(clipInfoCache, clipId);
    if (cachedClip !== undefined) {
        runtimeMetrics.cacheHits += 1;
        return cachedClip;
    }
    return await withInFlightDedup(inFlightClipRequests, clipId, async () => {
        runtimeMetrics.cacheMisses += 1;
        const outcome = await requestPublicClipInfo(axios, clipId, API_TIMEOUT);
        if (outcome.status === 'not-found') return null;
        if (outcome.status !== 'success') throw new Error(tBackend('clipLookupUnavailable'));
        const clip = outcome.value;
        setCachedValue(clipInfoCache, clipId, clip, MAX_CLIP_INFO_CACHE_ENTRIES);
        return clip;
    });
}

// ==========================================
// VIDEO INFO (for cutter)
// ==========================================
function isVideoEditorPreviewCompatible(filePath: string, videoCodec: string, audioCodec: string | null): boolean {
    const extension = path.extname(filePath).toLowerCase();
    const audioCompatible = !audioCodec || ['aac', 'mp3', 'opus', 'vorbis'].includes(audioCodec);
    if (['.mp4', '.m4v', '.mov'].includes(extension)) return ['h264', 'av1', 'vp9'].includes(videoCodec) && audioCompatible;
    if (extension === '.webm') return ['vp8', 'vp9', 'av1'].includes(videoCodec) && audioCompatible;
    if (extension === '.mkv') return ['h264', 'av1', 'vp8', 'vp9'].includes(videoCodec) && audioCompatible;
    return false;
}

function isSupportedVideoEditorInput(filePath: string): boolean {
    return ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ts', '.avi'].includes(path.extname(filePath).toLowerCase());
}

function normalizeCutterRotation(value: unknown): 0 | 90 | 180 | 270 {
    const numeric = Number(value);
    const normalized = ((numeric % 360) + 360) % 360;
    return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

async function getVideoInfo(filePath: string, trackedProcesses?: Set<ChildProcess>, timeoutMs = 30000): Promise<VideoInfo | null> {
    const ffmpegReady = await ensureFfmpegInstalled();
    if (!ffmpegReady) {
        appendDebugLog('get-video-info-missing-ffmpeg');
        return null;
    }

    const ffprobe = await getFFprobePath();
    if (appShutdownStarted) return null;
    return new Promise((resolve) => {
        const args = [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath
        ];

        recordManagedToolExecution('ffprobe', ffprobe);
        const proc = spawn(ffprobe, args, { windowsHide: true });
        trackedProcesses?.add(proc);
        proc.stderr?.resume();
        let output = '';
        let resolved = false;
        let forceResolveTimer: NodeJS.Timeout | null = null;

        const resolveOnce = (value: VideoInfo | null): void => {
            if (resolved) return;
            resolved = true;
            resolve(value);
        };

        const finish = (value: VideoInfo | null): void => {
            clearTimeout(timeoutTimer);
            if (forceResolveTimer) clearTimeout(forceResolveTimer);
            trackedProcesses?.delete(proc);
            resolveOnce(value);
        };

        const timeoutTimer = setTimeout(() => {
            try { proc.kill(); } catch { }
            forceResolveTimer = setTimeout(() => resolveOnce(null), 2000);
        }, timeoutMs);

        proc.stdout?.on('data', (data) => {
            output += data.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                finish(null);
                return;
            }

            try {
                const info = JSON.parse(output);
                const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');
                const audioStreams = (Array.isArray(info.streams) ? info.streams : [])
                    .filter((stream: any) => stream?.codec_type === 'audio')
                    .map((stream: any, index: number) => ({
                        index,
                        codec: String(stream.codec_name || '').toLowerCase(),
                        channels: Number.isFinite(stream.channels) ? Number(stream.channels) : 0,
                        language: typeof stream.tags?.language === 'string' ? stream.tags.language : null,
                    }));
                const audioStream = audioStreams[0] ?? null;
                const duration = parseFloat(info.format?.duration || videoStream?.duration || '0');
                const averageFps = parseFrameRate(videoStream?.avg_frame_rate);
                const realFps = parseFrameRate(videoStream?.r_frame_rate);
                const fps = averageFps > 0 ? averageFps : realFps;

                if (!videoStream || !Number.isFinite(duration) || duration <= 0 || !videoStream.width || !videoStream.height || !Number.isFinite(fps) || fps <= 0) {
                    finish(null);
                    return;
                }

                const sourceFormat = readVideoSourceFormat(videoStream);
                const videoCodec = String(videoStream.codec_name || '').toLowerCase();
                const audioCodec = audioStream?.codec ?? null;
                const variableFrameRate = averageFps > 0 && realFps > 0 && Math.abs(averageFps - realFps) / Math.max(averageFps, realFps) > 0.005;
                const rotationData = Array.isArray(videoStream.side_data_list)
                    ? videoStream.side_data_list.find((entry: any) => Number.isFinite(Number(entry?.rotation)))?.rotation
                    : undefined;
                finish({
                    duration,
                    width: videoStream.width,
                    height: videoStream.height,
                    fps,
                    hasAudio: Boolean(audioStream),
                    videoCodec,
                    audioCodec,
                    previewCompatible: !sourceFormat.hdr && sourceFormat.bitDepth === 8 && sourceFormat.pixelFormat === 'yuv420p' && isVideoEditorPreviewCompatible(filePath, videoCodec, audioCodec),
                    variableFrameRate,
                    rotation: normalizeCutterRotation(rotationData ?? videoStream.tags?.rotate),
                    audioStreams,
                    sourceFormat,
                });
            } catch {
                finish(null);
            }
        });

        proc.on('error', () => finish(null));
    });
}

async function runCutterFfmpegProbe(args: string[], captureOutput: boolean): Promise<{ success: boolean; output: string }> {
    const ffmpegPath = await getFFmpegPath();
    if (appShutdownStarted) return { success: false, output: '' };
    return await new Promise((resolve) => {
        recordManagedToolExecution('ffmpeg', ffmpegPath);
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        currentCutterProbeProcesses.add(proc);
        proc.stderr?.resume();
        let output = '';
        let settled = false;
        const finish = (success: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            currentCutterProbeProcesses.delete(proc);
            resolve({ success, output });
        };
        const timeout = setTimeout(() => {
            try { proc.kill(); } catch { }
            finish(false);
        }, captureOutput ? 8000 : 5000);
        if (captureOutput) proc.stdout?.on('data', (chunk) => { output += chunk.toString(); });
        proc.on('close', (code) => finish(code === 0));
        proc.on('error', () => finish(false));
    });
}

async function getCutterHardwareEncoders(): Promise<CutterHardwareEncoder[]> {
    if (cutterHardwareEncoderProbe) return await cutterHardwareEncoderProbe;
    cutterHardwareEncoderProbe = (async (): Promise<CutterHardwareEncoder[]> => {
        if (!await ensureFfmpegInstalled()) return [];
        const inventory = await runCutterFfmpegProbe(['-hide_banner', '-encoders'], true);
        if (!inventory.success) return [];
        return await probeCutterHardwareEncoders(parseCutterHardwareEncoders(inventory.output), async (_encoder, args) => {
            const probe = await runCutterFfmpegProbe([...args], false);
            return probe.success;
        });
    })();
    try {
        return await cutterHardwareEncoderProbe;
    } catch {
        cutterHardwareEncoderProbe = null;
        return [];
    }
}

function cancelCutterMediaPreparation(): void {
    cutterAssetRunGeneration += 1;
    for (const process of currentCutterMediaProcesses) {
        try { process.kill(); } catch { }
    }
}

function cancelCutterMetadataPreparation(): void {
    for (const process of currentCutterProbeProcesses) {
        try { process.kill(); } catch { }
    }
}

function cancelCutterPreviewPreparation(): void {
    for (const process of currentCutterPreviewProcesses) {
        try { process.kill(); } catch { }
    }
}

function cancelCutterWaveformPreparation(): void {
    cutterWaveformGeneration += 1;
    for (const process of currentCutterWaveformProcesses) {
        try { process.kill(); } catch { }
    }
}

async function runEditorMediaProcess(args: string[], runGeneration: number): Promise<boolean> {
    const ffmpegPath = await getFFmpegPath();
    return new Promise((resolve) => {
        if (runGeneration !== cutterAssetRunGeneration || appShutdownStarted) {
            resolve(false);
            return;
        }
        recordManagedToolExecution('ffmpeg', ffmpegPath);
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        currentCutterMediaProcesses.add(proc);
        proc.stderr?.resume();
        let settled = false;
        const finish = (success: boolean): void => {
            if (settled) return;
            settled = true;
            currentCutterMediaProcesses.delete(proc);
            resolve(success && runGeneration === cutterAssetRunGeneration && !appShutdownStarted);
        };
        proc.on('close', (code) => finish(code === 0));
        proc.on('error', () => finish(false));
    });
}

async function runEditorWaveformProcess(args: string[], runGeneration: number): Promise<boolean> {
    const ffmpegPath = await getFFmpegPath();
    return new Promise((resolve) => {
        if (runGeneration !== cutterWaveformGeneration || appShutdownStarted) {
            resolve(false);
            return;
        }
        recordManagedToolExecution('ffmpeg', ffmpegPath);
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        currentCutterWaveformProcesses.add(proc);
        proc.stderr?.resume();
        let settled = false;
        const finish = (success: boolean): void => {
            if (settled) return;
            settled = true;
            currentCutterWaveformProcesses.delete(proc);
            resolve(success && runGeneration === cutterWaveformGeneration && !appShutdownStarted);
        };
        proc.on('close', (code) => finish(code === 0));
        proc.on('error', () => finish(false));
    });
}

async function runEditorPreviewProcess(args: string[], requestGeneration: number): Promise<boolean> {
    const ffmpegPath = await getFFmpegPath();
    return new Promise((resolve) => {
        if (requestGeneration !== cutterMediaRequestGeneration || appShutdownStarted) {
            resolve(false);
            return;
        }
        recordManagedToolExecution('ffmpeg', ffmpegPath);
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        currentCutterPreviewProcesses.add(proc);
        proc.stderr?.resume();
        let settled = false;
        const finish = (success: boolean): void => {
            if (settled) return;
            settled = true;
            currentCutterPreviewProcesses.delete(proc);
            resolve(success && requestGeneration === cutterMediaRequestGeneration && !appShutdownStarted);
        };
        proc.on('close', (code) => finish(code === 0));
        proc.on('error', () => finish(false));
    });
}

function removeCutterPreviewDirectory(directory: string | null): void {
    if (!directory) return;
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { }
}

function createVideoEditorPreview(filePath: string, info: VideoInfo, requestGeneration: number): Promise<{ sourceUrl: string; directory: string } | null> {
    const directory = fs.mkdtempSync(path.join(app.getPath('temp'), `tvm-editor-preview-${process.pid}-`));
    const previewFile = path.join(directory, 'preview.mp4');
    const copyVideo = !info.sourceFormat.hdr && info.sourceFormat.bitDepth === 8 && ['h264', 'av1', 'vp9'].includes(info.videoCodec);
    const copyAudio = !info.audioCodec || ['aac', 'mp3'].includes(info.audioCodec);
    const args = ['-fflags', '+genpts', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?'];
    if (copyVideo) args.push('-c:v', 'copy');
    else {
        const format = cutterVideoFormat(info.sourceFormat, false, 'sdr');
        if (format.filters.length) args.push('-vf', format.filters.join(','));
        args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', ...format.args);
    }
    if (info.hasAudio) {
        if (copyAudio) args.push('-c:a', 'copy');
        else args.push('-c:a', 'aac', '-b:a', '160k');
    } else {
        args.push('-an');
    }
    args.push('-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', previewFile);
    return runEditorPreviewProcess(args, requestGeneration).then((success) => {
        if (!success || !fs.existsSync(previewFile) || fs.statSync(previewFile).size <= 256) {
            removeCutterPreviewDirectory(directory);
            return null;
        }
        return { sourceUrl: pathToFileURL(previewFile).href, directory };
    });
}

function readImageDataUrl(filePath: string): string | null {
    if (!fs.existsSync(filePath)) return null;
    const extension = path.extname(filePath).toLowerCase();
    const mediaType = extension === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mediaType};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

async function prepareVideoEditorMedia(filePath: string): Promise<VideoEditorMedia | null> {
    if (appShutdownStarted || typeof filePath !== 'string' || !path.isAbsolute(filePath) || !isSupportedVideoEditorInput(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const requestGeneration = ++cutterMediaRequestGeneration;
    cancelCutterPreviewPreparation();
    cancelCutterMetadataPreparation();
    const identityBefore = getCutterInputIdentity(filePath);
    if (!identityBefore) return null;
    const info = await getVideoInfo(filePath, currentCutterProbeProcesses);
    const identityAfter = getCutterInputIdentity(filePath);
    if (!info || requestGeneration !== cutterMediaRequestGeneration || !cutterInputIdentitiesMatch(identityBefore, identityAfter) || appShutdownStarted) return null;
    const preview = info.previewCompatible
        ? { sourceUrl: pathToFileURL(filePath).href, directory: null }
        : await createVideoEditorPreview(filePath, info, requestGeneration);
    if (!preview || requestGeneration !== cutterMediaRequestGeneration || !cutterInputIdentitiesMatch(identityBefore, getCutterInputIdentity(filePath)) || appShutdownStarted) {
        removeCutterPreviewDirectory(preview?.directory || null);
        return null;
    }
    cancelCutterMediaPreparation();
    cancelCutterWaveformPreparation();
    removeCutterPreviewDirectory(cutterMediaJob?.previewDirectory || null);
    const jobId = ++cutterMediaGeneration;
    cutterMediaJob = { jobId, path: identityAfter!.path, identity: identityAfter!, info, waveform: null, waveformPromise: null, previewDirectory: preview.directory };
    return {
        sourceUrl: preview.sourceUrl,
        info,
        jobId,
        thumbnails: [],
        waveform: null,
    };
}

async function prepareVideoEditorWaveform(filePath: string, jobId: number): Promise<VideoEditorWaveform | null> {
    const job = cutterMediaJob;
    if (appShutdownStarted || typeof filePath !== 'string' || !path.isAbsolute(filePath) || !Number.isInteger(jobId) || !job || jobId !== job.jobId || normalizeComparablePath(filePath) !== job.path || !cutterInputIdentitiesMatch(getCutterInputIdentity(filePath), job.identity)) return null;
    if (!job.info.hasAudio) return { jobId, waveform: null, pixelWidth: 32000, pixelHeight: 240 };
    if (job.waveform) return job.waveform;
    if (job.waveformPromise) return await job.waveformPromise;
    const runGeneration = cutterWaveformGeneration;
    const promise = (async (): Promise<VideoEditorWaveform | null> => {
        const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), `tvm-editor-waveform-${process.pid}-`));
        const waveformFile = path.join(tempDir, 'waveform.png');
        const channels = Math.max(1, Math.min(8, job.info.audioStreams[0]?.channels || 1));
        const pixelHeight = Math.max(192, channels * 96);
        try {
            const success = await runEditorWaveformProcess([
                '-i', filePath,
                '-filter_complex_threads', '1',
                '-filter_complex', `[0:a:0]showwavespic=s=32000x${pixelHeight}:split_channels=1:colors=white:scale=sqrt:filter=peak:draw=full`,
                '-frames:v', '1',
                '-y', waveformFile,
            ], runGeneration);
            if (!success || runGeneration !== cutterWaveformGeneration || cutterMediaJob !== job || !cutterInputIdentitiesMatch(getCutterInputIdentity(filePath), job.identity) || appShutdownStarted) return null;
            const waveform = readImageDataUrl(waveformFile);
            if (!waveform) return null;
            const result = { jobId, waveform, pixelWidth: 32000, pixelHeight, channels };
            job.waveform = result;
            return result;
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    })();
    job.waveformPromise = promise;
    const result = await promise;
    if (cutterMediaJob === job && job.waveformPromise === promise) job.waveformPromise = null;
    return result;
}

async function prepareVideoEditorAssets(filePath: string, jobId: number, profile: VideoEditorAssetProfile): Promise<VideoEditorAssets | null> {
    if (appShutdownStarted || typeof filePath !== 'string' || !path.isAbsolute(filePath) || !Number.isInteger(jobId) || !profile || !Number.isFinite(profile.timelineWidth) || profile.timelineWidth <= 0 || !Number.isFinite(profile.trackHeight) || profile.trackHeight <= 0 || !Number.isFinite(profile.pixelRatio) || profile.pixelRatio <= 0 || !cutterMediaJob || jobId !== cutterMediaJob.jobId || normalizeComparablePath(filePath) !== cutterMediaJob.path || !cutterInputIdentitiesMatch(getCutterInputIdentity(filePath), cutterMediaJob.identity)) return null;
    cancelCutterMediaPreparation();
    const runGeneration = cutterAssetRunGeneration;
    const info = cutterMediaJob.info;
    const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), `tvm-editor-media-${process.pid}-`));
    const pixelRatio = Math.min(3, Math.max(1, profile.pixelRatio));
    const pixelWidth = info.duration <= 120 ? 32000 : Math.round(Math.min(32000, Math.max(1800, Math.ceil(profile.timelineWidth * pixelRatio))));
    const thumbnailCount = info.duration <= 120 ? 200 : Math.round(Math.min(100, Math.max(30, Math.ceil(pixelWidth / 320))));
    const thumbnailTileWidth = Math.max(428, Math.ceil(pixelWidth / thumbnailCount / 2) * 2);
    const thumbnailTileHeight = 240;
    try {
        const thumbnailsReady = await runEditorMediaProcess([
            '-threads', '2',
            '-i', filePath,
            '-filter_threads', '1',
            '-vf', `fps=${thumbnailCount / info.duration},${info.sourceFormat.hdr ? cutterVideoFormat(info.sourceFormat, false, 'sdr').filters.join(',') + ',' : ''}scale=${thumbnailTileWidth}:${thumbnailTileHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${thumbnailTileWidth}:${thumbnailTileHeight}`,
            '-frames:v', String(thumbnailCount),
            '-q:v', '2',
            '-start_number', '1',
            '-y', path.join(tempDir, 'thumb-%03d.jpg'),
        ], runGeneration);
        if (runGeneration !== cutterAssetRunGeneration || !cutterMediaJob || jobId !== cutterMediaJob.jobId || !cutterInputIdentitiesMatch(getCutterInputIdentity(filePath), cutterMediaJob.identity) || appShutdownStarted) return null;
        if (!thumbnailsReady) return null;
        const thumbnails = fs.readdirSync(tempDir)
            .filter((name) => /^thumb-\d+\.jpg$/i.test(name))
            .sort()
            .map((name) => readImageDataUrl(path.join(tempDir, name)))
            .filter((value): value is string => Boolean(value));
        if (thumbnails.length < Math.floor(thumbnailCount * 0.95)) return null;
        return {
            jobId,
            thumbnails,
            thumbnailSprite: null,
            thumbnailCount: thumbnails.length,
            pixelWidth,
            pixelHeight: thumbnailTileHeight,
        };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function getCutterInputIdentity(filePath: string): { path: string; size: number; mtimeMs: number; dev: number; ino: number } | null {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return null;
        return { path: normalizeComparablePath(filePath), size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    } catch {
        return null;
    }
}

function getCutterProjectSource(filePath: string): CutterProjectSource | null {
    const identity = getCutterInputIdentity(filePath);
    return identity ? { path: identity.path, size: identity.size, mtimeMs: identity.mtimeMs } : null;
}

function isCutterExportProfile(value: unknown): value is CutterExportProfile {
    return value === 'quality' || value === 'balanced' || value === 'fast' || value === 'archive';
}

function isCutterExportEncoder(value: unknown): value is CutterExportEncoder {
    return value === 'software' || value === 'h264_nvenc' || value === 'h264_qsv' || value === 'h264_amf';
}

function createCutterProject(filePath: string, info: VideoInfo, value: unknown): CutterProject | null {
    if (!value || typeof value !== 'object') return null;
    const project = value as Record<string, unknown>;
    const profile = project.profile;
    const encoder = project.encoder;
    const audioStreamIndex = project.audioStreamIndex;
    if ((project.allAudioStreams !== undefined && typeof project.allAudioStreams !== 'boolean') || (project.colorMode !== undefined && project.colorMode !== 'source' && project.colorMode !== 'sdr')) return null;
    const trimStart = project.trimStart;
    const trimEnd = project.trimEnd;
    const cuts = project.cuts;
    const source = getCutterProjectSource(filePath);
    if (!source
        || !isCutterExportProfile(profile)
        || !isCutterExportEncoder(encoder)
        || typeof audioStreamIndex !== 'number' || !Number.isInteger(audioStreamIndex) || audioStreamIndex < 0
        || typeof trimStart !== 'number' || !Number.isFinite(trimStart)
        || typeof trimEnd !== 'number' || !Number.isFinite(trimEnd)
        || !Array.isArray(cuts) || cuts.length > 64
        || cuts.some((cut) => !isPlainObject(cut)
            || typeof cut.id !== 'string'
            || typeof cut.start !== 'number' || !Number.isFinite(cut.start)
            || typeof cut.end !== 'number' || !Number.isFinite(cut.end))) {
        return null;
    }
    const hasSelectedAudio = info.audioStreams.some((stream) => stream.index === audioStreamIndex);
    if ((info.hasAudio && !hasSelectedAudio) || (!info.hasAudio && audioStreamIndex !== 0)) return null;
    let state = setTrimRange(createVideoEditorState(info.duration, info.fps), trimStart, trimEnd);
    if (Math.abs(state.trimStart - trimStart) > 1 / info.fps || Math.abs(state.trimEnd - trimEnd) > 1 / info.fps) return null;
    try {
        for (const cut of cuts) {
            state = addCutAt(state, cut.start, cut.end - cut.start).state;
        }
    } catch {
        return null;
    }
    if (!validAudioProcessing(project.audioProcessing, getPlayableSegments(state).reduce((sum, segment) => sum + segment.end - segment.start, 0))) return null;
    return {
        source,
        ...(project.audioProcessing ? { audioProcessing: { ...project.audioProcessing as AudioProcessingOptions } } : {}),
        duration: info.duration,
        fps: info.fps,
        trimStart: state.trimStart,
        trimEnd: state.trimEnd,
        cuts: state.cuts.map((cut) => ({ ...cut })),
        profile,
        encoder,
        audioStreamIndex,
        allAudioStreams: project.allAudioStreams === true,
        colorMode: project.colorMode === 'sdr' ? 'sdr' : 'source',
    };
}

function cutterInputIdentityMatches(filePath: string): boolean {
    const current = getCutterInputIdentity(filePath);
    return cutterInputIdentitiesMatch(current, cutterPreparedInput);
}

function cutterInputIdentitiesMatch(
    left: { path: string; size: number; mtimeMs: number; dev: number; ino: number } | null,
    right: { path: string; size: number; mtimeMs: number; dev: number; ino: number } | null,
): boolean {
    return Boolean(left && right
        && left.path === right.path
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.dev === right.dev
        && left.ino === right.ino);
}

function normalizeComparablePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    let canonical = resolved;
    try { canonical = fs.realpathSync.native(resolved); } catch {
        try {
            const parent = fs.realpathSync.native(path.dirname(resolved));
            canonical = path.join(parent, path.basename(resolved));
        } catch { }
    }
    return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}

function pathsReferToSameFile(left: string, right: string): boolean {
    if (normalizeComparablePath(left) === normalizeComparablePath(right)) return true;
    if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
    try {
        const leftStat = fs.statSync(left);
        const rightStat = fs.statSync(right);
        return leftStat.dev === rightStat.dev && leftStat.ino !== 0 && leftStat.ino === rightStat.ino;
    } catch {
        return false;
    }
}

function publishVideoEditorOutput(partialFile: string, outputFile: string): void {
    const backupFile = `${outputFile}.${process.pid}.${Date.now()}.tvm-backup`;
    const hadExistingOutput = fs.existsSync(outputFile);
    if (hadExistingOutput) fs.renameSync(outputFile, backupFile);
    try {
        fs.renameSync(partialFile, outputFile);
        if (hadExistingOutput) {
            try { fs.rmSync(backupFile, { force: true }); } catch { }
        }
    } catch (error) {
        if (hadExistingOutput && fs.existsSync(backupFile) && !fs.existsSync(outputFile)) fs.renameSync(backupFile, outputFile);
        throw error;
    }
}

async function performVideoEditExport(request: VideoEditExportRequest, onProgress: (percent: number) => void): Promise<boolean> {
    if (appShutdownStarted) return false;
    if (!request || typeof request.inputFile !== 'string' || typeof request.outputFile !== 'string') return false;
    if (!path.isAbsolute(request.inputFile) || !path.isAbsolute(request.outputFile) || !fs.existsSync(request.inputFile)) return false;
    if (!isCutterExportProfile(request.profile) || !isCutterExportEncoder(request.encoder)) return false;
    const profile = getCutterExportProfile(request.profile);
    const outputExtension = `.${profile.container}`;
    if (path.extname(request.outputFile).toLowerCase() !== outputExtension || pathsReferToSameFile(request.inputFile, request.outputFile)) return false;
    if (!Number.isFinite(request.trimStart) || !Number.isFinite(request.trimEnd) || !Array.isArray(request.cuts) || request.cuts.length > 64) return false;
    if (request.cuts.some((cut) => !isPlainObject(cut) || typeof cut.id !== 'string' || !Number.isFinite(cut.start) || !Number.isFinite(cut.end))) return false;
    const inputIdentity = getCutterInputIdentity(request.inputFile);
    if (!cutterInputIdentitiesMatch(inputIdentity, cutterPreparedInput)) return false;
    const info = await getVideoInfo(request.inputFile, currentCutterExportProcesses);
    if (!info || cutterExportCancelled) return false;
    if (!Number.isInteger(request.audioStreamIndex) || request.audioStreamIndex < 0) return false;
    if ((info.hasAudio && !info.audioStreams.some((stream) => stream.index === request.audioStreamIndex)) || (!info.hasAudio && request.audioStreamIndex !== 0)) return false;
    const audioStreamIndices = info.hasAudio ? request.allAudioStreams ? info.audioStreams.map(stream => stream.index) : [request.audioStreamIndex] : [];
    let state = setTrimRange(createVideoEditorState(info.duration, info.fps), request.trimStart, request.trimEnd);
    if (Math.abs(state.trimStart - request.trimStart) > 1 / info.fps || Math.abs(state.trimEnd - request.trimEnd) > 1 / info.fps) return false;
    try {
        for (const cut of request.cuts) {
            state = addCutAt(state, cut.start, cut.end - cut.start).state;
        }
    } catch {
        return false;
    }
    const segments = getPlayableSegments(state);
    if (segments.length === 0) return false;
    const outputDir = path.dirname(request.outputFile);
    if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) return false;
    const inputBytes = fs.statSync(request.inputFile).size;
    const diskCheck = ensureDiskSpace(outputDir, Math.max(128 * 1024 * 1024, Math.ceil(inputBytes * 1.25)), 'Video-Editor');
    if (!diskCheck.success) return false;
    const partialFile = path.join(outputDir, `.${path.basename(request.outputFile, outputExtension)}.${process.pid}.${Date.now()}.tvm-edit${outputExtension}`);
    const availableHardwareEncoders = request.encoder === 'software' ? [] : await getCutterHardwareEncoders();
    let plan = createCutterExportPlan({
        inputFile: request.inputFile,
        outputFile: partialFile,
        segments,
        hasAudio: info.hasAudio,
        profile: request.profile,
        encoder: request.encoder,
        availableHardwareEncoders,
        audioStreamIndex: request.audioStreamIndex,
        audioStreamIndices,
        audioStreams: info.audioStreams,
        sourceFormat: info.sourceFormat,
        colorMode: request.colorMode,
        audioProcessing: request.audioProcessing,
        rotation: info.rotation,
    });
    if (plan.filterComplex.length > 24000 || cutterExportCancelled) return false;
    currentCutterPartialFile = partialFile;
    const ffmpegPath = await getFFmpegPath();
    if (cutterExportCancelled || appShutdownStarted) return false;
    const runPlan = async (activePlan: ReturnType<typeof createCutterExportPlan>): Promise<boolean> => await new Promise<boolean>((resolve) => {
        recordManagedToolExecution('ffmpeg', ffmpegPath);
        const proc = spawn(ffmpegPath, activePlan.ffmpegArgs, { windowsHide: true });
        currentCutterProcess = proc;
        currentCutterExportProcesses.add(proc);
        proc.stderr?.resume();
        let stdout = '';
        proc.stdout?.on('data', (data) => {
            stdout += data.toString();
            const lines = stdout.split(/\r?\n/);
            stdout = lines.pop() || '';
            for (const line of lines) {
                const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
                if (match) onProgress(calculateCutterExportProgress(Number(match[1]) / 1_000_000, activePlan));
            }
        });
        proc.on('close', (code) => {
            currentCutterExportProcesses.delete(proc);
            if (currentCutterProcess === proc) currentCutterProcess = null;
            resolve(code === 0 && !cutterExportCancelled);
        });
        proc.on('error', () => {
            currentCutterExportProcesses.delete(proc);
            if (currentCutterProcess === proc) currentCutterProcess = null;
            resolve(false);
        });
    });
    let success = await runPlan(plan);
    if (!success && !cutterExportCancelled && !plan.selectedEncoder.startsWith('lib') && plan.selectedEncoder !== 'ffv1') {
        try { fs.rmSync(partialFile, { force: true }); } catch { }
        plan = createCutterExportPlan({
            inputFile: request.inputFile,
            outputFile: partialFile,
            segments,
            hasAudio: info.hasAudio,
            profile: request.profile,
            encoder: 'software',
            audioStreamIndex: request.audioStreamIndex,
        audioStreamIndices,
        audioStreams: info.audioStreams,
        sourceFormat: info.sourceFormat,
        colorMode: request.colorMode,
        audioProcessing: request.audioProcessing,
            rotation: info.rotation,
        });
        success = await runPlan(plan);
    }
    if (!success || !fs.existsSync(partialFile) || fs.statSync(partialFile).size <= 256) {
        fs.rmSync(partialFile, { force: true });
        currentCutterPartialFile = null;
        return false;
    }
    if (cutterExportCancelled) {
        fs.rmSync(partialFile, { force: true });
        currentCutterPartialFile = null;
        return false;
    }
    const outputInfo = await getVideoInfo(partialFile, currentCutterExportProcesses);
    if (cutterExportCancelled || !outputInfo || Math.abs(outputInfo.duration - plan.remainingDuration) > Math.max(0.12, 3 / info.fps)
        || outputInfo.audioStreams.length !== plan.audioStreamIndices.length
        || outputInfo.sourceFormat.bitDepth < plan.bitDepth
        || outputInfo.sourceFormat.hdr !== plan.hdr) {
        fs.rmSync(partialFile, { force: true });
        currentCutterPartialFile = null;
        return false;
    }
    if (cutterExportCancelled || pathsReferToSameFile(request.inputFile, request.outputFile) || !cutterInputIdentitiesMatch(getCutterInputIdentity(request.inputFile), inputIdentity)) {
        fs.rmSync(partialFile, { force: true });
        currentCutterPartialFile = null;
        return false;
    }
    publishVideoEditorOutput(partialFile, request.outputFile);
    currentCutterPartialFile = null;
    onProgress(100);
    return true;
}

async function exportVideoEdit(request: VideoEditExportRequest, onProgress: (percent: number) => void): Promise<{ success: boolean; cancelled: boolean }> {
    if (cutterExportActive || appShutdownStarted || applicationBackupBusy || applicationWorkflowBusy()) return { success: false, cancelled: false };
    cutterExportActive = true;
    cutterExportCancelled = false;
    try {
        const success = await performVideoEditExport(request, onProgress);
        return { success, cancelled: !success && cutterExportCancelled };
    } catch (error) {
        appendDebugLog('video-editor-export-failed', String(error));
        return { success: false, cancelled: cutterExportCancelled };
    } finally {
        cutterExportActive = false;
        cutterExportCancelled = false;
        if (currentCutterPartialFile && !currentCutterProcess) {
            try { fs.rmSync(currentCutterPartialFile, { force: true }); } catch { }
            currentCutterPartialFile = null;
        }
    }
}

// ==========================================
// VIDEO CUTTER
// ==========================================
async function extractFrame(filePath: string, timeSeconds: number): Promise<string | null> {
    if (appShutdownStarted) return null;
    const ffmpegReady = await ensureFfmpegInstalled();
    if (!ffmpegReady || appShutdownStarted) {
        appendDebugLog('extract-frame-missing-ffmpeg');
        return null;
    }

    const ffmpeg = await getFFmpegPath();
    if (appShutdownStarted) return null;
    return new Promise((resolve) => {
        const tempFile = path.join(app.getPath('temp'), `frame_${process.pid}_${Date.now()}.jpg`);

        const args = [
            '-ss', timeSeconds.toString(),
            '-i', filePath,
            '-vframes', '1',
            '-q:v', '2',
            '-y',
            tempFile
        ];

        let proc: ChildProcess;
        try {
            recordManagedToolExecution('ffmpeg', ffmpeg);
            proc = spawn(ffmpeg, args, { windowsHide: true });
        } catch {
            resolve(null);
            return;
        }
        let settled = false;
        currentCutterFrameProcesses.add(proc);
        currentCutterFrameFiles.add(tempFile);
        proc.stderr?.resume();

        const finish = (code: number | null): void => {
            if (settled) return;
            settled = true;
            currentCutterFrameProcesses.delete(proc);
            currentCutterFrameFiles.delete(tempFile);
            let frame: string | null = null;
            try {
                if (code === 0 && !appShutdownStarted && fs.existsSync(tempFile)) {
                    frame = `data:image/jpeg;base64,${fs.readFileSync(tempFile).toString('base64')}`;
                }
            } catch { }
            try { fs.rmSync(tempFile, { force: true }); } catch { }
            resolve(frame);
        };

        proc.once('close', finish);
        proc.once('error', () => finish(null));
    });
}

// Concatenates same-codec mp4 files into a single output via ffmpeg's
// concat demuxer. No re-encoding — purely a container stitch, which is
// what we want for resumed-recording parts (same streamlink, same codec
// settings, just split across files). Returns false on any error so the
// caller can keep the original parts.
async function concatVideoFiles(inputFiles: string[], outputFile: string, itemId: string | null = null): Promise<boolean> {
    if (inputFiles.length < 2) return false;
    const ffmpegReady = await ensureFfmpegInstalled();
    if (!ffmpegReady) return false;

    for (const f of inputFiles) {
        if (!fs.existsSync(f)) {
            appendDebugLog('concat-missing-part', { missing: f });
            return false;
        }
    }

    const listFile = path.join(path.dirname(outputFile), `.concat-${Date.now()}.txt`);
    try {
        // ffmpeg concat demuxer escaping: paths go in single quotes, embedded
        // single quotes need '\''. Backslashes are fine on Windows.
        const lines = inputFiles
            .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
            .join('\n');
        fs.writeFileSync(listFile, lines, 'utf8');
    } catch (e) {
        appendDebugLog('concat-listfile-write-failed', String(e));
        return false;
    }

    const ffmpeg = await getFFmpegPath();
    const args = [
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c', 'copy',
        '-y',
        outputFile
    ];

    try {
        const success = await new Promise<boolean>((resolve) => {
                recordManagedToolExecution('ffmpeg', ffmpeg);
                const proc = spawn(ffmpeg, args, { windowsHide: true });
                const registration = itemId
                    ? queueProcessRegistry.register(itemId, 'post-processing', createPhaseBoundaryProcessResource(
                        proc,
                        () => waitForChildProcessExit(proc),
                        () => {
                            try { fs.rmSync(outputFile, { force: true }); } catch { }
                            try { fs.rmSync(listFile, { force: true }); } catch { }
                        },
                    ))
                    : null;
                if (registration && !registration.accepted) {
                    proc.once('error', () => undefined);
                    resolve(false);
                    return;
                }
                let stderrBuf = '';
                proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
                proc.on('close', (code) => {
                    registration?.release();
                    if (code === 0 && (!itemId || !queueProcessRegistry.isCancelled(itemId)) && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0) {
                        appendDebugLog('concat-ok', { output: outputFile, parts: inputFiles.length });
                        resolve(true);
                    } else {
                        appendDebugLog('concat-failed', { code, stderrTail: stderrBuf.slice(-400) });
                        try { fs.rmSync(outputFile, { force: true }); } catch { }
                        resolve(false);
                    }
                });
                proc.on('error', (err) => {
                    registration?.release();
                    appendDebugLog('concat-spawn-error', String(err));
                    resolve(false);
                });
        });
        if (itemId && queueProcessRegistry.isPaused(itemId) && !(await waitForQueuePhaseBoundary(itemId))) {
            try { fs.rmSync(outputFile, { force: true }); } catch { }
            return false;
        }
        if (!success) return false;
        if (!(await waitForQueuePhaseBoundary(itemId))) {
            try { fs.rmSync(outputFile, { force: true }); } catch { }
            return false;
        }
        return true;
    } finally {
        try { fs.rmSync(listFile, { force: true }); } catch { }
    }
}

async function cutVideo(
    inputFile: string,
    outputFile: string,
    startTime: number,
    endTime: number,
    onProgress: (percent: number) => void
): Promise<boolean> {
    if (appShutdownStarted) return false;
    const ffmpegReady = await ensureFfmpegInstalled();
    if (appShutdownStarted) return false;
    if (!ffmpegReady) {
        appendDebugLog('cut-video-missing-ffmpeg');
        return false;
    }

    const ffmpeg = await getFFmpegPath();
    const duration = Math.max(0.1, endTime - startTime);

    let inputBytes = 0;
    try {
        inputBytes = fs.statSync(inputFile).size;
    } catch { }

    const cutRequiredBytes = Math.max(96 * 1024 * 1024, Math.ceil(inputBytes * 0.75));
    const cutDiskCheck = ensureDiskSpace(path.dirname(outputFile), cutRequiredBytes, 'Video-Cut');
    if (!cutDiskCheck.success) {
        appendDebugLog('cut-video-no-disk-space', {
            inputFile,
            outputFile,
            requiredBytes: cutRequiredBytes,
            error: cutDiskCheck.error
        });
        return false;
    }

    const runCutAttempt = async (copyMode: boolean): Promise<boolean> => {
        if (appShutdownStarted) return false;
        const args = [
            '-ss', formatDuration(startTime),
            '-i', inputFile,
            '-t', formatDuration(duration)
        ];

        if (copyMode) {
            args.push('-c', 'copy');
        } else {
            args.push(
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '20',
                '-c:a', 'aac',
                '-b:a', '160k',
                '-movflags', '+faststart'
            );
        }

        args.push('-progress', 'pipe:1', '-y', outputFile);

        appendDebugLog('cut-video-attempt', { copyMode, args });

        return await new Promise((resolve) => {
            recordManagedToolExecution('ffmpeg', ffmpeg);
            const proc = spawn(ffmpeg, args, { windowsHide: true });
            currentEditorProcesses.add(proc);

            proc.stdout?.on('data', (data) => {
                const line = data.toString();
                const match = line.match(/out_time_us=(\d+)/);
                if (match) {
                    const currentUs = parseInt(match[1], 10);
                    const percent = Math.min(100, (currentUs / 1000000) / duration * 100);
                    onProgress(percent);
                }
            });

            proc.on('close', (code) => {
                currentEditorProcesses.delete(proc);
                if (!appShutdownStarted && code === 0 && fs.existsSync(outputFile)) {
                    const stats = fs.statSync(outputFile);
                    if (stats.size <= 256) {
                        appendDebugLog('cut-video-empty-output', { outputFile, bytes: stats.size });
                        resolve(false);
                        return;
                    }
                    resolve(true);
                } else {
                    resolve(false);
                }
            });

            proc.on('error', () => {
                currentEditorProcesses.delete(proc);
                resolve(false);
            });
        });
    };

    const copySuccess = await runCutAttempt(true);
    if (appShutdownStarted) return false;
    if (copySuccess) {
        return true;
    }

    appendDebugLog('cut-video-copy-failed-fallback-reencode', { inputFile, outputFile });
    try {
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch { }

    return await runCutAttempt(false);
}

// ==========================================
// MERGE VIDEOS
// ==========================================
async function mergeVideos(
    inputFiles: string[],
    outputFile: string,
    onProgress: (percent: number) => void,
    totalDurationSec?: number,
    itemId: string | null = null
): Promise<boolean> {
    if (appShutdownStarted) return false;
    const ffmpegReady = await ensureFfmpegInstalled();
    if (appShutdownStarted) return false;
    if (!ffmpegReady) {
        appendDebugLog('merge-videos-missing-ffmpeg');
        return false;
    }

    const ffmpeg = await getFFmpegPath();
    if (appShutdownStarted) return false;
    const concatFile = path.join(app.getPath('temp'), `concat_${Date.now()}.txt`);
    const concatContent = inputFiles.map((filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        return `file '${normalized.replace(/'/g, "'\\''")}'`;
    }).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    let mergeInputBytes = 0;
    for (const filePath of inputFiles) {
        try {
            mergeInputBytes += fs.statSync(filePath).size;
        } catch {
            // ignore missing file in estimation
        }
    }

    const mergeRequiredBytes = Math.max(128 * 1024 * 1024, Math.ceil(mergeInputBytes * 1.1));
    const mergeDiskCheck = ensureDiskSpace(path.dirname(outputFile), mergeRequiredBytes, 'Video-Merge');
    if (!mergeDiskCheck.success) {
        appendDebugLog('merge-video-no-disk-space', {
            outputFile,
            files: inputFiles.length,
            requiredBytes: mergeRequiredBytes,
            error: mergeDiskCheck.error
        });
        try {
            fs.unlinkSync(concatFile);
        } catch { }
        return false;
    }

    // Determine total duration for accurate progress
    let mergeTotalDurationUs = 0;
    if (totalDurationSec && totalDurationSec > 0) {
        mergeTotalDurationUs = totalDurationSec * 1_000_000;
    } else {
        for (const filePath of inputFiles) {
            if (appShutdownStarted) break;
            const info = await getVideoInfo(filePath, currentEditorProcesses, 10000);
            if (info && Number.isFinite(info.duration)) mergeTotalDurationUs += info.duration * 1_000_000;
        }
    }

    const runMergeAttempt = async (): Promise<boolean> => {
        if (appShutdownStarted) return false;
        const args = ['-f', 'concat', '-safe', '0', '-i', concatFile, '-map', '0', '-c', 'copy'];

        args.push('-progress', 'pipe:1', '-y', outputFile);
        appendDebugLog('merge-video-attempt', { argsCount: args.length });

        return await new Promise((resolve) => {
            recordManagedToolExecution('ffmpeg', ffmpeg);
            const proc = spawn(ffmpeg, args, { windowsHide: true });
            const registration = itemId
                ? queueProcessRegistry.register(itemId, 'merge', createPhaseBoundaryProcessResource(
                    proc,
                    () => waitForChildProcessExit(proc),
                    () => {
                        try { fs.rmSync(outputFile, { force: true }); } catch { }
                        try { fs.rmSync(concatFile, { force: true }); } catch { }
                    },
                ))
                : null;
            if (registration && !registration.accepted) {
                proc.once('error', () => undefined);
                resolve(false);
                return;
            }
            if (!itemId) currentEditorProcesses.add(proc);

            proc.stdout?.on('data', (data) => {
                const line = data.toString();
                const match = line.match(/out_time_us=(\d+)/);
                if (match) {
                    const currentUs = parseInt(match[1], 10);
                    if (mergeTotalDurationUs > 0) {
                        onProgress(Math.min(99, (currentUs / mergeTotalDurationUs) * 100));
                    } else {
                        onProgress(Math.min(99, currentUs / 10000000));
                    }
                }
            });

            proc.on('close', (code) => {
                registration?.release();
                if (!itemId) currentEditorProcesses.delete(proc);
                const success = !appShutdownStarted && code === 0 && (!itemId || !queueProcessRegistry.isCancelled(itemId)) && fs.existsSync(outputFile);
                if (success) {
                    onProgress(100);
                }
                resolve(success);
            });

            proc.on('error', () => {
                registration?.release();
                if (!itemId) currentEditorProcesses.delete(proc);
                resolve(false);
            });
        });
    };

    try {
        const copySuccess = await runMergeAttempt();
        if (appShutdownStarted) return false;
        if (copySuccess) {
            return true;
        }

        if (itemId && queueProcessRegistry.isCancelled(itemId)) {
            try { fs.rmSync(outputFile, { force: true }); } catch { }
            return false;
        }

        const boundaryReady = await waitForQueuePhaseBoundary(itemId);
        if (appShutdownStarted || !boundaryReady) {
            try { fs.rmSync(outputFile, { force: true }); } catch { }
            return false;
        }

        appendDebugLog('merge-video-copy-failed', { outputFile, files: inputFiles.length });
        try { fs.rmSync(outputFile, { force: true }); } catch { }
        return false;
    } finally {
        try {
            fs.unlinkSync(concatFile);
        } catch { }
    }
}

// ==========================================
// SPLIT MERGED FILE
// ==========================================
async function splitMergedFile(
    inputFile: string,
    outputFolder: string,
    partDurationSec: number,
    totalDurationSec: number,
    filenameGenerator: (partNum: number) => string,
    onProgress: (currentPart: number, totalParts: number) => void,
    onPartState: (partIndex: number, outputFile: string, temporaryFile: string | null) => void,
    itemId: string | null = null
): Promise<{ success: boolean; files: string[] }> {
    if (appShutdownStarted) return { success: false, files: [] };
    const ffmpegReady = await ensureFfmpegInstalled();
    if (appShutdownStarted) return { success: false, files: [] };
    if (!ffmpegReady) {
        appendDebugLog('split-merged-missing-ffmpeg');
        return { success: false, files: [] };
    }

    const ffmpeg = await getFFmpegPath();
    if (appShutdownStarted) return { success: false, files: [] };
    const numParts = Math.ceil(totalDurationSec / partDurationSec);
    const splitFiles: string[] = [];

    for (let i = 0; i < numParts; i++) {
        if (itemId && cancelledItemIds.has(itemId)) {
            return { success: false, files: splitFiles };
        }

        const startSec = i * partDurationSec;
        const thisDuration = Math.min(partDurationSec, totalDurationSec - startSec);
        const outputFile = ensureUniqueFilename(path.join(outputFolder, filenameGenerator(i + 1)), itemId);
        const temporaryFile = ensureUniqueFilename(path.join(outputFolder, `.merge_split_${Date.now()}_${process.pid}_${i}.mp4`), itemId);

        onPartState(i, outputFile, temporaryFile);
        onProgress(i + 1, numParts);

        const args = [
            '-ss', formatDuration(startSec),
            '-i', inputFile,
            '-t', formatDuration(thisDuration),
            '-c', 'copy',
            '-y', temporaryFile
        ];

        appendDebugLog('split-merged-part', { part: i + 1, total: numParts, startSec, duration: thisDuration });

        const success = await new Promise<boolean>((resolve) => {
            recordManagedToolExecution('ffmpeg', ffmpeg);
            const proc = spawn(ffmpeg, args, { windowsHide: true });
            const registration = itemId
                ? queueProcessRegistry.register(itemId, 'split', createPhaseBoundaryProcessResource(
                    proc,
                    () => waitForChildProcessExit(proc),
                    () => { try { fs.rmSync(temporaryFile, { force: true }); } catch { } },
                ))
                : null;
            if (registration && !registration.accepted) {
                proc.once('error', () => undefined);
                resolve(false);
                return;
            }
            if (!itemId) currentEditorProcesses.add(proc);

            proc.on('close', (code) => {
                registration?.release();
                if (!itemId) currentEditorProcesses.delete(proc);
                resolve(!appShutdownStarted && code === 0 && (!itemId || !queueProcessRegistry.isCancelled(itemId)) && fs.existsSync(temporaryFile));
            });

            proc.on('error', () => {
                registration?.release();
                if (!itemId) currentEditorProcesses.delete(proc);
                resolve(false);
            });
        });

        if (!success) {
            appendDebugLog('split-merged-part-failed', { part: i + 1, outputFile });
            try { fs.rmSync(temporaryFile, { force: true }); } catch { }
            if (!fs.existsSync(temporaryFile)) onPartState(i, '', null);
            return { success: false, files: splitFiles };
        }

        try {
            fs.renameSync(temporaryFile, outputFile);
        } catch {
            try { fs.rmSync(temporaryFile, { force: true }); } catch { }
            if (!fs.existsSync(temporaryFile)) onPartState(i, '', null);
            return { success: false, files: splitFiles };
        }
        onPartState(i, outputFile, null);
        splitFiles.push(outputFile);
        if (itemId) registerQueuePartialFile(itemId, outputFile);
        if (!(await waitForQueuePhaseBoundary(itemId))) {
            return { success: false, files: splitFiles };
        }
    }

    return { success: true, files: splitFiles };
}

// ==========================================
// DOWNLOAD FUNCTIONS
// ==========================================
async function finalizeDownloadedMp4(partialFilename: string, filename: string, itemId: string | null, expectedDuration: number | null, clipTracking?: ActiveClipDownloadTracking): Promise<DownloadResult> {
    const remuxFilename = partialDownloadRegistry.begin(`${filename}.remux`);
    try {
        if (appShutdownStarted || clipTracking?.cancelled || !(await waitForQueuePhaseBoundary(itemId))) throw new Error('Download cancelled');
        const diskCheck = ensureDiskSpace(path.dirname(filename), fs.statSync(partialFilename).size + 32 * 1024 * 1024, 'MP4');
        if (!diskCheck.success) return diskCheck;
        await remuxMp4({
            inputPath: partialFilename,
            outputPath: remuxFilename,
            ffmpegPath: await getFFmpegPath(),
            ffprobePath: await getFFprobePath(),
            onProcess: (process) => {
                if (clipTracking) clipTracking.process = process;
                const remuxRegistration = itemId ? queueProcessRegistry.register(itemId, 'post-processing', createPhaseBoundaryProcessResource(
                    process, () => waitForChildProcessExit(process),
                )) : null;
                if (appShutdownStarted || clipTracking?.cancelled) process.kill();
                return () => remuxRegistration?.release();
            },
        });
        if (appShutdownStarted || clipTracking?.cancelled || !(await waitForQueuePhaseBoundary(itemId))) throw new Error('Download cancelled');
        const integrity = await validateDownloadedFileIntegrity(remuxFilename, expectedDuration);
        if (appShutdownStarted || clipTracking?.cancelled || !(await waitForQueuePhaseBoundary(itemId))) throw new Error('Download cancelled');
        if (!integrity.success) return integrity;
        partialDownloadRegistry.commit(remuxFilename, filename);
        readArchiveInventory.invalidate();
        return { success: true };
    } catch (error) {
        appendDebugLog('mp4-finalization-failed', { itemId, error: String(error) });
        return { success: false, error: tBackend('mp4FinalizationFailed') };
    } finally {
        partialDownloadRegistry.discard(remuxFilename);
        partialDownloadRegistry.discard(partialFilename);
    }
}

async function downloadVODPart(
    url: string,
    filename: string,
    startTime: string | null,
    endTime: string | null,
    onProgress: (progress: DownloadProgress) => void,
    itemId: string,
    partNum: number,
    totalParts: number,
    expectedTotalSec: number = 0,
    quality?: string
): Promise<DownloadResult> {
    if (!(await ensureFfmpegInstalled())) return { success: false, error: tBackend('ffmpegAutoInstallFailed') };
    if (appShutdownStarted || !(await waitForQueuePhaseBoundary(itemId))) return { success: false, error: tBackend('downloadCancelled') };
    const requestedQuality = quality ?? config.streamlink_quality;
    const directSource = await resolveVodQualitySource(url, requestedQuality);
    const streamlinkCmd = directSource ? { command: '', prefixArgs: [] } : await getStreamlinkCommand();
    const ffmpegPath = directSource ? await getFFmpegPath() : null;
    if (appShutdownStarted || !(await waitForQueuePhaseBoundary(itemId))) return { success: false, error: tBackend('downloadCancelled') };
    return new Promise((resolve) => {
        const command = directSource ? ffmpegPath! : streamlinkCmd.command;
        const args = [...streamlinkCmd.prefixArgs, ...TWITCH_VIDEO_CODEC_ARGS, url, getStreamlinkStreamArg(quality), '--stdout'];
        if (directSource) {
            args.length = 0;
            args.push(...buildVodSourceDownloadArgs(directSource, startTime, endTime, expectedTotalSec));
        }
        if (!directSource && config.streamlink_disable_ads !== false) {
            // Skips Twitch mid-roll ads which would otherwise be embedded
            // in the VOD output. Off only if the user explicitly disabled it.
            args.push('--twitch-disable-ads');
        }
        // HLS-Segment-Resilience: bei vereinzelten CDN-Fehlern weiter retrien,
        // statt komplett zu sterben. Twitch hat 2025/26 oefter transiente 403/
        // timeout-Errors auf einzelne HLS-Segments. Default ist 3 — 5 ist ein
        // pragmatischer Kompromiss zwischen Resilience und Failing-Fast.
        if (!directSource) args.push('--stream-segment-attempts', '5');
        if (!directSource) args.push('--stream-segment-timeout', '20');
        if (!directSource) args.push('--stream-timeout', '120');
        // Streamlink-Plugin retry: bei "stream not found on URL"-Erstabfrage
        // einmal nachhaken, bevor wir den ganzen Run failen.
        if (!directSource) args.push('--retry-streams', '3');
        if (!directSource) args.push('--retry-max', '2');
        let lastErrorLine = '';
        const stderrBuffer: string[] = [];
        const expectedDurationSeconds = parseClockDurationSeconds(endTime)
            ?? (directSource && expectedTotalSec > 0 ? expectedTotalSec : null);
        const mediaProgress = new MediaDownloadProgress();

        if (!directSource && startTime) {
            args.push('--hls-start-offset', startTime);
        }
        if (!directSource && endTime) {
            args.push('--hls-duration', endTime);
        }

        // download-part-start in the debug log captures the same info
        // for support / forensics — no need to flood stdout too.
        appendDebugLog('download-part-start', { itemId, command, filename, args, directQuality: directSource ? requestedQuality : undefined });

        const partialFilename = partialDownloadRegistry.begin(filename);
        recordManagedToolExecution(directSource ? 'ffmpeg' : 'streamlink', command);
        const proc = spawn(command, args, { windowsHide: true });
        proc.stdout?.on('data', (data: Buffer) => mediaProgress.push(data));
        const outputStream = fs.createWriteStream(partialFilename, { flags: 'w' });
        if (!proc.stdout) {
            outputStream.destroy();
            partialDownloadRegistry.discard(partialFilename);
            resolve({ success: false, error: tBackend('unknownDownloadError') });
            return;
        }
        const output = createPausableOutput(
            proc.stdout,
            outputStream,
            createDownloadThrottleTransform(),
        );
        const outputFinished = output.finished.then(() => null, (error) => error);
        const processRegistration = queueProcessRegistry.register(itemId, 'streamlink', {
            kill: () => proc.kill(),
            wait: () => waitForChildProcessExit(proc),
            pause: () => output.pause(),
            resume: () => output.resume(),
            cancel: () => output.cancel(),
            cleanup: () => partialDownloadRegistry.discard(partialFilename),
        });

        const itemTracking: ActiveDownloadTracking = { process: proc, cancelled: false, startTime: Date.now(), bytes: 0, output, partialFilename };
        activeDownloads.set(itemId, itemTracking);
        if (queuePaused) output.pause();

        downloadedBytes = 0;
        let lastBytes = 0;
        let lastTime = Date.now();
        let lastMediaSeconds = 0;
        let mediaRate = 0;

        // Monitor file size for progress
        const progressInterval = setInterval(() => {
            if (fs.existsSync(partialFilename)) {
                try {
                    const stats = fs.statSync(partialFilename);
                    downloadedBytes = stats.size;
                    itemTracking.bytes = stats.size;

                    const now = Date.now();
                    const timeDiff = (now - lastTime) / 1000;
                    const bytesDiff = downloadedBytes - lastBytes;
                    const speed = timeDiff > 0 ? bytesDiff / timeDiff : 0;

                    runtimeMetrics.lastSpeedBytesPerSec = speed;
                    if (speed > 0) {
                        runtimeMetrics.avgSpeedBytesPerSec = runtimeMetrics.avgSpeedBytesPerSec <= 0
                            ? speed
                            : (runtimeMetrics.avgSpeedBytesPerSec * 0.8) + (speed * 0.2);
                    }

                    lastBytes = downloadedBytes;
                    lastTime = now;

                    const seconds = mediaProgress.seconds;
                    const totalSeconds = expectedDurationSeconds || expectedTotalSec;
                    const knownProgress = seconds !== null && totalSeconds > 0;
                    const mediaDelta = seconds === null ? 0 : Math.max(0, seconds - lastMediaSeconds);
                    if (seconds !== null) lastMediaSeconds = seconds;
                    if (timeDiff > 0 && mediaDelta > 0) {
                        const currentRate = mediaDelta / timeDiff;
                        mediaRate = mediaRate > 0 ? mediaRate * .6 + currentRate * .4 : currentRate;
                    }
                    const remainingSeconds = knownProgress && mediaRate > 0 ? Math.max(0, totalSeconds - seconds) / mediaRate : 0;
                    const etaStr = speed > 0 && remainingSeconds > 0 && remainingSeconds < 86400 ? formatETA(remainingSeconds) : '';
                    const progressEstimate = knownProgress ? Math.min(100, seconds / totalSeconds * 100) : -1;
                    const status = knownProgress && seconds >= totalSeconds ? tBackend('statusCompletingDownload')
                        : knownProgress ? formatDuration(Math.floor(Math.min(seconds, totalSeconds))) + ' / ' + formatDuration(Math.floor(totalSeconds)) + ' · ' + formatBytes(downloadedBytes)
                        : tBackend('statusBytesDownloaded', { bytes: formatBytes(downloadedBytes) });

                    onProgress({
                        id: itemId,
                        progress: progressEstimate,
                        progressPhase: knownProgress && seconds >= totalSeconds ? 'finalizing' : 'downloading',
                        speed: formatSpeed(speed),
                        eta: etaStr,
                        status,
                        currentPart: partNum,
                        totalParts: totalParts,
                        downloadedBytes: downloadedBytes,
                        speedBytesPerSec: speed
                    });
                } catch { }
            }
        }, 1000);

        proc.stderr?.on('data', (data: Buffer) => {
            const message = data.toString();
            if (message.trim()) {
                stderrBuffer.push(message);
                // Bounded buffer — wir wollen nicht 100MB stderr in RAM bei einem
                // streamlink-loop. 200 chunks reichen fuer normale Diagnose.
                if (stderrBuffer.length > 200) stderrBuffer.shift();
                // Letzte echte Errorzeile fuer User-Surface. "[ ... ] log lines"
                // ueberspringen, "error: ..." bevorzugen damit nicht ein triviales
                // INFO-Statement als User-facing-Fehler landet.
                const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
                for (const line of lines) {
                    const lower = line.toLowerCase();
                    if (lower.startsWith('error:') || lower.includes('error:')) {
                        lastErrorLine = line;
                    } else if (!lastErrorLine && line.length > 0 && !lower.startsWith('[')) {
                        // Fallback: jede non-bracket non-INFO Zeile
                        lastErrorLine = line;
                    }
                }
                appendDebugLog('download-part-stderr', { itemId, message: message.trim() });
                console.error('Streamlink error:', message);
            }
        });

        proc.on('close', async (code) => {
            clearInterval(progressInterval);
            const outputError = await outputFinished;
            processRegistration.release();
            activeDownloads.delete(itemId);

            if (outputError) {
                partialDownloadRegistry.discard(partialFilename);
                resolve({ success: false, error: String(outputError) });
                return;
            }

            if (cancelledItemIds.has(itemId)) {
                cancelledItemIds.delete(itemId);
                partialDownloadRegistry.discard(partialFilename);
                appendDebugLog('download-part-cancelled', { itemId, filename });
                resolve({ success: false, error: tBackend('downloadCancelled') });
                return;
            }

            if (code === 0 && fs.existsSync(partialFilename)) {
                const stats = fs.statSync(partialFilename);
                if (stats.size <= MIN_FILE_BYTES) {
                    const tooSmall = tBackend('fileTooSmall', { bytes: String(stats.size) });
                    partialDownloadRegistry.discard(partialFilename);
                    appendDebugLog('download-part-failed-small-file', { itemId, filename, bytes: stats.size });
                    resolve({ success: false, error: tooSmall });
                    return;
                }

                const integrityResult = await validateDownloadedFileIntegrity(partialFilename, expectedDurationSeconds);
                if (appShutdownStarted || !(await waitForQueuePhaseBoundary(itemId))) {
                    partialDownloadRegistry.discard(partialFilename);
                    resolve({ success: false, error: tBackend('downloadCancelled') });
                    return;
                }
                if (!integrityResult.success) {
                    partialDownloadRegistry.discard(partialFilename);
                    appendDebugLog('download-part-failed-integrity', {
                        itemId,
                        filename,
                        bytes: stats.size,
                        error: integrityResult.error
                    });
                    resolve(integrityResult);
                    return;
                }

                onProgress({ id: itemId, progress: 100, progressPhase: 'finalizing', speed: '', eta: '', status: tBackend('statusFinalizingMp4'), currentPart: partNum, totalParts });
                const finalized = await finalizeDownloadedMp4(partialFilename, filename, itemId, expectedDurationSeconds);
                if (!finalized.success) { resolve(finalized); return; }
                runtimeMetrics.downloadedBytesTotal += stats.size;
                appendDebugLog('download-part-success', { itemId, filename, bytes: stats.size });
                resolve({ success: true });
                return;
            }

            // Volle stderr+stdout-History im Debug-Log fuer Forensik.
            // Streamlink-Windows-Builds schreiben Errors gelegentlich auf
            // stdout statt stderr ("No playable streams found on this URL"
            // war historisch ein stdout-Error). Wir mergen beide Streams
            // damit immer SICHTBAR ist was passiert.
            const fullStderr = stderrBuffer.join('').trim();
            // Letzte Error-/Warning-Zeile aus beiden Streams suchen, falls
            // lastErrorLine noch leer ist (z.B. weil streamlink ohne Output
            // mit Code 1 exited — was bei pre-flight-Auth-Fails passiert).
            let userFacingError = lastErrorLine;
            if (!userFacingError) {
                const combined = fullStderr.split('\n').map(l => l.trim()).filter(Boolean);
                userFacingError = combined.filter(l => l.toLowerCase().includes('error:')).pop()
                    || combined.filter(l => !l.startsWith('[')).pop()
                    || '';
            }
            if (!userFacingError) {
                userFacingError = tBackend('streamlinkExitCode', { code: String(code ?? -1) });
            }
            appendDebugLog('download-part-failed', {
                itemId, filename, code, error: userFacingError,
                stderrTail: fullStderr.slice(-2000)
            });
            partialDownloadRegistry.discard(partialFilename);
            resolve({ success: false, error: userFacingError });
        });

        proc.on('error', async (err) => {
            clearInterval(progressInterval);
            await output.cancel();
            processRegistration.release();
            partialDownloadRegistry.discard(partialFilename);
            console.error('Process error:', err);
            activeDownloads.delete(itemId);
            const rawError = String(err);
            const errorMessage = rawError.includes('ENOENT')
                ? tBackend('streamlinkNotFound')
                : rawError;
            appendDebugLog('download-part-process-error', { itemId, error: errorMessage, rawError });
            resolve({ success: false, error: errorMessage });
        });
    });
}

// ==========================================
// AUTO-RECORD POLLER
// ==========================================
// Tracks the last-known live state of every streamer in
// config.auto_record_streamers. When a streamer transitions from
// offline -> live AND no live recording is already in flight for them,
// we auto-queue a live recording. Polling stops when no streamer has
// auto-record enabled.
const autoRecordLastLiveState = new Map<string, boolean>();
let autoRecordPollTimer: NodeJS.Timeout | null = null;
let autoRecordStartupTimer: NodeJS.Timeout | null = null;
let autoRecordPollInFlight = false;
let autoRecordLastRunAt = 0;
let autoRecordNextRunAt = 0;
let autoRecordLastTriggerCount = 0;

function stopAutoRecordPoller(): void {
    if (autoRecordPollTimer) {
        clearInterval(autoRecordPollTimer);
        autoRecordPollTimer = null;
    }
    if (autoRecordStartupTimer) {
        clearTimeout(autoRecordStartupTimer);
        autoRecordStartupTimer = null;
    }
}

function restartAutoRecordPoller(): void {
    stopAutoRecordPoller();
    if (applicationAutomationPaused) return;
    const list = Array.isArray(config.auto_record_streamers) ? config.auto_record_streamers : [];
    if (list.length === 0) {
        appendDebugLog('auto-record-poller-idle', { reason: 'no streamers' });
        return;
    }
    const seconds = normalizeAutoRecordPollSeconds(config.auto_record_poll_seconds);
    appendDebugLog('auto-record-poller-start', { streamers: list.length, seconds });
    autoRecordPollTimer = setInterval(() => { void runAutoRecordPoll(); }, seconds * 1000);
    autoRecordPollTimer.unref?.();
    autoRecordNextRunAt = Date.now() + seconds * 1000;
    // Kick off an immediate first poll so a freshly-enabled streamer that's
    // already live gets picked up without waiting a full interval.
    autoRecordStartupTimer = setTimeout(() => {
        autoRecordStartupTimer = null;
        if (!appShutdownStarted) void runAutoRecordPoll();
    }, 1500);
}

async function runAutoRecordPoll(): Promise<AutomationScanResult> {
    const result: AutomationScanResult = { addedCount: 0, checkedCount: 0, failedCount: 0, skipped: null };
    if (appShutdownStarted || applicationBackupBusy || autoRecordPollInFlight) return { ...result, skipped: appShutdownStarted ? 'shutdown' : 'busy' };
    autoRecordPollInFlight = true;
    try {
        const list = Array.isArray(config.auto_record_streamers) ? [...config.auto_record_streamers] : [];
        for (const streamer of list) {
            // Check if list still contains streamer (config may have changed
            // mid-iteration via save-config from the renderer).
            if (!config.auto_record_streamers.includes(streamer)) continue;

            const info = await getLiveStreamInfo(streamer);
            if (info === null) {
                result.failedCount++;
                // Couldn't determine live state — skip this streamer this
                // round. Don't update lastLiveState so a subsequent successful
                // poll can still detect an offline->live transition cleanly.
                continue;
            }

            result.checkedCount++;
            const wasLive = autoRecordLastLiveState.get(streamer) === true;
            autoRecordLastLiveState.set(streamer, info.isLive);

            if (!info.isLive || wasLive) continue;

            // offline -> live transition. Don't double-record if a live item
            // already exists in the queue (e.g. user manually triggered it).
            const alreadyRecording = downloadQueue.some((it) =>
                it.isLive && it.streamer === streamer
                && (it.status === 'pending' || it.status === 'downloading')
            );
            if (alreadyRecording) {
                appendDebugLog('auto-record-skip-already', { streamer });
                continue;
            }

            const liveItem: QueueItem = {
                id: generateQueueItemId(),
                createdAt: new Date().toISOString(),
                title: info.title || `${streamer} (LIVE)`,
                url: `https://www.twitch.tv/${streamer}`,
                date: new Date().toISOString(),
                streamer,
                duration_str: '0s',
                status: 'pending',
                progress: 0,
                isLive: true
            };
            const addition = commitQueueItemWithResult(liveItem, false);
            if (!addition.accepted) {
                if (addition.reason === 'shutting-down' || addition.reason === 'persistence-failed') {
                    autoRecordLastLiveState.set(streamer, wasLive);
                    result.failedCount++;
                    return result;
                }
                continue;
            }
            result.addedCount++;
            appendDebugLog('auto-record-triggered', { streamer, title: liveItem.title });

            if (!isDownloading) {
                scheduleQueueProcessing();
            }
        }
    } catch (e) {
        result.failedCount++;
        appendDebugLog('auto-record-poll-failed', String(e));
    } finally {
        autoRecordPollInFlight = false;
        autoRecordLastRunAt = Date.now();
        autoRecordLastTriggerCount = result.addedCount;
        const seconds = normalizeAutoRecordPollSeconds(config.auto_record_poll_seconds);
        autoRecordNextRunAt = Date.now() + seconds * 1000;
    }
    return result;
}

// ==========================================
// AUTO-VOD-DOWNLOAD POLLER
// ==========================================
// Periodically scans VOD listings of opted-in streamers and auto-queues
// any VOD that's (a) recent enough to be in scope, (b) not already
// downloaded, and (c) not already in the active queue. Cadence is
// minutes, not seconds — a VOD-listing scan is much heavier than a
// live-status check, and new VODs only appear after a stream ends, so
// minute-level lag is fine.
let autoVodPollTimer: NodeJS.Timeout | null = null;
let autoVodStartupTimer: NodeJS.Timeout | null = null;
let autoVodPollInFlight = false;
let autoVodLastRunAt = 0;
let autoVodNextRunAt = 0;
let autoVodLastQueuedCount = 0;

function stopAutoVodPoller(): void {
    if (autoVodPollTimer) {
        clearInterval(autoVodPollTimer);
        autoVodPollTimer = null;
    }
    if (autoVodStartupTimer) {
        clearTimeout(autoVodStartupTimer);
        autoVodStartupTimer = null;
    }
}

function restartAutoVodPoller(): void {
    stopAutoVodPoller();
    if (applicationAutomationPaused) return;
    const list = Array.isArray(config.auto_vod_download_streamers) ? config.auto_vod_download_streamers : [];
    if (list.length === 0) {
        appendDebugLog('auto-vod-poller-idle', { reason: 'no streamers' });
        return;
    }
    const minutes = (() => {
        const n = Number(config.auto_vod_download_poll_minutes);
        if (!Number.isFinite(n)) return 15;
        return Math.max(5, Math.min(360, Math.floor(n)));
    })();
    appendDebugLog('auto-vod-poller-start', { streamers: list.length, minutes });
    autoVodPollTimer = setInterval(() => { void runAutoVodPoll(); }, minutes * 60 * 1000);
    autoVodPollTimer.unref?.();
    autoVodNextRunAt = Date.now() + minutes * 60 * 1000;
    autoVodStartupTimer = setTimeout(() => {
        autoVodStartupTimer = null;
        if (!appShutdownStarted) void runAutoVodPoll();
    }, 5000);
}

async function runAutoVodPoll(): Promise<AutomationScanResult> {
    const result: AutomationScanResult = { addedCount: 0, checkedCount: 0, failedCount: 0, skipped: null };
    if (appShutdownStarted || applicationBackupBusy || autoVodPollInFlight) return { ...result, skipped: appShutdownStarted ? 'shutdown' : 'busy' };
    autoVodPollInFlight = true;
    try {
        const list = Array.isArray(config.auto_vod_download_streamers) ? [...config.auto_vod_download_streamers] : [];
        if (list.length === 0) return result;

        const maxAgeHours = (() => {
            const n = Number(config.auto_vod_max_age_hours);
            if (!Number.isFinite(n)) return 24;
            return Math.max(1, Math.min(720, Math.floor(n)));
        })();
        const scanTime = Date.now();

        const downloadedSet = new Set(Array.isArray(config.downloaded_vod_ids) ? config.downloaded_vod_ids : []);
        for (const streamer of list) {
            if (!config.auto_vod_download_streamers.includes(streamer)) continue;

            const userId = await getUserId(streamer);
            if (!userId) {
                result.failedCount++;
                appendDebugLog('auto-vod-skip-no-user', { streamer });
                continue;
            }

            let vods: VOD[] = [];
            try {
                vods = await getVODs(userId, true, true);
            } catch (e) {
                result.failedCount++;
                appendDebugLog('auto-vod-list-failed', { streamer, error: String(e) });
                continue;
            }
            result.checkedCount++;
            if (!Array.isArray(vods) || vods.length === 0) continue;

            for (const vod of vods) {
                if (!vod || !vod.id || !vod.url) continue;
                if (downloadedSet.has(vod.id)) continue;

                if (evaluateAutoVodRule(config.auto_vod_rules[streamer.toLowerCase()], vod, scanTime, maxAgeHours) !== 'match') continue;

                const queueItem: QueueItem = {
                    id: generateQueueItemId(),
                    createdAt: new Date().toISOString(),
                    title: vod.title || `${streamer} VOD ${vod.id}`,
                    url: vod.url,
                    date: vod.created_at,
                    streamer,
                    duration_str: vod.duration || '',
                    status: 'pending',
                    progress: 0
                };
                const addition = commitQueueItemWithResult(queueItem, false);
                if (!addition.accepted) {
                    if (addition.reason === 'shutting-down' || addition.reason === 'persistence-failed') { result.failedCount++; return result; }
                    continue;
                }
                result.addedCount++;
                appendDebugLog('auto-vod-queued', { streamer, vodId: vod.id, title: queueItem.title });

                if (config.discord_notify_vod_auto_queued) {
                    try {
                        await sendDiscordWebhook({
                            title: 'New VOD auto-queued',
                            description: `\`${streamer}\` published a new VOD — queued for download.`,
                            color: 'info',
                            fields: [
                                { name: 'Title', value: queueItem.title, inline: false },
                                { name: 'VOD ID', value: String(vod.id), inline: true },
                                { name: 'URL', value: vod.url, inline: false }
                            ]
                        });
                    } catch { /* ignore webhook errors */ }
                }
            }
        }

        if (!isDownloading && downloadQueue.some((it) => it.status === 'pending')) {
            scheduleQueueProcessing();
        }
    } catch (e) {
        result.failedCount++;
        appendDebugLog('auto-vod-poll-failed', String(e));
    } finally {
        autoVodPollInFlight = false;
        autoVodLastRunAt = Date.now();
        autoVodLastQueuedCount = result.addedCount;
        const minutes = (() => {
            const n = Number(config.auto_vod_download_poll_minutes);
            if (!Number.isFinite(n)) return 15;
            return Math.max(5, Math.min(360, Math.floor(n)));
        })();
        autoVodNextRunAt = Date.now() + minutes * 60 * 1000;
        if (result.addedCount > 0 && mainWindow) {
            mainWindow.webContents.send('auto-vod-scan-completed', { queuedCount: result.addedCount });
        }
    }
    return result;
}

// ==========================================
// LIVE STATUS BATCH POLLER — for the sidebar live indicators
// ==========================================
// Background poller that asks "which of these streamers are live right
// now?" for every streamer in the user's list, in a single GQL roundtrip
// (per chunk of 50). Results are stamped into liveStatusByLogin and
// pushed to the renderer so the sidebar gets a red pulsing dot next to
// anyone currently broadcasting. Independent from the auto-record
// poller — that one only watches a small subset and needs title/game,
// this one just needs the boolean and covers everyone.
const liveStatusByLogin = new Map<string, boolean>();
let liveStatusPollTimer: NodeJS.Timeout | null = null;
let liveStatusPollInFlight = false;
const LIVE_STATUS_POLL_INTERVAL_MS = 60_000;
const LIVE_STATUS_BATCH_CHUNK_SIZE = 50;

async function fetchLiveStatusBatch(logins: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (logins.length === 0) return result;

    for (let i = 0; i < logins.length; i += LIVE_STATUS_BATCH_CHUNK_SIZE) {
        const chunk = logins.slice(i, i + LIVE_STATUS_BATCH_CHUNK_SIZE);
        const vars: Record<string, string> = {};
        const varDecls: string[] = [];
        const aliases: string[] = [];
        chunk.forEach((login, idx) => {
            const varName = `l${idx}`;
            vars[varName] = login;
            varDecls.push(`$${varName}:String!`);
            aliases.push(`u${idx}:user(login:$${varName}){login stream{type}}`);
        });
        const query = `query(${varDecls.join(',')}){${aliases.join(' ')}}`;
        try {
            const data = await fetchPublicTwitchGql<Record<string, { login: string; stream: { type: string } | null } | null>>(
                query, vars
            );
            if (!data) continue;
            for (const key of Object.keys(data)) {
                const user = data[key];
                if (!user || !user.login) continue;
                result.set(normalizeLogin(user.login), user.stream?.type === 'live');
            }
        } catch (e) {
            appendDebugLog('live-status-batch-failed', { chunkStart: i, error: String(e) });
        }
    }
    return result;
}

async function runLiveStatusBatchPoll(): Promise<void> {
    if (liveStatusPollInFlight) return;
    liveStatusPollInFlight = true;
    try {
        const logins = ((config.streamers as string[]) || [])
            .map((s) => normalizeLogin(s))
            .filter((s): s is string => Boolean(s));

        const changes: Array<{ login: string; isLive: boolean }> = [];
        const watchedSet = new Set(logins);

        // Always run the eviction pass FIRST — entries left over from a
        // streamer that's no longer in the watch list must go regardless
        // of whether we're about to fetch fresh data. Previously this
        // ran inside the fetch branch only, so removing the last
        // streamer left ghost entries in liveStatusByLogin until the
        // next add.
        for (const oldLogin of Array.from(liveStatusByLogin.keys())) {
            if (!watchedSet.has(oldLogin)) {
                liveStatusByLogin.delete(oldLogin);
                changes.push({ login: oldLogin, isLive: false });
            }
        }

        if (logins.length > 0) {
            const fresh = await fetchLiveStatusBatch(logins);
            for (const [login, isLive] of fresh.entries()) {
                const prev = liveStatusByLogin.get(login);
                if (prev !== isLive) changes.push({ login, isLive });
                liveStatusByLogin.set(login, isLive);
            }
        }

        if (mainWindow && changes.length > 0) {
            // Renderer only consumes `changes` — initial state comes via
            // the get-live-status-snapshot IPC at boot. Don't ship the
            // full map on every tick (was ~1.5KB JSON per 60s with zero
            // consumer-side use). Also skip the broadcast entirely when
            // nothing actually changed.
            mainWindow.webContents.send('live-status-batch-update', { changes });
        }
    } catch (e) {
        appendDebugLog('live-status-poll-failed', String(e));
    } finally {
        liveStatusPollInFlight = false;
    }
}

function stopLiveStatusPoller(): void {
    if (liveStatusPollTimer) {
        clearInterval(liveStatusPollTimer);
        liveStatusPollTimer = null;
    }
}

function restartLiveStatusPoller(): void {
    stopLiveStatusPoller();
    liveStatusPollTimer = setInterval(() => { void runLiveStatusBatchPoll(); }, LIVE_STATUS_POLL_INTERVAL_MS);
    liveStatusPollTimer.unref?.();
    setTimeout(() => { void runLiveStatusBatchPoll(); }, 1500);
}

// ==========================================
// CHAT REPLAY DOWNLOAD
// ==========================================
// Twitch retains chat replay alongside the VOD itself — same 7-60 day TTL.
// Anyone archiving the video usually wants the chat too. fetchVodChatReplay
// pulls the entire chat for a VOD via the public GQL endpoint, paginated
// via edge cursors (Twitch returns ~100 comments per page).
interface ChatReplayMessage {
    id: string;
    offset: number;          // contentOffsetSeconds — when in the VOD
    createdAt: string;       // ISO timestamp
    user: string;            // display name
    login: string;           // login (lowercase)
    color: string;           // user chat color
    text: string;            // assembled message text
}

interface ChatReplayResult {
    messages: ChatReplayMessage[];
    truncated: boolean;
    pages: number;
}

async function fetchVodChatReplay(
    videoId: string,
    onProgress?: (count: number) => void,
    cancelCheck?: () => boolean
): Promise<ChatReplayResult> {
    const messages: ChatReplayMessage[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let truncated = false;
    // Hard cap to keep one runaway stream from filling memory. 200 pages =
    // ~20k messages which covers typical 6-hour streams. Above that we
    // stop and mark truncated.
    const MAX_PAGES = 500;

    type CommentNode = {
        id: string;
        contentOffsetSeconds: number;
        createdAt: string;
        message?: { fragments?: Array<{ text?: string }>; userColor?: string };
        commenter?: { displayName?: string; login?: string };
    };
    type CommentEdge = { node: CommentNode; cursor: string };
    type CommentsPage = {
        video: { comments: { edges: CommentEdge[]; pageInfo: { hasNextPage: boolean } } } | null;
    };

    const query = 'query($videoID:ID!,$cursor:Cursor){video(id:$videoID){comments(contentOffsetSeconds:0,cursor:$cursor){edges{node{id contentOffsetSeconds createdAt message{fragments{text} userColor} commenter{displayName login}} cursor} pageInfo{hasNextPage}}}}';

    while (pages < MAX_PAGES) {
        if (cancelCheck && cancelCheck()) {
            truncated = true;
            break;
        }
        const data: CommentsPage | null = await fetchPublicTwitchGql<CommentsPage>(query, {
            videoID: videoId,
            cursor
        });
        if (!data || !data.video || !data.video.comments) break;

        const edges: CommentEdge[] = Array.isArray(data.video.comments.edges) ? data.video.comments.edges : [];
        for (const edge of edges) {
            const node = edge.node;
            const fragments = node.message?.fragments || [];
            const text = fragments.map((f: { text?: string }) => (typeof f.text === 'string' ? f.text : '')).join('');
            messages.push({
                id: node.id,
                offset: Number(node.contentOffsetSeconds) || 0,
                createdAt: node.createdAt || '',
                user: node.commenter?.displayName || '',
                login: node.commenter?.login || '',
                color: node.message?.userColor || '',
                text
            });
        }

        pages += 1;
        if (onProgress) onProgress(messages.length);

        const last: CommentEdge | undefined = edges[edges.length - 1];
        if (!data.video.comments.pageInfo.hasNextPage || !last) break;
        cursor = last.cursor;
    }

    if (pages >= MAX_PAGES) truncated = true;
    return { messages, truncated, pages };
}

function chatReplayPathFor(vodFilePath: string): string {
    // Strip the final extension and append .chat.json so the chat file
    // lives next to the video and is easy to find.
    const ext = path.extname(vodFilePath);
    const base = ext ? vodFilePath.slice(0, -ext.length) : vodFilePath;
    return `${base}.chat.json`;
}

// ==========================================
// AUTO-CLEANUP
// ==========================================

const cleanupAbortController = new AbortController();
const reviewedCleanupPlans = new Map<string, string>();
let cleanupRecoveryPaths: string[] = [];
let cleanupRecoveryRoot = '';
let cleanupPending: Promise<StorageCleanupPreview | StorageCleanupResult> | null = null;
function cleanupConfiguration() {
    return { root: config.download_path, streamers: config.streamers, cutoffDays: Number(config.auto_cleanup_days) || 30,
        target: config.auto_cleanup_target === 'all' ? 'all' as const : 'live_only' as const,
        action: config.auto_cleanup_action === 'delete' ? 'delete' as const : 'archive' as const,
        enabled: config.auto_cleanup_enabled === true };
}
function cleanupConfigurationKey(): string { return JSON.stringify(cleanupConfiguration()); }
const storageCleanup = createStorageCleanupService({
    isActive: filename => {
        if (appShutdownStarted || applicationBackupBusy || isDownloading || activeDownloads.size > 0 || activeClipProcesses.size > 0 ||
            cutterExportActive || workspaceMergeActive || editingWorkflows?.busy) return true;
        const normalized = normalizeComparablePath(filename);
        if (editingWorkflows?.queue.list().some(job => job.status !== 'completed' && (job.request.kind === 'cut' ? [job.request.project.source] : job.request.sources).some(source => normalizeComparablePath(source.path) === normalized))) return true;
        return normalized === (cutterMediaJob ? normalizeComparablePath(cutterMediaJob.path) : '') ||
            [...mergeWorkspaceFiles.values()].some(file => normalizeComparablePath(file.path) === normalized);
    },
    trashDirectory: directory => shell.trashItem(directory)
});

async function executeStorageCleanup(options: { dryRun: boolean; token?: string; automatic?: boolean }): Promise<StorageCleanupPreview | StorageCleanupResult> {
    if (options.dryRun) {
        const preview = await storageCleanup.preview(cleanupConfiguration(), cleanupAbortController.signal);
        cleanupRecoveryPaths = [...preview.recoveryPaths];
        cleanupRecoveryRoot = config.download_path;
        reviewedCleanupPlans.clear();
        reviewedCleanupPlans.set(preview.token, cleanupConfigurationKey());
        return preview;
    }
    let token = options.token;
    if (options.automatic) {
        const preview = await storageCleanup.preview(cleanupConfiguration(), cleanupAbortController.signal);
        if (preview.recoveryPaths.length) return { ...preview, dryRun: false, skipped: preview.candidates, cancelled: false };
        token = preview.token;
    } else if (!token || reviewedCleanupPlans.get(token) !== cleanupConfigurationKey()) {
        throw new Error('preview-required');
    }
    if (!token) throw new Error('preview-required');
    reviewedCleanupPlans.delete(token);
    const result = await storageCleanup.execute(token, cleanupAbortController.signal);
    cleanupRecoveryPaths = [...result.recoveryPaths];
    cleanupRecoveryRoot = config.download_path;
    readArchiveInventory.invalidate();
    readStorageInventory.invalidate();
    appendDebugLog('storage-cleanup-run', { candidates: result.candidates, processed: result.processed, failed: result.failed, skipped: result.skipped, bytes: result.bytesAffected, action: result.action });
    return result;
}


async function runStorageCleanup(options: { dryRun: boolean; token?: string; automatic?: boolean }): Promise<StorageCleanupPreview | StorageCleanupResult> {
    if (cleanupPending || applicationBackupBusy) throw new Error('cleanup-busy');
    const pending = executeStorageCleanup(options);
    cleanupPending = pending;
    try { return await pending; } finally { if (cleanupPending === pending) cleanupPending = null; }
}

let autoCleanupTimer: NodeJS.Timeout | null = null;
let autoCleanupStartupTimer: NodeJS.Timeout | null = null;
let lastAutoCleanupAt = 0;
let startupToolsProvisionTimer: NodeJS.Timeout | null = null;

function stopStartupToolsProvisionTimer(): void {
    if (startupToolsProvisionTimer) {
        clearTimeout(startupToolsProvisionTimer);
        startupToolsProvisionTimer = null;
    }
}

function stopAutoCleanupTimer(): void {
    if (autoCleanupTimer) {
        clearInterval(autoCleanupTimer);
        autoCleanupTimer = null;
    }
    if (autoCleanupStartupTimer) {
        clearTimeout(autoCleanupStartupTimer);
        autoCleanupStartupTimer = null;
    }
}

function restartAutoCleanupTimer(): void {
    stopAutoCleanupTimer();
    if (applicationAutomationPaused) return;
    if (appShutdownStarted) return;
    if (!config.auto_cleanup_enabled) return;
    // Run every 6 hours while the app is running. Skip the first cycle if
    // the previous run was less than 6h ago to avoid hammering on every
    // settings save.
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    autoCleanupTimer = setInterval(() => {
        if (appShutdownStarted) return;
        if (Date.now() - lastAutoCleanupAt < SIX_HOURS_MS) return;
        lastAutoCleanupAt = Date.now();
        void runStorageCleanup({ dryRun: false, automatic: true }).catch(e => appendDebugLog('auto-cleanup-failed', String(e)));
    }, SIX_HOURS_MS);
    autoCleanupTimer.unref?.();

    // First run is delayed 60s so it doesn't compete with startup IO.
    autoCleanupStartupTimer = setTimeout(() => {
        autoCleanupStartupTimer = null;
        if (appShutdownStarted || !config.auto_cleanup_enabled) return;
        if (Date.now() - lastAutoCleanupAt < 60 * 1000) return;
        lastAutoCleanupAt = Date.now();
        void runStorageCleanup({ dryRun: false, automatic: true }).catch(e => appendDebugLog('auto-cleanup-failed', String(e)));
    }, 60 * 1000);
}

const readStorageInventory = createArchiveInventoryReader(15000, true);

async function computeStorageStats(): Promise<StorageStatsResult> {
    const root = config.download_path;
    const streamers = [...(config.streamers || [])];
    const [inventory, freeBytes] = await Promise.all([
        readStorageInventory(root, true),
        root ? fs.promises.statfs(root).then(info => {
            const bytes = info.bsize * info.bavail;
            return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : null;
        }).catch(() => null) : Promise.resolve(null),
    ]);
    return summarizeStorageInventory(inventory, streamers, freeBytes);
}

// ==========================================
// ARCHIVE STATS — DASHBOARD AGGREGATION
// ==========================================
const readArchiveInventory = createIndexedArchiveReader(path.join(APPDATA_DIR, 'archive-index.json'), 60000, directory => {
    if (directory === path.resolve(config.download_path) && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('archive-index-updated');
});

// ==========================================
// DISCORD WEBHOOK NOTIFICATIONS
// ==========================================
// Fire-and-forget webhook for "stream went live", "recording finished",
// "VOD download complete". Useful when the user runs the app on a
// dedicated archival machine and isn't checking it directly.
type DiscordEmbedColor = 'live' | 'success' | 'info';
const DISCORD_EMBED_COLORS: Record<DiscordEmbedColor, number> = {
    live: 0xE91916,    // red — recording started
    success: 0x00C853, // green — completed cleanly
    info: 0x9146FF     // twitch purple — neutral
};

function isAcceptableDiscordWebhook(url: string): boolean {
    try {
        const parsed = new URL((url || '').trim());
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
        const labels = parsed.hostname.split('.');
        const domain = labels.slice(-2).join('.');
        if (domain !== 'discord.com' && domain !== 'discordapp.com') return false;
        if (labels.length !== 2 && (labels.length !== 3 || !/^[a-z]+$/.test(labels[0]))) return false;
        return parsed.pathname.toLowerCase().startsWith('/api/webhooks/');
    } catch {
        return false;
    }
}

async function sendDiscordWebhook(payload: {
    title: string;
    description: string;
    color: DiscordEmbedColor;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
}): Promise<void> {
    const url = discordWebhookUrl.trim();
    if (!isAcceptableDiscordWebhook(url)) return;

    const body = {
        username: 'Twitch VOD Manager',
        embeds: [
            {
                title: payload.title.slice(0, 256),
                description: payload.description.slice(0, 4096),
                color: DISCORD_EMBED_COLORS[payload.color],
                fields: (payload.fields || []).slice(0, 25).map((f) => ({
                    name: (f.name || '').slice(0, 256),
                    value: (f.value || '').slice(0, 1024),
                    inline: f.inline === true
                })),
                timestamp: new Date().toISOString()
            }
        ]
    };

    try {
        await axios.post(url, body, { timeout: 8000, headers: { 'Content-Type': 'application/json' } });
        appendDebugLog('discord-webhook-ok', { title: payload.title, color: payload.color });
    } catch (e) {
        appendDebugLog('discord-webhook-failed', { title: payload.title, error: String(e) });
    }
}

// ==========================================
// LIVE RECORDING EVENTS LOG
// ==========================================
// Sibling .events.jsonl file alongside each live recording. Tracks
// recording start/end + Twitch metadata changes (title / game) that
// happen while the stream is being captured. Useful when seeking
// inside a long archived stream — tells you "at minute 142 he switched
// from Just Chatting to Counter-Strike". Independent of chat capture
// (lives even if capture_live_chat is off) and uses JSON Lines for
// the same crash-safety reason.
interface LiveEventTracker {
    itemId: string;
    streamer: string;
    eventsPath: string;
    fileHandle: number | null;
    startedAt: number;          // Date.now() when recording started
    lastTitle: string;
    lastGame: string;
    closing: boolean;
}

const liveEventTrackers = new Map<string, LiveEventTracker>();
let liveEventsPollTimer: NodeJS.Timeout | null = null;

function eventsLogPathFor(videoPath: string): string {
    const ext = path.extname(videoPath);
    const base = ext ? videoPath.slice(0, -ext.length) : videoPath;
    return `${base}.events.jsonl`;
}

function appendEventLine(tracker: LiveEventTracker, payload: Record<string, unknown>): void {
    if (tracker.fileHandle === null) return;
    const line = JSON.stringify({ t: new Date().toISOString(), ...payload }) + '\n';
    try {
        fs.writeSync(tracker.fileHandle, line);
    } catch (e) {
        appendDebugLog('events-log-write-failed', { itemId: tracker.itemId, error: String(e) });
    }
}

function startLiveEventsTracker(itemId: string, streamer: string, videoPath: string, initialTitle: string, initialGame: string): LiveEventTracker | null {
    const eventsPath = eventsLogPathFor(videoPath);
    let fd: number;
    try {
        fd = fs.openSync(eventsPath, 'w');
    } catch (e) {
        appendDebugLog('events-log-open-failed', { itemId, eventsPath, error: String(e) });
        return null;
    }

    const tracker: LiveEventTracker = {
        itemId,
        streamer,
        eventsPath,
        fileHandle: fd,
        startedAt: Date.now(),
        lastTitle: initialTitle,
        lastGame: initialGame,
        closing: false
    };

    appendEventLine(tracker, {
        type: 'recording_start',
        streamer,
        title: initialTitle,
        game: initialGame
    });

    liveEventTrackers.set(itemId, tracker);
    ensureLiveEventsPollTimer();
    return tracker;
}

function stopLiveEventsTracker(itemId: string, finalNote?: { success: boolean; durationMs: number; error?: string }): void {
    const tracker = liveEventTrackers.get(itemId);
    if (!tracker || tracker.closing) return;
    tracker.closing = true;

    appendEventLine(tracker, {
        type: 'recording_end',
        durationSeconds: finalNote ? Math.floor(finalNote.durationMs / 1000) : Math.floor((Date.now() - tracker.startedAt) / 1000),
        success: finalNote?.success === true,
        error: finalNote?.error || ''
    });

    if (tracker.fileHandle !== null) {
        try { fs.closeSync(tracker.fileHandle); } catch { /* ignore */ }
        tracker.fileHandle = null;
    }
    liveEventTrackers.delete(itemId);

    if (liveEventTrackers.size === 0 && liveEventsPollTimer) {
        clearInterval(liveEventsPollTimer);
        liveEventsPollTimer = null;
    }
}

function ensureLiveEventsPollTimer(): void {
    if (liveEventsPollTimer) return;
    // Same cadence as auto-record polling; metadata changes don't need
    // sub-minute resolution and we want to keep API load bounded.
    liveEventsPollTimer = setInterval(() => { void pollLiveEventsForChanges(); }, 60 * 1000);
    liveEventsPollTimer.unref?.();
}

async function pollLiveEventsForChanges(): Promise<void> {
    if (liveEventTrackers.size === 0) return;
    for (const tracker of liveEventTrackers.values()) {
        if (tracker.closing) continue;
        const info = await getLiveStreamInfo(tracker.streamer);
        if (!info || !info.isLive) continue;
        const currentTitle = info.title || '';
        const currentGame = info.gameName || '';

        if (currentTitle !== tracker.lastTitle) {
            appendEventLine(tracker, {
                type: 'title_change',
                from: tracker.lastTitle,
                to: currentTitle
            });
            tracker.lastTitle = currentTitle;
        }
        if (currentGame !== tracker.lastGame) {
            appendEventLine(tracker, {
                type: 'game_change',
                from: tracker.lastGame,
                to: currentGame
            });
            tracker.lastGame = currentGame;
            // Also fire a webhook ping if the user wants it. Game changes
            // matter more than title micro-tweaks, so we only ping for game.
            if (config.discord_notify_live_start) {
                void sendDiscordWebhook({
                    title: `Game change: ${tracker.streamer}`,
                    description: `Now playing **${currentGame || 'unknown'}**`,
                    color: 'info',
                    fields: [
                        { name: 'Title', value: currentTitle || '-', inline: false }
                    ]
                });
            }
        }
    }
}

// ==========================================
// LIVE CHAT CAPTURE (during live recording)
// ==========================================
// Companion to fetchVodChatReplay: while a stream is being recorded live,
// open an anonymous IRC connection to Twitch chat and append every message
// to a sibling .chat.jsonl file. Format is JSON Lines (one JSON object per
// line) so a partial / killed write still parses correctly — important
// because live recordings can run for many hours and we don't want to
// keep the full chat in memory.
interface LiveChatSession {
    streamer: string;
    outputPath: string;
    socket: TLSSocket;
    fileHandle: number | null;
    closing: boolean;
    messageCount: number;
    buffer: string;
}

const TWITCH_IRC_HOST = 'irc.chat.twitch.tv';
const TWITCH_IRC_PORT = 6697;

function liveChatPathFor(videoPath: string): string {
    const ext = path.extname(videoPath);
    const base = ext ? videoPath.slice(0, -ext.length) : videoPath;
    return `${base}.chat.jsonl`;
}

function startLiveChatCapture(streamer: string, outputPath: string): LiveChatSession | null {
    const channelName = normalizeLogin(streamer);
    if (!channelName) return null;

    let fd: number;
    try {
        fd = fs.openSync(outputPath, 'w');
    } catch (e) {
        appendDebugLog('chat-capture-open-failed', { streamer: channelName, outputPath, error: String(e) });
        return null;
    }

    const session: LiveChatSession = {
        streamer: channelName,
        outputPath,
        socket: tlsConnect({ host: TWITCH_IRC_HOST, port: TWITCH_IRC_PORT, servername: TWITCH_IRC_HOST }),
        fileHandle: fd,
        closing: false,
        messageCount: 0,
        buffer: ''
    };

    // Write a header line so the file is self-describing even if zero
    // messages arrive (e.g. silent stream, immediate disconnect).
    const header = {
        type: 'header',
        streamer: channelName,
        startedAt: new Date().toISOString(),
        format: 'twitch-vod-manager-chat-jsonl-v1'
    };
    try { fs.writeSync(fd, JSON.stringify(header) + '\n'); } catch { /* ignore */ }

    session.socket.on('secureConnect', () => {
        // Anonymous Twitch IRC: any nick prefixed with "justinfan" is
        // accepted without a password. Random suffix avoids collisions.
        const nick = `justinfan${Math.floor(Math.random() * 100000)}`;
        try {
            session.socket.write('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
            session.socket.write(`NICK ${nick}\r\n`);
            session.socket.write(`JOIN #${channelName}\r\n`);
        } catch (e) {
            appendDebugLog('chat-capture-handshake-failed', { streamer: channelName, error: String(e) });
        }
        appendDebugLog('chat-capture-connected', { streamer: channelName, nick });
    });

    session.socket.on('data', (chunk: Buffer) => {
        session.buffer += chunk.toString('utf-8');
        const lines = session.buffer.split('\r\n');
        session.buffer = lines.pop() || '';
        for (const line of lines) {
            handleIrcLine(session, line);
        }
    });

    session.socket.on('error', (err: Error) => {
        appendDebugLog('chat-capture-socket-error', { streamer: channelName, error: String(err) });
    });

    session.socket.on('close', () => {
        if (!session.closing) {
            appendDebugLog('chat-capture-disconnected', { streamer: channelName, messages: session.messageCount });
        }
        if (session.fileHandle !== null) {
            try { fs.closeSync(session.fileHandle); } catch { /* ignore */ }
            session.fileHandle = null;
        }
    });

    return session;
}

function handleIrcLine(session: LiveChatSession, line: string): void {
    if (!line) return;
    if (line.startsWith('PING')) {
        try { session.socket.write('PONG' + line.slice(4) + '\r\n'); } catch { /* ignore */ }
        return;
    }

    let rest = line;
    let tagsStr = '';
    if (rest.startsWith('@')) {
        const sp = rest.indexOf(' ');
        if (sp < 0) return;
        tagsStr = rest.slice(1, sp);
        rest = rest.slice(sp + 1);
    }
    let prefix = '';
    if (rest.startsWith(':')) {
        const sp = rest.indexOf(' ');
        if (sp < 0) return;
        prefix = rest.slice(1, sp);
        rest = rest.slice(sp + 1);
    }
    const cmdSp = rest.indexOf(' ');
    const command = cmdSp < 0 ? rest : rest.slice(0, cmdSp);
    const params = cmdSp < 0 ? '' : rest.slice(cmdSp + 1);

    if (command !== 'PRIVMSG' && command !== 'USERNOTICE' && command !== 'CLEARCHAT' && command !== 'CLEARMSG') return;

    const colonIdx = params.indexOf(' :');
    const text = colonIdx >= 0 ? params.slice(colonIdx + 2) : '';

    const tags: Record<string, string> = {};
    if (tagsStr) {
        for (const pair of tagsStr.split(';')) {
            const eq = pair.indexOf('=');
            if (eq < 0) continue;
            tags[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
    }

    const login = (prefix.split('!')[0] || tags['login'] || '').toLowerCase();
    const message = {
        t: new Date().toISOString(),
        type: command === 'PRIVMSG' ? 'msg' : (command === 'USERNOTICE' ? 'notice' : command.toLowerCase()),
        u: tags['display-name'] || login,
        login,
        color: tags['color'] || '',
        msg: text,
        badges: tags['badges'] || '',
        bits: tags['bits'] || '',
        msgId: tags['msg-id'] || '',
        systemMsg: (tags['system-msg'] || '').replace(/\\s/g, ' ')
    };

    if (session.fileHandle === null) return;
    try {
        fs.writeSync(session.fileHandle, JSON.stringify(message) + '\n');
        session.messageCount++;
    } catch (e) {
        appendDebugLog('chat-capture-write-failed', { error: String(e) });
    }
}

function stopLiveChatCapture(session: LiveChatSession): void {
    if (session.closing) return;
    session.closing = true;
    appendDebugLog('chat-capture-stopping', { streamer: session.streamer, messages: session.messageCount });
    try { session.socket.write(`PART #${session.streamer}\r\nQUIT\r\n`); } catch { /* ignore */ }
    try { session.socket.end(); } catch { /* ignore */ }
    setTimeout(() => {
        try { session.socket.destroy(); } catch { /* ignore */ }
    }, 500);
}

async function downloadLiveStream(
    item: QueueItem,
    onProgress: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
    onProgress({
        id: item.id,
        progress: -1,
        speed: '',
        eta: '',
        status: tBackend('statusPreparingTools'),
        currentPart: 0,
        totalParts: 0
    });

    const streamlinkReady = await ensureStreamlinkInstalled();
    if (!streamlinkReady) {
        return { success: false, error: tBackend('streamlinkAutoInstallFailed') };
    }

    onProgress({
        id: item.id,
        progress: -1,
        speed: '',
        eta: '',
        status: tBackend('statusDownloadStarted'),
        currentPart: 0,
        totalParts: 0
    });

    const safeStreamer = (item.streamer || 'live').replace(/[^a-zA-Z0-9_-]/g, '');
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
    const timeStr = `${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}-${now.getSeconds().toString().padStart(2, '0')}`;
    const folder = path.join(config.download_path, safeStreamer, 'live');
    fs.mkdirSync(folder, { recursive: true });

    const baseFilename = ensureUniqueFilename(
        path.join(folder, `${safeStreamer}_LIVE_${dateStr}_${timeStr}.mp4`),
        item.id
    );

    // Optional: anonymous IRC chat capture for the duration of the
    // recording. Sibling .chat.jsonl file. We start it BEFORE streamlink
    // so the very first chat lines after JOIN aren't dropped, and stop it
    // AFTER streamlink exits so trailing messages (e.g. "stream offline"
    // user reactions) are still captured. Chat + events span the whole
    // multi-part recording (chat is an independent IRC connection, events
    // is an independent poller), so they stay alive across resume cycles.
    let chatSession: LiveChatSession | null = null;
    if (config.capture_live_chat) {
        const chatPath = liveChatPathFor(baseFilename);
        chatSession = startLiveChatCapture(item.streamer, chatPath);
    }

    let eventsTracker: LiveEventTracker | null = null;
    if (config.log_stream_events) {
        let initialTitle = '';
        let initialGame = '';
        try {
            const info = await getLiveStreamInfo(item.streamer);
            if (info) {
                initialTitle = info.title || '';
                initialGame = info.gameName || '';
            }
        } catch { /* ignore */ }
        eventsTracker = startLiveEventsTracker(item.id, item.streamer, baseFilename, initialTitle, initialGame);
    }

    if (config.discord_notify_live_start) {
        void sendDiscordWebhook({
            title: `Recording started: ${item.streamer}`,
            description: item.title || `${item.streamer} is live`,
            color: 'live',
            fields: [
                { name: 'URL', value: item.url, inline: false },
                { name: 'Output', value: path.basename(baseFilename), inline: false }
            ]
        });
    }

    const recordingStartedAt = Date.now();
    const BYTES_FRESH_MS = 30_000;
    const MIN_HEALTHY_PART_MS = 30_000;
    const RESUME_WAIT_MS = 10_000;
    const MAX_RESUME_ATTEMPTS = 5;

    // Total-recording byte tracking. Each resumed part starts streamlink
    // fresh, so its byte counter resets to 0; we keep accumulatedBytes
    // across parts so the meta line shows the TOTAL recorded size, not
    // just the current part. Same for elapsed — recordingStartedAt is the
    // overall start, not per-part.
    let accumulatedBytes = 0;
    let currentPartBytes = 0;
    let lastBytesValue = 0;
    let lastBytesAdvancedAt = 0;
    let lastEmittedProgress: DownloadProgress | null = null;

    const computeHealth = (): 'ok' | 'stale' | 'unknown' => {
        if (lastBytesAdvancedAt === 0) return 'unknown';
        return (Date.now() - lastBytesAdvancedAt) <= BYTES_FRESH_MS ? 'ok' : 'stale';
    };

    const wrappedProgress = (p: DownloadProgress): void => {
        const bytes = Number(p.downloadedBytes) || 0;
        if (bytes > lastBytesValue) {
            lastBytesValue = bytes;
            lastBytesAdvancedAt = Date.now();
        }
        currentPartBytes = bytes;
        const totalBytes = accumulatedBytes + currentPartBytes;
        const elapsed = Math.max(1, Math.floor((Date.now() - recordingStartedAt) / 1000));
        const avgBitrateMbps = (totalBytes * 8) / elapsed / 1_000_000;
        const parts: string[] = [formatDuration(elapsed)];
        if (totalBytes > 0) parts.push(formatBytes(totalBytes));
        if (avgBitrateMbps > 0) parts.push(`${avgBitrateMbps.toFixed(1)} Mbps`);
        const next = {
            ...p,
            speed: '',
            eta: '',
            status: parts.join(' · '),
            recordingHealth: computeHealth()
        };
        lastEmittedProgress = next;
        onProgress(next);
    };

    // Health-tick: re-emit the most recent progress every 10s so the
    // renderer's health badge updates even when streamlink is silent.
    // Without this, a streamlink hung on a buffer-stall would keep showing
    // 'ok' until the next real byte event.
    const healthTick = setInterval(() => {
        if (!lastEmittedProgress) return;
        const updated: DownloadProgress = { ...lastEmittedProgress, recordingHealth: computeHealth() };
        lastEmittedProgress = updated;
        onProgress(updated);
    }, 10_000);
    healthTick.unref?.();

    const outputs: string[] = [];
    let partNumber = 1;
    let resumeCount = 0;
    let failedPartResult: DownloadResult | null = null;

    try {
        // Resume loop. Each iteration runs streamlink once. On clean exit,
        // we re-check whether the stream is still live on Twitch's side;
        // if yes, the exit was an interruption (network blip, segment
        // discontinuity, etc.) — start a new part and append. If the
        // stream really ended, break and finalize.
        while (true) {
            const partFilename = partNumber === 1
                ? baseFilename
                : ensureUniqueFilename(
                    baseFilename.replace(/\.mp4$/i, `_part${partNumber}.mp4`),
                    item.id
                );

            // Reset per-part counters — streamlink is fresh, byte counter
            // restarts at zero. lastBytesAdvancedAt stays at zero until
            // the first segment arrives, which correctly flips the health
            // dot to 'unknown' during the resume gap.
            lastBytesValue = 0;
            lastBytesAdvancedAt = 0;
            currentPartBytes = 0;

            const partStartedAt = Date.now();
            appendDebugLog('recording-part-start', { itemId: item.id, partNumber, filename: path.basename(partFilename) });

            const partResult = await downloadVODPart(item.url, partFilename, null, null, wrappedProgress, item.id, partNumber, partNumber, 0, item.quality);

            // Accumulate this part's final bytes into the running total so
            // the next part's meta line continues from the correct figure.
            let partFinalBytes = 0;
            if (fs.existsSync(partFilename)) {
                try {
                    partFinalBytes = fs.statSync(partFilename).size || 0;
                } catch { /* ignore */ }
            }
            if (partFinalBytes > 0) {
                outputs.push(partFilename);
                accumulatedBytes += partFinalBytes;
            } else {
                failedPartResult = partResult;
                // Streamlink produced no bytes — likely permission or auth
                // failure. Skip resume because retrying will hit the same
                // wall. The error from lastPartResult will surface upstream.
                appendDebugLog('recording-part-zero-bytes', { itemId: item.id, partNumber });
                break;
            }

            // Resume decision tree.
            if (cancelledItemIds.has(item.id) || !isDownloading) {
                appendDebugLog('recording-resume-cancelled', { itemId: item.id, partNumber, reason: 'cancel' });
                break;
            }
            if (!config.auto_resume_live_recording) {
                appendDebugLog('recording-resume-disabled', { itemId: item.id });
                break;
            }
            if (resumeCount >= MAX_RESUME_ATTEMPTS) {
                appendDebugLog('recording-resume-max-attempts', { itemId: item.id, max: MAX_RESUME_ATTEMPTS });
                break;
            }
            // Don't resume on suspiciously short parts — that pattern points
            // at a config issue (bad URL, auth-required stream, streamlink
            // missing plugin) where retrying will just loop and burn API
            // quota.
            const partDurationMs = Date.now() - partStartedAt;
            if (partDurationMs < MIN_HEALTHY_PART_MS) {
                appendDebugLog('recording-resume-skip-short', { itemId: item.id, partNumber, durationMs: partDurationMs });
                break;
            }

            // Only resume if Twitch still says the stream is live. If the
            // streamer actually ended their broadcast, we accept the part
            // we have and call the recording done.
            let stillLive = false;
            try {
                const info = await getLiveStreamInfo(item.streamer);
                stillLive = info?.isLive === true;
            } catch {
                // Unknown liveness — err on the side of NOT resuming to
                // avoid infinite-loop on network-out conditions where we
                // can't even reach Twitch to check. The user can always
                // restart manually.
                stillLive = false;
            }
            if (!stillLive) {
                appendDebugLog('recording-finished-stream-offline', { itemId: item.id, parts: partNumber });
                break;
            }

            appendDebugLog('recording-resume-attempt', { itemId: item.id, previousPart: partNumber, attempt: resumeCount + 1 });
            if (eventsTracker) {
                appendEventLine(eventsTracker, { type: 'recording_resume', part: partNumber + 1 });
            }
            resumeCount++;
            partNumber++;
            await sleep(RESUME_WAIT_MS);
        }
    } finally {
        clearInterval(healthTick);
    }

    if (chatSession) {
        stopLiveChatCapture(chatSession);
    }
    if (eventsTracker) {
        stopLiveEventsTracker(item.id, {
            success: outputs.length > 0,
            durationMs: Date.now() - recordingStartedAt,
            error: outputs.length === 0 ? failedPartResult?.error ?? tBackend('unknownDownloadError') : undefined
        });
    }

    if (config.discord_notify_live_end) {
        const durationSec = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000));
        const sizeBytes = accumulatedBytes;
        const success = outputs.length > 0;
        void sendDiscordWebhook({
            title: success ? `Recording finished: ${item.streamer}` : `Recording failed: ${item.streamer}`,
            description: item.title || `${item.streamer}`,
            color: success ? 'success' : 'info',
            fields: [
                { name: 'Duration', value: formatDuration(durationSec), inline: true },
                { name: 'Size', value: formatBytes(sizeBytes), inline: true },
                { name: 'Parts', value: String(outputs.length || 1), inline: true },
                { name: 'Chat captured', value: chatSession ? `${chatSession.messageCount} messages` : 'no', inline: true },
                { name: 'Output', value: path.basename(baseFilename), inline: false }
            ]
        });
    }

    if (outputs.length === 0) return failedPartResult ?? { success: false, error: tBackend('unknownDownloadError') };

    // Auto-merge resumed parts. Only attempt when (a) the user opted in,
    // (b) there's actually something to merge, and (c) the parts are all
    // present on disk. Failure is non-fatal — we keep the parts so the
    // user still has working files even if ffmpeg trips on a corrupted
    // segment header.
    let finalRecordings = outputs.slice();
    if (config.auto_merge_resumed_parts && outputs.length > 1) {
        const mergedOutput = ensureUniqueFilename(
            baseFilename.replace(/\.mp4$/i, '_merged.mp4'),
            item.id
        );
        const mergeOk = await concatVideoFiles(outputs, mergedOutput, item.id);
        if (mergeOk) {
            if (config.delete_parts_after_merge) {
                for (const partPath of outputs) {
                    try { fs.unlinkSync(partPath); } catch (e) {
                        appendDebugLog('merge-part-delete-failed', { path: partPath, error: String(e) });
                    }
                }
                finalRecordings = [mergedOutput];
            } else {
                finalRecordings = [mergedOutput, ...outputs];
            }
            appendDebugLog('merge-resumed-parts-ok', { merged: mergedOutput, partsKept: !config.delete_parts_after_merge });
        } else {
            appendDebugLog('merge-resumed-parts-failed-keeping-parts');
        }
    }

    if (chatSession && fs.existsSync(chatSession.outputPath)) {
        finalRecordings.push(chatSession.outputPath);
    }
    if (eventsTracker && fs.existsSync(eventsTracker.eventsPath)) {
        finalRecordings.push(eventsTracker.eventsPath);
    }
    return { success: true, outputFiles: finalRecordings };
}

function editedVodFolder(item: QueueItem): string | null {
    if (!item.customClip?.omissions || !item.artifactRoot) return null;
    const date = new Date(item.date);
    const dateStr = String(date.getDate()).padStart(2, '0') + '.' + String(date.getMonth() + 1).padStart(2, '0') + '.' + date.getFullYear();
    return path.join(item.artifactRoot, item.streamer.replace(/[^a-zA-Z0-9_-]/g, ''), dateStr);
}

async function downloadVOD(
    item: QueueItem,
    onProgress: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
    // Live-recording branch: URL is the channel page, no VOD id, no time
    // window. Streamlink runs until the stream ends, then we treat the
    // whole capture as a single output file.
    if (item.isLive) {
        return await downloadLiveStream(item, onProgress);
    }

    const vodId = parseVodId(item.url);
    if (!isLikelyVodUrl(item.url) || !vodId) {
        return {
            success: false,
            error: tBackend('invalidVodUrl')
        };
    }

    onProgress({
        id: item.id,
        progress: -1,
        speed: '',
        eta: '',
        status: tBackend('statusPreparingTools'),
        currentPart: 0,
        totalParts: 0
    });

    const streamlinkReady = await ensureStreamlinkInstalled();
    if (!streamlinkReady) {
        return {
            success: false,
            error: tBackend('streamlinkAutoInstallFailed')
        };
    }

    onProgress({
        id: item.id,
        progress: -1,
        speed: '',
        eta: '',
        status: tBackend('statusDownloadStarted'),
        currentPart: 0,
        totalParts: 0
    });

    const streamer = item.streamer.replace(/[^a-zA-Z0-9_-]/g, '');
    const date = new Date(item.date);
    const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;

    if (item.customClip?.omissions && !item.artifactRoot) {
        item.artifactRoot = path.resolve(config.download_path);
        saveQueue(downloadQueue);
    }
    const folder = path.join(item.customClip?.omissions ? item.artifactRoot! : config.download_path, streamer, dateStr);
    fs.mkdirSync(folder, { recursive: true });

    const totalDuration = parseDuration(item.duration_str);

    const requiredBytesEstimate = estimateRequiredDownloadBytes(item);
    const diskSpaceCheck = ensureDiskSpace(folder, requiredBytesEstimate, 'Download');
    if (!diskSpaceCheck.success) {
        return diskSpaceCheck;
    }

    const makeTemplateFilename = (
        template: string,
        templateFallback: string,
        partNum: number,
        trimStartSec: number,
        trimLengthSec: number
    ): string => {
        const relativeName = renderClipFilenameTemplate({
            template: normalizeFilenameTemplate(template, templateFallback),
            title: item.title,
            vodId,
            channel: item.streamer,
            date,
            part: partNum,
            partPadded: partNum.toString().padStart(2, '0'),
            trimStartSec,
            trimEndSec: trimStartSec + trimLengthSec,
            trimLengthSec,
            fullLengthSec: totalDuration
        });

        return path.join(folder, relativeName);
    };

    if (item.customClip?.omissions) {
        const clip = item.customClip;
        const omissions = config.download_mode === 'full'
            ? { ...clip.omissions!, partDurationSec: Math.max(60, Math.ceil(clip.durationSec)) } : clip.omissions!;
        if (!(await ensureFfmpegInstalled())) return { success: false, error: tBackend('ffmpegAutoInstallFailed') };
        const plan = planEditedVod(clip.durationSec, omissions.partDurationSec, omissions.ranges, clip.startPart, omissions.selection);
        const editRegistration = queueProcessRegistry.register(item.id, 'post-processing', {});
        if (!editRegistration.accepted) return { success: false, error: tBackend('downloadCancelled') };
        const wait = async (): Promise<boolean> => !appShutdownStarted && isDownloading && downloadQueue.some(candidate => candidate.id === item.id)
            && !cancelledItemIds.has(item.id) && await waitForQueuePhaseBoundary(item.id);
        try {
            const outputFiles = await downloadEditedVod({
                id: item.id, url: item.url, folder, duration: clip.durationSec, startPart: clip.startPart, omissions,
                namingIdentity: JSON.stringify([clip.filenameFormat, clip.filenameTemplate, item.title, item.date, item.streamer]),
                ffmpegPath: await getFFmpegPath(), ffprobePath: await getFFprobePath(), wait,
                onProcess(process) {
                    const command = process.spawnfile;
                    recordManagedToolExecution(managedToolKindFromCommand(command) || 'ffmpeg', command);
                    const registration = queueProcessRegistry.register(item.id, 'post-processing', createPhaseBoundaryProcessResource(process, () => waitForChildProcessExit(process)));
                    if (appShutdownStarted || cancelledItemIds.has(item.id) || !downloadQueue.some(candidate => candidate.id === item.id)) process.kill();
                    return () => registration.release();
                },
                async download(range, filename, progress) {
                    const clock = (seconds: number): string => {
                        const milliseconds = Math.round(seconds * 1000);
                        return formatDuration(Math.floor(milliseconds / 1000)) + '.' + String(milliseconds % 1000).padStart(3, '0');
                    };
                    const result = await downloadVODPart(item.url, filename, clock(range.start), clock(range.end - range.start), value => progress(value.progress), item.id, 1, 1, 0, item.quality);
                    if (!result.success) throw new Error(result.error || tBackend('editedVodFailed'));
                },
                filename(part) {
                    const template = clip.filenameFormat === 'template' ? clip.filenameTemplate || DEFAULT_FILENAME_TEMPLATE_PARTS
                        : clip.filenameFormat === 'parts' ? DEFAULT_FILENAME_TEMPLATE_PARTS
                            : clip.filenameFormat === 'timestamp' ? '{date}_CLIP_{trim_start}_{part}.mp4' : '{date}_{part}.mp4';
                    const relativeName = renderClipFilenameTemplate({ template: normalizeFilenameTemplate(template, DEFAULT_FILENAME_TEMPLATE_PARTS),
                        title: item.title, vodId, channel: item.streamer, date, part: part.number, partPadded: String(part.number).padStart(2, '0'),
                        trimStartSec: part.ranges[0].start, trimEndSec: part.ranges[part.ranges.length - 1].end, trimLengthSec: part.duration, fullLengthSec: clip.durationSec });
                    return ensureUniqueFilename(path.join(folder, relativeName), item.id);
                },
                checkSpace(bytes) {
                    const result = ensureDiskSpace(folder, bytes, 'MP4');
                    if (!result.success) throw new Error(result.error);
                },
                progress(progress, phase, index, count) {
                    onProgress({ id: item.id, progress, progressPhase: phase === 'download' ? 'downloading' : 'finalizing', speed: '', eta: '', currentPart: phase === 'publish' ? index : 0, totalParts: plan.parts.length,
                        status: tBackend(phase === 'download' ? 'editedVodDownloading' : phase === 'assemble' ? 'editedVodAssembling' : 'editedVodPublishing', { index, count }) });
                },
            });
            return { success: true, outputFiles };
        } catch (error) {
            appendDebugLog('edited-vod-failed', { itemId: item.id, error: String(error) });
            return { success: false, error: tBackend('editedVodFailed') };
        } finally {
            editRegistration.release();
            if (!downloadQueue.some(candidate => candidate.id === item.id)) await cleanupEditedVod(folder, item.id);
        }
    }

    // Custom Clip - download specific time range
    if (item.customClip) {
        const clip = item.customClip;
        const partDuration = config.download_mode === 'full' ? clip.durationSec : config.part_minutes * 60;

        // Helper to generate filename based on format
        const makeClipFilename = (partNum: number, startOffset: number, clipLengthSec: number): string => {
            if (clip.filenameFormat === 'template') {
                return makeTemplateFilename(
                    clip.filenameTemplate || config.filename_template_clip,
                    DEFAULT_FILENAME_TEMPLATE_CLIP,
                    partNum,
                    startOffset,
                    clipLengthSec
                );
            }

            if (clip.filenameFormat === 'timestamp') {
                const h = Math.floor(startOffset / 3600);
                const m = Math.floor((startOffset % 3600) / 60);
                const s = Math.floor(startOffset % 60);
                const timeStr = `${h.toString().padStart(2, '0')}-${m.toString().padStart(2, '0')}-${s.toString().padStart(2, '0')}`;
                return path.join(folder, `${dateStr}_CLIP_${timeStr}_${partNum}.mp4`);
            }

            if (clip.filenameFormat === 'parts') {
                // Mirrors the global filename_template_parts default:
                // `{date}_Part{part_padded}.mp4` -> e.g. 08.05.2026_Part07.mp4
                return path.join(folder, `${dateStr}_Part${partNum.toString().padStart(2, '0')}.mp4`);
            }

            return path.join(folder, `${dateStr}_${partNum}.mp4`);
        };

        // If clip is longer than part duration, split into parts
        if (clip.durationSec > partDuration) {
            const numParts = Math.ceil(clip.durationSec / partDuration);
            const downloadedFiles: string[] = [];

            for (let i = 0; i < numParts; i++) {
                if (cancelledItemIds.has(item.id)) break;

                const partNum = clip.startPart + i;
                const startOffset = clip.startSec + (i * partDuration);
                const remainingDuration = clip.durationSec - (i * partDuration);
                const thisDuration = Math.min(partDuration, remainingDuration);

                const partFilename = ensureUniqueFilename(makeClipFilename(partNum, startOffset, thisDuration), item.id);

                const result = await downloadVODPart(
                    item.url,
                    partFilename,
                    formatDuration(startOffset),
                    formatDuration(thisDuration),
                    value => onProgress(aggregateDownloadProgress(value, i * partDuration, thisDuration, clip.durationSec)),
                    item.id,
                    i + 1,
                    numParts,
                    0,
                    item.quality
                );

                if (!result.success) return result;
                downloadedFiles.push(partFilename);
            }

            return {
                success: downloadedFiles.length === numParts,
                error: downloadedFiles.length === numParts ? undefined : tBackend('notAllClipPartsDownloaded'),
                outputFiles: downloadedFiles.length === numParts ? [...downloadedFiles] : undefined
            };
        } else {
            // Single clip file
            const filename = ensureUniqueFilename(makeClipFilename(clip.startPart, clip.startSec, clip.durationSec), item.id);
            const result = await downloadVODPart(
                item.url,
                filename,
                formatDuration(clip.startSec),
                formatDuration(clip.durationSec),
                onProgress,
                item.id,
                1,
                1,
                0,
                item.quality
            );
            return result.success ? { ...result, outputFiles: [filename] } : result;
        }
    }

    // Check download mode
    if (config.download_mode === 'full' || totalDuration <= config.part_minutes * 60) {
        const filename = ensureUniqueFilename(makeTemplateFilename(
            config.filename_template_vod,
            DEFAULT_FILENAME_TEMPLATE_VOD,
            1,
            0,
            totalDuration
        ), item.id);
        const result = await downloadVODPart(item.url, filename, null, null, onProgress, item.id, 1, 1, totalDuration, item.quality);
        return result.success ? { ...result, outputFiles: [filename] } : result;
    } else {
        // Part-based download — wrappt onProgress mit einem Aggregator, der
        // pro Part den letzten bekannten %-Wert haelt und einen weighted
        // overallProgress (0-100%) zurueck an die UI emittiert. Ohne den
        // Wrapper sah die UI nur "Part X bei Y%" und der Bar sprang bei
        // Part-Wechsel von 100% zurueck auf 0%.
        const partDuration = config.part_minutes * 60;
        const numParts = Math.ceil(totalDuration / partDuration);
        const downloadedFiles: string[] = [];

        for (let i = 0; i < numParts; i++) {
            if (cancelledItemIds.has(item.id)) break;

            const startSec = i * partDuration;
            const endSec = Math.min((i + 1) * partDuration, totalDuration);
            const duration = endSec - startSec;

            const partFilename = ensureUniqueFilename(makeTemplateFilename(
                config.filename_template_parts,
                DEFAULT_FILENAME_TEMPLATE_PARTS,
                i + 1,
                startSec,
                duration
            ), item.id);

            const result = await downloadVODPart(
                item.url,
                partFilename,
                formatDuration(startSec),
                formatDuration(duration),
                value => onProgress(aggregateDownloadProgress(value, startSec, duration, totalDuration)),
                item.id,
                i + 1,
                numParts,
                duration,
                item.quality
            );

            if (!result.success) {
                return result;
            }

            downloadedFiles.push(partFilename);
        }

        return {
            success: downloadedFiles.length === numParts,
            error: downloadedFiles.length === numParts ? undefined : tBackend('notAllPartsDownloaded'),
            outputFiles: downloadedFiles.length === numParts ? [...downloadedFiles] : undefined
        };
    }
}

// ==========================================
// MERGE GROUP DOWNLOAD PIPELINE
// ==========================================
async function processDownloadMergeGroup(
    item: QueueItem,
    onProgress: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
    const mg = item.mergeGroup!;
    const artifactRootResolution = resolveMergeArtifactRoot(item, config.download_path);
    if (!artifactRootResolution.artifactRoot) {
        item.mergeRecoveryBlocked = true;
        item.last_error = tBackend('mergeRecoveryBlocked');
        saveQueue(downloadQueue);
        return { success: false, error: item.last_error };
    }
    const artifactRoot = artifactRootResolution.artifactRoot;
    if (item.artifactRoot !== artifactRoot) {
        item.artifactRoot = artifactRoot;
        saveQueue(downloadQueue);
    }
    const totalDurationSec = mg.totalDurationSec || mg.items.reduce((sum, i) => sum + parseDuration(i.duration_str), 0);
    mg.totalDurationSec = totalDurationSec;

    // ---- PHASE 1: DOWNLOADING ----
    if (mg.mergePhase === 'downloading') {
        onProgress({
            id: item.id,
            progress: -1,
            speed: '',
            eta: '',
            status: tBackend('statusPreparingTools'),
            currentPart: 0,
            totalParts: 0
        });

        const streamlinkReady = await ensureStreamlinkInstalled();
        if (!streamlinkReady) {
            return { success: false, error: tBackend('streamlinkAutoInstallFailed') };
        }

        const ffmpegReady = await ensureFfmpegInstalled();
        if (!ffmpegReady) {
            return { success: false, error: tBackend('ffmpegAutoInstallFailed') };
        }

        const streamer = mg.items[0].streamer.replace(/[^a-zA-Z0-9_-]/g, '');
        const date = new Date(mg.items[0].date);
        const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
        const folder = path.join(artifactRoot, streamer, dateStr);
        fs.mkdirSync(folder, { recursive: true });

        // Disk space pre-check: 3x total estimated size
        const estimatedBytes = mg.items.reduce((sum, i) => {
            const dur = parseDuration(i.duration_str);
            return sum + Math.ceil(dur * 500_000); // ~500KB/s estimate
        }, 0);
        const requiredBytes = Math.max(256 * 1024 * 1024, estimatedBytes * 3);
        const diskCheck = ensureDiskSpace(folder, requiredBytes, 'Merge-Group-Download');
        if (!diskCheck.success) {
            return diskCheck;
        }

        for (let i = 0; i < mg.items.length; i++) {
            if (cancelledItemIds.has(item.id)) {
                return { success: false, error: tBackend('downloadCancelled') };
            }

            // Skip already downloaded files (retry recovery)
            if (mg.downloadedFiles[i] && fs.existsSync(mg.downloadedFiles[i])) {
                appendDebugLog('merge-group-skip-existing', { index: i, file: mg.downloadedFiles[i] });
                continue;
            }

            // Reset stale per-item cancel state (global cancel already checked above)
            cancelledItemIds.delete(item.id);
            mg.currentItemIndex = i;
            mg.mergePhase = 'downloading';
            saveQueue(downloadQueue);

            const vodItem = mg.items[i];
            const tmpFilename = ensureUniqueFilename(path.join(folder, `merge_tmp_${i}_${Date.now()}.mp4`), item.id);

            // Calculate progress weighting per VOD
            const vodDuration = parseDuration(vodItem.duration_str);
            const vodWeight = vodDuration / totalDurationSec;
            const priorWeight = mg.items.slice(0, i).reduce((s, v) => s + parseDuration(v.duration_str), 0) / totalDurationSec;

            let lastVodProgress = 0;
            const result = await downloadVODPart(
                vodItem.url,
                tmpFilename,
                null,   // startTime: null = full VOD
                null,   // endTime: null = full VOD
                (progress) => {
                    if (progress.progress > 0 && progress.progress <= 100) {
                        lastVodProgress = progress.progress;
                    }
                    // Weighted progress: download phase = 0-70%
                    const overallProgress = (priorWeight + vodWeight * (lastVodProgress / 100)) * 70;
                    onProgress({
                        ...progress,
                        id: item.id,
                        progress: overallProgress,
                        status: `${getMergeGroupPhaseText('downloading')} ${i + 1}/${mg.items.length} — ${progress.status}`,
                        currentPart: i + 1,
                        totalParts: mg.items.length
                    });
                },
                item.id,
                i + 1,
                mg.items.length,
                vodDuration,
                vodItem.quality
            );

            if (!result.success) {
                return result;
            }

            mg.downloadedFiles[i] = tmpFilename;
            registerQueuePartialFile(item.id, tmpFilename);
            saveQueue(downloadQueue);
        }
    }

    // ---- PHASE 2: MERGING ----
    mg.mergePhase = 'merging';
    saveQueue(downloadQueue);
    emitQueueUpdated();

    // Check all downloaded files exist (retry recovery)
    for (let i = 0; i < mg.items.length; i++) {
        if (!mg.downloadedFiles[i] || !fs.existsSync(mg.downloadedFiles[i])) {
            mg.mergePhase = 'downloading';
            return { success: false, error: tBackend('mergeGroupFileMissing', { index: i + 1 }) };
        }
    }

    if (!mg.mergedFile || !fs.existsSync(mg.mergedFile)) {
        const streamer = mg.items[0].streamer.replace(/[^a-zA-Z0-9_-]/g, '');
        const date = new Date(mg.items[0].date);
        const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
        const folder = path.join(artifactRoot, streamer, dateStr);
        const mergedFilePath = ensureUniqueFilename(path.join(folder, `.merge_output_${Date.now()}_${process.pid}.mp4`), item.id);

        // Get files in correct order (explicit sort by index — do NOT rely on Object.values ordering)
        const sortedFiles = Object.keys(mg.downloadedFiles)
            .sort((a, b) => Number(a) - Number(b))
            .map(k => mg.downloadedFiles[Number(k)]);

        mg.mergedFile = mergedFilePath;
        saveQueue(downloadQueue);
        registerQueuePartialFile(item.id, mergedFilePath);

        const mergeSuccess = await mergeVideos(
            sortedFiles,
            mergedFilePath,
            (percent) => {
                const overallProgress = 70 + (percent / 100) * 20; // merge = 70-90%
                onProgress({
                    id: item.id,
                    progress: overallProgress,
                    speed: '',
                    eta: '',
                    status: getMergeGroupPhaseText('merging'),
                    currentPart: 0,
                    totalParts: 0
                });
            },
            totalDurationSec,
            item.id
        );

        if (!mergeSuccess) {
            try { fs.rmSync(mergedFilePath, { force: true }); } catch { }
            if (fs.existsSync(mergedFilePath)) {
                item.mergeRecoveryBlocked = true;
                item.last_error = tBackend('mergeRecoveryBlocked');
                saveQueue(downloadQueue);
                return { success: false, error: item.last_error };
            }
            delete mg.mergedFile;
            saveQueue(downloadQueue);
            return { success: false, error: tBackend('ffmpegMergeFailed') };
        }

        saveQueue(downloadQueue);
        if (!(await waitForQueuePhaseBoundary(item.id))) {
            return { success: false, error: tBackend('downloadCancelled') };
        }
    }

    // ---- PHASE 3: SPLITTING ----
    mg.mergePhase = 'splitting';
    saveQueue(downloadQueue);
    emitQueueUpdated();

    if (cancelledItemIds.has(item.id)) {
        return { success: false, error: tBackend('downloadCancelled') };
    }

    const partDuration = config.part_minutes * 60;
    const streamer = mg.items[0].streamer.replace(/[^a-zA-Z0-9_-]/g, '');
    const date = new Date(mg.items[0].date);
    const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
    const folder = path.join(artifactRoot, streamer, dateStr);
    const vodId = parseVodId(mg.items[0].url) || 'merged';

    const splitTempFilesByPart = new Map<number, string>();
    const splitResult = await splitMergedFile(
        mg.mergedFile!,
        folder,
        partDuration,
        totalDurationSec,
        (partNum: number) => {
            const startSec = (partNum - 1) * partDuration;
            const thisDuration = Math.min(partDuration, totalDurationSec - startSec);
            return renderClipFilenameTemplate({
                template: normalizeFilenameTemplate(config.filename_template_parts, DEFAULT_FILENAME_TEMPLATE_PARTS),
                title: mg.items[0].title,
                vodId,
                channel: mg.items[0].streamer,
                date,
                part: partNum,
                partPadded: partNum.toString().padStart(2, '0'),
                trimStartSec: startSec,
                trimEndSec: startSec + thisDuration,
                trimLengthSec: thisDuration,
                fullLengthSec: totalDurationSec
            });
        },
        (currentPart, totalParts) => {
            const overallProgress = 90 + ((currentPart - 1) / totalParts) * 10; // split = 90-100%
            onProgress({
                id: item.id,
                progress: overallProgress,
                speed: '',
                eta: '',
                status: `${getMergeGroupPhaseText('splitting')} ${currentPart}/${totalParts}...`,
                currentPart,
                totalParts
            });
        },
        (partIndex, outputFile, temporaryFile) => {
            const nextSplitFiles = [...(mg.splitFiles ?? [])];
            if (outputFile) nextSplitFiles[partIndex] = outputFile;
            else nextSplitFiles.splice(partIndex, 1);
            if (temporaryFile) splitTempFilesByPart.set(partIndex, temporaryFile);
            else splitTempFilesByPart.delete(partIndex);
            if (nextSplitFiles.length > 0) mg.splitFiles = nextSplitFiles;
            else delete mg.splitFiles;
            const nextTemporaryFiles = [...splitTempFilesByPart.values()];
            if (nextTemporaryFiles.length > 0) mg.splitTempFiles = nextTemporaryFiles;
            else delete mg.splitTempFiles;
            saveQueue(downloadQueue);
        },
        item.id
    );

    if (!splitResult.success) {
        const failedCleanup = new Set<string>();
        const cleanupCandidates = new Set([
            ...splitResult.files,
            ...(mg.splitFiles ?? []),
            ...(mg.splitTempFiles ?? []),
        ]);
        for (const partFile of cleanupCandidates) {
            try { if (fs.existsSync(partFile)) fs.unlinkSync(partFile); } catch { }
            if (fs.existsSync(partFile)) failedCleanup.add(partFile);
        }
        if (failedCleanup.size > 0) {
            mg.splitFiles = (mg.splitFiles ?? []).filter((filePath) => failedCleanup.has(filePath));
            mg.splitTempFiles = (mg.splitTempFiles ?? []).filter((filePath) => failedCleanup.has(filePath));
            item.mergeRecoveryBlocked = true;
            item.last_error = tBackend('mergeRecoveryBlocked');
            saveQueue(downloadQueue);
            return { success: false, error: item.last_error };
        }
        delete mg.splitFiles;
        delete mg.splitTempFiles;
        saveQueue(downloadQueue);
        return { success: false, error: tBackend('ffmpegSplitFailed') };
    }

    mg.splitFiles = splitResult.files;
    delete mg.splitTempFiles;

    // ---- PHASE 4: CLEANUP ----
    mg.mergePhase = 'cleanup';
    saveQueue(downloadQueue);

    const failedCleanup = new Set<string>();
    for (const key of Object.keys(mg.downloadedFiles)) {
        const filePath = mg.downloadedFiles[Number(key)];
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(filePath)) failedCleanup.add(filePath);
        } catch {
            failedCleanup.add(filePath);
        }
    }

    if (mg.mergedFile) {
        try {
            if (fs.existsSync(mg.mergedFile)) fs.unlinkSync(mg.mergedFile);
            if (fs.existsSync(mg.mergedFile)) failedCleanup.add(mg.mergedFile);
        } catch {
            failedCleanup.add(mg.mergedFile);
        }
    }

    if (failedCleanup.size > 0) {
        item.mergeRecoveryBlocked = true;
        item.last_error = tBackend('mergeRecoveryBlocked');
        saveQueue(downloadQueue);
        appendDebugLog('merge-group-cleanup-failed', { itemId: item.id, files: failedCleanup.size });
        return { success: false, error: item.last_error };
    }

    mg.downloadedFiles = {};
    delete mg.mergedFile;
    mg.mergePhase = 'done';
    saveQueue(downloadQueue);
    appendDebugLog('merge-group-complete', {
        itemId: item.id,
        parts: splitResult.files.length,
        totalDurationSec
    });

    return { success: true, outputFiles: [...splitResult.files] };
}

async function processOneQueueItem(item: QueueItem): Promise<void> {
    queueProcessRegistry.resetItem(item.id);
    const itemRegistration = queueProcessRegistry.register(item.id, 'post-processing', {});
    if (!itemRegistration.accepted) return;
    if (item.mergeGroup) {
        for (const filePath of Object.values(item.mergeGroup.downloadedFiles)) {
            if (filePath && fs.existsSync(filePath)) registerQueuePartialFile(item.id, filePath);
        }
        if (item.mergeGroup.mergedFile && fs.existsSync(item.mergeGroup.mergedFile)) {
            registerQueuePartialFile(item.id, item.mergeGroup.mergedFile);
        }
    }

    appendDebugLog('queue-item-start', {
        itemId: item.id,
        title: item.title,
        url: item.url
    });

    runtimeMetrics.downloadsStarted += 1;
    runtimeMetrics.activeItemId = item.id;
    runtimeMetrics.activeItemTitle = item.title;
    activeQueueItemId = item.id;

    cancelledItemIds.delete(item.id);
    applyQueueTransferState(item, 'downloading', item.progress);
    saveQueue(downloadQueue);
    emitQueueUpdated();

    item.last_error = '';

    try {
        let finalResult: DownloadResult = { success: false, error: tBackend('unknownDownloadError') };
        const maxAttempts = getRetryAttemptLimit();

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (!isDownloading || cancelledItemIds.has(item.id) || queueProcessRegistry.isCancelled(item.id)) {
                finalResult = { success: false, error: tBackend('downloadCancelled') };
                break;
            }
            appendDebugLog('queue-item-attempt', { itemId: item.id, attempt, max: maxAttempts });

            const result = item.mergeGroup
                ? await processDownloadMergeGroup(item, (progress) => {
                    recordDownloadProgress(progress);
                    if (!queuePaused) mainWindow?.webContents.send('download-progress', progress);
                })
                : await downloadVOD(item, (progress) => {
                    recordDownloadProgress(progress);
                    if (!queuePaused) mainWindow?.webContents.send('download-progress', progress);
                });

            if (result.success) {
                finalResult = result;
                break;
            }

            finalResult = result;

            if (item.mergeRecoveryBlocked) break;

            if (queueProcessRegistry.isPaused(item.id)) {
                await queueProcessRegistry.whenResumed(item.id);
                if (!isDownloading || cancelledItemIds.has(item.id) || queueProcessRegistry.isCancelled(item.id)) {
                    finalResult = { success: false, error: tBackend('downloadCancelled') };
                    break;
                }
                attempt -= 1;
                continue;
            }

            if (!isDownloading || cancelledItemIds.has(item.id) || queueProcessRegistry.isCancelled(item.id)) {
                finalResult = { success: false, error: tBackend('downloadCancelled') };
                break;
            }

            const errorClass = classifyDownloadError(result.error || '');
            runtimeMetrics.lastErrorClass = errorClass;

            if (errorClass === 'tooling' || errorClass === 'validation') {
                appendDebugLog('queue-item-no-retry', {
                    itemId: item.id,
                    errorClass,
                    error: result.error || 'unknown'
                });
                break;
            }

            if (attempt < maxAttempts) {
                const retryDelaySeconds = getRetryDelaySeconds(errorClass, attempt);
                runtimeMetrics.retriesScheduled += 1;
                runtimeMetrics.lastRetryDelaySeconds = retryDelaySeconds;

                item.last_error = tBackend('attemptFailed', { attempt, max: maxAttempts, errorClass, error: result.error || tBackend('unknownDownloadError') });
                const retryProgress = prepareQueueRetryProgress(
                    item,
                    tBackend('retryingIn', { seconds: retryDelaySeconds, errorClass }),
                );
                recordDownloadProgress(retryProgress);
                if (!queuePaused) mainWindow?.webContents.send('download-progress', retryProgress);
                saveQueue(downloadQueue);
                emitQueueUpdated();
                await Promise.race([
                    sleep(retryDelaySeconds * 1000),
                    queueProcessRegistry.whenCancelled(item.id),
                ]);
            } else {
                runtimeMetrics.retriesExhausted += 1;
            }
        }

        if (!hasQueueItemId(item.id)) {
            appendDebugLog('queue-item-finished-removed', { itemId: item.id });
            return;
        }

        applyQueueTransferState(
            item,
            finalResult.success ? 'completed' : 'error',
            finalResult.success ? 100 : item.progress,
        );
        item.last_error = finalResult.success ? '' : (finalResult.error || tBackend('unknownDownloadError'));

        if (finalResult.success && Array.isArray(finalResult.outputFiles) && finalResult.outputFiles.length > 0) {
            // Attach the produced file paths so the renderer can offer
            // "Open file" / "Show in folder" actions on completed items,
            // surviving a queue persistence round-trip.
            item.outputFiles = [...finalResult.outputFiles];
        }

        if (finalResult.success) {
            item.completedAt = new Date().toISOString();
            item.completionRecorded = true;
            item.outputBytes = downloadOutputBytes(item.outputFiles ?? []);
            saveQueue(downloadQueue, true);
        }

        // Discord webhook for non-live VOD completion. Live recordings
        // already get their own end-of-recording webhook in downloadLiveStream.
        if (finalResult.success && !item.isLive && config.discord_notify_vod_complete) {
            const totalBytes = (item.outputFiles || []).reduce((sum, f) => {
                try { return sum + (fs.statSync(f).size || 0); } catch { return sum; }
            }, 0);
            void sendDiscordWebhook({
                title: `VOD download complete: ${item.streamer}`,
                description: item.title || item.url,
                color: 'success',
                fields: [
                    { name: 'Files', value: String((item.outputFiles || []).length), inline: true },
                    { name: 'Size', value: formatBytes(totalBytes), inline: true }
                ]
            });
        }

        // Per-VOD completion notification (separate from the queue-end
        // notification fired at the end of processQueue). Off by default
        // because users with long queues would get spammed.
        if (finalResult.success && config.notify_on_each_completion) {
            try {
                if (Notification.isSupported()) {
                    const itemNotification = new Notification({
                        title: 'Twitch VOD Manager',
                        body: `${item.title || item.url}`,
                        icon: path.join(__dirname, '../build/icon.png')
                    });
                    const firstFile = item.outputFiles?.[0];
                    itemNotification.on('click', () => {
                        try {
                            if (mainWindow) {
                                if (mainWindow.isMinimized()) mainWindow.restore();
                                mainWindow.focus();
                            }
                            // Click on a per-item notification opens the
                            // file directly when we know it; falls back to
                            // the download folder otherwise.
                            if (firstFile && fs.existsSync(firstFile)) {
                                shell.showItemInFolder(firstFile);
                            } else if (config.download_path && fs.existsSync(config.download_path)) {
                                void shell.openPath(config.download_path);
                            }
                        } catch (e) {
                            appendDebugLog('per-item-notification-click-failed', String(e));
                        }
                    });
                    itemNotification.show();
                }
            } catch { /* notifications optional */ }
        }

        if (finalResult.success) {
            // Record the VOD ID so the renderer can mark this VOD as
            // already-downloaded the next time the user browses the
            // streamer's archive. Merge groups don't have a single VOD
            // ID — record each component instead.
            if (item.mergeGroup?.items?.length) {
                for (const m of item.mergeGroup.items) {
                    const id = parseVodId(m.url);
                    if (id) recordDownloadedVodId(id);
                }
            } else {
                const id = parseVodId(item.url);
                if (id) recordDownloadedVodId(id);
            }

            // Optional chat-replay download. Only for non-live, non-merge
            // VODs that have a parseable VOD id and produced at least one
            // output file. Saved as {video_basename}.chat.json next to the
            // video. Truncation is logged but not fatal.
            if (config.download_chat_replay && !item.isLive && !item.mergeGroup) {
                const vodIdForChat = parseVodId(item.url);
                const firstOutput = item.outputFiles?.[0];
                if (vodIdForChat && firstOutput) {
                    try {
                        mainWindow?.webContents.send('download-progress', {
                            id: item.id,
                            progress: 100,
                            speed: '',
                            eta: '',
                            status: tBackend('statusFetchingChatReplay'),
                            currentPart: 0,
                            totalParts: 0
                        } as DownloadProgress);

                        const replay = await fetchVodChatReplay(vodIdForChat, (count) => {
                            mainWindow?.webContents.send('download-progress', {
                                id: item.id,
                                progress: 100,
                                speed: '',
                                eta: '',
                                status: tBackend('statusChatMessagesFetched', { count: String(count) }),
                                currentPart: 0,
                                totalParts: 0
                            } as DownloadProgress);
                        }, () => cancelledItemIds.has(item.id) || queueProcessRegistry.isCancelled(item.id));

                        const chatPath = chatReplayPathFor(firstOutput);
                        const payload = {
                            videoId: vodIdForChat,
                            videoUrl: item.url,
                            streamer: item.streamer,
                            title: item.title,
                            fetchedAt: new Date().toISOString(),
                            messageCount: replay.messages.length,
                            truncated: replay.truncated,
                            pages: replay.pages,
                            messages: replay.messages
                        };
                        writeFileAtomicSync(chatPath, JSON.stringify(payload, null, 2));
                        appendDebugLog('chat-replay-saved', {
                            itemId: item.id,
                            videoId: vodIdForChat,
                            messages: replay.messages.length,
                            pages: replay.pages,
                            truncated: replay.truncated,
                            path: chatPath
                        });
                        if (Array.isArray(item.outputFiles)) {
                            item.outputFiles = [...item.outputFiles, chatPath];
                        }
                    } catch (e) {
                        // Non-fatal: video download still succeeded.
                        appendDebugLog('chat-replay-failed', { itemId: item.id, error: String(e) });
                    }
                }
            }
        }

        if (finalResult.success) {
            runtimeMetrics.downloadsCompleted += 1;
        } else {
            runtimeMetrics.downloadsFailed += 1;
        }

        appendDebugLog('queue-item-finished', {
            itemId: item.id,
            status: item.status,
            error: item.last_error
        });

        saveQueue(downloadQueue);
        const editFolder = editedVodFolder(item);
        if (editFolder && finalResult.success) await cleanupEditedVod(editFolder, item.id).catch(error => appendDebugLog('edited-vod-cleanup-failed', String(error)));
        if (!appShutdownStarted) emitQueueUpdated();
    } finally {
        queueProcessRegistry.releaseItem(item.id);
        activeDownloads.delete(item.id);
        cancelledItemIds.delete(item.id);
        // Release only THIS item's claimed filenames (other parallel downloads keep their claims)
        releaseClaimedFilenamesForItem(item.id);
        clearDownloadProgress(item.id);
    }
}

function scheduleQueueProcessing(manualOverride = false): boolean {
    if (appShutdownStarted || applicationBackupBusy || (!manualOverride && applicationAutomationPaused)) return false;
    if (!isDownloading && !canStartDownloadQueue(manualOverride)) return false;
    return queueRunLifecycle.schedule(() => processQueue(manualOverride), (error) => {
        appendDebugLog('queue-run-failed', String(error));
    });
}

async function processQueue(manualOverride = false): Promise<void> {
    if (appShutdownStarted || isDownloading || !downloadQueue.some((item) => item.status === 'pending')) return;
    if (!canStartDownloadQueue(manualOverride)) return;

    appendDebugLog('queue-start', {
        items: downloadQueue.length,
        scheduling: 'queue-order',
        performanceMode: config.performance_mode,
        parallelDownloads: config.parallel_downloads || 1
    });

    isDownloading = true;
    queuePaused = false;
    cancelledItemIds.clear();
    mainWindow?.webContents.send('download-started');
    emitQueueUpdated();

    const maxSlots = Math.min(Math.max(1, config.parallel_downloads || 1), 2);
    const activePromises = new Map<string, Promise<void>>();

    while (isDownloading) {
        // Clean up finished promises
        for (const [id] of activePromises) {
            const queueItem = downloadQueue.find(i => i.id === id);
            if (!queueItem || (queueItem.status !== 'downloading' && queueItem.status !== 'paused')) {
                activePromises.delete(id);
            }
        }

        // Fill available slots
        while (activePromises.size < maxSlots && !queuePaused) {
            const item = pickNextPendingQueueItem();
            if (!item) break;

            const itemPromise = processOneQueueItem(item);
            activePromises.set(item.id, itemPromise);
        }

        if (activePromises.size === 0) break;

        // Wait for any one download to finish before re-checking
        await Promise.race([...activePromises.values()]);
    }

    // Wait for all remaining active downloads to complete
    if (activePromises.size > 0) {
        await Promise.allSettled([...activePromises.values()]);
    }

    isDownloading = false;
    queuePaused = false;
    runtimeMetrics.activeItemId = null;
    runtimeMetrics.activeItemTitle = null;
    activeQueueItemId = null;
    activeDownloads.clear();
    cancelledItemIds.clear();

    saveQueue(downloadQueue);
    if (appShutdownStarted) {
        appendDebugLog('queue-finished', { items: downloadQueue.length, shutdown: true });
        return;
    }
    emitQueueUpdated();
    mainWindow?.webContents.send('download-finished');
    try {
        if (Notification.isSupported()) {
            const completed = downloadQueue.filter(i => i.status === 'completed').length;
            const failed = downloadQueue.filter(i => i.status === 'error').length;
            const notification = new Notification({
                title: 'Twitch VOD Manager',
                body: failed > 0
                    ? `${completed} Downloads fertig, ${failed} fehlgeschlagen`
                    : `${completed} Downloads abgeschlossen`,
                icon: path.join(__dirname, '../build/icon.png')
            });
            // Click brings the app to the foreground AND opens the download
            // folder so the user can immediately see the output files.
            notification.on('click', () => {
                try {
                    if (mainWindow) {
                        if (mainWindow.isMinimized()) mainWindow.restore();
                        mainWindow.focus();
                    }
                    if (config.download_path && fs.existsSync(config.download_path)) {
                        void shell.openPath(config.download_path);
                    }
                } catch (e) {
                    appendDebugLog('notification-click-failed', String(e));
                }
            });
            notification.show();
        }
    } catch { }
    appendDebugLog('queue-finished', { items: downloadQueue.length });
}

// ==========================================
// WINDOW CREATION
// ==========================================
function resolveNativeThemeSource(theme: string): 'system' | 'light' | 'dark' {
    if (theme === 'system') return 'system';
    return theme === 'light' ? 'light' : 'dark';
}

function createWindow(): void {
    nativeTheme.themeSource = resolveNativeThemeSource(config.theme);
    const windowIconPath = WINDOWS_APP_ICON_PATH ?? path.join(__dirname, '../build/icon.png');

    mainWindow = new BrowserWindow({
        show: false,
        width: 1400,
        height: 900,
        minWidth: 1200,
        minHeight: 700,
        title: `${WINDOWS_APP_IDENTITY.name} [v${APP_VERSION}]`,
        backgroundColor: '#0e0e10',
        icon: windowIconPath,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    if (process.platform === 'win32') {
        mainWindow.setAppDetails(createWindowsTaskbarDetails({
            identity: WINDOWS_APP_IDENTITY,
            iconPath: windowIconPath,
            executablePath: process.execPath,
            developmentRelaunchCommand: process.env.TWITCH_VOD_MANAGER_RELAUNCH_COMMAND,
            isDevelopment: IS_HOT_DEVELOPMENT,
        }));
    }
    const window = mainWindow;
    let paintReady = false;
    let rendererReady = false;
    let revealed = false;
    const reveal = () => {
        if (revealed || !paintReady || !rendererReady || window.isDestroyed()) return;
        revealed = true;
        clearTimeout(readinessTimeout);
        window.show();
        appendDebugLog('window-ready', { elapsedMs: Math.round(performance.now()) });
    };
    const readinessTimeout = setTimeout(() => {
        appendDebugLog('renderer-ready-timeout');
        rendererReady = true;
        reveal();
    }, 6000);
    const onRendererReady = (event: Electron.IpcMainEvent) => {
        if (event.sender !== window.webContents || !isTrustedRendererEvent(event)) return;
        rendererReady = true;
        appendDebugLog('renderer-ready', { elapsedMs: Math.round(performance.now()) });
        reveal();
    };
    ipcMain.on('renderer-ready', onRendererReady);
    window.once('ready-to-show', () => { paintReady = true; reveal(); });
    window.once('closed', () => {
        clearTimeout(readinessTimeout);
        ipcMain.removeListener('renderer-ready', onRendererReady);
    });

    if (process.platform !== 'darwin') {
        mainWindow.removeMenu();
    }

    const rendererFile = path.join(__dirname, 'renderer/index.html');
    const rendererUrl = pathToFileURL(rendererFile).href;
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.split(/[?#]/, 1)[0] !== rendererUrl) event.preventDefault();
    });
    mainWindow.webContents.on('console-message', (details) => {
        if (details.level === 'error' && (details.sourceId.includes('renderer-vod-player') || details.message.startsWith('vod-workspace-render-failed'))) {
            appendDebugLog('vod-player-renderer-error', { message: details.message.slice(0, 12000), source: details.sourceId, line: details.lineNumber });
        }
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    if (IS_HOT_DEVELOPMENT && fs.existsSync(path.resolve(__dirname, '../scripts/dev.mjs'))) {
        const contents = mainWindow.webContents;
        let pendingDevelopmentAction: 'reload' | 'restart' | undefined;
        let applyingDevelopmentUpdate = false;
        let developmentBuildFailed = false;
        const applyDevelopmentUpdate = async () => {
            if (!pendingDevelopmentAction || developmentBuildFailed || applyingDevelopmentUpdate || contents.isDestroyed() || contents.isLoadingMainFrame() || applicationRestoreBusy() || applicationBackupBusy) return;
            applyingDevelopmentUpdate = true;
            try {
                const prepared = await contents.executeJavaScript('typeof prepareDevelopmentRefresh === "function" && prepareDevelopmentRefresh()');
                if (!prepared || developmentBuildFailed || contents.isDestroyed() || applicationRestoreBusy() || applicationBackupBusy) return;
                const action = pendingDevelopmentAction;
                pendingDevelopmentAction = undefined;
                if (action === 'restart') {
                    app.relaunch();
                    app.quit();
                } else contents.reloadIgnoringCache();
            } catch (error) {
                appendDebugLog('development-refresh-failed', String(error));
            } finally { applyingDevelopmentUpdate = false; }
        };
        const developmentRefreshTimer = setInterval(() => { void applyDevelopmentUpdate(); }, 500);
        const live = createDevelopmentLiveUpdates(path.resolve(__dirname, '..'), update => {
            developmentBuildFailed = update.status === 'error';
            if (update.status === 'restart') pendingDevelopmentAction = 'restart';
            else if (update.status === 'reload') pendingDevelopmentAction ??= 'reload';
            appendDebugLog('development-live-update', { revision: update.revision, status: update.status, styles: update.styles.length });
            if (!contents.isDestroyed() && !contents.isLoadingMainFrame()) contents.send('development-style-update', { ...update, status: developmentBuildFailed ? 'error' : pendingDevelopmentAction || update.status });
        }, error => appendDebugLog('development-live-update-failed', String(error)));
        const deliverCurrent = () => {
            if (!contents.isDestroyed()) contents.send('development-style-update', { ...live.current(), status: developmentBuildFailed ? 'error' : pendingDevelopmentAction || 'ready' });
        };
        const sendCurrent = (event: Electron.IpcMainEvent) => {
            if (event.sender === contents && isTrustedRendererEvent(event)) deliverCurrent();
        };
        contents.on('did-finish-load', deliverCurrent);
        ipcMain.on('development-style-ready', sendCurrent);
        mainWindow.once('closed', () => {
            ipcMain.removeListener('development-style-ready', sendCurrent);
            contents.removeListener('did-finish-load', deliverCurrent);
            clearInterval(developmentRefreshTimer);
            live.stop();
        });
    }
    mainWindow.loadFile(rendererFile, { query: IS_HOT_DEVELOPMENT ? { development: '1' } : {} });

    mainWindow.webContents.on('did-finish-load', () => {
        emitQueueUpdated(true);
        emitDownloadPolicyStatus(true);
        if (isDownloading) {
            mainWindow?.webContents.send('download-started');
        }

        const updateLifecycleSnapshot = autoUpdateLifecycle.snapshot;
        if (updateLifecycleSnapshot.phase === 'ready') {
            mainWindow?.webContents.send('update-downloaded', buildUpdateInfoPayload(updateLifecycleSnapshot.version));
        }

        // Auto-resume: if the user opted in AND the persisted queue has
        // pending entries, kick off processing after a short delay so the
        // UI has time to render and the user can still pause if they want.
        if (!applicationAutomationPaused && config.auto_resume_queue_on_startup && !isDownloading) {
            const hasPending = downloadQueue.some((it) => it.status === 'pending');
            if (hasPending) {
                appendDebugLog('auto-resume-queue-scheduled', { pending: downloadQueue.filter((it) => it.status === 'pending').length });
                setTimeout(() => {
                    if (!appShutdownStarted && config.auto_resume_queue_on_startup && !isDownloading
                        && downloadQueue.some((it) => it.status === 'pending')) {
                        scheduleQueueProcessing();
                    }
                }, 5000);
            }
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Setup auto-updater after window is ready
    autoUpdaterSetupTimer = setTimeout(() => {
        autoUpdaterSetupTimer = null;
        if (!appShutdownStarted) setupAutoUpdater();
    }, 3000);
}

// ==========================================
// AUTO-UPDATER (electron-updater)
// ==========================================
function normalizeReleaseVersionCandidate(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }

    return normalizeUpdateVersion(trimmed) || trimmed.replace(/^v/i, '');
}

function cacheLatestReleaseUpdateInfo(releaseData: any): void {
    if (!releaseData || typeof releaseData !== 'object') {
        return;
    }

    const tagName = typeof releaseData.tag_name === 'string' ? releaseData.tag_name.trim() : '';
    const version = normalizeReleaseVersionCandidate(tagName)
        || normalizeReleaseVersionCandidate(releaseData.name);
    const releaseName = typeof releaseData.name === 'string' ? releaseData.name.trim() : '';
    const releaseNotes = typeof releaseData.body === 'string' ? releaseData.body : '';
    const releaseDate = typeof releaseData.published_at === 'string'
        ? releaseData.published_at
        : (typeof releaseData.created_at === 'string' ? releaseData.created_at : undefined);

    latestReleaseUpdateInfo = {
        tagName: tagName || undefined,
        version,
        releaseDate,
        releaseName: releaseName || undefined,
        releaseNotes: releaseNotes.trim() ? releaseNotes : undefined
    };
}

function buildUpdateInfoPayload(version: string, releaseDate?: string): {
    version: string;
    releaseDate?: string;
    releaseName?: string;
    releaseNotes?: string;
} {
    const normalizedVersion = normalizeReleaseVersionCandidate(version) || version;
    const cachedVersion = latestReleaseUpdateInfo?.version
        ? (normalizeReleaseVersionCandidate(latestReleaseUpdateInfo.version) || latestReleaseUpdateInfo.version)
        : undefined;
    const hasMatchingReleaseInfo = !cachedVersion || cachedVersion === normalizedVersion;

    return {
        version: normalizedVersion,
        releaseDate: releaseDate || (hasMatchingReleaseInfo ? latestReleaseUpdateInfo?.releaseDate : undefined),
        releaseName: hasMatchingReleaseInfo ? latestReleaseUpdateInfo?.releaseName : undefined,
        releaseNotes: hasMatchingReleaseInfo ? latestReleaseUpdateInfo?.releaseNotes : undefined
    };
}

async function requestUpdateCheck(source: UpdateCheckSource, force = false): Promise<{ started: boolean; reason?: string }> {
    if (appShutdownStarted) return { started: false, reason: 'shutting-down' };
    if (autoUpdateCheckCoordinator.inProgress) {
        return { started: false, reason: 'in-progress' };
    }

    const now = Date.now();
    if (!force && lastAutoUpdateCheckAt > 0 && (now - lastAutoUpdateCheckAt) < AUTO_UPDATE_MIN_CHECK_GAP_MS) {
        return { started: false, reason: 'throttled' };
    }

    const lifecycleStart = autoUpdateLifecycle.beginCheck();
    if (!lifecycleStart.started) return lifecycleStart;

    const result = await autoUpdateCheckCoordinator.run(async () => {
        lastAutoUpdateCheckAt = now;
        appendDebugLog('update-check-start', { source });
        try {
            const githubReleaseResponse = await axios.get(GITHUB_RELEASES_API_LATEST_URL, {
                timeout: 5000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Twitch-VOD-Manager'
                }
            });
            cacheLatestReleaseUpdateInfo(githubReleaseResponse.data);
            const tagName = latestReleaseUpdateInfo?.tagName || githubReleaseResponse.data?.tag_name;
            if (tagName) {
                autoUpdater.setFeedURL({
                    provider: 'generic',
                    url: `${GITHUB_RELEASES_DOWNLOAD_BASE_URL}/${tagName}/`,
                    useMultipleRangeRequest: false
                });
                appendDebugLog('github-feed-url-set', { tagName, owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME });
            }
        } catch (apiErr) {
            appendDebugLog('github-api-failed', String(apiErr));
        }
        await autoUpdater.checkForUpdates();
    }, AUTO_UPDATE_CHECK_TIMEOUT_MS);

    if (result.state === 'completed') {
        return { started: true };
    }
    if (result.state === 'timed-out') {
        const failed = autoUpdateLifecycle.failCheck();
        appendDebugLog('update-check-ui-timeout', { source, timeoutMs: AUTO_UPDATE_CHECK_TIMEOUT_MS, stateChanged: failed });
        return { started: false, reason: 'timed-out' };
    }
    if (result.state === 'in-progress') {
        return { started: false, reason: 'in-progress' };
    }

    const failed = autoUpdateLifecycle.failCheck();
    appendDebugLog('update-check-failed', { source, error: String(result.error), stateChanged: failed });
    if (failed) {
        mainWindow?.webContents.send('update-error', { message: String(result.error), kind: 'check' });
    }
    console.error('Update check failed:', result.error);
    return { started: false, reason: 'error' };
}

async function requestUpdateDownload(source: UpdateDownloadSource): Promise<{ started: boolean; reason?: string }> {
    if (appShutdownStarted) return { started: false, reason: 'shutting-down' };
    const lifecycleSnapshot = autoUpdateLifecycle.snapshot;
    const version = lifecycleSnapshot.phase === 'available' ? lifecycleSnapshot.version : latestKnownUpdateVersion || '';
    const lifecycleStart = autoUpdateLifecycle.beginDownload(version);
    if (!lifecycleStart.started) return lifecycleStart;
    appendDebugLog('update-download-start', { source, version });

    try {
        await autoUpdater.downloadUpdate();
        return { started: true };
    } catch (err) {
        const failed = autoUpdateLifecycle.failDownload(version);
        appendDebugLog('update-download-failed', { source, version, error: String(err), stateChanged: failed });
        if (failed) {
            mainWindow?.webContents.send('update-error', { message: String(err), kind: 'download', version });
        }
        console.error('Download failed:', err);
        return { started: false, reason: 'error' };
    }
}

function stopAutoUpdatePolling(): void {
    if (autoUpdaterSetupTimer) {
        clearTimeout(autoUpdaterSetupTimer);
        autoUpdaterSetupTimer = null;
    }
    if (autoUpdateCheckTimer) {
        clearInterval(autoUpdateCheckTimer);
        autoUpdateCheckTimer = null;
    }

    if (autoUpdateStartupTimer) {
        clearTimeout(autoUpdateStartupTimer);
        autoUpdateStartupTimer = null;
    }
}

function startAutoUpdatePolling(): void {
    if (appShutdownStarted) return;
    if (!autoUpdateCheckTimer) {
        autoUpdateCheckTimer = setInterval(() => {
            void requestUpdateCheck('interval');
        }, AUTO_UPDATE_CHECK_INTERVAL_MS);

        autoUpdateCheckTimer.unref?.();
    }

    if (autoUpdateStartupTimer) {
        clearTimeout(autoUpdateStartupTimer);
        autoUpdateStartupTimer = null;
    }

    autoUpdateStartupTimer = setTimeout(() => {
        autoUpdateStartupTimer = null;
        void requestUpdateCheck('startup', true);
    }, AUTO_UPDATE_STARTUP_CHECK_DELAY_MS);
}

function setupAutoUpdater() {
    if (appShutdownStarted) return;
    if (autoUpdaterInitialized) {
        startAutoUpdatePolling();
        return;
    }

    autoUpdaterInitialized = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;

    autoUpdater.on('checking-for-update', () => {
        if (autoUpdateLifecycle.snapshot.phase !== 'checking') {
            appendDebugLog('auto-updater-checking-ignored');
            return;
        }
        appendDebugLog('auto-updater-checking');
        mainWindow?.webContents.send('update-checking');
    });

    autoUpdater.on('update-available', (info) => {
        const incomingVersion = normalizeUpdateVersion(info.version);
        const displayVersion = incomingVersion || info.version;

        if (latestKnownUpdateVersion && compareUpdateVersions(incomingVersion, latestKnownUpdateVersion) < 0) {
            autoUpdateLifecycle.failCheck();
            appendDebugLog('update-available-ignored-older', {
                incomingVersion: displayVersion,
                knownVersion: latestKnownUpdateVersion
            });
            return;
        }

        if (!autoUpdateLifecycle.completeCheckAvailable(incomingVersion)) {
            appendDebugLog('update-available-ignored-state', {
                incomingVersion: displayVersion,
                phase: autoUpdateLifecycle.snapshot.phase,
            });
            return;
        }

        latestKnownUpdateVersion = incomingVersion || latestKnownUpdateVersion;

        appendDebugLog('auto-updater-update-available', { version: displayVersion });

        if (mainWindow) {
            mainWindow.webContents.send('update-available', buildUpdateInfoPayload(displayVersion, info.releaseDate));
        }

        if (AUTO_UPDATE_AUTO_DOWNLOAD) {
            void requestUpdateDownload('auto');
        }
    });

    autoUpdater.on('update-not-available', () => {
        if (!autoUpdateLifecycle.completeCheckNotAvailable()) {
            appendDebugLog('auto-updater-update-not-available-ignored', { phase: autoUpdateLifecycle.snapshot.phase });
            return;
        }
        appendDebugLog('auto-updater-update-not-available');
        mainWindow?.webContents.send('update-not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
        // No per-tick stdout — the autoUpdater fires this ~10x/sec during
        // an in-flight download. The renderer banner is the user-visible
        // surface; appendDebugLog already captures phase transitions.
        if (autoUpdateLifecycle.snapshot.phase !== 'downloading') {
            appendDebugLog('auto-updater-download-progress-ignored', { phase: autoUpdateLifecycle.snapshot.phase });
            return;
        }
        if (mainWindow) {
            mainWindow.webContents.send('update-download-progress', {
                percent: progress.percent,
                bytesPerSecond: progress.bytesPerSecond,
                transferred: progress.transferred,
                total: progress.total
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        const downloadedVersion = normalizeUpdateVersion(info.version) || info.version;
        if (!autoUpdateLifecycle.completeDownload(downloadedVersion)) {
            appendDebugLog('auto-updater-update-downloaded-ignored', {
                version: downloadedVersion,
                phase: autoUpdateLifecycle.snapshot.phase,
            });
            return;
        }
        appendDebugLog('auto-updater-update-downloaded', { version: downloadedVersion });
        if (!latestKnownUpdateVersion || compareUpdateVersions(downloadedVersion, latestKnownUpdateVersion) > 0) {
            latestKnownUpdateVersion = downloadedVersion;
        }
        if (mainWindow) {
            mainWindow.webContents.send('update-downloaded', buildUpdateInfoPayload(downloadedVersion, info.releaseDate));
        }
    });

    autoUpdater.on('error', (err) => {
        const message = String(err);
        const lifecycleSnapshot = autoUpdateLifecycle.snapshot;
        if (lifecycleSnapshot.phase === 'checking') {
            autoUpdateLifecycle.failCheck();
            appendDebugLog('auto-updater-error', { message, kind: 'check' });
            mainWindow?.webContents.send('update-error', { message, kind: 'check' });
        } else if (lifecycleSnapshot.phase === 'downloading') {
            autoUpdateLifecycle.failDownload(lifecycleSnapshot.version);
            appendDebugLog('auto-updater-error', { message, kind: 'download', version: lifecycleSnapshot.version });
            mainWindow?.webContents.send('update-error', { message, kind: 'download', version: lifecycleSnapshot.version });
        } else {
            appendDebugLog('auto-updater-error-ignored', { message, phase: lifecycleSnapshot.phase });
        }
        console.error('Auto-updater error:', err);
    });

    startAutoUpdatePolling();
}

// ==========================================
// IPC HANDLERS
// ==========================================
ipcMain.handle('get-config', () => config);

ipcMain.handle('get-download-policy-status', (event) => {
    if (!isTrustedRendererEvent(event)) return getDownloadPolicyStatus();
    return getDownloadPolicyStatus();
});

ipcMain.handle('get-secret-status', (event) => {
    if (!isTrustedRendererEvent(event) || !appSecretStore) {
        return { encryptionAvailable: false, clientSecretConfigured: false, discordWebhookConfigured: false };
    }
    return appSecretStore.status();
});

ipcMain.handle('set-client-secret', (event, value: string) => {
    if (!isTrustedRendererEvent(event) || !appSecretStore || !appSecretStore.status().encryptionAvailable) return appSecretStore?.status() ?? null;
    const update = resolveSecretInputUpdate(typeof value === 'string' ? value : '', false);
    if (update.action !== 'set') return appSecretStore.status();
    appSecretStore.set('twitch_client_secret', update.value);
    twitchClientSecret = update.value;
    twitchAppTokenService.clear();
    return appSecretStore.status();
});

ipcMain.handle('clear-client-secret', (event) => {
    if (!isTrustedRendererEvent(event) || !appSecretStore) return appSecretStore?.status() ?? null;
    appSecretStore.clear('twitch_client_secret');
    twitchClientSecret = '';
    twitchAppTokenService.clear();
    return appSecretStore.status();
});

ipcMain.handle('set-discord-webhook', (event, value: string) => {
    if (!isTrustedRendererEvent(event) || !appSecretStore || !appSecretStore.status().encryptionAvailable) return appSecretStore?.status() ?? null;
    const update = resolveSecretInputUpdate(typeof value === 'string' ? value : '', false);
    if (update.action !== 'set') return appSecretStore.status();
    appSecretStore.set('discord_webhook_url', update.value);
    discordWebhookUrl = update.value;
    return appSecretStore.status();
});

ipcMain.handle('clear-discord-webhook', (event) => {
    if (!isTrustedRendererEvent(event) || !appSecretStore) return appSecretStore?.status() ?? null;
    appSecretStore.clear('discord_webhook_url');
    discordWebhookUrl = '';
    return appSecretStore.status();
});

ipcMain.handle('get-automation-status', () => ({
    autoRecord: {
        watching: Array.isArray(config.auto_record_streamers) ? config.auto_record_streamers.length : 0,
        lastRunAt: autoRecordLastRunAt,
        nextRunAt: autoRecordNextRunAt,
        lastTriggeredCount: autoRecordLastTriggerCount,
        inFlight: autoRecordPollInFlight
    },
    autoVod: {
        watching: Array.isArray(config.auto_vod_download_streamers) ? config.auto_vod_download_streamers.length : 0,
        lastRunAt: autoVodLastRunAt,
        nextRunAt: autoVodNextRunAt,
        lastQueuedCount: autoVodLastQueuedCount,
        inFlight: autoVodPollInFlight
    }
}));

ipcMain.handle('trigger-auto-record-scan', async (event) => {
    if (!isTrustedRendererEvent(event)) return { triggered: 0 };
    const result = await runAutoRecordPoll();
    return { ...result, triggered: result.addedCount };
});

ipcMain.handle('trigger-auto-vod-scan', async (event) => {
    if (!isTrustedRendererEvent(event)) return { queuedCount: 0 };
    const result = await runAutoVodPoll();
    return { ...result, queuedCount: result.addedCount };
});

function applyConfigTransition(previousConfig: Config, nextConfig: Config): Config {
    const previousClientId = previousConfig.client_id;
    const previousCacheMinutes = previousConfig.metadata_cache_minutes;
    const previousPersistQueueOnRestart = previousConfig.persist_queue_on_restart;
    const previousTheme = previousConfig.theme;
    const previousAutoRecordList = JSON.stringify(previousConfig.auto_record_streamers || []);
    const previousAutoRecordSeconds = previousConfig.auto_record_poll_seconds;
    const previousAutoVodList = JSON.stringify(previousConfig.auto_vod_download_streamers || []);
    const previousAutoVodMinutes = previousConfig.auto_vod_download_poll_minutes;
    const previousStreamerList = JSON.stringify(previousConfig.streamers || []);
    const previousDownloadPolicy = JSON.stringify(previousConfig.download_policy);
    config = persistStateChange(previousConfig, () => nextConfig, saveConfig);
    downloadThrottleBudget.setMaxBytesPerSecond(config.download_policy.throttle?.maxBytesPerSecond ?? null);
    if (JSON.stringify(config.download_policy) !== previousDownloadPolicy && !isDownloading && downloadQueue.some((item) => item.status === 'pending')) {
        scheduleQueueProcessing();
    } else {
        emitDownloadPolicyStatus(true);
    }

    if (config.client_id !== previousClientId) {
        twitchAppTokenService.clear();
    }

    if (config.metadata_cache_minutes !== previousCacheMinutes) {
        clearMetadataCaches();
    }

    if (config.theme !== previousTheme) {
        nativeTheme.themeSource = resolveNativeThemeSource(config.theme);
    }

    if (config.persist_queue_on_restart === false) {
        pendingQueueSnapshot = null;
        if (queueSaveTimer) {
            clearTimeout(queueSaveTimer);
            queueSaveTimer = null;
        }
        clearQueueFileFromDisk();
    } else if (previousPersistQueueOnRestart === false) {
        saveQueue(downloadQueue, true);
    }

    const newAutoRecordList = JSON.stringify(config.auto_record_streamers || []);
    if (newAutoRecordList !== previousAutoRecordList || config.auto_record_poll_seconds !== previousAutoRecordSeconds) {
        const watched = new Set(config.auto_record_streamers || []);
        for (const k of Array.from(autoRecordLastLiveState.keys())) {
            if (!watched.has(k)) autoRecordLastLiveState.delete(k);
        }
        restartAutoRecordPoller();
    }

    const newAutoVodList = JSON.stringify(config.auto_vod_download_streamers || []);
    if (newAutoVodList !== previousAutoVodList || config.auto_vod_download_poll_minutes !== previousAutoVodMinutes) {
        restartAutoVodPoller();
    }

    const newStreamerList = JSON.stringify(config.streamers || []);
    if (newStreamerList !== previousStreamerList) {
        restartLiveStatusPoller();
    }

    restartAutoCleanupTimer();
    return config;
}

ipcMain.handle('save-config', (event, newConfig: Partial<Config>, fileCapability?: string) => {
    if (!isTrustedRendererEvent(event)) return config;
    const acceptedConfig = sanitizeConfigInput(newConfig) as Partial<Config>;
    if (typeof acceptedConfig.download_path === 'string' && acceptedConfig.download_path !== config.download_path) {
        const selectedPath = typeof fileCapability === 'string'
            ? resolveFileCapability(event, fileCapability, 'selected-folder')
            : null;
        if (!selectedPath || normalizeComparablePath(selectedPath) !== normalizeComparablePath(acceptedConfig.download_path)) {
            delete acceptedConfig.download_path;
        }
    }
    const previousConfig = config;
    const nextConfig = normalizeConfigTemplates({ ...previousConfig, ...acceptedConfig });
    return applyConfigTransition(previousConfig, nextConfig);
});

ipcMain.handle('login', async (event) => {
    if (!isTrustedRendererEvent(event)) return false;
    return (await ensureTwitchAuth(true)) !== null;
});

ipcMain.handle('get-user-id', async (_, username: string) => {
    return await getUserId(username);
});

ipcMain.handle('get-vods', async (_, userId: string, forceRefresh: boolean = false) => {
    return await getVODs(userId, forceRefresh);
});

ipcMain.handle('get-queue', (event) => {
    if (!isTrustedRendererEvent(event)) return [];
    rememberQueueFilePaths(downloadQueue);
    return downloadQueue;
});

ipcMain.handle('start-live-recording', async (event, streamerName: string) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return { success: false, error: 'Access denied' };
    if (typeof streamerName !== 'string' || !streamerName) {
        return { success: false, error: 'Invalid streamer name' };
    }
    const login = normalizeLogin(streamerName);
    if (!login) return { success: false, error: 'Invalid streamer name' };

    const liveInfo = await getLiveStreamInfo(login);
    if (appShutdownStarted) return { success: false, error: 'Access denied' };
    if (liveInfo === null) {
        return { success: false, error: 'Could not check live status. Try again.' };
    }
    if (!liveInfo.isLive) {
        return { success: false, error: 'OFFLINE', streamer: login };
    }

    const channelUrl = `https://www.twitch.tv/${login}`;
    const liveItem: QueueItem = {
        id: generateQueueItemId(),
        createdAt: new Date().toISOString(),
        title: liveInfo.title || `${login} (LIVE)`,
        url: channelUrl,
        date: new Date().toISOString(),
        streamer: login,
        duration_str: '0s', // unknown — stream is in progress
        status: 'pending',
        progress: 0,
        isLive: true
    };

    // Duplicate guard — refuse to start a second live recording of the
    // same channel while one is already active or pending.
    const dup = downloadQueue.some((it) => it.isLive && it.streamer === login
        && (it.status === 'pending' || it.status === 'downloading'));
    if (dup) {
        return { success: false, error: 'ALREADY_RECORDING', streamer: login };
    }

    const addition = commitQueueItemWithResult(liveItem, false);
    if (!addition.accepted) {
        return { success: false, error: addition.reason === 'duplicate' ? 'ALREADY_RECORDING' : addition.reason, streamer: login };
    }
    if (!isDownloading) scheduleQueueProcessing();
    appendDebugLog('live-recording-queued', { streamer: login, title: liveItem.title });
    return { success: true, streamer: login, title: liveInfo.title || login };
});

function commitQueueItemWithResult(item: QueueItem | null, notifyDuplicate: boolean): QueueAdditionResult<QueueItem> {
    if (appShutdownStarted) {
        return { queue: downloadQueue, accepted: false, reason: 'shutting-down' };
    }
    let duplicate = false;
    const result = commitQueueAddition(
        downloadQueue,
        item,
        (candidate) => {
            duplicate = config.prevent_duplicate_downloads && hasActiveDuplicate(candidate);
            return duplicate;
        },
        saveQueue,
    );
    if (duplicate && item) {
        runtimeMetrics.duplicateSkips += 1;
        if (notifyDuplicate) {
            mainWindow?.webContents.send('queue-duplicate-skipped', {
                title: item.title,
                streamer: item.streamer,
                url: item.url
            });
        }
        appendDebugLog('queue-item-duplicate-skipped', {
            title: item.title,
            url: item.url,
            streamer: item.streamer
        });
    }
    if (result.accepted) {
        downloadQueue = result.queue;
        emitQueueUpdated();
    } else if (result.reason === 'persistence-failed') {
        appendDebugLog('queue-item-persist-failed', { title: item?.title || '', url: item?.url || '' });
    }
    return result;
}

function addRendererQueueItemWithResult(input: unknown, notifyDuplicate: boolean): QueueAdditionResult<QueueItem> {
    const item = createRendererQueueItem(input, generateQueueItemId());
    if (item) item.createdAt = new Date().toISOString();
    return commitQueueItemWithResult(item, notifyDuplicate);
}

registerTrustedIpcHandler(ipcMain, 'add-to-queue', isTrustedRendererEvent, () => [], (_, input: unknown) => {
    return addRendererQueueItemWithResult(input, true).queue;
});

registerTrustedIpcHandler(ipcMain, 'add-to-queue-with-result', isTrustedRendererEvent, () => ({ queue: [], accepted: false, reason: 'access-denied' as const }), (_, input: unknown) => {
    return addRendererQueueItemWithResult(input, false);
});

registerTrustedIpcHandler(ipcMain, 'remove-from-queue', isTrustedRendererEvent, () => Promise.resolve(downloadQueue), async (_, id: string) => {
    if (typeof id !== 'string' || !id) return downloadQueue;
    const wasActiveItem = activeQueueItemId === id || activeDownloads.has(id) || queueProcessRegistry.activeItemIds().includes(id);
    const removedItem = downloadQueue.find((item) => item.id === id);

    if (removedItem?.mergeRecoveryBlocked) {
        const recovery = recoverInterruptedMergeArtifacts([removedItem], config.download_path, new Set([removedItem.id]));
        const recoveredItem = recovery.queue[0];
        if (recovery.failedFiles.length > 0) {
            recoveredItem.last_error = tBackend('mergeRecoveryBlocked');
            downloadQueue = persistStateChange(downloadQueue, (current) => current.map((item) => item.id === id ? recoveredItem : item), saveQueue);
            emitQueueUpdated();
            return downloadQueue;
        }
        downloadQueue = persistStateChange(downloadQueue, (current) => current.map((item) => item.id === id ? recoveredItem : item), saveQueue);
    }

    await commitQueueMutation(
        downloadQueue,
        (current) => current.filter((item) => item.id !== id),
        saveQueue,
        (nextQueue) => { downloadQueue = nextQueue; },
        async () => {
            if (wasActiveItem) {
                cancelledItemIds.add(id);
                await queueProcessRegistry.cancelItem(id);
                activeDownloads.delete(id);
                const nextActiveId = queueProcessRegistry.activeItemIds()[0] || null;
                activeQueueItemId = nextActiveId;
                runtimeMetrics.activeItemId = nextActiveId;
                runtimeMetrics.activeItemTitle = nextActiveId ? downloadQueue.find((item) => item.id === nextActiveId)?.title || null : null;
                appendDebugLog('queue-item-removed-active-cancelled', { id });
            }
            const editFolder = removedItem ? editedVodFolder(removedItem) : null;
            if (editFolder && !wasActiveItem) await cleanupEditedVod(editFolder, id);
            for (const cleanupPath of getMergeGroupCleanupPaths(removedItem)) {
                try { if (fs.existsSync(cleanupPath)) fs.unlinkSync(cleanupPath); } catch { }
            }
        },
    );
    emitQueueUpdated();
    return downloadQueue;
});

ipcMain.handle('clear-completed', (event) => {
    if (!isTrustedRendererEvent(event)) return downloadQueue;
    downloadQueue = persistStateChange(downloadQueue, (current) => current.filter((item) => item.status !== 'completed'), saveQueue);
    emitQueueUpdated();
    return downloadQueue;
});

ipcMain.handle('reorder-queue', (event, orderIds: string[]) => {
    if (!isTrustedRendererEvent(event) || !Array.isArray(orderIds)) return downloadQueue;
    const order = new Map(orderIds.map((id, idx) => [id, idx]));
    const withOrder = [...downloadQueue].sort((a, b) => {
        const ai = order.has(a.id) ? (order.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = order.has(b.id) ? (order.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
    });

    downloadQueue = persistStateChange(downloadQueue, () => withOrder, saveQueue);
    emitQueueUpdated();
    return downloadQueue;
});

ipcMain.handle('retry-failed-downloads', async (event) => {
    if (!isTrustedRendererEvent(event)) return downloadQueue;
    const failedIds = downloadQueue.filter((item) => item.status === 'error' && !item.mergeRecoveryBlocked).map((item) => item.id);
    await Promise.all(failedIds.map((id) => queueProcessRegistry.cancelItem(id)));
    for (const id of failedIds) queueProcessRegistry.resetItem(id);
    const nextQueue: QueueItem[] = downloadQueue.map((item) => {
        if (item.status !== 'error' || item.mergeRecoveryBlocked) return item;

        return { ...clearQueueTransferState(item, 'pending', 0), last_error: '' };
    });

    downloadQueue = persistStateChange(downloadQueue, () => nextQueue, saveQueue);
    emitQueueUpdated();

    if (!isDownloading) {
        scheduleQueueProcessing();
    }

    return downloadQueue;
});

ipcMain.handle('retry-queue-item', async (event, id: string) => {
    if (!isTrustedRendererEvent(event)) return downloadQueue;
    if (typeof id !== 'string' || !id) return downloadQueue;
    const idx = downloadQueue.findIndex((it) => it.id === id);
    if (idx < 0) return downloadQueue;
    const item = downloadQueue[idx];
    if (item.status !== 'error' || item.mergeRecoveryBlocked) return downloadQueue;

    await queueProcessRegistry.cancelItem(id);
    queueProcessRegistry.resetItem(id);

    downloadQueue = persistStateChange(downloadQueue, (current) => current.map((candidate) => candidate.id === id
        ? { ...clearQueueTransferState(candidate, 'pending', 0), last_error: '' }
        : candidate), saveQueue);
    emitQueueUpdated();
    appendDebugLog('queue-item-retry-single', { id, title: item.title });

    if (!isDownloading) {
        scheduleQueueProcessing();
    }

    return downloadQueue;
});

ipcMain.handle('create-merge-group', (event, itemIds: string[]) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted || !Array.isArray(itemIds)) return downloadQueue;
    const selectedItems = downloadQueue.filter(item => itemIds.includes(item.id));

    if (selectedItems.length < 2) {
        return downloadQueue;
    }

    // Validate all are pending
    if (selectedItems.some(item => item.status !== 'pending' || item.customClip || item.mergeGroup || item.isLive)) {
        return downloadQueue;
    }

    // Preserve user-defined order from renderer (itemIds array order)
    const sorted = itemIds
        .map(id => selectedItems.find(item => item.id === id))
        .filter((item): item is QueueItem => item !== undefined);

    // Calculate total duration
    const totalDurationSec = sorted.reduce((sum, item) => sum + parseDuration(item.duration_str), 0);
    const totalDurationStr = (() => {
        const h = Math.floor(totalDurationSec / 3600);
        const m = Math.floor((totalDurationSec % 3600) / 60);
        const s = totalDurationSec % 60;
        const parts: string[] = [];
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);
        if (s > 0 || parts.length === 0) parts.push(`${s}s`);
        return parts.join('');
    })();

    // Generate title (language-aware)
    const first = sorted[0];
    const isEnglish = config.language === 'en';
    const title = sorted.length === 2
        ? `Merge: ${first.title} + ${sorted[1].title}`
        : `Merge: ${first.title} + ${sorted.length - 1} ${isEnglish ? 'more' : 'weitere'}`;

    // Build merge group
    const mergeGroup: MergeGroup = {
        items: sorted.map(item => ({
            url: item.url,
            title: item.title,
            date: item.date,
            streamer: item.streamer,
            duration_str: item.duration_str,
            quality: item.quality,
            qualityLabel: item.qualityLabel
        })),
        mergePhase: 'downloading',
        currentItemIndex: 0,
        downloadedFiles: {},
        totalDurationSec
    };

    // Create merged queue item
    const mergedItem: QueueItem = {
        id: generateQueueItemId(),
        createdAt: new Date().toISOString(),
        title,
        url: first.url,
        date: first.date,
        streamer: first.streamer,
        duration_str: totalDurationStr,
        status: 'pending',
        progress: 0,
        mergeGroup
    };

    // Find position of first selected item
    const firstIndex = downloadQueue.findIndex(item => itemIds.includes(item.id));

    // Remove selected items and insert merged item at first position
    const nextQueue = downloadQueue.filter((item) => !itemIds.includes(item.id));
    nextQueue.splice(firstIndex >= 0 ? Math.min(firstIndex, nextQueue.length) : nextQueue.length, 0, mergedItem);
    downloadQueue = persistStateChange(downloadQueue, () => nextQueue, saveQueue);
    emitQueueUpdated();
    return downloadQueue;
});

ipcMain.handle('start-download', async (event, manualOverride: unknown = false) => {
    if (!isTrustedRendererEvent(event)) return false;
    if (isDownloading && queuePaused) {
        const nextQueue = downloadQueue.map((item) => item.status === 'paused'
            ? clearQueueTransferState(item, 'downloading', item.progress)
            : item);
        saveQueue(nextQueue);
        downloadQueue = applyQueueSnapshotPreservingActiveItems(downloadQueue, nextQueue, new Set(queueProcessRegistry.activeItemIds()));
        queuePaused = false;
        await Promise.all(queueProcessRegistry.activeItemIds().map((id) => queueProcessRegistry.resumeItem(id)));
        emitQueueUpdated(true);
        mainWindow?.webContents.send('download-started');
        return true;
    }

    const nextQueue = downloadQueue.map((item) => item.status === 'paused'
        ? clearQueueTransferState(item, 'pending', 0)
        : item);

    const hasPendingItems = nextQueue.some(item => item.status === 'pending');
    if (!hasPendingItems) {
        emitQueueUpdated();
        return false;
    }

    downloadQueue = persistStateChange(downloadQueue, () => nextQueue, saveQueue);
    emitQueueUpdated();

    if (!isDownloading) {
        scheduleQueueProcessing(manualOverride === true);
    }
    return true;
});

ipcMain.handle('pause-download', async (event) => {
    if (!isTrustedRendererEvent(event)) return false;
    if (!isDownloading || queuePaused) return false;

    const nextQueue = downloadQueue.map((item) => {
        if (item.status !== 'downloading') return item;
        const waitsForBoundary = Boolean(item.mergeGroup && (item.mergeGroup.mergePhase === 'merging' || item.mergeGroup.mergePhase === 'splitting'));
        return {
            ...item,
            status: waitsForBoundary ? 'downloading' as const : 'paused' as const,
            speed: '',
            eta: '',
            progressStatus: waitsForBoundary ? tBackend('downloadPausePending') : tBackend('downloadPaused'),
            recordingHealth: undefined,
        };
    });
    await commitQueueMutation(
        downloadQueue,
        () => nextQueue,
        saveQueue,
        (candidate) => {
            downloadQueue = applyQueueSnapshotPreservingActiveItems(downloadQueue, candidate, new Set(queueProcessRegistry.activeItemIds()));
            queuePaused = true;
        },
        async () => {
            await Promise.all(queueProcessRegistry.activeItemIds().map((id) => queueProcessRegistry.pauseItem(id)));
        },
    );
    emitQueueUpdated(true);
    mainWindow?.webContents.send('download-paused');
    return true;
});

ipcMain.handle('cancel-download', async (event) => {
    if (!isTrustedRendererEvent(event)) return false;
    isDownloading = false;
    queuePaused = false;
    const activeItemIds = queueProcessRegistry.activeItemIds();
    for (const id of activeItemIds) cancelledItemIds.add(id);
    await queueProcessRegistry.cancelAll();
    return true;
});

const fileCapabilities = new FileCapabilityStore();
const VIDEO_FILE_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ts', 'avi'];
const knownRendererPaths = new Map<FileCapabilityPurpose, Set<string>>();
const activeChatReadControllers = new Map<number, Map<string, AbortController>>();

function issueFileCapability(event: IpcMainInvokeEvent, purpose: FileCapabilityPurpose, filePath: string, kind: 'input-file' | 'output-file' | 'directory', extensions: string[] = [], ttlMs?: number): FileCapabilityReference {
    return fileCapabilities.issue({ ownerId: event.sender.id, purpose, path: filePath, kind, extensions, ttlMs });
}

function resolveFileCapability(event: IpcMainInvokeEvent, token: string, purpose: FileCapabilityPurpose, consume = false, protectedPaths: string[] = []): string | null {
    if (!isTrustedRendererEvent(event)) return null;
    try {
        return consume
            ? fileCapabilities.consume(token, event.sender.id, purpose, protectedPaths)
            : fileCapabilities.resolve(token, event.sender.id, purpose);
    } catch (error) {
        appendDebugLog('file-capability-rejected', { purpose, error: String(error) });
        return null;
    }
}

function rememberRendererPath(purpose: FileCapabilityPurpose, filePath: string): void {
    if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) return;
    rememberResolvedRendererPath(purpose, normalizeComparablePath(filePath));
}

function rememberResolvedRendererPath(purpose: FileCapabilityPurpose, normalized: string): void {
    const paths = knownRendererPaths.get(purpose) ?? new Set<string>();
    paths.delete(normalized);
    paths.add(normalized);
    while (paths.size > 4096) paths.delete(paths.values().next().value as string);
    knownRendererPaths.set(purpose, paths);
}

function rememberQueueFilePaths(queueItems: QueueItem[]): void {
    for (const item of queueItems) {
        for (const filePath of item.outputFiles ?? []) {
            rememberRendererPath('open-file', filePath);
            rememberRendererPath('show-in-folder', filePath);
            if (/\.(?:chat\.json|chat\.jsonl|events\.jsonl)$/i.test(filePath)) rememberRendererPath('chat-input', filePath);
        }
    }
}

function isKnownRendererPath(purpose: FileCapabilityPurpose, candidate: string): boolean {
    if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) return false;
    const normalized = normalizeComparablePath(candidate);
    if (purpose === 'selected-folder' && normalized === normalizeComparablePath(config.download_path)) return true;
    return knownRendererPaths.get(purpose)?.has(normalized) === true;
}

ipcMain.handle('select-folder', async (event) => {
    if (!isTrustedRendererEvent(event)) return null;
    const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory']
    });
    const selectedPath = result.filePaths[0];
    if (!selectedPath) return null;
    const capability = issueFileCapability(event, 'selected-folder', selectedPath, 'directory');
    return { ...capability, displayPath: selectedPath };
});

ipcMain.handle('select-video-file', async (event) => {
    if (!isTrustedRendererEvent(event)) return null;
    const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        filters: [
            { name: 'Video Files', extensions: VIDEO_FILE_EXTENSIONS }
        ]
    });
    return result.filePaths[0]
        ? issueFileCapability(event, 'cutter-input', result.filePaths[0], 'input-file', VIDEO_FILE_EXTENSIONS, CUTTER_SESSION_CAPABILITY_TTL_MS)
        : null;
});

ipcMain.handle('grant-dropped-video', (event, filePath: string): FileCapabilityReference | null => {
    if (!isTrustedRendererEvent(event)) return null;
    try {
        return issueFileCapability(event, 'cutter-input', filePath, 'input-file', VIDEO_FILE_EXTENSIONS, CUTTER_SESSION_CAPABILITY_TTL_MS);
    } catch {
        return null;
    }
});

ipcMain.handle('authorize-managed-path', (event, purpose: FileCapabilityPurpose, pathOrCapability: string): FileCapabilityReference | null => {
    if (!isTrustedRendererEvent(event) || !['selected-folder', 'chat-input', 'open-file', 'show-in-folder'].includes(purpose)) return null;
    try {
        const existingPath = fileCapabilities.resolve(pathOrCapability, event.sender.id, purpose);
        return { token: pathOrCapability, name: path.basename(existingPath) };
    } catch { }
    if (!isKnownRendererPath(purpose, pathOrCapability)) return null;
    if (purpose === 'selected-folder') {
        if (!fs.statSync(pathOrCapability).isDirectory()) return null;
        return issueFileCapability(event, purpose, pathOrCapability, 'directory');
    }
    const extensions = purpose === 'chat-input' ? ['.chat.json', '.chat.jsonl', '.events.jsonl'] : [];
    return issueFileCapability(event, purpose, pathOrCapability, 'input-file', extensions);
});

ipcMain.handle('open-folder', async (event, capability: string) => {
    const folderPath = resolveFileCapability(event, capability, 'selected-folder', true);
    if (folderPath) await shell.openPath(folderPath);
});

const SAFE_ARCHIVE_OPEN_EXTENSIONS = new Set([
    '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ts', '.avi',
    '.aac', '.m4a', '.mp3', '.wav', '.ogg',
    '.json', '.jsonl', '.txt', '.srt', '.vtt',
    '.jpg', '.jpeg', '.png', '.webp'
]);

ipcMain.handle('open-file', async (event, capability: string): Promise<boolean> => {
    const filePath = resolveFileCapability(event, capability, 'open-file', true);
    if (!filePath) return false;
    const ext = path.extname(filePath).toLowerCase();
    if (!SAFE_ARCHIVE_OPEN_EXTENSIONS.has(ext)) {
        appendDebugLog('open-file-rejected-extension', { ext, path: filePath.slice(0, 200) });
        return false;
    }
    const result = await shell.openPath(filePath);
    // shell.openPath returns '' on success, an error string on failure.
    return result === '';
});

ipcMain.handle('show-in-folder', (event, capability: string): boolean => {
    const filePath = resolveFileCapability(event, capability, 'show-in-folder', true);
    if (!filePath) return false;
    shell.showItemInFolder(filePath);
    return true;
});

ipcMain.handle('get-version', () => APP_VERSION);

ipcMain.handle('check-update', async (event) => {
    if (!isTrustedRendererEvent(event)) return { error: true };
    try {
        setupAutoUpdater();
        const result = await requestUpdateCheck('manual', true);
        if (result.reason === 'error') {
            return { error: true };
        }

        return result.started
            ? { checking: true }
            : { checking: true, skipped: result.reason };
    } catch (err) {
        console.error('Update check failed:', err);
        return { error: true };
    }
});

ipcMain.handle('download-update', async (event) => {
    if (!isTrustedRendererEvent(event)) return { error: true };
    try {
        setupAutoUpdater();
        const result = await requestUpdateDownload('manual');
        if (result.reason === 'error') {
            return { error: true };
        }

        return result.started
            ? { downloading: true }
            : { downloading: true, skipped: result.reason };
    } catch (err) {
        console.error('Download failed:', err);
        return { error: true };
    }
});

ipcMain.handle('install-update', (event) => {
    if (!isTrustedRendererEvent(event)) return;
    autoUpdater.quitAndInstall(true, true);
});

ipcMain.handle('open-external', async (event, url: string) => {
    if (!isTrustedRendererEvent(event)) return;
    // Only allow https / http URLs — never let the renderer push a
    // file://, javascript:, or shell:-style URL through to the OS
    // shell.openExternal handler. The renderer is contextIsolated +
    // nodeIntegration: false, but an XSS through (e.g.) a streamer name
    // smuggling a payload into a template would otherwise hand the
    // attacker shell.openExternal which on Windows happily resolves
    // file:///C:/Windows/System32/calc.exe.
    if (typeof url !== 'string') return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
        appendDebugLog('open-external-rejected', { url: trimmed.slice(0, 200) });
        return;
    }
    await shell.openExternal(trimmed);
});

interface ActiveClipDownloadTracking {
    process: ChildProcess;
    output: PausableOutput;
    partialFilename: string;
    cancelled: boolean;
}
interface ClipRequest {
    ownerId: number;
    controller: AbortController;
    progress: ClipTransferProgress;
    tracking?: ActiveClipDownloadTracking;
}
interface ClipResult { success: boolean; cancelled?: boolean; error?: string; filename?: string }
const activeClipProcesses = new Set<ActiveClipDownloadTracking>();
const clipRequests = new Map<string, ClipRequest>();
let workspaceSession: WorkspaceSessionStore;
const mergeWorkspaceFiles = new Map<string, WorkspaceMergeFile>();

function publishClipProgress(request: ClipRequest): void {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === request.ownerId) mainWindow.webContents.send('clip-progress', request.progress);
}

function cancelClipRequest(request: ClipRequest): void {
    request.controller.abort();
    if (request.tracking) {
        request.tracking.cancelled = true;
        try { request.tracking.process.kill(); } catch {}
        void request.tracking.output.cancel().catch(() => {});
    }
}

async function prepareClipStep<T>(request: ClipRequest, operation: Promise<T>): Promise<T> {
    const signal = request.controller.signal;
    if (signal.aborted) throw new Error('cancelled');
    return await new Promise<T>((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

registerTrustedIpcHandler(ipcMain, 'get-clip-info', isTrustedRendererEvent, () => Promise.resolve(null), async (_, clipUrl: unknown): Promise<{ title: string; broadcaster_name: string } | null> => {
    if (appShutdownStarted) return null;
    const clipId = parseTwitchClipId(clipUrl);
    return clipId ? await getClipInfo(clipId) : null;
});

ipcMain.handle('cancel-clip-download', (event, requestId: string) => {
    if (!isTrustedRendererEvent(event)) return false;
    const request = clipRequests.get(requestId);
    if (!request || request.ownerId !== event.sender.id) return false;
    cancelClipRequest(request);
    return true;
});

async function performClipDownload(clipId: string, request: ClipRequest): Promise<ClipResult> {
    const clipInfo = await prepareClipStep(request, getClipInfo(clipId));
    if (!clipInfo) return { success: false, error: tBackend('clipNotFound') };
    if (!(await prepareClipStep(request, ensureStreamlinkInstalled()))) return { success: false, error: tBackend('streamlinkAutoInstallFailed') };
    if (!(await prepareClipStep(request, ensureFfmpegInstalled()))) return { success: false, error: tBackend('ffmpegAutoInstallFailed') };
    if (appShutdownStarted || request.controller.signal.aborted) return { success: false, cancelled: true };
    const safeBroadcaster = sanitizeClipFilename(clipInfo.broadcaster_name || '', 'unknown');
    const folder = path.join(config.download_path, 'Clips', safeBroadcaster);
    fs.mkdirSync(folder, { recursive: true });
    const diskCheck = ensureDiskSpace(folder, 128 * 1024 * 1024, 'Clip-Download');
    if (!diskCheck.success) return { success: false, error: diskCheck.error || tBackend('diskSpaceShortGeneric') };
    const filename = ensureUniqueFilename(path.join(folder, sanitizeClipFilename(clipInfo.title || '') + '.mp4'), clipId);
    let partialFilename: string | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    try {
        partialFilename = partialDownloadRegistry.begin(filename);
        const command = await getStreamlinkCommand();
        if (request.controller.signal.aborted || appShutdownStarted) return { success: false, cancelled: true };
        recordManagedToolExecution('streamlink', command.command);
        const proc = spawn(command.command, [...command.prefixArgs, 'https://clips.twitch.tv/' + clipId, getStreamlinkStreamArg(), '--stdout'], { windowsHide: true });
        if (!proc.stdout) { proc.kill(); return { success: false, error: tBackend('unknownDownloadError') }; }
        proc.stderr?.resume();
        const output = createPausableOutput(proc.stdout, fs.createWriteStream(partialFilename, { flags: 'w' }), createDownloadThrottleTransform());
        const tracking: ActiveClipDownloadTracking = { process: proc, output, partialFilename, cancelled: false };
        request.tracking = tracking;
        activeClipProcesses.add(tracking);
        const outputFinished = output.finished.then(() => null, error => { try { proc.kill(); } catch {} return error; });
        request.progress.phase = 'downloading';
        let previousBytes = 0;
        let previousTime = Date.now();
        proc.stdout.on('data', (chunk: Buffer) => { request.progress.bytes += chunk.length; });
        progressTimer = setInterval(() => {
            const now = Date.now();
            request.progress.bytesPerSecond = Math.max(0, (request.progress.bytes - previousBytes) * 1000 / Math.max(1, now - previousTime));
            previousBytes = request.progress.bytes;
            previousTime = now;
            publishClipProgress(request);
        }, 300);
        progressTimer.unref();
        publishClipProgress(request);
        appendDebugLog('clip-download-start', { clipId, filename });
        const code = await new Promise<number | null>(resolve => {
            proc.once('close', resolve);
            proc.once('error', () => { void output.cancel().finally(() => resolve(-1)); });
        });
        const outputError = await outputFinished;
        clearInterval(progressTimer);
        if (request.controller.signal.aborted || appShutdownStarted) return { success: false, cancelled: true };
        if (outputError || code !== 0 || !fs.existsSync(partialFilename)) return { success: false, error: tBackend('downloadFailedExitCode', { code: String(code ?? -1) }) };
        const stats = fs.statSync(partialFilename);
        if (stats.size < 16 * 1024) return { success: false, error: tBackend('clipFileTooSmall', { bytes: String(stats.size) }) };
        request.progress.phase = 'saving';
        request.progress.bytesPerSecond = 0;
        publishClipProgress(request);
        const integrity = await validateDownloadedFileIntegrity(partialFilename, null);
        if (request.controller.signal.aborted || appShutdownStarted) return { success: false, cancelled: true };
        if (!integrity.success) return { success: false, error: integrity.error || tBackend('integrityFailedGeneric') };
        const finalized = await finalizeDownloadedMp4(partialFilename, filename, null, null, tracking);
        if (request.controller.signal.aborted || appShutdownStarted) return { success: false, cancelled: true };
        if (!finalized.success) return finalized;
        try { downloadHistoryStore?.recordClip({ attemptId: request.progress.requestId, clipId, filename, title: clipInfo.title, channel: clipInfo.broadcaster_name }); }
        catch (error) { appendDebugLog('clip-history-save-failed', { clipId, error: String(error) }); }
        readArchiveInventory.invalidate();
        rememberRendererPath('open-file', filename);
        rememberRendererPath('show-in-folder', filename);
        appendDebugLog('clip-download-success', { clipId, bytes: stats.size, filename });
        return { success: true, filename };
    } finally {
        clearInterval(progressTimer);
        if (request.tracking) activeClipProcesses.delete(request.tracking);
        if (partialFilename) partialDownloadRegistry.discard(partialFilename);
        releaseClaimedFilenamesForItem(clipId);
    }
}

registerTrustedIpcHandler(ipcMain, 'download-clip', isTrustedRendererEvent, () => Promise.resolve({ success: false, error: 'File access denied' }), async (event, clipUrl: string, requestId: string): Promise<ClipResult> => {
    if (appShutdownStarted) return { success: false, cancelled: true };
    if (applicationBackupBusy) return { success: false, error: config.language === 'de' ? 'Sicherung wird verarbeitet.' : 'Backup in progress.' };
    const clipId = parseTwitchClipId(clipUrl);
    if (!clipId) return { success: false, error: tBackend('invalidClipUrl') };
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(requestId) || clipRequests.has(requestId) || [...clipRequests.values()].some(request => request.ownerId === event.sender.id)) return { success: false, error: tBackend('unknownDownloadError') };
    const policy = decideStandaloneDownloadStart(config.download_policy, new Date());
    if (!policy.allowed) return { success: false, error: tBackend('downloadOutsideWindow', { nextStart: policy.nextStart ? policy.nextStart.getHours().toString().padStart(2, '0') + ':' + policy.nextStart.getMinutes().toString().padStart(2, '0') : '--:--' }) };
    const request: ClipRequest = { ownerId: event.sender.id, controller: new AbortController(), progress: {
        url: 'https://clips.twitch.tv/' + clipId, requestId, bytes: 0, bytesPerSecond: 0, phase: 'preparing', state: 'active'
    } };
    clipRequests.set(requestId, request);
    const entry = workspaceSession.clips.find(item => item.url === request.progress.url);
    if (entry) { entry.state = 'active'; entry.error = undefined; workspaceSession.save(); }
    publishClipProgress(request);
    let result: ClipResult;
    try { result = await performClipDownload(clipId, request); }
    catch (error) {
        result = request.controller.signal.aborted ? { success: false, cancelled: true } : { success: false, error: tBackend('unknownDownloadError') };
        if (!result.cancelled) appendDebugLog('clip-download-failed', { clipId, error: String(error) });
    }
    request.progress.state = result.cancelled ? 'stopped' : result.success ? 'done' : 'failed';
    request.progress.filename = result.filename;
    request.progress.error = result.error;
    request.progress.bytesPerSecond = 0;
    const current = workspaceSession.clips.find(item => item.url === request.progress.url);
    if (current) { Object.assign(current, { state: request.progress.state, filename: result.filename, error: result.error }); workspaceSession.save(); }
    publishClipProgress(request);
    clipRequests.delete(requestId);
    return result;
});

registerTrustedIpcHandler(ipcMain, 'run-preflight', isTrustedRendererEvent, () => Promise.resolve(null), async (_, autoFix: boolean = false) => {
    return await runPreflight(autoFix);
});

const vodQualityService = new VodQualityService();

registerTrustedIpcHandler(ipcMain, 'get-vod-qualities', isTrustedRendererEvent, () => Promise.resolve(null), async (_, request: unknown) => {
    if (appShutdownStarted) return null;
    try { return await vodQualityService.load(request, { prepare: ensureStreamlinkInstalled, streamlink: getStreamlinkCommand }); }
    catch { return null; }
});

registerTrustedIpcHandler(ipcMain, 'cancel-vod-qualities', isTrustedRendererEvent, () => Promise.resolve(), async (_, id: unknown) => {
    vodQualityService.cancel(id);
});

registerTrustedIpcHandler(ipcMain, 'open-vod-playback', isTrustedRendererEvent, () => Promise.resolve(null), async (_, request: unknown) => {
    if (appShutdownStarted) return null;
    try {
        const requestedQuality = config.streamlink_quality;
        const directSource = typeof (request as { url?: unknown } | null)?.url === 'string'
            ? await resolveVodQualitySource((request as { url: string }).url, requestedQuality)
            : null;
        return await vodPlaybackService.open(request, {
            prepare: ensureStreamlinkInstalled,
            streamlink: getStreamlinkCommand,
            quality: getStreamlinkStreamArg(),
            sourceUrl: directSource,
        });
    } catch {
        appendDebugLog('vod-playback-unavailable');
        return null;
    }
});

registerTrustedIpcHandler(ipcMain, 'open-clip-playback', isTrustedRendererEvent, () => Promise.resolve(null), async (_, request: unknown) => {
    if (appShutdownStarted) return null;
    try { return await clipPlaybackService.openClip(request, { prepare: ensureStreamlinkInstalled, streamlink: getStreamlinkCommand, quality: 'source,best' }); }
    catch { return null; }
});

registerTrustedIpcHandler(ipcMain, 'close-clip-playback', isTrustedRendererEvent, () => Promise.resolve(), async (_, id: unknown) => {
    if (typeof id === 'string') await clipPlaybackService.close(id);
});

registerTrustedIpcHandler(ipcMain, 'get-vod-timeline', isTrustedRendererEvent, () => Promise.resolve(null), async (_, request: unknown) => {
    if (appShutdownStarted) return null;
    try { return await vodTimelineService.load(request, config.download_path); }
    catch { return null; }
});

registerTrustedIpcHandler(ipcMain, 'close-vod-playback', isTrustedRendererEvent, () => Promise.resolve(), async (_, id: unknown) => {
    if (typeof id === 'string') { vodTimelineService.close(id); await vodPlaybackService.close(id); }
});

ipcMain.handle('get-managed-tool-status', async (event) => {
    if (!isTrustedRendererEvent(event)) return null;
    return await getManagedToolStatuses();
});

ipcMain.handle('get-managed-tool-execution-diagnostics', (event) => {
    if (!isTrustedRendererEvent(event)) return null;
    return managedToolExecutionTracker.snapshot();
});

ipcMain.handle('repair-managed-tools', async (event) => {
    if (!isTrustedRendererEvent(event)) return null;
    return await repairManagedTools();
});

ipcMain.handle('reset-managed-tools', async (event) => {
    if (!isTrustedRendererEvent(event)) return null;
    return await resetManagedTools();
});

registerTrustedIpcHandler(ipcMain, 'get-debug-log', isTrustedRendererEvent, () => Promise.resolve(''), async (_, lines: number = 200) => {
    // Cap so a misbehaving renderer (or future feature) cannot ask the
    // main process to slice millions of lines from a multi-MB log.
    const safeLines = Number.isFinite(lines) ? Math.max(1, Math.min(5000, Math.floor(lines))) : 200;
    return readDebugLog(safeLines);
});

ipcMain.handle('open-debug-log-file', (event): boolean => {
    if (!isTrustedRendererEvent(event)) return false;
    if (!fs.existsSync(DEBUG_LOG_FILE)) return false;
    shell.showItemInFolder(DEBUG_LOG_FILE);
    return true;
});

ipcMain.handle('get-archive-stats', async (event, range?: import('./main/domain/download-history-store').DownloadHistoryRange): Promise<ArchiveStats> => {
    if (!isTrustedRendererEvent(event)) throw new Error('File access denied');
    return summarizeArchiveInventory(await readArchiveInventory(config.download_path, true), downloadHistoryStore?.summarize(new Date(), range) ?? emptyLifetimeDownloadStats());
});
ipcMain.handle('search-download-history', async (event, filter?: import('./main/domain/download-history-store').DownloadHistoryFilter) => {
    if (!isTrustedRendererEvent(event)) throw new Error('File access denied');
    if (!downloadHistoryStore) throw new Error('Download history unavailable');
    const result = await downloadHistoryStore.search(filter);
    for (const entry of result.entries) for (const filename of entry.availablePaths) rememberRendererPath('show-in-folder', filename);
    return result;
});
ipcMain.handle('has-downloaded-clip', (event, clipId: string): boolean => {
    return isTrustedRendererEvent(event) && typeof clipId === 'string' && (downloadHistoryStore?.hasClip(clipId) ?? false);
});
ipcMain.handle('export-statistics', async (event, range?: import('./main/domain/download-history-store').DownloadHistoryRange): Promise<boolean> => {
    if (!isTrustedRendererEvent(event) || !downloadHistoryStore) throw new Error('File access denied');
    const stats = downloadHistoryStore.summarize(new Date(), range);
    const selected = await dialog.showSaveDialog(mainWindow!, { defaultPath: 'download-statistics.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (selected.canceled || !selected.filePath) return false;
    const isGerman = config.language !== 'en';
    const header = isGerman ? 'Datum;Downloads;Bytes' : 'Date;Downloads;Bytes';
    const rows = stats.dailyActivity.map(day => [day.date, day.count, day.bytes].join(';'));
    const summary = isGerman ? 'Kennzahl;Wert' : 'Metric;Value';
    const totals = [['VOD', stats.vodDownloads], ['Clip', stats.clipDownloads], ['Live', stats.liveRecordings], ['Bytes', stats.totalBytes]].map(row => row.join(';'));
    return publishCapabilityOutput(selected.filePath, async temporary => {
        await fs.promises.writeFile(temporary, '\uFEFF' + [summary, ...totals, '', header, ...rows].join('\r\n') + '\r\n', 'utf8');
        return true;
    });
});

ipcMain.handle('get-streamer-profile', async (_, login: string, forceRefresh?: boolean): Promise<StreamerProfile | null> => {
    return await getStreamerProfile(login, forceRefresh === true);
});

ipcMain.handle('get-streamer-display-names', async (_, logins: string[]): Promise<Record<string, string>> => {
    return await getStreamerDisplayNames(Array.isArray(logins) ? logins : []);
});

ipcMain.handle('get-vod-storyboard', async (_, vodId: string): Promise<VodStoryboard | null> => {
    return await getVodStoryboard(vodId);
});

ipcMain.handle('get-live-status-snapshot', (): Record<string, boolean> => {
    const snap: Record<string, boolean> = {};
    for (const [k, v] of liveStatusByLogin.entries()) snap[k] = v;
    return snap;
});


ipcMain.handle('prepare-archive-videos', async (event, requested: string[], target: 'cutter' | 'merge'): Promise<MergeFileReference[]> => {
    if (!isTrustedRendererEvent(event) || !['cutter', 'merge'].includes(target) || !Array.isArray(requested)
        || !requested.length || requested.length > 500 || (target === 'cutter' && requested.length !== 1)
        || (target === 'cutter' && cutterExportActive) || (target === 'merge' && workspaceMergeActive)) throw new Error('File access denied');
    const inventory = await readArchiveInventory(config.download_path, true);
    const available = new Map(inventory.files.filter(file => ['vod', 'live', 'clip'].includes(file.type)).map(file => [normalizeComparablePath(file.fullPath), file]));
    const candidates = requested.map(filename => typeof filename === 'string' ? available.get(normalizeComparablePath(filename)) : undefined);
    if (candidates.some(file => !file) || new Set(requested.map(normalizeComparablePath)).size !== requested.length) throw new Error('File access denied');
    const references: MergeFileReference[] = [];
    for (const candidate of candidates) {
        const stat = await fs.promises.stat(candidate!.fullPath);
        if (!stat.isFile() || stat.size !== candidate!.size || stat.mtimeMs !== candidate!.mtimeMs) throw new Error('File changed');
        const file: WorkspaceMergeFile = { id: randomUUID(), path: candidate!.fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
        if (target === 'merge') mergeWorkspaceFiles.set(file.id, file);
        references.push({ ...issueFileCapability(event, target === 'cutter' ? 'cutter-input' : 'merge-input', file.path, 'input-file', VIDEO_FILE_EXTENSIONS, CUTTER_SESSION_CAPABILITY_TTL_MS), id: file.id });
    }
    return references;
});

ipcMain.handle('search-archive', async (event, filter: Partial<ArchiveSearchFilter>): Promise<ArchiveSearchResult> => {
    if (!isTrustedRendererEvent(event)) throw new Error('File access denied');
    const normalized: ArchiveSearchFilter = {
        query: typeof filter?.query === 'string' ? filter.query.trim() : '',
        type: (['all', 'live', 'vod', 'clip', 'chat', 'events'] as const).includes(filter?.type as 'all' | 'live' | 'vod' | 'clip' | 'chat' | 'events')
            ? filter!.type as 'all' | 'live' | 'vod' | 'clip' | 'chat' | 'events'
            : 'all',
        streamer: typeof filter?.streamer === 'string' ? filter.streamer.trim() : '',
        sinceMs: Number.isFinite(filter?.sinceMs as number) ? Number(filter?.sinceMs) : null,
        untilMs: Number.isFinite(filter?.untilMs as number) ? Number(filter?.untilMs) : null,
        sort: (['date_desc', 'date_asc', 'size_desc', 'size_asc', 'name_asc'] as const).includes(filter?.sort as 'date_desc')
            ? filter!.sort as 'date_desc' | 'date_asc' | 'size_desc' | 'size_asc' | 'name_asc'
            : 'date_desc',
        limit: Number.isFinite(filter?.limit as number) ? Number(filter?.limit) : 200,
        offset: Number.isFinite(filter?.offset) ? Math.max(0, Math.floor(Number(filter?.offset))) : 0
    };
    const directory = config.download_path;
    const result = searchArchiveInventory(await readArchiveInventory(directory, filter?.refresh === true), normalized);
    const paths = await resolveArchiveFilePaths(directory, result.hits.flatMap(hit => [hit.fullPath, hit.chatPath, hit.eventsPath].filter((filename): filename is string => Boolean(filename))));
    for (const hit of result.hits) {
        const canonical = paths.get(hit.fullPath);
        if (canonical) {
            rememberResolvedRendererPath('open-file', canonical);
            rememberResolvedRendererPath('show-in-folder', canonical);
        }
        for (const sidecar of [hit.chatPath, hit.eventsPath]) {
            const canonical = sidecar && paths.get(sidecar);
            if (!canonical) continue;
            rememberResolvedRendererPath('open-file', canonical);
            rememberResolvedRendererPath('show-in-folder', canonical);
            rememberResolvedRendererPath('chat-input', canonical);
        }
    }
    result.refreshing = readArchiveInventory.isRefreshing(directory);
    return result;
});

ipcMain.handle('get-storage-stats', async (event): Promise<StorageStatsResult> => {
    if (!isTrustedRendererEvent(event)) throw new Error('File access denied');
    const result = await computeStorageStats();
    for (const row of [...result.streamers, ...result.extras]) rememberRendererPath('selected-folder', row.folderPath);
    return result;
});

ipcMain.handle('run-storage-cleanup', async (event, options?: { dryRun?: boolean; token?: string }) => {
    if (!isTrustedRendererEvent(event)) throw new Error('File access denied');
    return runStorageCleanup({ dryRun: options?.dryRun === true, token: typeof options?.token === 'string' ? options.token : undefined });
});
ipcMain.handle('recover-storage-cleanup', async event => {
    if (!isTrustedRendererEvent(event) || applicationRestoreBusy() || cleanupPending || cleanupRecoveryRoot !== config.download_path) throw new Error('cleanup-busy');
    applicationBackupBusy = true;
    try {
        await storageCleanup.recover(cleanupRecoveryRoot, cleanupRecoveryPaths);
        cleanupRecoveryPaths = [];
        reviewedCleanupPlans.clear();
        readArchiveInventory.invalidate();
        readStorageInventory.invalidate();
        return true;
    } finally { applicationBackupBusy = false; }
});

// Read a chat-replay (.chat.json) or live-chat (.chat.jsonl) file and
// return a normalized message list the renderer can display directly.
// Caps at 50k messages to stop a runaway file from killing the renderer.
ipcMain.on('cancel-chat-read', (event, requestId: string) => {
    if (!isTrustedRendererEvent(event) || typeof requestId !== 'string') return;
    activeChatReadControllers.get(event.sender.id)?.get(requestId)?.abort();
});

ipcMain.handle('read-chat-file', async (event, capability: string, requestId?: string) => {
    const filePath = resolveFileCapability(event, capability, 'chat-input', true);
    if (!filePath) return { success: false, error: 'File access denied' };
    const controller = new AbortController();
    const validRequestId = typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128
        ? requestId
        : null;
    if (validRequestId) {
        const controllers = activeChatReadControllers.get(event.sender.id) ?? new Map<string, AbortController>();
        controllers.set(validRequestId, controller);
        activeChatReadControllers.set(event.sender.id, controllers);
    }
    try {
        return await readChatFile(filePath, { signal: controller.signal });
    } finally {
        if (validRequestId) {
            const controllers = activeChatReadControllers.get(event.sender.id);
            controllers?.delete(validRequestId);
            if (controllers?.size === 0) activeChatReadControllers.delete(event.sender.id);
        }
    }
});

ipcMain.handle('check-folder-writable', (event, capability: string): boolean => {
    const folderPath = resolveFileCapability(event, capability, 'selected-folder', true);
    if (!folderPath) return false;
    return isDownloadPathWritable(folderPath);
});

ipcMain.handle('is-downloading', () => isDownloading && !queuePaused);

ipcMain.handle('get-runtime-metrics', () => getRuntimeMetricsSnapshot());

ipcMain.handle('export-runtime-metrics', async (event) => {
    if (!isTrustedRendererEvent(event)) return { success: false, error: 'File access denied' };
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const defaultName = `runtime-metrics-${timestamp}.json`;
        const preferredDir = fs.existsSync(config.download_path) ? config.download_path : app.getPath('desktop');

        const dialogResult = await dialog.showSaveDialog(mainWindow!, {
            defaultPath: path.join(preferredDir, defaultName),
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });

        if (dialogResult.canceled || !dialogResult.filePath) {
            return { success: false, cancelled: true };
        }

        const outputCapability = issueFileCapability(event, 'runtime-export', dialogResult.filePath, 'output-file', ['json']);
        const outputFile = resolveFileCapability(event, outputCapability.token, 'runtime-export', true);
        if (!outputFile) return { success: false, error: 'File access denied' };
        const snapshot = getRuntimeMetricsSnapshot();
        // Atomic write: same fsync+rename pattern used for config/queue
        // (cycle 1) so a power loss mid-export can't leave a half-written
        // metrics file at the user's chosen path.
        writeFileAtomicSync(outputFile, JSON.stringify(snapshot, null, 2));
        return { success: true, filePath: outputFile };
    } catch (e) {
        appendDebugLog('runtime-metrics-export-failed', String(e));
        return { success: false, error: String(e) };
    }
});

ipcMain.handle('mark-vod-downloaded', (event, vodId: string, mark: boolean): { success: boolean } => {
    if (!isTrustedRendererEvent(event)) return { success: false };
    if (typeof vodId !== 'string' || !vodId) return { success: false };
    const downloadedVodIds = Array.isArray(config.downloaded_vod_ids) ? config.downloaded_vod_ids : [];
    const has = downloadedVodIds.includes(vodId);
    let nextDownloadedVodIds: string[];
    if (mark && !has) {
        nextDownloadedVodIds = [...downloadedVodIds, vodId];
    } else if (!mark && has) {
        nextDownloadedVodIds = downloadedVodIds.filter((id) => id !== vodId);
    } else {
        return { success: true };
    }
    config = persistStateChange(config, (current) => ({ ...current, downloaded_vod_ids: nextDownloadedVodIds }), saveConfig);
    appendDebugLog('mark-vod-downloaded', { vodId, mark });
    return { success: true };
});

ipcMain.handle('reset-downloaded-vod-ids', (event) => {
    if (!isTrustedRendererEvent(event)) return { success: false, removedCount: 0 };
    const count = Array.isArray(config.downloaded_vod_ids) ? config.downloaded_vod_ids.length : 0;
    config = persistStateChange(config, (current) => ({ ...current, downloaded_vod_ids: [] }), saveConfig);
    appendDebugLog('reset-downloaded-vod-ids', { previousCount: count });
    return { success: true, removedCount: count };
});

ipcMain.handle('export-config', async (event) => {
    if (!isTrustedRendererEvent(event)) return { success: false, error: 'File access denied' };
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const defaultName = `twitch-vod-manager-config-${timestamp}.json`;
        const preferredDir = fs.existsSync(config.download_path) ? config.download_path : app.getPath('desktop');

        const dialogResult = await dialog.showSaveDialog(mainWindow!, {
            defaultPath: path.join(preferredDir, defaultName),
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });

        if (dialogResult.canceled || !dialogResult.filePath) {
            return { success: false, cancelled: true };
        }

        // Strip the secrets from the export — Client Secret should not
        // travel as plain text across machines / cloud sync. The user
        // re-enters it on the new machine after import.
        const outputCapability = issueFileCapability(event, 'config-export', dialogResult.filePath, 'output-file', ['json']);
        const outputFile = resolveFileCapability(event, outputCapability.token, 'config-export', true);
        if (!outputFile) return { success: false, error: 'File access denied' };
        const exportable = createExportableConfig(config as unknown as Record<string, unknown>);
        writeFileAtomicSync(outputFile, JSON.stringify(exportable, null, 2));
        return { success: true, filePath: outputFile };
    } catch (e) {
        appendDebugLog('config-export-failed', String(e));
        return { success: false, error: String(e) };
    }
});

ipcMain.handle('import-config', async (event) => {
    if (!isTrustedRendererEvent(event)) return { success: false, error: 'File access denied' };
    try {
        const dialogResult = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (dialogResult.canceled || !dialogResult.filePaths[0]) {
            return { success: false, cancelled: true };
        }

        const importCapability = issueFileCapability(event, 'config-import', dialogResult.filePaths[0], 'input-file', ['json']);
        const importPath = resolveFileCapability(event, importCapability.token, 'config-import', true);
        if (!importPath) return { success: false, error: 'File access denied' };
        const importStats = fs.statSync(importPath);
        if (!importStats.isFile() || importStats.size > MAX_CONFIG_IMPORT_BYTES) {
            return { success: false, error: 'Imported file is too large or invalid.' };
        }
        const raw = fs.readFileSync(importPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
            return { success: false, error: 'Imported file is not a JSON object.' };
        }

        const previousConfig = config;
        const imported = secureImportedConfigTransition(previousConfig, sanitizeImportedConfig(parsed));
        const merged = normalizeConfigTemplates({ ...previousConfig, ...imported } as Config);
        applyConfigTransition(previousConfig, merged);
        appendDebugLog('config-import-applied', { source: importPath });
        return { success: true, filePath: importPath };
    } catch (e) {
        appendDebugLog('config-import-failed', String(e));
        return { success: false, error: String(e) };
    }
});

function isTrustedRendererEvent(event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
    if (!mainWindow) return false;
    const rendererUrl = pathToFileURL(path.join(__dirname, 'renderer/index.html')).href;
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    return isTrustedFileIpcSender(mainWindow.webContents.id, rendererUrl, event.sender.id, senderUrl);
}

function isPathInsideDirectory(rootDirectory: string, candidate: string): boolean {
    const root = normalizeComparablePath(rootDirectory);
    const target = normalizeComparablePath(candidate);
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Video Cutter IPC
ipcMain.handle('get-video-info', async (event, capability: string) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return null;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    if (!filePath) return null;
    return await getVideoInfo(filePath, currentCutterInfoProcesses);
});

ipcMain.handle('extract-frame', async (event, capability: string, timeSeconds: number) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return null;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    if (!filePath) return null;
    return await extractFrame(filePath, timeSeconds);
});

ipcMain.handle('prepare-video-editor-media', async (event, capability: string) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return null;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    if (!filePath) return null;
    const media = await prepareVideoEditorMedia(filePath);
    if (media && cutterMediaJob?.jobId === media.jobId) cutterPreparedInput = cutterMediaJob.identity;
    return media;
});

ipcMain.handle('prepare-video-editor-waveform', async (event, capability: string, jobId: number) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return null;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    if (!filePath) return null;
    return await prepareVideoEditorWaveform(filePath, jobId);
});

ipcMain.handle('prepare-video-editor-assets', async (event, capability: string, jobId: number, profile: VideoEditorAssetProfile) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return null;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    if (!filePath) return null;
    return await prepareVideoEditorAssets(filePath, jobId, profile);
});

ipcMain.handle('cancel-video-editor-assets', (event, jobId: number) => {
    if (!isTrustedRendererEvent(event) || !Number.isInteger(jobId) || cutterMediaJob?.jobId !== jobId) return false;
    cancelCutterMediaPreparation();
    return true;
});

ipcMain.handle('get-cutter-project-recovery', (event, capability: string) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return null;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    const source = filePath ? getCutterProjectSource(filePath) : null;
    return source ? cutterProjectAutosaves.find(source) : null;
});

ipcMain.handle('save-cutter-project', async (event, capability: string, value: unknown) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return false;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    if (!filePath || !cutterInputIdentityMatches(filePath) || !cutterMediaJob || !cutterInputIdentitiesMatch(getCutterInputIdentity(filePath), cutterMediaJob.identity)) return false;
    const project = createCutterProject(filePath, cutterMediaJob.info, value);
    if (!project) return false;
    try {
        cutterProjectAutosaves.save(project);
        return true;
    } catch (error) {
        appendDebugLog('cutter-project-save-failed', String(error));
        return false;
    }
});

ipcMain.handle('discard-cutter-project', (event, capability: string) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return false;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    const source = filePath ? getCutterProjectSource(filePath) : null;
    if (!source) return false;
    try {
        return cutterProjectAutosaves.discard(source);
    } catch (error) {
        appendDebugLog('cutter-project-discard-failed', String(error));
        return false;
    }
});

ipcMain.handle('open-cutter-project', (event, capability: string) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return null;
    const filePath = resolveFileCapability(event, capability, 'cutter-input');
    const source = filePath ? getCutterProjectSource(filePath) : null;
    return source ? cutterProjectAutosaves.find(source) : null;
});

ipcMain.handle('get-cutter-export-options', async (event) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) return null;
    return { profiles: CUTTER_EXPORT_PROFILES, hardwareEncoders: await getCutterHardwareEncoders() };
});

ipcMain.handle('export-video-edit', async (event, request: RendererVideoEditExportRequest) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted || !request || typeof request.inputCapability !== 'string') return { success: false, outputName: null };
    const inputFile = resolveFileCapability(event, request.inputCapability, 'cutter-input');
    if (!inputFile || !cutterInputIdentityMatches(inputFile)) return { success: false, outputName: null };
    const profile = request.profile ?? 'balanced';
    const encoder = request.encoder ?? 'software';
    const audioStreamIndex = request.audioStreamIndex ?? 0;
    if ((request.allAudioStreams !== undefined && typeof request.allAudioStreams !== 'boolean') || (request.colorMode !== undefined && request.colorMode !== 'source' && request.colorMode !== 'sdr')) return { success: false, outputName: null };
    if (!isCutterExportProfile(profile) || !isCutterExportEncoder(encoder) || !Number.isInteger(audioStreamIndex) || audioStreamIndex < 0) return { success: false, outputName: null };
    const profileDefinition = getCutterExportProfile(profile);
    const extension = profileDefinition.container;
    let outputFile: string | null = null;
    const testRoot = process.env.TWITCH_VOD_MANAGER_E2E_CUTTER_OUTPUT_ROOT;
    if (testRoot && typeof request.outputName === 'string' && path.basename(request.outputName) === request.outputName) {
        const candidate = path.join(testRoot, request.outputName);
        if (isPathInsideDirectory(testRoot, candidate)) {
            const outputCapability = issueFileCapability(event, 'cutter-output', candidate, 'output-file', [extension]);
            outputFile = resolveFileCapability(event, outputCapability.token, 'cutter-output', true, [inputFile]);
        }
    } else {
        const defaultName = path.join(path.dirname(inputFile), `${path.basename(inputFile, path.extname(inputFile))}_edited.${extension}`);
        const result = await dialog.showSaveDialog(mainWindow!, {
            defaultPath: defaultName,
            filters: [{ name: `${profileDefinition.label} Video`, extensions: [extension] }],
        });
        if (result.canceled || !result.filePath) return { success: false, outputName: null, cancelled: true };
        const outputCapability = issueFileCapability(event, 'cutter-output', result.filePath, 'output-file', [extension]);
        outputFile = resolveFileCapability(event, outputCapability.token, 'cutter-output', true, [inputFile]);
    }
    if (!outputFile) return { success: false, outputName: null };
    const outcome = await exportVideoEdit({ inputFile, outputFile, trimStart: request.trimStart, trimEnd: request.trimEnd, cuts: request.cuts, profile, encoder, audioStreamIndex, allAudioStreams: request.allAudioStreams, colorMode: request.colorMode, audioProcessing: request.audioProcessing }, (percent) => {
        mainWindow?.webContents.send('cut-progress', percent);
    });
    const outputCapability = outcome.success ? issueFileCapability(event, 'show-in-folder', outputFile, 'input-file', [extension]) : null;
    return { success: outcome.success, outputCapability: outputCapability?.token, outputName: outcome.success ? path.basename(outputFile) : null, cancelled: outcome.cancelled || undefined };
});

ipcMain.handle('cancel-video-edit', (event) => {
    if (!isTrustedRendererEvent(event) || !cutterExportActive) return false;
    cutterExportCancelled = true;
    for (const process of currentCutterExportProcesses) {
        try { process.kill(); } catch { }
    }
    return true;
});

ipcMain.handle('cut-video', async (event, inputCapability: string, startTime: number, endTime: number) => {
    const inputFile = resolveFileCapability(event, inputCapability, 'cutter-input', true);
    if (!inputFile) return { success: false, outputName: null };
    const dir = path.dirname(inputFile);
    const baseName = path.basename(inputFile, path.extname(inputFile));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(11, 19);
    const outputFile = path.join(dir, `${baseName}_cut_${timestamp}.mp4`);

    const completed = await cutVideo(inputFile, outputFile, startTime, endTime, (percent) => {
        mainWindow?.webContents.send('cut-progress', percent);
    });
    const success = completed && !appShutdownStarted;

    return { success, outputName: success ? path.basename(outputFile) : null };
});

function restoreMergeReference(event: IpcMainInvokeEvent, file: WorkspaceMergeFile): MergeFileReference {
    try {
        const stat = fs.statSync(file.path);
        if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) throw new Error('File changed');
        return { ...issueFileCapability(event, 'merge-input', file.path, 'input-file', VIDEO_FILE_EXTENSIONS, CUTTER_SESSION_CAPABILITY_TTL_MS), id: file.id, durationSeconds: file.durationSeconds };
    } catch { return { id: file.id, token: '', name: path.basename(file.path), missing: true }; }
}

ipcMain.handle('get-workspace-session', (event) => {
    if (!isTrustedRendererEvent(event)) return null;
    for (const item of workspaceSession.clips) {
        if (item.filename && fs.existsSync(item.filename)) {
            rememberRendererPath('open-file', item.filename);
            rememberRendererPath('show-in-folder', item.filename);
        } else if (item.state === 'done') {
            item.state = 'stopped';
            item.filename = undefined;
            item.error = config.language === 'en' ? 'File missing' : 'Datei fehlt';
        }
    }
    const active = [...clipRequests.values()].find(request => request.ownerId === event.sender.id);
    if (active) {
        const item = workspaceSession.clips.find(clip => clip.url === active.progress.url);
        if (item) item.state = 'active';
    }
    return { automationPaused: applicationAutomationPaused, clips: workspaceSession.clips, mergeFiles: workspaceSession.mergeFiles.map(file => restoreMergeReference(event, file)), activeClip: active?.progress,
        mergeActive: workspaceMergeActive, mergeProgress: workspaceMergeProgress };
});

ipcMain.handle('save-clip-workspace', (event, items: unknown) => {
    if (!isTrustedRendererEvent(event) || !Array.isArray(items) || items.length > 200) return false;
    const previous = new Map(workspaceSession.clips.map(item => [item.url, item]));
    workspaceSession.clips = normalizeWorkspaceClips(items).map(item => {
        const saved = previous.get(item.url);
        const active = [...clipRequests.values()].find(request => request.progress.url === item.url);
        return { ...item, filename: saved?.filename,
            state: active ? 'active' : item.state === 'done' && !saved?.filename ? 'ready' : item.state };
    });
    return workspaceSession.save();
});

ipcMain.handle('save-merge-workspace', (event, ids: unknown) => {
    if (!isTrustedRendererEvent(event) || workspaceMergeActive || !Array.isArray(ids) || ids.length > 500 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !mergeWorkspaceFiles.has(id))) return false;
    workspaceSession.mergeFiles = ids.map(id => mergeWorkspaceFiles.get(id)!);
    return workspaceSession.save();
});

ipcMain.handle('get-merge-video-info', async (event, id: string) => {
    if (!isTrustedRendererEvent(event)) return { missing: true };
    const file = mergeWorkspaceFiles.get(id);
    if (!file || restoreMergeReference(event, file).missing) return { missing: true };
    if (file.durationSeconds !== undefined) return { durationSeconds: file.durationSeconds };
    if (!(await ensureFfmpegInstalled()) || appShutdownStarted) return {};
    const info = await getVideoInfo(file.path, currentEditorProcesses);
    if (info && Number.isFinite(info.duration) && info.duration >= 0) {
        file.durationSeconds = info.duration;
        workspaceSession.save();
    }
    return { durationSeconds: file.durationSeconds };
});

let workspaceMergeActive = false;
let workspaceMergeProgress = 0;

ipcMain.handle('merge-videos', async (event, inputCapabilities: string[], outputCapability: string) => {
    if (!isTrustedRendererEvent(event) || applicationBackupBusy || applicationWorkflowBusy() || cutterExportActive || workspaceMergeActive || !Array.isArray(inputCapabilities) || inputCapabilities.length < 2 || inputCapabilities.length > 500) return { success: false, outputName: null };
    const inputFiles = inputCapabilities.map(capability => resolveFileCapability(event, capability, 'merge-input'));
    const outputFile = resolveFileCapability(event, outputCapability, 'merge-output');
    if (inputFiles.some(file => !file) || !outputFile) return { success: false, outputName: null };
    if (!resolveFileCapability(event, outputCapability, 'merge-output', true, inputFiles as string[])) return { success: false, outputName: null };
    workspaceMergeActive = true;
    workspaceMergeProgress = 0;
    let success = false;
    try {
        const known = inputFiles.map(filePath => [...mergeWorkspaceFiles.values()].find(file => file.path === filePath)?.durationSeconds);
        const total = known.every(duration => duration !== undefined) ? known.reduce<number>((sum, duration) => sum + duration!, 0) : undefined;
        success = await publishCapabilityOutput(outputFile, async partialFile => {
            const produced = await mergeVideos(inputFiles as string[], partialFile, percent => {
                workspaceMergeProgress = percent;
                mainWindow?.webContents.send('merge-progress', percent);
            }, total);
            return produced && !appShutdownStarted;
        });
        if (success) { workspaceSession.mergeFiles = []; workspaceSession.save(); }
    } catch (error) { appendDebugLog('workspace-merge-failed', { error: String(error) }); }
    finally { workspaceMergeActive = false; }
    const result = { success, outputName: success ? path.basename(outputFile) : null };
    if (!event.sender.isDestroyed()) event.sender.send('merge-finished', result);
    return result;
});

ipcMain.handle('select-multiple-videos', async (event) => {
    if (!isTrustedRendererEvent(event) || workspaceMergeActive) return null;
    const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Video Files', extensions: VIDEO_FILE_EXTENSIONS }]
    });
    return result.filePaths.slice(0, 500).map(filePath => {
        const stat = fs.statSync(filePath);
        const file: WorkspaceMergeFile = { id: randomUUID(), path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
        mergeWorkspaceFiles.set(file.id, file);
        return restoreMergeReference(event, file);
    });
});

ipcMain.handle('save-video-dialog', async (event, defaultName: string) => {
    if (!isTrustedRendererEvent(event)) return null;
    const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: defaultName,
        filters: [
            { name: 'MP4 Video', extensions: ['mp4'] }
        ]
    });
    return result.filePath ? issueFileCapability(event, 'merge-output', result.filePath, 'output-file', ['mp4']) : null;
});

// ==========================================
// APP LIFECYCLE
// ==========================================
// Long-lived SQLite-Handle (Plan 04b+ Voraussetzung). Wird in app.whenReady
// geoeffnet, in shutdownCleanup geschlossen. getAppDb() returnt null wenn
// Open fehlgeschlagen ist (Native-Build-Probleme) — Caller mussen das pruefen.
let appDb: DbHandle | null = null;
export function getAppDb(): DbHandle | null { return appDb; }

async function cleanupStaleCutterMediaDirectories(): Promise<number> {
    const tempRoot = path.resolve(app.getPath('temp'));
    let removed = 0;
    try {
        for (const entry of await fs.promises.readdir(tempRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^tvm-editor-(?:media|waveform|preview)-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
            const candidate = path.resolve(tempRoot, entry.name);
            if (path.dirname(candidate) !== tempRoot) continue;
            const processMatch = entry.name.match(/^tvm-editor-(?:media|waveform|preview)-(\d+)-/);
            if (processMatch) {
                try { process.kill(Number(processMatch[1]), 0); continue; }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
            } else {
                try { if (Date.now() - (await fs.promises.stat(candidate)).mtimeMs < 24 * 60 * 60 * 1000) continue; }
                catch { continue; }
            }
            if (appShutdownStarted) break;
            try { await fs.promises.rm(candidate, { recursive: true, force: true }); removed += 1; }
            catch { }
        }
    } catch { }
    return removed;
}

app.whenReady().then(async () => {
    try {
        const restore = await applyPendingApplicationRestore(APPDATA_DIR);
        applicationAutomationPaused = restore.restored || restore.recovered;
    } catch (error) {
        appendDebugLog('application-restore-startup-failed', String(error));
        dialog.showErrorBox('Wiederherstellung fehlgeschlagen', 'Die Programmdaten wurden nicht geöffnet. Die Sicherung bleibt erhalten.\n' + String(error));
        app.exit(1);
        return;
    }
    workspaceSession = new WorkspaceSessionStore(path.join(APPDATA_DIR, 'workspace-session.json'), error => appendDebugLog('workspace-save-error', { error: String(error) }));
    for (const file of workspaceSession.mergeFiles) mergeWorkspaceFiles.set(file.id, file);
    const removedPartialDownloads = partialDownloadRegistry.cleanup();
    if (removedPartialDownloads.length > 0) {
        appendDebugLog('partial-downloads-cleaned-on-startup', { count: removedPartialDownloads.length });
    }
    refreshBundledToolPaths(true);
    startMetadataCacheCleanup();
    startDebugLogFlushTimer();

    try {
        const dbPath = path.join(APPDATA_DIR, 'app.db');
        const database: DbHandle = openDatabase(dbPath);
        appDb = database;
        const secureStorage = createElectronSecureStorage();
        appSecretStore = createSecretStore(database, secureStorage);
        const result = migrateJsonToSqlite({
            db: database,
            appDataDir: APPDATA_DIR,
            secrets: appSecretStore,
            requireEncryption: true,
        });
        appendDebugLog('sqlite-migrator', result);
        const fatalMigrationErrors = result.errors.filter((entry: { source: string }) => entry.source !== 'legacy-config-scrub');
        if (fatalMigrationErrors.length > 0) {
            throw new Error(fatalMigrationErrors.map((entry: { source: string; message: string }) => `${entry.source}: ${entry.message}`).join('; '));
        }
        downloadHistoryStore = createDownloadHistoryStore(database);
        const recoveredDownloads = downloadHistoryStore.recoverCompletedQueue();
        if (recoveredDownloads > 0) appendDebugLog('download-history-recovered', { jobs: recoveredDownloads });
        appStateStore = createAppStateStore(database);
        config = loadConfig();
        lastPersistedConfig = cloneConfig(config);
        const queueLoad = config.persist_queue_on_restart === false && !applicationAutomationPaused
            ? { queue: [] as QueueItem[], interruptedMergeItemIds: new Set<string>() }
            : loadQueue(applicationAutomationPaused);
        downloadQueue = queueLoad.queue;
        for (const item of downloadQueue) {
            if (item.mergeRecoveryBlocked) queueLoad.interruptedMergeItemIds.add(item.id);
        }
        const mergeRecovery = recoverInterruptedMergeArtifacts(downloadQueue, config.download_path, queueLoad.interruptedMergeItemIds);
        if (mergeRecovery.changed) {
            downloadQueue = mergeRecovery.queue;
            for (const item of downloadQueue) {
                if (item.mergeRecoveryBlocked) item.last_error = tBackend('mergeRecoveryBlocked');
            }
            appStateStore.saveQueue(downloadQueue);
            appendDebugLog('merge-recovery-reset', {
                removedFiles: mergeRecovery.removedFiles.length,
                failedFiles: mergeRecovery.failedFiles.length,
            });
        }
        if (config.persist_queue_on_restart === false && !applicationAutomationPaused) appStateStore.saveQueue([]);
        lastPersistedQueueSnapshot = cloneQueue(downloadQueue);
        twitchClientSecret = readSecretSafely(appSecretStore, 'twitch_client_secret', (error) => {
            appendDebugLog('secret-load-failed', { key: 'twitch_client_secret', error: String(error) });
        });
        discordWebhookUrl = readSecretSafely(appSecretStore, 'discord_webhook_url', (error) => {
            appendDebugLog('secret-load-failed', { key: 'discord_webhook_url', error: String(error) });
        });
    } catch (e) {
        appendDebugLog('sqlite-open-failed', {
            error: e instanceof Error ? e.message : String(e),
        });
        try { appDb?.close(); } catch { }
        appDb = null;
        if (applicationAutomationPaused) {
            dialog.showErrorBox('Wiederherstellung fehlgeschlagen', 'Die wiederhergestellten Programmdaten konnten nicht geöffnet werden.');
            app.exit(1);
            return;
        }
        appStateStore = null;
        downloadHistoryStore = null;
        appSecretStore = null;
        config = normalizeConfigTemplates(defaultConfig);
        lastPersistedConfig = cloneConfig(config);
        downloadQueue = [];
        lastPersistedQueueSnapshot = [];
        twitchClientSecret = '';
        discordWebhookUrl = '';
    }

    restartAutoRecordPoller();
    restartAutoVodPoller();
    restartLiveStatusPoller();
    restartAutoCleanupTimer();
    try { await initializeEditingWorkflowIntegration(); }
    catch (error) {
        appendDebugLog('editing-workflow-startup-failed', String(error));
        for (const channel of ['editing-projects-list', 'editing-project-save', 'editing-project-open', 'editing-jobs-list', 'editing-job-cut', 'editing-job-merge', 'editing-merge-inspect', 'editing-job-action']) {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, event => ({ success: false, error: isTrustedRendererEvent(event) ? 'Export queue could not be opened. Restore a backup or inspect the debug log.' : 'File access denied' }));
        }
    }
    applicationWorkflowBusy = () => editingWorkflows?.busy ?? false;
    applicationWorkflowFlush = async () => { await editingWorkflows?.flush(); };
    createWindow();
    void cleanupStaleCutterMediaDirectories().then(count => {
        if (count > 0) appendDebugLog('cutter-media-cleaned-on-startup', { count });
    });
    if (app.isPackaged) {
        startupToolsProvisionTimer = setTimeout(() => {
            startupToolsProvisionTimer = null;
            if (appShutdownStarted) return;
            appendDebugLog('startup-tools-provisioning-start');
            void (async () => {
                const streamlinkReady = await ensureStreamlinkInstalled();
                if (appShutdownStarted) return;
                const ffmpegReady = await ensureFfmpegInstalled();
                appendDebugLog('startup-tools-provisioning-finished', { streamlinkReady, ffmpegReady });
            })().catch((error) => {
                appendDebugLog('startup-tools-provisioning-failed', String(error));
            });
        }, STARTUP_TOOLS_PROVISION_DELAY_MS);
    } else {
        appendDebugLog('startup-tools-check-skipped', 'Deferred to first use');
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Both window-all-closed and before-quit ran nearly identical cleanup blocks
// before, with slight drift (only window-all-closed killed children, only
// window-all-closed did anything platform-specific). Consolidating them into
// a single idempotent helper means any future tweak (e.g. flushing a new
// debug stream) lands once and applies on every quit path.
let shutdownCleanupDone = false;
let quitAfterCleanup = false;
let shutdownPromise: Promise<void> | null = null;

async function waitForAllChildProcessesExit(processes: ChildProcess[]): Promise<void> {
    const results = await Promise.allSettled(processes.map((process) => waitForChildProcessExit(process)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
}

async function shutdownCleanup(reason: 'window-all-closed' | 'before-quit'): Promise<void> {
    if (shutdownCleanupDone) return;
    shutdownCleanupDone = true;
    appShutdownStarted = true;
    clearDownloadPolicyWakeTimer();
    if (queueSaveTimer) {
        clearTimeout(queueSaveTimer);
        queueSaveTimer = null;
    }
    pendingQueueSnapshot = downloadQueue;

    appendDebugLog('shutdown-cleanup', { reason });

    const cleanupError = (step: string, error: unknown): void => {
        appendDebugLog('shutdown-step-failed', { step, error: String(error) });
    };
    for (const request of clipRequests.values()) cancelClipRequest(request);
    const clipProcesses = [...activeClipProcesses];
    const editorProcesses = [...currentEditorProcesses];
    const exportProcesses = [...currentCutterExportProcesses];
    const mediaProcesses = [...currentCutterMediaProcesses, ...currentCutterWaveformProcesses, ...currentCutterProbeProcesses, ...currentCutterInfoProcesses, ...currentCutterPreviewProcesses];
    const frameProcesses = [...currentCutterFrameProcesses];
    const frameFiles = [...currentCutterFrameFiles];
    let exportProcessesExited = exportProcesses.length === 0;
    let mediaProcessesExited = mediaProcesses.length === 0;
    let frameProcessesExited = frameProcesses.length === 0;

    await runResilientSteps([
        ['storage-cleanup', async () => { cleanupAbortController.abort(); await cleanupPending; }],
        ['editing-workflows', async () => { await editingWorkflows?.dispose(); }],
        ['vod-playback', () => vodPlaybackService.close()],
        ['clip-playback', () => clipPlaybackService.close()],
        ['vod-timeline', () => vodTimelineService.close()],
        ['metadata-cache-timer', () => stopMetadataCacheCleanup()],
        ['metadata-cache-files', () => cleanupMetadataCaches('shutdown')],
        ['auto-update-poller', () => stopAutoUpdatePolling()],
        ['auto-record-poller', () => stopAutoRecordPoller()],
        ['auto-vod-poller', () => stopAutoVodPoller()],
        ['live-status-poller', () => stopLiveStatusPoller()],
        ['auto-cleanup-timer', () => stopAutoCleanupTimer()],
        ['startup-tools-provision-timer', () => stopStartupToolsProvisionTimer()],
        ['tool-probes', () => cancelPendingToolChecks()],
        ['queue-lifecycle', async () => {
            await queueRunLifecycle.shutdown(
                () => {
                    isDownloading = false;
                    queuePaused = false;
                    for (const id of queueProcessRegistry.activeItemIds()) cancelledItemIds.add(id);
                },
                () => runResilientSteps([
                    ['persist-config', () => saveConfig(config)],
                    ['persist-queue', () => flushQueueSave()],
                ], cleanupError),
                (error) => cleanupError('queue-persist', error),
                (error) => cleanupError('queue-run-exit', error),
            );
        }],
        ['queue-tracking', () => activeDownloads.clear()],
        ['clip-processes', async () => {
            const results = await Promise.allSettled(clipProcesses.map(async (tracking) => {
                try { tracking.process.kill(); } catch { }
                await waitForChildProcessExit(tracking.process);
                await runResilientSteps([
                    ['clip-output', () => tracking.output.cancel()],
                    ['clip-partial', () => partialDownloadRegistry.discard(tracking.partialFilename)],
                ], cleanupError);
                activeClipProcesses.delete(tracking);
            }));
            for (const result of results) {
                if (result.status === 'rejected') cleanupError('clip-process-exit', result.reason);
            }
        }],
        ['workspace-session', () => { workspaceSession?.flush(); }],
        ['vod-library', () => vodLibrary.flush()],
        ['editor-processes', async () => {
            for (const process of editorProcesses) {
                try { process.kill(); } catch { }
            }
            await waitForAllChildProcessesExit(editorProcesses);
            for (const process of editorProcesses) currentEditorProcesses.delete(process);
        }],
        ['cutter-export-cancel', () => {
            if (cutterExportActive) cutterExportCancelled = true;
            for (const process of exportProcesses) {
                try { process.kill(); } catch { }
            }
        }],
        ['cutter-export-wait', async () => {
            await waitForAllChildProcessesExit(exportProcesses);
            exportProcessesExited = true;
        }],
        ['cutter-export-release', () => {
            if (!exportProcessesExited) return;
            if (currentCutterProcess && exportProcesses.includes(currentCutterProcess)) currentCutterProcess = null;
        }],
        ['archive-index-close', () => readArchiveInventory.dispose()],
        ['cutter-media-cancel', () => cancelCutterMediaPreparation()],
        ['cutter-waveform-cancel', () => cancelCutterWaveformPreparation()],
        ['cutter-metadata-cancel', () => cancelCutterMetadataPreparation()],
        ['cutter-preview-cancel', () => cancelCutterPreviewPreparation()],
        ['cutter-media-kill', () => {
            for (const process of mediaProcesses) {
                try { process.kill(); } catch { }
            }
        }],
        ['cutter-media-wait', async () => {
            await waitForAllChildProcessesExit(mediaProcesses);
            mediaProcessesExited = true;
        }],
        ['cutter-frame-kill', () => {
            for (const process of frameProcesses) {
                try { process.kill(); } catch { }
            }
        }],
        ['cutter-frame-wait', async () => {
            await waitForAllChildProcessesExit(frameProcesses);
            frameProcessesExited = true;
        }],
        ['cutter-frame-release', () => {
            if (frameProcessesExited) currentCutterFrameProcesses.clear();
        }],
        ['cutter-frame-files', async () => {
            if (!frameProcessesExited) return;
            await runResilientSteps(frameFiles.map((filePath, index) => [
                `cutter-frame-file-${index}`,
                () => fs.rmSync(filePath, { force: true }),
            ] as const), cleanupError);
            currentCutterFrameFiles.clear();
        }],
        ['cutter-preview-directory', () => {
            if (mediaProcessesExited) removeCutterPreviewDirectory(cutterMediaJob?.previewDirectory || null);
        }],
        ['cutter-partial', () => {
            if (!exportProcessesExited || !currentCutterPartialFile) return;
            fs.rmSync(currentCutterPartialFile, { force: true });
            currentCutterPartialFile = null;
        }],
        ['database-close', () => {
            const database = appDb;
            appDb = null;
            database?.close();
        }],
        ['debug-log-flush', () => stopDebugLogFlushTimer(true)],
    ], cleanupError);
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', (event) => {
    if (quitAfterCleanup) return;
    event.preventDefault();
    if (shutdownPromise) return;
    shutdownPromise = shutdownCleanup('before-quit').finally(() => {
        quitAfterCleanup = true;
        app.quit();
    });
});

function applicationRestoreBusy(): boolean {
    if (cleanupPending || storageCleanup.isBusy()) return true;
    return isDownloading || activeDownloads.size > 0 || clipRequests.size > 0 || activeClipProcesses.size > 0 || cutterExportActive || workspaceMergeActive || applicationWorkflowBusy() || autoRecordPollInFlight || autoVodPollInFlight || appShutdownStarted;
}

ipcMain.handle('export-application-backup', async event => {
    if (!isTrustedRendererEvent(event) || !appDb || applicationBackupBusy) return { success: false, error: 'busy' };
    applicationBackupBusy = true;
    try {
        const selected = await dialog.showSaveDialog(mainWindow!, {
            defaultPath: path.join(app.getPath('documents'), 'Twitch-VOD-Manager-' + new Date().toISOString().slice(0, 10) + '.tvmbackup'),
            filters: [{ name: 'Twitch VOD Manager', extensions: ['tvmbackup'] }]
        });
        if (selected.canceled || !selected.filePath) return { success: false, cancelled: true };
        if (applicationRestoreBusy() || !workspaceSession.flush()) return { success: false, error: 'busy' };
        await applicationWorkflowFlush();
        await vodLibrary.flush();
        const result = await createApplicationBackup({ db: appDb, dataDirectory: APPDATA_DIR, appVersion: APP_VERSION, outputFile: selected.filePath, queue: cloneQueue(downloadQueue) });
        return { success: true, preview: result };
    } catch (error) {
        appendDebugLog('application-backup-failed', { error: String(error) });
        return { success: false, error: error instanceof Error && 'code' in error ? String(error.code) : 'failed' };
    } finally { applicationBackupBusy = false; }
});

ipcMain.handle('restore-application-backup', async event => {
    if (!isTrustedRendererEvent(event) || !appDb || applicationBackupBusy || applicationRestoreBusy()) return { success: false, error: 'busy' };
    applicationBackupBusy = true;
    try {
        const selected = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'Twitch VOD Manager', extensions: ['tvmbackup'] }] });
        if (selected.canceled || !selected.filePaths[0]) return { success: false, cancelled: true };
        const details = await inspectApplicationBackup(selected.filePaths[0], APPDATA_DIR);
        const english = config.language === 'en';
        const number = new Intl.NumberFormat(english ? 'en-US' : 'de-DE');
        const date = new Intl.DateTimeFormat(english ? 'en-US' : 'de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(details.createdAt));
        const confirmation = await dialog.showMessageBox(mainWindow!, {
            type: 'question', title: english ? 'Restore backup' : 'Sicherung wiederherstellen',
            message: english ? 'Replace application data and restart?' : 'Programmdaten ersetzen und neu starten?',
            detail: [date + ' · ' + details.appVersion,
                (english ? 'Downloads: ' : 'Downloads: ') + number.format(details.downloads),
                (english ? 'Queue: ' : 'Warteschlange: ') + number.format(details.queue),
                (english ? 'Projects: ' : 'Projekte: ') + number.format(details.projects),
                (english ? 'Clips: ' : 'Clips: ') + number.format(details.clips),
                (english ? 'Export jobs: ' : 'Exportaufträge: ') + number.format(details.exportJobs),
                '', english ? 'Current data is backed up first. Sign-ins remain unchanged. Video files are not included. Automatic tasks stay paused for this start.' : 'Der aktuelle Stand wird vorher gesichert. Anmeldungen bleiben erhalten. Videodateien sind nicht enthalten. Automatische Aufgaben bleiben für diesen Start pausiert.'
            ].join('\n'),
            buttons: english ? ['Restore and restart', 'Cancel'] : ['Wiederherstellen und neu starten', 'Abbrechen'],
            defaultId: 1, cancelId: 1, noLink: true
        });
        if (confirmation.response !== 0) return { success: false, cancelled: true };
        if (applicationRestoreBusy() || !workspaceSession.flush()) return { success: false, error: 'busy' };
        await applicationWorkflowFlush();
        await vodLibrary.flush();
        await createApplicationBackup({ db: appDb, dataDirectory: APPDATA_DIR, appVersion: APP_VERSION, outputFile: path.join(APPDATA_DIR, 'before-restore-' + randomUUID() + '.tvmbackup'), queue: cloneQueue(downloadQueue) });
        await queueApplicationRestore({ filename: selected.filePaths[0], expectedDigest: details.digest, dataDirectory: APPDATA_DIR });
        app.relaunch();
        app.quit();
        return { success: true };
    } catch (error) {
        appendDebugLog('application-restore-failed', { error: String(error) });
        return { success: false, error: error instanceof Error && 'code' in error ? String(error.code) : 'failed' };
    } finally { applicationBackupBusy = false; }
});


let editingWorkflows: Awaited<ReturnType<typeof registerEditingWorkflows>> | null = null;

async function initializeEditingWorkflowIntegration(): Promise<void> {
    editingWorkflows = await registerEditingWorkflows({
        directory: APPDATA_DIR,
        blocked: () => appShutdownStarted || applicationBackupBusy || storageCleanup.isBusy(),
        window: () => mainWindow,
        trusted: event => isTrustedRendererEvent(event) && !appShutdownStarted,
        project(event, capability, value) {
            const filePath = resolveFileCapability(event, capability, 'cutter-input');
            if (!filePath || !cutterInputIdentityMatches(filePath) || !cutterMediaJob
                || !cutterInputIdentitiesMatch(getCutterInputIdentity(filePath), cutterMediaJob.identity)) return null;
            return createCutterProject(filePath, cutterMediaJob.info, value);
        },
        async mergeSources(_event, ids) {
            return ids.map(id => {
                const source = mergeWorkspaceFiles.get(id);
                if (!source) throw new Error('Merge source unavailable');
                return { path: source.path, size: source.size, mtimeMs: source.mtimeMs };
            });
        },
        sourceCapability: (event, filePath) => issueFileCapability(event, 'cutter-input', filePath, 'input-file', VIDEO_FILE_EXTENSIONS),
        mediaBusy: () => cutterExportActive || workspaceMergeActive,
        resolveTools: async () => ({ ffmpeg: await getFFmpegPath(), ffprobe: await getFFprobePath() }),
        availableHardwareEncoders: getCutterHardwareEncoders,
        log: error => appendDebugLog('editing-workflows', String(error)),
    });
}

ipcMain.handle('discover-clips', async (event, request: ClipDiscoveryRequest) => {
    if (!isTrustedRendererEvent(event) || appShutdownStarted) throw new Error('Clip discovery unavailable');
    return discoverClips(request, {
        credentials: async () => { const accessToken = await ensureTwitchAuth(); return accessToken ? { clientId: config.client_id, accessToken } : null; },
        userId: getUserId,
        downloaded: clipId => downloadHistoryStore?.hasClip(clipId) ?? false,
    });
});

ipcMain.handle('get-vod-library', async event => {
    if (!isTrustedRendererEvent(event)) throw new Error('Unauthorized');
    await vodLibrary.flush();
    return vodLibrary.read();
});
ipcMain.handle('change-vod-library', async (event, change: VodLibraryChange) => {
    if (!isTrustedRendererEvent(event) || applicationBackupBusy || appShutdownStarted) throw new Error('Unavailable');
    return vodLibrary.change(change);
});

ipcMain.handle('preview-auto-vod-rule', async (event, channel: string, value: unknown) => {
    if (!isTrustedRendererEvent(event) || typeof channel !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(channel)) throw new Error('Invalid channel');
    const rule = normalizeAutoVodRule(value);
    const userId = await getUserId(channel);
    if (!userId) throw new Error('Channel unavailable');
    const vods = await getVODs(userId, true, true);
    const now = Date.now();
    return vods.slice(0, 100).map(vod => ({ id: vod.id, title: vod.title, duration: vod.duration, result: evaluateAutoVodRule(rule, vod, now, config.auto_vod_max_age_hours), downloaded: config.downloaded_vod_ids.includes(vod.id) }));
});
