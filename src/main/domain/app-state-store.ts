import type { DbHandle } from '../infra/db';
import { normalizeLogin } from './config-normalize';
import { sanitizeConfigInput } from './config-input';
import { createDownloadHistoryStore } from './download-history-store';

export interface AppStateStore {
    loadConfig(): Record<string, unknown>;
    saveConfig<T extends object>(config: T): void;
    loadQueue<T extends object = Record<string, unknown>>(): T[];
    saveQueue<T extends object>(queue: T[]): void;
}

function normalizeConfig(config: object): Record<string, unknown> {
    return sanitizeConfigInput(config);
}

function replaceConfig(db: DbHandle, normalized: Record<string, unknown>): void {
    db.transaction(() => {
        db.run('DELETE FROM config_kv');
        for (const [key, value] of Object.entries(normalized)) {
            db.run(
                `INSERT INTO config_kv(key, value, updated_at)
                 VALUES (?, ?, strftime('%s','now'))`,
                [key, JSON.stringify(value)]
            );
        }
        db.run('DELETE FROM downloaded_vods');
        for (const vodId of (normalized.downloaded_vod_ids as string[] | undefined) ?? []) {
            db.run('INSERT INTO downloaded_vods(vod_id) VALUES (?)', [vodId]);
        }
        db.run('DELETE FROM streamers');
        for (const login of (normalized.auto_record_streamers as string[] | undefined) ?? []) {
            db.run('INSERT INTO streamers(login, auto_record) VALUES (?, 1)', [login]);
        }
        for (const login of (normalized.auto_vod_download_streamers as string[] | undefined) ?? []) {
            db.run(
                `INSERT INTO streamers(login, auto_vod_download) VALUES (?, 1)
                 ON CONFLICT(login) DO UPDATE SET auto_vod_download = 1`,
                [login]
            );
        }
    });
}

export function createAppStateStore(db: DbHandle): AppStateStore {
    const downloadHistory = createDownloadHistoryStore(db);
    return {
        loadConfig() {
            const stored = Object.fromEntries(
                db.all<{ key: string; value: string }>('SELECT key, value FROM config_kv')
                    .map((row) => [row.key, JSON.parse(row.value)])
            );
            const normalized = normalizeConfig(stored);
            if (JSON.stringify(stored) !== JSON.stringify(normalized)) replaceConfig(db, normalized);
            return normalized;
        },
        saveConfig(config) {
            const normalized = normalizeConfig(config);
            replaceConfig(db, normalized);
        },
        loadQueue<T extends object>() {
            return db.all<{ payload_json: string }>(
                'SELECT payload_json FROM queue_items ORDER BY queue_position, created_at, id'
            ).map((row) => JSON.parse(row.payload_json) as T);
        },
        saveQueue<T extends object>(queue: T[]) {
            const now = Math.floor(Date.now() / 1000);
            db.transaction(() => {
                db.run('DELETE FROM queue_items');
                queue.forEach((rawItem, index) => {
                    const item = rawItem as Record<string, unknown>;
                    const id = typeof item.id === 'string' && item.id ? item.id : null;
                    if (!id) throw new Error('Queue item id must not be empty');
                    downloadHistory.recordQueueItem(item);
                    db.run(
                        `INSERT OR REPLACE INTO queue_items
                         (id, queue_position, streamer_login, vod_id, clip_id, title, output_path, status,
                          progress_pct, error_message, created_at, updated_at, completed_at, payload_json)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            id,
                            index,
                            typeof item.streamer === 'string' ? normalizeLogin(item.streamer) : null,
                            typeof item.vod_id === 'string' ? item.vod_id : null,
                            typeof item.clip_id === 'string' ? item.clip_id : null,
                            typeof item.title === 'string' ? item.title : null,
                            typeof item.output_path === 'string' ? item.output_path : null,
                            typeof item.status === 'string' ? item.status : 'pending',
                            typeof item.progress_pct === 'number' ? item.progress_pct : null,
                            typeof item.error_message === 'string' ? item.error_message : null,
                            typeof item.created_at === 'number' ? item.created_at : now,
                            typeof item.updated_at === 'number' ? item.updated_at : now,
                            typeof item.completed_at === 'number' ? item.completed_at : null,
                            JSON.stringify(item),
                        ]
                    );
                });
            });
        },
    };
}
