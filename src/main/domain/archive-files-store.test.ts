import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, type DbHandle } from '../infra/db';
import { createArchiveFilesStore, type ArchiveFilesStore } from './archive-files-store';

let tmpDir: string;
let db: DbHandle;
let store: ArchiveFilesStore;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
    db = openDatabase(path.join(tmpDir, 'app.db'));
    store = createArchiveFilesStore(db);
});
afterEach(() => {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('createArchiveFilesStore', () => {
    test('upsert + get roundtrip', () => {
        const rec = store.upsert({
            path: 'C:/vods/foo/2026-05-11.mp4',
            streamerLogin: 'Foo',
            sizeBytes: 1024 * 1024 * 100,
            durationSeconds: 3600,
            createdAt: 1700000000,
            verified: true,
        });
        expect(rec.path).toBe('C:/vods/foo/2026-05-11.mp4');
        expect(rec.streamerLogin).toBe('foo');
        expect(rec.sizeBytes).toBe(1024 * 1024 * 100);
        expect(rec.verified).toBe(true);

        const fetched = store.get('C:/vods/foo/2026-05-11.mp4');
        expect(fetched?.streamerLogin).toBe('foo');
    });

    test('upsert same path updates instead of duplicating', () => {
        store.upsert({ path: '/x', streamerLogin: 'a', sizeBytes: 100 });
        store.upsert({ path: '/x', streamerLogin: 'a', sizeBytes: 200 });
        const list = store.list();
        expect(list).toHaveLength(1);
        expect(list[0].sizeBytes).toBe(200);
    });

    test('list returns all, ordered by created_at DESC NULLS LAST', () => {
        store.upsert({ path: '/older', streamerLogin: 'a', createdAt: 1000 });
        store.upsert({ path: '/newer', streamerLogin: 'a', createdAt: 2000 });
        store.upsert({ path: '/no-date', streamerLogin: 'a' });
        const list = store.list();
        expect(list.map(r => r.path)).toEqual(['/newer', '/older', '/no-date']);
    });

    test('list(streamerLogin) filters and normalizes', () => {
        store.upsert({ path: '/a1', streamerLogin: 'alice' });
        store.upsert({ path: '/a2', streamerLogin: 'Alice' }); // normalized to alice
        store.upsert({ path: '/b1', streamerLogin: 'bob' });
        const aliceFiles = store.list('@Alice');
        expect(aliceFiles).toHaveLength(2);
    });

    test('setVerified toggles the flag', () => {
        store.upsert({ path: '/v', verified: false });
        store.setVerified('/v', true);
        expect(store.get('/v')?.verified).toBe(true);
        store.setVerified('/v', false);
        expect(store.get('/v')?.verified).toBe(false);
    });

    test('delete removes the record', () => {
        store.upsert({ path: '/d', streamerLogin: 'x' });
        store.delete('/d');
        expect(store.get('/d')).toBeNull();
    });

    test('summaryByStreamer aggregates counts and total bytes', () => {
        store.upsert({ path: '/a1', streamerLogin: 'alice', sizeBytes: 100 });
        store.upsert({ path: '/a2', streamerLogin: 'alice', sizeBytes: 200 });
        store.upsert({ path: '/b1', streamerLogin: 'bob', sizeBytes: 50 });
        store.upsert({ path: '/orphan', sizeBytes: 999 }); // no streamer — excluded

        const summary = store.summaryByStreamer();
        // Sorted by total DESC: alice (300), bob (50)
        expect(summary).toHaveLength(2);
        expect(summary[0]).toEqual({ streamerLogin: 'alice', fileCount: 2, totalBytes: 300 });
        expect(summary[1]).toEqual({ streamerLogin: 'bob', fileCount: 1, totalBytes: 50 });
    });

    test('totalBytes sums across everything', () => {
        store.upsert({ path: '/1', sizeBytes: 100 });
        store.upsert({ path: '/2', sizeBytes: 200 });
        store.upsert({ path: '/3', sizeBytes: 300, streamerLogin: 'a' });
        store.upsert({ path: '/4' }); // null bytes — coalesced to 0
        expect(store.totalBytes()).toBe(600);
    });

    test('get returns null for missing path', () => {
        expect(store.get('/nope')).toBeNull();
    });

    test('totalBytes on empty table = 0', () => {
        expect(store.totalBytes()).toBe(0);
    });
});
