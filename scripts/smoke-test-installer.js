// Restored from 85d6291^; current product name and in-place reinstall coverage added.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appGuid = '08429788-303d-53b6-a4f9-894401712c7e';
const shortcutName = packageJson.build.nsis.shortcutName;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    timeout: 240000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr })}`);
  }
  return result;
}

function findUninstaller(installationDirectory) {
  if (!fs.existsSync(installationDirectory)) return '';
  return fs.readdirSync(installationDirectory)
    .filter((name) => /^uninstall.*\.exe$/i.test(name))
    .map((name) => path.join(installationDirectory, name))[0] || '';
}

function createInstallerPhases(smokeRoot, folders) {
  if (!path.win32.isAbsolute(smokeRoot)) throw new Error(`Installer smoke root is not absolute: ${smokeRoot}`);
  for (const name of ['commonDesktop', 'commonPrograms', 'currentDesktop', 'currentPrograms']) {
    if (!path.win32.isAbsolute(folders[name] || '')) throw new Error(`Windows shell folder ${name} is invalid: ${folders[name] || ''}`);
  }
  return [
    {
      desktopShortcut: path.win32.join(folders.currentDesktop, `${shortcutName}.lnk`),
      flag: '/currentuser',
      hive: 'HKCU',
      installationDirectory: path.win32.join(smokeRoot, 'currentuser', 'app'),
      oppositeHive: 'HKLM',
      startMenuShortcut: path.win32.join(folders.currentPrograms, `${shortcutName}.lnk`)
    },
    {
      desktopShortcut: path.win32.join(folders.commonDesktop, `${shortcutName}.lnk`),
      flag: '/allusers',
      hive: 'HKLM',
      installationDirectory: path.win32.join(smokeRoot, 'allusers', 'app'),
      oppositeHive: 'HKCU',
      startMenuShortcut: path.win32.join(folders.commonPrograms, `${shortcutName}.lnk`)
    }
  ].map((phase) => ({
    ...phase,
    executablePath: path.win32.join(phase.installationDirectory, `${packageJson.build.productName}.exe`),
    iconPath: path.win32.join(phase.installationDirectory, 'resources', 'app-icons', `icon-${packageJson.version}.ico`),
    installArguments: ['/S', phase.flag, `/D=${phase.installationDirectory}`]
  }));
}

function normalizeWindowsPath(candidate) {
  return path.win32.resolve(String(candidate)).replaceAll('/', '\\').toLowerCase();
}

function canonicalWindowsPath(candidate) {
  try {
    return normalizeWindowsPath(fs.realpathSync.native(candidate));
  } catch {
    return normalizeWindowsPath(candidate);
  }
}

function assertPathInside(targetPath, parentPath) {
  const relative = path.win32.relative(path.win32.resolve(parentPath), path.win32.resolve(targetPath));
  if (!relative || relative.startsWith('..\\') || relative === '..' || path.win32.isAbsolute(relative)) {
    throw new Error(`Refusing recursive cleanup outside its parent: ${JSON.stringify({ targetPath, parentPath })}`);
  }
}

function assertFile(filePath, label) {
  let isFile = false;
  try {
    isFile = fs.statSync(filePath).isFile();
  } catch {}
  if (!isFile) throw new Error(`${label} is missing: ${filePath}`);
}

function assertShortcutDetails(details, { expectedIcon, expectedTarget, pathExists = fs.existsSync }) {
  const targetPath = String(details.targetPath || '');
  const iconPath = String(details.iconLocation || '').replace(/,\s*-?\d+$/, '');
  if (canonicalWindowsPath(targetPath) !== canonicalWindowsPath(expectedTarget)) {
    throw new Error(`Shortcut target mismatch: ${JSON.stringify({ actual: targetPath, expected: expectedTarget })}`);
  }
  if (canonicalWindowsPath(iconPath) !== canonicalWindowsPath(expectedIcon)) {
    throw new Error(`Shortcut icon mismatch: ${JSON.stringify({ actual: iconPath, expected: expectedIcon })}`);
  }
  if (!pathExists(targetPath)) throw new Error(`Shortcut target is missing: ${targetPath}`);
  if (!pathExists(iconPath)) throw new Error(`Shortcut icon is missing: ${iconPath}`);
}

function registryKeys(hive) {
  return {
    install: `${hive}\\Software\\${appGuid}`,
    uninstall: `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appGuid}`
  };
}

function assertInstalledRegistration(phase, { expectedUninstallerPath, keyExists, readRegistryValue }) {
  const selectedKeys = registryKeys(phase.hive);
  const oppositeKeys = registryKeys(phase.oppositeHive);
  if (!keyExists(selectedKeys.install) || !keyExists(selectedKeys.uninstall)) {
    throw new Error(`Installer did not register the ${phase.flag} installation in ${phase.hive}`);
  }
  if (keyExists(oppositeKeys.install) || keyExists(oppositeKeys.uninstall)) {
    throw new Error(`Installer left registration in the opposite installation scope ${phase.oppositeHive}`);
  }

  const registeredLocation = readRegistryValue(selectedKeys.install, 'InstallLocation');
  if (normalizeWindowsPath(registeredLocation) !== normalizeWindowsPath(phase.installationDirectory)) {
    throw new Error(`Registered install location mismatch: ${JSON.stringify({ actual: registeredLocation, expected: phase.installationDirectory })}`);
  }

  const uninstallString = String(readRegistryValue(selectedKeys.uninstall, 'UninstallString') || '');
  const quietUninstallString = String(readRegistryValue(selectedKeys.uninstall, 'QuietUninstallString') || '');
  const expectedUninstallString = `"${expectedUninstallerPath}" ${phase.flag}`;
  const expectedQuietUninstallString = `${expectedUninstallString} /S`;
  if (uninstallString.toLowerCase() !== expectedUninstallString.toLowerCase() || quietUninstallString.toLowerCase() !== expectedQuietUninstallString.toLowerCase()) {
    throw new Error(`Registered uninstall command mismatch: ${JSON.stringify({ actual: { quietUninstallString, uninstallString }, expected: { quietUninstallString: expectedQuietUninstallString, uninstallString: expectedUninstallString } })}`);
  }
}

function assertInstallerSurfaceClean(phases, { keyExists, pathExists = fs.existsSync }) {
  const registrySurface = [...new Set(phases.flatMap((phase) => Object.values(registryKeys(phase.hive))))];
  const shortcutSurface = [...new Set(phases.flatMap((phase) => [phase.startMenuShortcut, phase.desktopShortcut]))];
  const existing = [
    ...registrySurface.filter(keyExists),
    ...shortcutSurface.filter(pathExists)
  ];
  if (existing.length > 0) {
    throw new Error(`Installer smoke requires a clean registry and shortcut surface: ${existing.join(', ')}`);
  }
}

function registryKeyExists(key) {
  const result = spawnSync('reg.exe', ['query', key], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Registry query failed: ${JSON.stringify({ key, status: result.status, stdout: result.stdout, stderr: result.stderr })}`);
}

