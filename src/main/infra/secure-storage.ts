// Production secrets use Electron safeStorage and the operating-system keystore.
// MemorySecureStorage is an unencrypted unit-test fake; GUI tests use the
// explicitly isolated, ephemeral AES-GCM provider below.

import { createIsolatedTestSecureStorage } from './test-secure-storage';

let backend: 'native' | 'isolated-test' = 'native';
let blockedNativeCalls = 0;

export function getSecureStorageDiagnostics(): { backend: string; blockedNativeCalls: number } {
    return { backend, blockedNativeCalls };
}

export interface SecureStorage {
    isEncryptionAvailable(): boolean;
    encrypt(plaintext: string): string;
    decrypt(ciphertext: string): string;
}

export class MemorySecureStorage implements SecureStorage {
    isEncryptionAvailable(): boolean {
        return false;
    }
    encrypt(plaintext: string): string {
        // Base64 als Kennzeichnung — kein Schutz, nur damit `decrypt(encrypt(x)) === x`
        // semantisch konsistent ist (kein literal plaintext zwischen den Methoden).
        return Buffer.from(plaintext, 'utf-8').toString('base64');
    }
    decrypt(ciphertext: string): string {
        return Buffer.from(ciphertext, 'base64').toString('utf-8');
    }
}

interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(buf: Buffer): string;
}

export function wrapNativeSecureStorage(safeStorage: SafeStorageLike): SecureStorage {
    return {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString('base64'),
        decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext, 'base64')),
    };
}

/**
 * Wrappt electron.safeStorage. Setzt voraus, dass `app.whenReady()` gefired ist.
 * Wird per Lazy-Require konstruiert, sodass Module ausserhalb von Electron
 * (zB Tests) das Modul importieren koennen ohne Crash.
 */
export function createElectronSecureStorage(): SecureStorage {
    if (!process.versions.electron) throw new Error('Electron safeStorage is only available inside Electron');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    const testStorage = createIsolatedTestSecureStorage(process.env, electron.app.getPath('userData'));
    if (testStorage) {
        backend = 'isolated-test';
        // Catch future accidental bypasses too. No native encryption API may
        // cause a password dialog in an isolated test, even on an error path.
        for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString', 'isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
            if (typeof electron.safeStorage[method] === 'function') {
                electron.safeStorage[method] = () => {
                    blockedNativeCalls += 1;
                    throw new Error('Native Keychain access is forbidden in isolated tests');
                };
            }
        }
        return testStorage;
    }
    const safeStorage = electron?.safeStorage as SafeStorageLike | undefined;
    if (!safeStorage) {
        throw new Error('Electron safeStorage not available (called before app.whenReady?)');
    }

    return wrapNativeSecureStorage(safeStorage);
}
