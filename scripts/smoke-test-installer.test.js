// Historical 85d6291^ installer contracts restored and adapted to the Windows public product.
// Native shortcut inspection is exercised by smoke-test-installer-process-scope.cjs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  assertHostedWindowsCi,
  assertInstalledRegistration,
  assertInstallerSurfaceClean,
  assertPathInside,
  assertShortcutDetails,
  waitForInstallerSurfaceClean,
  createInstallerPhases,
  registryKeys
} = require('./smoke-test-installer');

const builderInstallerSource = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'installer.nsh'), 'utf8');
const builderMultiUserSource = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'multiUser.nsh'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('real installer smoke cannot be enabled on a local workstation', () => {
  assert.throws(
    () => assertHostedWindowsCi({ TWITCH_VOD_MANAGER_INSTALLER_SMOKE: '1' }, 'win32'),
    /approved Windows Actions runner/
  );
});

test('real installer smoke rejects generic local CI identities', () => {
  assert.throws(() => assertHostedWindowsCi({
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '123',
    GITHUB_SERVER_URL: 'https://ci.example.test',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: 'C:\\runner-temp'
  }, 'win32'), /approved Windows Actions runner/);
});

test('real installer smoke accepts the GitHub Windows Actions identity', () => {
  assert.doesNotThrow(() => assertHostedWindowsCi({
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '123',
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_OS: 'Windows',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_TEMP: 'C:\\runner-temp'
  }, 'win32'));
});

