import Database, { type Database as DatabaseT } from 'better-sqlite3';
import { SCHEMA_V5_SQL } from './schema-v5';
import { DOWNLOAD_HISTORY_SCHEMA_SQL } from './download-history-schema';

/**
 * Public DB-Handle. Schmaler Wrapper um better-sqlite3.
 */
export interface DbHandle {
    run(sql: string, params?: unknown[]): void;
    get<T = unknown>(sql: string, params?: unknown[]): T | undefined;
    all<T = unknown>(sql: string, params?: unknown[]): T[];
    transaction<R>(fn: () => R): R;
    runBatch(sql: string): void;
    close(): void;
    readonly raw: DatabaseT;
}

function splitStatements(sql: string): string[] {
    return sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

function runMultiStatement(db: DatabaseT, sql: string): void {
    for (const stmt of splitStatements(sql)) {
        db.prepare(stmt).run();
    }
}

export function openDatabase(filePath: string): DbHandle {
    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    runMultiStatement(db, SCHEMA_V5_SQL);
    db.transaction(() => runMultiStatement(db, DOWNLOAD_HISTORY_SCHEMA_SQL))();
    const queueColumns = db.prepare('PRAGMA table_info(queue_items)').all() as Array<{ name: string }>;
    if (!queueColumns.some((column) => column.name === 'queue_position')) {
        db.prepare('ALTER TABLE queue_items ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0').run();
    }

    const handle: DbHandle = {
        run(sql, params) {
            db.prepare(sql).run(...(params ?? []) as unknown[]);
        },
        get<T>(sql: string, params?: unknown[]): T | undefined {
            return db.prepare(sql).get(...(params ?? []) as unknown[]) as T | undefined;
        },
        all<T>(sql: string, params?: unknown[]): T[] {
            return db.prepare(sql).all(...(params ?? []) as unknown[]) as T[];
        },
        transaction<R>(fn: () => R): R {
            return db.transaction(fn)();
        },
        runBatch(sql) {
            runMultiStatement(db, sql);
        },
        close() {
            db.close();
        },
        get raw() { return db; },
    };
    return handle;
}
