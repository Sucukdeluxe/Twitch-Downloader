import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CUTTER_SESSION_CAPABILITY_TTL_MS,
    FileCapabilityStore,
    isTrustedFileIpcSender,
    publishCapabilityOutput,
} from './file-capability';

describe('file capability boundary', () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    });

    function createFixture(): { directory: string; video: string; chat: string; output: string } {
        const directory = mkdtempSync(join(tmpdir(), 'tvm-capability-'));
        directories.push(directory);
        const video = join(directory, 'source.mp4');
        const chat = join(directory, 'source.chat.jsonl');
        writeFileSync(video, 'video');
        writeFileSync(chat, '{"message":"hello"}\n');
        return { directory, video, chat, output: join(directory, 'result.mp4') };
    }

    it('accepts only the expected renderer owner and document URL', () => {
        const expectedUrl = 'file:///C:/app/src/index.html';
        expect(isTrustedFileIpcSender(17, expectedUrl, 17, `${expectedUrl}?language=de#cutter`)).toBe(true);
        expect(isTrustedFileIpcSender(17, expectedUrl, 18, expectedUrl)).toBe(false);
        expect(isTrustedFileIpcSender(17, expectedUrl, 17, 'file:///C:/app/src/forged.html')).toBe(false);
        expect(isTrustedFileIpcSender(17, expectedUrl, 17, 'https://attacker.invalid/')).toBe(false);
    });

    it('rejects forged, wrong-owner, wrong-purpose, expired, and reused tokens', () => {
        const fixture = createFixture();
        let now = 1_000;
        const store = new FileCapabilityStore({ now: () => now, defaultTtlMs: 500 });
        const mergeInput = store.issue({ ownerId: 7, purpose: 'merge-input', path: fixture.video, kind: 'input-file', extensions: ['.mp4'] });

        expect(() => store.consume('forged', 7, 'merge-input')).toThrow('Invalid file capability');
        expect(() => store.consume(mergeInput.token, 8, 'merge-input')).toThrow('Invalid file capability owner');
        expect(() => store.consume(mergeInput.token, 7, 'cutter-input')).toThrow('Invalid file capability purpose');
        expect(store.consume(mergeInput.token, 7, 'merge-input')).toBe(realpathSync.native(fixture.video));
        expect(() => store.consume(mergeInput.token, 7, 'merge-input')).toThrow('Invalid file capability');

        const expired = store.issue({ ownerId: 7, purpose: 'chat-input', path: fixture.chat, kind: 'input-file', extensions: ['.chat.jsonl'] });
        now = 1_500;
        expect(() => store.resolve(expired.token, 7, 'chat-input')).toThrow('Expired file capability');
    });

    it('keeps a purpose-bound cutter session usable after fifteen minutes without weakening owner or purpose checks', () => {
        const fixture = createFixture();
        let now = 10_000;
        const store = new FileCapabilityStore({ now: () => now, defaultTtlMs: 500 });
        const cutter = store.issue({
            ownerId: 7,
            purpose: 'cutter-input',
            path: fixture.video,
            kind: 'input-file',
            extensions: ['mp4'],
            ttlMs: CUTTER_SESSION_CAPABILITY_TTL_MS,
        });

        now += 16 * 60 * 1000;
        const assetInput = store.resolve(cutter.token, 7, 'cutter-input');
        const exportInput = store.resolve(cutter.token, 7, 'cutter-input');
        expect(assetInput).toBe(realpathSync.native(fixture.video));
        expect(exportInput).toBe(realpathSync.native(fixture.video));
        expect(() => store.resolve(cutter.token, 8, 'cutter-input')).toThrow('Invalid file capability owner');
        expect(() => store.resolve(cutter.token, 7, 'merge-input')).toThrow('Invalid file capability purpose');

        now = 10_000 + 8 * 60 * 60 * 1000;
        expect(() => store.resolve(cutter.token, 7, 'cutter-input')).toThrow('Expired file capability');
    });

    it('binds canonical input and output paths to the allowed extension and semantics', () => {
        const fixture = createFixture();
        const store = new FileCapabilityStore();
        const aliasedInput = join(fixture.directory, 'nested', '..', 'source.mp4');
        mkdirSync(dirname(aliasedInput), { recursive: true });
        const input = store.issue({ ownerId: 3, purpose: 'cutter-input', path: aliasedInput, kind: 'input-file', extensions: ['mp4'] });
        expect(store.resolve(input.token, 3, 'cutter-input')).toBe(realpathSync.native(fixture.video));

        expect(() => store.issue({ ownerId: 3, purpose: 'cutter-input', path: fixture.chat, kind: 'input-file', extensions: ['mp4'] })).toThrow('File extension is not allowed');
        expect(() => store.issue({ ownerId: 3, purpose: 'merge-output', path: join(fixture.directory, 'result.exe'), kind: 'output-file', extensions: ['mp4'] })).toThrow('File extension is not allowed');
        expect(() => store.issue({ ownerId: 3, purpose: 'merge-output', path: join(fixture.directory, 'missing', 'result.mp4'), kind: 'output-file', extensions: ['mp4'] })).toThrow('Output directory does not exist');
        const directoryTarget = join(fixture.directory, 'directory.mp4');
        mkdirSync(directoryTarget);
        expect(() => store.issue({ ownerId: 3, purpose: 'merge-output', path: directoryTarget, kind: 'output-file', extensions: ['mp4'] })).toThrow('Output target is not a file');

        const output = store.issue({ ownerId: 3, purpose: 'merge-output', path: fixture.output, kind: 'output-file', extensions: ['mp4'] });
        expect(store.consume(output.token, 3, 'merge-output')).toBe(join(realpathSync.native(fixture.directory), 'result.mp4'));
    });

    it('rejects an output capability that aliases a protected input', () => {
        const fixture = createFixture();
        const store = new FileCapabilityStore();
        const output = store.issue({ ownerId: 3, purpose: 'merge-output', path: fixture.video, kind: 'output-file', extensions: ['mp4'] });

        expect(() => store.consume(output.token, 3, 'merge-output', [fixture.video])).toThrow('Output path conflicts with a protected input');
    });

    it('detects canonical-path replacement after a capability is issued', () => {
        const fixture = createFixture();
        const store = new FileCapabilityStore();
        const input = store.issue({ ownerId: 3, purpose: 'cutter-input', path: fixture.video, kind: 'input-file', extensions: ['mp4'] });
        const replacement = join(fixture.directory, 'replacement.mp4');
        writeFileSync(replacement, 'replacement');
        rmSync(fixture.video);
        try {
            symlinkSync(replacement, fixture.video, 'file');
        } catch {
            writeFileSync(fixture.video, 'changed');
        }
        expect(() => store.resolve(input.token, 3, 'cutter-input')).toThrow('File capability path changed');
    });

    it('never removes or replaces an existing destination when output production fails', async () => {
        const fixture = createFixture();
        writeFileSync(fixture.output, 'existing-user-file');

        const success = await publishCapabilityOutput(fixture.output, async (partialPath) => {
            writeFileSync(partialPath, 'incomplete-merge');
            return false;
        });

        expect(success).toBe(false);
        expect(readFileSync(fixture.output, 'utf8')).toBe('existing-user-file');
    });

    it('atomically replaces the selected destination only after successful production', async () => {
        const fixture = createFixture();
        writeFileSync(fixture.output, 'existing-user-file');

        const success = await publishCapabilityOutput(fixture.output, async (partialPath) => {
            writeFileSync(partialPath, 'complete-merge');
            return true;
        });

        expect(success).toBe(true);
        expect(readFileSync(fixture.output, 'utf8')).toBe('complete-merge');
    });
});
