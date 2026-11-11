import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PartialDownloadRegistry } from './partial-download';

let tempDirectory: string;
let registryPath: string;

beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-partial-'));
    registryPath = path.join(tempDirectory, 'partial-downloads.json');
});

afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('PartialDownloadRegistry', () => {
    it('veröffentlicht erst nach erfolgreichem Commit den endgültigen Dateinamen', () => {
        const registry = new PartialDownloadRegistry(registryPath);
        const finalPath = path.join(tempDirectory, 'video.mp4');
        const partialPath = registry.begin(finalPath);

        fs.writeFileSync(partialPath, 'vollständig');

        expect(partialPath).toBe(`${finalPath}.tvm-part`);
        expect(fs.existsSync(finalPath)).toBe(false);

        registry.commit(partialPath, finalPath);

        expect(fs.readFileSync(finalPath, 'utf8')).toBe('vollständig');
        expect(fs.existsSync(partialPath)).toBe(false);
        expect(fs.existsSync(registryPath)).toBe(false);
    });

    it('entfernt eine abgebrochene Teil-Datei', () => {
        const registry = new PartialDownloadRegistry(registryPath);
        const finalPath = path.join(tempDirectory, 'abbruch.mp4');
        const partialPath = registry.begin(finalPath);
        fs.writeFileSync(partialPath, 'unvollständig');

        registry.discard(partialPath);

        expect(fs.existsSync(partialPath)).toBe(false);
        expect(fs.existsSync(finalPath)).toBe(false);
        expect(fs.existsSync(registryPath)).toBe(false);
    });

    it('räumt nach einem simulierten Crash registrierte Teil-Dateien beim nächsten Start auf', () => {
        const firstRun = new PartialDownloadRegistry(registryPath);
        const finalPath = path.join(tempDirectory, 'crash.mp4');
        const partialPath = firstRun.begin(finalPath);
        fs.writeFileSync(partialPath, 'unvollständig');

        const secondRun = new PartialDownloadRegistry(registryPath);
        const removed = secondRun.cleanup();

        expect(removed).toEqual([partialPath]);
        expect(fs.existsSync(partialPath)).toBe(false);
        expect(fs.existsSync(finalPath)).toBe(false);
        expect(fs.existsSync(registryPath)).toBe(false);
    });
});
