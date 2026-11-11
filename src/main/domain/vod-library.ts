import { readJsonDocument, writeJsonDocument } from './durable-json-store';
import { randomUUID } from 'node:crypto';
import { normalizeOmissions, planEditedVod, type OmittedRange } from './vod-edit-plan';

export interface SavedVodFilter { id: string; name: string; query: string; sort: 'date_desc' | 'date_asc' | 'views_desc' | 'duration_desc' | 'duration_asc'; hideDownloaded: boolean }
export interface VodChannelGroup { id: string; name: string; channels: string[] }
export interface NamedVodMarker { id: string; name: string; vodId: string; seconds: number; duration: number }
export interface SavedVodExcerpt { id: string; name: string; vodId: string; duration: number; range: OmittedRange; omissions: OmittedRange[] }
export interface VodLibrary { version: 1; filters: SavedVodFilter[]; groups: VodChannelGroup[]; markers: NamedVodMarker[]; excerpts: SavedVodExcerpt[] }
export type VodLibraryCollection = 'filters' | 'groups' | 'markers' | 'excerpts';
export type VodLibraryChange = { collection: VodLibraryCollection; remove: string } | { collection: 'filters'; item: Omit<SavedVodFilter, 'id'> & { id?: string } } | { collection: 'groups'; item: Omit<VodChannelGroup, 'id'> & { id?: string } } | { collection: 'markers'; item: Omit<NamedVodMarker, 'id'> & { id?: string } } | { collection: 'excerpts'; item: Omit<SavedVodExcerpt, 'id'> & { id?: string } };
const collections: VodLibraryCollection[] = ['filters', 'groups', 'markers', 'excerpts'];
const limits = { filters: 50, groups: 50, markers: 1000, excerpts: 500 };
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid VOD library');
    return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new Error('Invalid VOD library text');
    return value.trim();
}
function seconds(value: unknown, maximum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error('Invalid VOD library time');
    return Math.round(value * 1000) / 1000;
}
export function normalizeVodLibrary(value: unknown): VodLibrary {
    const raw = object(value);
    if (raw.version !== 1) throw new Error('Unsupported VOD library');
    const result: VodLibrary = { version: 1, filters: [], groups: [], markers: [], excerpts: [] };
    for (const collection of collections) {
        const rows = raw[collection];
        if (!Array.isArray(rows) || rows.length > limits[collection]) throw new Error('VOD library limit exceeded');
        const ids = new Set<string>();
        for (const input of rows) {
            const row = object(input); const id = text(row.id, 100); const name = text(row.name, 80);
            if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error('Invalid VOD library identity'); ids.add(id);
            if (collection === 'filters') {
                if (typeof row.query !== 'string' || row.query.length > 500 || !['date_desc','date_asc','views_desc','duration_desc','duration_asc'].includes(String(row.sort)) || typeof row.hideDownloaded !== 'boolean') throw new Error('Invalid saved VOD filter');
                result.filters.push({ id, name, query: row.query, sort: row.sort as SavedVodFilter['sort'], hideDownloaded: row.hideDownloaded });
            } else if (collection === 'groups') {
                if (!Array.isArray(row.channels) || row.channels.length > 500 || row.channels.some(channel => typeof channel !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(channel))) throw new Error('Invalid channel group');
                result.groups.push({ id, name, channels: [...new Set((row.channels as string[]).map(channel => channel.toLowerCase()))] });
            } else {
                const vodId = text(row.vodId, 30); if (!/^\d+$/.test(vodId)) throw new Error('Invalid VOD');
                const duration = seconds(row.duration, 86400); if (!duration) throw new Error('Invalid duration');
                if (collection === 'markers') result.markers.push({ id, name, vodId, duration, seconds: seconds(row.seconds, duration) });
                else {
                    const range = normalizeOmissions([object(row.range) as unknown as OmittedRange], duration)[0];
                    if (!Array.isArray(row.omissions)) throw new Error('Invalid omissions');
                    const omissions = normalizeOmissions(row.omissions, duration);
                    if (omissions.some(omission => omission.start < range.start || omission.end > range.end) || !planEditedVod(duration, 3600, omissions, 1, range).duration) throw new Error('Invalid excerpt');
                    result.excerpts.push({ id, name, vodId, duration, range, omissions });
                }
            }
        }
    }
    return result;
}

export class VodLibraryStore {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly filename: string) {}
    async read(): Promise<VodLibrary> {
        const value = await readJsonDocument(this.filename, 4 * 1024 * 1024);
        return value === undefined ? { version: 1, filters: [], groups: [], markers: [], excerpts: [] } : normalizeVodLibrary(value);
    }
    async flush(): Promise<void> { await this.tail; }
    change(change: VodLibraryChange): Promise<VodLibrary> {
        const operation = this.tail.then(async () => {
            if (!change || !collections.includes(change.collection)) throw new Error('Invalid VOD library change');
            const current = await this.read();
            const rows = current[change.collection] as Array<{ id: string }>;
            if ('remove' in change) {
                const index = rows.findIndex(row => row.id === change.remove); if (index >= 0) rows.splice(index, 1);
            } else {
                const item = { ...object(change.item), id: change.item.id || randomUUID() } as { id: string };
                const index = rows.findIndex(row => row.id === item.id); if (index >= 0) rows[index] = item; else rows.push(item);
            }
            const next = normalizeVodLibrary(current);
            await writeJsonDocument(this.filename, next);
            return next;
        });
        this.tail = operation.catch(() => {});
        return operation;
    }
}
