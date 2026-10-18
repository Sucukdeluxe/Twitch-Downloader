import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { LifetimeDownloadStats } from './download-history-store';

export type ArchiveFileType = 'live' | 'vod' | 'clip' | 'chat' | 'events' | 'other';
export interface ArchiveStatsTopStreamer { streamer: string; bytes: number; fileCount: number; liveBytes: number; vodBytes: number; clipBytes: number; chatBytes: number }
export interface ArchiveStatsDay { date: string; count: number; bytes: number }
export interface ArchiveStatsBucket { label: string; count: number; bytes: number }
export interface ArchiveStats {
    lifetime: LifetimeDownloadStats;
    channels?: ArchiveStatsTopStreamer[];
    totalFiles: number; totalBytes: number; liveCount: number; liveBytes: number; vodCount: number; vodBytes: number;
    clipCount: number; clipBytes: number; chatCount: number; chatBytes: number; eventsCount: number;
    streamerCount: number; avgRecordingSizeBytes: number; topStreamers: ArchiveStatsTopStreamer[];
    dailyActivity: ArchiveStatsDay[]; sizeBuckets: ArchiveStatsBucket[]; scannedAt: string; downloadPath: string; rootExists: boolean;
}
export interface ArchiveSearchFilter {
    query: string; type: 'all' | 'live' | 'vod' | 'clip' | 'chat' | 'events'; streamer: string;
    sinceMs: number | null; untilMs: number | null;
    sort: 'date_desc' | 'date_asc' | 'size_desc' | 'size_asc' | 'name_asc'; limit: number; offset?: number; refresh?: boolean;
}
export interface ArchiveSearchHit {
    fullPath: string; fileName: string; streamer: string; type: ArchiveFileType; size: number; mtimeMs: number;
    chatPath: string | null; eventsPath: string | null;
}
export interface ArchiveSearchResult {
    totalScanned: number; matchCount: number; truncated: boolean; hits: ArchiveSearchHit[];
    scannedAt: string; rootExists: boolean; streamers: string[]; offset: number; refreshing?: boolean;
}
export interface ArchiveInventoryFile { fullPath: string; relativePath: string; fileName: string; streamer: string; type: ArchiveFileType; size: number; mtimeMs: number; date: string }
export interface ArchiveInventory { root: string; rootExists: boolean; scannedAt: string; files: ArchiveInventoryFile[]; folders?: string[] }

const MEDIA_EXTENSION = /\.(mp4|mkv|ts|m4v|webm|mov)$/i;
const SIZE_BUCKETS = [
    { label: '< 100 MB', max: 100 * 1024 * 1024 },
    { label: '100 MB - 500 MB', max: 500 * 1024 * 1024 },
    { label: '500 MB - 1 GB', max: 1024 * 1024 * 1024 },
    { label: '1 GB - 5 GB', max: 5 * 1024 * 1024 * 1024 },
    { label: '5 GB - 10 GB', max: 10 * 1024 * 1024 * 1024 },
    { label: '> 10 GB', max: Number.POSITIVE_INFINITY },
];

function localDate(value: Date): string {
    return String(value.getFullYear()).padStart(4, '0') + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
}

export function fileDate(name: string, mtimeMs: number): string {
    const match = /(\d{4})-(\d{2})-(\d{2})/.exec(name);
    if (match) {
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3])) return localDate(date);
    }
    return localDate(new Date(mtimeMs));
}

export function classify(relativePath: string): { type: ArchiveFileType; streamer: string } {
    const pieces = relativePath.replace(/\\/g, '/').split('/');
    const isClip = pieces[0]?.toLowerCase() === 'clips';
    const streamer = pieces.length < 2 ? '' : isClip ? pieces.length > 2 ? pieces[1] : '' : pieces[0];
    let type: ArchiveFileType = 'other';
    if (/\.chat\.jsonl?$/i.test(relativePath)) type = 'chat';
    else if (/\.events\.jsonl$/i.test(relativePath)) type = 'events';
    else if (MEDIA_EXTENSION.test(relativePath)) type = isClip ? 'clip' : pieces.slice(1, -1).some(piece => piece.toLowerCase() === 'live') ? 'live' : 'vod';
    return { type, streamer };
}

