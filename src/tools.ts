import * as path from 'path';
import * as fs from 'fs';
import { spawn, execSync, spawnSync } from 'child_process';
import axios from 'axios';
import { createManagedToolInstaller, type ManagedToolInstaller, type ManagedToolStatus } from './main/domain/managed-tools';
import { APPLICATION_TOOL_MANIFEST } from './main/domain/tool-manifest';

// ==========================================
// CONSTANTS
// ==========================================
const TOOL_PATH_REFRESH_TTL_MS = 10 * 1000;

// ==========================================
// DEBUG LOG CALLBACK
// ==========================================
let _appendDebugLog: (message: string, details?: unknown) => void = () => {};

export function setDebugLogFn(fn: (message: string, details?: unknown) => void): void {
    _appendDebugLog = fn;
}

// ==========================================
// TOOL DIRECTORIES (set once from main)
// ==========================================
let TOOLS_STREAMLINK_DIR = '';
let TOOLS_FFMPEG_DIR = '';
let _getTempPath: () => string = () => '';
let macosToolResources = '';
let applicationToolManifest = APPLICATION_TOOL_MANIFEST;

export function initToolDirs(streamlinkDir: string, ffmpegDir: string, getTempPath: () => string, resourceDirectory = ''): void {
    TOOLS_STREAMLINK_DIR = streamlinkDir;
    TOOLS_FFMPEG_DIR = ffmpegDir;
    _getTempPath = getTempPath;
    macosToolResources = resourceDirectory;
    if (process.platform === 'darwin') {
        const manifestPath = path.join(resourceDirectory, 'manifest.json');
        // Development may run before tools are prepared; never download Windows tools on a Mac.
        if (fs.existsSync(manifestPath)) applicationToolManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    managedToolInstallers.clear();
}

// ==========================================
// CACHE STATE
// ==========================================
let streamlinkPathCache: string | null = null;
let streamlinkCommandCache: { command: string; prefixArgs: string[] } | null = null;
let ffmpegPathCache: string | null = null;
let ffprobePathCache: string | null = null;
let bundledStreamlinkPath: string | null = null;
let bundledFFmpegPath: string | null = null;
let bundledFFprobePath: string | null = null;
let verifiedStreamlinkCommandKey: string | null = null;
let verifiedFfmpegCommandKey: string | null = null;
let bundledToolPathSignature = '';
let bundledToolPathRefreshedAt = 0;
const managedToolInstallers = new Map<'streamlink' | 'ffmpeg', ManagedToolInstaller>();

// ==========================================
// INTERNAL HELPERS
// ==========================================
function findFileRecursive(rootDir: string, fileName: string): string | null {
    const direct = path.join(rootDir, fileName);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    if (!fs.existsSync(rootDir)) return null;

    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
            return fullPath;
        }

        if (entry.isDirectory()) {
            const nested = findFileRecursive(fullPath, fileName);
            if (nested) return nested;
        }
    }

    return null;
}

function getDirectoryMtimeMs(directoryPath: string): number {
    try {
        return fs.statSync(directoryPath).mtimeMs;
    } catch {
        return 0;
    }
}

function getCommandCacheKey(command: string, args: string[]): string {
    return [command, ...args].join('\u0000');
}

