import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase, type DbHandle } from '../infra/db';
import { createAppStateStore } from './app-state-store';
import { createDownloadHistoryStore, downloadOutputBytes, emptyLifetimeDownloadStats } from './download-history-store';

let directory: string;
let db: DbHandle;
let databasePath: string;
beforeEach(() => {
    const root = path.resolve('tmp_statistics-tests');
    fs.mkdirSync(root, { recursive: true });
    directory = fs.mkdtempSync(path.join(root, 'history-'));
    databasePath = path.join(directory, 'app.db');
    db = openDatabase(databasePath);
});
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
function vod(id: string, extra: object = {}) {
    return { id, url: 'https://www.twitch.tv/videos/1234', status: 'completed', completedAt: '2026-10-09T12:00:00.000Z', completionRecorded: true, ...extra };
}
describe('persistent download history', () => {
    it('starts empty and provides an explicit unavailable state', () => {
        expect(emptyLifetimeDownloadStats()).toMatchObject({ available: false, totalDownloads: 0 });
        expect(createDownloadHistoryStore(db).summarize()).toMatchObject({ available: true, totalDownloads: 0, completedJobs: 0 });
    });
    it('counts one VOD across many parts and excludes sidecar data', () => {
        const files = ['one.mp4', 'two.mp4', 'one.chat.json', 'one.events.jsonl'].map(name => path.join(directory, name));
        files.forEach(file => fs.writeFileSync(file, Buffer.alloc(128)));
        const store = createDownloadHistoryStore(db);
        expect(store.recordQueueItem(vod('parts', { outputFiles: files }))).toBe(true);
        expect(store.summarize()).toMatchObject({ vodDownloads: 1, completedJobs: 1, outputFiles: 2, totalBytes: 256 });
    });
    it('keeps counters after files, queue and downloaded flags are deleted and the database reopens', () => {
        const file = path.join(directory, 'output.mp4'); fs.writeFileSync(file, Buffer.alloc(256));
        const state = createAppStateStore(db);
        state.saveQueue([vod('persist', { outputFiles: [file], outputBytes: 256 })]);
        state.saveConfig({ downloaded_vod_ids: ['1234'] });
        fs.unlinkSync(file); state.saveQueue([]); state.saveConfig({ downloaded_vod_ids: [] });
        db.close(); db = openDatabase(databasePath);
        expect(createDownloadHistoryStore(db).summarize()).toMatchObject({ vodDownloads: 1, totalBytes: 256, outputFiles: 1 });
    });
    it('does not count retry, pause, failure or repeated completion of a job', () => {
        const store = createDownloadHistoryStore(db);
        for (const status of ['pending', 'downloading', 'paused', 'error']) expect(store.recordQueueItem(vod('retry', { status }))).toBe(false);
        for (let i = 0; i < 100; i++) store.recordQueueItem(vod('retry'));
        expect(store.summarize()).toMatchObject({ vodDownloads: 1 });
    });
    it('counts an intentional new download of the same VOD', () => {
        const store = createDownloadHistoryStore(db); store.recordQueueItem(vod('a')); store.recordQueueItem(vod('b'));
        expect(store.summarize()).toMatchObject({ vodDownloads: 2, completedJobs: 2 });
    });
    it('counts merged VOD sources once without counting intermediate output', () => {
        const store = createDownloadHistoryStore(db);
        store.recordQueueItem(vod('merge', { mergeGroup: { items: [{ url: 'https://www.twitch.tv/videos/1' }, { url: 'https://www.twitch.tv/videos/2' }, { url: 'https://www.twitch.tv/videos/1' }], downloadedFiles: { 0: 'temp1.mp4', 1: 'temp2.mp4' } }, outputFiles: ['final.mp4'], outputBytes: 500 }));
        expect(store.summarize()).toMatchObject({ vodDownloads: 2, completedJobs: 1, outputFiles: 1, totalBytes: 500 });
    });
    it('tracks live sessions independently from VODs and counts resumed parts as one session', () => {
        const store = createDownloadHistoryStore(db);
        store.recordQueueItem(vod('live', { isLive: true, url: 'https://twitch.tv/streamer', outputFiles: ['part1.mp4', 'part2.mp4'] }));
        expect(store.summarize()).toMatchObject({ liveRecordings: 1, vodDownloads: 0, outputFiles: 2 });
    });
    it('counts independent successful clip attempts and deduplicates callbacks', () => {
        const store = createDownloadHistoryStore(db); const file = path.join(directory, 'clip.mp4'); fs.writeFileSync(file, Buffer.alloc(100));
        for (const attemptId of ['a', 'a', 'b']) store.recordClip({ attemptId, clipId: 'ExampleClip', filename: file });
        expect(store.summarize()).toMatchObject({ clipDownloads: 2, totalBytes: 200, completedJobs: 2 });
    });
    it('does not fabricate history from manual marks, archive files or incomplete queue entries', () => {
        createAppStateStore(db).saveConfig({ downloaded_vod_ids: ['1234', '5678'] });
        fs.writeFileSync(path.join(directory, 'untracked.mp4'), Buffer.alloc(100));
        createAppStateStore(db).saveQueue([vod('error', { status: 'error' }), vod('pending', { status: 'pending' })]);
        const store = createDownloadHistoryStore(db); expect(store.recoverCompletedQueue()).toBe(0); expect(store.summarize().totalDownloads).toBe(0);
    });
    it('recovers legacy completed queue entries once without inventing their completion date', () => {
        const item = vod('1791532800000', { completedAt: undefined, completionRecorded: undefined, outputFiles: ['deleted.mp4'] });
        db.run('INSERT INTO queue_items(id, status, created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)', ['1791532800000', 'completed', 0, 0, JSON.stringify(item)]);
        const store = createDownloadHistoryStore(db); expect(store.recoverCompletedQueue()).toBe(1); expect(store.recoverCompletedQueue()).toBe(0);
        expect(store.summarize(new Date('2026-10-09T12:00:00Z'))).toMatchObject({ vodDownloads: 1, recoveredDownloads: 1, unknownDateDownloads: 1, outputFiles: 1, totalBytes: 0 });
        expect(store.summarize().dailyActivity.reduce((sum, day) => sum + day.count, 0)).toBe(0);
    });
    it('ignores corrupt legacy payloads without losing valid records', () => {
        db.run('INSERT INTO queue_items(id, status, created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)', ['bad', 'completed', 0, 0, '{']);
        createAppStateStore(db).saveConfig({ language: 'de' });
        const store = createDownloadHistoryStore(db); expect(store.recoverCompletedQueue()).toBe(0); store.recordQueueItem(vod('ok')); expect(store.summarize().vodDownloads).toBe(1);
    });
    it('rolls completion history back together with a failed queue snapshot', () => {
        const state = createAppStateStore(db);
        expect(() => state.saveQueue([vod('rollback'), { status: 'pending' }])).toThrow();
        expect(createDownloadHistoryStore(db).summarize().totalDownloads).toBe(0);
        expect(state.loadQueue()).toHaveLength(0);
    });
    it('uses local calendar dates and keeps exactly thirty days including DST changes', () => {
        const store = createDownloadHistoryStore(db);
        const now = new Date(2026, 9, 27, 12);
        for (let day = 0; day < 40; day++) { const time = new Date(now); time.setDate(time.getDate() - day); time.setHours(0, 5); store.recordQueueItem(vod('day-' + day, { completedAt: time.toISOString() })); }
        const stats = store.summarize(now); expect(stats.dailyActivity).toHaveLength(30);
        expect(new Set(stats.dailyActivity.map(day => day.date)).size).toBe(30);
        expect(stats.dailyActivity.every(day => day.count === 1)).toBe(true);
        expect(stats.dailyActivity.at(-1)?.date).toBe('2026-10-27');
    });
    it('retains the tracking start when the schema is reopened', () => {
        const start = createDownloadHistoryStore(db).summarize().trackedSince; db.close(); db = openDatabase(databasePath);
        expect(createDownloadHistoryStore(db).summarize().trackedSince).toBe(start);
    });
    it('rejects invalid sources and tolerates missing files', () => {
        const store = createDownloadHistoryStore(db);
        for (const url of ['', 'broken', 'https://evil.test/videos/123', 'https://twitch.tv/abc']) expect(store.recordQueueItem(vod('invalid-' + url, { url }))).toBe(false);
        expect(downloadOutputBytes(['missing.mp4'])).toBe(0);
    });
    it('counts a five-part edited VOD with multiple omitted ranges only once', () => {
        const store = createDownloadHistoryStore(db);
        const item = vod('omissions', { customClip: { startSec: 0, durationSec: 22000, startPart: 1, filenameFormat: 'parts', omissions: { partDurationSec: 3600, ranges: [{ start: 100, end: 2200 }, { start: 7000, end: 9000 }], selection: { start: 0, end: 20000 } } }, outputFiles: Array.from({ length: 5 }, (_, i) => 'Part' + (i + 1) + '.mp4'), outputBytes: 500 });
        store.recordQueueItem(item); createAppStateStore(db).saveQueue([item]);
        expect(store.summarize()).toMatchObject({ vodDownloads: 1, completedJobs: 1, outputFiles: 5, totalBytes: 500 });
    });
    it('does not backfill an invalid queue identity that startup will replace', () => {
        const item = vod('invalid-history-id');
        db.run('INSERT INTO queue_items(id, status, created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)', [item.id, 'completed', 0, 0, JSON.stringify(item)]);
        expect(createDownloadHistoryStore(db).recoverCompletedQueue()).toBe(0);
    });
    it('handles ten thousand history records and repeated snapshots without duplicate counts', () => {
        const store = createDownloadHistoryStore(db);
        db.transaction(() => { for (let i = 0; i < 10000; i++) store.recordQueueItem(vod('stress-' + i, { outputBytes: 1024 })); });
        const state = createAppStateStore(db); const items = Array.from({ length: 200 }, (_, index) => vod('stress-' + index));
        for (let i = 0; i < 20; i++) state.saveQueue(items);
        expect(store.summarize()).toMatchObject({ vodDownloads: 10000, completedJobs: 10000, totalBytes: 10240000 });
    });
});

it('updates only matching history paths after recordings move and keeps totals', async () => {
    const store = createDownloadHistoryStore(db);
    const source = path.join(directory, 'old.mp4'), destination = path.join(directory, 'new.mp4');
    fs.writeFileSync(source, 'video');
    store.recordQueueItem(vod('move', { outputFiles: [source] }));
    store.recordQueueItem(vod('other', { outputFiles: [path.join(directory, 'other.mp4')] }));
    const before = store.summarize();
    fs.renameSync(source, destination);
    store.relocatePaths([{ source, destination }]);
    const result = await store.search();
    expect(JSON.stringify(result)).toContain(destination.replace(/\\/g, '\\\\'));
    expect(JSON.stringify(result)).not.toContain(source.replace(/\\/g, '\\\\'));
    expect(store.summarize()).toEqual(before);
});
