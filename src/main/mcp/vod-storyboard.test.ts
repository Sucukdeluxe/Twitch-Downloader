import { describe, expect, it } from 'vitest';
import { sanitizeConfigInput, sanitizeImportedConfig } from '../domain/config-input';
import { loadStoryboard, selectStoryboardEntry, sheetIndexesForRange } from './vod-storyboard';

const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0xFF, 0xD9]);
const manifest = [
    { count: 200, width: 160, rows: 40, images: ['900-low-0.jpg'], interval: 117, quality: 'low', cols: 5, height: 90 },
    { count: 200, width: 220, rows: 10, images: ['900-high-0.jpg', '900-high-1.jpg', '900-high-2.jpg', '900-high-3.jpg'], interval: 117, quality: 'high', cols: 5, height: 124 },
];
const manifestUrl = 'https://d3stzm2eumvgb4.cloudfront.net/abc_kanal_1_2/storyboards/900-info.json';

function fakeFetch(overrides: Record<string, Response | (() => Response)> = {}): { fetch: typeof fetch; requested: string[] } {
    const requested: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        const override = overrides[url.split('/').pop()!];
        if (override) return typeof override === 'function' ? override() : override;
        if (url.endsWith('-info.json')) return new Response(JSON.stringify(manifest));
        return new Response(JPEG);
    }) as typeof fetch;
    return { fetch: fetchImpl, requested };
}

describe('selectStoryboardEntry', () => {
    it('prefers the high-quality sheets', () => {
        expect(selectStoryboardEntry(manifest)).toMatchObject({ intervalSeconds: 117, frameCount: 200, columns: 5, rows: 10, cellWidth: 220, images: manifest[1].images });
    });

    it('ignores entries with unsafe image names or missing numbers', () => {
        expect(selectStoryboardEntry([{ ...manifest[1], images: ['../secret.jpg'] }])).toBeNull();
        expect(selectStoryboardEntry([{ ...manifest[1], images: ['https://evil.example/a.jpg'] }])).toBeNull();
        expect(selectStoryboardEntry([{ ...manifest[1], interval: 0 }])).toBeNull();
        expect(selectStoryboardEntry('nope')).toBeNull();
    });
});

describe('sheetIndexesForRange', () => {
    const entry = selectStoryboardEntry(manifest)!;

    it('returns only the sheets that cover the requested time', () => {
        expect(sheetIndexesForRange(entry, null, null)).toEqual([0, 1, 2, 3]);
        expect(sheetIndexesForRange(entry, 0, 600)).toEqual([0]);
        expect(sheetIndexesForRange(entry, 5800, 5900)).toEqual([0, 1]);
        expect(sheetIndexesForRange(entry, 6000, 12000)).toEqual([1, 2]);
        expect(sheetIndexesForRange(entry, 999999, null)).toEqual([3]);
    });
});

describe('loadStoryboard', () => {
    it('loads the selected sheets from the Twitch media host', async () => {
        const { fetch: fetchImpl, requested } = fakeFetch();
        const storyboard = await loadStoryboard('900', 6000, 12000, { manifestUrl: async () => manifestUrl, fetch: fetchImpl, signal: new AbortController().signal });
        expect(storyboard).toMatchObject({ vodId: '900', intervalSeconds: 117, frameCount: 200, columns: 5, rows: 10 });
        expect(storyboard!.sheets.map(sheet => [sheet.index, sheet.firstFrame, sheet.frameCount])).toEqual([[1, 50, 50], [2, 100, 50]]);
        expect(requested.slice(1).every(url => url.startsWith('https://d3stzm2eumvgb4.cloudfront.net/abc_kanal_1_2/storyboards/900-high-'))).toBe(true);
    });

    it('returns nothing when Twitch has no storyboard or the images are not JPEG files', async () => {
        const signal = new AbortController().signal;
        expect(await loadStoryboard('900', null, null, { manifestUrl: async () => null, fetch: fakeFetch().fetch, signal })).toBeNull();
        const html = fakeFetch(Object.fromEntries(manifest[1].images.map(name => [name, () => new Response('<html>')])));
        expect(await loadStoryboard('900', null, null, { manifestUrl: async () => manifestUrl, fetch: html.fetch, signal })).toBeNull();
        expect(await loadStoryboard('abc', null, null, { manifestUrl: async () => manifestUrl, fetch: fakeFetch().fetch, signal })).toBeNull();
    });

    it('refuses manifests from hosts other than the Twitch media network', async () => {
        const signal = new AbortController().signal;
        await expect(loadStoryboard('900', null, null, { manifestUrl: async () => 'https://evil.example/900-info.json', fetch: fakeFetch().fetch, signal })).rejects.toThrow(/Invalid VOD media host/);
        await expect(loadStoryboard('900', null, null, { manifestUrl: async () => 'http://d3stzm2eumvgb4.cloudfront.net/900-info.json', fetch: fakeFetch().fetch, signal })).rejects.toThrow(/Invalid VOD media host/);
    });
});

describe('MCP settings protection', () => {
    it('cannot be switched on through the general settings or a configuration import', () => {
        const attempt = { mcp_enabled: true, mcp_network_access: true, mcp_port: 8080, mcp_public_url: 'https://evil.example', mcp_access_token: 'x'.repeat(43), language: 'en' };
        expect(sanitizeConfigInput(attempt)).toEqual({ language: 'en' });
        expect(sanitizeImportedConfig(attempt)).toEqual({ language: 'en' });
    });
});
