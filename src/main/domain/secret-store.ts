import type { DbHandle } from '../infra/db';
import type { SecureStorage } from '../infra/secure-storage';

export type AppSecretKey = 'twitch_client_secret' | 'discord_webhook_url' | 'mcp_access_token';

export interface SecretStatus {
    encryptionAvailable: boolean;
    clientSecretConfigured: boolean;
    discordWebhookConfigured: boolean;
}

export interface SecretStore {
    get(key: AppSecretKey): string | null;
    set(key: AppSecretKey, value: string): void;
    clear(key: AppSecretKey): void;
    status(): SecretStatus;
}

const SECRET_VERSION = 1;

export function createSecretStore(db: DbHandle, storage: SecureStorage): SecretStore {
    return {
        get(key) {
            const row = db.get<{ version: number; encrypted_value: string }>(
                'SELECT version, encrypted_value FROM app_secrets WHERE key = ?',
                [key]
            );
            if (!row) return null;
            if (row.version !== SECRET_VERSION) {
                throw new Error(`Unsupported secret record version: ${row.version}`);
            }
            return storage.decrypt(row.encrypted_value);
        },
        set(key, value) {
            if (!value) throw new Error('Secret value must not be empty');
            db.run(
                `INSERT INTO app_secrets(key, version, encrypted_value, updated_at)
                 VALUES (?, ?, ?, strftime('%s','now'))
                 ON CONFLICT(key) DO UPDATE SET
                    version = excluded.version,
                    encrypted_value = excluded.encrypted_value,
                    updated_at = excluded.updated_at`,
                [key, SECRET_VERSION, storage.encrypt(value)]
            );
        },
        clear(key) {
            db.run('DELETE FROM app_secrets WHERE key = ?', [key]);
        },
        status() {
            const keys = new Set(db.all<{ key: AppSecretKey }>('SELECT key FROM app_secrets').map((row) => row.key));
            return {
                encryptionAvailable: storage.isEncryptionAvailable(),
                clientSecretConfigured: keys.has('twitch_client_secret'),
                discordWebhookConfigured: keys.has('discord_webhook_url'),
            };
        },
    };
}
