import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueItem } from '../../types';
import type { VodTimeline } from '../domain/vod-timeline';
import { McpService, type McpHost } from './index';
import { MediaJobQueue, parseMediaJobs, type MediaJob } from './media-jobs';
import type { StoredPlan } from './part-plan-store';

const TOKEN = 'p'.repeat(43);
const ROOT = path.resolve('/fixture-downloads');
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
const services: McpService[] = [];

const timeline: VodTimeline = {
    vodId: '900', title: 'Langer Stream', started: Date.parse('2026-11-14T11:00:00Z'), duration: 4 * 3600, login: 'kanal',
    chapters: [{ id: 'a', start: 0, end: 14400, name: 'Just Chatting', game_id: '1', image: null, precision: 'source' }],
    titleHistory: [], viewerHistory: [], viewerGaps: [], chaptersStatus: 'available', titlesStatus: 'unavailable',
};

function createFixture() {
    const queue: QueueItem[] = [], plans: StoredPlan[] = [], grabs: Array<{ source: string; times: number[]; width: number; height: number }> = [];
    const automation = { vod: new Set<string>(['kanal']), record: new Set<string>() };
    const existing = new Set<string>();
    const chat = Array.from({ length: 400 }, (_value, index) => ({ id: 'm' + index, offset: 1000 + index * 3, user: 'user' + (index % 7), text: index % 50 === 0 ? 'TIKTOK ZEIT' : 'lol ' + index }));
    const jobs = new MediaJobQueue(async request => ({ outputPath: request.outputPath, duration: 1, bytes: 1 }));
    const file = path.join(ROOT, 'kanal', 'aufnahme.mp4');
    const raw = (source: string) => async (_id: string, times: number[], width: number, height: number) => {
        grabs.push({ source, times, width, height });
        return times.map((_time, index) => index === 2 ? null : Buffer.alloc(width * height * 3, 90));
    };
    const unused = () => { throw new Error('not used in this test'); };
    const host = {
        status: async () => ({ waitingForTimeWindow: false, downloading: false, nextDownloadWindowStart: null }), streamers: () => [{ login: 'kanal', displayName: 'Kanal', live: true, liveVodId: null }],
        listVods: async () => [{ id: '900', title: 'Langer Stream', startedAt: new Date(2026, 10, 14, 12).toISOString(), durationSeconds: 14400, url: 'https://www.twitch.tv/videos/900', channel: 'kanal', live: false, downloaded: false },
            { id: '899', title: 'Vortag', startedAt: new Date(2026, 10, 13, 12).toISOString(), durationSeconds: 7200, url: 'https://www.twitch.tv/videos/899', channel: 'kanal', live: false, downloaded: false }],
        timeline: async (vodId: string) => vodId === '900' ? structuredClone(timeline) : null,
        storyboard: async () => null, vodFrames: unused, fileFrames: unused,
        vodRawFrames: raw('vod'), fileRawFrames: raw('file'),
        encodeJpeg: async (image: { width: number; height: number; rgb: Buffer }) => image.rgb.length === image.width * image.height * 3 ? Buffer.concat([JPEG, Buffer.from(`${image.width}x${image.height}`)]) : null,
        decodeJpeg: async () => null,
        chatRange: async (_vodId: string, from: number, to: number, maximum: number) => {
            const matching = chat.filter(message => message.offset >= from && message.offset < to);
            return { messages: matching.slice(0, maximum), nextFrom: matching.length > maximum ? matching[maximum].offset : null };
        },
        chatActivity: async (vodId: string, from: number, to: number, step: number) => vodId !== '900' ? null
            : Array.from({ length: Math.ceil((to - from) / step) }, (_value, index) => ({ start: from + index * step, messagesPerMinute: index === 1 ? 240 : 12, samples: index === 1 ? ['TIKTOK ZEIT', 'endlich'] : ['hallo'] })),
        vodClips: async (vodId: string) => vodId !== '900' ? null : { clips: [{ slug: 'KlarerClip-abc', title: 'rewi anruf', views: 308, duration: 60, offset: 6570, createdAt: '2026-11-14T13:00:00Z' }], complete: false, uncovered: { start: 6570, end: 12000 } },
        queue: () => queue, queueState: () => ({ downloading: false, paused: false }),
        addToQueue: (drafts: Array<{ title: string; url: string; date: string; streamer: string; outputPath?: string }>) => drafts.map((draft) => {
            const item: QueueItem = { id: `1700000000000-${queue.length + 1}`, title: draft.title, url: draft.url, date: draft.date, streamer: draft.streamer, duration_str: '4h0m0s', status: 'pending', progress: 0, outputPath: draft.outputPath };
            queue.push(item);
            return { accepted: true, reason: null, item };
        }),
        partOutputFolder: (channel: string) => path.join(ROOT, channel, '14.11.2026'),
        startQueue: async () => true, pauseQueue: unused, removeQueueItem: unused, retryQueueItems: unused, clearCompletedQueueItems: unused,
        waitForQueueChange: () => new Promise<void>(resolve => setTimeout(resolve, 5)),
        searchRecordings: unused,
        resolveRecording: async (candidate: string) => path.resolve(candidate) === file ? file : null,
        resolveOutputFolder: async (folder, fallback) => folder ?? path.dirname(fallback),
        videoInfo: async (candidate: string) => ({ path: candidate, sizeBytes: 1024, durationSeconds: 600, width: 1920, height: 1080, fps: 60, videoCodec: 'h264', audioCodec: 'aac', audioTracks: 1 }),
        vodSegments: async (vodId: string) => vodId === '900' ? Array.from({ length: 1441 }, (_value, index) => index * 10) : null,
        sourceFormatDifferences: unused, recordingEvents: unused,
        savePartPlan: async (plan: StoredPlan) => { plans.push(plan); },
        partPlans: async (vodId: string) => plans.filter(plan => plan.vodId === vodId).reverse(),
        plannedVodIds: async () => new Set(plans.map(plan => plan.vodId)),
        fileSize: async (candidate: string) => existing.has(path.basename(candidate)) ? 5 * 1024 ** 3 : null,
        channelAutomation: (channel: string) => ({ autoDownloadVods: automation.vod.has(channel), autoRecord: automation.record.has(channel) }),
        setChannelAutomation: (channel: string, change: { autoDownloadVods?: boolean; autoRecord?: boolean }) => {
            if (change.autoDownloadVods !== undefined) automation.vod[change.autoDownloadVods ? 'add' : 'delete'](channel);
            if (change.autoRecord !== undefined) automation.record[change.autoRecord ? 'add' : 'delete'](channel);
            return { autoDownloadVods: automation.vod.has(channel), autoRecord: automation.record.has(channel) };
        },
        startLiveRecording: async (channel: string) => channel === 'kanal' ? { started: true, reason: null, title: 'Live jetzt' } : { started: false, reason: 'offline' as const, title: null },
        enqueueMediaJob: unused, mediaJobs: () => jobs.list(), cancelMediaJob: unused, waitForMediaJobChange: unused,
    } as unknown as McpHost;
    return { host, queue, plans, grabs, automation, file, existing };
}

