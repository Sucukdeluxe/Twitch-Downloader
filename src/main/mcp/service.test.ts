import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueItem } from '../../types';
import type { VodTimeline } from '../domain/vod-timeline';
import { McpService, type McpHost, type McpQueueDraft } from './index';
import { MediaJobQueue, type MediaJobRequest } from './media-jobs';
import type { StoredPlan } from './part-plan-store';

const TOKEN = 't'.repeat(43);
const ROOT = path.resolve('/fixture-downloads');
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
const services: McpService[] = [];

const timeline: VodTimeline = {
    vodId: '900', title: 'Langer Stream', started: Date.parse('2026-11-14T11:00:00Z'), duration: 6 * 3600, login: 'kanal',
    chapters: [
        { id: 'a', start: 0, end: 3600, name: 'Just Chatting', game_id: '1', image: null, precision: 'source' },
        { id: 'b', start: 3600, end: 14400, name: 'Minecraft', game_id: '2', image: null, precision: 'source' },
        { id: 'c', start: 14400, end: 21600, name: 'Just Chatting', game_id: '1', image: null, precision: 'source' },
    ],
    titleHistory: [{ id: 't1', at: Date.parse('2026-11-14T12:00:00Z'), until: Date.parse('2026-11-14T17:00:00Z'), title: 'Jetzt Minecraft', kind: 'changed', precision: 'observed', priority: 2 }],
    viewerHistory: [[{ at: Date.parse('2026-11-14T11:00:30Z'), viewers: 100 }, { at: Date.parse('2026-11-14T11:01:00Z'), viewers: 300 }]],
    viewerGaps: [], chaptersStatus: 'available', titlesStatus: 'local',
};

const fixtureSegments: { value: number[] | null } = { value: null };

interface Fixture { host: McpHost; queue: QueueItem[]; drafts: McpQueueDraft[]; jobRequests: MediaJobRequest[]; starts: boolean[]; jobs: MediaJobQueue; plans: StoredPlan[]; automation: { vod: Set<string>; record: Set<string> }; grabs: Array<{ times: number[]; width: number; height: number }>; existing: Set<string>; window: { waiting: boolean }; live: Set<string> }

