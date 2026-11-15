import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, type DbHandle } from './db';

let tmpDir: string;
let db: DbHandle | null = null;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
});
afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('openDatabase', () => {
    test('creates a new file', () => {
        const target = path.join(tmpDir, 'a.db');
        db = openDatabase(target);
        expect(fs.existsSync(target)).toBe(true);
        expect(typeof db.run).toBe('function');
        expect(typeof db.get).toBe('function');
        expect(typeof db.all).toBe('function');
        expect(typeof db.close).toBe('function');
        expect(typeof db.transaction).toBe('function');
        expect(typeof db.runBatch).toBe('function');
    });

    test('schema_meta row exists with schema_version=5', () => {
        db = openDatabase(path.join(tmpDir, 'b.db'));
        const row = db.get<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', ['schema_version']);
        expect(row?.value).toBe('5');
    });

    test('WAL mode active', () => {
        db = openDatabase(path.join(tmpDir, 'c.db'));
        const row = db.get<{ journal_mode: string }>('PRAGMA journal_mode');
        expect(row?.journal_mode).toBe('wal');
    });

    test('idempotent open: existing file keeps schema_version=5', () => {
        const target = path.join(tmpDir, 'd.db');
        db = openDatabase(target);
        db.close();
        db = openDatabase(target);
        const row = db.get<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', ['schema_version']);
        expect(row?.value).toBe('5');
    });

    test('run + get + all roundtrip on downloaded_vods', () => {
        db = openDatabase(path.join(tmpDir, 'e.db'));
        db.run('INSERT INTO downloaded_vods(vod_id) VALUES (?)', ['1234']);
        db.run('INSERT INTO downloaded_vods(vod_id) VALUES (?)', ['5678']);
        const one = db.get<{ vod_id: string }>('SELECT vod_id FROM downloaded_vods WHERE vod_id = ?', ['1234']);
        expect(one?.vod_id).toBe('1234');
        const all = db.all<{ vod_id: string }>('SELECT vod_id FROM downloaded_vods ORDER BY vod_id');
        expect(all.map(r => r.vod_id)).toEqual(['1234', '5678']);
    });

    test('transaction commits as bracket', () => {
        db = openDatabase(path.join(tmpDir, 'f.db'));
        const handle = db;
        const inserted = handle.transaction(() => {
            handle.run('INSERT INTO downloaded_vods(vod_id) VALUES (?)', ['t1']);
            handle.run('INSERT INTO downloaded_vods(vod_id) VALUES (?)', ['t2']);
            return 2;
        });
        expect(inserted).toBe(2);
        const c = handle.get<{ c: number }>('SELECT COUNT(*) AS c FROM downloaded_vods');
        expect(c?.c).toBe(2);
    });

    test('chunk_index table accepts insert + UNIQUE(item_id, chunk_seq)', () => {
        db = openDatabase(path.join(tmpDir, 'chunk.db'));
        db.run(
            'INSERT INTO chunk_index(item_id, chunk_seq, sha1_hex, bytes) VALUES (?, ?, ?, ?)',
            ['item1', 0, 'abc123', 1024]
        );
        const handle = db;
        expect(() => {
            handle.run(
                'INSERT INTO chunk_index(item_id, chunk_seq, sha1_hex, bytes) VALUES (?, ?, ?, ?)',
                ['item1', 0, 'different', 2048]
            );
        }).toThrow(); // UNIQUE violation
        const rows = handle.all<{ sha1_hex: string }>('SELECT sha1_hex FROM chunk_index WHERE item_id = ?', ['item1']);
        expect(rows).toHaveLength(1);
        expect(rows[0].sha1_hex).toBe('abc123');
    });

    test('oauth_accounts table exists and accepts insert', () => {
        db = openDatabase(path.join(tmpDir, 'oauth.db'));
        db.run(
            `INSERT INTO oauth_accounts(provider, twitch_user_id, login, encrypted_access_token)
             VALUES (?, ?, ?, ?)`,
            ['twitch', 'user-123', 'alice', 'ciphertext-blob']
        );
        const row = db.get<{ login: string; provider: string }>(
            'SELECT login, provider FROM oauth_accounts WHERE twitch_user_id = ?',
            ['user-123']
        );
        expect(row?.login).toBe('alice');
        expect(row?.provider).toBe('twitch');
    });

    test('oauth_accounts UNIQUE(provider, twitch_user_id) enforced', () => {
        db = openDatabase(path.join(tmpDir, 'oauth-unique.db'));
        db.run(
            `INSERT INTO oauth_accounts(provider, twitch_user_id, login, encrypted_access_token)
             VALUES (?, ?, ?, ?)`,
            ['twitch', 'u1', 'a', 'x']
        );
        const handle = db;
        expect(() => {
            handle.run(
                `INSERT INTO oauth_accounts(provider, twitch_user_id, login, encrypted_access_token)
                 VALUES (?, ?, ?, ?)`,
                ['twitch', 'u1', 'b', 'y']
            );
        }).toThrow();
    });

    test('transaction rolls back on throw', () => {
        db = openDatabase(path.join(tmpDir, 'g.db'));
        const handle = db;
        expect(() => {
            handle.transaction(() => {
                handle.run('INSERT INTO downloaded_vods(vod_id) VALUES (?)', ['x1']);
                throw new Error('boom');
            });
        }).toThrow('boom');
        const c = handle.get<{ c: number }>('SELECT COUNT(*) AS c FROM downloaded_vods');
        expect(c?.c).toBe(0);
    });
});
