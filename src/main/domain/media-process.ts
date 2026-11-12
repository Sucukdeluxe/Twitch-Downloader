import { spawn, type ChildProcess } from 'node:child_process';

export interface MediaProcessOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    onProcess?: (process: ChildProcess) => (() => void) | void;
}

export function runMediaProcess(command: string, args: string[], options: MediaProcessOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) return reject(new Error('Media operation cancelled'));
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let stopped = false;
        const stop = (): void => { stopped = true; child.kill(); };
        const timer = setTimeout(stop, options.timeoutMs ?? 120000);
        options.signal?.addEventListener('abort', stop, { once: true });
        const release = options.onProcess?.(child);
        const cleanup = (): void => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', stop);
            release?.();
        };
        child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-1024 * 1024); });
        child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
        child.once('error', (error) => { cleanup(); reject(error); });
        child.once('close', (code) => {
            cleanup();
            if (code !== 0 || stopped || options.signal?.aborted) reject(new Error(stopped ? 'Media operation cancelled or timed out' : stderr || `Media process exited with ${code}`));
            else resolve(stdout);
        });
    });
}
