import path from 'node:path';
import { classify, type ArchiveInventory, type ArchiveInventoryFile } from './archive-inventory';

export function isWithinArchiveRoot(root: string, filename: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(filename));
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

export function combineClipArchiveInventory(primary: ArchiveInventory, clips: ArchiveInventory): ArchiveInventory {
    const nested = path.relative(primary.root, clips.root) !== '' && isWithinArchiveRoot(primary.root, clips.root);
    const key = (filename: string) => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
    const clipFile = (file: ArchiveInventoryFile): ArchiveInventoryFile => {
        const relativePath = path.join('Clips', path.relative(clips.root, file.fullPath));
        return { ...file, relativePath, ...classify(relativePath) };
    };
    const files = new Map(primary.files.map(file => [key(file.fullPath), nested && isWithinArchiveRoot(clips.root, file.fullPath) ? clipFile(file) : file]));
    for (const file of clips.files) if (!files.has(key(file.fullPath))) files.set(key(file.fullPath), clipFile(file));
    return { ...primary, rootExists: primary.rootExists || clips.rootExists, files: [...files.values()] };
}
