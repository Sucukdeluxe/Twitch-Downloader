import axios from 'axios';
import { runMediaProcess } from './media-process';

export interface VodQualityOption { id: string; label: string }
export const TWITCH_VIDEO_CODEC_ARGS = ['--twitch-supported-codecs', 'h264,h265,av1'];

export function normalizeVodQuality(value: unknown): string | null {
    if (value === undefined || value === 'source' || value === 'best') return 'source';
    if (typeof value !== 'string' || value.length > 24) return null;
    const variants = value.split('_alt');
    if (variants.length > 2 || (variants.length === 2 && !/^[0-9]{0,2}$/.test(variants[1]))) return null;
    const parts = variants[0].split('p');
    if (parts.length !== 2 || !/^[1-9][0-9]{2,3}$/.test(parts[0]) || (parts[1] !== '' && !/^[1-9][0-9]{0,2}$/.test(parts[1]))) return null;
    return value;
}

export function vodQualityStreamArg(value?: string): string {
    const quality = normalizeVodQuality(value);
    if (!quality) throw new Error('Invalid VOD quality');
    return quality === 'source' ? 'source,best' : quality;
}

interface VodStream { url?: unknown; master?: unknown }

interface UnavailableVodVariant {
    id: string;
    url: string;
    height: number;
    fps?: number;
    codec?: string;
    source: boolean;
}

interface VodVariantMetadata {
    id: string;
    url: string;
    height: number;
    fps?: number;
    codec?: string;
    source: boolean;
}

function codecLabel(codecs: string): string | undefined {
    const value = codecs.toLowerCase();
    return /(?:^|,)(?:avc1|avc3)/.test(value) ? 'H.264'
        : /(?:^|,)(?:hvc1|hev1)/.test(value) ? 'H.265 / HEVC'
            : /(?:^|,)av01/.test(value) ? 'AV1' : undefined;
}

function qualityPath(urlValue: string, id: string, source: boolean): string | null {
    try {
        const url = new URL(urlValue);
        const parts = url.pathname.split('/');
        const index = parts.length - 2;
        if (index < 1 || !parts[index]) return null;
        parts[index] = source ? 'chunked' : id;
        url.pathname = parts.join('/');
        return url.href;
    } catch {
        return null;
    }
}

function parseResolution(value: unknown): number {
    const match = typeof value === 'string' ? value.match(/x([0-9]{3,4})$/) : null;
    return match ? Number(match[1]) : 0;
}

function parseUnavailableVodVariants(playlist: string, referenceUrl: string): UnavailableVodVariant[] {
    const line = playlist.split(/\r?\n/).find(value => value.includes('DATA-ID="com.amazon.ivs.unavailable-media"'));
    if (!line) return [];
    const value = line.match(/VALUE="([^"]+)"/)?.[1];
    if (!value) return [];
    try {
        const data = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Array<Record<string, unknown>>;
        return data.flatMap(entry => {
            const id = typeof entry['STABLE-VARIANT-ID'] === 'string' ? entry['STABLE-VARIANT-ID']
                : typeof entry.IVS_NAME === 'string' ? entry.IVS_NAME : '';
            const height = parseResolution(entry.RESOLUTION);
            const fpsValue = Number(entry['FRAME-RATE']);
            const fps = Number.isFinite(fpsValue) && fpsValue > 0 ? fpsValue : undefined;
            const normalizedId = normalizeVodQuality(id) ? id : height > 0
                ? `${height}p${fps ? Math.round(fps) : ''}` : '';
            if (!normalizedId || !normalizeVodQuality(normalizedId)) return [];
            const source = typeof entry['IVS-VARIANT-SOURCE'] === 'string'
                && entry['IVS-VARIANT-SOURCE'].toLowerCase().includes('source');
            const url = qualityPath(referenceUrl, normalizedId, source);
            if (!url || !height) return [];
            return [{ id: normalizedId, url, height, fps, codec: typeof entry.CODECS === 'string' ? codecLabel(entry.CODECS) : undefined, source }];
        });
    } catch {
        return [];
    }
}

function unavailableVariantsFromPlaylist(playlist: string, referenceUrl: string): VodVariantMetadata[] {
    return parseUnavailableVodVariants(playlist, referenceUrl).map(value => ({ ...value }));
}