export function canExecute(cmd: string): boolean {
    try {
        execSync(cmd, { stdio: 'ignore', windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

export function canExecuteCommand(command: string, args: string[]): boolean {
    try {
        const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
        return result.status === 0;
    } catch {
        return false;
    }
}

// ==========================================
// VERIFIED COMMAND CACHES
// ==========================================
export function cacheVerifiedStreamlinkCommand(command: string, args: string[]): void {
    verifiedStreamlinkCommandKey = getCommandCacheKey(command, args);
}

export function isVerifiedStreamlinkCommand(command: string, args: string[]): boolean {
    return verifiedStreamlinkCommandKey === getCommandCacheKey(command, args);
}

export function cacheVerifiedFfmpegCommands(ffmpegCommand: string, ffprobeCommand: string): void {
    verifiedFfmpegCommandKey = getCommandCacheKey(ffmpegCommand, [ffprobeCommand]);
}

export function isVerifiedFfmpegCommands(ffmpegCommand: string, ffprobeCommand: string): boolean {
    return verifiedFfmpegCommandKey === getCommandCacheKey(ffmpegCommand, [ffprobeCommand]);
}

export function invalidateVerifiedToolCaches(): void {
    verifiedStreamlinkCommandKey = null;
    verifiedFfmpegCommandKey = null;
}

// ==========================================
// TOOL PATH DISCOVERY
// ==========================================
export function getStreamlinkPath(): string {
    // The Mac app owns its runtime. Probing /usr/bin/python3 before the first
    // install can launch Apple's Command Line Tools installer on a clean Mac.
    if (process.platform === 'darwin') return path.join(TOOLS_STREAMLINK_DIR, 'streamlink');
    if (streamlinkPathCache) {
        if (streamlinkPathCache === 'streamlink' || fs.existsSync(streamlinkPathCache)) {
            return streamlinkPathCache;
        }
        streamlinkPathCache = null;
    }

    if (bundledStreamlinkPath && fs.existsSync(bundledStreamlinkPath)) {
        streamlinkPathCache = bundledStreamlinkPath;
        return streamlinkPathCache;
    }

    try {
        if (process.platform === 'win32') {
            const result = execSync('where streamlink', { encoding: 'utf-8' });
            const paths = result.trim().split('\n');
            if (paths.length > 0) {
                streamlinkPathCache = paths[0].trim();
                return streamlinkPathCache;
            }
        } else {
            const result = execSync('which streamlink', { encoding: 'utf-8' });
            streamlinkPathCache = result.trim();
            return streamlinkPathCache;
        }
    } catch { }

    const commonPaths = [
        'C:\\Program Files\\Streamlink\\bin\\streamlink.exe',
        'C:\\Program Files (x86)\\Streamlink\\bin\\streamlink.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Streamlink', 'bin', 'streamlink.exe')
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            streamlinkPathCache = p;
            return streamlinkPathCache;
        }
    }

    streamlinkPathCache = 'streamlink';
    return streamlinkPathCache;
}

export function getStreamlinkCommand(): { command: string; prefixArgs: string[] } {
    if (streamlinkCommandCache) {
        return streamlinkCommandCache;
    }

    const directPath = getStreamlinkPath();
    if (directPath !== 'streamlink' || canExecute('streamlink --version')) {
        streamlinkCommandCache = { command: directPath, prefixArgs: [] };
        return streamlinkCommandCache;
    }

    if (process.platform === 'win32') {
        if (canExecute('py -3 -m streamlink --version')) {
            streamlinkCommandCache = { command: 'py', prefixArgs: ['-3', '-m', 'streamlink'] };
            return streamlinkCommandCache;
        }

        if (canExecute('python -m streamlink --version')) {
            streamlinkCommandCache = { command: 'python', prefixArgs: ['-m', 'streamlink'] };
            return streamlinkCommandCache;
        }
    } else {
        if (canExecute('python3 -m streamlink --version')) {
            streamlinkCommandCache = { command: 'python3', prefixArgs: ['-m', 'streamlink'] };
            return streamlinkCommandCache;
        }

        if (canExecute('python -m streamlink --version')) {
            streamlinkCommandCache = { command: 'python', prefixArgs: ['-m', 'streamlink'] };
            return streamlinkCommandCache;
        }
    }

    streamlinkCommandCache = { command: directPath, prefixArgs: [] };
    return streamlinkCommandCache;
}

export function getFFmpegPath(): string {
    if (process.platform === 'darwin') return path.join(TOOLS_FFMPEG_DIR, 'ffmpeg');
    if (ffmpegPathCache) {
        if (ffmpegPathCache === 'ffmpeg' || fs.existsSync(ffmpegPathCache)) {
            return ffmpegPathCache;
        }
        ffmpegPathCache = null;
    }

    if (bundledFFmpegPath && fs.existsSync(bundledFFmpegPath)) {
        ffmpegPathCache = bundledFFmpegPath;
        return ffmpegPathCache;
    }

    try {
        if (process.platform === 'win32') {
            const result = execSync('where ffmpeg', { encoding: 'utf-8' });
            const paths = result.trim().split('\n');
            if (paths.length > 0) {
                ffmpegPathCache = paths[0].trim();
                return ffmpegPathCache;
            }
        } else {
            const result = execSync('which ffmpeg', { encoding: 'utf-8' });
            ffmpegPathCache = result.trim();
            return ffmpegPathCache;
        }
    } catch { }

    const commonPaths = [
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            ffmpegPathCache = p;
            return ffmpegPathCache;
        }
    }

    ffmpegPathCache = 'ffmpeg';
    return ffmpegPathCache;
}

export function getFFprobePath(): string {
    if (process.platform === 'darwin') return path.join(TOOLS_FFMPEG_DIR, 'ffprobe');
    if (ffprobePathCache) {
        if (ffprobePathCache === 'ffprobe' || ffprobePathCache === 'ffprobe.exe' || fs.existsSync(ffprobePathCache)) {
            return ffprobePathCache;
        }
        ffprobePathCache = null;
    }

    if (bundledFFprobePath && fs.existsSync(bundledFFprobePath)) {
        ffprobePathCache = bundledFFprobePath;
        return ffprobePathCache;
    }

    const ffmpegPath = getFFmpegPath();
    const ffprobeExe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

    if (ffmpegPath === 'ffmpeg') {
        ffprobePathCache = ffprobeExe;
        return ffprobePathCache;
    }

    const derivedFfprobePath = path.join(path.dirname(ffmpegPath), ffprobeExe);
    if (fs.existsSync(derivedFfprobePath)) {
        ffprobePathCache = derivedFfprobePath;
        return ffprobePathCache;
    }

    ffprobePathCache = ffprobeExe;
    return ffprobePathCache;
}

// ==========================================
// BUNDLED TOOL PATH REFRESH
// ==========================================
export function refreshBundledToolPaths(force = false): void {
    const now = Date.now();
    const signature = `${getDirectoryMtimeMs(TOOLS_STREAMLINK_DIR)}|${getDirectoryMtimeMs(TOOLS_FFMPEG_DIR)}`;

    if (!force && signature === bundledToolPathSignature && (now - bundledToolPathRefreshedAt) < TOOL_PATH_REFRESH_TTL_MS) {
        return;
    }

    bundledToolPathSignature = signature;
    bundledToolPathRefreshedAt = now;

    const nextBundledStreamlinkPath = findFileRecursive(TOOLS_STREAMLINK_DIR, process.platform === 'win32' ? 'streamlink.exe' : 'streamlink');
    const nextBundledFFmpegPath = findFileRecursive(TOOLS_FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const nextBundledFFprobePath = findFileRecursive(TOOLS_FFMPEG_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

    const changed =
        nextBundledStreamlinkPath !== bundledStreamlinkPath ||
        nextBundledFFmpegPath !== bundledFFmpegPath ||
        nextBundledFFprobePath !== bundledFFprobePath;

    bundledStreamlinkPath = nextBundledStreamlinkPath;
    bundledFFmpegPath = nextBundledFFmpegPath;
    bundledFFprobePath = nextBundledFFprobePath;

    if (changed) {
        streamlinkPathCache = null;
        ffmpegPathCache = null;
        ffprobePathCache = null;
        streamlinkCommandCache = null;
        invalidateVerifiedToolCaches();
    }
}

// ==========================================
// DOWNLOAD & EXTRACT HELPERS
// ==========================================
async function downloadFile(url: string, destinationPath: string): Promise<boolean> {
    try {
        const response = await axios.get(url, { responseType: 'stream', timeout: 120000 });

        await new Promise<void>((resolve, reject) => {
            const writer = fs.createWriteStream(destinationPath);
            response.data.pipe(writer);
            writer.on('finish', () => resolve());
            writer.on('error', (err) => reject(err));
        });

        return true;
    } catch (e) {
        _appendDebugLog('download-file-failed', { url, destinationPath, error: String(e) });
        return false;
    }
}

async function extractZip(zipPath: string, destinationDir: string): Promise<boolean> {
    try {
        fs.mkdirSync(destinationDir, { recursive: true });

        const command = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`;

        await new Promise<void>((resolve, reject) => {
            const proc = process.platform === 'darwin'
                ? spawn('/usr/bin/ditto', ['-x', '-k', zipPath, destinationDir])
                : spawn('powershell', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Command',
                command
            ], { windowsHide: true });

            let stderr = '';
            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Expand-Archive exit code ${code}: ${stderr.trim()}`));
                }
            });

            proc.on('error', (err) => reject(err));
        });

        return true;
    } catch (e) {
        _appendDebugLog('extract-zip-failed', { zipPath, destinationDir, error: String(e) });
        return false;
    }
}

