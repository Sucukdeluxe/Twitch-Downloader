import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

async function listFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) return listFiles(file);
        return entry.isFile() ? [file] : [];
    }));
    return files.flat().sort();
}

async function fingerprint(root, files) {
    const hash = createHash('sha256');
    for (const file of files.sort()) {
        hash.update(relative(root, file));
        hash.update(await readFile(file));
    }
    return hash.digest('hex');
}

export async function sourceFingerprint(root) {
    const sources = (await listFiles(resolve(root, 'src'))).filter((file) => !/\.(test|spec)\./.test(file));
    const scripts = (await listFiles(resolve(root, 'scripts'))).filter((file) => /[\\/]build[^\\/]*\.mjs$/.test(file));
    return fingerprint(root, [...sources, ...scripts, ...['package.json', 'package-lock.json', 'tsconfig.json', 'build/icon.ico'].map((file) => resolve(root, file))]);
}

async function outputFingerprint(root) {
    const dist = resolve(root, 'dist');
    await Promise.all(['main.js', 'preload.js', 'renderer/index.html'].map((file) => readFile(resolve(dist, file))));
    return fingerprint(root, (await listFiles(dist)).filter((file) => /\.(js|css|html)$/.test(file)));
}

export async function saveBuildState(root, source) {
    if (source !== await sourceFingerprint(root)) return;
    const destination = resolve(root, 'dist', '.build-state.json');
    await mkdir(resolve(root, 'dist'), { recursive: true });
    await writeFile(destination + '.tmp', JSON.stringify({ source, output: await outputFingerprint(root) }));
    await rename(destination + '.tmp', destination);
}

export async function isBuildCurrent(root) {
    try {
        const state = JSON.parse(await readFile(resolve(root, 'dist', '.build-state.json'), 'utf8'));
        return state.source === await sourceFingerprint(root) && state.output === await outputFingerprint(root);
    } catch {
        return false;
    }
}