function createFixture(): Fixture {
    fixtureSegments.value = Array.from({ length: 2161 }, (_value, index) => index * 10);
    const queue: QueueItem[] = [], drafts: McpQueueDraft[] = [], jobRequests: MediaJobRequest[] = [], starts: boolean[] = [], plans: StoredPlan[] = [];
    const automation = { vod: new Set<string>(['kanal']), record: new Set<string>() };
    const existing = new Set<string>(), window = { waiting: false };
    const grabs: Array<{ times: number[]; width: number; height: number }> = [];
    const live = new Set<string>(['kanal']);
    const rawFrames = (times: number[], width: number, height: number) => { grabs.push({ times, width, height }); return times.map((_time, index) => index === 2 ? null : Buffer.alloc(width * height * 3, 90)); };
    const chat = Array.from({ length: 400 }, (_value, index) => ({ id: 'm' + index, offset: 1000 + index * 3, user: 'user' + (index % 7), text: index % 50 === 0 ? 'TIKTOK ZEIT' : 'lol ' + index }));
    const jobs = new MediaJobQueue(async (request, context) => {
        jobRequests.push(request);
        context.onProgress(50);
        return { outputPath: request.outputPath, duration: 120, bytes: 4096 };
    });
    const files = new Map([[path.join(ROOT, 'kanal', 'a.mp4'), 3600], [path.join(ROOT, 'kanal', 'b.mp4'), 1800], [path.join(ROOT, 'kanal', 'c.mp4'), 900]]);
    const host: McpHost = {
        createRecordingFolder: (folder, dryRun) => ({ path: folder, created: !dryRun, dry_run: dryRun }),
        organizeRecordings: async (files, dryRun) => ({ dry_run: dryRun, files: files.map(file => ({ ...file, bytes: 10, status: dryRun ? 'planned' : 'moved' })) }),
        downloadSettings: () => ({ download_mode: 'parts', part_minutes: 60, parallel_downloads: 1, default_quality: 'source' }),
        updateDownloadSettings: change => ({ ...host.downloadSettings(), ...change }),
        status: async () => ({
            version: '9.9.9', language: 'de', downloadFolder: ROOT, downloadMode: 'parts', partMinutes: 60, freeBytes: 50 * 1024 ** 3, parallelDownloads: 1,
            defaultQuality: 'source', downloading: false, paused: false, waitingForTimeWindow: window.waiting, nextDownloadWindowStart: window.waiting ? '2026-11-17T01:00:00.000Z' : null,
            tools: { ffmpeg: true, streamlink: true }, autoVodChannels: ['kanal'], autoRecordChannels: [],
        }),
        streamers: () => [{ login: 'kanal', displayName: 'Kanal', live: false, liveVodId: null }],
        listVods: async channel => channel !== 'kanal' ? null : [
            { id: '900', title: 'Langer Stream', startedAt: new Date(2026, 10, 14, 12, 0).toISOString(), durationSeconds: 21600, url: 'https://www.twitch.tv/videos/900', channel, live: false, downloaded: false },
            { id: '899', title: 'Vortag', startedAt: new Date(2026, 10, 13, 12, 0).toISOString(), durationSeconds: 7200, url: 'https://www.twitch.tv/videos/899', channel, live: false, downloaded: true },
        ],
        timeline: async vodId => vodId === '900' ? structuredClone(timeline) : null,
        storyboard: async () => ({ vodId: '900', intervalSeconds: 108, frameCount: 200, columns: 5, rows: 10, cellWidth: 220, cellHeight: 124, sheets: [0, 1, 2, 3].map(index => ({ index, firstFrame: index * 50, frameCount: 50, jpeg: JPEG })) }),
        vodFrames: async (_vodId, times) => times.map((time, index) => ({ time, jpeg: index === 1 ? null : JPEG })),
        vodRawFrames: async (_vodId, times, width, height) => rawFrames(times, width, height),
        fileRawFrames: async (_file, times, width, height) => rawFrames(times, width, height),
        encodeJpeg: async image => image.rgb.length === image.width * image.height * 3 ? Buffer.concat([JPEG, Buffer.from(`${image.width}x${image.height}`)]) : null,
        decodeJpeg: async (_jpeg, width, height) => Buffer.alloc(width * height * 3, 40),
        chatRange: async (_vodId, from, to, maximum) => {
            const matching = chat.filter(message => message.offset >= from && message.offset < to);
            return { messages: matching.slice(0, maximum), nextFrom: matching.length > maximum ? matching[maximum].offset : null };
        },
        chatActivity: async (_vodId, from, to, step) => Array.from({ length: Math.ceil((to - from) / step) }, (_value, index) => ({ start: from + index * step, messagesPerMinute: index === 1 ? 240 : 12, samples: index === 1 ? ['TIKTOK ZEIT', 'endlich'] : ['hallo'] })),
        vodClips: async vodId => vodId !== '900' ? null : { clips: [{ slug: 'KlarerClip-abc', title: 'rewi anruf', views: 308, duration: 60, offset: 6570, createdAt: '2026-11-14T13:00:00Z' }], complete: true, uncovered: null },
        savePartPlan: async (plan) => { plans.push(plan); },
        partPlans: async vodId => plans.filter(plan => plan.vodId === vodId).reverse(),
        plannedVodIds: async () => new Set(plans.map(plan => plan.vodId)),
        fileSize: async file => existing.has(path.basename(file)) ? 5 * 1024 ** 3 : null,
        channelAutomation: channel => ({ autoDownloadVods: automation.vod.has(channel), autoRecord: automation.record.has(channel) }),
        setChannelAutomation: (channel, change) => {
            if (change.autoDownloadVods !== undefined) automation.vod[change.autoDownloadVods ? 'add' : 'delete'](channel);
            if (change.autoRecord !== undefined) automation.record[change.autoRecord ? 'add' : 'delete'](channel);
            return { autoDownloadVods: automation.vod.has(channel), autoRecord: automation.record.has(channel) };
        },
        startLiveRecording: async channel => live.has(channel) ? { started: true, reason: null, title: 'Live jetzt' } : { started: false, reason: 'offline', title: null },
        queue: () => queue,
        queueState: () => ({ downloading: starts.length > 0, paused: false }),
        addToQueue(items) {
            return items.map((draft) => {
                if (drafts.some(existing => JSON.stringify(existing.customClip) === JSON.stringify(draft.customClip) && existing.url === draft.url)) return { accepted: false, reason: 'duplicate', item: null };
                drafts.push(draft);
                const item: QueueItem = { id: `1700000000000-${queue.length + 1}`, title: draft.title, url: draft.url, date: draft.date, streamer: draft.streamer, duration_str: '6h0m0s', status: 'pending', progress: 0, customClip: draft.customClip, outputPath: draft.outputPath };
                queue.push(item);
                return { accepted: true, reason: null, item };
            });
        },
        partOutputFolder: (channel) => path.join(ROOT, channel, '14.11.2026'),
        startQueue: async (ignoreTimeWindow) => { starts.push(ignoreTimeWindow === true); return true; },
        pauseQueue: async () => true,
        removeQueueItem: async (id) => { const index = queue.findIndex(item => item.id === id); if (index < 0) return false; queue.splice(index, 1); return true; },
        retryQueueItems: async ids => queue.filter(item => item.status === 'error' && (!ids || ids.includes(item.id))).map(item => { item.status = 'pending'; return item.id; }),
        clearCompletedQueueItems: () => { const before = queue.length; for (let index = queue.length - 1; index >= 0; index--) if (queue[index].status === 'completed') queue.splice(index, 1); return before - queue.length; },
        waitForQueueChange: () => new Promise(resolve => setTimeout(resolve, 10)),
        searchRecordings: async () => ({
            totalScanned: 2, matchCount: 2, truncated: false, scannedAt: new Date().toISOString(), rootExists: true, streamers: ['kanal'], offset: 0,
            hits: [...files.keys()].map(fullPath => ({ fullPath, fileName: path.basename(fullPath), streamer: 'kanal', type: 'vod' as const, size: 1024 ** 3, mtimeMs: Date.UTC(2026, 10, 14), chatPath: null, eventsPath: null })),
        }),
        resolveRecording: async file => files.has(path.resolve(file)) ? path.resolve(file) : null,
        resolveOutputFolder: async (folder, fallbackSource) => {
            const target = path.resolve(folder ?? path.dirname(fallbackSource));
            return target === ROOT || target.startsWith(ROOT + path.sep) ? target : null;
        },
        videoInfo: async file => ({ path: file, sizeBytes: 1024 ** 3, durationSeconds: files.get(file)!, width: 1920, height: 1080, fps: 60, videoCodec: 'h264', audioCodec: 'aac', audioTracks: 1 }),
        vodSegments: async vodId => vodId === '900' ? fixtureSegments.value : null,
        sourceFormatDifferences: async files => files.some(file => file.endsWith('b.mp4')) && files.some(file => file.endsWith('c.mp4')) ? ['video height'] : [],
        recordingEvents: async () => [{ offsetSeconds: 0, at: '2026-11-14T11:00:00.000Z', type: 'recording_start', title: 'Start', category: 'Just Chatting' }],
        fileFrames: async (_file, times) => times.map(time => ({ time, jpeg: JPEG })),
        enqueueMediaJob: request => jobs.enqueue(request),
        mediaJobs: () => jobs.list(),
        cancelMediaJob: id => jobs.cancel(id),
        waitForMediaJobChange: (timeoutMs, signal) => jobs.waitForChange(Math.min(timeoutMs, 50), signal),
    };
    return { host, queue, drafts, jobRequests, starts, jobs, plans, automation, grabs, live, existing, window };
}

