import { statSync, promises as fs } from 'node:fs';
import type { DbHandle } from '../infra/db';
import { parseTwitchClipId } from '../twitch/clip-url';
import { isValidPersistedQueueId } from './queue-runtime';

export interface LifetimeDownloadStats {
    available: boolean;
    trackedSince: string | null;
    totalDownloads: number;
    completedJobs: number;
    vodDownloads: number;
    clipDownloads: number;
    liveRecordings: number;
    outputFiles: number;
    totalBytes: number;
    recoveredDownloads: number;
    unknownDateDownloads: number;
    dailyActivity: Array<{ date: string; count: number; bytes: number }>;
}

interface DownloadCompletion {
    eventKey: string;
    kind: 'vod' | 'clip' | 'live';
    sourceIds: string[];
    outputFiles: number;
    totalBytes: number;
    completedAt: string | null;
    recovered: boolean;
    title: string | null;
    channel: string | null;
    sourceUrl: string | null;
    paths: string[];
}

export interface DownloadHistoryStore {
    recordQueueItem(item: unknown): boolean;
    recordClip(input: { attemptId: string; clipId: string; filename: string; completedAt?: string; title?: string; channel?: string; sourceUrl?: string }): boolean;
    recoverCompletedQueue(): number;
    summarize(now?: Date, range?: DownloadHistoryRange): LifetimeDownloadStats;
    search(filter?: DownloadHistoryFilter): Promise<DownloadHistoryResult>;
    hasClip(clipId: string): boolean;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizedTimestamp(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 40) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function nonnegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function vodSourceId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (!['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname.toLowerCase())) return null;
        return /^\/videos\/(\d+)\/?$/.exec(url.pathname)?.[1]?.replace(/^0+(?=\d)/, '') ?? null;
    } catch { return null; }
}

function mediaOutputFiles(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && /\.(mp4|mkv|ts|m4v|webm|mov)$/i.test(entry)))] : [];
}

export function downloadOutputBytes(files: readonly string[]): number {
    let bytes = 0;
    for (const filename of mediaOutputFiles(files)) {
        try {
            const stat = statSync(filename);
            if (stat.isFile()) bytes += stat.size;
        } catch { }
    }
    return Math.min(Number.MAX_SAFE_INTEGER, bytes);
}

function queueCompletion(input: unknown): DownloadCompletion | null {
    const item = objectRecord(input);
    if (!item || item.status !== 'completed' || typeof item.id !== 'string' || !item.id) return null;
    let kind: DownloadCompletion['kind'] = 'vod';
    let sourceIds: string[];
    if (item.isLive === true) {
        kind = 'live';
        sourceIds = [item.id];
    } else {
        const merge = objectRecord(item.mergeGroup);
        const sources = merge && Array.isArray(merge.items) ? merge.items.map(value => objectRecord(value)?.url) : [item.url];
        sourceIds = [...new Set(sources.map(vodSourceId).filter((value): value is string => value !== null))];
        if (sourceIds.length === 0) {
            const clipId = typeof item.url === 'string' ? parseTwitchClipId(item.url) : null;
            if (!clipId) return null;
            kind = 'clip';
            sourceIds = [clipId];
        }
    }
    const files = mediaOutputFiles(item.outputFiles);
    const completedAt = normalizedTimestamp(item.completedAt);
    return {
        eventKey: 'queue:' + item.id,
        kind,
        sourceIds,
        outputFiles: files.length,
        totalBytes: nonnegativeInteger(item.outputBytes) ?? downloadOutputBytes(files),
        completedAt,
        recovered: item.completionRecorded !== true,
        title: snapshotText(item.title),
        channel: snapshotText(item.streamer),
        sourceUrl: snapshotText(item.url),
        paths: files,
    };
}

function localDateKey(value: Date): string {
    return String(value.getFullYear()).padStart(4, '0') + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
}

