import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type DbHandle } from '../infra/db';
import { createAppStateStore } from './app-state-store';
import { commitQueueMutation, persistStateChange } from './persistence-commit';

let directory: string;
let db: DbHandle;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-commit-'));
    db = openDatabase(path.join(directory, 'app.db'));
});

afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('persistStateChange', () => {
    it('keeps runtime configuration at the persisted value when a SQLite write fails', () => {
        const previous = { language: 'de' };
        const next = { language: 'en' };
        createAppStateStore(db).saveConfig(previous);
        const failingDb: DbHandle = {
            ...db,
            run(sql, params) {
                if (sql.includes('INSERT INTO config_kv')) throw new Error('SQLITE_IOERR config');
                db.run(sql, params);
            },
        };
        let runtime = previous;

        expect(() => {
            runtime = persistStateChange(runtime, () => next, (candidate) => createAppStateStore(failingDb).saveConfig(candidate));
        }).toThrow('SQLITE_IOERR config');
        expect(runtime).toEqual(previous);
        expect(createAppStateStore(db).loadConfig()).toMatchObject(previous);
    });

    it('keeps runtime queue at the persisted snapshot when a SQLite write fails', () => {
        const previous = [{ id: 'q1', status: 'pending' }];
        const next = [{ id: 'q2', status: 'pending' }];
        createAppStateStore(db).saveQueue(previous);
        const failingDb: DbHandle = {
            ...db,
            run(sql, params) {
                if (sql.includes('INSERT OR REPLACE INTO queue_items')) throw new Error('SQLITE_IOERR queue');
                db.run(sql, params);
            },
        };
        let runtime = previous;

        expect(() => {
            runtime = persistStateChange(runtime, () => next, (candidate) => createAppStateStore(failingDb).saveQueue(candidate));
        }).toThrow('SQLITE_IOERR queue');
        expect(runtime).toEqual(previous);
        expect(createAppStateStore(db).loadQueue()).toEqual(previous);
    });

    it('does not cancel a process or delete a file when queue removal cannot persist', async () => {
        const previous = [{ id: 'q1', status: 'pending' }];
        const temporaryFile = path.join(directory, 'q1.partial');
        fs.writeFileSync(temporaryFile, 'keep');
        createAppStateStore(db).saveQueue(previous);
        const failingDb: DbHandle = {
            ...db,
            run(sql, params) {
                if (sql.includes('DELETE FROM queue_items')) throw new Error('SQLITE_IOERR remove');
                db.run(sql, params);
            },
        };
        const cancelProcess = vi.fn();
        let runtime = previous;

        await expect(commitQueueMutation(
            runtime,
            () => [],
            (candidate) => createAppStateStore(failingDb).saveQueue(candidate),
            (candidate) => { runtime = candidate; },
            async () => {
                cancelProcess('q1');
                fs.rmSync(temporaryFile);
            },
        )).rejects.toThrow('SQLITE_IOERR remove');

        expect(cancelProcess).not.toHaveBeenCalled();
        expect(fs.existsSync(temporaryFile)).toBe(true);
        expect(runtime).toEqual(previous);
        expect(createAppStateStore(db).loadQueue()).toEqual(previous);
    });

    it('does not pause a process when a paused queue snapshot cannot persist', async () => {
        const previous = [{ id: 'q1', status: 'downloading' }];
        const paused = [{ id: 'q1', status: 'paused' }];
        createAppStateStore(db).saveQueue(previous);
        const failingDb: DbHandle = {
            ...db,
            run(sql, params) {
                if (sql.includes('DELETE FROM queue_items')) throw new Error('SQLITE_IOERR pause');
                db.run(sql, params);
            },
        };
        const pauseProcess = vi.fn();
        let runtime = previous;

        await expect(commitQueueMutation(
            runtime,
            () => paused,
            (candidate) => createAppStateStore(failingDb).saveQueue(candidate),
            (candidate) => { runtime = candidate; },
            async () => { pauseProcess('q1'); },
        )).rejects.toThrow('SQLITE_IOERR pause');

        expect(pauseProcess).not.toHaveBeenCalled();
        expect(runtime).toEqual(previous);
        expect(createAppStateStore(db).loadQueue()).toEqual(previous);
    });
});
