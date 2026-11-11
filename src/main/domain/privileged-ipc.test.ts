import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerTrustedIpcHandler } from './privileged-ipc';

describe('privileged IPC behavior', () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    });

    it.each(['add-to-queue', 'remove-from-queue', 'download-clip', 'run-preflight', 'get-debug-log'])(
        'registers %s so an untrusted renderer event cannot execute it',
        async (channel) => {
            const directory = mkdtempSync(join(tmpdir(), 'tvm-privileged-ipc-'));
            directories.push(directory);
            const marker = join(directory, `${channel}.txt`);
            const handlers = new Map<string, (event: { trusted: boolean }) => unknown>();
            registerTrustedIpcHandler(
                { handle: (registeredChannel, handler) => handlers.set(registeredChannel, handler) },
                channel,
                (event: { trusted: boolean }) => event.trusted,
                () => ({ denied: true }),
                async () => {
                    writeFileSync(marker, channel);
                    return { denied: false };
                },
            );
            const handler = handlers.get(channel);

            expect(handler).toBeTypeOf('function');
            expect(await handler?.({ trusted: false })).toEqual({ denied: true });
            expect(() => readFileSync(marker, 'utf8')).toThrow();
            expect(await handler?.({ trusted: true })).toEqual({ denied: false });
            expect(readFileSync(marker, 'utf8')).toBe(channel);
        },
    );
});
