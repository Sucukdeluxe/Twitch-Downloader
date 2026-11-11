import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MAC_UPDATE_BUNDLE_ID, MAC_UPDATE_FEED, type MacUpdateManifest } from '../domain/mac-update-manifest';
import { assertMacOSVersionSupported, MacUpdater } from './mac-updater';
import { UpdateLifecycle } from '../updates/update-lifecycle';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const archive = Buffer.from('PK\u0003\u0004authenticated update archive fixture');
let directory: string;
let get: MockInstance<typeof axios.get>;

function release(version = '1.2.3', bytes = archive): { manifest: MacUpdateManifest; envelope: Buffer } {
    const manifest = {
        schema: 1, version, publishedAt: '2026-11-11T10:00:00.000Z', releaseNotes: 'Fixture release',
        artifacts: Object.fromEntries(['arm64', 'x64'].map((arch) => [arch, {
            url: `https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v${version}/Twitch-VOD-Manager-${version}-mac-${arch}.zip`,
            size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        }])),
    } as MacUpdateManifest;
    const payload = Buffer.from(JSON.stringify(manifest));
    return { manifest, envelope: Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })) };
}

function updater(version = '1.0.0', arch: 'arm64' | 'x64' = 'arm64') {
    const errors = vi.fn(), available = vi.fn(), downloaded = vi.fn(), unavailable = vi.fn(), progress = vi.fn(), log = vi.fn();
    const instance = new MacUpdater({
        version, arch, publicKey, cacheDirectory: path.join(directory, 'cache'), targetApp: path.join(directory, 'Installed.app'), helperPath: path.join(directory, 'helper'), log,
    });
    instance.on('error', errors).on('update-available', available).on('update-downloaded', downloaded).on('update-not-available', unavailable).on('download-progress', progress);
    return { instance, errors, available, downloaded, unavailable, progress, log };
}

function saveCached(value = release(), bytes = archive): void {
    fs.mkdirSync(path.join(directory, 'cache'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'cache', 'update.json'), value.envelope);
    fs.writeFileSync(path.join(directory, 'cache', 'update.zip'), bytes);
}