export async function scanArchiveInventory(root: string, includeHidden = false): Promise<ArchiveInventory> {
    const inventory: ArchiveInventory = { root, rootExists: false, scannedAt: new Date().toISOString(), files: [], folders: [] };
    if (!root) return inventory;
    try { if (!(await fs.stat(root)).isDirectory()) return inventory; } catch { return inventory; }
    inventory.rootExists = true;
    const pending = [root];
    while (pending.length > 0) {
        const folder = pending.pop()!;
        let entries;
        try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { continue; }
        for (let offset = 0; offset < entries.length; offset += 32) {
            await Promise.all(entries.slice(offset, offset + 32).map(async entry => {
                if (!includeHidden && entry.name.startsWith('.')) return;
                const fullPath = path.join(folder, entry.name);
                if (entry.isDirectory()) {
                    if (folder === root) inventory.folders!.push(entry.name);
                    pending.push(fullPath);
                    return;
                }
                if (!entry.isFile()) return;
                try {
                    const stat = await fs.stat(fullPath);
                    if (!stat.isFile()) return;
                    const relativePath = path.relative(root, fullPath);
                    inventory.files.push({ fullPath, relativePath, fileName: entry.name, ...classify(relativePath), size: stat.size, mtimeMs: stat.mtimeMs, date: fileDate(entry.name, stat.mtimeMs) });
                } catch { }
            }));
        }
    }
    inventory.scannedAt = new Date().toISOString();
    return inventory;
}

export function createArchiveInventoryReader(maxAgeMs = 15000, includeHidden = false) {
    const cache = new Map<string, { inventory: ArchiveInventory; expires: number }>();
    const active = new Map<string, { request: Promise<ArchiveInventory>; refresh: boolean }>();
    const resolveRoot = (root: string) => root ? path.resolve(root) : '';
    const read = (root: string, refresh = false): Promise<ArchiveInventory> => {
        const key = resolveRoot(root);
        const cached = cache.get(key);
        if (!refresh && cached && cached.expires > Date.now()) return Promise.resolve(cached.inventory);
        const existing = active.get(key);
        if (existing && (!refresh || existing.refresh)) return existing.request;
        cache.delete(key);
        const request = scanArchiveInventory(key, includeHidden).then(inventory => {
            if (active.get(key)?.request === request) {
                if (cache.size >= 4) cache.delete(cache.keys().next().value!);
                cache.set(key, { inventory, expires: Date.now() + maxAgeMs });
            }
            return inventory;
        }).finally(() => {
            if (active.get(key)?.request === request) active.delete(key);
        });
        active.set(key, { request, refresh });
        return request;
    };
    read.invalidate = (root?: string): void => {
        if (root === undefined) { cache.clear(); active.clear(); }
        else { const key = resolveRoot(root); cache.delete(key); active.delete(key); }
    };
    return read;
}

