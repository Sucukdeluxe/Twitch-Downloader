import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { CutterProjectSource } from './cutter-project';
import { type PortableCutterEdit, validatePortableCutterEdit } from './portable-cutter-project';
import { createSerialExecutor, readJsonDocument, writeJsonDocument } from './durable-json-store';

export type ExportJobRequest =
    | { kind: 'cut'; project: PortableCutterEdit; outputPath: string; replaceExisting?: boolean }
    | { kind: 'merge'; sources: CutterProjectSource[]; outputPath: string; mode: 'copy' | 'encode'; replaceExisting?: boolean };
export type ExportJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface ExportJob {
    id: string;
    name: string;
    request: ExportJobRequest;
    status: ExportJobStatus;
    progress: number;
    attempts: number;
    createdAt: number;
    updatedAt: number;
    error: string | null;
    outputFiles: string[];
}
export interface ExportJobContext {
    signal: AbortSignal;
    onProgress(progress: number): void;
}
export interface ExportJobQueueOptions {
    filePath: string;
    run(request: ExportJobRequest, context: ExportJobContext): Promise<{ outputFiles: string[] }>;
    onChange?(jobs: ExportJob[]): void;
    onPersistenceError?(error: Error): void;
}

function clone<T>(value: T): T {
    return structuredClone(value);
}
function validPath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value) && path.isAbsolute(value);
}
export function validateExportJobRequest(value: unknown): ExportJobRequest {
    if (!value || typeof value !== 'object') throw new Error('Invalid export request');
    const request = value as Record<string, unknown>;
    if (request.replaceExisting !== undefined && typeof request.replaceExisting !== 'boolean') throw new Error('Invalid overwrite preference');
    if (!validPath(request.outputPath)) throw new Error('Invalid export destination');
    let validated: ExportJobRequest;
    if (request.kind === 'cut') {
        validated = { kind: 'cut', project: validatePortableCutterEdit(request.project), outputPath: request.outputPath, replaceExisting: request.replaceExisting as boolean | undefined };
    } else if (request.kind === 'merge' && Array.isArray(request.sources) && request.sources.length >= 2 && request.sources.length <= 1000 && (request.mode === 'copy' || request.mode === 'encode')) {
        const sources = request.sources.map((value) => {
            if (!value || typeof value !== 'object') throw new Error('Invalid merge source');
            const source = value as Record<string, unknown>;
            if (!validPath(source.path) || !Number.isSafeInteger(source.size) || (source.size as number) <= 0 || typeof source.mtimeMs !== 'number' || !Number.isFinite(source.mtimeMs) || source.mtimeMs < 0) throw new Error('Invalid merge source');
            return { path: source.path, size: source.size as number, mtimeMs: source.mtimeMs };
        });
        validated = { kind: 'merge', sources, outputPath: request.outputPath, mode: request.mode, replaceExisting: request.replaceExisting as boolean | undefined };
    } else throw new Error('Invalid export request');
    const sources = validated.kind === 'cut' ? [validated.project.source] : validated.sources;
    if (sources.some((source) => path.resolve(source.path).toLowerCase() === path.resolve(validated.outputPath).toLowerCase())) throw new Error('Export cannot overwrite a source');
    return validated;
}
export function parseExportJobs(value: unknown): ExportJob[] {
    if (value === undefined) return [];
    const document = value as { version?: unknown; jobs?: unknown };
    if (!document || document.version !== 1 || !Array.isArray(document.jobs) || document.jobs.length > 5000) throw new Error('Invalid export queue');
    const ids = new Set<string>();
    return document.jobs.map((value: unknown): ExportJob => {
        if (!value || typeof value !== 'object') throw new Error('Invalid export job');
        const job = value as ExportJob;
        if (typeof job.id !== 'string' || !job.id || ids.has(job.id) || typeof job.name !== 'string' || !job.name.trim() || job.name.length > 160
            || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.status)
            || !Number.isFinite(job.progress) || job.progress < 0 || job.progress > 100
            || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || !Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt)
            || (job.error !== null && typeof job.error !== 'string') || !Array.isArray(job.outputFiles) || !job.outputFiles.every(validPath)) throw new Error('Invalid export job');
        ids.add(job.id);
        return { id: job.id, name: job.name, request: validateExportJobRequest(job.request), status: job.status, progress: job.progress, attempts: job.attempts, createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error, outputFiles: [...job.outputFiles] };
    });
}

