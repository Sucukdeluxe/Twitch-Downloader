import { afterEach, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SCHEMA_V5_SQL } from '../infra/schema-v5';
import { openDatabase, type DbHandle } from '../infra/db';
import { createAppStateStore } from './app-state-store';
import { compareMacVersions } from './mac-update-manifest';

let directory: string | undefined;
let current: DbHandle | undefined;
afterEach(() => {
    current?.close();
    current = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
});

test('the 1.1.20 upgrade preserves a pre-history Mac database through two launches', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-version-upgrade-'));
    const filename = path.join(directory, 'app.db');
    // 1.0.10 used this schema, before download_history was introduced.
    const legacy = new Database(filename);
    legacy.exec(SCHEMA_V5_SQL);
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'download_history'").get()).toBeUndefined();
    const config = {
        language: 'de', theme: 'twitch', streamers: ['alice'],
        download_path: '/Volumes/Media/Twitch Downloads',
        downloaded_vod_ids: ['12345'], auto_record_streamers: ['alice'],
        auto_vod_download_streamers: [], persist_queue_on_restart: true,
    };
    for (const [key, value] of Object.entries(config)) {
        legacy.prepare('INSERT INTO config_kv(key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    }
    const queued = {
        id: 'persisted-job', status: 'pending', url: 'https://www.twitch.tv/videos/12345',
        title: 'My selected VOD', streamer: 'alice', customClip: { startTime: 12.5, endTime: 25.75 },
    };
    legacy.prepare('INSERT INTO queue_items(id, queue_position, status, created_at, updated_at, payload_json) VALUES (?, 0, ?, 1, 1, ?)')
        .run(queued.id, queued.status, JSON.stringify(queued));
    legacy.prepare('INSERT INTO app_secrets(key, version, encrypted_value) VALUES (?, 1, ?)')
        .run('twitch_client_secret', 'existing-keychain-ciphertext');
    legacy.prepare('INSERT INTO downloaded_vods(vod_id) VALUES (?)').run('12345');
    legacy.close();

    for (let launch = 0; launch < 2; launch += 1) {
        current = openDatabase(filename);
        const state = createAppStateStore(current);
        expect(state.loadConfig()).toEqual(config);
        expect(state.loadQueue()).toEqual([queued]);
        expect(current.get('SELECT version, encrypted_value FROM app_secrets WHERE key = ?', ['twitch_client_secret']))
            .toEqual({ version: 1, encrypted_value: 'existing-keychain-ciphertext' });
        expect(current.all('SELECT vod_id FROM downloaded_vods')).toEqual([{ vod_id: '12345' }]);
        expect(current.get("SELECT name FROM sqlite_master WHERE name = 'download_history'")).toEqual({ name: 'download_history' });
        state.saveQueue(state.loadQueue());
        current.close();
        current = undefined;
    }
});

test('the published Mac bootstrap sees 1.1.20 as an upgrade and cannot downgrade back', () => {
    expect(compareMacVersions('1.1.20', '1.0.10')).toBe(1);
    expect(compareMacVersions('1.0.10', '1.1.20')).toBe(-1);
    expect(compareMacVersions('1.1.20', '1.1.20')).toBe(0);
});