function readRegistryValue(key, name) {
  const result = spawnSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new Error(`Registry value query failed: ${JSON.stringify({ key, name, status: result.status, stdout: result.stdout, stderr: result.stderr })}`);
  }
  const valueMatch = result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\S+)\s+REG_\w+\s+(.*)$/i))
    .find((match) => match?.[1]?.toLowerCase() === name.toLowerCase());
  return valueMatch?.[2]?.trim() ?? null;
}

function runPowerShell(script, environment = {}) {
  const result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...environment }
  });
  return result.stdout.trim().replace(/^\uFEFF/, '');
}

function readShellFolders() {
  return JSON.parse(runPowerShell("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [ordered]@{ currentPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs); commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms); currentDesktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory); commonDesktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory) } | ConvertTo-Json -Compress"));
}

function readShortcutDetails(shortcutPath) {
  const script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:TVM_INSTALLER_SMOKE_SHORTCUT); [ordered]@{ targetPath = $shortcut.TargetPath; iconLocation = $shortcut.IconLocation } | ConvertTo-Json -Compress";
  return JSON.parse(runPowerShell(script, { TVM_INSTALLER_SMOKE_SHORTCUT: shortcutPath }));
}

function assertAdministrator() {
  runPowerShell("$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($identity); if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }");
}

