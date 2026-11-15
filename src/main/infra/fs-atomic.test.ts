import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSync } from './fs-atomic';

let tmpDir: string;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsatomic-'));
});
afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('writeFileAtomicSync', () => {
    test('writes a string payload', () => {
        const target = path.join(tmpDir, 'a.txt');
        writeFileAtomicSync(target, 'hello');
        expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
    });

    test('writes a buffer payload', () => {
        const target = path.join(tmpDir, 'b.bin');
        writeFileAtomicSync(target, Buffer.from([1, 2, 3, 4]));
        expect(fs.readFileSync(target)).toEqual(Buffer.from([1, 2, 3, 4]));
    });

    test('overwrites existing file', () => {
        const target = path.join(tmpDir, 'c.txt');
        fs.writeFileSync(target, 'old');
        writeFileAtomicSync(target, 'new');
        expect(fs.readFileSync(target, 'utf-8')).toBe('new');
    });

    test('cleans up tmp file after success', () => {
        const target = path.join(tmpDir, 'd.txt');
        writeFileAtomicSync(target, 'x');
        expect(fs.existsSync(target + '.tmp')).toBe(false);
    });

    test('utf-8 multibyte chars roundtrip', () => {
        const target = path.join(tmpDir, 'e.txt');
        writeFileAtomicSync(target, 'aeoeue-aeoeue');
        expect(fs.readFileSync(target, 'utf-8')).toBe('aeoeue-aeoeue');
    });

    test('empty payload writes empty file', () => {
        const target = path.join(tmpDir, 'f.txt');
        writeFileAtomicSync(target, '');
        expect(fs.readFileSync(target, 'utf-8')).toBe('');
        expect(fs.statSync(target).size).toBe(0);
    });
});