export function searchArchiveInventory(inventory: ArchiveInventory, filter: ArchiveSearchFilter): ArchiveSearchResult {
    const result: ArchiveSearchResult = {
        totalScanned: inventory.files.length, matchCount: 0, truncated: false, hits: [], offset: 0, scannedAt: inventory.scannedAt, rootExists: inventory.rootExists, streamers: [],
    };
    const companions = new Map<string, { chat: string | null; events: string | null }>();
    for (const file of inventory.files) {
        if (file.type !== 'chat' && file.type !== 'events') continue;
        const key = file.fullPath.replace(/\.chat\.jsonl?$/i, '').replace(/\.events\.jsonl$/i, '');
        const pair = companions.get(key) ?? { chat: null, events: null };
        if (file.type === 'chat') pair.chat = file.fullPath;
        else pair.events = file.fullPath;
        companions.set(key, pair);
    }
    const streamers = new Set<string>();
    const query = filter.query.toLowerCase();
    for (const file of inventory.files) {
        if (!['vod', 'live', 'clip'].includes(file.type)) continue;
        if (file.streamer) streamers.add(file.streamer);
        const pair = companions.get(file.fullPath.replace(MEDIA_EXTENSION, '')) ?? { chat: null, events: null };
        if (filter.type === 'chat' ? !pair.chat : filter.type === 'events' ? !pair.events : filter.type !== 'all' && filter.type !== file.type) continue;
        if (filter.streamer && filter.streamer.toLowerCase() !== file.streamer.toLowerCase()) continue;
        if (filter.sinceMs !== null && file.mtimeMs < filter.sinceMs) continue;
        if (filter.untilMs !== null && file.mtimeMs > filter.untilMs) continue;
        if (query && !(file.fileName + ' ' + file.streamer + ' ' + file.relativePath).toLowerCase().includes(query)) continue;
        result.hits.push({ fullPath: file.fullPath, fileName: file.fileName, streamer: file.streamer, type: file.type, size: file.size, mtimeMs: file.mtimeMs, chatPath: pair.chat, eventsPath: pair.events });
    }
    result.streamers = [...streamers].sort((a, b) => a.localeCompare(b));
    const compare = {
        date_desc: (a: ArchiveSearchHit, b: ArchiveSearchHit) => b.mtimeMs - a.mtimeMs,
        date_asc: (a: ArchiveSearchHit, b: ArchiveSearchHit) => a.mtimeMs - b.mtimeMs,
        size_desc: (a: ArchiveSearchHit, b: ArchiveSearchHit) => b.size - a.size,
        size_asc: (a: ArchiveSearchHit, b: ArchiveSearchHit) => a.size - b.size,
        name_asc: (a: ArchiveSearchHit, b: ArchiveSearchHit) => a.fileName.localeCompare(b.fileName),
    };
    result.hits.sort((a, b) => (compare[filter.sort] ?? compare.date_desc)(a, b) || a.fullPath.localeCompare(b.fullPath));
    result.matchCount = result.hits.length;
    const limit = Math.max(10, Math.min(2000, Math.floor(filter.limit) || 200));
    const offset = Number.isFinite(filter.offset) ? Math.max(0, Math.floor(filter.offset!)) : 0;
    result.offset = Math.min(offset, Math.max(0, Math.ceil(result.matchCount / limit) - 1) * limit);
    result.truncated = result.offset + limit < result.matchCount;
    result.hits = result.hits.slice(result.offset, result.offset + limit);
    return result;
}