function variantLabel(id: string, fps?: number, codec?: string): string {
    const [base, alternative] = id.split('_alt');
    const [height, rate] = base.split('p');
    const resolvedFps = fps || Number(rate);
    const displayedFps = resolvedFps && Math.abs(resolvedFps - Math.round(resolvedFps)) < 0.01 ? Math.round(resolvedFps) : resolvedFps;
    return [height + 'p', displayedFps ? displayedFps + ' fps' : '', codec || '', alternative !== undefined && !codec ? '#' + (Number(alternative || 0) + 2) : ''].filter(Boolean).join(' · ');
}

function playlistVariants(playlist: string, master: string): Map<string, { codec?: string; fps?: number }> {
    const variants = new Map<string, { codec?: string; fps?: number }>();
    let attributes: Record<string, string> | null = null;
    for (const raw of playlist.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            attributes = Object.fromEntries(Array.from(line.slice(18).matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g), match => [match[1], match[2] ?? match[3]]));
        } else if (line && !line.startsWith('#') && attributes) {
            const codec = codecLabel(attributes.CODECS || '');
            const rate = Number(attributes['FRAME-RATE']);
            const fps = Number.isFinite(rate) && rate > 0 && rate <= 1000 ? rate : undefined;
            try { variants.set(new URL(line, master).href, { codec, fps }); } catch {}
            attributes = null;
        }
    }
    return variants;
}

export function parseVodQualities(json: string, playlist = '', master = ''): VodQualityOption[] {
    const data = JSON.parse(json) as { streams?: Record<string, VodStream> };
    if (!data?.streams || typeof data.streams !== 'object') throw new Error('Missing VOD streams');
    const streams = { ...data.streams };
    const referenceUrl = Object.values(streams).find(value => typeof value?.url === 'string')?.url as string | undefined;
    const unavailable = referenceUrl ? unavailableVariantsFromPlaylist(playlist, referenceUrl) : [];
    for (const variant of unavailable) {
        if (!streams[variant.id]) streams[variant.id] = { url: variant.url };
    }
    const keys = Object.keys(streams).filter(key => key !== 'source' && key !== 'best' && normalizeVodQuality(key) === key && typeof streams[key]?.url === 'string');
    const rank = (key: string): number => { const parts = key.split('_')[0].split('p'); return Number(parts[0]) * 1000 + Number(parts[1] || 0); };
    keys.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
    if (!keys.length) throw new Error('No VOD video streams');
    const variants = playlistVariants(playlist, master);
    for (const variant of unavailable) variants.set(variant.url, { codec: variant.codec, fps: variant.fps });
    const label = (id: string): string => {
        const metadata = variants.get(String(streams[id].url));
        return variantLabel(id, metadata?.fps, metadata?.codec);
    };
    const sourceVariant = unavailable.filter(variant => variant.source).sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0))[0];
    const bestUrl = sourceVariant?.url || streams.source?.url || streams.best?.url;
    const best = keys.find(key => streams[key].url === bestUrl) || keys[0];
    return [{ id: 'source', label: 'Source · ' + label(best) }, ...keys.map(id => ({ id, label: label(id) }))];
}

