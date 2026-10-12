import { normalizeVodQuality } from './vod-quality';
import { parseOmissionConfig } from './vod-edit-plan';
import type { CustomClip, QueueItem } from '../../types';

export type RendererQueueInput = Pick<QueueItem, 'url' | 'title' | 'date' | 'streamer' | 'duration_str' | 'quality' | 'qualityLabel'> & { customClip?: CustomClip };

function normalizedString(value: unknown, maximumLength: number): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized && normalized.length <= maximumLength ? normalized : null;
}

function normalizeCustomClip(value: unknown): CustomClip | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (!Number.isFinite(raw.startSec) || Number(raw.startSec) < 0) return null;
    if (!Number.isFinite(raw.durationSec) || Number(raw.durationSec) <= 0 || Number(raw.durationSec) > 24 * 60 * 60) return null;
    if (!Number.isInteger(raw.startPart) || Number(raw.startPart) < 1 || Number(raw.startPart) > 100000) return null;
    if (!['simple', 'timestamp', 'template', 'parts'].includes(String(raw.filenameFormat))) return null;
    const filenameFormat = raw.filenameFormat as CustomClip['filenameFormat'];
    const filenameTemplate = raw.filenameTemplate === undefined
        ? undefined
        : normalizedString(raw.filenameTemplate, 500);
    if (raw.filenameTemplate !== undefined && !filenameTemplate) return null;
    if (filenameFormat === 'template' && !filenameTemplate) return null;
    const omissions = raw.omissions === undefined ? undefined : parseOmissionConfig(raw.omissions, Number(raw.durationSec));
    if (raw.omissions !== undefined && (!omissions || raw.startSec !== 0)) return null;
    return {
        startSec: Number(raw.startSec),
        durationSec: Number(raw.durationSec),
        startPart: Number(raw.startPart),
        filenameFormat,
        ...(filenameTemplate ? { filenameTemplate } : {}),
        ...(omissions ? { omissions } : {}),
    };
}

export function normalizeRendererQueueInput(value: unknown): RendererQueueInput | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const url = normalizedString(raw.url, 2048);
    const title = normalizedString(raw.title, 500);
    const date = normalizedString(raw.date, 100);
    const streamer = normalizedString(raw.streamer, 25);
    const duration = normalizedString(raw.duration_str, 64);
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
        if (parsed.hostname !== 'twitch.tv' && parsed.hostname !== 'www.twitch.tv') return null;
        if (!/^\/videos\/\d+(?:\/|$)/i.test(parsed.pathname)) return null;
    } catch {
        return null;
    }
    if (!title || !date || !streamer || !/^[a-z0-9_]+$/i.test(streamer) || !duration) return null;
    const quality = normalizeVodQuality(raw.quality);
    if (!quality) return null;
    const qualityLabel = raw.qualityLabel === undefined ? undefined : normalizedString(raw.qualityLabel, 200);
    if (raw.qualityLabel !== undefined && !qualityLabel) return null;
    const customClip = raw.customClip === undefined ? undefined : normalizeCustomClip(raw.customClip);
    if (raw.customClip !== undefined && !customClip) return null;
    return {
        url,
        title,
        date,
        streamer: streamer.toLowerCase(),
        duration_str: duration,
        ...(raw.quality !== undefined ? { quality } : {}),
        ...(qualityLabel ? { qualityLabel } : {}),
        ...(customClip ? { customClip } : {}),
    };
}

export function createRendererQueueItem(value: unknown, id: string): QueueItem | null {
    const input = normalizeRendererQueueInput(value);
    if (!input || !id) return null;
    return { ...input, id, status: 'pending', progress: 0 };
}

export function getMergeGroupCleanupPaths(item: QueueItem | undefined): string[] {
    if (!item?.mergeGroup) return [];
    const interruptedSplitFiles = item.mergeGroup.mergePhase === 'done'
        ? []
        : [...(item.mergeGroup.splitFiles ?? []), ...(item.mergeGroup.splitTempFiles ?? [])];
    return [
        ...Object.values(item.mergeGroup.downloadedFiles),
        ...(item.mergeGroup.mergedFile ? [item.mergeGroup.mergedFile] : []),
        ...interruptedSplitFiles,
    ];
}
