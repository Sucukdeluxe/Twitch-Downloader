import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';

const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = resolve(dirname(scriptPath), '..');
const typescriptCli = resolve(rootDirectory, 'node_modules', 'typescript', 'bin', 'tsc');
const electronSourceExecutable = process.platform === 'win32'
    ? resolve(rootDirectory, 'node_modules', 'electron', 'dist', 'electron.exe')
    : resolve(rootDirectory, 'node_modules', '.bin', 'electron');
let electronExecutable = electronSourceExecutable;
const outputDirectory = resolve(rootDirectory, 'dist');
const developmentProgramData = resolve(rootDirectory, '.dev-program-data');
const developmentUserData = resolve(rootDirectory, '.dev-user-data');
const developmentRelaunchCommand = `"${process.execPath}" "${scriptPath}" --once`;
const runOnce = process.argv.includes('--once');

let electronProcess;
let restarting = false;
let restartTimer;
let compiler;
let outputWatcher;

function run(command, args, options = {}) {
    return spawn(command, args, { cwd: rootDirectory, stdio: 'inherit', ...options });
}

function waitForExit(child) {
    return new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolveExit(code ?? 1));
    });
}

function startElectron() {
    electronProcess = run(electronExecutable, [`--user-data-dir=${developmentUserData}`, '.'], {
        env: {
            ...process.env,
            PROGRAMDATA: developmentProgramData,
            TWITCH_VOD_MANAGER_DATA_DIR: resolve(developmentProgramData, 'Twitch_VOD_Manager'),
            TWITCH_VOD_MANAGER_DEV: '1',
            TWITCH_VOD_MANAGER_RELAUNCH_COMMAND: developmentRelaunchCommand,
        },
    });
    electronProcess.once('exit', () => {
        electronProcess = undefined;
    });
    return electronProcess;
}

function restartElectron() {
    if (restarting) return;
    restarting = true;
    if (electronProcess) {
        electronProcess.once('exit', () => {
            restarting = false;
            startElectron();
        });
        electronProcess.kill();
        return;
    }
    restarting = false;
    startElectron();
}

function isElectronRestartTarget(fileName) {
    const baseName = fileName.replaceAll('\\', '/').split('/').at(-1) ?? '';
    if (baseName === 'renderer.js') return false;
    if (!baseName.startsWith('renderer') || !baseName.endsWith('.js')) return true;
    const suffix = baseName.slice(8);
    return suffix.length <= 4 || (suffix[0] !== '-' && suffix[0] !== '.');
}

function scheduleRestart(fileName) {
    if (!fileName || !isElectronRestartTarget(fileName.toString())) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restartElectron, 200);
}

function stop(child) {
    if (child && !child.killed) child.kill();
}

const initialCompile = run(process.execPath, [typescriptCli]);
const initialExitCode = await waitForExit(initialCompile);
if (initialExitCode !== 0) process.exit(initialExitCode);

if (process.platform === 'win32') {
    const helperPath = pathToFileURL(resolve(outputDirectory, 'main', 'dev-executable.js')).href;
    const { prepareWindowsDevExecutable } = await import(helperPath);
    electronExecutable = await prepareWindowsDevExecutable({
        sourcePath: electronSourceExecutable,
        destinationPath: resolve(rootDirectory, 'node_modules', 'electron', 'dist', 'Twitch VOD Manager.exe'),
        iconPath: resolve(rootDirectory, 'build', 'icon.ico'),
        version: '1.0.9',
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        outputWatcher?.close();
        clearTimeout(restartTimer);
        stop(compiler);
        stop(electronProcess);
        process.exit();
    });
}

if (runOnce) {
    process.exitCode = await waitForExit(startElectron());
} else {
    compiler = run(process.execPath, [typescriptCli, '--watch', '--preserveWatchOutput']);
    outputWatcher = watch(outputDirectory, { recursive: true }, (_, fileName) => scheduleRestart(fileName));
    startElectron();
}
