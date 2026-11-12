param(
    [Parameter(Mandatory = $true)]
    [string] $InstallDirectory,
    [ValidateSet('Check', 'Close')]
    [string] $Mode = 'Check'
)

$ErrorActionPreference = 'Stop'

try {
    if (-not [System.IO.Path]::IsPathRooted($InstallDirectory)) {
        throw 'The installation directory must be an absolute path.'
    }
    $directory = [System.IO.Path]::GetFullPath($InstallDirectory)
    $expectedPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    [void] $expectedPaths.Add([System.IO.Path]::Combine($directory, 'Twitch Downloader.exe'))
    [void] $expectedPaths.Add([System.IO.Path]::Combine($directory, 'Twitch VOD Manager.exe'))

    function Get-InstalledAppProcesses {
        @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Twitch Downloader.exe' OR Name = 'Twitch VOD Manager.exe'" | Where-Object {
            $_.ExecutablePath -and $expectedPaths.Contains([System.IO.Path]::GetFullPath($_.ExecutablePath))
        })
    }

    $running = @(Get-InstalledAppProcesses)
    if ($running.Count -eq 0) { exit 0 }
    if ($Mode -eq 'Check') { exit 10 }

    foreach ($candidate in $running) {
        $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.Path -and $expectedPaths.Contains([System.IO.Path]::GetFullPath($process.Path))) {
            [void] $process.CloseMainWindow()
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $running = @(Get-InstalledAppProcesses)
        if ($running.Count -eq 0) { exit 0 }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    foreach ($candidate in $running) {
        $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.Path -and $expectedPaths.Contains([System.IO.Path]::GetFullPath($process.Path))) {
            Stop-Process -InputObject $process -Force
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        if (@(Get-InstalledAppProcesses).Count -eq 0) { exit 0 }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    exit 10
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 20
}