function getManagedToolInstaller(toolId: 'streamlink' | 'ffmpeg'): ManagedToolInstaller {
    const existing = managedToolInstallers.get(toolId);
    if (existing) return existing;

    const installationDirectory = toolId === 'streamlink' ? TOOLS_STREAMLINK_DIR : TOOLS_FFMPEG_DIR;
    const installer = createManagedToolInstaller({
        installationDirectory,
        temporaryDirectory: _getTempPath(),
        download: async (sourceUrl, archivePath) => {
            if (process.platform === 'darwin') {
                const manifest = applicationToolManifest[toolId];
                const bundled = path.join(macosToolResources, path.basename(manifest.archiveName));
                if (!fs.existsSync(bundled)) throw new Error('Bundled macOS tools are missing. Run npm run tools:mac before building.');
                await fs.promises.copyFile(bundled, archivePath);
                return;
            }
            if (!await downloadFile(sourceUrl, archivePath)) {
                throw new Error('tool archive download failed');
            }
        },
        extract: async (archivePath, destinationPath) => {
            if (!await extractZip(archivePath, destinationPath)) {
                throw new Error('tool archive extraction failed');
            }
        },
        diagnostic: (message, details) => _appendDebugLog(message, details)
    });
    managedToolInstallers.set(toolId, installer);
    return installer;
}

