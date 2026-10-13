import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createExportJobQueue, type ExportJob, type ExportJobQueue } from './domain/export-job-queue';
import { createExportJobRunner, inspectMergeSources, type ExportJobRunnerOptions } from './domain/export-job-runner';
import { createRecentCutterProjectsStore, openPortableCutterProject, relinkPortableCutterProject, savePortableCutterProject, type PortableCutterEdit, type PortableCutterProject } from './domain/portable-cutter-project';
import type { CutterProjectSource } from './domain/cutter-project';

export interface EditingWorkflowDependencies extends ExportJobRunnerOptions {
    directory: string;
    blocked?(): boolean;
    window(): BrowserWindow | null;
    trusted(event: IpcMainInvokeEvent): boolean;
    project(event: IpcMainInvokeEvent, capability: string, value: unknown): PortableCutterEdit | null;
    mergeSources(event: IpcMainInvokeEvent, ids: string[]): Promise<CutterProjectSource[]>;
    sourceCapability(event: IpcMainInvokeEvent, filePath: string): unknown;
    mediaBusy(): boolean;
    log(error: unknown): void;
}
export interface EditingJobSummary {
    id: string; name: string; kind: 'cut' | 'merge'; status: ExportJob['status']; progress: number;
    attempts: number; error: string | null; outputName: string | null;
}
function summarize(jobs: ExportJob[]): EditingJobSummary[] {
    return jobs.map(job => ({ id: job.id, name: job.name, kind: job.request.kind, status: job.status, progress: job.progress,
        attempts: job.attempts, error: job.error, outputName: job.outputFiles.length ? path.basename(job.outputFiles[0]) : null }));
}
function fileKey(filePath: string): string { return createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex'); }

export async function registerEditingWorkflows(dependencies: EditingWorkflowDependencies): Promise<{ queue: ExportJobQueue; readonly busy: boolean; flush(): Promise<void>; dispose(): Promise<void> }> {
    const recent = createRecentCutterProjectsStore(path.join(dependencies.directory, 'recent-cutter-projects.json'));
    const opened = new Map<number, { filePath: string; document: PortableCutterProject; sourcePath: string }>();
    let activeOperations = 0;
    const inspectController = new AbortController();
    const ensureAvailable = () => { if (dependencies.blocked?.()) throw new Error('Workspace is locked for backup or restore'); };
    const ensureProjectChange = () => { ensureAvailable(); if (dependencies.mediaBusy()) throw new Error('A media export is running'); };
    const broadcast = () => {
        const window = dependencies.window();
        if (window && !window.isDestroyed() && queue) window.webContents.send('editing-jobs-changed', { jobs: summarize(queue.list()), paused: queue.paused });
    };
    const execute = createExportJobRunner(dependencies);
    const queue = await createExportJobQueue({ filePath: path.join(dependencies.directory, 'export-jobs.json'),
        run: async (request, context) => {
            ensureAvailable();
            if (dependencies.mediaBusy()) throw new Error('Another media export is running');
            return execute(request, context);
        }, onChange: broadcast, onPersistenceError: dependencies.log });
    const channels: string[] = [];
    const handle = (channel: string, operation: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>) => {
        channels.push(channel);
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
            if (!dependencies.trusted(event)) return { success: false, error: 'Unauthorized request' };
            const mutating = channel !== 'editing-projects-list' && channel !== 'editing-jobs-list';
            if (mutating) activeOperations++;
            try { if (mutating) ensureAvailable(); return await operation(event, ...args); }
            catch (error) { dependencies.log(error); return { success: false, error: error instanceof Error ? error.message : String(error) }; }
            finally { if (mutating) activeOperations--; }
        });
    };
    const parent = (): BrowserWindow => { const window = dependencies.window(); if (!window || window.isDestroyed()) throw new Error('Window unavailable'); return window; };
    handle('editing-projects-list', async () => ({ success: true, projects: (await recent.list()).map(project => ({ id: fileKey(project.filePath), name: project.name, sourceName: project.sourceName, updatedAt: project.updatedAt })) }));
    handle('editing-project-save', async (event, token: unknown, value: unknown, name: unknown, saveAs: unknown = false) => {
        if (typeof token !== 'string' || typeof name !== 'string' || !name.trim() || name.trim().length > 120 || typeof saveAs !== 'boolean') throw new Error('Invalid project');
        const project = dependencies.project(event, token, value);
        if (!project) throw new Error('Project source changed');
        const candidate = opened.get(event.sender.id);
        const previous = saveAs || !candidate || path.resolve(candidate.sourcePath).toLowerCase() !== path.resolve(project.source.path).toLowerCase() ? undefined : candidate;
        let filePath = previous?.filePath;
        if (!filePath) {
            const safeName = Array.from(name).map(character => character.charCodeAt(0) < 32 ? '_' : character).join('').replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
            const selected = await dialog.showSaveDialog(parent(), { defaultPath: path.join(path.dirname(project.source.path), safeName + '.tvmcut'), filters: [{ name: 'Twitch Downloader', extensions: ['tvmcut'] }] });
            if (selected.canceled || !selected.filePath) return { success: false, cancelled: true };
            ensureAvailable();
            filePath = selected.filePath;
        }
        ensureAvailable();
        const document = await savePortableCutterProject(filePath, name, project, previous?.document);
        opened.set(event.sender.id, { filePath, document, sourcePath: project.source.path });
        await recent.remember(filePath, document);
        return { success: true, name: document.name };
    });
    handle('editing-project-open', async (event, id?: unknown) => {
        ensureProjectChange();
        let filePath: string | undefined;
        if (id !== undefined) {
            if (typeof id !== 'string') throw new Error('Invalid project reference');
            filePath = (await recent.list()).find(project => fileKey(project.filePath) === id)?.filePath;
            if (!filePath) throw new Error('Project not found');
        } else {
            const selected = await dialog.showOpenDialog(parent(), { properties: ['openFile'], filters: [{ name: 'Twitch Downloader', extensions: ['tvmcut'] }] });
            if (selected.canceled || !selected.filePaths[0]) return { success: false, cancelled: true };
            filePath = selected.filePaths[0];
        }
        ensureProjectChange();
        let loaded = await openPortableCutterProject(filePath);
        if (!loaded.project) {
            const selected = await dialog.showOpenDialog(parent(), { title: loaded.document.source.name, properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'ts', 'avi', 'm4v'] }] });
            if (selected.canceled || !selected.filePaths[0]) return { success: false, cancelled: true };
            ensureProjectChange();
            loaded = await relinkPortableCutterProject(filePath, selected.filePaths[0]);
        }
        ensureProjectChange();
        if (!loaded.project) throw new Error('Project source unavailable');
        opened.set(event.sender.id, { filePath, document: loaded.document, sourcePath: loaded.project.source.path });
        await recent.remember(filePath, loaded.document);
        return { success: true, name: loaded.document.name, project: loaded.project, source: dependencies.sourceCapability(event, loaded.project.source.path) };
    });
    handle('editing-jobs-list', async () => ({ success: true, jobs: summarize(queue.list()), paused: queue.paused }));
    const destination = async (defaultPath: string, extensions: string[]) => {
        const selected = await dialog.showSaveDialog(parent(), { defaultPath, filters: [{ name: 'Video', extensions }] });
        if (selected.canceled || !selected.filePath) return null;
        ensureAvailable();
        const exists = await fs.stat(selected.filePath).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
        return { outputPath: selected.filePath, replaceExisting: exists };
    };
    handle('editing-job-cut', async (event, token: unknown, value: unknown) => {
        if (typeof token !== 'string') throw new Error('Invalid source');
        const project = dependencies.project(event, token, value);
        if (!project) throw new Error('Project source changed');
        const extension = project.profile === 'archive' ? 'mkv' : 'mp4';
        const selected = await destination(path.join(path.dirname(project.source.path), path.basename(project.source.path, path.extname(project.source.path)) + '_edited.' + extension), [extension]);
        if (!selected) return { success: false, cancelled: true };
        ensureAvailable();
        const job = await queue.enqueue(path.basename(selected.outputPath), { kind: 'cut', project, ...selected });
        return { success: true, job: summarize([job])[0] };
    });
    handle('editing-merge-inspect', async (event, ids: unknown) => {
        if (!Array.isArray(ids) || ids.length < 2 || ids.length > 500 || !ids.every(id => typeof id === 'string')) throw new Error('Invalid merge');
        const sources = await dependencies.mergeSources(event, ids);
        const compatibility = await inspectMergeSources(sources, dependencies, AbortSignal.any([inspectController.signal, AbortSignal.timeout(120000)]));
        return { success: true, compatibility };
    });
    handle('editing-job-merge', async (event, ids: unknown, mode: unknown) => {
        if (!Array.isArray(ids) || ids.length < 2 || ids.length > 500 || !ids.every(id => typeof id === 'string') || (mode !== 'copy' && mode !== 'encode')) throw new Error('Invalid merge');
        const sources = await dependencies.mergeSources(event, ids);
        if (sources.length !== ids.length) throw new Error('Merge source changed');
        const selected = await destination(path.join(path.dirname(sources[0].path), 'merged.mp4'), ['mp4', 'mkv']);
        if (!selected) return { success: false, cancelled: true };
        const job = await queue.enqueue(path.basename(selected.outputPath), { kind: 'merge', sources, mode, ...selected });
        return { success: true, job: summarize([job])[0] };
    });
    handle('editing-job-action', async (_event, action: unknown, id?: unknown) => {
        if (action === 'start') { if (dependencies.mediaBusy()) throw new Error('Another media export is running'); queue.start(); }
        else if (action === 'pause') queue.pause();
        else if (action === 'clear-completed') await queue.clearCompleted();
        else if (typeof id === 'string' && (action === 'move-up' || action === 'move-down')) await queue.move(id, action === 'move-up' ? -1 : 1);
        else if (typeof id === 'string' && action === 'cancel') await queue.cancel(id);
        else if (typeof id === 'string' && action === 'retry') await queue.retry(id);
        else if (typeof id === 'string' && action === 'remove') await queue.remove(id);
        else if (typeof id === 'string' && action === 'reveal') {
            const job = queue.list().find(entry => entry.id === id && entry.status === 'completed');
            if (!job?.outputFiles[0]) throw new Error('Export output unavailable');
            await fs.access(job.outputFiles[0]);
            shell.showItemInFolder(job.outputFiles[0]);
        } else throw new Error('Invalid export action');
        broadcast();
        return { success: true };
    });
    return { queue, get busy() { return activeOperations > 0 || queue.running; }, async flush() { await recent.flush(); await queue.flush(); }, async dispose() { inspectController.abort(); for (const channel of channels) ipcMain.removeHandler(channel); await queue.close(); opened.clear(); } };
}