export function parseVodPlaylistQualities(playlist: string, master: string): VodQualityOption[] {
    const streams: Record<string, VodStream> = {};
    const names = new Map<string, string>();
    let attributes: Record<string, string> | null = null;
    for (const raw of playlist.split(/\r?\n/)) {
        const line = raw.trim();
        const readAttributes = (value: string): Record<string, string> => Object.fromEntries(
            Array.from(value.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g), match => [match[1], match[2] ?? match[3]]),
        );
        if (line.startsWith('#EXT-X-MEDIA:')) {
            const media = readAttributes(line.slice(13));
            if (media.TYPE === 'VIDEO' && media['GROUP-ID'] && media.NAME) names.set(media['GROUP-ID'], media.NAME);
        } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
            attributes = readAttributes(line.slice(18));
        } else if (line && !line.startsWith('#') && attributes) {
            const current = attributes;
            attributes = null;
            const height = parseResolution(current.RESOLUTION);
            if (!height) continue;
            const name = current['IVS-NAME'] || names.get(current.VIDEO) || current['STABLE-VARIANT-ID'] || '';
            const namedQuality = name.replace(/\s*\(source\)$/i, '');
            const fps = Number(current['FRAME-RATE']);
            let id = normalizeVodQuality(namedQuality);
            if (!id || id === 'source') id = `${height}p${fps > 30 ? Math.round(fps) : ''}`;
            if (!normalizeVodQuality(id)) continue;
            const url = new URL(line, master);
            if (url.protocol !== 'https:') continue;
            const source = current['IVS-VARIANT-SOURCE'] === 'source' || /\(source\)$/i.test(name) || /\/chunked\//.test(url.pathname);
            if (streams[id]) {
                const base = id;
                let alternative = '_alt';
                if (streams[base + alternative]) {
                    alternative = '_alt2';
                    if (streams[base + alternative]) continue;
                }
                id = base + alternative;
            }
            streams[id] = { url: url.href };
            if (source) streams.source = streams[id];
        }
    }
    return parseVodQualities(JSON.stringify({ streams }), playlist, master);
}

const directVodVariantCache = new Map<string, { expires: number; variants: UnavailableVodVariant[]; playlist: string; master: string }>();

async function loadDirectVodPlaylist(urlValue: string, signal?: AbortSignal): Promise<{ variants: UnavailableVodVariant[]; playlist: string; master: string }> {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || !['twitch.tv', 'www.twitch.tv'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('Invalid VOD URL');
    const id = url.pathname.match(/^\/videos\/(\d+)\/?$/)?.[1];
    if (!id) throw new Error('Invalid VOD URL');
    signal?.throwIfAborted();
    for (const [key, entry] of directVodVariantCache) if (entry.expires <= Date.now()) directVodVariantCache.delete(key);
    const cached = directVodVariantCache.get(id);
    if (cached) return cached;
    const requestSignal = AbortSignal.any([AbortSignal.timeout(6000), ...(signal ? [signal] : [])]);
    const query = {
        operationName: 'PlaybackAccessToken_Template',
        query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature } }',
        variables: { isLive: false, login: '', isVod: true, vodID: id, playerType: 'embed' },
    };
    const tokenResponse = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
        body: JSON.stringify(query), signal: requestSignal,
    });
    if (!tokenResponse.ok) throw new Error('VOD access token unavailable');
    const tokenData = await tokenResponse.json() as { data?: { videoPlaybackAccessToken?: { value?: string; signature?: string } } };
    const token = tokenData.data?.videoPlaybackAccessToken;
    if (!token?.value || !token.signature) throw new Error('VOD access token unavailable');
    const params = new URLSearchParams({
        sig: token.signature, token: token.value, allow_source: 'true', allow_audio_only: 'true', include_unavailable: 'true',
        platform: 'web', player_backend: 'mediaplayer', playlist_include_framerate: 'true', supported_codecs: 'av1,h265,h264',
    });
    const masterUrl = `https://usher.ttvnw.net/vod/v2/${id}.m3u8?${params.toString()}`;
    const masterResponse = await fetch(masterUrl, { signal: requestSignal });
    if (!masterResponse.ok) throw new Error('VOD playlist unavailable');
    const playlist = await masterResponse.text();
    requestSignal.throwIfAborted();
    if (playlist.length > 1048576 || !playlist.startsWith('#EXTM3U') || !/#EXT-X-STREAM-INF:[^\r\n]*RESOLUTION=\d+x\d+/i.test(playlist)) throw new Error('Invalid VOD playlist');
    try { parseVodPlaylistQualities(playlist, masterUrl); } catch { throw new Error('Invalid VOD playlist'); }
    const referenceUrl = playlist.split(/\r?\n/).find(line => /^https?:\/\//.test(line.trim()))?.trim();
    const variants = referenceUrl ? parseUnavailableVodVariants(playlist, referenceUrl) : [];
    const result = { expires: Date.now() + 120000, variants, playlist, master: masterUrl };
    if (directVodVariantCache.size >= 20) directVodVariantCache.delete(directVodVariantCache.keys().next().value!);
    directVodVariantCache.set(id, result);
    return result;
}

export async function resolveVodQualitySource(urlValue: string, quality?: string, signal?: AbortSignal): Promise<string | null> {
    const normalized = normalizeVodQuality(quality);
    if (!normalized) return null;
    if (normalized !== 'source' && Number(normalized.split('p')[0]) < 1100) return null;
    try {
        const { variants } = await loadDirectVodPlaylist(urlValue, signal);
        const source = variants.filter(value => value.source).sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0))[0];
        if (normalized === 'source') return source?.url || null;
        return variants.find(value => value.id === normalized)?.url || null;
    } catch {
        return null;
    }
}

