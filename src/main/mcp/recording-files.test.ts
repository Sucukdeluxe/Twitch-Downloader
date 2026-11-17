import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordingFolder, organizeRecordings } from './recording-files';

const roots: string[] = [];
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-files-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'old'));
    const source = path.join(root, 'old', 'source.mp4');
    fs.writeFileSync(source, 'original video bytes');
    return { root, source, destination: path.join(root, 'new', 'renamed.mp4') };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('recording organization', () => {
    it('previews without creating directories or changing the original', () => {
        const { root, source, destination } = fixture();
        const result = organizeRecordings([root], [{ source, destination }], { dryRun: true });
        expect(result.files[0]).toMatchObject({ source, destination, status: 'planned' });
        expect(fs.existsSync(path.dirname(destination))).toBe(false);
        expect(fs.readFileSync(source, 'utf8')).toBe('original video bytes');
    });
    it('moves video and matching chat and events without changing bytes', () => {
        const { root, source, destination } = fixture();
        for (const extension of ['.chat.json', '.chat.jsonl', '.events.jsonl']) fs.writeFileSync(source.replace('.mp4', extension), extension);
        const result = organizeRecordings([root], [{ source, destination }]);
        expect(result.files).toHaveLength(4);
        expect(result.files.every(file => file.status === 'moved')).toBe(true);
        expect(fs.existsSync(source)).toBe(false);
        expect(fs.readFileSync(destination, 'utf8')).toBe('original video bytes');
        for (const extension of ['.chat.json', '.chat.jsonl', '.events.jsonl']) expect(fs.readFileSync(destination.replace('.mp4', extension), 'utf8')).toBe(extension);
    });
    it('validates the whole batch before moving any file and never overwrites', () => {
        const { root, source, destination } = fixture();
        const second = path.join(root, 'old', 'second.mp4');
        fs.writeFileSync(second, 'second');
        fs.mkdirSync(path.dirname(destination));
        fs.writeFileSync(destination, 'existing');
        expect(() => organizeRecordings([root], [{ source: second, destination: path.join(root, 'new', 'second.mp4') }, { source, destination }])).toThrow(/exists/i);
        expect(fs.readFileSync(destination, 'utf8')).toBe('existing');
        expect(fs.existsSync(second)).toBe(true);
        expect(fs.existsSync(source)).toBe(true);
    });
    it('rejects outside paths, symbolic links, directories, invalid names and extension changes', () => {
        const { root, source, destination } = fixture();
        const outside = fixture().root;
        expect(() => organizeRecordings([root], [{ source, destination: path.join(outside, 'x.mp4') }])).toThrow();
        expect(() => organizeRecordings([root], [{ source, destination: path.join(root, 'new', 'CON.mp4') }])).toThrow();
        expect(() => organizeRecordings([root], [{ source, destination: destination.replace('.mp4', '.exe') }])).toThrow();
        expect(() => organizeRecordings([root], [{ source: path.dirname(source), destination }])).toThrow();
        fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
        expect(() => organizeRecordings([root], [{ source, destination: path.join(root, 'linked', 'x.mp4') }])).toThrow();
        expect(fs.existsSync(source)).toBe(true);
    });
    it('rejects active work and duplicate destinations', () => {
        const { root, source, destination } = fixture();
        expect(() => organizeRecordings([root], [{ source, destination }], { busy: true })).toThrow(/busy/i);
        expect(() => organizeRecordings([root], [{ source, destination }, { source, destination }])).toThrow(/duplicate/i);
        expect(fs.existsSync(source)).toBe(true);
    });
    it('creates only folders under an allowed root and supports a no-op preview', () => {
        const { root } = fixture();
        const target = path.join(root, 'channel', '16.11.2026');
        expect(createRecordingFolder([root], target, true).created).toBe(false);
        expect(fs.existsSync(target)).toBe(false);
        expect(createRecordingFolder([root], target).created).toBe(true);
        expect(createRecordingFolder([root], target).created).toBe(false);
        expect(() => createRecordingFolder([root], path.dirname(root))).toThrow();
    });
});
