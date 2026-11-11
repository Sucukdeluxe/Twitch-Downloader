const fs = require('fs');
const path = require('path');

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const installerSource = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
const installerSmokeSource = fs.readFileSync(path.join(root, 'scripts', 'smoke-test-installer.js'), 'utf8');
const manifestPath = path.join(root, 'scripts', 'public-release-files.json');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

check(packageJson.version === '1.0.10', `package version is ${packageJson.version}`);
check(packageLock.version === '1.0.10', `lockfile version is ${packageLock.version}`);
check(packageLock.packages?.['']?.version === '1.0.10', `lockfile root package version is ${packageLock.packages?.['']?.version}`);
check(packageJson.build?.appId === 'io.github.sucukdeluxe.twitch-vod-manager', `appId is ${packageJson.build?.appId}`);
check(packageJson.build?.publish?.provider === 'generic', `publish provider is ${packageJson.build?.publish?.provider}`);
check(packageJson.build?.publish?.url === 'https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/latest/download/', `publish URL is ${packageJson.build?.publish?.url}`);
check(JSON.stringify(packageJson.build?.files) === JSON.stringify(['dist/**/*', 'src/index.html', 'src/styles.css', 'src/workspace.css', 'build/icon.png', 'package.json']), 'packaged file list is not restricted');
check(packageJson.build?.win?.icon === 'build/icon.ico', `Windows icon is ${packageJson.build?.win?.icon}`);
check(packageJson.build?.nsis?.installerIcon === 'build/icon.ico', `installer icon is ${packageJson.build?.nsis?.installerIcon}`);
check(packageJson.build?.nsis?.uninstallerIcon === 'build/icon.ico', `uninstaller icon is ${packageJson.build?.nsis?.uninstallerIcon}`);
check(packageJson.build?.nsis?.shortcutName === 'Twitch VOD Manager', `Windows Start Menu shortcut is not stable: ${packageJson.build?.nsis?.shortcutName}`);
check(installerSource.includes('!macro preInit'), 'installer does not recover from orphaned Windows registration before upgrade detection');
check(installerSource.includes('ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation'), 'installer does not read the existing per-user install location before upgrade detection');
check(installerSource.includes('${ifNot} ${FileExists} "$0\\${APP_EXECUTABLE_FILENAME}"'), 'installer does not detect a missing executable in an existing per-user registration');
check(installerSource.includes('DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"') && installerSource.includes('DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"'), 'installer does not clear orphaned per-user registration before upgrade detection');
const shortcutIconResource = packageJson.build?.extraResources?.find((entry) => entry?.from === 'build/icon.ico');
check(shortcutIconResource?.to === 'app-icons/icon-${version}.ico', `versioned shortcut icon resource is ${shortcutIconResource?.to}`);
check(installerSource.includes('"$LOCALAPPDATA\\Twitch VOD Manager\\Shortcut Icons\\icon-${VERSION}.ico"'), 'installed shortcuts do not use the persistent versioned icon resource');
check(installerSource.includes('CopyFiles /SILENT "$INSTDIR\\resources\\app-icons\\icon-${VERSION}.ico"'), 'versioned shortcut icon is not copied to persistent storage');
check(installerSource.includes('CreateShortCut "$newDesktopLink"'), 'desktop shortcut is not refreshed with the versioned icon resource');
check(installerSource.includes('CreateShortCut "$newStartMenuLink"'), 'start menu shortcut is not refreshed with the versioned icon resource');
check(installerSource.includes('Delete "$SMPROGRAMS\\Twitch VOD Manager v*.lnk"'), 'legacy versioned Start Menu shortcuts are not removed during upgrade');
const stableStartShortcutBlock = installerSource.match(/Delete "\$SMPROGRAMS\\Twitch VOD Manager v\*\.lnk"([\s\S]*?)System::Call 'shell32::SHChangeNotify\(i 0x00001000/);
check(Boolean(stableStartShortcutBlock) && !stableStartShortcutBlock[1].includes('${if} ${FileExists} "$newStartMenuLink"'), 'stable Start Menu shortcut is not recreated when an older installer did not register it');
check(installerSource.includes('SHChangeNotify(i 0x00001000, i 0x0005, w "$SMPROGRAMS"'), 'Windows Start Menu is not notified after shortcut refresh');
check(installerSmokeSource.includes("'/currentuser'"), 'installer smoke does not force a per-user test installation');
check(installerSmokeSource.includes('assertCleanInstallerSmokeSurface'), 'installer smoke can run against an existing workstation installation');
check(installerSource.includes('SHChangeNotify(i 0x08000000, i 0x1000'), 'Windows shell icon cache is not flushed after shortcut refresh');
check(installerSource.includes('${ifNot} ${isUpdated}') && installerSource.includes('RMDir /r "$LOCALAPPDATA\\Twitch VOD Manager\\Shortcut Icons"'), 'persistent shortcut icons are not cleaned up on a real uninstall');
check(packageJson.build?.win?.signAndEditExecutable !== false, 'Windows executable resource editing is enabled');
check(packageJson.build?.win?.signExecutable !== false, 'Windows executable signing is disabled');
check(fs.existsSync(path.join(root, 'build', 'icon.png')), 'application PNG icon is missing');
check(fs.existsSync(path.join(root, 'build', 'icon.ico')), 'application ICO icon is missing');
check(mainSource.includes('app.setAppUserModelId(WINDOWS_APP_IDENTITY.appUserModelId)'), 'Windows AppUserModelID is not applied from the centralized identity');
check(mainSource.includes('app.setName(WINDOWS_APP_IDENTITY.name)'), 'Windows application name is not applied before startup');
const windowCreationIndex = mainSource.indexOf('mainWindow = new BrowserWindow');
const taskbarDetailsIndex = mainSource.indexOf('mainWindow.setAppDetails', windowCreationIndex);
const windowShowIndex = mainSource.indexOf('mainWindow.show()', windowCreationIndex);
check(mainSource.includes('resolveWindowsAppIconPath') && mainSource.includes('createWindowsTaskbarDetails'), 'BrowserWindow does not use centralized Windows taskbar identity');
check(mainSource.slice(windowCreationIndex, taskbarDetailsIndex).includes('show: false'), 'BrowserWindow is visible before Windows taskbar identity is applied');
check(taskbarDetailsIndex > windowCreationIndex && windowShowIndex > taskbarDetailsIndex, 'Windows taskbar identity is not applied before the window is shown');
check(indexSource.includes('class="topbar-brand-mark" src="../build/icon.png"'), 'topbar does not use the application icon');
check(mainSource.includes('GITHUB_RELEASES_API_LATEST_URL'), 'GitHub releases API constant is missing');
check(mainSource.includes('GITHUB_RELEASES_DOWNLOAD_BASE_URL'), 'GitHub releases download constant is missing');
check(mainSource.includes('https://api.github.com/repos/Sucukdeluxe/Twitch-VOD-Manager/releases/latest'), 'GitHub latest release API URL is missing');
check(mainSource.includes('https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download'), 'GitHub release download URL is missing');
check(!/storyboards\/\d{8,12}(?:-|\/)/.test(mainSource), 'numeric Twitch VOD example remains in the public source');
check(indexSource.includes('Version: v1.0.10'), 'initial version label is not 1.0.10');
check(!indexSource.includes('Version: v4.1.13'), 'legacy version label is still present');
check(fs.existsSync(manifestPath), 'public release manifest is missing');

if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const normalizedEntries = entries.map((entry) => entry.replace(/\\/g, '/').replace(/\/$/, ''));
  const forbiddenReleasePath = /(?:^|\/)(?:\.claude|\.codex|\.superpowers|tasks?|memories?|prompts?|artifacts?|logs?|backups?)(?:\/|$)|(?:^|\/)(?:AGENTS|CLAUDE)\.md$|\.(?:db|sqlite|sqlite3|log|bak|backup|zip|7z|rar|exe|msi|jsonl)$/i;
  for (const entry of entries) {
    const absolutePath = path.join(root, entry);
    check(fs.existsSync(absolutePath), `public release entry does not exist: ${entry}`);
    if (fs.existsSync(absolutePath)) {
      const stat = fs.lstatSync(absolutePath);
      check(stat.isFile(), `public release entry is not a file: ${entry}`);
      check(!stat.isSymbolicLink(), `public release entry is a symbolic link: ${entry}`);
    }
    check(!forbiddenReleasePath.test(entry.replace(/\\/g, '/')), `forbidden public release path: ${entry}`);
  }

  check(new Set(normalizedEntries).size === normalizedEntries.length, 'public release manifest contains duplicate entries');

  const collectFiles = (directory) => {
    const result = [];
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, item.name);
      if (item.isDirectory()) result.push(...collectFiles(absolutePath));
      else if (item.isFile() && !/^macos-updater-(arm64|x64)$/.test(item.name)) result.push(path.relative(root, absolutePath).replace(/\\/g, '/'));
    }
    return result;
  };
  const publicTreeFiles = [...collectFiles(path.join(root, 'build')), ...collectFiles(path.join(root, 'src'))].sort();
  const missingTreeFiles = publicTreeFiles.filter((relativePath) => !normalizedEntries.includes(relativePath));
  check(missingTreeFiles.length === 0, `public release manifest is missing ${missingTreeFiles.length} build/src files: ${missingTreeFiles.slice(0, 5).join(', ')}`);

  const referencedTestFiles = new Set();
  for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    if (!name.startsWith('test')) continue;
    for (const match of String(command).matchAll(/\b((?:scripts|tests?|src)[\\/][A-Za-z0-9._\\/-]+)\b/g)) {
      const relativePath = match[1].replace(/\\/g, '/');
      const absolutePath = path.join(root, ...relativePath.split('/'));
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        referencedTestFiles.add(relativePath);
      }
    }
  }

  for (const relativePath of [...referencedTestFiles].sort()) {
    check(normalizedEntries.includes(relativePath), `test script file is missing from the public release manifest: ${relativePath}`);
  }
}

console.log(JSON.stringify({ failures }, null, 2));

if (failures.length) process.exitCode = 1;
