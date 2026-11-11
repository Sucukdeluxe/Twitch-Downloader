import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import axios from 'axios';
import { MAC_UPDATE_BUNDLE_ID, MAC_UPDATE_FEED, compareMacVersions, validateMacArchiveEntries, verifyMacUpdateManifest, type MacUpdateArch, type MacUpdateManifest } from '../domain/mac-update-manifest';

const execute = promisify(execFile);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Options {
    version: string;
    arch: MacUpdateArch;
    publicKey: string;
    cacheDirectory: string;
    targetApp: string;
    helperPath: string;
    log: (event: string, details?: unknown) => void;
}
interface PreparedInstall { token: string; child: ChildProcess; directory: string }

function writeJson(file: string, value: unknown): void {
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}

async function checksum(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

export function assertMacOSVersionSupported(minimumVersion: unknown, currentVersion: string): void {
    // Older signed app bundles did not declare a minimum. Continue accepting
    // those while refusing malformed or unsupported requirements when present.
    if (minimumVersion === undefined) return;
    const parse = (value: unknown): number[] => {
        if (typeof value !== 'string' || value.length > 32) throw new Error('Invalid macOS system version');
        const components = value.split('.');
        if (components.length > 3 || components.some(part => !/^\d+$/.test(part))) throw new Error('Invalid macOS system version');
        const parts = components.map(Number);
        if (parts[0] <= 0 || parts.some(part => !Number.isSafeInteger(part))) throw new Error('Invalid macOS system version');
        return [parts[0], parts[1] ?? 0, parts[2] ?? 0];
    };
    const minimum = parse(minimumVersion), current = parse(currentVersion);
    for (let index = 0; index < 3; index++) {
        if (current[index] > minimum[index]) return;
        if (current[index] < minimum[index]) throw new Error(`Update requires macOS ${minimumVersion} or later (this Mac has ${currentVersion})`);
    }
}

async function assertBundle(bundle: string, version: string, arch: MacUpdateArch): Promise<void> {
    const stat = await fs.promises.lstat(bundle);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid update application');
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    const info: unknown = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout);
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Invalid update application metadata');
    const metadata = info as Record<string, unknown>;
    if (metadata.CFBundleIdentifier !== MAC_UPDATE_BUNDLE_ID || metadata.CFBundleShortVersionString !== version) throw new Error('Update application identity does not match');
    if (metadata.LSMinimumSystemVersion !== undefined) {
        const hostVersion = (await execute('/usr/bin/sw_vers', ['-productVersion'], { timeout: 5000 })).stdout.trim();
        assertMacOSVersionSupported(metadata.LSMinimumSystemVersion, hostVersion);
    }
    const executable = metadata.CFBundleExecutable;
    if (typeof executable !== 'string' || !executable || executable.includes('\0') || path.basename(executable) !== executable || executable === '.' || executable === '..') throw new Error('Invalid update executable');
    const binary = path.join(bundle, 'Contents', 'MacOS', executable);
    const architectures = (await execute('/usr/bin/lipo', ['-archs', binary])).stdout.trim().split(/\s+/);
    if (!architectures.includes(arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error('Update is for a different Mac processor');
    // Relative Framework symlinks are normal; no entry may escape the app.
    const inspect = async (directory: string): Promise<void> => {
        for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                const resolved = await fs.promises.realpath(file);
                if (!resolved.startsWith(`${bundle}${path.sep}`)) throw new Error('Update contains an external symbolic link');
            } else if (entry.isDirectory()) await inspect(file);
            else if (!entry.isFile()) throw new Error('Update contains an unsupported file');
        }
    };
    await inspect(bundle);
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120000 });
}

/** Independent of Squirrel.Mac: signed releases also work with ad-hoc app signatures. */
export class MacUpdater extends EventEmitter {
    private manifest: MacUpdateManifest | null = null;
    private envelope: Buffer | null = null;
    private downloaded: MacUpdateManifest | null = null;
    private downloadPromise: Promise<void> | null = null;
    private prepared: PreparedInstall | null = null;
    private stagedApp: string | null = null;
    private restored = false;

