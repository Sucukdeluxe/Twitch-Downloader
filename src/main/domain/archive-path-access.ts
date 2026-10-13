import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function resolveArchiveFilePaths(root: string, filenames: readonly string[], resolvePath = fs.realpath): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    if (!root || !filenames.length) return resolved;
    const directory = path.resolve(root);
    const contained = (base: string, filename: string): boolean => {
        const relative = path.relative(base, filename);
        return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
    };
    let canonicalRoot: string;
    try { canonicalRoot = await resolvePath(directory); } catch { return resolved; }
    const unique = [...new Set(filenames)].filter(filename => typeof filename === 'string' && path.isAbsolute(filename) && contained(directory, filename));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(32, unique.length) }, async () => {
        while (next < unique.length) {
            const filename = unique[next++];
            try {
                const canonical = await resolvePath(filename);
                if (contained(canonicalRoot, canonical)) resolved.set(filename, process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical);
            } catch { }
        }
    }));
    return resolved;
}