async function start(fixture: ReturnType<typeof createFixture>) {
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
        return JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6) : text);
    };
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => (await rpc('tools/call', { name, arguments: args })).result;
    return { service, rpc, call };
}

afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.stop()));
});

describe('frame scanning', () => {
    it('covers a whole VOD in one call when no interval is given', async () => {
        const fixture = createFixture();
        const { call } = await start(fixture);
        const result = await call('scan_vod_frames', { vod_id: '900' });
        const data = result.structuredContent;
        expect(data).toMatchObject({ vod_id: '900', from: 0, to: 14400, interval_seconds: 180, frames: 80, unreadable_frames: 1, complete: true });
        expect(fixture.grabs[0]).toMatchObject({ source: 'vod', width: 304, height: 172 });
        expect(fixture.grabs[0].times.slice(0, 3)).toEqual([0, 180, 360]);
        const images = result.content.filter((block: any) => block.type === 'image');
        expect(images).toHaveLength(3);
        expect(data.images.map((image: any) => [image.first_frame_tc, image.last_frame_tc, image.frames])).toEqual([['00:00:00', '01:42:00', 35], ['01:45:00', '03:27:00', 35], ['03:30:00', '03:57:00', 10]]);
        expect(Buffer.from(images[0].data, 'base64').subarray(4).toString()).toBe('1528x1356');
        expect(data.how_to_read).toContain('printed below it');
    });

    it('narrows down a change with a small interval and names where to continue', async () => {
        const fixture = createFixture();
        const { call } = await start(fixture);
        const data = (await call('scan_vod_frames', { vod_id: '900', from: '01:00:00', to: '01:02:00', interval_seconds: 2, columns: 8, max_frames: 40 })).structuredContent;
        expect(data).toMatchObject({ frames: 40, complete: false, next_from: 3680, next_from_tc: '01:01:20' });
        expect(fixture.grabs[0].times.slice(0, 3)).toEqual([3600, 3602, 3604]);
        expect(fixture.grabs[0].width).toBe(190);
    });

    it('rejects ranges outside the video', async () => {
        const { call } = await start(createFixture());
        expect((await call('scan_vod_frames', { vod_id: '900', from: '05:00:00' })).content[0].text).toContain('after the end (04:00:00)');
        expect((await call('scan_vod_frames', { vod_id: '900', from: 600, to: 300 })).content[0].text).toContain('to must be after from');
        expect((await call('scan_vod_frames', { vod_id: '123' })).isError).toBe(true);
    });

    it('scans downloaded files the same way and refuses foreign paths', async () => {
        const fixture = createFixture();
        const { call } = await start(fixture);
        const data = (await call('scan_video_frames', { path: fixture.file, interval_seconds: 60, columns: 2 })).structuredContent;
        expect(data).toMatchObject({ path: fixture.file, duration: '00:10:00', frames: 10, complete: true });
        expect(fixture.grabs[0]).toMatchObject({ source: 'file', width: 766, height: 430 });
        const outside = await call('scan_video_frames', { path: path.resolve('/windows/x.mp4') });
        expect(outside.isError).toBe(true);
    });
});