function assertCleanInstallerSmokeSurface(phases) {
  assertInstallerSurfaceClean(phases, { keyExists: registryKeyExists });
}

function seedOrphanedRegistrations(phase, smokeRoot) {
  for (const hive of ['HKCU', 'HKLM']) {
    const keys = registryKeys(hive);
    const orphanedLocation = path.win32.join(smokeRoot, 'orphaned', phase.flag.slice(1), hive, 'app');
    const orphanedUninstaller = path.win32.join(orphanedLocation, `Uninstall ${packageJson.build.productName}.exe`);
    run('reg.exe', ['add', keys.install, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', orphanedLocation, '/f']);
    run('reg.exe', ['add', keys.uninstall, '/v', 'UninstallString', '/t', 'REG_SZ', '/d', `"${orphanedUninstaller}" ${phase.flag}`, '/f']);
  }
}

function cleanupInstallerSurface(phases) {
  const keys = [...new Set(phases.flatMap((phase) => Object.values(registryKeys(phase.hive))))];
  for (const key of keys) {
    spawnSync('reg.exe', ['delete', key, '/f'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  }
  const shortcuts = [...new Set(phases.flatMap((phase) => [phase.startMenuShortcut, phase.desktopShortcut]))];
  for (const shortcut of shortcuts) fs.rmSync(shortcut, { force: true });
}

function verifyInstalledPhase(phase) {
  assertFile(phase.executablePath, 'Installed executable');
  assertFile(phase.iconPath, 'Installed shortcut icon');
  assertFile(phase.startMenuShortcut, 'Start Menu shortcut');
  assertFile(phase.desktopShortcut, 'Desktop shortcut');
  const uninstallerPath = findUninstaller(phase.installationDirectory);
  if (!uninstallerPath) throw new Error(`Installed uninstaller is missing: ${phase.installationDirectory}`);
  assertInstalledRegistration(phase, { expectedUninstallerPath: uninstallerPath, keyExists: registryKeyExists, readRegistryValue });
  for (const shortcutPath of [phase.startMenuShortcut, phase.desktopShortcut]) {
    assertShortcutDetails(readShortcutDetails(shortcutPath), {
      expectedIcon: phase.iconPath,
      expectedTarget: phase.executablePath
    });
  }
  return uninstallerPath;
}

async function waitForInstallerSurfaceClean(phases, { keyExists, pathExists = fs.existsSync, timeoutMs = 30000, pollIntervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertInstallerSurfaceClean(phases, { keyExists, pathExists });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

async function waitForPathRemoval(targetPath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(targetPath)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function assertHostedWindowsCi(environment = process.env, platform = process.platform) {
  const serverUrl = String(environment.GITHUB_SERVER_URL || '').replace(/\/+$/, '').toLowerCase();
  const isGitHubActions = environment.GITHUB_ACTIONS === 'true' && environment.GITEA_ACTIONS !== 'true' && environment.RUNNER_ENVIRONMENT === 'github-hosted' && serverUrl === 'https://github.com';
  const isGiteaActions = environment.GITEA_ACTIONS === 'true' && serverUrl === 'https://git.24-music.de';
  const runnerOs = String(environment.RUNNER_OS || '').toLowerCase();
  if (platform !== 'win32' || environment.CI !== 'true' || runnerOs !== 'windows' || !environment.RUNNER_TEMP || !environment.GITHUB_RUN_ID || (!isGitHubActions && !isGiteaActions)) {
    throw new Error('Real installer smoke is restricted to an approved Windows Actions runner');
  }
}

async function verifyInstalledLaunch(executablePath, environment) {
  const { launchElectron } = require('./release-test-harness.cjs');
  const { verifyRuntime, cleanExit } = require('./smoke-test-release-package');
  // Use the shared native network/credential guards and resource tracking for
  // the actual NSIS-installed binary, confined to this owned environment.
  const session = await launchElectron(environment, { packaged: true, executablePath });
  try {
    await verifyRuntime(session, executablePath);
    await cleanExit(session.app);
  } finally {
    // An assertion failure must still release the installed executable before
    // the outer cleanup attempts to run its uninstaller.
    await session.app.close();
  }
}

async function main() {
  assertHostedWindowsCi();
  const installerPath = path.join(root, 'release', `Twitch-Downloader-Setup-${packageJson.version}.exe`);
  assertFile(installerPath, 'Installer');
  assertAdministrator();

  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp || !path.win32.isAbsolute(runnerTemp) || !fs.statSync(runnerTemp).isDirectory()) {
    throw new Error(`Hosted runner temp directory is invalid: ${runnerTemp || ''}`);
  }
  const { createEnvironment, closeSession } = require('./release-test-harness.cjs');
  // GitHub's RUNNER_TEMP can differ from the Windows account's TEMP directory.
  // createEnvironment is synchronous: scope these overrides to its allocation
  // and restore the parent process before starting any native subprocess.
  const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  let environment;
  try {
    process.env.TEMP = runnerTemp;
    process.env.TMP = runnerTemp;
    environment = createEnvironment('installer');
  } finally {
    for (const [name, value] of Object.entries(previousTemp)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const smokeRoot = environment.rootDir;
  let phases = [];
  const results = [];
  let ownsSurface = false;

  try {
    assertPathInside(smokeRoot, runnerTemp);
    phases = createInstallerPhases(smokeRoot, readShellFolders());
    assertCleanInstallerSmokeSurface(phases);
    ownsSurface = true;
    for (const phase of phases) {
      seedOrphanedRegistrations(phase, smokeRoot);
      run(installerPath, phase.installArguments, { cwd: smokeRoot });
      const uninstallerPath = verifyInstalledPhase(phase);
      await verifyInstalledLaunch(phase.executablePath, environment);
      // Running the same release over itself exercises NSIS in-place replacement.
      // Cross-version updater coverage belongs to the explicit post-publish gate.
      run(installerPath, phase.installArguments, { cwd: smokeRoot });
      verifyInstalledPhase(phase);
      await verifyInstalledLaunch(phase.executablePath, environment);
      run(uninstallerPath, [phase.flag, '/S'], { cwd: smokeRoot });
      if (!await waitForPathRemoval(phase.installationDirectory, 30000)) {
        throw new Error(`Silent uninstall left the installation directory behind: ${phase.installationDirectory}`);
      }
      await waitForInstallerSurfaceClean(phases, { keyExists: registryKeyExists });
      results.push({
        flag: phase.flag,
        hive: phase.hive,
        iconPath: phase.iconPath,
        installationDirectory: phase.installationDirectory,
        startMenuShortcut: phase.startMenuShortcut
      });
    }
    console.log(JSON.stringify({ failures: [], installerPath, results }, null, 2));
  } finally {
    if (ownsSurface) {
      for (const phase of [...phases].reverse()) {
        const uninstallerPath = findUninstaller(phase.installationDirectory);
        if (uninstallerPath) {
          spawnSync(uninstallerPath, [phase.flag, '/S'], { cwd: smokeRoot, timeout: 240000, windowsHide: true, stdio: 'ignore' });
        }
      }
      cleanupInstallerSurface(phases);
    }
    assertPathInside(smokeRoot, runnerTemp);
    await closeSession(environment);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  assertHostedWindowsCi,
  assertInstalledRegistration,
  assertInstallerSurfaceClean,
  assertPathInside,
  assertShortcutDetails,
  createInstallerPhases,
  readShortcutDetails,
  registryKeys,
  waitForInstallerSurfaceClean
};