    constructor(private readonly options: Options) { super(); }

    private get archive(): string { return path.join(this.options.cacheDirectory, 'update.zip'); }
    private get metadata(): string { return path.join(this.options.cacheDirectory, 'update.json'); }
    private info(manifest: MacUpdateManifest) { return { version: manifest.version, releaseDate: manifest.publishedAt, releaseNotes: manifest.releaseNotes }; }

    private ensureCache(): void {
        fs.mkdirSync(this.options.cacheDirectory, { recursive: true, mode: 0o700 });
        const stat = fs.lstatSync(this.options.cacheDirectory);
        if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('Unsafe update cache permissions');
    }

    private async restore(): Promise<void> {
        if (this.restored) return;
        this.restored = true;
        this.ensureCache();
        try {
            const envelope = await fs.promises.readFile(this.metadata);
            const manifest = verifyMacUpdateManifest(envelope, this.options.publicKey);
            if (compareMacVersions(manifest.version, this.options.version) <= 0) {
                await fs.promises.rm(this.archive, { force: true });
                await fs.promises.rm(this.metadata, { force: true });
                return;
            }
            await this.verifyArchive(manifest);
            this.manifest = this.downloaded = manifest;
            this.envelope = envelope;
            this.emit('update-downloaded', this.info(manifest));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.log('mac-update-cache-ignored', String(error));
        }
    }

