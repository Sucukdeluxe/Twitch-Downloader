import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIsolatedTestSecureStorage } from './test-secure-storage';
import { wrapNativeSecureStorage } from './secure-storage';

let root: string;
let userData: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-vod-manager-encryption-'));
    userData = path.join(root, 'userdata');
    const data = path.join(root, 'data');
    fs.mkdirSync(userData);
    fs.mkdirSync(data);
    env = { TVM_E2E_ROOT: root, TVM_E2E_ID: crypto.randomUUID(), TVM_E2E_SECRET_KEY: crypto.randomBytes(32).toString('hex'), TWITCH_VOD_MANAGER_DATA_DIR: data };
    fs.writeFileSync(path.join(root, '.tvm-e2e'), env.TVM_E2E_ID!);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('isolated test encryption', () => {
    it('does not select a test provider without explicit test configuration', () => {
        expect(createIsolatedTestSecureStorage({}, userData)).toBeNull();
    });
    it('encrypts with random IVs and reads persisted data after an app restart', () => {
        const first = createIsolatedTestSecureStorage(env, userData)!;
        const ciphertext = first.encrypt('synthetic-test-data');
        expect(ciphertext).not.toContain('synthetic-test-data');
        expect(first.encrypt('synthetic-test-data') === ciphertext).toBe(false);
        const restarted = createIsolatedTestSecureStorage(env, userData)!;
        expect(restarted.decrypt(ciphertext)).toBe('synthetic-test-data');
    });
    it('rejects modified ciphertext and a different test environment key', () => {
        const store = createIsolatedTestSecureStorage(env, userData)!;
        const ciphertext = store.encrypt('synthetic-test-data');
        const bytes = Buffer.from(ciphertext.slice(7), 'base64');
        bytes[bytes.length - 1] ^= 1;
        expect(() => store.decrypt(`e2e-v1:${bytes.toString('base64')}`)).toThrow();
        const other = createIsolatedTestSecureStorage({ ...env, TVM_E2E_SECRET_KEY: crypto.randomBytes(32).toString('hex') }, userData)!;
        expect(() => other.decrypt(ciphertext)).toThrow();
    });
    it('fails closed for partial test flags and an incorrect marker', () => {
        expect(() => createIsolatedTestSecureStorage({ TVM_E2E_ROOT: root }, userData)).toThrow();
        fs.writeFileSync(path.join(root, '.tvm-e2e'), 'incorrect marker');
        expect(() => createIsolatedTestSecureStorage(env, userData)).toThrow();
    });
    it('refuses application or user data outside the isolated temporary root', () => {
        expect(() => createIsolatedTestSecureStorage({ ...env, TWITCH_VOD_MANAGER_DATA_DIR: os.tmpdir() }, userData)).toThrow();
        expect(() => createIsolatedTestSecureStorage(env, os.tmpdir())).toThrow();
    });
    it('never treats native ciphertext as test ciphertext', () => {
        expect(() => createIsolatedTestSecureStorage(env, userData)!.decrypt('not-a-test-ciphertext')).toThrow();
    });
});

describe('production encryption adapter', () => {
    it('delegates to native storage and propagates denial without plaintext fallback', () => {
        const native = {
            isEncryptionAvailable: vi.fn(() => false),
            encryptString: vi.fn(() => { throw new Error('Keychain access denied'); }),
            decryptString: vi.fn(() => { throw new Error('Keychain access denied'); }),
        };
        const storage = wrapNativeSecureStorage(native);
        expect(storage.isEncryptionAvailable()).toBe(false);
        expect(() => storage.encrypt('synthetic-test-data')).toThrow('Keychain access denied');
        expect(() => storage.decrypt('YQ==')).toThrow('Keychain access denied');
        expect(native.encryptString).toHaveBeenCalledOnce();
        expect(native.decryptString).toHaveBeenCalledOnce();
    });
});
