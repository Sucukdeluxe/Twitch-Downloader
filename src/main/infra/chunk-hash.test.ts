import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashBuffer, hashFile } from './chunk-hash';

let tmpDir: string;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunkhash-'));
});
afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('hashBuffer', () => {
    test('"hello" sha1', () => {
        expect(hashBuffer(Buffer.from('hello', 'utf-8')))
            .toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    test('empty buffer sha1', () => {
        expect(hashBuffer(Buffer.alloc(0)))
            .toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    });

    test('large buffer hashes deterministically', () => {
        const big = Buffer.alloc(1024 * 1024, 0x42); // 1MB of 'B' bytes
        const a = hashBuffer(big);
        const b = hashBuffer(big);
        expect(a).toBe(b);
        expect(a).toHaveLength(40); // sha1 = 40 hex chars
    });

    test('different content produces different hashes', () => {
        expect(hashBuffer(Buffer.from('a'))).not.toBe(hashBuffer(Buffer.from('b')));
    });
});

describe('hashFile', () => {
    test('file hash matches buffer hash for same content', async () => {
        const content = 'roundtrip-test-payload';
        const filePath = path.join(tmpDir, 'a.bin');
        fs.writeFileSync(filePath, content, 'utf-8');
        const fileHash = await hashFile(filePath);
        const bufHash = hashBuffer(Buffer.from(content, 'utf-8'));
        expect(fileHash).toBe(bufHash);
    });

    test('empty file = empty-buffer sha1', async () => {
        const filePath = path.join(tmpDir, 'empty.bin');
        fs.writeFileSync(filePath, '');
        const fileHash = await hashFile(filePath);
        expect(fileHash).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    });

    test('large file (4MB) hashes correctly', async () => {
        const filePath = path.join(tmpDir, 'big.bin');
        const payload = Buffer.alloc(4 * 1024 * 1024, 0x55);
        fs.writeFileSync(filePath, payload);
        const fileHash = await hashFile(filePath);
        expect(fileHash).toBe(hashBuffer(payload));
    });

    test('missing file rejects', async () => {
        await expect(hashFile(path.join(tmpDir, 'does-not-exist'))).rejects.toThrow();
    });
});
