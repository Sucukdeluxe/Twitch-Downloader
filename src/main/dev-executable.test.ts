import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ResEdit from 'resedit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareWindowsDevExecutable } from './dev-executable';

let tempDirectory: string;

beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-dev-exe-'));
});

afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('prepareWindowsDevExecutable', () => {
    it('bettet App-Icon und Produktnamen in die gestartete Entwicklungs-EXE ein', async () => {
        const sourcePath = path.join(tempDirectory, 'source.exe');
        fs.writeFileSync(sourcePath, Buffer.from(ResEdit.NtExecutable.createEmpty(false).generate()));
        const destinationPath = path.join(tempDirectory, 'Twitch VOD Manager.exe');
        const iconPath = path.resolve('build/icon.ico');

        await prepareWindowsDevExecutable({
            sourcePath,
            destinationPath,
            iconPath,
            version: '1.0.5'
        });

        const executable = ResEdit.NtExecutable.from(fs.readFileSync(destinationPath));
        const resources = ResEdit.NtExecutableResource.from(executable);
        const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
        const versionInfo = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0];
        const strings = versionInfo.getStringValues(versionInfo.getAllLanguagesForStringValues()[0]);

        expect(iconGroups[0].icons).toHaveLength(6);
        expect(strings.ProductName).toBe('Twitch Downloader Development');
        expect(strings.FileDescription).toBe('Twitch Downloader Development');
    });
});
