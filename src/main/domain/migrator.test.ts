import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, type DbHandle } from '../infra/db';
import { migrateJsonToSqlite } from './migrator';
import { MemorySecureStorage } from '../infra/secure-storage';
import { createSecretStore } from './secret-store';

let tmpDir: string;
let appDataDir: string;
let db: DbHandle;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-'));
    appDataDir = path.join(tmpDir, 'appdata');
    fs.mkdirSync(appDataDir, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'app.db'));
});
afterEach(() => {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeJson(name: string, payload: unknown): string {
    const target = path.join(appDataDir, name);
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf-8');
    return target;
}

describe('migrateJsonToSqlite', () => {
    test('no JSON files: writes migrations_applied marker', () => {
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.configMigrated).toBe(false);
        expect(result.queueMigrated).toBe(false);
        expect(result.downloadedVodsCount).toBe(0);
        expect(result.streamersCount).toBe(0);

        const marker = db.get<{ name: string }>('SELECT name FROM migrations_applied WHERE name = ?', ['authoritative-state-v1']);
        expect(marker?.name).toBe('authoritative-state-v1');
    });

    test('migrates config.json keys into config_kv', () => {
        writeJson('config.json', {
            language: 'de',
            performance_mode: 'speed',
            metadata_cache_minutes: 30,
            downloaded_vod_ids: ['1', '2', '3'],
            auto_record_streamers: ['foo', 'bar'],
        });
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.configMigrated).toBe(true);

        const lang = db.get<{ value: string }>('SELECT value FROM config_kv WHERE key = ?', ['language']);
        expect(JSON.parse(lang!.value)).toBe('de');

        const perf = db.get<{ value: string }>('SELECT value FROM config_kv WHERE key = ?', ['performance_mode']);
        expect(JSON.parse(perf!.value)).toBe('speed');
    });

    test('migrates downloaded_vod_ids', () => {
        writeJson('config.json', { downloaded_vod_ids: ['100', '200', '300'] });
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.downloadedVodsCount).toBe(3);
        const rows = db.all<{ vod_id: string }>('SELECT vod_id FROM downloaded_vods ORDER BY vod_id');
        expect(rows.map(r => r.vod_id)).toEqual(['100', '200', '300']);
    });

    test('migrates streamers from both auto-record and auto-vod-download lists', () => {
        writeJson('config.json', {
            auto_record_streamers: ['Alice', '@bob'],
            auto_vod_download_streamers: ['bob', 'carol'],
        });
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.streamersCount).toBeGreaterThanOrEqual(3);

        const alice = db.get<{ login: string; auto_record: number }>('SELECT login, auto_record FROM streamers WHERE login = ?', ['alice']);
        expect(alice?.auto_record).toBe(1);

        const bob = db.get<{ login: string; auto_record: number; auto_vod_download: number }>('SELECT login, auto_record, auto_vod_download FROM streamers WHERE login = ?', ['bob']);
        expect(bob?.auto_record).toBe(1);
        expect(bob?.auto_vod_download).toBe(1);

        const carol = db.get<{ login: string; auto_vod_download: number }>('SELECT login, auto_vod_download FROM streamers WHERE login = ?', ['carol']);
        expect(carol?.auto_vod_download).toBe(1);
    });

    test('migrates download_queue.json items', () => {
        writeJson('download_queue.json', [
            { id: 'q1', status: 'pending', streamer: 'foo', vod_id: 'v1', created_at: 1000, updated_at: 1000 },
            { id: 'q2', status: 'completed', streamer: 'bar', vod_id: 'v2', created_at: 2000, updated_at: 3000, completed_at: 3000 },
        ]);
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.queueMigrated).toBe(true);

        const all = db.all<{ id: string; status: string }>('SELECT id, status FROM queue_items ORDER BY id');
        expect(all).toHaveLength(2);
        expect(all[0].status).toBe('pending');
        expect(all[1].status).toBe('completed');
    });

    test('idempotent second run', () => {
        writeJson('config.json', { downloaded_vod_ids: ['1', '2'] });
        migrateJsonToSqlite({ db, appDataDir });
        const result2 = migrateJsonToSqlite({ db, appDataDir });
        expect(result2.alreadyApplied).toBe(true);
        const count = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM downloaded_vods');
        expect(count?.c).toBe(2);
    });

    test('writes .v4-backup of source JSONs', () => {
        const configPath = writeJson('config.json', { language: 'en' });
        migrateJsonToSqlite({ db, appDataDir });
        expect(fs.existsSync(configPath + '.v4-backup')).toBe(true);
        expect(fs.readFileSync(configPath + '.v4-backup', 'utf-8')).toContain('"language": "en"');
    });

    test('malformed JSON is logged + skipped', () => {
        fs.writeFileSync(path.join(appDataDir, 'config.json'), '{ not valid json', 'utf-8');
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.configMigrated).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].source).toBe('config.json');
        expect(db.get('SELECT name FROM migrations_applied WHERE name = ?', ['authoritative-state-v1'])).toBeUndefined();
    });

    test('rolls back all records and marker when migration is interrupted', () => {
        writeJson('config.json', { language: 'de', metadata_cache_minutes: 30 });
        writeJson('download_queue.json', [{ id: 'q1', status: 'pending', title: 'Queue item' }]);
        let queueInsertReached = false;
        const interruptedDb: DbHandle = {
            ...db,
            run(sql, params) {
                if (sql.includes('INSERT OR REPLACE INTO queue_items')) {
                    queueInsertReached = true;
                    throw new Error('simulated interruption');
                }
                db.run(sql, params);
            },
        };

        const result = migrateJsonToSqlite({ db: interruptedDb, appDataDir });

        expect(queueInsertReached).toBe(true);
        expect(result.errors).toEqual([{ source: 'migration', message: 'simulated interruption' }]);
        expect(db.all('SELECT * FROM config_kv')).toEqual([]);
        expect(db.all('SELECT * FROM queue_items')).toEqual([]);
        expect(db.get('SELECT name FROM migrations_applied WHERE name = ?', ['authoritative-state-v1'])).toBeUndefined();
    });

    test('rolls back config queue and secrets when the migration marker cannot be written', () => {
        const configPath = writeJson('config.json', { language: 'de', client_secret: 'must-survive' });
        writeJson('download_queue.json', [{ id: 'q1', status: 'pending' }]);
        const interruptedDb: DbHandle = {
            ...db,
            run(sql, params) {
                if (sql.includes('INSERT INTO migrations_applied')) throw new Error('marker unavailable');
                db.run(sql, params);
            },
        };
        const secrets = createSecretStore(interruptedDb, new MemorySecureStorage());

        const result = migrateJsonToSqlite({ db: interruptedDb, appDataDir, secrets });

        expect(result.errors).toEqual([{ source: 'migration', message: 'marker unavailable' }]);
        expect(db.all('SELECT * FROM config_kv')).toEqual([]);
        expect(db.all('SELECT * FROM queue_items')).toEqual([]);
        expect(db.all('SELECT * FROM app_secrets')).toEqual([]);
        expect(db.get('SELECT name FROM migrations_applied WHERE name = ?', ['authoritative-state-v1'])).toBeUndefined();
        expect(fs.readFileSync(configPath, 'utf-8')).toContain('must-survive');
    });

    test('imports legacy JSON once and ignores later JSON changes after restart', () => {
        const configPath = writeJson('config.json', { language: 'de' });
        migrateJsonToSqlite({ db, appDataDir });
        fs.writeFileSync(configPath, JSON.stringify({ language: 'en' }), 'utf-8');

        const second = migrateJsonToSqlite({ db, appDataDir });
        const language = db.get<{ value: string }>('SELECT value FROM config_kv WHERE key = ?', ['language']);

        expect(second.alreadyApplied).toBe(true);
        expect(JSON.parse(language!.value)).toBe('de');
    });

    test('keeps SQLite config queue and secrets authoritative after a corrupted legacy config restart', () => {
        const configPath = writeJson('config.json', { language: 'de', client_secret: 'persisted-secret' });
        writeJson('download_queue.json', [{ id: 'q1', status: 'pending', title: 'Persisted queue item' }]);
        let secrets = createSecretStore(db, new MemorySecureStorage());

        migrateJsonToSqlite({ db, appDataDir, secrets });
        db.close();
        db = openDatabase(path.join(tmpDir, 'app.db'));
        secrets = createSecretStore(db, new MemorySecureStorage());
        fs.writeFileSync(configPath, '{ no longer valid JSON', 'utf-8');

        const restart = migrateJsonToSqlite({ db, appDataDir, secrets });

        expect(restart).toMatchObject({ alreadyApplied: true, errors: [] });
        expect(JSON.parse(db.get<{ value: string }>('SELECT value FROM config_kv WHERE key = ?', ['language'])!.value)).toBe('de');
        expect(db.all<{ id: string }>('SELECT id FROM queue_items ORDER BY queue_position')).toEqual([{ id: 'q1' }]);
        expect(secrets.get('twitch_client_secret')).toBe('persisted-secret');
    });

    test.each([
        ['null', null],
        ['false', false],
        ['zero', 0],
        ['empty string', ''],
    ])('does not mark or partially migrate a syntactically valid but invalid %s config', (_, invalidConfig) => {
        writeJson('config.json', invalidConfig);
        writeJson('download_queue.json', [{ id: 'q1', status: 'pending' }]);

        const result = migrateJsonToSqlite({ db, appDataDir });

        expect(result.errors).toEqual([{ source: 'config.json', message: 'Config JSON must be an object' }]);
        expect(db.all('SELECT * FROM config_kv')).toEqual([]);
        expect(db.all('SELECT * FROM queue_items')).toEqual([]);
        expect(db.get('SELECT name FROM migrations_applied WHERE name = ?', ['authoritative-state-v1'])).toBeUndefined();
    });

    test('does not let the former shadow-migration marker skip authoritative secret import', () => {
        const configPath = writeJson('config.json', { language: 'de', client_secret: 'legacy-secret' });
        db.run('INSERT INTO migrations_applied(name, payload) VALUES (?, ?)', ['v4-to-v5-jsons', '{}']);
        const secrets = createSecretStore(db, new MemorySecureStorage());

        const result = migrateJsonToSqlite({ db, appDataDir, secrets });

        expect(result.alreadyApplied).toBe(false);
        expect(result.errors).toEqual([]);
        expect(secrets.get('twitch_client_secret')).toBe('legacy-secret');
        expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('legacy-secret');
    });

    test('migrates plaintext secrets into encrypted versioned records and scrubs JSON', () => {
        const configPath = writeJson('config.json', {
            client_secret: 'legacy-client-secret',
            discord_webhook_url: 'https://discord.com/api/webhooks/legacy',
            language: 'de',
        });
        const secrets = createSecretStore(db, new MemorySecureStorage());

        const result = migrateJsonToSqlite({ db, appDataDir, secrets });

        expect(result.errors).toEqual([]);
        expect(secrets.get('twitch_client_secret')).toBe('legacy-client-secret');
        expect(secrets.get('discord_webhook_url')).toBe('https://discord.com/api/webhooks/legacy');
        expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('legacy-client-secret');
        expect(fs.readFileSync(configPath + '.v4-backup', 'utf-8')).not.toContain('/webhooks/legacy');
        expect(db.get('SELECT key FROM config_kv WHERE key = ?', ['discord_webhook_url'])).toBeUndefined();
    });

    test('keeps plaintext legacy secrets untouched when production encryption is unavailable', () => {
        const configPath = writeJson('config.json', { client_secret: 'must-survive', language: 'de' });
        const secrets = createSecretStore(db, new MemorySecureStorage());

        const result = migrateJsonToSqlite({ db, appDataDir, secrets, requireEncryption: true });

        expect(result.errors).toEqual([{ source: 'migration', message: 'OS secret encryption is unavailable' }]);
        expect(fs.readFileSync(configPath, 'utf-8')).toContain('must-survive');
        expect(secrets.get('twitch_client_secret')).toBeNull();
        expect(db.get('SELECT name FROM migrations_applied WHERE name = ?', ['authoritative-state-v1'])).toBeUndefined();
    });

    test('keeps plaintext legacy secrets when the sanitized backup cannot be published', () => {
        const configPath = writeJson('config.json', { client_secret: 'must-survive', language: 'de' });
        fs.mkdirSync(`${configPath}.v4-backup`);
        const secrets = createSecretStore(db, new MemorySecureStorage());

        const result = migrateJsonToSqlite({ db, appDataDir, secrets });

        expect(result.errors).toHaveLength(1);
        expect(fs.readFileSync(configPath, 'utf-8')).toContain('must-survive');
        expect(result.configMigrated).toBe(true);
        expect(result.errors[0].source).toBe('legacy-config-scrub');
        expect(db.get<{ value: string }>('SELECT value FROM config_kv WHERE key = ?', ['language'])?.value).toBe('"de"');
        expect(secrets.get('twitch_client_secret')).toBe('must-survive');
        expect(db.get('SELECT name FROM migrations_applied WHERE name = ?', ['authoritative-state-v1'])).toBeDefined();
        // Database commit must survive a later filesystem error; retry only scrubs the legacy file.
        fs.rmdirSync(`${configPath}.v4-backup`);
        const retried = migrateJsonToSqlite({ db, appDataDir, secrets });
        expect(retried).toMatchObject({ alreadyApplied: true, errors: [] });
        expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('must-survive');
        expect(secrets.get('twitch_client_secret')).toBe('must-survive');
    });
});
