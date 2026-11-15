import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, type DbHandle } from '../infra/db';
import { MemorySecureStorage } from '../infra/secure-storage';
import { createTokenStore, type TokenStore } from './token-store';

let tmpDir: string;
let db: DbHandle;
let store: TokenStore;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-'));
    db = openDatabase(path.join(tmpDir, 'app.db'));
    store = createTokenStore(db, new MemorySecureStorage());
});
afterEach(() => {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('createTokenStore', () => {
    test('upsert new account returns record with id > 0', () => {
        const rec = store.upsert({
            provider: 'twitch',
            twitchUserId: 'u1',
            login: 'alice',
            accessToken: 'aaa.aaa.aaa',
        });
        expect(rec.id).toBeGreaterThan(0);
        expect(rec.login).toBe('alice');
        expect(rec.provider).toBe('twitch');
        expect(rec.twitchUserId).toBe('u1');
    });

    test('upsert same (provider, twitch_user_id) updates, no duplicate row', () => {
        store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'alice', accessToken: 't1' });
        const updated = store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'alice2', accessToken: 't2' });
        expect(updated.login).toBe('alice2');
        const all = store.list('twitch');
        expect(all).toHaveLength(1);
        expect(all[0].login).toBe('alice2');
    });

    test('list() returns all accounts, list(provider) filters', () => {
        store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'a', accessToken: 'x' });
        store.upsert({ provider: 'twitch', twitchUserId: 'u2', login: 'b', accessToken: 'y' });
        store.upsert({ provider: 'youtube', twitchUserId: undefined, login: 'c', accessToken: 'z' });
        expect(store.list()).toHaveLength(3);
        expect(store.list('twitch')).toHaveLength(2);
        expect(store.list('youtube')).toHaveLength(1);
    });

    test('getDefault returns null when nothing default', () => {
        store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'a', accessToken: 'x' });
        expect(store.getDefault('twitch')).toBeNull();
    });

    test('upsert with isDefault=true makes it default, demotes siblings', () => {
        const a = store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'a', accessToken: 'x', isDefault: true });
        const b = store.upsert({ provider: 'twitch', twitchUserId: 'u2', login: 'b', accessToken: 'y', isDefault: true });

        const def = store.getDefault('twitch');
        expect(def?.id).toBe(b.id);

        const aAgain = store.list('twitch').find(r => r.id === a.id);
        expect(aAgain?.isDefault).toBe(false);
    });

    test('setDefault toggles is_default exclusivity within provider', () => {
        const a = store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'a', accessToken: 'x', isDefault: true });
        const b = store.upsert({ provider: 'twitch', twitchUserId: 'u2', login: 'b', accessToken: 'y' });

        store.setDefault(b.id);
        expect(store.getDefault('twitch')?.id).toBe(b.id);

        const aAgain = store.list('twitch').find(r => r.id === a.id);
        expect(aAgain?.isDefault).toBe(false);
    });

    test('getAccessToken returns decrypted plaintext', () => {
        const rec = store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'a', accessToken: 'super-secret-token' });
        expect(store.getAccessToken(rec.id)).toBe('super-secret-token');
    });

    test('getRefreshToken returns null if not provided, value if provided', () => {
        const noRefresh = store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'a', accessToken: 't1' });
        expect(store.getRefreshToken(noRefresh.id)).toBeNull();

        const withRefresh = store.upsert({
            provider: 'twitch', twitchUserId: 'u2', login: 'b',
            accessToken: 't2', refreshToken: 'refresh-xyz',
        });
        expect(store.getRefreshToken(withRefresh.id)).toBe('refresh-xyz');
    });

    test('scopes roundtrip as array', () => {
        const rec = store.upsert({
            provider: 'twitch', twitchUserId: 'u1', login: 'a',
            accessToken: 't', scopes: ['user:read:email', 'channel:read:subscriptions'],
        });
        expect(rec.scopes).toEqual(['user:read:email', 'channel:read:subscriptions']);
    });

    test('delete removes the record', () => {
        const rec = store.upsert({ provider: 'twitch', twitchUserId: 'u1', login: 'a', accessToken: 'x' });
        store.delete(rec.id);
        expect(store.list('twitch')).toHaveLength(0);
        expect(() => store.getAccessToken(rec.id)).toThrow();
    });

    test('expiresAt roundtrip', () => {
        const future = Math.floor(Date.now() / 1000) + 3600;
        const rec = store.upsert({
            provider: 'twitch', twitchUserId: 'u1', login: 'a',
            accessToken: 't', expiresAt: future,
        });
        expect(rec.expiresAt).toBe(future);
    });
});
