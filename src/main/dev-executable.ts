import * as fs from 'fs';
import * as path from 'path';
import * as ResEdit from 'resedit';
import { writeFileAtomicSync } from './infra/fs-atomic';

export interface WindowsDevExecutableOptions {
    sourcePath: string;
    destinationPath: string;
    iconPath: string;
    version: string;
}

export async function prepareWindowsDevExecutable(options: WindowsDevExecutableOptions): Promise<string> {
    const source = path.resolve(options.sourcePath);
    const destination = path.resolve(options.destinationPath);
    const icon = path.resolve(options.iconPath);
    const stampPath = `${destination}.json`;
    const sourceStats = fs.statSync(source);
    const iconStats = fs.statSync(icon);
    const fingerprint = JSON.stringify({
        sourceSize: sourceStats.size,
        sourceModified: sourceStats.mtimeMs,
        iconSize: iconStats.size,
        iconModified: iconStats.mtimeMs,
        version: options.version
    });

    if (fs.existsSync(destination) && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8') === fingerprint) {
        return destination;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporaryDestination = `${destination}.tmp`;
    fs.copyFileSync(source, temporaryDestination);

    try {
        const executable = ResEdit.NtExecutable.from(fs.readFileSync(temporaryDestination), { ignoreCert: true });
        const resources = ResEdit.NtExecutableResource.from(executable);
        const versionEntries = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
        const versionInfo = versionEntries[0] || ResEdit.Resource.VersionInfo.createEmpty();
        const languages = versionInfo.getAllLanguagesForStringValues();
        const language = languages[0] || { lang: 0x0409, codepage: 1200 };
        versionInfo.setStringValues(language, {
            FileDescription: 'Twitch Downloader',
            ProductName: 'Twitch Downloader',
            InternalName: 'Twitch Downloader',
            OriginalFilename: 'Twitch Downloader.exe'
        });
        versionInfo.setFileVersion(options.version);
        versionInfo.setProductVersion(options.version);
        versionInfo.outputToResourceEntries(resources.entries);

        const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icon));
        ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
            resources.entries,
            1,
            language.lang,
            iconFile.icons.map((entry) => entry.data)
        );

        resources.outputResource(executable);
        fs.writeFileSync(temporaryDestination, Buffer.from(executable.generate()));
        fs.rmSync(destination, { force: true });
        fs.renameSync(temporaryDestination, destination);
        writeFileAtomicSync(stampPath, fingerprint);
        return destination;
    } catch (error) {
        fs.rmSync(temporaryDestination, { force: true });
        throw error;
    }
}
