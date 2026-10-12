import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const target = args.find((arg) => /^scripts\/[\w./-]+\.(?:c?js|mjs)$/.test(arg));
if (!target) throw new Error('A local check script is required');
if (!existsSync(resolve(root, target))) {
    const message = `Local-only check unavailable in this checkout: ${target}`;
    if (process.env.TVM_STRICT_LOCAL_CHECKS === 'true') throw new Error(message);
    console.log(`::notice::${message}`);
} else {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code) => { process.exitCode = code ?? 1; });
}
