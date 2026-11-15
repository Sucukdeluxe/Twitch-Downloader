// Reconstructed native boundary test. All executable fixtures and shortcuts are
// created beneath one temporary directory; no installed application is launched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertShortcutDetails, readShortcutDetails } = require('./smoke-test-installer');

function main() {
  assert.equal(process.platform, 'win32', 'Installer process-scope verification requires native Windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-installer-process-'));
  try {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$root = $env:TVM_SCOPE_ROOT
$helper = $env:TVM_SCOPE_HELPER
$owned = @()
function Assert-That($value, $message) { if (-not $value) { throw $message } }
function Invoke-Helper($directory, $mode, $expected) {
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -InstallDirectory $directory -Mode $mode
  Assert-That ($LASTEXITCODE -eq $expected) "Helper $mode returned $LASTEXITCODE, expected $expected"
}
function Is-Alive($process) { $process.Refresh(); return -not $process.HasExited }
try {
  $install = Join-Path $root 'installed'
  $other = Join-Path $root 'installed-other'
  $nested = Join-Path $install 'nested'
  New-Item -ItemType Directory -Path $install, $other, $nested | Out-Null
  Invoke-Helper 'relative-path-is-forbidden' 'Check' 20
  Invoke-Helper $install 'Check' 0
  $source = 'public static class Sleeper { public static void Main() { System.Threading.Thread.Sleep(120000); } }'
  $binary = Join-Path $root 'fixture.exe'
  Add-Type -TypeDefinition $source -OutputAssembly $binary -OutputType ConsoleApplication
  $inside = @()
  $outside = @()
  foreach ($directory in @($install, $other, $nested)) {
    foreach ($name in @('Twitch Downloader.exe', 'Twitch VOD Manager.exe')) {
      $executable = Join-Path $directory $name
      Copy-Item -LiteralPath $binary -Destination $executable
      $process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden
      $owned += $process
      if ($directory -eq $install) { $inside += $process } else { $outside += $process }
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $visible = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $owned.Id -and $_.ExecutablePath })
    if ($visible.Count -eq $owned.Count) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  Assert-That ($visible.Count -eq 6) 'All six owned fixtures must be discoverable with executable paths'
  Invoke-Helper $install 'Check' 10
  foreach ($process in $owned) { Assert-That (Is-Alive $process) 'Check must never terminate a process' }
  # Windows path equality is case insensitive; the helper must also canonicalize .. .
  $alias = Join-Path $install.ToUpperInvariant() 'nested\..'
  Invoke-Helper $alias 'Close' 0
  foreach ($process in $inside) { Assert-That ($process.WaitForExit(10000)) 'Installed product and legacy product must close' }
  foreach ($process in $outside) { Assert-That (Is-Alive $process) 'Same-name processes outside exact installation directory must survive' }
  Invoke-Helper $install 'Check' 0
  Invoke-Helper $install 'Close' 0
  foreach ($process in $outside) { Assert-That (Is-Alive $process) 'Repeated Close must not broaden its scope' }
  [Console]::WriteLine('PASS exact-directory process checks for current and legacy executable names')
} finally {
  # Stop only the exact Process objects created above, never processes by name.
  foreach ($process in $owned) {
    if (Is-Alive $process) { Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue }
    [void] $process.WaitForExit(10000)
    $process.Dispose()
  }
}
`;
    const scriptPath = path.join(root, 'scope.ps1');
    fs.writeFileSync(scriptPath, script);
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8', timeout: 90000, windowsHide: true,
      env: { ...process.env, TVM_SCOPE_ROOT: root, TVM_SCOPE_HELPER: path.resolve(__dirname, '../build/close-installed-app.ps1') }
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASS exact-directory/);

    // Native portion restored from the historical shortcut contract, without skips.
    const targetPath = path.join(root, 'Twitch Downloader.exe');
    const iconPath = path.join(root, 'icon.ico');
    const shortcutPath = path.join(root, 'Twitch Downloader.lnk');
    fs.copyFileSync(path.join(root, 'fixture.exe'), targetPath);
    fs.copyFileSync(path.resolve(__dirname, '../build/icon.ico'), iconPath);
    const link = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:TVM_TEST_SHORTCUT); $shortcut.TargetPath = $env:TVM_TEST_TARGET; $shortcut.IconLocation = $env:TVM_TEST_ICON; $shortcut.Save(); $folder = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TVM_SCOPE_ROOT); [Console]::Write($folder.ShortPath)"], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, TVM_SCOPE_ROOT: root, TVM_TEST_ICON: iconPath, TVM_TEST_SHORTCUT: shortcutPath, TVM_TEST_TARGET: targetPath }
    });
    if (link.error) throw link.error;
    assert.equal(link.status, 0, link.stderr);
    const details = readShortcutDetails(shortcutPath);
    const expectedIcon = path.join(link.stdout.trim(), path.basename(iconPath));
    assert.doesNotThrow(() => assertShortcutDetails(details, { expectedIcon, expectedTarget: path.join(link.stdout.trim(), path.basename(targetPath)) }));
    assert.throws(() => assertShortcutDetails(details, { expectedIcon, expectedTarget: path.join(root, 'wrong.exe') }), /target mismatch/i);
    assert.throws(() => assertShortcutDetails(details, { expectedIcon: path.join(root, 'wrong.ico'), expectedTarget: targetPath }), /icon mismatch/i);
    console.log('PASS installer native process isolation, non-destructive Check, idempotent Close and real Windows shortcut inspection');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

if (require.main === module) main();
