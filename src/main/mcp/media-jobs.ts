import { randomUUID } from 'node:crypto';
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

const MAX_ACTIVE_JOBS = 200;
const MAX_FINISHED_JOBS = 200;

export class MediaJobQueue {
    private jobs: MediaJob[] = [];
    private active: { id: string; controller: AbortController } | null = null;
    private pumping: Promise<void> | null = null;
    private disposed = false;
    private waiters = new Set<() => void>();

    constructor(private readonly run: MediaJobRunner, private readonly onChange: () => void = () => undefined) {}

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
        this.disposed = true;
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
        try { this.onChange(); } catch { return; }
    }

    private pump(): void {
        if (this.pumping || this.disposed) return;
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
            if (!this.disposed && this.jobs.some(job => job.status === 'queued')) this.pump();
        });
    }
}