async function loadVodPlaylist(json: string, signal: AbortSignal): Promise<{ playlist: string; master: string }> {
    const data = JSON.parse(json) as { streams?: Record<string, VodStream> };
    const stream = data.streams?.best || Object.values(data.streams || {}).find(value => typeof value?.master === 'string');
    if (typeof stream?.master !== 'string') return { playlist: '', master: '' };
    const url = new URL(stream.master);
    if (url.protocol !== 'https:' || url.hostname !== 'usher.ttvnw.net' || url.port || url.username || url.password) return { playlist: '', master: '' };
    const response = await axios.get<string>(url.href, { signal, timeout: 10000, maxRedirects: 0, maxContentLength: 1048576, responseType: 'text', transformResponse: value => value });
    return { playlist: response.data, master: url.href };
}

export class VodQualityService {
    private active: { id: string; controller: AbortController } | null = null;
    private readonly cache = new Map<string, { expires: number; qualities: VodQualityOption[] }>();

    cancel(id: unknown): void {
        if (this.active && this.active.id === id) { this.active.controller.abort(); this.active = null; }
    }

    async load(request: unknown, tools: { prepare: () => Promise<boolean>; streamlink: () => Promise<{ command: string; prefixArgs: string[] }> }): Promise<VodQualityOption[]> {
        const input = request as { id?: unknown; url?: unknown } | null;
        if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) || typeof input.url !== 'string') throw new Error('Invalid VOD request');
        const url = new URL(input.url);
        if (url.protocol !== 'https:' || !['twitch.tv', 'www.twitch.tv'].includes(url.hostname) || url.username || url.password || url.port || !/^\/videos\/\d+\/?$/.test(url.pathname)) throw new Error('Invalid VOD URL');
        this.active?.controller.abort();
        this.active = null;
        const key = 'https://www.twitch.tv' + url.pathname.replace(/\/$/, '');
        for (const [cachedKey, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(cachedKey);
        const cached = this.cache.get(key);
        if (cached) return structuredClone(cached.qualities);
        const active = { id: input.id, controller: new AbortController() };
        this.active = active;
        try {
            let qualities: VodQualityOption[] | undefined;
            try {
                const direct = await loadDirectVodPlaylist(key, active.controller.signal);
                qualities = parseVodPlaylistQualities(direct.playlist, direct.master);
            } catch {
                if (active.controller.signal.aborted) throw new Error('VOD quality request cancelled');
            }
            if (!qualities) {
                if (!await tools.prepare() || active.controller.signal.aborted) throw new Error('VOD quality request cancelled');
                const tool = await tools.streamlink();
                const output = await runMediaProcess(tool.command, [...tool.prefixArgs, '--loglevel', 'none', ...TWITCH_VIDEO_CODEC_ARGS, '--json', 'https://www.twitch.tv' + url.pathname], { signal: active.controller.signal, timeoutMs: 45000 });
                let metadata = { playlist: '', master: '' };
                try { metadata = await loadVodPlaylist(output, active.controller.signal); } catch { if (active.controller.signal.aborted) throw new Error('VOD quality request cancelled'); }
                if (active.controller.signal.aborted) throw new Error('VOD quality request cancelled');
                qualities = parseVodQualities(output, metadata.playlist, metadata.master);
            }
            if (active.controller.signal.aborted) throw new Error('VOD quality request cancelled');
            if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(key, { expires: Date.now() + 120000, qualities: structuredClone(qualities) });
            return qualities;
        } finally { if (this.active === active) this.active = null; }
    }
}
