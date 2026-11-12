import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnDownloadProcess, killDownloadProcess } from './download-process';
import { QueueProcessRegistry, waitForChildProcessExit } from '../queue/process-registry';

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('download process cancellation', () => {
    it('waits for a normal child and handles a missing executable', async () => {
        const child = spawnDownloadProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
        killDownloadProcess(child);
        await waitForChildProcessExit(child, 100);
        expect(alive(child.pid!)).toBe(false);
        const missing = spawnDownloadProcess(path.join(os.tmpdir(), 'nonexistent-tvm-executable'), []);
        missing.on('error', () => undefined);
        await waitForChildProcessExit(missing, 100);
    });

    it.runIf(process.platform === 'darwin').each(['inherited', 'private'])('kills an uncooperative descendant with %s stdio before cleanup', async (stdio) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-process-test-'));
        const ready = path.join(root, 'ready');
        const descendantCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
        const parentCode = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:${stdio === 'inherited' ? "['ignore',1,2]" : "'ignore'"}});console.log(c.pid);setInterval(()=>{},1000)`;
        const child = spawnDownloadProcess(process.execPath, ['-e', parentCode]);
        const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
        let descendantPid = 0;
        try {
            const [data] = await once(child.stdout, 'data');
            descendantPid = Number(String(data).trim());
            const deadline = Date.now() + 3000;
            while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
            expect(fs.existsSync(ready)).toBe(true);
            const registry = new QueueProcessRegistry();
            let cleaned = false;
            registry.register('download', 'streamlink', {
                kill: () => killDownloadProcess(child),
                wait: () => waitForChildProcessExit(child, 100),
                cleanup: () => {
                    expect(alive(descendantPid)).toBe(false);
                    expect(alive(child.pid!)).toBe(false);
                    cleaned = true;
                },
            });
            await registry.cancelItem('download');
            expect(cleaned).toBe(true);
            expect(alive(unrelated.pid!)).toBe(true);
            // Repeated cancellation/quit is harmless after the group has gone.
            await waitForChildProcessExit(child, 100);
            expect(killDownloadProcess(child)).toBe(false);
        } finally {
            for (const proc of [child, unrelated] as ChildProcess[]) { try { killDownloadProcess(proc, 'SIGKILL'); } catch { } }
            if (descendantPid && alive(descendantPid)) { try { process.kill(descendantPid, 'SIGKILL'); } catch { } }
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
