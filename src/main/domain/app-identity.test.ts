import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    createWindowsTaskbarDetails,
    getWindowsAppIdentity,
    resolveWindowsAppIconPath,
} from './app-identity';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('getWindowsAppIdentity', () => {
    test('trennt Hot-Dev von der veröffentlichten Windows-Identität', () => {
        expect(getWindowsAppIdentity(true)).toEqual({
            name: 'Twitch Downloader · Entwickler-Version',
            appUserModelId: 'io.github.sucukdeluxe.twitch-downloader.development'
        });
        expect(getWindowsAppIdentity(false)).toEqual({
            name: 'Twitch Downloader',
            appUserModelId: 'io.github.sucukdeluxe.twitch-downloader'
        });
    });
});

describe('Windows taskbar identity', () => {
    test('resolves an existing repository icon for development and the versioned resource for packaged builds', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-app-icon-'));
        temporaryDirectories.push(root);
        const appPath = path.join(root, 'app');
        const resourcesPath = path.join(root, 'resources');
        const developmentIcon = path.join(appPath, 'build', 'icon.ico');
        const packagedIcon = path.join(resourcesPath, 'app-icons', 'icon-1.0.5.ico');
        fs.mkdirSync(path.dirname(developmentIcon), { recursive: true });
        fs.mkdirSync(path.dirname(packagedIcon), { recursive: true });
        fs.writeFileSync(developmentIcon, 'development-icon');
        fs.writeFileSync(packagedIcon, 'packaged-icon');

        expect(resolveWindowsAppIconPath({ isPackaged: false, appPath, resourcesPath, version: '1.0.5' })).toBe(developmentIcon);
        expect(resolveWindowsAppIconPath({ isPackaged: true, appPath, resourcesPath, version: '1.0.5' })).toBe(packagedIcon);
    });

    test('rejects startup when the selected Windows icon resource is missing', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-app-icon-missing-'));
        temporaryDirectories.push(root);

        expect(() => resolveWindowsAppIconPath({
            isPackaged: true,
            appPath: path.join(root, 'app'),
            resourcesPath: path.join(root, 'resources'),
            version: '1.0.5',
        })).toThrow('Windows application icon is missing');
    });

    test('provides explicit taskbar relaunch properties for development and packaged windows', () => {
        const developmentIdentity = getWindowsAppIdentity(true);
        const packagedIdentity = getWindowsAppIdentity(false);
        const developmentCommand = '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\scripts\\dev.mjs" --once';

        expect(createWindowsTaskbarDetails({
            identity: developmentIdentity,
            iconPath: 'C:\\repo\\build\\icon.ico',
            executablePath: 'C:\\repo\\Twitch VOD Manager.exe',
            developmentRelaunchCommand: developmentCommand,
            isDevelopment: true,
        })).toEqual({
            appId: developmentIdentity.appUserModelId,
            appIconPath: 'C:\\repo\\build\\icon.ico',
            appIconIndex: 0,
            relaunchCommand: developmentCommand,
            relaunchDisplayName: developmentIdentity.name,
        });

        expect(createWindowsTaskbarDetails({
            identity: packagedIdentity,
            iconPath: 'C:\\Program Files\\Twitch VOD Manager\\resources\\app-icons\\icon-1.0.5.ico',
            executablePath: 'C:\\Program Files\\Twitch VOD Manager\\Twitch VOD Manager.exe',
            isDevelopment: false,
        }).relaunchCommand).toBe('"C:\\Program Files\\Twitch VOD Manager\\Twitch VOD Manager.exe"');
    });

    test('wires taskbar properties before the initially hidden window is shown and routes start through the branded launcher', () => {
        const root = path.resolve(__dirname, '..', '..', '..');
        const mainSource = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
        const devSource = fs.readFileSync(path.join(root, 'scripts', 'dev.mjs'), 'utf8');
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        const windowCreation = mainSource.indexOf('mainWindow = new BrowserWindow');
        const appDetails = mainSource.indexOf('mainWindow.setAppDetails', windowCreation);
        const windowShow = mainSource.indexOf('presentApplicationWindow(window, IS_BACKGROUND_E2E)', windowCreation);

        expect(mainSource.slice(windowCreation, appDetails)).toContain('show: false');
        expect(appDetails).toBeGreaterThan(windowCreation);
        expect(windowShow).toBeGreaterThan(appDetails);
        expect(mainSource).toContain('resolveWindowsAppIconPath');
        expect(mainSource).toContain('createWindowsTaskbarDetails');
        expect(devSource).toContain('TWITCH_VOD_MANAGER_RELAUNCH_COMMAND');
        expect(packageJson.scripts?.start).toBe('node scripts/dev.mjs --once');
    });
});
