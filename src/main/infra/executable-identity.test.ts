import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executableIdentity } from './executable-identity';

let root: string;
let file: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-executable-identity-'));
    file = path.join(root, 'tool');
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('verified executable cache identity', () => {
    it('is stable for the same unchanged executable', () => {
        const identity = executableIdentity(file);
        expect(identity).not.toBeNull();
        expect(executableIdentity(file)).toBe(identity);
    });
    it('invalidates same-size changes even if mtime is restored', () => {
        const timestamp = new Date('2026-01-01T00:00:00Z');
        fs.utimesSync(file, timestamp, timestamp);
        const stat = fs.statSync(file, { bigint: true });
        const identity = executableIdentity(file);
        fs.writeFileSync(file, '#!/bin/sh\nexit 1\n');
        fs.utimesSync(file, timestamp, timestamp);
        expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(stat.mtimeNs);
        expect(executableIdentity(file)).not.toBe(identity);
    });
    it('invalidates replacement at the same path', () => {
        const identity = executableIdentity(file);
        const replacement = path.join(root, 'replacement');
        fs.copyFileSync(file, replacement);
        fs.renameSync(replacement, file);
        expect(executableIdentity(file)).not.toBe(identity);
    });
    it('refuses missing files, directories and PATH lookups', () => {
        expect(executableIdentity(`${file}-missing`)).toBeNull();
        expect(executableIdentity(root)).toBeNull();
        expect(executableIdentity('ffmpeg')).toBeNull();
    });
    it.skipIf(process.platform === 'win32')('refuses lost executable permission', () => {
        expect(executableIdentity(file)).not.toBeNull();
        fs.chmodSync(file, 0o644);
        expect(executableIdentity(file)).toBeNull();
    });
});
