import fs from 'fs';
import path from 'path';
import { writeFileAtomicSync } from '../infra/fs-atomic';

export type ClipState = 'ready' | 'active' | 'done' | 'failed' | 'invalid' | 'stopped';
export interface WorkspaceClip {
    url: string;
    label: string;
    streamer: string;
    metadataState: 'pending' | 'loading' | 'ready' | 'missing' | 'unavailable';
    state: ClipState;
    filename?: string;
    outputDirectory?: string;
    error?: string;
}
export interface WorkspaceMergeFile {
    id: string;
    path: string;
    size: number;
    mtimeMs: number;
    durationSeconds?: number;
}
export interface MergeFileReference {
    id: string;
    token: string;
    name: string;
    durationSeconds?: number;
    missing?: boolean;
}
export interface ClipTransferProgress {
    url: string;
    requestId: string;
    bytes: number;
    bytesPerSecond: number;
    phase: 'preparing' | 'downloading' | 'saving';
    state: ClipState;
    filename?: string;
    error?: string;
}
export interface WorkspaceSnapshot {
    automationPaused?: boolean;
    clips: WorkspaceClip[];
    mergeFiles: MergeFileReference[];
    activeClip?: ClipTransferProgress;
    mergeActive?: boolean;
    mergeProgress?: number;
}

const clipStates = new Set(['ready', 'active', 'done', 'failed', 'invalid', 'stopped']);
const metadataStates = new Set(['pending', 'loading', 'ready', 'missing', 'unavailable']);
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : '';

export function normalizeWorkspaceClips(input: unknown): WorkspaceClip[] {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const result: WorkspaceClip[] = [];
    for (const item of input.slice(0, 200)) {
        if (!item || typeof item !== 'object') continue;
        const url = text(item.url, 4096).trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        result.push({ url, label: text(item.label, 1000), streamer: text(item.streamer, 100),
            metadataState: metadataStates.has(item.metadataState) ? item.metadataState : 'pending',
            state: clipStates.has(item.state) ? item.state : 'ready',
            error: text(item.error, 500) || undefined });
    }
    return result;
}

export class WorkspaceSessionStore {
    clips: WorkspaceClip[] = [];
    mergeFiles: WorkspaceMergeFile[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private dirty = false;
    private waiters: Array<(saved: boolean) => void> = [];

    constructor(private readonly filename: string, private readonly onError: (error: unknown) => void) {
        try {
            if (!fs.existsSync(filename)) return;
            if (fs.statSync(filename).size > 4 * 1024 * 1024) throw new Error('Workspace exceeds size limit');
            const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (data.version !== 1) throw new Error('Unsupported workspace version');
            this.clips = normalizeWorkspaceClips(data.clips).map(item => {
                const saved = data.clips.find((value: WorkspaceClip) => value?.url === item.url);
                return { ...item, state: item.state === 'active' ? 'stopped' : item.state,
                    metadataState: item.metadataState === 'loading' ? 'pending' : item.metadataState,
                    filename: text(saved?.filename, 4096) || undefined,
                    outputDirectory: typeof saved?.outputDirectory === 'string' && path.isAbsolute(saved.outputDirectory) ? text(saved.outputDirectory, 4096) : undefined };
            });
            if (Array.isArray(data.mergeFiles)) {
                this.mergeFiles = data.mergeFiles.slice(0, 500).filter((file: WorkspaceMergeFile) =>
                    file && typeof file.id === 'string' && file.id.length <= 100 && typeof file.path === 'string' &&
                    file.path.length <= 4096 && path.isAbsolute(file.path) && Number.isFinite(file.size) && Number.isFinite(file.mtimeMs)
                ).map((file: WorkspaceMergeFile) => ({ id: file.id, path: file.path, size: file.size, mtimeMs: file.mtimeMs,
                    durationSeconds: Number.isFinite(file.durationSeconds) && file.durationSeconds! >= 0 ? file.durationSeconds : undefined }));
            }
        } catch (error) { onError(error); }
    }

    save(): Promise<boolean> {
        this.dirty = true;
        const saved = new Promise<boolean>(resolve => this.waiters.push(resolve));
        if (!this.timer) {
            this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 150);
            this.timer.unref();
        }
        return saved;
    }

    flush(): boolean {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.dirty) return true;
        try {
            fs.mkdirSync(path.dirname(this.filename), { recursive: true });
            writeFileAtomicSync(this.filename, JSON.stringify({ version: 1, clips: this.clips, mergeFiles: this.mergeFiles }));
            this.dirty = false;
            this.waiters.splice(0).forEach(resolve => resolve(true));
            return true;
        } catch (error) { this.onError(error); this.waiters.splice(0).forEach(resolve => resolve(false)); return false; }
    }
}
