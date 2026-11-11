import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecureStorage } from './secure-storage';

function inside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Explicit E2E-only provider. The random key lives in the test parent process,
 * never on disk. Invalid test configuration fails closed, never to the Keychain.
 * Both app-data locations must be inside a marked, private temporary test root.
 */
export function createIsolatedTestSecureStorage(env: NodeJS.ProcessEnv, userDataDirectory: string): SecureStorage | null {
    const fields = [env.TVM_E2E_SECRET_KEY, env.TVM_E2E_ROOT, env.TVM_E2E_ID];
    if (fields.every((value) => value === undefined)) return null;
    if (!env.TVM_E2E_SECRET_KEY || !/^[a-f0-9]{64}$/.test(env.TVM_E2E_SECRET_KEY)
        || !env.TVM_E2E_ROOT || !path.isAbsolute(env.TVM_E2E_ROOT)
        || !env.TVM_E2E_ID || !/^[a-f0-9-]{36}$/.test(env.TVM_E2E_ID)
        || !env.TWITCH_VOD_MANAGER_DATA_DIR || !path.isAbsolute(env.TWITCH_VOD_MANAGER_DATA_DIR)) {
        throw new Error('Invalid isolated test encryption configuration');
    }
    const root = fs.realpathSync(env.TVM_E2E_ROOT);
    const data = fs.realpathSync(env.TWITCH_VOD_MANAGER_DATA_DIR);
    const userData = fs.realpathSync(userDataDirectory);
    if (!inside(fs.realpathSync(os.tmpdir()), root)
        || !path.basename(root).startsWith('twitch-vod-manager-')
        || !inside(root, data) || !inside(root, userData)
        || fs.readFileSync(path.join(root, '.tvm-e2e'), 'utf8') !== env.TVM_E2E_ID) {
        throw new Error('Test encryption refuses non-isolated application data');
    }
    const key = Buffer.from(env.TVM_E2E_SECRET_KEY, 'hex');
    return {
        isEncryptionAvailable: () => true,
        encrypt(plaintext) {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
            return `e2e-v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
        },
        decrypt(ciphertext) {
            if (!ciphertext.startsWith('e2e-v1:')) throw new Error('Invalid isolated test ciphertext');
            const value = Buffer.from(ciphertext.slice(7), 'base64');
            if (value.length < 28) throw new Error('Truncated isolated test ciphertext');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
            decipher.setAuthTag(value.subarray(12, 28));
            return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
        },
    };
}
