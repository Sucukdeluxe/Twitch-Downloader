import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { sourceFingerprint, saveBuildState } from './build-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const developmentRefresh = process.argv.includes('--development-refresh');
const source = developmentRefresh ? null : await sourceFingerprint(root);
await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
});
await import('./build-player.mjs');

await import('./build-renderer.mjs');

if (source !== null) await saveBuildState(root, source);
