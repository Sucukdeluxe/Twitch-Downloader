import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCutterProjectAutosaveStore } from './cutter-project';

let directory: string;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-vod-manager-cutter-project-'));
});

afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('cutter project autosave', () => {
    test.each(['software', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'] as const)('restores a crash-saved %s edit after recreating the local store', (encoder) => {
        const autosavePath = path.join(directory, 'cutter-projects.json');
        const source = { path: 'C:\\Media\\source.mp4', size: 2_048_000, mtimeMs: 1_725_000_000_000 };
        const savingStore = createCutterProjectAutosaveStore(autosavePath);

        savingStore.save({
            source,
            duration: 120,
            fps: 30,
            trimStart: 5,
            trimEnd: 110,
            cuts: [{ id: 'cut-1', start: 32, end: 46 }],
            profile: 'quality',
            encoder,
            audioStreamIndex: 1,
        });

        const recovered = createCutterProjectAutosaveStore(autosavePath).find(source);

        expect(recovered).toMatchObject({
            source,
            trimStart: 5,
            trimEnd: 110,
            cuts: [{ id: 'cut-1', start: 32, end: 46 }],
            profile: 'quality',
            encoder,
            audioStreamIndex: 1,
        });
        expect(fs.existsSync(`${autosavePath}.tmp`)).toBe(false);
    });

    test.each([
        ['path', (source: { path: string; size: number; mtimeMs: number }) => ({ ...source, path: 'C:\\Media\\renamed.mp4' })],
        ['size', (source: { path: string; size: number; mtimeMs: number }) => ({ ...source, size: source.size + 1 })],
        ['modification time', (source: { path: string; size: number; mtimeMs: number }) => ({ ...source, mtimeMs: source.mtimeMs + 1 })],
    ])('rejects a recovery when the source %s changed', (_field, mutate) => {
        const autosavePath = path.join(directory, 'cutter-projects.json');
        const savedSource = { path: 'C:\\Media\\source.mp4', size: 2_048_000, mtimeMs: 1_725_000_000_000 };
        const changedSource = mutate(savedSource);
        const store = createCutterProjectAutosaveStore(autosavePath);
        store.save({
            source: savedSource,
            duration: 120,
            fps: 30,
            trimStart: 0,
            trimEnd: 120,
            cuts: [],
            profile: 'balanced',
            encoder: 'software',
            audioStreamIndex: 0,
        });

        expect(store.find(changedSource)).toBeNull();
    });

    test('discards the current source recovery', () => {
        const autosavePath = path.join(directory, 'cutter-projects.json');
        const savedSource = { path: 'C:\\Media\\source.mp4', size: 2_048_000, mtimeMs: 1_725_000_000_000 };
        const store = createCutterProjectAutosaveStore(autosavePath);
        store.save({
            source: savedSource,
            duration: 120,
            fps: 30,
            trimStart: 0,
            trimEnd: 120,
            cuts: [],
            profile: 'balanced',
            encoder: 'software',
            audioStreamIndex: 0,
        });

        expect(store.discard(savedSource)).toBe(true);
        expect(createCutterProjectAutosaveStore(autosavePath).find(savedSource)).toBeNull();
    });
});