async function startService(fixture: Fixture) {
    const service = new McpService({ host: fixture.host, version: '9.9.9', token: () => TOKEN, log: () => undefined });
    services.push(service);
    await service.apply({ enabled: true, port: 0, network: false });
    const url = `http://127.0.0.1:${service.status().port}/mcp`;
    let id = 0;
    const rpc = async (method: string, params?: Record<string, unknown>): Promise<any> => {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2025-06-18' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }),
        });
        const text = await response.text();
        const payload = response.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6) : text;
        return JSON.parse(payload);
    };
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => (await rpc('tools/call', { name, arguments: args })).result;
    return { service, url, rpc, call };
}

afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.stop()));
});

describe('MCP service protocol', () => {
    it('answers the 2025 handshake with server information and usage instructions', async () => {
        const { rpc } = await startService(createFixture());
        const { result } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        expect(result.protocolVersion).toBe('2025-06-18');
        expect(result.serverInfo).toMatchObject({ name: 'twitch-downloader', title: 'Twitch Downloader', version: '9.9.9' });
        expect(result.capabilities.tools).toBeDefined();
        expect(result.instructions).toContain('queue_vod_parts');
    });

    it('serves the 2026-07-28 revision without a handshake', async () => {
        const { url } = await startService(createFixture());
        const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } };
        const post = async (method: string, params: Record<string, unknown>, extra: Record<string, string> = {}) => (await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...extra },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
        })).json() as Promise<any>;
        const discover = await post('server/discover', {});
        expect(discover.result.supportedVersions).toContain('2026-07-28');
        expect(discover.result.instructions).toContain('get_vod_timeline');
        const status = await post('tools/call', { name: 'get_status', arguments: {} }, { 'mcp-name': 'get_status' });
        expect(status.result.resultType).toBe('complete');
        expect(status.result.structuredContent.version).toBe('9.9.9');
    });

    it('lists every tool with a description, object schema and explicit read-only hint', async () => {
        const { rpc } = await startService(createFixture());
        const { result } = await rpc('tools/list');
        expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
            'create_recording_folder', 'get_download_settings', 'organize_recordings', 'set_download_settings',
            'cancel_file_job', 'clear_completed_queue_items', 'create_videos_from_files', 'get_file_jobs', 'get_queue', 'get_recording_events', 'get_status',
            'get_video_frames', 'get_video_info', 'get_vod_chat', 'get_vod_chat_activity', 'get_vod_clips', 'get_vod_frames', 'get_vod_parts_state', 'get_vod_storyboard',
            'get_vod_timeline', 'list_recordings', 'list_streamers', 'list_vods', 'pause_queue', 'queue_vod', 'queue_vod_parts', 'remove_queue_items', 'retry_queue_items',
            'scan_video_frames', 'scan_vod_frames', 'set_channel_automation', 'start_live_recording', 'start_queue', 'suggest_vod_parts', 'wait_for_file_jobs', 'wait_for_queue',
        ].sort());
        for (const tool of result.tools) {
            expect(tool.description.length).toBeGreaterThan(40);
            expect(tool.inputSchema.type).toBe('object');
            expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
            expect(typeof tool.annotations.destructiveHint).toBe('boolean');
            expect(`mcp__twitch-downloader__${tool.name}`.length).toBeLessThanOrEqual(64);
        }
        const destructive = result.tools.filter((tool: any) => tool.annotations.destructiveHint).map((tool: any) => tool.name).sort();
        expect(destructive).toEqual(['cancel_file_job', 'remove_queue_items']);
    });

    it('rejects requests without the access key', async () => {
        const { url } = await startService(createFixture());
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
        expect(response.status).toBe(401);
    });

    it('reports a port conflict instead of failing silently', async () => {
        const first = await startService(createFixture());
        const second = new McpService({ host: createFixture().host, version: '1', token: () => TOKEN, log: () => undefined });
        services.push(second);
        await second.apply({ enabled: true, port: first.service.status().port!, network: false });
        expect(second.status()).toMatchObject({ running: false, error: 'port-in-use' });
        await second.apply({ enabled: false, port: 0, network: false });
        expect(second.status()).toMatchObject({ running: false, error: null });
    });
});