export function emptyLifetimeDownloadStats(): LifetimeDownloadStats {
    return {
        available: false,
        trackedSince: null,
        totalDownloads: 0,
        completedJobs: 0,
        vodDownloads: 0,
        clipDownloads: 0,
        liveRecordings: 0,
        outputFiles: 0,
        totalBytes: 0,
        recoveredDownloads: 0,
        unknownDateDownloads: 0,
        dailyActivity: [],
    };
}


export interface DownloadHistoryRange { days?: 7 | 30 | 90; since?: string; until?: string; channel?: string }
export interface DownloadHistoryFilter extends DownloadHistoryRange { query?: string; kind?: 'all' | 'vod' | 'clip' | 'live'; offset?: number; limit?: number }
export interface DownloadHistoryEntry {
    id: string; kind: 'vod' | 'clip' | 'live'; sourceIds: string[]; title: string | null; channel: string | null;
    sourceUrl: string | null; completedAt: string | null; status: 'saved'; totalBytes: number; outputFiles: number;
    paths: string[]; availablePaths: string[]; filePresence: 'present' | 'partial' | 'missing' | 'unknown'; recovered: boolean;
}
export interface DownloadHistoryResult { entries: DownloadHistoryEntry[]; total: number; offset: number; limit: number }

function snapshotText(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 4096) : null;
}