export interface ManagedToolStatuses {
    streamlink: ManagedToolStatus;
    ffmpeg: ManagedToolStatus;
}

export async function getManagedToolStatuses(): Promise<ManagedToolStatuses> {
    return {
        streamlink: await getManagedToolInstaller('streamlink').status(applicationToolManifest.streamlink),
        ffmpeg: await getManagedToolInstaller('ffmpeg').status(applicationToolManifest.ffmpeg)
    };
}

export async function repairManagedTools(): Promise<{ success: boolean; statuses: ManagedToolStatuses }> {
    const [streamlink, ffmpeg] = await Promise.all([
        getManagedToolInstaller('streamlink').repair(applicationToolManifest.streamlink),
        getManagedToolInstaller('ffmpeg').repair(applicationToolManifest.ffmpeg)
    ]);
    refreshBundledToolPaths(true);
    return {
        success: streamlink.success && ffmpeg.success,
        statuses: await getManagedToolStatuses()
    };
}

export async function resetManagedTools(): Promise<{ success: boolean; statuses: ManagedToolStatuses }> {
    const [streamlink, ffmpeg] = await Promise.all([
        getManagedToolInstaller('streamlink').reset(applicationToolManifest.streamlink),
        getManagedToolInstaller('ffmpeg').reset(applicationToolManifest.ffmpeg)
    ]);
    refreshBundledToolPaths(true);
    return {
        success: streamlink.state !== 'installing' && ffmpeg.state !== 'installing',
        statuses: await getManagedToolStatuses()
    };
}

