import type { DownloadProgress, QueueItem } from '../../types';

type QueueIdentityInput = Pick<QueueItem, 'url' | 'customClip' | 'quality'>;
type QueueTransitionStatus = QueueItem['status'];

function onlyDigits(value: string): boolean {
    return value.length > 0 && [...value].every((character) => character >= '0' && character <= '9');
}

function parseHistoricalQueueId(value: string): number | null {
    const separator = value.indexOf('-');
    if (separator !== -1 && separator !== value.lastIndexOf('-')) return null;
    const timestampText = separator === -1 ? value : value.slice(0, separator);
    const counterText = separator === -1 ? null : value.slice(separator + 1);
    if (timestampText.length !== 13 || !onlyDigits(timestampText)) return null;
    if (counterText !== null) {
        if (!onlyDigits(counterText) || counterText.length > 3) return null;
        if (counterText.length > 1 && counterText.startsWith('0')) return null;
        if (Number(counterText) > 999) return null;
    }
    const timestamp = Number(timestampText);
    return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function normalizedUrlIdentity(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    try {
        const parsed = new URL(trimmed);
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const vod = hostname === 'twitch.tv' ? parsed.pathname.match(/^\/videos\/(\d+)\/?$/i) : null;
        if (vod) return `twitch-vod:${vod[1].replace(/^0+(?=\d)/, '')}`;
        const clip = hostname === 'clips.twitch.tv'
            ? parsed.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/)
            : hostname === 'twitch.tv'
                ? parsed.pathname.match(/^\/[^/]+\/clip\/([A-Za-z0-9_-]+)\/?$/i)
                : null;
        if (clip) return `twitch-clip:${clip[1]}`;
        const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        return `${parsed.protocol.toLowerCase()}//${hostname}${pathname}`;
    } catch {
        return trimmed.split(/[?#]/, 1)[0].replace(/\/+$/, '').toLowerCase();
    }
}

export function isValidPersistedQueueId(value: unknown): value is string {
    return typeof value === 'string' && parseHistoricalQueueId(value) !== null;
}

export function getQueueCreatedAtMs(item: Pick<QueueItem, 'id' | 'createdAt'>, fallback: number): number {
    const explicit = Date.parse(item.createdAt || '');
    if (Number.isFinite(explicit)) return explicit;
    return parseHistoricalQueueId(item.id) ?? fallback;
}

export function canonicalQueueItemIdentity(item: QueueIdentityInput): string {
    const mediaIdentity = normalizedUrlIdentity(item.url) + (item.quality && item.quality !== 'source' && item.quality !== 'best' ? '|quality:' + item.quality : '');
    if (!item.customClip) return `${mediaIdentity}|full`;
    return [
        mediaIdentity,
        'clip',
        item.customClip.startSec,
        item.customClip.durationSec,
        item.customClip.startPart,
        ...(item.customClip.omissions ? [JSON.stringify(item.customClip.omissions)] : []),
    ].join('|');
}

export function clearQueueTransferState(item: QueueItem, status: QueueTransitionStatus, progress: number): QueueItem {
    const stable = { ...item };
    delete stable.speed;
    delete stable.eta;
    delete stable.progressStatus;
    delete stable.progressPhase;
    delete stable.finalization;
    delete stable.downloadedBytes;
    delete stable.totalBytes;
    delete stable.recordingHealth;
    return { ...stable, status, progress };
}

export function applyQueueTransferState(item: QueueItem, status: QueueTransitionStatus, progress: number): QueueItem {
    delete item.speed;
    delete item.eta;
    delete item.progressStatus;
    delete item.progressPhase;
    delete item.finalization;
    delete item.downloadedBytes;
    delete item.totalBytes;
    delete item.recordingHealth;
    item.status = status;
    item.progress = progress;
    return item;
}

export function prepareQueueRetryProgress(item: QueueItem, status: string): DownloadProgress {
    applyQueueTransferState(item, 'downloading', item.progress);
    item.recordingHealth = 'unknown';
    return {
        id: item.id,
        progress: -1,
        speed: '',
        eta: '',
        status,
        currentPart: item.currentPart,
        totalParts: item.totalParts,
        recordingHealth: 'unknown',
    };
}

export function mergeQueueProgressState(item: QueueItem, progress: DownloadProgress, paused: boolean): QueueItem {
    if (paused) return item;
    const numericProgress = Number(progress.progress);
    if (Number.isFinite(numericProgress) && numericProgress > 0 && numericProgress <= 100) {
        item.progress = Math.max(item.progress, numericProgress);
    }
    item.speed = progress.speed || '';
    item.eta = progress.eta || '';
    item.progressStatus = progress.status;
    item.progressPhase = progress.progressPhase;
    item.finalization = progress.finalization;
    if (typeof progress.currentPart === 'number') item.currentPart = progress.currentPart;
    if (typeof progress.totalParts === 'number') item.totalParts = progress.totalParts;
    if (typeof progress.downloadedBytes === 'number') item.downloadedBytes = progress.downloadedBytes;
    if (typeof progress.totalBytes === 'number') item.totalBytes = progress.totalBytes;
    if (progress.recordingHealth === 'ok' || progress.recordingHealth === 'stale' || progress.recordingHealth === 'unknown') {
        item.recordingHealth = progress.recordingHealth;
    } else {
        delete item.recordingHealth;
    }
    return item;
}