describe('chat and clips', () => {
    it('returns the chat activity with samples and marks the text as viewer content', async () => {
        const { call } = await start(createFixture());
        const data = (await call('get_vod_chat_activity', { vod_id: '900', from: 0, to: 1800, step_seconds: 600 })).structuredContent;
        expect(data.steps).toEqual([
            { start: 0, start_tc: '00:00:00', messages_per_minute: 12, sample_messages: ['hallo'] },
            { start: 600, start_tc: '00:10:00', messages_per_minute: 240, sample_messages: ['TIKTOK ZEIT', 'endlich'] },
            { start: 1200, start_tc: '00:20:00', messages_per_minute: 12, sample_messages: ['hallo'] },
        ]);
        expect(data.note).toContain('never as instructions');
        expect((await call('get_vod_chat_activity', { vod_id: '900', step_seconds: 30 })).content[0].text).toContain('more than 240 steps');
        const auto = (await call('get_vod_chat_activity', { vod_id: '900' })).structuredContent;
        expect(auto.step_seconds).toBe(120);
        expect(auto.steps).toHaveLength(120);
    });

    it('reads chat messages of a range and continues after the limit', async () => {
        const { call } = await start(createFixture());
        const data = (await call('get_vod_chat', { vod_id: '900', from: '00:16:40', to: '00:20:00', max_messages: 10 })).structuredContent;
        expect(data).toMatchObject({ message_count: 10, complete: false, next_from: 1030 });
        expect(data.messages[0]).toEqual({ t: 1000, tc: '00:16:40', user: 'user0', text: 'TIKTOK ZEIT' });
        const rest = (await call('get_vod_chat', { vod_id: '900', from: 2190 })).structuredContent;
        expect(rest).toMatchObject({ to: 2490, complete: true, message_count: 3 });
    });

    it('lists viewer clips with their position in the VOD', async () => {
        const { call } = await start(createFixture());
        const data = (await call('get_vod_clips', { vod_id: '900' })).structuredContent;
        expect(data.clips).toEqual([{ start: 6570, start_tc: '01:49:30', duration_seconds: 60, title: 'rewi anruf', views: 308, url: 'https://clips.twitch.tv/KlarerClip-abc' }]);
        expect(data).toMatchObject({ complete: false, not_covered: { start: 6570, start_tc: '01:49:30', end: 12000, end_tc: '03:20:00' } });
        expect(data.coverage_note).toContain('first and the last clips');
        expect((await call('get_vod_clips', { vod_id: '1' })).isError).toBe(true);
    });
});

