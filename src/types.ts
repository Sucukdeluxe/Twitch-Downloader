export interface LiveVodStatus {
    isLive: boolean;
    vodId: string | null;
}

export interface CustomClip {
    startSec: number;
    durationSec: number;
    startPart: number;
    filenameFormat: 'simple' | 'timestamp' | 'template' | 'parts';
    filenameTemplate?: string;
    omissions?: import('./main/domain/vod-edit-plan').OmissionConfig;
}

export interface MergeGroupItem {
    url: string;
    title: string;
    date: string;
    streamer: string;
    duration_str: string;
    quality?: string;
    qualityLabel?: string;
}

export interface MergeGroup {
    items: MergeGroupItem[];
    mergePhase: 'downloading' | 'merging' | 'splitting' | 'cleanup' | 'done';
    currentItemIndex: number;
    downloadedFiles: Record<number, string>;
    mergedFile?: string;
    splitFiles?: string[];
    splitTempFiles?: string[];
    totalDurationSec?: number;
}

export interface QueueItem {
    id: string;
    createdAt?: string;
    completedAt?: string;
    completionRecorded?: boolean;
    outputBytes?: number;
    title: string;
    url: string;
    date: string;
    streamer: string;
    duration_str: string;
    quality?: string;
    qualityLabel?: string;
    status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
    progress: number;
    currentPart?: number;
    totalParts?: number;
    speed?: string;
    eta?: string;
    downloadedBytes?: number;
    totalBytes?: number;
    progressStatus?: string;
    progressPhase?: 'downloading' | 'finalizing';
    finalization?: Mp4FinalizationProgress;
    last_error?: string;
    customClip?: CustomClip;
    mergeGroup?: MergeGroup;
    mergeRecoveryBlocked?: boolean;
    artifactRoot?: string;
    outputPath?: string;
    // File paths produced by the download (single file for VOD/clip, multiple
    // for parts/merge-group splits). Persisted with the queue so completed
    // items keep their "Open file" / "Show in folder" actions across restarts.
    outputFiles?: string[];
    completedVodParts?: Array<{ key: string; filename: string; size: number; mtimeMs: number }>;
    // Live stream recording — when true, item.url is the channel URL
    // (https://twitch.tv/{streamer}) and streamlink runs until the stream
    // ends instead of using --hls-start-offset / --hls-duration. The output
    // filename includes a timestamp so consecutive live recordings of the
    // same streamer don't collide.
    isLive?: boolean;
    // Live recording health snapshot. 'ok' means bytes are flowing within
    // the freshness window, 'stale' means the streamlink subprocess hasn't
    // pushed bytes recently (dropped segments, network blip, or stream just
    // ended), 'unknown' until the first progress event arrives. Only set
    // for in-flight live recordings; cleared when the recording finishes.
    recordingHealth?: 'ok' | 'stale' | 'unknown';
}

export interface Mp4FinalizationProgress {
    stage: 'writing' | 'optimizing' | 'verifying';
    percent?: number;
    processedSeconds?: number;
    durationSeconds?: number;
    writtenBytes?: number;
    speedBytesPerSec?: number;
    etaSeconds?: number;
    elapsedSeconds: number;
}

export interface DownloadProgress {
    id: string;
    progress: number;
    progressPhase?: 'downloading' | 'finalizing';
    finalization?: Mp4FinalizationProgress;
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

export interface DownloadResult {
    success: boolean;
    error?: string;
    outputFiles?: string[];
}

export type QueueAdditionRejectionReason = import('./main/domain/queue-addition').QueueAdditionRejectionReason;
export type QueueAdditionResult = import('./main/domain/queue-addition').QueueAdditionResult<QueueItem>;

export interface AutomationScanResult {
    addedCount: number;
    checkedCount: number;
    failedCount: number;
    skipped: 'busy' | 'shutdown' | null;
}