describe('MCP VOD tools', () => {
    it('filters VODs by the day the stream started', async () => {
        const { call } = await startService(createFixture());
        const all = await call('list_vods', { channel: 'Kanal' });
        expect(all.structuredContent.vods.map((vod: any) => vod.vod_id)).toEqual(['900', '899']);
        const day = await call('list_vods', { channel: 'kanal', date: '2026-11-13' });
        expect(day.structuredContent.vods).toHaveLength(1);
        expect(day.structuredContent.vods[0]).toMatchObject({ vod_id: '899', duration: '02:00:00', downloaded: true });
        const unknown = await call('list_vods', { channel: 'niemand' });
        expect(unknown.isError).toBe(true);
    });

    it('returns categories, title changes and viewer numbers as VOD positions', async () => {
        const { call } = await startService(createFixture());
        const result = await call('get_vod_timeline', { vod_id: 'https://www.twitch.tv/videos/900' });
        const data = result.structuredContent;
        expect(data).toMatchObject({ vod_id: '900', channel: 'kanal', duration_seconds: 21600, duration: '06:00:00', categories_status: 'available' });
        expect(data.categories[1]).toMatchObject({ category: 'Minecraft', start: 3600, end: 14400, start_tc: '01:00:00', end_tc: '04:00:00' });
        expect(data.title_changes).toEqual([{ start: 3600, start_tc: '01:00:00', title: 'Jetzt Minecraft' }]);
        expect(data.viewers).toMatchObject({ peak: 300, average: 200 });
        expect(JSON.parse(result.content[0].text)).toEqual(data);
    });

    it('suggests one part per category that covers the whole VOD', async () => {
        const { call } = await startService(createFixture());
        const data = (await call('suggest_vod_parts', { vod_id: '900' })).structuredContent;
        expect(data.parts.map((part: any) => [part.number, part.name, part.duration])).toEqual([[1, 'Just Chatting', '03:00:00'], [2, 'Minecraft', '03:00:00']]);
        expect(data.parts[0].ranges.map((range: any) => [range.start, range.end])).toEqual([[0, 3600], [14400, 21600]]);
        expect(data.coverage.complete).toBe(true);
    });

    it('returns storyboard sheets with the time printed below every frame', async () => {
        const { call } = await startService(createFixture());
        const result = await call('get_vod_storyboard', { vod_id: '900', from: '00:10:00', to: '01:00:00' });
        const images = result.content.filter((block: any) => block.type === 'image');
        expect(images).toHaveLength(1);
        expect(result.structuredContent.images[0]).toMatchObject({ image: 1, first_frame_tc: '00:00:00', last_frame_tc: '01:28:12', frames: 50 });
        expect(result.structuredContent.how_to_read).toContain('printed below it');
        expect(Buffer.from(images[0].data, 'base64').subarray(4).toString()).toBe('1108x1458');
    });

    it('labels every returned frame with its time and marks unavailable frames', async () => {
        const { call } = await startService(createFixture());
        const result = await call('get_vod_frames', { vod_id: '900', times: [60, '00:02:00', 180] });
        expect(result.structuredContent.frames.map((frame: any) => frame.available)).toEqual([true, false, true]);
        expect(result.content.filter((block: any) => block.type === 'image')).toHaveLength(2);
        expect(result.content.map((block: any) => block.text).filter(Boolean)).toContain('Frame at 00:03:00 (180 s)');
        expect((await call('get_vod_frames', { vod_id: '900', times: ['07:00:00'] })).isError).toBe(true);
    });
});

