import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readChatFile } from './chat-reader';

describe('chat reader', () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    });

    it('streams a large live chat without retaining more than the configured message limit', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'tvm-chat-reader-'));
        directories.push(directory);
        const filePath = join(directory, 'stream.chat.jsonl');
        const lines = Array.from({ length: 4_000 }, (_, index) => JSON.stringify({ type: 'msg', u: `viewer-${index}`, msg: `message-${index}` }));
        writeFileSync(filePath, lines.join('\n'), 'utf8');

        let yielded = false;
        const resultPromise = readChatFile(filePath, { maxMessages: 120, yieldEveryChunks: 1 });
        void new Promise<void>((resolve) => setImmediate(() => {
            yielded = true;
            resolve();
        }));
        const result = await resultPromise;

        expect(yielded).toBe(true);
        expect(result).toMatchObject({ success: true, format: 'live', total: 4_000, truncated: true });
        if (!result.success) throw new Error(result.error || 'Chat reader failed');
        expect(result.messages).toHaveLength(120);
        expect(result.messages?.[0]).toMatchObject({ u: 'viewer-0', msg: 'message-0' });
        expect(result.messages?.[119]).toMatchObject({ u: 'viewer-119', msg: 'message-119' });
    });

    it('stops an active stream when the caller cancels the read', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'tvm-chat-reader-'));
        directories.push(directory);
        const filePath = join(directory, 'stream.chat.jsonl');
        writeFileSync(filePath, Array.from({ length: 30_000 }, (_, index) => JSON.stringify({ type: 'msg', msg: String(index) })).join('\n'), 'utf8');
        const controller = new AbortController();

        const reading = readChatFile(filePath, { signal: controller.signal, yieldEveryChunks: 1 });
        controller.abort();

        await expect(reading).resolves.toEqual({ success: false, cancelled: true });
    });
});