test('real installer smoke rejects self-hosted GitHub and non-Windows execution', () => {
  const environment = {
    CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123',
    GITHUB_SERVER_URL: 'https://github.com', RUNNER_OS: 'Windows',
    RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: 'C:\\runner-temp'
  };
  for (const platform of ['darwin', 'linux']) {
    assert.throws(() => assertHostedWindowsCi(environment, platform), /approved Windows Actions runner/);
  }
  assert.throws(() => assertHostedWindowsCi({ ...environment, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'),
    /approved Windows Actions runner/);
});

test('real installer smoke accepts the git.24-music.de Gitea Windows Actions identity', () => {
  assert.doesNotThrow(() => assertHostedWindowsCi({
    CI: 'true',
    GITEA_ACTIONS: 'true',
    GITHUB_RUN_ID: '456',
    GITHUB_SERVER_URL: 'https://git.24-music.de',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: 'C:\\runner-temp'
  }, 'win32'));
  assert.doesNotThrow(() => assertHostedWindowsCi({
    CI: 'true',
    GITEA_ACTIONS: 'true',
    GITHUB_RUN_ID: '456',
    GITHUB_SERVER_URL: 'https://git.24-music.de',
    RUNNER_OS: 'windows',
    RUNNER_TEMP: 'C:\\runner-temp'
  }, 'win32'));
});

test('installer phases cover current user then all users with scope-correct paths', () => {
  const phases = createInstallerPhases('C:\\smoke', {
    commonDesktop: 'C:\\shared-desktop',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  });

  assert.deepStrictEqual(phases.map((phase) => ({
    flag: phase.flag,
    hive: phase.hive,
    installationDirectory: phase.installationDirectory,
    startMenuShortcut: phase.startMenuShortcut
  })), [
    {
      flag: '/currentuser',
      hive: 'HKCU',
      installationDirectory: 'C:\\smoke\\currentuser\\app',
      startMenuShortcut: 'C:\\user-programs\\Twitch Downloader.lnk'
    },
    {
      flag: '/allusers',
      hive: 'HKLM',
      installationDirectory: 'C:\\smoke\\allusers\\app',
      startMenuShortcut: 'C:\\shared-programs\\Twitch Downloader.lnk'
    }
  ]);
  for (const phase of phases) {
    assert.deepStrictEqual(phase.installArguments, ['/S', phase.flag, `/D=${phase.installationDirectory}`]);
  }
});

test('installer phases reject unresolved Windows shell folders', () => {
  assert.throws(() => createInstallerPhases('C:\\smoke', {
    commonDesktop: '',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  }), /commonDesktop/);
});

test('shortcut contract verifies the real target and versioned installed icon', () => {
  const expectedIcon = `C:\\smoke\\currentuser\\app\\resources\\app-icons\\icon-${packageJson.version}.ico`;
  const existingPaths = new Set([
    'c:\\smoke\\currentuser\\app\\twitch downloader.exe',
    expectedIcon.toLowerCase()
  ]);
  assert.doesNotThrow(() => assertShortcutDetails({
    iconLocation: `${expectedIcon},0`,
    targetPath: 'C:\\smoke\\currentuser\\app\\Twitch Downloader.exe'
  }, {
    expectedIcon,
    expectedTarget: 'C:\\smoke\\currentuser\\app\\Twitch Downloader.exe',
    pathExists: (candidate) => existingPaths.has(candidate.toLowerCase())
  }));
  assert.throws(() => assertShortcutDetails({
    iconLocation: 'C:\\Users\\runner\\AppData\\Local\\Twitch Downloader\\Shortcut Icons\\icon-1.0.17.ico,0',
    targetPath: 'C:\\smoke\\currentuser\\app\\Twitch Downloader.exe'
  }, {
    expectedIcon,
    expectedTarget: 'C:\\smoke\\currentuser\\app\\Twitch Downloader.exe',
    pathExists: () => true
  }), /icon/i);
});

test('registration contract proves the selected hive, install path and uninstall mode', () => {
  const [phase] = createInstallerPhases('C:\\smoke', {
    commonDesktop: 'C:\\shared-desktop',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  });
  const selected = registryKeys('HKCU');
  const values = new Map([
    [`${selected.install}|InstallLocation`, phase.installationDirectory],
    [`${selected.uninstall}|UninstallString`, `"C:\\smoke\\currentuser\\app\\Uninstall Twitch Downloader.exe" ${phase.flag}`],
    [`${selected.uninstall}|QuietUninstallString`, `"C:\\smoke\\currentuser\\app\\Uninstall Twitch Downloader.exe" ${phase.flag} /S`]
  ]);
  assert.doesNotThrow(() => assertInstalledRegistration(phase, {
    expectedUninstallerPath: 'C:\\smoke\\currentuser\\app\\Uninstall Twitch Downloader.exe',
    keyExists: (key) => [...values.keys()].some((entry) => entry.startsWith(`${key}|`)),
    readRegistryValue: (key, name) => values.get(`${key}|${name}`) ?? null
  }));
  values.set(`${registryKeys('HKLM').install}|InstallLocation`, 'C:\\orphan');
  assert.throws(() => assertInstalledRegistration(phase, {
    expectedUninstallerPath: 'C:\\smoke\\currentuser\\app\\Uninstall Twitch Downloader.exe',
    keyExists: (key) => [...values.keys()].some((entry) => entry.startsWith(`${key}|`)),
    readRegistryValue: (key, name) => values.get(`${key}|${name}`) ?? null
  }), /opposite installation scope/i);
  values.delete(`${registryKeys('HKLM').install}|InstallLocation`);
  values.set(`${selected.uninstall}|UninstallString`, `"C:\\smoke\\currentuser\\app\\Uninstall Twitch Downloader.exe" ${phase.flag} /unexpected`);
  assert.throws(() => assertInstalledRegistration(phase, {
    expectedUninstallerPath: 'C:\\smoke\\currentuser\\app\\Uninstall Twitch Downloader.exe',
    keyExists: (key) => [...values.keys()].some((entry) => entry.startsWith(`${key}|`)),
    readRegistryValue: (key, name) => values.get(`${key}|${name}`) ?? null
  }), /uninstall command mismatch/i);
});

test('bundled electron-builder writes the selected install mode into both uninstall commands', () => {
  assert.match(builderMultiUserSource, /!macro setInstallModePerUser[\s\S]*?SetShellVarContext current/);
  assert.match(builderMultiUserSource, /!macro setInstallModePerAllUsers[\s\S]*?SetShellVarContext all/);
  assert.match(builderInstallerSource, /\$installMode == "all"[\s\S]*?StrCpy \$0 "\/allusers"[\s\S]*?StrCpy \$0 "\/currentuser"/);
  assert.match(builderInstallerSource, /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString '"\$2" \$0'/);
  assert.match(builderInstallerSource, /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" QuietUninstallString '"\$2" \$0 \/S'/);
});

test('clean surface contract includes both registry hives and both shortcut scopes', () => {
  const phases = createInstallerPhases('C:\\smoke', {
    commonDesktop: 'C:\\shared-desktop',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  });
  assert.doesNotThrow(() => assertInstallerSurfaceClean(phases, {
    keyExists: () => false,
    pathExists: () => false
  }));
  assert.throws(() => assertInstallerSurfaceClean(phases, {
    keyExists: (key) => key === registryKeys('HKLM').uninstall,
    pathExists: (candidate) => candidate === phases[0].startMenuShortcut
  }), /HKLM.*Twitch Downloader\.lnk/i);
});

test('surface wait tolerates asynchronous uninstaller cleanup before the deadline', async () => {
  const phases = createInstallerPhases('C:\\smoke', {
    commonDesktop: 'C:\\shared-desktop',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  });
  let sweeps = 0;
  await waitForInstallerSurfaceClean(phases, {
    keyExists: (key) => {
      if (key === registryKeys('HKCU').uninstall) sweeps += 1;
      return sweeps < 3;
    },
    pathExists: () => sweeps < 3,
    timeoutMs: 5000,
    pollIntervalMs: 5
  });
  assert.ok(sweeps >= 3);
});

test('surface wait still fails when the uninstaller never cleans up', async () => {
  const phases = createInstallerPhases('C:\\smoke', {
    commonDesktop: 'C:\\shared-desktop',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  });
  await assert.rejects(() => waitForInstallerSurfaceClean(phases, {
    keyExists: () => true,
    pathExists: () => false,
    timeoutMs: 60,
    pollIntervalMs: 5
  }), /clean registry and shortcut surface/);
});

test('recursive cleanup is limited to the dedicated runner temp directory', () => {
  assert.doesNotThrow(() => assertPathInside('C:\\runner-temp\\tvm-installer-123', 'C:\\runner-temp'));
  assert.throws(() => assertPathInside('C:\\runner-temp', 'C:\\runner-temp'), /outside its parent/i);
  assert.throws(() => assertPathInside('C:\\other', 'C:\\runner-temp'), /outside its parent/i);
  assert.throws(() => assertPathInside('C:\\runner-temp-sibling\\app', 'C:\\runner-temp'), /outside its parent/i);
  assert.throws(() => assertPathInside('C:\\runner-temp\\app\\..\\..\\other', 'C:\\runner-temp'), /outside its parent/i);
  assert.throws(() => assertPathInside('D:\\runner-temp\\app', 'C:\\runner-temp'), /outside its parent/i);
});
