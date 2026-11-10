// Verschluesselt String-Payloads im OS-Keystore (Win Credential Manager via
// Electron safeStorage). MemorySecureStorage ist fuer Tests/Headless-Envs —
// gibt plaintext zurueck und meldet isEncryptionAvailable() === false, damit
// Caller das in den Log schreiben oder verweigern koennen.

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

/**
 * Wrappt electron.safeStorage. Setzt voraus, dass `app.whenReady()` gefired ist.
 * Wird per Lazy-Require konstruiert, sodass Module ausserhalb von Electron
 * (zB Tests) das Modul importieren koennen ohne Crash.
 */
export function createElectronSecureStorage(): SecureStorage {
    if (!process.versions.electron) throw new Error('Electron safeStorage is only available inside Electron');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    const safeStorage = electron?.safeStorage as SafeStorageLike | undefined;
    if (!safeStorage) {
        throw new Error('Electron safeStorage not available (called before app.whenReady?)');
    }

    return {
        isEncryptionAvailable(): boolean {
            return safeStorage.isEncryptionAvailable();
        },
        encrypt(plaintext: string): string {
            const buf = safeStorage.encryptString(plaintext);
            return buf.toString('base64');
        },
        decrypt(ciphertext: string): string {
            const buf = Buffer.from(ciphertext, 'base64');
            return safeStorage.decryptString(buf);
        },
    };
}