// ==========================================
// AUTO-INSTALL TOOLS
// ==========================================
export async function ensureStreamlinkInstalled(): Promise<boolean> {
    refreshBundledToolPaths();

    const manifest = applicationToolManifest.streamlink;
    const managedStatus = await getManagedToolInstaller('streamlink').status(manifest);
    const requiresManagedRepair = (process.platform === 'darwin' || Boolean(bundledStreamlinkPath)) && !managedStatus.verified;
    const current = getStreamlinkCommand();
    const versionArgs = [...current.prefixArgs, '--version'];
    if (!requiresManagedRepair && isVerifiedStreamlinkCommand(current.command, versionArgs)) {
        return true;
    }

    if (!requiresManagedRepair && canExecuteCommand(current.command, versionArgs)) {
        cacheVerifiedStreamlinkCommand(current.command, versionArgs);
        return true;
    }

    if (process.platform !== 'win32' && process.platform !== 'darwin') {
        return false;
    }

    _appendDebugLog('streamlink-install-start');
    try {
        const result = await getManagedToolInstaller('streamlink').install(manifest);
        if (!result.success) {
            _appendDebugLog('streamlink-install-failed', { error: result.error, status: result.status });
            return false;
        }

        refreshBundledToolPaths(true);
        streamlinkCommandCache = null;

        const cmd = getStreamlinkCommand();
        const installedVersionArgs = [...cmd.prefixArgs, '--version'];
        const works = canExecuteCommand(cmd.command, installedVersionArgs);
        if (works) {
            cacheVerifiedStreamlinkCommand(cmd.command, installedVersionArgs);
        }
        _appendDebugLog('streamlink-install-finished', { works, command: cmd.command, prefixArgs: cmd.prefixArgs });
        return works;
    } catch (e) {
        _appendDebugLog('streamlink-install-failed', String(e));
        return false;
    }
}

export async function ensureFfmpegInstalled(): Promise<boolean> {
    refreshBundledToolPaths();

    const manifest = applicationToolManifest.ffmpeg;
    const managedStatus = await getManagedToolInstaller('ffmpeg').status(manifest);
    const requiresManagedRepair = (process.platform === 'darwin' || Boolean(bundledFFmpegPath || bundledFFprobePath)) && !managedStatus.verified;
    const ffmpegPath = getFFmpegPath();
    const ffprobePath = getFFprobePath();
    if (!requiresManagedRepair && isVerifiedFfmpegCommands(ffmpegPath, ffprobePath)) {
        return true;
    }

    if (!requiresManagedRepair && canExecuteCommand(ffmpegPath, ['-version']) && canExecuteCommand(ffprobePath, ['-version'])) {
        cacheVerifiedFfmpegCommands(ffmpegPath, ffprobePath);
        return true;
    }

    if (process.platform !== 'win32' && process.platform !== 'darwin') {
        return false;
    }

    _appendDebugLog('ffmpeg-install-start');
    try {
        const result = await getManagedToolInstaller('ffmpeg').install(manifest);
        if (!result.success) {
            _appendDebugLog('ffmpeg-install-failed', { error: result.error, status: result.status });
            return false;
        }

        refreshBundledToolPaths(true);

        const newFfmpegPath = getFFmpegPath();
        const newFfprobePath = getFFprobePath();
        const works = canExecuteCommand(newFfmpegPath, ['-version']) && canExecuteCommand(newFfprobePath, ['-version']);
        if (works) {
            cacheVerifiedFfmpegCommands(newFfmpegPath, newFfprobePath);
        }
        _appendDebugLog('ffmpeg-install-finished', { works, ffmpeg: newFfmpegPath, ffprobe: newFfprobePath });
        return works;
    } catch (e) {
        _appendDebugLog('ffmpeg-install-failed', String(e));
        return false;
    }
}