describe('MCP queue tools', () => {
    const parts = [
        { name: 'TikTok', ranges: [{ start: 0, end: '01:00:00' }, { start: '04:00:00', end: '06:00:00' }] },
        { name: 'Minecraft', ranges: [{ start: 3600, end: 14400 }] },
    ];

    it('refuses plans with gaps and names the missing time', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const result = await call('queue_vod_parts', { vod_id: '900', parts: [parts[0]] });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Not covered: 01:00:00–04:00:00');
        expect(result.structuredContent.queued).toBe(false);
        expect(fixture.drafts).toHaveLength(0);
    });

    it('refuses double coverage unless it is allowed', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const overlapping = [{ name: 'A', ranges: [{ start: 0, end: 12000 }] }, { name: 'B', ranges: [{ start: 10800, end: 21600 }] }];
        const rejected = await call('queue_vod_parts', { vod_id: '900', parts: overlapping, dry_run: true });
        expect(rejected.isError).toBe(true);
        expect(rejected.content[0].text).toContain('Covered twice by parts 1 and 2: 03:00:00–03:20:00');
        const allowed = await call('queue_vod_parts', { vod_id: '900', parts: overlapping, dry_run: true, allow_double_coverage: true });
        expect(allowed.isError).toBeUndefined();
    });

    it('shows the plan and file names in a dry run without queueing', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const data = (await call('queue_vod_parts', { vod_id: '900', parts, dry_run: true })).structuredContent;
        expect(data).toMatchObject({ dry_run: true, queued: false });
        expect(data.coverage.complete).toBe(true);
        expect(data.parts.map((part: any) => path.basename(part.output_file))).toEqual(['14.11.2026_Part01_TikTok.mp4', '14.11.2026_Part02_Minecraft.mp4']);
        expect(fixture.drafts).toHaveLength(0);
        expect(fixture.starts).toHaveLength(0);
    });

    it('queues one download per part with joined ranges and starts the queue', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const data = (await call('queue_vod_parts', { vod_id: '900', parts, first_part_number: 3, filename_template: '{channel}_{part_padded}_{name}', quality: '720p60' })).structuredContent;
        expect(data.queued).toBe(true);
        expect(data.parts.map((part: any) => part.result)).toEqual(['queued', 'queued']);
        expect(data.parts.map((part: any) => part.queue_item_id)).toEqual(['1700000000000-1', '1700000000000-2']);
        expect(fixture.starts).toEqual([false]);
        expect(fixture.drafts).toHaveLength(2);
        expect(fixture.drafts[0]).toMatchObject({
            url: 'https://www.twitch.tv/videos/900', streamer: 'kanal', durationSeconds: 21600, quality: '720p60', title: 'Part 3 · TikTok',
            outputPath: path.join(ROOT, 'kanal', '14.11.2026', 'kanal_03_TikTok.mp4'),
            customClip: { startSec: 0, durationSec: 21600, startPart: 3, filenameFormat: 'parts', omissions: { version: 1, partDurationSec: 10800, ranges: [{ start: 3600, end: 14400 }], selection: { start: 0, end: 21600 } } },
        });
        expect(fixture.drafts[1].customClip!.omissions).toEqual({ version: 1, partDurationSec: 10800, ranges: [], selection: { start: 3600, end: 14400 }, cuts: 'segments' });
        expect(data.cuts.moved).toEqual([]);
        const again = (await call('queue_vod_parts', { vod_id: '900', parts, first_part_number: 3, start: false })).structuredContent;
        expect(again.parts.map((part: any) => part.result)).toEqual(['already in queue', 'already in queue']);
        expect(again.queued).toBe(false);
        expect(fixture.starts).toEqual([false]);
    });

    it('downloads selected ranges only when full coverage is switched off', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const data = (await call('queue_vod_parts', { vod_id: '900', parts: [{ name: 'Highlight', ranges: [{ start: 600, end: 660 }] }], require_full_coverage: false, start: false })).structuredContent;
        expect(data.queued).toBe(true);
        expect(data.coverage.complete).toBe(false);
        expect(fixture.starts).toHaveLength(0);
    });

    it('explains invalid ranges instead of queueing them', async () => {
        const { call } = await startService(createFixture());
        const result = await call('queue_vod_parts', { vod_id: '900', parts: [{ name: 'Zu lang', ranges: [{ start: 0, end: '07:00:00' }] }] });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('after the end of the source (06:00:00)');
        const missing = await call('queue_vod_parts', { vod_id: '123', parts });
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toContain('not found');
    });

    it('moves every cut to a segment boundary of the VOD so that neighbouring parts meet exactly', async () => {
        const fixture = createFixture();
        const uneven = [0];
        while (uneven.at(-1)! < 21600) uneven.push(Math.round((uneven.at(-1)! + (uneven.length % 7 === 0 ? 11.466 : 10)) * 1000) / 1000);
        uneven[uneven.length - 1] = 21600.068;
        fixtureSegments.value = uneven;
        const { call } = await startService(fixture);
        const data = (await call('queue_vod_parts', { vod_id: '900', parts: [
            { name: 'A', ranges: [{ start: 0, end: 3600 }, { start: 14403, end: 21600 }] },
            { name: 'B', ranges: [{ start: 3600, end: 14403 }] },
        ] })).structuredContent;
        const cut = (time: number): number => uneven.reduce((best, boundary) => Math.abs(boundary - time) < Math.abs(best - time) ? boundary : best, 0);
        const first = cut(3600), second = cut(14403);
        expect(first).not.toBe(3600);
        expect(data.coverage).toMatchObject({ complete: true, source_duration_seconds: 21600.068, gaps: [], double_coverage: [] });
        expect(data.parts[0].ranges.map((range: any) => [range.start, range.end])).toEqual([[0, first], [second, 21600.068]]);
        expect(data.parts[1].ranges.map((range: any) => [range.start, range.end])).toEqual([[first, second]]);
        expect(data.cuts.moved.map((move: any) => [move.requested, move.actual])).toEqual([[3600, first], [14403, second]]);
        expect(data.cuts.moved[0]).toMatchObject({ requested_tc: '01:00:00', moved_seconds: Math.round((first - 3600) * 1000) / 1000 });
        expect(fixture.drafts[0].customClip).toMatchObject({ durationSec: 21601, omissions: { ranges: [{ start: first, end: second }], selection: { start: 0, end: 21600.068 }, cuts: 'segments' } });
        expect(fixture.drafts[1].customClip!.omissions).toMatchObject({ ranges: [], selection: { start: first, end: second }, cuts: 'segments' });
        expect(fixture.plans[0].parts.map(part => part.ranges)).toEqual([[{ start: 0, end: first }, { start: second, end: 21600.068 }], [{ start: first, end: second }]]);
    });

    it('queues nothing when the segment list of the VOD cannot be read', async () => {
        const fixture = createFixture();
        fixtureSegments.value = null;
        const { call } = await startService(fixture);
        const result = await call('queue_vod_parts', { vod_id: '900', parts });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('segment list of this VOD could not be read');
        expect(fixture.drafts).toHaveLength(0);
        expect(fixture.plans).toHaveLength(0);
    });

    it('gives parts new file names when files of an earlier plan exist and reports a closed download window', async () => {
        const fixture = createFixture();
        fixture.existing.add('14.11.2026_Part01_TikTok.mp4');
        fixture.existing.add('14.11.2026_Part01_TikTok_1.mp4');
        fixture.window.waiting = true;
        const { call } = await startService(fixture);
        const data = (await call('queue_vod_parts', { vod_id: '900', parts })).structuredContent;
        expect(data.parts.map((part: any) => path.basename(part.output_file))).toEqual(['14.11.2026_Part01_TikTok_2.mp4', '14.11.2026_Part02_Minecraft.mp4']);
        expect(fixture.plans[0].parts[0].outputFile).toBe(path.join(ROOT, 'kanal', '14.11.2026', '14.11.2026_Part01_TikTok_2.mp4'));
        expect(data).toMatchObject({ queued: true, queue_started: false, waiting_for_time_window: true, next_time_window_start: '2026-11-17T01:00:00.000Z' });
        const started = (await call('start_queue', {})).structuredContent;
        expect(started).toMatchObject({ started: false, waiting_for_time_window: true });
    });

    it('suggests parts for a VOD without categories even when the title is very long', async () => {
        const fixture = createFixture();
        const original = fixture.host.timeline;
        fixture.host.timeline = async (id, refresh) => { const value = await original(id, refresh); return value ? { ...value, chapters: [], title: 'Sehr langer Titel '.repeat(9) } : value; };
        const { call } = await startService(fixture);
        const result = await call('suggest_vod_parts', { vod_id: '900', max_part_minutes: 120 });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent.parts).toHaveLength(3);
        expect(result.structuredContent.parts.every((part: any) => part.name.length <= 120)).toBe(true);
    });

    it('queues a complete VOD and reports duplicates', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const first = await call('queue_vod', { vod_id: '900' });
        expect(first.structuredContent.queued).toMatchObject({ kind: 'vod', vod_id: '900', status: 'pending' });
        expect(fixture.drafts[0].customClip).toBeUndefined();
        const second = await call('queue_vod', { vod_id: '900' });
        expect(second.isError).toBe(true);
        expect(second.content[0].text).toContain('already');
    });

    it('waits for queue items and returns as soon as they are finished', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const queued = (await call('queue_vod_parts', { vod_id: '900', parts })).structuredContent;
        const ids = queued.parts.map((part: any) => part.queue_item_id);
        const pending = (await call('wait_for_queue', { ids, timeout_seconds: 1 })).structuredContent;
        expect(pending.finished).toBe(false);
        setTimeout(() => {
            fixture.queue[0].status = 'completed';
            fixture.queue[0].outputFiles = [fixture.queue[0].outputPath!];
            fixture.queue[1].status = 'error';
            fixture.queue[1].last_error = 'Netzwerkfehler';
        }, 60);
        const startedAt = Date.now();
        const done = (await call('wait_for_queue', { ids, timeout_seconds: 20 })).structuredContent;
        expect(Date.now() - startedAt).toBeLessThan(5000);
        expect(done.finished).toBe(true);
        expect(done.items[0]).toMatchObject({ status: 'completed', kind: 'vod_ranges', duration: '03:00:00' });
        expect(done.items[0].ranges.map((range: any) => [range.start, range.end])).toEqual([[0, 3600], [14400, 21600]]);
        expect(done.items[1]).toMatchObject({ status: 'error', error: 'Netzwerkfehler' });
        expect((await call('retry_queue_items', {})).structuredContent.retried_ids).toEqual([ids[1]]);
        expect((await call('clear_completed_queue_items', {})).structuredContent.cleared).toBe(1);
        const removal = (await call('remove_queue_items', { ids: [ids[1], 'unbekannt'] })).structuredContent;
        expect(removal).toMatchObject({ removed_ids: [ids[1]], not_found_ids: ['unbekannt'] });
        expect((await call('get_queue', {})).structuredContent.items).toEqual([]);
    });

    it('passes the time window override to the queue start', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        await call('start_queue', { ignore_time_window: true });
        expect(fixture.starts).toEqual([true]);
    });
});