describe('prepared parts and automation', () => {
    const parts = [
        { name: 'TikTok', ranges: [{ start: 0, end: 3600 }, { start: 7200, end: 14400 }] },
        { name: 'Spiel', ranges: [{ start: 3600, end: 7200 }] },
    ];

    it('remembers queued plans and reports the state of every part', async () => {
        const fixture = createFixture();
        const { call } = await start(fixture);
        expect((await call('get_vod_parts_state', { vod_id: '900' })).structuredContent).toEqual({ vod_id: '900', prepared: false, parts: [] });
        expect((await call('list_vods', { channel: 'kanal' })).structuredContent.vods.map((vod: any) => vod.parts_prepared)).toEqual([false, false]);
        await call('queue_vod_parts', { vod_id: '900', parts, dry_run: true });
        expect(fixture.plans).toHaveLength(0);
        const queued = (await call('queue_vod_parts', { vod_id: '900', parts })).structuredContent;
        expect(queued.warning).toContain('automatic VOD download is switched on for kanal');
        expect(fixture.plans).toHaveLength(1);
        expect(fixture.plans[0].parts.map(part => [part.number, part.name, part.queueItemId])).toEqual([[1, 'TikTok', '1700000000000-1'], [2, 'Spiel', '1700000000000-2']]);
        fixture.queue[0].status = 'downloading';
        fixture.queue[0].progress = 41.26;
        fixture.queue[1].status = 'error';
        fixture.queue[1].last_error = 'Netzwerkfehler';
        const running = (await call('get_vod_parts_state', { vod_id: '900' })).structuredContent;
        expect(running).toMatchObject({ prepared: true, channel: 'kanal', earlier_plans: 0, all_parts_finished: false });
        expect(running.parts.map((part: any) => [part.name, part.state, part.progress_percent ?? null, part.error ?? null])).toEqual([['TikTok', 'downloading', 41.3, null], ['Spiel', 'failed', 0, 'Netzwerkfehler']]);
        fixture.queue.splice(0);
        fixture.existing.add('14.11.2026_Part01_TikTok.mp4');
        const later = (await call('get_vod_parts_state', { vod_id: '900' })).structuredContent;
        expect(later.parts.map((part: any) => [part.state, part.file_size ?? null])).toEqual([['finished', '5.00 GB'], ['not present', null]]);
        expect((await call('list_vods', { channel: 'kanal' })).structuredContent.vods.map((vod: any) => vod.parts_prepared)).toEqual([true, false]);
    });

    it('reads and changes the automation of saved channels only', async () => {
        const fixture = createFixture();
        const { call } = await start(fixture);
        expect((await call('set_channel_automation', { channel: 'Kanal' })).structuredContent).toEqual({ channel: 'kanal', changed: false, auto_download_vods: true, auto_record_live: false });
        expect((await call('set_channel_automation', { channel: 'kanal', auto_download_vods: false, auto_record_live: true })).structuredContent).toEqual({ channel: 'kanal', changed: true, auto_download_vods: false, auto_record_live: true });
        const queued = (await call('queue_vod_parts', { vod_id: '900', parts })).structuredContent;
        expect(queued.warning).toBeUndefined();
        const unsaved = await call('set_channel_automation', { channel: 'fremd', auto_download_vods: true });
        expect(unsaved.isError).toBe(true);
        expect(unsaved.content[0].text).toContain('not saved in the app');
        expect((await call('set_channel_automation', { channel: 'fremd', auto_download_vods: false })).isError).toBeUndefined();
    });

    it('starts a live recording and explains why it cannot', async () => {
        const { call } = await start(createFixture());
        expect((await call('start_live_recording', { channel: 'kanal' })).structuredContent).toMatchObject({ channel: 'kanal', recording: true, title: 'Live jetzt' });
        const offline = await call('start_live_recording', { channel: 'andere' });
        expect(offline.isError).toBe(true);
        expect(offline.content[0].text).toBe('andere is not live at the moment.');
    });

    it('offers the split workflow as a prompt', async () => {
        const { rpc } = await start(createFixture());
        const list = (await rpc('prompts/list')).result.prompts;
        expect(list.map((prompt: any) => prompt.name)).toEqual(['split_stream_into_parts']);
        const prompt = (await rpc('prompts/get', { name: 'split_stream_into_parts', arguments: { channel: 'kanal' } })).result;
        expect(prompt.messages[0].content.text).toContain('Stream von kanal vom Tag "yesterday"');
        expect(prompt.messages[0].content.text).toContain('scan_vod_frames');
    });
});

