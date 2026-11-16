import type { QueueItem, CustomClip } from '../../types';
import type { VodTimeline } from '../domain/vod-timeline';
import type { ArchiveSearchFilter, ArchiveSearchResult } from '../domain/archive-inventory';
import type { MediaJob, MediaJobRequest } from './media-jobs';
import type { Storyboard } from './vod-storyboard';
import type { GrabbedFrame } from './frame-grab';
import type { ComposedSheet } from './frame-sheet';
import type { ChatActivityBucket, ChatRange, VodClip } from './vod-signals';
import type { StoredPlan } from './part-plan-store';

export interface McpAppStatus {
    version: string;
    language: 'de' | 'en';
    downloadFolder: string;
    downloadMode: 'full' | 'parts';
    partMinutes: number;
    freeBytes: number | null;
    parallelDownloads: number;
    defaultQuality: string;
    downloading: boolean;
    paused: boolean;
    waitingForTimeWindow: boolean;
    nextDownloadWindowStart: string | null;
    tools: { ffmpeg: boolean; streamlink: boolean };
    autoVodChannels: string[];
    autoRecordChannels: string[];
}

export interface McpStreamer { login: string; displayName: string; live: boolean | null; liveVodId: string | null }

export interface McpVod {
    id: string;
    title: string;
    startedAt: string;
    durationSeconds: number;
    url: string;
    channel: string;
    live: boolean;
    downloaded: boolean;
}

export interface McpQueueDraft {
    url: string;
    title: string;
    date: string;
    streamer: string;
    durationSeconds: number;
    quality?: string;
    customClip?: CustomClip;
    outputPath?: string;
}

export interface McpQueueAddResult { accepted: boolean; reason: string | null; item: QueueItem | null }

export interface McpVideoInfo {
    path: string;
    sizeBytes: number;
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    videoCodec: string;
    audioCodec: string | null;
    audioTracks: number;
}

export interface McpRecordingEvent { offsetSeconds: number; at: string; type: string; title?: string; category?: string; from?: string; to?: string }

export interface McpChannelAutomation { autoDownloadVods: boolean; autoRecord: boolean }
export interface McpLiveRecordingResult { started: boolean; reason: 'offline' | 'already-recording' | 'unavailable' | 'rejected' | null; title: string | null }

export interface McpHost {
    status(): Promise<McpAppStatus>;
    streamers(): McpStreamer[];
    listVods(channel: string, refresh: boolean): Promise<McpVod[] | null>;
    timeline(vodId: string, refresh: boolean): Promise<VodTimeline | null>;
    storyboard(vodId: string, from: number | null, to: number | null, signal: AbortSignal): Promise<Storyboard | null>;
    vodFrames(vodId: string, times: number[], width: number, signal: AbortSignal): Promise<GrabbedFrame[]>;
    vodRawFrames(vodId: string, times: number[], width: number, height: number, signal: AbortSignal): Promise<Array<Buffer | null>>;
    fileRawFrames(file: string, times: number[], width: number, height: number, signal: AbortSignal): Promise<Array<Buffer | null>>;
    encodeJpeg(image: ComposedSheet, signal: AbortSignal): Promise<Buffer | null>;
    decodeJpeg(jpeg: Buffer, width: number, height: number, signal: AbortSignal): Promise<Buffer | null>;
    chatRange(vodId: string, from: number, to: number, maximum: number, signal: AbortSignal): Promise<ChatRange | null>;
    chatActivity(vodId: string, from: number, to: number, stepSeconds: number, signal: AbortSignal): Promise<ChatActivityBucket[] | null>;
    vodClips(vodId: string): Promise<VodClip[] | null>;
    savePartPlan(plan: StoredPlan): Promise<void>;
    partPlans(vodId: string): Promise<StoredPlan[]>;
    plannedVodIds(): Promise<Set<string>>;
    fileSize(file: string): Promise<number | null>;
    channelAutomation(channel: string): McpChannelAutomation;
    setChannelAutomation(channel: string, change: Partial<McpChannelAutomation>): McpChannelAutomation;
    startLiveRecording(channel: string): Promise<McpLiveRecordingResult>;
    queue(): QueueItem[];
    queueState(): { downloading: boolean; paused: boolean };
    addToQueue(drafts: McpQueueDraft[]): McpQueueAddResult[];
    partOutputFolder(channel: string, startedAt: string): string;
    startQueue(ignoreTimeWindow?: boolean): Promise<boolean>;
    pauseQueue(): Promise<boolean>;
    removeQueueItem(id: string): Promise<boolean>;
    retryQueueItems(ids: string[] | null): Promise<string[]>;
    clearCompletedQueueItems(): number;
    waitForQueueChange(timeoutMs: number, signal: AbortSignal): Promise<void>;
    searchRecordings(filter: ArchiveSearchFilter): Promise<ArchiveSearchResult>;
    resolveRecording(file: string): Promise<string | null>;
    resolveOutputFolder(folder: string | null, fallbackSource: string): Promise<string | null>;
    videoInfo(file: string): Promise<McpVideoInfo | null>;
    vodSegments(vodId: string, quality: string | undefined, signal: AbortSignal): Promise<number[] | null>;
    sourceFormatDifferences(files: string[], signal: AbortSignal): Promise<string[]>;
    recordingEvents(file: string): Promise<McpRecordingEvent[] | null>;
    fileFrames(file: string, times: number[], width: number, signal: AbortSignal): Promise<GrabbedFrame[]>;
    enqueueMediaJob(request: MediaJobRequest): MediaJob;
    mediaJobs(): MediaJob[];
    cancelMediaJob(id: string): boolean;
    waitForMediaJobChange(timeoutMs: number, signal: AbortSignal): Promise<void>;
}
