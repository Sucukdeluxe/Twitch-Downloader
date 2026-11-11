import * as fs from 'node:fs';
import * as path from 'node:path';

/** A process-local cache identity, never a replacement for initial hash/runtime
 * verification. ctime detects same-size edits even when mtime is restored.
 * Include resolved target, inode and permissions so replacements and chmods
 * invalidate a previously successful probe immediately.
 */
export function executableIdentity(command: string): string | null {
    try {
        if (!path.isAbsolute(command)) return null;
        const resolved = fs.realpathSync(command);
        fs.accessSync(resolved, fs.constants.X_OK);
        const stat = fs.statSync(resolved, { bigint: true });
        if (!stat.isFile()) return null;
        return JSON.stringify([resolved, stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].map(String));
    } catch {
        return null;
    }
}
