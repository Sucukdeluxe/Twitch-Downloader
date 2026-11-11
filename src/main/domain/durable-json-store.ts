import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function readJsonDocument(filePath: string, maxBytes = 16 * 1024 * 1024): Promise<unknown | undefined> {
    let file: fs.FileHandle;
    try {
        file = await fs.open(filePath, 'r');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    try {
        if ((await file.stat()).size > maxBytes) throw new Error('Document exceeds size limit');
        return JSON.parse(await file.readFile('utf8')) as unknown;
    } finally {
        await file.close();
    }
}

export async function writeJsonDocument(filePath: string, document: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + randomUUID() + '.tmp');
    const file = await fs.open(temporaryPath, 'wx', 0o600);
    try {
        try {
            await file.writeFile(JSON.stringify(document), 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await fs.rename(temporaryPath, filePath);
    } finally {
        await fs.rm(temporaryPath, { force: true });
    }
}

export function createSerialExecutor(): <T>(operation: () => Promise<T>) => Promise<T> {
    let previous: Promise<unknown> = Promise.resolve();
    return <T>(operation: () => Promise<T>): Promise<T> => {
        const current = previous.then(operation, operation);
        previous = current.catch(() => undefined);
        return current;
    };
}
