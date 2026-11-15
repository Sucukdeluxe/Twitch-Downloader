import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, type DbHandle } from '../infra/db';
import { createChunkIndexStore, type ChunkIndexStore } from './chunk-index-store';

let tmpDir: string;
let db: DbHandle;
let store: ChunkIndexStore;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunkstore-'));
    db = openDatabase(path.join(tmpDir, 'app.db'));
    store = createChunkIndexStore(db);
});
afterEach(() => {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('createChunkIndexStore', () => {
    test('record returns ChunkRecord with id > 0', () => {
        const rec = store.record('item-1', 0, 'sha1-abc', 1024);
        expect(rec.id).toBeGreaterThan(0);
        expect(rec.itemId).toBe('item-1');
        expect(rec.chunkSeq).toBe(0);
        expect(rec.sha1Hex).toBe('sha1-abc');
        expect(rec.bytes).toBe(1024);
    });

    test('listForItem returns chunks ordered by chunk_seq', () => {
        store.record('it', 2, 's2', 200);
        store.record('it', 0, 's0', 100);
        store.record('it', 1, 's1', 150);
        const all = store.listForItem('it');
        expect(all.map(r => r.chunkSeq)).toEqual([0, 1, 2]);
        expect(all.map(r => r.sha1Hex)).toEqual(['s0', 's1', 's2']);
    });

    test('UNIQUE(item_id, chunk_seq): same key updates, no duplicate', () => {
        store.record('it', 0, 'first', 100);
        store.record('it', 0, 'second', 200);
        const list = store.listForItem('it');
        expect(list).toHaveLength(1);
        expect(list[0].sha1Hex).toBe('second');
        expect(list[0].bytes).toBe(200);
    });

    test('countForItem', () => {
        expect(store.countForItem('it')).toBe(0);
        store.record('it', 0, 'a', 1);
        store.record('it', 1, 'b', 1);
        expect(store.countForItem('it')).toBe(2);
        expect(store.countForItem('other')).toBe(0);
    });

    test('lookupBySha1 finds dedupe candidates', () => {
        store.record('item-A', 0, 'same-sha', 100);
        store.record('item-B', 5, 'same-sha', 100);
        store.record('item-C', 0, 'other-sha', 100);

        const hits = store.lookupBySha1('same-sha');
        expect(hits).toHaveLength(2);
        expect(hits.map(r => r.itemId).sort()).toEqual(['item-A', 'item-B']);
    });

    test('deleteForItem removes all chunks for that item and returns count', () => {
        store.record('it', 0, 'a', 1);
        store.record('it', 1, 'b', 1);
        store.record('keep', 0, 'c', 1);

        const removed = store.deleteForItem('it');
        expect(removed).toBe(2);
        expect(store.countForItem('it')).toBe(0);
        expect(store.countForItem('keep')).toBe(1);
    });

    test('deleteForItem on missing returns 0, doesnt throw', () => {
        expect(store.deleteForItem('does-not-exist')).toBe(0);
    });

    test('bytes roundtrip', () => {
        const rec = store.record('it', 0, 'sha', 1234567);
        expect(rec.bytes).toBe(1234567);
        const list = store.listForItem('it');
        expect(list[0].bytes).toBe(1234567);
    });
});
