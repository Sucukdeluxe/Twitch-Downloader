import path from 'node:path';
import type { ArchiveInventory } from './archive-inventory';

export interface ClipLibraryFile { fullPath: string; fileName: string; streamer: string; size: number; mtimeMs: number }
export interface ClipLibraryPage { directory: string; rootExists: boolean; total: number; offset: number; files: ClipLibraryFile[] }

export function clipLibraryPage(inventory: ArchiveInventory, requestedOffset: unknown): ClipLibraryPage {
    const files = inventory.files.filter(file => /\.(mp4|mkv|webm|mov|m4v|ts)$/i.test(file.fileName))
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath));
    const requested = typeof requestedOffset === 'number' && Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    const offset = Math.min(Math.floor(Math.max(0, files.length - 1) / 100) * 100, Math.floor(requested / 100) * 100);
    return { directory: inventory.root, rootExists: inventory.rootExists, total: files.length, offset,
        files: files.slice(offset, offset + 100).map(file => ({ fullPath: file.fullPath, fileName: file.fileName,
            streamer: path.dirname(file.relativePath) === '.' ? '' : file.relativePath.split(path.sep)[0], size: file.size, mtimeMs: file.mtimeMs })) };
}
