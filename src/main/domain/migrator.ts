import * as fs from 'fs';
import * as path from 'path';
import type { DbHandle } from '../infra/db';
import { createAppStateStore } from './app-state-store';
import { isSecretBearingKey } from './config-export';
import type { SecretStore } from './secret-store';

export interface MigratorOptions {
    db: DbHandle;
    appDataDir: string;
    secrets?: SecretStore;
    requireEncryption?: boolean;
}

export interface MigrationError {
    source: string;
    message: string;
}

export interface MigrationResult {
    alreadyApplied: boolean;
    configMigrated: boolean;
    queueMigrated: boolean;
    downloadedVodsCount: number;
    streamersCount: number;
    errors: MigrationError[];
}

const MIGRATION_NAME = 'authoritative-state-v1';
function normalizeSecretKey(key: string): string {
    return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function findLegacySecret(config: Record<string, unknown>, canonicalKey: string): string | null {
    const canonicalValue = config[canonicalKey];
    if (typeof canonicalValue === 'string' && canonicalValue) return canonicalValue;
    const normalizedKey = normalizeSecretKey(canonicalKey);
    for (const [key, value] of Object.entries(config)) {
        if (normalizeSecretKey(key) === normalizedKey && typeof value === 'string' && value) return value;
    }
    return null;
}

function readJson<T>(filePath: string, source: string, errors: MigrationError[]): T | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch (error) {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) });
        return undefined;
    }
}

function withoutSecrets(config: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(config).filter(([key]) => !isSecretBearingKey(key)));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, filePath);
}

function backupJson(filePath: string, value: unknown): void {
    const backupPath = `${filePath}.v4-backup`;
    if (!fs.existsSync(backupPath)) writeJsonAtomic(backupPath, value);
}

function scrubConfigFiles(configPath: string, config: Record<string, unknown>): void {
    const sanitized = withoutSecrets(config);
    writeJsonAtomic(`${configPath}.v4-backup`, sanitized);
    writeJsonAtomic(configPath, sanitized);
}

function scrubExistingConfig(configPath: string): void {
    for (const candidate of [configPath, `${configPath}.v4-backup`]) {
        if (!fs.existsSync(candidate)) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        } catch {
            fs.rmSync(candidate, { force: true });
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fs.rmSync(candidate, { force: true });
            continue;
        }
        const config = parsed as Record<string, unknown>;
        const sanitized = withoutSecrets(config);
        if (JSON.stringify(config) !== JSON.stringify(sanitized)) writeJsonAtomic(candidate, sanitized);
    }
}

function emptyResult(alreadyApplied: boolean, errors: MigrationError[] = []): MigrationResult {
    return {
        alreadyApplied,
        configMigrated: false,
        queueMigrated: false,
        downloadedVodsCount: 0,
        streamersCount: 0,
        errors,
    };
}

export function migrateJsonToSqlite(opts: MigratorOptions): MigrationResult {
    const { db, appDataDir, secrets, requireEncryption = false } = opts;
    const configPath = path.join(appDataDir, 'config.json');
    const queuePath = path.join(appDataDir, 'download_queue.json');
    const existing = db.get<{ name: string }>('SELECT name FROM migrations_applied WHERE name = ?', [MIGRATION_NAME]);
    if (existing) {
        try {
            scrubExistingConfig(configPath);
        } catch (error) {
            return emptyResult(true, [{ source: 'legacy-config-scrub', message: error instanceof Error ? error.message : String(error) }]);
        }
        return emptyResult(true);
    }

    const errors: MigrationError[] = [];
    const configExists = fs.existsSync(configPath);
    const queueExists = fs.existsSync(queuePath);
    const config = readJson<Record<string, unknown>>(configPath, 'config.json', errors);
    const queue = readJson<unknown>(queuePath, 'download_queue.json', errors);
    if (queueExists && !Array.isArray(queue)) {
        errors.push({ source: 'download_queue.json', message: 'Queue JSON must be an array' });
    }
    if (errors.length > 0) return emptyResult(false, errors);
    if (configExists && (!config || typeof config !== 'object' || Array.isArray(config))) {
        return emptyResult(false, [{ source: 'config.json', message: 'Config JSON must be an object' }]);
    }
    const clientSecret = config ? findLegacySecret(config, 'client_secret') : null;
    const webhookUrl = config ? findLegacySecret(config, 'discord_webhook_url') : null;
    if ((clientSecret || webhookUrl) && !secrets) {
        return emptyResult(false, [{ source: 'migration', message: 'Secure secret storage is required for plaintext secret migration' }]);
    }
    if ((clientSecret || webhookUrl) && requireEncryption && !secrets?.status().encryptionAvailable) {
        return emptyResult(false, [{ source: 'migration', message: 'OS secret encryption is unavailable' }]);
    }

    const state = createAppStateStore(db);
    let downloadedVodsCount = 0;
    let streamersCount = 0;
    try {
        db.transaction(() => {
            if (configExists && config) {
                state.saveConfig(config);
                downloadedVodsCount = Array.isArray(config.downloaded_vod_ids)
                    ? config.downloaded_vod_ids.filter((value) => typeof value === 'string' && value).length
                    : 0;
                if (clientSecret) secrets!.set('twitch_client_secret', clientSecret);
                if (webhookUrl) secrets!.set('discord_webhook_url', webhookUrl);
            }
            if (queueExists) state.saveQueue(queue as Array<Record<string, unknown>>);
            streamersCount = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM streamers')?.count ?? 0;
            db.run(
                'INSERT INTO migrations_applied(name, payload) VALUES (?, ?)',
                [MIGRATION_NAME, JSON.stringify({ configMigrated: configExists, queueMigrated: queueExists, downloadedVodsCount, streamersCount })]
            );
            if (queueExists) backupJson(queuePath, queue);
        });
    } catch (error) {
        return emptyResult(false, [{ source: 'migration', message: error instanceof Error ? error.message : String(error) }]);
    }

    if (configExists && config) {
        try {
            scrubConfigFiles(configPath, config);
        } catch (error) {
            return {
                alreadyApplied: false,
                configMigrated: true,
                queueMigrated: queueExists,
                downloadedVodsCount,
                streamersCount,
                errors: [{ source: 'legacy-config-scrub', message: error instanceof Error ? error.message : String(error) }],
            };
        }
    }

    return {
        alreadyApplied: false,
        configMigrated: configExists,
        queueMigrated: queueExists,
        downloadedVodsCount,
        streamersCount,
        errors: [],
    };
}
