import { execFile } from 'node:child_process';
import * as path from 'node:path';

function runExtractor(executable: string, args: string[], env = process.env): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(executable, args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, env }, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

export async function extractZipArchive(archivePath: string, destinationPath: string): Promise<void> {
    if (process.platform === 'darwin') {
        await runExtractor('/usr/bin/ditto', ['-x', '-k', archivePath, destinationPath]);
        return;
    }
    const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    try {
        await runExtractor(path.join(systemDirectory, 'tar.exe'), ['-xf', archivePath, '-C', destinationPath]);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await runExtractor(path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$env:PSModulePath = Join-Path $PSHOME 'Modules'; Expand-Archive -LiteralPath $env:TVM_ARCHIVE_PATH -DestinationPath $env:TVM_EXTRACT_PATH -Force -ErrorAction Stop",
        ], { ...process.env, TVM_ARCHIVE_PATH: archivePath, TVM_EXTRACT_PATH: destinationPath });
    }
}