export function summarizeArchiveInventory(inventory: ArchiveInventory, lifetime: LifetimeDownloadStats, now = new Date()): ArchiveStats {
    const stats: ArchiveStats = {
        lifetime, totalFiles: 0, totalBytes: 0, liveCount: 0, liveBytes: 0, vodCount: 0, vodBytes: 0, clipCount: 0, clipBytes: 0,
        chatCount: 0, chatBytes: 0, eventsCount: 0, streamerCount: 0, avgRecordingSizeBytes: 0, topStreamers: [], dailyActivity: [],
        sizeBuckets: SIZE_BUCKETS.map(bucket => ({ label: bucket.label, count: 0, bytes: 0 })), scannedAt: inventory.scannedAt, downloadPath: inventory.root, rootExists: inventory.rootExists,
    };
    const streamers = new Map<string, ArchiveStatsTopStreamer>();
    const days = new Map<string, ArchiveStatsDay>();
    let recordingBytes = 0;
    let recordingCount = 0;
    for (const file of inventory.files) {
        stats.totalFiles++; stats.totalBytes += file.size;
        const key = file.streamer.toLowerCase();
        const streamer = streamers.get(key) ?? { streamer: file.streamer, bytes: 0, fileCount: 0, liveBytes: 0, vodBytes: 0, clipBytes: 0, chatBytes: 0 };
        streamer.fileCount++; streamer.bytes += file.size;
        if (file.streamer) streamers.set(key, streamer);
        if (file.type === 'live') { stats.liveCount++; stats.liveBytes += file.size; streamer.liveBytes += file.size; }
        else if (file.type === 'vod') { stats.vodCount++; stats.vodBytes += file.size; streamer.vodBytes += file.size; }
        else if (file.type === 'clip') { stats.clipCount++; stats.clipBytes += file.size; streamer.clipBytes += file.size; }
        else if (file.type === 'chat') { stats.chatCount++; stats.chatBytes += file.size; streamer.chatBytes += file.size; }
        else if (file.type === 'events') stats.eventsCount++;
        if (['vod', 'live', 'clip'].includes(file.type)) {
            recordingCount++; recordingBytes += file.size;
            const bucket = SIZE_BUCKETS.findIndex(entry => file.size < entry.max);
            stats.sizeBuckets[bucket].count++; stats.sizeBuckets[bucket].bytes += file.size;
            const day = days.get(file.date) ?? { date: file.date, count: 0, bytes: 0 };
            day.count++; day.bytes += file.size; days.set(file.date, day);
        }
    }
    stats.channels = [...streamers.values()].filter(item => item.bytes > 0 && (item.liveBytes + item.vodBytes + item.clipBytes) > 0).sort((a, b) => b.bytes - a.bytes || a.streamer.localeCompare(b.streamer));
    stats.streamerCount = stats.channels.length;
    stats.avgRecordingSizeBytes = recordingCount > 0 ? Math.round(recordingBytes / recordingCount) : 0;
    stats.topStreamers = stats.channels.slice(0, 10);
    for (let offset = 29; offset >= 0; offset--) {
        const day = new Date(now); day.setDate(day.getDate() - offset);
        const date = localDate(day);
        stats.dailyActivity.push(days.get(date) ?? { date, count: 0, bytes: 0 });
    }
    return stats;
}


export interface StorageFolderEntry {
    name: string;
    fileCount: number;
    totalBytes: number;
    liveBytes: number;
    chatBytes: number;
    folderPath: string;
}

export interface StorageStatsResult {
    downloadPath: string;
    rootExists: boolean;
    freeBytes: number | null;
    totalFiles: number;
    totalBytes: number;
    streamers: StorageFolderEntry[];
    extras: StorageFolderEntry[];
    scannedAt: string;
}

export function summarizeStorageInventory(inventory: ArchiveInventory, streamers: readonly string[], freeBytes: number | null): StorageStatsResult {
    const result: StorageStatsResult = {
        downloadPath: inventory.root, rootExists: inventory.rootExists, freeBytes,
        totalFiles: 0, totalBytes: 0, streamers: [], extras: [], scannedAt: inventory.scannedAt,
    };
    const folders = new Map<string, StorageFolderEntry>();
    const folderEntry = (name: string): StorageFolderEntry => {
        let row = folders.get(name);
        if (!row) {
            row = { name: name || path.basename(inventory.root) || inventory.root, folderPath: path.join(inventory.root, name), fileCount: 0, totalBytes: 0, liveBytes: 0, chatBytes: 0 };
            folders.set(name, row);
        }
        return row;
    };
    for (const name of inventory.folders || []) folderEntry(name);
    for (const file of inventory.files) {
        const pieces = file.relativePath.split(path.sep);
        const row = folderEntry(pieces.length > 1 ? pieces[0] : '');
        row.fileCount++;
        row.totalBytes += file.size;
        if (file.type === 'chat') row.chatBytes += file.size;
        if (pieces.slice(1, -1).some(piece => piece.toLowerCase() === 'live')) row.liveBytes += file.size;
        result.totalFiles++;
        result.totalBytes += file.size;
    }
    const known = new Set(streamers.map(name => name.toLowerCase()));
    for (const [name, row] of folders) {
        const tracked = name && (known.has(name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase()) || name.toLowerCase() === 'clips');
        (tracked ? result.streamers : result.extras).push(row);
    }
    const sort = (a: StorageFolderEntry, b: StorageFolderEntry) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name);
    result.streamers.sort(sort);
    result.extras.sort(sort);
    return result;
}