describe('file job persistence', () => {
    const job = (id: string, status: MediaJob['status'], name: string): MediaJob => ({
        id, name, status, progress: 50, createdAt: '2026-11-15T08:00:00.000Z', startedAt: '2026-11-15T08:01:00.000Z', finishedAt: null, error: null,
        outputPath: path.join(ROOT, name + '.mp4'), segments: [{ path: path.join(ROOT, 'a.mp4') }, { path: path.join(ROOT, 'b.mp4'), start: 5, end: 9 }], outputBytes: null, outputDuration: null,
    });
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];

    it('stores the job list on every change and writes interrupted jobs as waiting', async () => {
        const saved: MediaJob[][] = [];
        let release!: () => void;
        const queue = new MediaJobQueue(request => new Promise((resolve) => { release = () => resolve({ outputPath: request.outputPath, duration: 2, bytes: 3 }); }), { persist: jobs => saved.push(jobs) });
        const created = queue.enqueue({ name: 'eins.mp4', outputPath: path.join(ROOT, 'eins.mp4'), segments: [{ path: path.join(ROOT, 'a.mp4') }, { path: path.join(ROOT, 'b.mp4') }] });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(queue.get(created.id)!.status).toBe('running');
        expect(saved.at(-1)![0]).toMatchObject({ status: 'queued', progress: 0, startedAt: null });
        release();
        while (queue.busy) await queue.waitForChange(20);
        expect(saved.at(-1)![0]).toMatchObject({ status: 'completed', outputBytes: 3 });
    });

    it('continues waiting jobs after a restart and refuses jobs outside the download folder', async () => {
        const stored = parseMediaJobs(JSON.parse(JSON.stringify({ version: 1, jobs: [job(ids[0], 'running', 'unterbrochen'), job(ids[1], 'completed', 'fertig'), job(ids[2], 'queued', 'fremd'), { id: 'kaputt' }, { ...job(ids[0], 'queued', 'doppelt') }] })));
        expect(stored.map(entry => [entry.name, entry.status, entry.progress])).toEqual([['unterbrochen', 'queued', 0], ['fertig', 'completed', 50], ['fremd', 'queued', 0]]);
        const ran: string[] = [];
        const queue = new MediaJobQueue(async (request) => { ran.push(request.name); return { outputPath: request.outputPath, duration: 1, bytes: 1 }; });
        expect(queue.restore(stored, entry => entry.name !== 'fremd')).toBe(1);
        while (queue.busy) await queue.waitForChange(20);
        expect(ran).toEqual(['unterbrochen']);
        expect(queue.list().map(entry => [entry.name, entry.status])).toEqual([['unterbrochen', 'completed'], ['fertig', 'completed'], ['fremd', 'failed']]);
        expect(queue.get(ids[2])!.error).toContain('no longer inside the download folder');
        expect(queue.restore(stored)).toBe(0);
        expect(queue.list()).toHaveLength(3);
    });

    it('ignores files in an unknown format', () => {
        expect(parseMediaJobs(null)).toEqual([]);
        expect(parseMediaJobs({ version: 2, jobs: [] })).toEqual([]);
        expect(parseMediaJobs({ version: 1, jobs: [{ ...job(ids[0], 'queued', 'x'), outputPath: 'relativ.mp4' }, { ...job(ids[1], 'queued', 'y'), segments: [] }] })).toEqual([]);
    });
});
