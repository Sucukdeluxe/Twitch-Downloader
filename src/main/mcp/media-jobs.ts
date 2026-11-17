import { relocateRecordingPath, type RecordingPathMove } from '../domain/recording-paths';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ComposeResult, ComposeSegmentInput } from './lossless-compose';

export type MediaJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface MediaJobRequest { name: string; segments: ComposeSegmentInput[]; outputPath: string }
export interface MediaJob {
    id: string;
    name: string;
    status: MediaJobStatus;
    progress: number;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    outputPath: string;
    segments: ComposeSegmentInput[];
    outputBytes: number | null;
    outputDuration: number | null;
}
export interface MediaJobContext { signal: AbortSignal; onProgress(percent: number): void }
export type MediaJobRunner = (request: MediaJobRequest, context: MediaJobContext) => Promise<ComposeResult>;
export interface MediaJobQueueOptions { onChange?(): void; persist?(jobs: MediaJob[]): void }

const JOB_STATUSES: readonly MediaJobStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];

function validPath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 2048 && !value.includes('\0') && path.isAbsolute(value);
}

function optionalTime(value: unknown): value is number | null | undefined {
    return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

export function parseMediaJobs(value: unknown): MediaJob[] {
    const document = value as { version?: unknown; jobs?: unknown } | null;
    if (!document || document.version !== 1 || !Array.isArray(document.jobs)) return [];
    const ids = new Set<string>();
    return document.jobs.slice(-400).flatMap((entry): MediaJob[] => {
        const job = entry as MediaJob | null;
        if (!job || typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id) || ids.has(job.id) || typeof job.name !== 'string' || !job.name || job.name.length > 300
            || !JOB_STATUSES.includes(job.status) || !validPath(job.outputPath) || typeof job.createdAt !== 'string'
            || !Array.isArray(job.segments) || job.segments.length === 0 || job.segments.length > 1000
            || !job.segments.every(segment => segment && validPath(segment.path) && optionalTime(segment.start) && optionalTime(segment.end))) return [];
        ids.add(job.id);
        const interrupted = job.status === 'running';
        return [{
            id: job.id, name: job.name, status: interrupted ? 'queued' : job.status, progress: interrupted || job.status === 'queued' ? 0 : Math.max(0, Math.min(100, Number(job.progress) || 0)),
            createdAt: job.createdAt, startedAt: interrupted ? null : typeof job.startedAt === 'string' ? job.startedAt : null,
            finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null, error: typeof job.error === 'string' ? job.error.slice(0, 2000) : null,
            outputPath: job.outputPath, segments: job.segments.map(segment => ({ path: segment.path, ...(typeof segment.start === 'number' ? { start: segment.start } : {}), ...(typeof segment.end === 'number' ? { end: segment.end } : {}) })),
            outputBytes: typeof job.outputBytes === 'number' ? job.outputBytes : null, outputDuration: typeof job.outputDuration === 'number' ? job.outputDuration : null,
        }];
    });
}

export class MediaJobDeferred extends Error {}

const MAX_ACTIVE_JOBS = 200;
const DEFERRED_RETRY_MS = 5000;
const MAX_FINISHED_JOBS = 200;

