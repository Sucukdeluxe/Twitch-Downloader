import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function publishBuildFile(target, content) {
    const data = Buffer.from(content);
    const existing = await readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing?.equals(data)) return;
    await mkdir(dirname(target), { recursive: true });
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, data);
        for (let attempt = 0; ; attempt++) {
            try { await rename(temporary, target); return; }
            catch (error) {
                if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 39) throw error;
                await delay(50);
            }
        }
    } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}
