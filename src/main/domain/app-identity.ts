import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WindowsAppIdentity {
    name: string;
    appUserModelId: string;
}

export interface WindowsAppIconPathOptions {
    isPackaged: boolean;
    appPath: string;
    resourcesPath: string;
    version: string;
}

export interface WindowsTaskbarDetailsOptions {
    identity: WindowsAppIdentity;
    iconPath: string;
    executablePath: string;
    developmentRelaunchCommand?: string;
    isDevelopment: boolean;
}

export interface WindowsTaskbarDetails {
    appId: string;
    appIconPath: string;
    appIconIndex: number;
    relaunchCommand: string;
    relaunchDisplayName: string;
}

export function getWindowsAppIdentity(isDevelopment: boolean): WindowsAppIdentity {
    return {
        name: isDevelopment ? 'Twitch Downloader · Entwickler-Version' : 'Twitch Downloader',
        appUserModelId: isDevelopment
            ? 'io.github.sucukdeluxe.twitch-downloader.development'
            : 'io.github.sucukdeluxe.twitch-downloader'
    };
}

export function migrateLegacyDirectory(targetDirectory: string, legacyDirectory: string): void {
    if (!fs.existsSync(legacyDirectory)) return;
    fs.mkdirSync(targetDirectory, { recursive: true });
    for (const entry of fs.readdirSync(legacyDirectory, { withFileTypes: true })) {
        if (entry.name.includes('Cache') || entry.name === 'blob_storage') continue;
        const sourcePath = path.join(legacyDirectory, entry.name);
        const destinationPath = path.join(targetDirectory, entry.name);
        if (fs.existsSync(destinationPath)) continue;
        try {
            fs.cpSync(sourcePath, destinationPath, { recursive: true, force: false });
        } catch {
        }
    }
}

export function resolveWindowsAppIconPath(options: WindowsAppIconPathOptions): string {
    const iconPath = options.isPackaged
        ? path.join(options.resourcesPath, 'app-icons', `icon-${options.version}.ico`)
        : path.join(options.appPath, 'build', 'icon.ico');
    if (!fs.existsSync(iconPath) || !fs.statSync(iconPath).isFile()) {
        throw new Error(`Windows application icon is missing: ${iconPath}`);
    }
    return iconPath;
}

function quoteWindowsCommandPath(value: string): string {
    if (!value || /["\r\n]/.test(value)) throw new Error('Invalid Windows command path');
    return `"${value}"`;
}

export function createWindowsTaskbarDetails(options: WindowsTaskbarDetailsOptions): WindowsTaskbarDetails {
    const developmentCommand = options.developmentRelaunchCommand?.trim();
    if (options.isDevelopment && !developmentCommand) throw new Error('Development relaunch command is missing');
    return {
        appId: options.identity.appUserModelId,
        appIconPath: options.iconPath,
        appIconIndex: 0,
        relaunchCommand: options.isDevelopment ? developmentCommand! : quoteWindowsCommandPath(options.executablePath),
        relaunchDisplayName: options.identity.name,
    };
}