export class MediaJobQueue {
    private jobs: MediaJob[] = [];
    private active: { id: string; controller: AbortController } | null = null;
    private pumping: Promise<void> | null = null;
    private disposed = false;
    private waiters = new Set<() => void>();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly run: MediaJobRunner, private readonly options: MediaJobQueueOptions = {}) {}

    persistable(): MediaJob[] {
        return this.list().map(job => job.status === 'running' ? { ...job, status: 'queued' as const, progress: 0, startedAt: null } : job);
    }

    restore(jobs: MediaJob[], accept: (job: MediaJob) => boolean = () => true): number {
        if (this.disposed) return 0;
        const known = new Set(this.jobs.map(job => job.id));
        let waiting = 0;
        for (const job of jobs) {
            if (known.has(job.id)) continue;
            const restored = structuredClone(job);
            if (restored.status === 'queued' && !accept(restored)) {
                restored.status = 'failed';
                restored.error = 'The job was not continued because its files are no longer inside the download folder.';
                restored.finishedAt = new Date().toISOString();
            }
            if (restored.status === 'queued') waiting += 1;
            this.jobs.push(restored);
        }
        this.changed();
        this.pump();
        return waiting;
    }

    relocatePaths(moves: readonly RecordingPathMove[]): void {
        if (this.busy) throw new Error('File jobs are still busy.');
        this.jobs = this.jobs.map(job => ({ ...job, outputPath: relocateRecordingPath(job.outputPath, moves), segments: job.segments.map(segment => ({ ...segment, path: relocateRecordingPath(segment.path, moves) })) }));
        this.changed();
    }

    get busy(): boolean {
        return this.jobs.some(job => job.status === 'queued' || job.status === 'running');
    }

    list(): MediaJob[] {
        return structuredClone(this.jobs);
    }

    get(id: string): MediaJob | null {
        const job = this.jobs.find(entry => entry.id === id);
        return job ? structuredClone(job) : null;
    }

    hasPendingOutput(outputPath: string): boolean {
        const key = outputPath.toLowerCase();
        return this.jobs.some(job => (job.status === 'queued' || job.status === 'running') && job.outputPath.toLowerCase() === key);
    }

    enqueue(request: MediaJobRequest): MediaJob {
        if (this.disposed) throw new Error('Media jobs are unavailable while the application is closing.');
        if (this.jobs.filter(job => job.status === 'queued' || job.status === 'running').length >= MAX_ACTIVE_JOBS) throw new Error('Too many media jobs are waiting.');
        if (this.hasPendingOutput(request.outputPath)) throw new Error('A job for this output file is already waiting.');
        const job: MediaJob = {
            id: randomUUID(), name: request.name, status: 'queued', progress: 0, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
            error: null, outputPath: request.outputPath, segments: structuredClone(request.segments), outputBytes: null, outputDuration: null,
        };
        this.jobs.push(job);
        this.changed();
        this.pump();
        return structuredClone(job);
    }

    cancel(id: string): boolean {
        const job = this.jobs.find(entry => entry.id === id);
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return false;
        if (this.active?.id === id) {
            this.active.controller.abort();
            return true;
        }
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        this.changed();
        return true;
    }

    waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
        return new Promise(resolve => {
            const finish = (): void => {
                clearTimeout(timer);
                this.waiters.delete(finish);
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            this.waiters.add(finish);
            signal?.addEventListener('abort', finish, { once: true });
            if (signal?.aborted) finish();
        });
    }

    async dispose(): Promise<void> {
        if (!this.disposed) this.persist();
        this.disposed = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        for (const job of this.jobs) {
            if (job.status !== 'queued') continue;
            job.status = 'cancelled';
            job.finishedAt = new Date().toISOString();
        }
        this.active?.controller.abort();
        while (this.pumping) await this.pumping;
        this.changed();
    }

    private changed(): void {
        const finished = this.jobs.filter(job => job.status !== 'queued' && job.status !== 'running');
        if (finished.length > MAX_FINISHED_JOBS) {
            const removed = new Set(finished.slice(0, finished.length - MAX_FINISHED_JOBS).map(job => job.id));
            this.jobs = this.jobs.filter(job => !removed.has(job.id));
        }
        for (const waiter of [...this.waiters]) waiter();
        if (!this.disposed) this.persist();
        try { this.options.onChange?.(); } catch { return; }
    }

    private persist(): void {
        try { this.options.persist?.(this.persistable()); } catch { return; }
    }

    private pump(): void {
        if (this.pumping || this.disposed) return;
        let deferred = false;
        this.pumping = (async () => {
            while (!this.disposed) {
                const job = this.jobs.find(entry => entry.status === 'queued');
                if (!job) break;
                const controller = new AbortController();
                this.active = { id: job.id, controller };
                job.status = 'running';
                job.startedAt = new Date().toISOString();
                this.changed();
                try {
                    const result = await this.run({ name: job.name, segments: structuredClone(job.segments), outputPath: job.outputPath }, {
                        signal: controller.signal,
                        onProgress: percent => {
                            if (!Number.isFinite(percent) || controller.signal.aborted) return;
                            job.progress = Math.max(job.progress, Math.min(99.9, Math.max(0, percent)));
                        },
                    });
                    job.status = 'completed';
                    job.progress = 100;
                    job.outputPath = result.outputPath;
                    job.outputBytes = result.bytes;
                    job.outputDuration = result.duration;
                } catch (error) {
                    if (error instanceof MediaJobDeferred && !controller.signal.aborted) {
                        job.status = 'queued';
                        job.progress = 0;
                        job.startedAt = null;
                        this.active = null;
                        deferred = true;
                        this.changed();
                        break;
                    }
                    job.status = controller.signal.aborted ? 'cancelled' : 'failed';
                    job.error = controller.signal.aborted ? null : (error instanceof Error ? error.message : String(error)).slice(0, 2000);
                }
                job.finishedAt = new Date().toISOString();
                this.active = null;
                this.changed();
            }
        })().finally(() => {
            this.active = null;
            this.pumping = null;
            if (this.disposed || !this.jobs.some(job => job.status === 'queued')) return;
            if (!deferred) { this.pump(); return; }
            if (this.retryTimer) clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump(); }, DEFERRED_RETRY_MS);
        });
    }
}
