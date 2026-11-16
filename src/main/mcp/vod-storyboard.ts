import { validateVodMediaUrl } from '../domain/vod-playback-service';

export interface StoryboardSheet { index: number; firstFrame: number; frameCount: number; jpeg: Buffer }
export interface Storyboard {
    vodId: string;
    intervalSeconds: number;
    frameCount: number;
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    sheets: StoryboardSheet[];
}
export interface StoryboardDependencies {
    manifestUrl(vodId: string): Promise<string | null>;
    fetch: typeof fetch;
    signal: AbortSignal;
}

const MAX_SHEETS = 8;
const MAX_SHEET_BYTES = 3 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

function positiveInteger(value: unknown, maximum: number): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maximum ? value : null;
}

async function readLimited(response: Response, maximum: number): Promise<Buffer | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maximum) { await reader.cancel(); return null; }
        chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
}

export function selectStoryboardEntry(manifest: unknown): { intervalSeconds: number; frameCount: number; columns: number; rows: number; cellWidth: number; cellHeight: number; images: string[] } | null {
    if (!Array.isArray(manifest)) return null;
    const entries = manifest.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const raw = value as Record<string, unknown>;
        const frameCount = positiveInteger(raw.count, 100000), columns = positiveInteger(raw.cols, 50), rows = positiveInteger(raw.rows, 200);
        const cellWidth = positiveInteger(raw.width, 4096), cellHeight = positiveInteger(raw.height, 4096);
        const intervalSeconds = typeof raw.interval === 'number' && Number.isFinite(raw.interval) && raw.interval > 0 ? raw.interval : null;
        const images = Array.isArray(raw.images) ? raw.images.filter((name): name is string => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,200}\.jpe?g$/i.test(name)) : [];
        if (!frameCount || !columns || !rows || !cellWidth || !cellHeight || !intervalSeconds || !images.length || images.length !== (raw.images as unknown[]).length) return [];
        return [{ intervalSeconds, frameCount, columns, rows, cellWidth, cellHeight, images, quality: raw.quality === 'high' ? 1 : 0 }];
    });
    const selected = entries.filter(entry => entry.images.length <= MAX_SHEETS).sort((a, b) => b.quality - a.quality || b.cellWidth - a.cellWidth)[0];
    if (!selected) return null;
    return { intervalSeconds: selected.intervalSeconds, frameCount: selected.frameCount, columns: selected.columns, rows: selected.rows, cellWidth: selected.cellWidth, cellHeight: selected.cellHeight, images: selected.images };
}

export function sheetIndexesForRange(entry: { intervalSeconds: number; frameCount: number; columns: number; rows: number; images: string[] }, from: number | null, to: number | null): number[] {
    const perSheet = entry.columns * entry.rows;
    const firstFrame = from === null ? 0 : Math.max(0, Math.min(entry.frameCount - 1, Math.floor(from / entry.intervalSeconds)));
    const lastFrame = to === null ? entry.frameCount - 1 : Math.max(firstFrame, Math.min(entry.frameCount - 1, Math.ceil(to / entry.intervalSeconds) - 1));
    const indexes: number[] = [];
    for (let index = Math.floor(firstFrame / perSheet); index <= Math.floor(lastFrame / perSheet) && index < entry.images.length; index++) indexes.push(index);
    return indexes;
}

export async function loadStoryboard(vodId: string, from: number | null, to: number | null, dependencies: StoryboardDependencies): Promise<Storyboard | null> {
    if (!/^\d{1,20}$/.test(vodId)) return null;
    const manifestLocation = await dependencies.manifestUrl(vodId);
    if (!manifestLocation) return null;
    const manifestUrl = validateVodMediaUrl(manifestLocation);
    const timeout = AbortSignal.any([dependencies.signal, AbortSignal.timeout(20000)]);
    const manifestResponse = await dependencies.fetch(manifestUrl.href, { signal: timeout, redirect: 'error' });
    if (!manifestResponse.ok) return null;
    const manifestBytes = await readLimited(manifestResponse, MAX_MANIFEST_BYTES);
    if (!manifestBytes) return null;
    const entry = selectStoryboardEntry(JSON.parse(manifestBytes.toString('utf8')));
    if (!entry) return null;
    const perSheet = entry.columns * entry.rows;
    const sheets = (await Promise.all(sheetIndexesForRange(entry, from, to).map(async (index): Promise<StoryboardSheet | null> => {
        const imageUrl = validateVodMediaUrl(new URL(entry.images[index], manifestUrl).href);
        const response = await dependencies.fetch(imageUrl.href, { signal: timeout, redirect: 'error' });
        if (!response.ok) return null;
        const jpeg = await readLimited(response, MAX_SHEET_BYTES);
        if (!jpeg || jpeg.length < 4 || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return null;
        return { index, firstFrame: index * perSheet, frameCount: Math.min(perSheet, entry.frameCount - index * perSheet), jpeg };
    }))).filter((sheet): sheet is StoryboardSheet => sheet !== null);
    if (!sheets.length) return null;
    return { vodId, intervalSeconds: entry.intervalSeconds, frameCount: entry.frameCount, columns: entry.columns, rows: entry.rows, cellWidth: entry.cellWidth, cellHeight: entry.cellHeight, sheets };
}