describe('MCP file tools', () => {
    const a = path.join(ROOT, 'kanal', 'a.mp4'), b = path.join(ROOT, 'kanal', 'b.mp4');

    it('lists recordings and reads file details', async () => {
        const { call } = await startService(createFixture());
        const list = (await call('list_recordings', { channel: 'kanal', type: 'vod' })).structuredContent;
        expect(list.files.map((file: any) => file.name)).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
        const info = (await call('get_video_info', { path: a })).structuredContent;
        expect(info).toMatchObject({ duration: '01:00:00', width: 1920, video_codec: 'h264' });
        const outside = await call('get_video_info', { path: path.resolve('/windows/system32/x.mp4') });
        expect(outside.isError).toBe(true);
        expect(outside.content[0].text).toContain('not a video file inside the download folder');
    });

    it('plans outputs from segments and checks source coverage on request', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const videos = [
            { name: 'Thema 1', segments: [{ path: a, start: 0, end: 1800 }, { path: b }] },
            { name: 'Thema 2', segments: [{ path: a, start: 2000 }] },
        ];
        const gap = await call('create_videos_from_files', { videos, require_full_coverage: true });
        expect(gap.isError).toBe(true);
        expect(gap.content[0].text).toContain('a.mp4: Not covered: 00:30:00–00:33:20');
        expect(fixture.jobRequests).toHaveLength(0);
        const plan = (await call('create_videos_from_files', { videos, dry_run: true })).structuredContent;
        expect(plan.videos.map((video: any) => [path.basename(video.output_file), video.duration])).toEqual([['Thema 1.mp4', '01:00:00'], ['Thema 2.mp4', '00:26:40']]);
        expect(plan.videos[0].segments.map((segment: any) => segment.whole_file)).toEqual([false, true]);
        expect(plan.started).toBe(false);
    });

    it('starts background jobs and reports their result', async () => {
        const fixture = createFixture();
        const { call } = await startService(fixture);
        const started = (await call('create_videos_from_files', { videos: [{ name: 'Zusammen', segments: [{ path: a }, { path: b, start: '00:10:00', end: '00:20:00' }] }], output_folder: path.join(ROOT, 'Ausgabe') })).structuredContent;
        expect(started.started).toBe(true);
        const done = (await call('wait_for_file_jobs', { ids: [started.jobs[0].id], timeout_seconds: 5 })).structuredContent;
        expect(done.finished).toBe(true);
        expect(done.jobs[0]).toMatchObject({ status: 'completed', progress_percent: 100, output_file: path.join(ROOT, 'Ausgabe', 'Zusammen.mp4'), output_bytes: 4096 });
        expect(fixture.jobRequests[0].segments).toEqual([{ path: a }, { path: b, start: 600, end: 1200 }]);
    });

    it('rejects unknown sources, foreign output folders and pointless jobs', async () => {
        const { call } = await startService(createFixture());
        const unknown = await call('create_videos_from_files', { videos: [{ name: 'X', segments: [{ path: path.join(ROOT, 'fehlt.mp4') }, { path: a }] }] });
        expect(unknown.isError).toBe(true);
        const foreign = await call('create_videos_from_files', { videos: [{ name: 'X', segments: [{ path: a }, { path: b }] }], output_folder: path.resolve('/anderswo') });
        expect(foreign.isError).toBe(true);
        expect(foreign.content[0].text).toContain('inside the download folder');
        const whole = await call('create_videos_from_files', { videos: [{ name: 'X', segments: [{ path: a }] }] });
        expect(whole.isError).toBe(true);
        expect(whole.content[0].text).toContain('needs no processing');
        const late = await call('create_videos_from_files', { videos: [{ name: 'X', segments: [{ path: a, start: 0, end: 4000 }, { path: b }] }] });
        expect(late.content[0].text).toContain('after the end of the file (01:00:00)');
        const mixed = await call('create_videos_from_files', { videos: [{ name: 'Gemischt', segments: [{ path: b }, { path: path.join(ROOT, 'kanal', 'c.mp4') }] }], dry_run: true });
        expect(mixed.isError).toBe(true);
        expect(mixed.content[0].text).toContain('formats differ (video height)');
    });
});


