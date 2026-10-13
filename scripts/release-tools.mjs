import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { sourceFingerprint } from './build-state.mjs';

export async function runtimeFiles(root) {
    const html = await readFile(resolve(root, 'dist/renderer/index.html'), 'utf8');
    const assets = new Set([...html.matchAll(/(?:src|href)="\.\/([^"/]+\.(?:js|css))"/g)].map(match => match[1]));
    if (assets.size < 5) throw new Error('Renderer manifest is incomplete');
    const files = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const full = resolve(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Unexpected runtime symlink');
            if (entry.isDirectory()) { await visit(full); continue; }
            const name = relative(root, full).replaceAll('\\', '/');
            if (!/\.(js|css|html|webp)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
            if (name.startsWith('dist/renderer/') && name !== 'dist/renderer/index.html' && !name.endsWith('.webp') && !assets.has(name.slice('dist/renderer/'.length))) continue;
            if (['dist/main/dev-executable.js', 'dist/main/index.js', 'dist/types.js'].includes(name)) continue;
            files.push(name);
        }
    }
    await visit(resolve(root, 'dist'));
    for (const asset of assets) if (!(await stat(resolve(root, 'dist/renderer', asset))).isFile()) throw new Error('Missing renderer asset: ' + asset);
    return files.sort();
}

export async function releaseFingerprint(root) {
    const hash = createHash('sha256');
    hash.update(await sourceFingerprint(root));
    const files = [...await runtimeFiles(root), 'scripts/package-release.mjs', 'scripts/release-gate.mjs', 'scripts/release-tools.mjs', 'scripts/public-release-files.json'];
    for (const file of files) { hash.update(file); hash.update(await readFile(resolve(root, file))); }
    return hash.digest('hex');
}

export async function verifyReceipt(root) {
    const receipt = JSON.parse(await readFile(resolve(root, 'release/verification/receipt.json'), 'utf8'));
    if (receipt.fingerprint !== await releaseFingerprint(root) || !receipt.success || !(receipt.tests > 0)) throw new Error('Release checks are missing or outdated. Run npm run release:verify.');
    return receipt;
}
