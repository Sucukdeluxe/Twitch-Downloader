import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface DownloadProcessGroup {
    pid: number;
    closed: boolean;
    waiting?: Promise<void>;
}

// Only processes created here may be signalled as a group. Never infer a
// process-group ID from an arbitrary child PID (it could be the app's group).
const groups = new WeakMap<ChildProcess, DownloadProcessGroup>();

export function spawnDownloadProcess(command: string, args: string[]): ChildProcessWithoutNullStreams {
    const child = spawn(command, args, { windowsHide: true, detached: process.platform === 'darwin' });
    if (process.platform === 'darwin' && child.pid !== undefined) {
        const group: DownloadProcessGroup = { pid: child.pid, closed: false };
        groups.set(child, group);
        child.once('close', () => { group.closed = true; });
    }
    return child;
}

export function killDownloadProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const group = groups.get(child);
    if (!group) return child.kill(signal);
    try {
        process.kill(-group.pid, signal);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
    }
}

function groupExists(pid: number): boolean {
    try { process.kill(-pid, 0); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
    }
}

export function waitForDownloadProcessExit(child: ChildProcess, forceKillAfterMs: number): Promise<void> | undefined {
    const group = groups.get(child);
    if (!group) return undefined;
    if (group.waiting) return group.waiting;
    group.waiting = (async () => {
        const deadline = Date.now() + forceKillAfterMs;
        let forced = false;
        // Streamlink can exit before its FFmpeg child, with or without inherited
        // stdio. Await both the process group and close, not just parent exitCode.
        while (!group.closed || groupExists(group.pid)) {
            if (!forced && Date.now() >= deadline) {
                killDownloadProcess(child, 'SIGKILL');
                forced = true;
            }
            if (Date.now() >= deadline + 2000) throw new Error('Download process group did not exit after SIGKILL');
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    })();
    return group.waiting;
}
