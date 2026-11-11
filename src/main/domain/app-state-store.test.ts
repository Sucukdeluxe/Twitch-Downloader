import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type DbHandle } from '../infra/db';
import { createAppStateStore } from './app-state-store';

let directory: string;
let databasePath: string;
let db: DbHandle;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-state-'));
    databasePath = path.join(directory, 'app.db');
    db = openDatabase(databasePath);
});

afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('createAppStateStore', () => {
    it('recovers configuration from SQLite after restart without secret fields', () => {
        const store = createAppStateStore(db);
        store.saveConfig({
            language: 'de',
            client_id: 'client-id',
            client_secret: 'plain-client-secret',
            discord_webhook_url: 'https://discord.com/api/webhooks/plain',
            downloaded_vod_ids: ['v2', 'v1'],
            auto_record_streamers: ['Alice'],
            auto_vod_download_streamers: ['Bob'],
        });

        db.close();
        db = openDatabase(databasePath);
        const recovered = createAppStateStore(db).loadConfig();

        expect(recovered).toMatchObject({
            language: 'de',
            client_id: 'client-id',
            downloaded_vod_ids: ['v2', 'v1'],
            auto_record_streamers: ['alice'],
            auto_vod_download_streamers: ['bob'],
        });
        expect(recovered).not.toHaveProperty('client_secret');
        expect(recovered).not.toHaveProperty('discord_webhook_url');
        const persisted = JSON.stringify(db.all('SELECT key, value FROM config_kv'));
        expect(persisted).not.toContain('plain-client-secret');
        expect(persisted).not.toContain('/webhooks/plain');
    });

    it('persists queue snapshots atomically and preserves order across restart', () => {
        const first = { id: 'q2', status: 'pending', title: 'second', streamer: 'Beta' };
        const second = { id: 'q1', status: 'completed', title: 'first', streamer: 'Alpha' };
        createAppStateStore(db).saveQueue([first, second]);

        db.close();
        db = openDatabase(databasePath);

        expect(createAppStateStore(db).loadQueue()).toEqual([first, second]);
        expect(db.all<{ id: string; queue_position: number }>('SELECT id, queue_position FROM queue_items ORDER BY queue_position')).toEqual([
            { id: 'q2', queue_position: 0 },
            { id: 'q1', queue_position: 1 },
        ]);
    });
});