describe('MCP recording management', () => {
    it('uses the requested stream day for folder and filename instead of the source start date', async () => {
        const fixture = createFixture();
        fixture.host.partOutputFolder = (channel, startedAt) => path.join(ROOT, channel, new Date(startedAt).getDate().toString());
        const { call } = await startService(fixture);
        const result = await call('queue_vod_parts', { vod_id: '900', stream_date: '2026-11-16', parts: [{ name: 'Game', ranges: [{ start: 0, end: 21600 }] }], dry_run: true });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent.output_folder).toBe(path.join(ROOT, 'kanal', '16'));
        expect(path.basename(result.structuredContent.parts[0].output_file)).toContain('16.11.2026');
        expect(fixture.drafts).toHaveLength(0);
    });
    it('validates a custom output folder and rejects impossible dates', async () => {
        const { call } = await startService(createFixture());
        const args = { vod_id: '900', parts: [{ name: 'Game', ranges: [{ start: 0, end: 21600 }] }], dry_run: true };
        const valid = await call('queue_vod_parts', { ...args, output_folder: path.join(ROOT, 'Final') });
        expect(valid.structuredContent.output_folder).toBe(path.join(ROOT, 'Final'));
        expect((await call('queue_vod_parts', { ...args, output_folder: path.resolve('/outside') })).isError).toBe(true);
        expect((await call('queue_vod_parts', { ...args, stream_date: '2026-02-30' })).isError).toBe(true);
    });
    it('exposes only download settings and keeps dry runs unchanged', async () => {
        const fixture = createFixture();
        const changes: unknown[] = [];
        fixture.host.downloadSettings = () => ({ download_mode: 'full', part_minutes: 60, parallel_downloads: 1, default_quality: 'source' });
        fixture.host.updateDownloadSettings = change => { changes.push(change); return { ...fixture.host.downloadSettings(), ...change }; };
        const { call } = await startService(fixture);
        expect((await call('get_download_settings')).structuredContent.settings.parallel_downloads).toBe(1);
        const preview = await call('set_download_settings', { settings: { parallel_downloads: 2 }, dry_run: true });
        expect(preview.structuredContent.after.parallel_downloads).toBe(2);
        expect(changes).toHaveLength(0);
        expect((await call('set_download_settings', { settings: { parallel_downloads: 3 } })).isError).toBe(true);
        expect((await call('set_download_settings', { settings: { mcp_access_token: 'unsafe' } })).isError).toBe(true);
        expect((await call('set_download_settings', { settings: { default_quality: '720p60' } })).isError).toBe(true);
        expect((await call('set_download_settings', { settings: { download_mode: 'parts' } })).isError).not.toBe(true);
        expect(changes).toEqual([{ download_mode: 'parts' }]);
    });
});
