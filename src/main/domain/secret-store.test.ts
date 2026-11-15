import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type DbHandle } from '../infra/db';
import { MemorySecureStorage } from '../infra/secure-storage';
import { createSecretStore } from './secret-store';

let directory: string;
let db: DbHandle;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-secrets-'));
    db = openDatabase(path.join(directory, 'app.db'));
});

afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('createSecretStore', () => {
    it('stores versioned ciphertext and exposes only configured status', () => {
        const store = createSecretStore(db, new MemorySecureStorage());
        store.set('twitch_client_secret', 'client-secret-value');
        store.set('discord_webhook_url', 'https://discord.com/api/webhooks/value');

        expect(store.get('twitch_client_secret')).toBe('client-secret-value');
        expect(store.status()).toEqual({
            encryptionAvailable: false,
            clientSecretConfigured: true,
            discordWebhookConfigured: true,
        });
        const rows = db.all<{ key: string; version: number; encrypted_value: string }>('SELECT key, version, encrypted_value FROM app_secrets ORDER BY key');
        expect(rows.map((row) => row.version)).toEqual([1, 1]);
        expect(JSON.stringify(rows)).not.toContain('client-secret-value');
        expect(JSON.stringify(rows)).not.toContain('/webhooks/value');
    });

    it('clears one secret without changing the other', () => {
        const store = createSecretStore(db, new MemorySecureStorage());
        store.set('twitch_client_secret', 'client');
        store.set('discord_webhook_url', 'webhook');
        store.clear('twitch_client_secret');

        expect(store.get('twitch_client_secret')).toBeNull();
        expect(store.get('discord_webhook_url')).toBe('webhook');
    });
});