export async function createExportJobQueue(options: ExportJobQueueOptions) {
    let jobs = parseExportJobs(await readJsonDocument(options.filePath));
    const interrupted = jobs.some((job) => job.status === 'running');
    jobs = jobs.map((job) => job.status === 'running' ? { ...job, status: 'failed' as const, error: 'interrupted', updatedAt: Date.now() } : job);
    if (interrupted) await writeJsonDocument(options.filePath, { version: 1, jobs });
    const serial = createSerialExecutor();
    let enabled = false;
    let disposed = false;
    let active: { id: string; controller: AbortController } | null = null;
    let pumping: Promise<void> | null = null;
    let persistenceError: Error | null = null;
    const notify = (): void => {
        try { options.onChange?.(clone(jobs)); } catch { return; }
    };
    const commit = async (next: ExportJob[]): Promise<void> => {
        await writeJsonDocument(options.filePath, { version: 1, jobs: next });
        jobs = next;
        notify();
    };
    const assertOpen = (): void => { if (disposed) throw new Error('Export queue is closed'); };
    const persistenceFailed = (error: unknown): void => {
        enabled = false;
        persistenceError = error instanceof Error ? error : new Error(String(error));
        try { options.onPersistenceError?.(persistenceError); } catch { return; }
    };
    const pump = (): void => {
        if (!enabled || pumping || disposed) return;
        pumping = (async () => {
            while (enabled && !disposed) {
                const job = await serial(async () => {
                    const queued = jobs.find((entry) => entry.status === 'queued');
                    if (!queued || !enabled || disposed) return null;
                    const next = { ...queued, status: 'running' as const, progress: 0, attempts: queued.attempts + 1, error: null, updatedAt: Date.now() };
                    await commit(jobs.map((entry) => entry.id === queued.id ? next : entry));
                    active = { id: next.id, controller: new AbortController() };
                    return clone(next);
                });
                if (!job || !active) break;
                const controller = active.controller;
                let outcome: { outputFiles: string[] } | null = null;
                let failure: string | null = null;
                try {
                    outcome = await options.run(clone(job.request), {
                        signal: controller.signal,
                        onProgress(progress) {
                            if (!Number.isFinite(progress) || active?.id !== job.id || controller.signal.aborted) return;
                            const current = jobs.find((entry) => entry.id === job.id);
                            if (current) {
                                current.progress = Math.max(current.progress, Math.min(99.9, Math.max(0, progress)));
                                notify();
                            }
                        },
                    });
                    if (!outcome || !Array.isArray(outcome.outputFiles) || outcome.outputFiles.length === 0 || !outcome.outputFiles.every(validPath)) throw new Error('Export returned no valid output');
                } catch (error) {
                    failure = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
                }
                await serial(async () => {
                    const cancelled = controller.signal.aborted && !outcome;
                    await commit(jobs.map((entry) => entry.id !== job.id ? entry : {
                        ...entry, status: cancelled ? 'cancelled' : failure ? 'failed' : 'completed',
                        progress: !cancelled && !failure ? 100 : entry.progress, error: cancelled ? null : failure,
                        outputFiles: cancelled || failure ? [] : [...outcome!.outputFiles], updatedAt: Date.now(),
                    }));
                });
                active = null;
            }
        })().catch(persistenceFailed).finally(() => {
            active = null;
            pumping = null;
            if (enabled && !disposed && jobs.some((job) => job.status === 'queued')) pump();
        });
    };
    return {
        list: (): ExportJob[] => clone(jobs),
        get running(): boolean { return pumping !== null; },
        get paused(): boolean { return !enabled; },
        get persistenceError(): Error | null { return persistenceError; },
        async enqueue(name: string, request: ExportJobRequest): Promise<ExportJob> {
            assertOpen();
            if (typeof name !== 'string' || !name.trim() || name.trim().length > 160) throw new Error('Invalid export job name');
            const validated = validateExportJobRequest(request);
            const job = await serial(async () => {
                if (jobs.length >= 5000) throw new Error('Export queue is full');
                const outputKey = path.resolve(validated.outputPath).toLowerCase();
                if (jobs.some((entry) => (entry.status === 'queued' || entry.status === 'running') && path.resolve(entry.request.outputPath).toLowerCase() === outputKey)) throw new Error('Export destination is already queued');
                const now = Date.now();
                const entry: ExportJob = { id: randomUUID(), name: name.trim(), request: validated, status: 'queued', progress: 0, attempts: 0, createdAt: now, updatedAt: now, error: null, outputFiles: [] };
                await commit([...jobs, entry]);
                return clone(entry);
            });
            pump();
            return job;
        },
        start(): void { assertOpen(); persistenceError = null; enabled = true; pump(); },
        pause(): void { enabled = false; },
        async cancel(id: string): Promise<boolean> {
            assertOpen();
            return serial(async () => {
                const job = jobs.find((entry) => entry.id === id);
                if (!job || (job.status !== 'queued' && job.status !== 'running')) return false;
                if (active?.id === id) { active.controller.abort(); return true; }
                await commit(jobs.map((entry) => entry.id === id ? { ...entry, status: 'cancelled', error: null, updatedAt: Date.now() } : entry));
                return true;
            });
        },
        async retry(id: string): Promise<boolean> {
            assertOpen();
            const retried = await serial(async () => {
                const job = jobs.find((entry) => entry.id === id);
                if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return false;
                const destination = path.resolve(job.request.outputPath).toLowerCase();
                if (jobs.some((entry) => entry.id !== id && (entry.status === 'queued' || entry.status === 'running') && path.resolve(entry.request.outputPath).toLowerCase() === destination)) throw new Error('Export destination is already queued');
                await commit(jobs.map((entry) => entry.id === id ? { ...entry, status: 'queued', progress: 0, error: null, outputFiles: [], updatedAt: Date.now() } : entry));
                return true;
            });
            pump();
            return retried;
        },
        async move(id: string, direction: -1 | 1): Promise<boolean> {
            assertOpen();
            if (direction !== -1 && direction !== 1) throw new Error('Invalid move direction');
            return serial(async () => {
                const waiting = jobs.filter(job => job.status === 'queued');
                const index = waiting.findIndex(job => job.id === id);
                const neighbor = waiting[index + direction];
                if (index < 0 || !neighbor) return false;
                const next = [...jobs];
                const from = next.findIndex(job => job.id === id);
                const to = next.findIndex(job => job.id === neighbor.id);
                [next[from], next[to]] = [next[to], next[from]];
                await commit(next);
                return true;
            });
        },
        async clearCompleted(): Promise<number> {
            assertOpen();
            return serial(async () => {
                const next = jobs.filter(job => job.status !== 'completed');
                const removed = jobs.length - next.length;
                if (removed) await commit(next);
                return removed;
            });
        },
        async remove(id: string): Promise<boolean> {
            assertOpen();
            return serial(async () => {
                const job = jobs.find((entry) => entry.id === id);
                if (!job || job.status === 'running') return false;
                await commit(jobs.filter((entry) => entry.id !== id));
                return true;
            });
        },
        async flush(): Promise<void> { await serial(async () => undefined); },
        async idle(): Promise<void> { while (pumping) await pumping; await serial(async () => undefined); },
        async close(): Promise<void> {
            enabled = false;
            disposed = true;
            active?.controller.abort();
            while (pumping) await pumping;
            await serial(async () => undefined);
        },
    };
}
export type ExportJobQueue = Awaited<ReturnType<typeof createExportJobQueue>>;