function stringArray(value: string | null): string[] {
    try {
        const parsed: unknown = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch { return []; }
}

function calendarDate(value: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error('Invalid date');
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (localDateKey(date) !== value) throw new Error('Invalid date');
    return date;
}

export function historyRangeBounds(range: DownloadHistoryRange | undefined, now = new Date()): { start: Date; end: Date; filtered: boolean } {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid date');
    const end = range?.until ? calendarDate(range.until) : new Date(now);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
    const start = range?.since ? calendarDate(range.since) : new Date(end);
    if (!range?.since) start.setDate(start.getDate() - ([7, 30, 90].includes(range?.days || 0) ? range!.days! : 30));
    if (start >= end || end.getTime() - start.getTime() > 3660 * 86400000) throw new Error('Invalid date range');
    return { start, end, filtered: !!(range?.days || range?.since || range?.until) };
}

export function downloadHistoryCsv(entries: readonly DownloadHistoryEntry[]): string {
    const cell = (value: unknown) => {
        const text = String(value ?? '');
        const safe = /^[=+@\-\t\r\n]/.test(text) ? "'" + text : text;
        return '"' + safe.replace(/"/g, '""') + '"';
    };
    const rows: unknown[][] = [['Date', 'Type', 'Title', 'Channel', 'Source', 'Status', 'Bytes', 'Files', 'File presence', 'Paths']];
    for (const entry of entries) rows.push([entry.completedAt, entry.kind, entry.title, entry.channel, entry.sourceUrl, entry.status, entry.totalBytes, entry.outputFiles, entry.filePresence, entry.paths.join('\n')]);
    return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n') + '\r\n';
}

interface HistoryRow {
    event_key: string; kind: DownloadHistoryEntry['kind']; source_ids_json: string; title: string | null;
    channel: string | null; source_url: string | null; completed_at: string | null; total_bytes: number;
    output_files: number; paths_json: string | null; recovered: number;
}

export function createDownloadHistoryStore(db: DbHandle): DownloadHistoryStore {
    const record = (completion: DownloadCompletion): boolean => db.transaction(() => {
        db.run(
            'INSERT OR IGNORE INTO download_history(event_key, kind, source_count, source_ids_json, output_files, total_bytes, completed_at, recovered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [completion.eventKey, completion.kind, completion.sourceIds.length, JSON.stringify(completion.sourceIds), completion.outputFiles, completion.totalBytes, completion.completedAt, completion.recovered ? 1 : 0],
        );
        const inserted = (db.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0) > 0;
        if (inserted) db.run('INSERT INTO download_history_details(event_key, title, channel, source_url, paths_json) VALUES (?, ?, ?, ?, ?)',
            [completion.eventKey, completion.title, completion.channel, completion.sourceUrl, JSON.stringify(completion.paths)]);
        return inserted;
    });
    const recordQueueItem = (item: unknown): boolean => {
        const candidate = objectRecord(item);
        if (candidate?.status !== 'completed') return false;
        if (typeof candidate?.id === 'string' && db.get('SELECT event_key FROM download_history WHERE event_key = ?', ['queue:' + candidate.id])) return false;
        const completion = queueCompletion(item);
        return completion ? record(completion) : false;
    };
    return {
        recordQueueItem,
        hasClip(clipId) {
            if (!clipId || clipId.length > 512) return false;
            return !!db.get("SELECT 1 FROM download_history h, json_each(h.source_ids_json) s WHERE h.kind = 'clip' AND s.value = ? LIMIT 1", [clipId]);
        },
        async search(filter = {}) {
            const conditions: string[] = [];
            const params: unknown[] = [];
            const bounds = historyRangeBounds(filter);
            if (bounds.filtered) {
                conditions.push('h.completed_at >= ? AND h.completed_at < ?');
                params.push(bounds.start.toISOString(), bounds.end.toISOString());
            }
            if (filter.kind && ['vod', 'clip', 'live'].includes(filter.kind)) {
                conditions.push('h.kind = ?'); params.push(filter.kind);
            }
            if (typeof filter.channel === 'string' && filter.channel.trim()) {
                conditions.push('LOWER(d.channel) = ?'); params.push(filter.channel.trim().toLowerCase().slice(0, 100));
            }
            const query = typeof filter.query === 'string' ? filter.query.trim().slice(0, 4096) : '';
            if (query) {
                conditions.push("(COALESCE(d.title, '') || ' ' || COALESCE(d.channel, '') || ' ' || COALESCE(d.source_url, '') || ' ' || h.source_ids_json) LIKE ? ESCAPE '\\'");
                params.push('%' + query.replace(/[\\%_]/g, character => '\\' + character) + '%');
            }
            const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
            const from = ' FROM download_history h LEFT JOIN download_history_details d ON d.event_key = h.event_key';
            const total = db.get<{ count: number }>('SELECT COUNT(*) AS count' + from + where, params)?.count || 0;
            const limit = Number.isFinite(filter.limit) ? Math.max(1, Math.min(250, Math.floor(filter.limit!))) : 100;
            const requested = Number.isFinite(filter.offset) ? Math.max(0, Math.floor(filter.offset!)) : 0;
            const offset = Math.min(requested, Math.max(0, Math.ceil(total / limit) - 1) * limit);
            const rows = db.all<HistoryRow>('SELECT h.*, d.title, d.channel, d.source_url, d.paths_json' + from + where + ' ORDER BY h.completed_at DESC, h.event_key ASC LIMIT ? OFFSET ?', [...params, limit, offset]);
            const entries: DownloadHistoryEntry[] = [];
            for (let cursor = 0; cursor < rows.length; cursor += 16) {
                entries.push(...await Promise.all(rows.slice(cursor, cursor + 16).map(async row => {
                    const paths = stringArray(row.paths_json);
                    const availablePaths: string[] = [];
                    for (const filename of paths) {
                        try { if ((await fs.stat(filename)).isFile()) availablePaths.push(filename); } catch { }
                    }
                    return {
                        id: row.event_key, kind: row.kind, sourceIds: stringArray(row.source_ids_json), title: row.title,
                        channel: row.channel, sourceUrl: row.source_url, completedAt: row.completed_at, status: 'saved' as const,
                        totalBytes: row.total_bytes, outputFiles: row.output_files, recovered: row.recovered === 1, paths, availablePaths,
                        filePresence: !paths.length ? 'unknown' as const : availablePaths.length === paths.length ? 'present' as const : availablePaths.length ? 'partial' as const : 'missing' as const,
                    };
                })));
            }
            return { entries, total, offset, limit };
        },

        recordClip(input) {
            if (!input.attemptId || !input.clipId) return false;
            return record({
                eventKey: 'clip:' + input.attemptId,
                kind: 'clip',
                sourceIds: [input.clipId],
                outputFiles: 1,
                totalBytes: downloadOutputBytes([input.filename]),
                completedAt: normalizedTimestamp(input.completedAt) ?? new Date().toISOString(),
                recovered: false,
                title: snapshotText(input.title),
                channel: snapshotText(input.channel),
                sourceUrl: snapshotText(input.sourceUrl) ?? 'https://clips.twitch.tv/' + encodeURIComponent(input.clipId),
                paths: mediaOutputFiles([input.filename]),
            });
        },
        recoverCompletedQueue() {
            return db.transaction(() => {
                let recovered = 0;
                for (const row of db.all<{ payload_json: string }>("SELECT payload_json FROM queue_items WHERE status = 'completed'")) {
                    let parsed: unknown;
                    try { parsed = JSON.parse(row.payload_json); } catch { continue; }
                    if (!isValidPersistedQueueId(objectRecord(parsed)?.id)) continue;
                    if (recordQueueItem(parsed)) recovered++;
                }
                return recovered;
            });
        },
        summarize(now = new Date(), range?: DownloadHistoryRange) {
            const bounds = historyRangeBounds(range, now);
            const channel = typeof range?.channel === 'string' ? range.channel.trim().toLowerCase().slice(0, 100) : '';
            const channelCondition = channel ? ' AND event_key IN (SELECT event_key FROM download_history_details WHERE LOWER(channel) = ?)' : '';
            const totals = db.get<{
                totalDownloads: number; completedJobs: number; vodDownloads: number; clipDownloads: number; liveRecordings: number;
                outputFiles: number; totalBytes: number; recoveredDownloads: number; unknownDateDownloads: number;
            }>(`SELECT COALESCE(SUM(source_count), 0) AS totalDownloads, COUNT(*) AS completedJobs,
                COALESCE(SUM(CASE WHEN kind = 'vod' THEN source_count ELSE 0 END), 0) AS vodDownloads,
                COALESCE(SUM(CASE WHEN kind = 'clip' THEN source_count ELSE 0 END), 0) AS clipDownloads,
                COALESCE(SUM(CASE WHEN kind = 'live' THEN source_count ELSE 0 END), 0) AS liveRecordings,
                COALESCE(SUM(output_files), 0) AS outputFiles, COALESCE(SUM(total_bytes), 0) AS totalBytes,
                COALESCE(SUM(CASE WHEN recovered = 1 THEN source_count ELSE 0 END), 0) AS recoveredDownloads,
                COALESCE(SUM(CASE WHEN completed_at IS NULL THEN source_count ELSE 0 END), 0) AS unknownDateDownloads
                FROM download_history WHERE 1=1 ${bounds.filtered ? 'AND completed_at >= ? AND completed_at < ?' : ''}${channelCondition}`, [...(bounds.filtered ? [bounds.start.toISOString(), bounds.end.toISOString()] : []), ...(channel ? [channel] : [])])!;
            const start = bounds.start;
            const end = bounds.end;
            const activity = new Map<string, { date: string; count: number; bytes: number }>();
            for (const row of db.all<{ completed_at: string; source_count: number; total_bytes: number }>(
                'SELECT completed_at, source_count, total_bytes FROM download_history WHERE completed_at >= ? AND completed_at < ?' + channelCondition,
                [start.toISOString(), end.toISOString(), ...(channel ? [channel] : [])],
            )) {
                const date = localDateKey(new Date(row.completed_at));
                const day = activity.get(date) ?? { date, count: 0, bytes: 0 };
                day.count += row.source_count;
                day.bytes += row.total_bytes;
                activity.set(date, day);
            }
            const dailyActivity: LifetimeDownloadStats['dailyActivity'] = [];
            for (let offset = 0; ; offset++) {
                const day = new Date(start);
                day.setDate(day.getDate() + offset);
                if (day >= end) break;
                const date = localDateKey(day);
                dailyActivity.push(activity.get(date) ?? { date, count: 0, bytes: 0 });
            }
            return {
                ...totals,
                available: true,
                trackedSince: db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'download_history_started_at'")?.value ?? null,
                dailyActivity,
            };
        },
    };
}