    async checkForUpdates(): Promise<void> {
        await this.restore();
        if (this.downloadPromise || this.prepared) return;
        this.emit('checking-for-update');
        try {
            const response = await axios.get(MAC_UPDATE_FEED, {
                responseType: 'arraybuffer', timeout: 15000, maxContentLength: 256 * 1024,
                headers: { 'User-Agent': 'Twitch-VOD-Manager', 'Cache-Control': 'no-cache' },
                beforeRedirect: (options) => { if (options.protocol !== 'https:') throw new Error('Insecure update redirect'); },
            });
            const envelope = Buffer.from(response.data);
            const manifest = verifyMacUpdateManifest(envelope, this.options.publicKey);
            if (compareMacVersions(manifest.version, this.options.version) <= 0) {
                this.emit('update-not-available');
                return;
            }
            if (this.manifest && compareMacVersions(manifest.version, this.manifest.version) < 0) {
                this.emit(this.downloaded?.version === this.manifest.version ? 'update-downloaded' : 'update-available', this.info(this.manifest));
                return;
            }
            this.manifest = manifest;
            this.envelope = envelope;
            this.emit(this.downloaded?.version === manifest.version ? 'update-downloaded' : 'update-available', this.info(manifest));
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                this.emit('update-not-available');
                return;
            }
            this.emit('error', error);
            throw error;
        }
    }

    async downloadUpdate(): Promise<void> {
        if (this.downloadPromise) return this.downloadPromise;
        if (!this.manifest || !this.envelope) throw new Error('Check for updates before downloading');
        if (this.downloaded?.version === this.manifest.version) {
            this.emit('update-downloaded', this.info(this.downloaded));
            return;
        }
        const manifest = this.manifest, envelope = this.envelope;
        this.downloadPromise = this.download(manifest, envelope);
        try { await this.downloadPromise; }
        catch (error) { this.emit('error', error); throw error; }
        finally { this.downloadPromise = null; }
    }

    private async download(manifest: MacUpdateManifest, envelope: Buffer): Promise<void> {
        this.ensureCache();
        const artifact = manifest.artifacts[this.options.arch];
        const disk = await fs.promises.statfs(this.options.cacheDirectory);
        if (disk.bavail * disk.bsize < artifact.size * 2 + 128 * 1024 * 1024) throw new Error('Not enough free space to download this update');
        const temporary = `${this.archive}.${randomBytes(8).toString('hex')}.part`;
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 10 * 60 * 1000);
        let transferred = 0, lastEvent = 0;
        const started = Date.now(), hash = createHash('sha256');
        try {
            const response = await axios.get(artifact.url, {
                responseType: 'stream', timeout: 30000, signal: controller.signal,
                headers: { 'User-Agent': 'Twitch-VOD-Manager' },
                beforeRedirect: (options) => { if (options.protocol !== 'https:') throw new Error('Insecure update redirect'); },
            });
            const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
                transferred += chunk.length;
                if (transferred > artifact.size) { callback(new Error('Update exceeds the signed size')); return; }
                hash.update(chunk);
                if (Date.now() - lastEvent >= 100 || transferred === artifact.size) {
                    lastEvent = Date.now();
                    this.emit('download-progress', { percent: transferred / artifact.size * 100, transferred, total: artifact.size, bytesPerSecond: transferred / Math.max(1, (Date.now() - started) / 1000) });
                }
                callback(null, chunk);
            } });
            await pipeline(response.data, meter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
            if (transferred !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('Update checksum does not match. Nothing was installed.');
            await fs.promises.rename(temporary, this.archive);
            writeJson(this.metadata, JSON.parse(envelope.toString()));
            this.downloaded = manifest;
            this.emit('update-downloaded', this.info(manifest));
        } finally {
            clearTimeout(deadline);
            await fs.promises.rm(temporary, { force: true });
        }
    }

    private async verifyArchive(manifest: MacUpdateManifest): Promise<void> {
        const stat = await fs.promises.lstat(this.archive), artifact = manifest.artifacts[this.options.arch];
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size || await checksum(this.archive) !== artifact.sha256) throw new Error('Cached update failed verification');
    }

    async prepareInstall(): Promise<void> {
        if (this.prepared) throw new Error('Update installation is already being prepared');
        await this.restore();
        if (!this.downloaded) throw new Error('Download the update first');
        const manifest = this.downloaded;
        const target = await fs.promises.realpath(this.options.targetApp);
        if (!target.endsWith('.app') || target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) throw new Error('Move the app to Applications before installing an update');
        const parent = path.dirname(target);
        await fs.promises.access(parent, fs.constants.W_OK);
        const disk = await fs.promises.statfs(parent);
        if (disk.bavail * disk.bsize < manifest.artifacts[this.options.arch].size * 5 + 128 * 1024 * 1024) throw new Error('Not enough free space to install this update');
        await this.verifyArchive(manifest);
        const listing = await execute('/usr/bin/unzip', ['-Z', '-1', this.archive], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
        validateMacArchiveEntries(listing.stdout);
        const token = randomBytes(32).toString('hex');
        const extraction = await fs.promises.mkdtemp(path.join(parent, '.twitch-vod-extract-'));
        const stagedApp = path.join(parent, `.Twitch-VOD-Manager-update-${token}.app`);
        try {
            await execute('/usr/bin/ditto', ['-x', '-k', this.archive, extraction], { timeout: 180000 });
            const extracted = path.join(extraction, 'Twitch VOD Manager.app');
            await assertBundle(extracted, manifest.version, this.options.arch);
            await fs.promises.rename(extracted, stagedApp);
            this.stagedApp = stagedApp;
            const directory = await fs.promises.realpath(this.options.cacheDirectory);
            const plan = path.join(directory, `plan-${token}.json`);
            writeJson(plan, { schema: 1, parentPid: process.pid, targetApp: target, stagedApp, expectedBundleId: MAC_UPDATE_BUNDLE_ID, expectedVersion: manifest.version, healthToken: token, stateDirectory: directory, userDataDirectory: await fs.promises.realpath(path.dirname(this.options.cacheDirectory)) });
            await fs.promises.access(this.options.helperPath, fs.constants.X_OK);
            // Keep the running helper outside the bundle it will replace.
            const helper = path.join(directory, `installer-${token}`);
            await fs.promises.copyFile(this.options.helperPath, helper, fs.constants.COPYFILE_EXCL);
            await fs.promises.chmod(helper, 0o700);
            if (await checksum(helper) !== await checksum(this.options.helperPath)) throw new Error('Installer copy failed verification');
            const child = spawn(helper, ['--install', plan], { detached: true, stdio: 'ignore' });
            this.prepared = { token, child, directory };
            child.on('error', (error) => this.options.log('mac-update-helper-error', String(error)));
            child.unref();
            await this.waitForMarker('ready', 100000);
        } catch (error) {
            await this.cancelInstall();
            throw error;
        } finally { await fs.promises.rm(extraction, { recursive: true, force: true }); }
    }

    private async waitForMarker(kind: 'ready' | 'armed', timeout: number): Promise<void> {
        const prepared = this.prepared;
        if (!prepared) throw new Error('Update installer is not prepared');
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            const marker = path.join(prepared.directory, `${kind}-${prepared.token}.json`);
            try {
                const state = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
                if (state.schema === 1 && state.token === prepared.token) return;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            if (!prepared.child.pid || prepared.child.exitCode !== null || prepared.child.signalCode !== null) {
                let message = 'Update installer exited before it was ready';
                try {
                    const result = JSON.parse(await fs.promises.readFile(path.join(prepared.directory, `result-${prepared.token}.json`), 'utf8'));
                    if (result.token === prepared.token && typeof result.message === 'string') message = result.message;
                } catch { /* The child may have failed before it could write a result. */ }
                throw new Error(message);
            }
            await wait(100);
        }
        throw new Error('Update installer did not become ready in time');
    }

    async armInstall(): Promise<void> {
        if (!this.prepared) throw new Error('Update installer is not prepared');
        const { directory, token } = this.prepared;
        writeJson(path.join(directory, `proceed-${token}.json`), { schema: 1, token });
        await this.waitForMarker('armed', 10000);
    }

    async cancelInstall(): Promise<void> {
        const prepared = this.prepared;
        this.prepared = null;
        if (prepared) {
            try { await fs.promises.rm(path.join(prepared.directory, `proceed-${prepared.token}.json`), { force: true }); }
            catch (error) { this.options.log('mac-update-cancel-marker', String(error)); }
            finally { prepared.child.kill('SIGTERM'); }
            // Never remove a stage while the helper could still be inspecting it.
            if (prepared.child.exitCode === null && prepared.child.signalCode === null) await Promise.race([new Promise<void>((resolve) => prepared.child.once('exit', () => resolve())), wait(2000)]);
        }
        if (this.stagedApp && (!prepared || prepared.child.exitCode !== null || prepared.child.signalCode !== null)) {
            try { await fs.promises.rm(this.stagedApp, { recursive: true, force: true }); }
            catch (error) { this.options.log('mac-update-cancel-stage', String(error)); }
            this.stagedApp = null;
        }
    }

    acknowledgeStartup(argv: string[], healthy: boolean): void {
        if (!healthy) return;
        const token = argv.find((arg) => arg.startsWith('--mac-update-token='))?.slice('--mac-update-token='.length);
        const directory = argv.find((arg) => arg.startsWith('--mac-update-state='))?.slice('--mac-update-state='.length);
        if (!token || !/^[a-f0-9]{64}$/.test(token) || !directory) return;
        this.ensureCache();
        if (directory !== fs.realpathSync(this.options.cacheDirectory)) return;
        const plan = JSON.parse(fs.readFileSync(path.join(directory, `plan-${token}.json`), 'utf8'));
        if (plan.healthToken !== token || plan.expectedVersion !== this.options.version || plan.targetApp !== fs.realpathSync(this.options.targetApp)) return;
        writeJson(path.join(directory, `health-${token}.json`), { schema: 1, token, version: this.options.version, pid: process.pid });
    }

    takeInstallOutcome(): 'rolled-back' | 'failed' | null {
        try {
            const outcome = JSON.parse(fs.readFileSync(path.join(this.options.cacheDirectory, 'result.json'), 'utf8'));
            if (outcome.schema !== 1 || !/^[a-f0-9]{64}$/.test(outcome.token) || !['rolled-back', 'failed'].includes(outcome.status)) return null;
            if (outcome.targetApp !== fs.realpathSync(this.options.targetApp)) return null;
            const marker = path.join(this.options.cacheDirectory, `notified-${outcome.token}.json`);
            if (fs.existsSync(marker)) return null;
            writeJson(marker, { token: outcome.token });
            this.options.log('mac-update-install-outcome', outcome);
            return outcome.status;
        } catch { return null; }
    }
}
