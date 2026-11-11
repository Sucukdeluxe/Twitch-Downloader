import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sourceFingerprint, saveBuildState } from './build-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const lockPath = fileURLToPath(new URL('../dist/.build.lock', import.meta.url));
await mkdir(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true });
const waitingSince = Date.now();
let lock;
while (!lock) {
    try {
        lock = await open(lockPath, 'wx');
        await lock.writeFile(String(process.pid));
    } catch (error) {
        if (lock) { await lock.close(); await unlink(lockPath); throw error; }
        if (error.code !== 'EEXIST') throw error;
        try {
            const owner = Number(await readFile(lockPath, 'utf8'));
            if (Number.isInteger(owner) && owner > 0) {
                try { process.kill(owner, 0); }
                catch (ownerError) { if (ownerError.code === 'ESRCH') await unlink(lockPath); }
            } else if (Date.now() - (await stat(lockPath)).mtimeMs > 5000) await unlink(lockPath);
        } catch (lockError) { if (lockError.code !== 'ENOENT') throw lockError; }
        if (Date.now() - waitingSince > 180000) throw new Error('Timed out waiting for the active build', { cause: error });
        await delay(100);
    }
}
try {
    const developmentRefresh = process.argv.includes('--development-refresh');
    const source = developmentRefresh ? null : await sourceFingerprint(root);
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))], {
        cwd: root, windowsHide: true,
    });
    await import('./build-player.mjs');
    await import('./build-renderer.mjs');
    if (source !== null) await saveBuildState(root, source);
} finally {
    await lock.close();
    await unlink(lockPath);
}