function notFound(): Error & { isAxiosError: true; response: { status: number } } {
    return Object.assign(new Error('No stable release'), { isAxiosError: true as const, response: { status: 404 } });
}

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-updater-test-'));
    fs.mkdirSync(path.join(directory, 'Installed.app'));
    get = vi.spyOn(axios, 'get');
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('macOS update system compatibility', () => {
    it.each([
        [undefined, '13.0'], ['12.0', '13.0'], ['13', '13.0.0'], ['13.0.1', '13.0.1'], ['13.9', '13.10'],
    ])('accepts requirement %s on macOS %s', (minimum, current) => {
        expect(() => assertMacOSVersionSupported(minimum, current)).not.toThrow();
    });

    it.each([
        ['13.0', '12.7.6'], ['13.1', '13.0.9'], ['13.0.1', '13.0'], ['13.10', '13.9'], ['999.0', '26.0'],
    ])('rejects requirement %s on macOS %s', (minimum, current) => {
        expect(() => assertMacOSVersionSupported(minimum, current)).toThrow(`Update requires macOS ${minimum}`);
    });

    it.each([null, 13, '', '13..0', '13.0-beta', '13.0.0.1', ' 13.0', '0.0'])('rejects malformed declared requirement %s', minimum => {
        expect(() => assertMacOSVersionSupported(minimum, '13.0')).toThrow('Invalid macOS system version');
    });

    it.runIf(process.platform === 'darwin').each([false, true])('rejects an incompatible authenticated archive before staging (cleanup failure: %s)', async cleanupFails => {
        const bundle = path.join(directory, 'Twitch VOD Manager.app');
        fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${MAC_UPDATE_BUNDLE_ID}</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>LSMinimumSystemVersion</key><string>999.0</string>
</dict></plist>`);
        const zip = path.join(directory, 'unsupported.zip');
        execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, zip]);
        const bytes = fs.readFileSync(zip);
        saveCached(release('1.2.3', bytes), bytes);
        fs.writeFileSync(path.join(directory, 'Installed.app', 'unchanged'), 'installed application');
        const state = updater();
        if (cleanupFails) {
            const remove = fs.promises.rm.bind(fs.promises);
            vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
                if (String(file).startsWith(path.join(fs.realpathSync(directory), '.twitch-vod-extract-'))) {
                    throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
                }
                return remove(file, options);
            });
        }

        await expect(state.instance.prepareInstall()).rejects.toThrow('Update requires macOS 999.0');

        expect(fs.readFileSync(path.join(directory, 'Installed.app', 'unchanged'), 'utf8')).toBe('installed application');
        if (cleanupFails) {
            expect(state.log).toHaveBeenCalledWith('mac-update-extraction-cleanup-failed', 'Error: directory not empty');
        } else {
            expect(fs.readdirSync(directory).filter(name => name.startsWith('.twitch-vod-extract-') || name.startsWith('.Twitch-VOD-Manager-update-'))).toEqual([]);
        }
        expect(fs.readdirSync(path.join(directory, 'cache')).filter(name => name.startsWith('plan-') || name.startsWith('installer-'))).toEqual([]);
    });
});

describe.skipIf(process.platform === 'win32')('macOS updater authenticated transport and cache', () => {
    it('restores a verified cached download into the ready lifecycle without a new transfer', async () => {
        saveCached();
        get.mockRejectedValueOnce(notFound());
        const state = updater();
        const lifecycle = new UpdateLifecycle();
        lifecycle.beginCheck();
        state.instance.on('update-downloaded', info => {
            if (!lifecycle.completeDownload(info.version)) lifecycle.restoreDownload(info.version);
        });
        state.instance.on('update-not-available', () => lifecycle.completeCheckNotAvailable());

        await state.instance.checkForUpdates();

        expect(lifecycle.snapshot).toEqual({ phase: 'ready', version: '1.2.3' });
        expect(lifecycle.beginCheck()).toEqual({ started: false, reason: 'ready-to-install' });
        expect(state.progress).not.toHaveBeenCalled();
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('does not let cached restoration replace a newer available or downloading version', () => {
        const lifecycle = new UpdateLifecycle();
        lifecycle.beginCheck();
        lifecycle.completeCheckAvailable('1.3.0');
        lifecycle.beginCheck();
        expect(lifecycle.restoreDownload('1.2.3')).toBe(false);
        lifecycle.failCheck();
        lifecycle.beginDownload('1.3.0');
        expect(lifecycle.restoreDownload('1.2.3')).toBe(false);
        expect(lifecycle.snapshot).toEqual({ phase: 'downloading', version: '1.3.0' });
    });

    it.each(['arm64', 'x64'] as const)('downloads the signed %s artifact and restores it after restart', async (arch) => {
        const value = release();
        get.mockResolvedValueOnce({ data: value.envelope }).mockResolvedValueOnce({ data: Readable.from([archive.subarray(0, 7), archive.subarray(7)]) });
        const first = updater('1.0.0', arch);
        await first.instance.checkForUpdates();
        expect(first.available).toHaveBeenCalledWith(expect.objectContaining({ version: '1.2.3' }));
        await first.instance.downloadUpdate();
        expect(get).toHaveBeenNthCalledWith(2, value.manifest.artifacts[arch].url, expect.objectContaining({ responseType: 'stream' }));
        expect(first.downloaded).toHaveBeenCalledTimes(1);
        expect(first.progress).toHaveBeenLastCalledWith(expect.objectContaining({ percent: 100, transferred: archive.length, total: archive.length }));
        expect(fs.readFileSync(path.join(directory, 'cache', 'update.zip'))).toEqual(archive);
        get.mockRejectedValueOnce(notFound());
        const restarted = updater('1.0.0', arch);
        await restarted.instance.checkForUpdates();
        expect(restarted.downloaded).toHaveBeenCalledWith(expect.objectContaining({ version: '1.2.3' }));
        const calls = get.mock.calls.length;
        await restarted.instance.downloadUpdate();
        expect(get).toHaveBeenCalledTimes(calls);
    });

    it.each(['0.9.0', '1.0.0'])('does not offer or restore non-newer release %s', async (version) => {
        saveCached(release(version));
        get.mockResolvedValueOnce({ data: release(version).envelope });
        const state = updater();
        await state.instance.checkForUpdates();
        expect(state.available).not.toHaveBeenCalled();
        expect(state.downloaded).not.toHaveBeenCalled();
        expect(state.unavailable).toHaveBeenCalledTimes(1);
        await expect(state.instance.downloadUpdate()).rejects.toThrow(/check/i);
    });

    it('treats a missing stable feed as no update and still allows a later successful check', async () => {
        get.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ data: release().envelope });
        const state = updater();
        await state.instance.checkForUpdates();
        expect(state.unavailable).toHaveBeenCalledTimes(1);
        expect(state.errors).not.toHaveBeenCalled();
        await state.instance.checkForUpdates();
        expect(state.available).toHaveBeenCalledTimes(1);
        expect(get.mock.calls[0][0]).toBe(MAC_UPDATE_FEED);
    });

    it('finishes the checking state when a stale feed regresses below the newest known release', async () => {
        get.mockResolvedValueOnce({ data: release('1.2.3').envelope }).mockResolvedValueOnce({ data: release('1.2.2').envelope });
        const state = updater();
        const checking = vi.fn();
        state.instance.on('checking-for-update', checking);
        await state.instance.checkForUpdates();
        state.available.mockClear();
        await state.instance.checkForUpdates();
        expect(checking).toHaveBeenCalledTimes(2);
        const terminalEvents = state.available.mock.calls.length + state.downloaded.mock.calls.length + state.unavailable.mock.calls.length + state.errors.mock.calls.length;
        expect(terminalEvents).toBeGreaterThan(0);
        expect(state.available).not.toHaveBeenCalledWith(expect.objectContaining({ version: '1.2.2' }));
    });

    it('rejects a tampered network manifest before requesting an artifact', async () => {
        const envelope = JSON.parse(release().envelope.toString());
        const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString());
        payload.releaseNotes = 'tampered';
        envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        get.mockResolvedValueOnce({ data: Buffer.from(JSON.stringify(envelope)) });
        const state = updater();
        await expect(state.instance.checkForUpdates()).rejects.toThrow(/signature/i);
        await expect(state.instance.downloadUpdate()).rejects.toThrow(/check/i);
        expect(state.errors).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(path.join(directory, 'cache', 'update.zip'))).toBe(false);
    });

    it.each([
        ['oversized stream', Buffer.concat([archive, Buffer.from('extra')]), /signed size/i],
        ['truncated stream', archive.subarray(0, -1), /checksum/i],
        ['same-size tampering', Buffer.alloc(archive.length, 0x61), /checksum/i],
    ])('rejects %s without committing a cache and permits retry', async (_name, invalid, error) => {
        get.mockResolvedValueOnce({ data: release().envelope }).mockResolvedValueOnce({ data: Readable.from([invalid]) }).mockResolvedValueOnce({ data: Readable.from([archive]) });
        const state = updater();
        await state.instance.checkForUpdates();
        await expect(state.instance.downloadUpdate()).rejects.toThrow(error);
        expect(state.downloaded).not.toHaveBeenCalled();
        expect(fs.readdirSync(path.join(directory, 'cache'))).toEqual([]);
        await state.instance.downloadUpdate();
        expect(state.downloaded).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(path.join(directory, 'cache', 'update.zip'))).toEqual(archive);
    });

    it('cleans an interrupted stream and retries with one shared concurrent transfer', async () => {
        const failed = Readable.from((async function* () { yield archive.subarray(0, 4); throw new Error('connection lost'); })());
        get.mockResolvedValueOnce({ data: release().envelope }).mockResolvedValueOnce({ data: failed }).mockResolvedValueOnce({ data: Readable.from([archive]) });
        const state = updater();
        await state.instance.checkForUpdates();
        await expect(state.instance.downloadUpdate()).rejects.toThrow('connection lost');
        expect(fs.readdirSync(path.join(directory, 'cache'))).toEqual([]);
        await Promise.all([state.instance.downloadUpdate(), state.instance.downloadUpdate()]);
        expect(get).toHaveBeenCalledTimes(3);
        expect(state.downloaded).toHaveBeenCalledTimes(1);
    });

    it('preserves an older verified download when a newer transfer fails', async () => {
        saveCached(release('1.1.0'));
        get.mockResolvedValueOnce({ data: release().envelope }).mockResolvedValueOnce({ data: Readable.from([Buffer.alloc(archive.length)]) });
        const state = updater();
        await state.instance.checkForUpdates();
        await expect(state.instance.downloadUpdate()).rejects.toThrow(/checksum/i);
        get.mockRejectedValueOnce(notFound());
        const restarted = updater();
        await restarted.instance.checkForUpdates();
        expect(restarted.downloaded).toHaveBeenCalledWith(expect.objectContaining({ version: '1.1.0' }));
    });

    it.each(['checksum', 'signature', 'symlink'] as const)('does not restore cached %s corruption', async (kind) => {
        saveCached();
        if (kind === 'checksum') fs.writeFileSync(path.join(directory, 'cache', 'update.zip'), Buffer.alloc(archive.length));
        if (kind === 'signature') fs.writeFileSync(path.join(directory, 'cache', 'update.json'), release().envelope.toString().replace('signature', 'unsigned'));
        if (kind === 'symlink') {
            fs.renameSync(path.join(directory, 'cache', 'update.zip'), path.join(directory, 'external.zip'));
            fs.symlinkSync(path.join(directory, 'external.zip'), path.join(directory, 'cache', 'update.zip'));
        }
        get.mockRejectedValueOnce(notFound());
        const state = updater();
        await state.instance.checkForUpdates();
        expect(state.downloaded).not.toHaveBeenCalled();
        expect(state.log).toHaveBeenCalledWith('mac-update-cache-ignored', expect.any(String));
        await expect(state.instance.downloadUpdate()).rejects.toThrow(/check/i);
    });

    it('verifies cached bytes again immediately before installation', async () => {
        saveCached();
        get.mockRejectedValueOnce(notFound());
        const state = updater();
        await state.instance.checkForUpdates();
        fs.writeFileSync(path.join(directory, 'cache', 'update.zip'), Buffer.alloc(archive.length));
        await expect(state.instance.prepareInstall()).rejects.toThrow(/verification/i);
        expect(fs.readdirSync(path.join(directory, 'Installed.app'))).toEqual([]);
        expect(fs.readdirSync(directory).filter((name) => name.startsWith('.twitch-vod'))).toEqual([]);
    });

    it('rejects insecure redirects for feed and archive requests', async () => {
        get.mockResolvedValueOnce({ data: release().envelope }).mockResolvedValueOnce({ data: Readable.from([archive]) });
        const state = updater();
        await state.instance.checkForUpdates();
        await state.instance.downloadUpdate();
        for (const call of get.mock.calls) {
            const redirect = call[1]!.beforeRedirect!;
            expect(() => redirect({ protocol: 'http:' } as never, {} as never, {} as never)).toThrow(/insecure/i);
            expect(() => redirect({ protocol: 'https:' } as never, {} as never, {} as never)).not.toThrow();
        }
    });

    it('refuses a cache directory writable by another user', async () => {
        fs.mkdirSync(path.join(directory, 'cache'), { mode: 0o777 });
        fs.chmodSync(path.join(directory, 'cache'), 0o777);
        const state = updater();
        await expect(state.instance.checkForUpdates()).rejects.toThrow(/permissions/i);
        expect(get).not.toHaveBeenCalled();
    });
});

describe.skipIf(process.platform === 'win32')('macOS update startup health acknowledgement', () => {
    it('requires healthy startup, matching version and the actual installation path', () => {
        const token = 'a'.repeat(64);
        const cache = path.join(directory, 'cache');
        fs.mkdirSync(cache, { mode: 0o700 });
        const realCache = fs.realpathSync(cache);
        const target = fs.realpathSync(path.join(directory, 'Installed.app'));
        const plan = { healthToken: token, expectedVersion: '1.2.3', targetApp: target };
        fs.writeFileSync(path.join(cache, `plan-${token}.json`), JSON.stringify(plan));
        const argv = [`--mac-update-token=${token}`, `--mac-update-state=${realCache}`];
        const health = path.join(cache, `health-${token}.json`);
        const state = updater('1.2.3');
        state.instance.acknowledgeStartup(argv, false);
        expect(fs.existsSync(health)).toBe(false);
        updater('1.2.2').instance.acknowledgeStartup(argv, true);
        expect(fs.existsSync(health)).toBe(false);
        state.instance.acknowledgeStartup([argv[0], `--mac-update-state=${directory}`], true);
        expect(fs.existsSync(health)).toBe(false);
        state.instance.acknowledgeStartup(argv, true);
        expect(JSON.parse(fs.readFileSync(health, 'utf8'))).toEqual({ schema: 1, token, version: '1.2.3', pid: process.pid });
    });

    it('ignores malformed health tokens without touching the filesystem', () => {
        expect(() => updater().instance.acknowledgeStartup(['--mac-update-token=../escape', `--mac-update-state=${directory}`], true)).not.toThrow();
        expect(fs.readdirSync(directory)).toEqual(['Installed.app']);
    });
});

describe.skipIf(process.platform === 'win32')('macOS update recovery notification', () => {
    it.each(['rolled-back', 'failed'])('reports a matching %s outcome once across restarts', (status) => {
        const cache = path.join(directory, 'cache');
        fs.mkdirSync(cache, { mode: 0o700 });
        fs.writeFileSync(path.join(cache, 'result.json'), JSON.stringify({
            schema: 1, token: 'a'.repeat(64), status, targetApp: fs.realpathSync(path.join(directory, 'Installed.app')),
        }));
        expect(updater().instance.takeInstallOutcome()).toBe(status);
        expect(updater().instance.takeInstallOutcome()).toBeNull();
    });

    it.each(['installing', 'installed', 'foreign-target', 'malformed-token'])('does not display a failure for %s', (scenario) => {
        const cache = path.join(directory, 'cache');
        fs.mkdirSync(cache, { mode: 0o700 });
        fs.writeFileSync(path.join(cache, 'result.json'), JSON.stringify({
            schema: 1, token: scenario === 'malformed-token' ? '../escape' : 'a'.repeat(64),
            status: scenario === 'installing' || scenario === 'installed' ? scenario : 'failed',
            targetApp: scenario === 'foreign-target' ? path.join(directory, 'Other.app') : fs.realpathSync(path.join(directory, 'Installed.app')),
        }));
        expect(updater().instance.takeInstallOutcome()).toBeNull();
        expect(fs.readdirSync(cache)).toEqual(['result.json']);
    });
});

describe.skipIf(process.platform === 'win32')('macOS installation cancellation', () => {
    it('stops the waiting helper even if authorization and stage cleanup fail', async () => {
        const state = updater();
        const child = {
            exitCode: null,
            signalCode: null as string | null,
            kill: vi.fn(() => { child.signalCode = 'SIGTERM'; return true; }),
        };
        // Seed an already prepared transaction without launching an OS installer.
        Reflect.set(state.instance, 'prepared', { token: 'a'.repeat(64), directory, child });
        Reflect.set(state.instance, 'stagedApp', path.join(directory, 'Staged.app'));
        vi.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('Read-only filesystem'), { code: 'EROFS' }));

        await expect(state.instance.cancelInstall()).resolves.toBeUndefined();
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
        expect(state.log).toHaveBeenCalledWith('mac-update-cancel-marker', expect.stringContaining('Read-only filesystem'));
        expect(state.log).toHaveBeenCalledWith('mac-update-cancel-stage', expect.stringContaining('Read-only filesystem'));
        await state.instance.cancelInstall();
        expect(child.kill).toHaveBeenCalledTimes(1);
    });
});
