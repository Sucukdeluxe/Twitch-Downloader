import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolError } from './tool-kit';

export interface RecordingMove { source: string; destination: string }
export interface RecordingMoveResult extends RecordingMove { bytes: number; status: 'planned' | 'moved' | 'unchanged' | 'copied'; error?: string }
export interface RecordingOrganization { dry_run: boolean; files: RecordingMoveResult[] }
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.ts', '.webm', '.mov', '.m4v']);
const SIDECARS = ['.chat.json', '.chat.jsonl', '.events.jsonl'];
const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;

function inside(root: string, target: string): boolean {
    const relative = path.relative(key(root), key(target));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

export function validateRecordingPath(roots: string[], candidate: string): string {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.length > 1024 || candidate.includes('\0')) throw new ToolError('An absolute path inside a configured download folder is required.');
    const target = path.resolve(candidate);
    const root = roots.filter(Boolean).map(value => path.resolve(value)).find(value => inside(value, target));
    if (!root) throw new ToolError('The path is outside the configured download folders.');
    const parts = path.relative(root, target).split(path.sep).filter(Boolean);
    for (const part of parts) {
        if (part.length > 240 || /[<>:"|?*]/.test(part) || [...part].some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /^\.(?:mcp-compose|vod-edit)-/.test(part)) throw new ToolError('The path contains an invalid or reserved name.');
    }
    const canonicalRoot = fs.realpathSync.native(root);
    let current = root;
    for (const part of parts) {
        current = path.join(current, part);
        let stat: fs.Stats;
        try { stat = fs.lstatSync(current); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
            throw error;
        }
        if (stat.isSymbolicLink() || !inside(canonicalRoot, fs.realpathSync.native(current))) throw new ToolError('Symbolic links and paths outside the download folders are not supported.');
    }
    return target;
}

export function createRecordingFolder(roots: string[], folder: string, dryRun = false): { path: string; created: boolean; dry_run: boolean } {
    const target = validateRecordingPath(roots, folder);
    const exists = fs.existsSync(target);
    if (exists && !fs.statSync(target).isDirectory()) throw new ToolError('The folder path is already occupied by a file.');
    if (!dryRun) fs.mkdirSync(target, { recursive: true });
    return { path: target, created: !exists && !dryRun, dry_run: dryRun };
}

export function organizeRecordings(roots: string[], moves: RecordingMove[], options: { dryRun?: boolean; busy?: boolean; beforeMove?: (files: RecordingMoveResult[]) => void } = {}): RecordingOrganization {
    if (options.busy) throw new ToolError('The application is busy. Finish or pause work and remove pending jobs before moving recordings.');
    if (!moves.length || moves.length > 100) throw new ToolError('Supply between 1 and 100 recordings.');
    const sources = new Set<string>(), destinations = new Set<string>();
    const files: RecordingMoveResult[] = [];
    const add = (sourceInput: string, destinationInput: string): void => {
        const source = validateRecordingPath(roots, sourceInput), destination = validateRecordingPath(roots, destinationInput);
        if (sources.has(key(source)) || destinations.has(key(destination))) throw new ToolError('Duplicate source or destination in the batch.');
        sources.add(key(source)); destinations.add(key(destination));
        const stat = fs.statSync(source);
        if (!stat.isFile()) throw new ToolError('Only completed video files and their sidecars may be moved.');
        const unchanged = key(source) === key(destination);
        if (!unchanged && fs.existsSync(destination)) throw new ToolError('Destination already exists: ' + destination);
        let ancestor = path.dirname(destination);
        while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
        if (!fs.statSync(ancestor).isDirectory()) throw new ToolError('The destination parent is not a folder.');
        if (fs.statSync(ancestor).dev !== stat.dev) throw new ToolError('Moves across drives are not supported. Source files were kept.');
        files.push({ source, destination, bytes: stat.size, status: unchanged ? 'unchanged' : 'planned' });
    };
    for (const move of moves) {
        const extension = path.extname(move.source).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(extension) || path.extname(move.destination).toLowerCase() !== extension) throw new ToolError('Keep the original supported video extension when renaming.');
        add(move.source, move.destination);
        for (const suffix of SIDECARS) {
            const source = move.source.slice(0, -path.extname(move.source).length) + suffix;
            validateRecordingPath(roots, source);
            if (fs.existsSync(source)) add(source, move.destination.slice(0, -path.extname(move.destination).length) + suffix);
        }
    }
    if (options.dryRun) return { dry_run: true, files };
    options.beforeMove?.(files);
    const linked: RecordingMoveResult[] = [];
    try {
        for (const file of files.filter(file => file.status !== 'unchanged')) {
            fs.mkdirSync(path.dirname(file.destination), { recursive: true });
            validateRecordingPath(roots, file.source);
            validateRecordingPath(roots, file.destination);
            fs.linkSync(file.source, file.destination);
            linked.push(file);
        }
    } catch (error) {
        for (const file of linked) { try { fs.unlinkSync(file.destination); } catch { } }
        throw new ToolError('Nothing was moved; source files were kept. ' + (error instanceof Error ? error.message : String(error)));
    }
    for (const file of linked) {
        try { fs.unlinkSync(file.source); file.status = 'moved'; }
        catch (error) { file.status = 'copied'; file.error = 'Destination is ready; source remains: ' + (error instanceof Error ? error.message : String(error)); }
    }
    return { dry_run: false, files };
}
