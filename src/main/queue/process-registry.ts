import type { ChildProcess } from 'node:child_process';
import { waitForDownloadProcessExit } from '../infra/download-process';

export type QueueProcessPhase = 'streamlink' | 'merge' | 'split' | 'post-processing';

export function waitForChildProcessExit(process: ChildProcess | null, forceKillAfterMs = 5000): Promise<void> {
    if (process) {
        const groupExit = waitForDownloadProcessExit(process, forceKillAfterMs);
        if (groupExit) return groupExit;
    }
    if (!process || process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        const finish = (): void => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            if (process.exitCode !== null || process.signalCode !== null) return;
            try { process.kill('SIGKILL'); } catch { }
        }, forceKillAfterMs);
        process.once('close', finish);
    });
}

export interface QueueProcessResource {
    kill?: () => unknown;
    wait?: () => Promise<unknown>;
    pause?: () => unknown | Promise<unknown>;
    resume?: () => unknown | Promise<unknown>;
    cancel?: () => unknown | Promise<unknown>;
    cleanup?: () => unknown | Promise<unknown>;
}

export interface QueueProcessRegistration {
    accepted: boolean;
    release: () => void;
}

interface RegisteredResource {
    itemId: string;
    phase: QueueProcessPhase;
    resource: QueueProcessResource;
    stopping: Promise<void> | null;
}

export class QueueProcessRegistry {
    private readonly groups = new Map<string, Set<RegisteredResource>>();
    private readonly cancelledItems = new Set<string>();
    private readonly pausedItems = new Set<string>();
    private readonly cancellationWaiters = new Map<string, Set<() => void>>();
    private readonly resumeWaiters = new Map<string, Set<() => void>>();
    private readonly pauseRuns = new Map<string, Promise<void>>();
    private readonly settling = new Set<Promise<void>>();
    private shuttingDown = false;

    register(itemId: string, phase: QueueProcessPhase, resource: QueueProcessResource): QueueProcessRegistration {
        const entry: RegisteredResource = { itemId, phase, resource, stopping: null };
        if (this.shuttingDown || this.cancelledItems.has(itemId)) {
            this.trackSettlement(this.stopResource(entry));
            return { accepted: false, release: () => undefined };
        }

        let group = this.groups.get(itemId);
        if (!group) {
            group = new Set();
            this.groups.set(itemId, group);
        }
        group.add(entry);
        if (this.pausedItems.has(itemId)) this.enqueuePause(itemId, [entry]);

        return {
            accepted: true,
            release: () => this.release(entry),
        };
    }

    async pauseItem(itemId: string): Promise<void> {
        this.pausedItems.add(itemId);
        await this.enqueuePause(itemId, [...(this.groups.get(itemId) || [])]);
    }

    async resumeItem(itemId: string): Promise<void> {
        while (this.pausedItems.has(itemId) && !this.cancelledItems.has(itemId)) {
            const pauseRun = this.pauseRuns.get(itemId);
            if (pauseRun) await pauseRun;
            if (!this.pausedItems.has(itemId) || this.cancelledItems.has(itemId)) return;
            if (pauseRun !== this.pauseRuns.get(itemId)) continue;
            await this.invokeItem(itemId, 'resume');
            if (pauseRun !== this.pauseRuns.get(itemId)) continue;
            this.pausedItems.delete(itemId);
            this.pauseRuns.delete(itemId);
            this.resolveWaiters(this.resumeWaiters, itemId);
        }
    }

    async cancelItem(itemId: string): Promise<void> {
        this.cancelledItems.add(itemId);
        this.pausedItems.delete(itemId);
        this.resolveWaiters(this.cancellationWaiters, itemId);
        this.resolveWaiters(this.resumeWaiters, itemId);
        const entries = [...(this.groups.get(itemId) || [])];
        await Promise.all(entries.map((entry) => this.stopResource(entry)));
        if ((this.groups.get(itemId)?.size || 0) === 0) this.groups.delete(itemId);
    }

    releaseItem(itemId: string): void {
        this.groups.delete(itemId);
        this.cancellationWaiters.delete(itemId);
        this.resumeWaiters.delete(itemId);
        this.pauseRuns.delete(itemId);
        this.pausedItems.delete(itemId);
    }

    resetItem(itemId: string): void {
        if ((this.groups.get(itemId)?.size || 0) > 0) {
            throw new Error(`Queue item ${itemId} still has active resources`);
        }
        this.cancelledItems.delete(itemId);
        this.pausedItems.delete(itemId);
        this.cancellationWaiters.delete(itemId);
        this.resumeWaiters.delete(itemId);
        this.pauseRuns.delete(itemId);
    }

    isCancelled(itemId: string): boolean {
        return this.cancelledItems.has(itemId);
    }

    isPaused(itemId: string): boolean {
        return this.pausedItems.has(itemId);
    }

    whenCancelled(itemId: string): Promise<void> {
        if (this.cancelledItems.has(itemId)) return Promise.resolve();
        return this.waitFor(this.cancellationWaiters, itemId);
    }

    whenResumed(itemId: string): Promise<void> {
        if (!this.pausedItems.has(itemId)) return Promise.resolve();
        return this.waitFor(this.resumeWaiters, itemId);
    }

    beginShutdown(): void {
        this.shuttingDown = true;
    }

    async cancelAll(): Promise<void> {
        await Promise.all(this.activeItemIds().map((itemId) => this.cancelItem(itemId)));
    }

    async waitForIdle(): Promise<void> {
        while (this.settling.size > 0) {
            await Promise.allSettled([...this.settling]);
        }
    }

    activeItemIds(): string[] {
        return [...this.groups.entries()]
            .filter(([, entries]) => entries.size > 0)
            .map(([itemId]) => itemId);
    }

    private async invokeItem(itemId: string, operation: 'pause' | 'resume'): Promise<void> {
        const entries = [...(this.groups.get(itemId) || [])];
        await Promise.allSettled(entries.map(async ({ resource }) => {
            await resource[operation]?.();
        }));
    }

    private stopResource(entry: RegisteredResource): Promise<void> {
        if (entry.stopping) return entry.stopping;
        entry.stopping = (async () => {
            try { entry.resource.kill?.(); } catch { }
            try { await entry.resource.cancel?.(); } catch { }
            try { await entry.resource.wait?.(); } catch { }
            try { await entry.resource.cleanup?.(); } catch { }
            this.release(entry);
        })();
        return entry.stopping;
    }

    private trackSettlement(settlement: Promise<void>): void {
        this.settling.add(settlement);
        void settlement.finally(() => this.settling.delete(settlement));
    }

    private enqueuePause(itemId: string, entries: RegisteredResource[]): Promise<void> {
        const previous = this.pauseRuns.get(itemId) || Promise.resolve();
        const pauseRun = Promise.allSettled([
            previous,
            ...entries.map(async ({ resource }) => {
                await resource.pause?.();
            }),
        ]).then(() => undefined);
        this.pauseRuns.set(itemId, pauseRun);
        return pauseRun;
    }

    private release(entry: RegisteredResource): void {
        const group = this.groups.get(entry.itemId);
        if (!group) return;
        group.delete(entry);
        if (group.size === 0) this.groups.delete(entry.itemId);
    }

    private waitFor(waiterMap: Map<string, Set<() => void>>, itemId: string): Promise<void> {
        return new Promise((resolve) => {
            let waiters = waiterMap.get(itemId);
            if (!waiters) {
                waiters = new Set();
                waiterMap.set(itemId, waiters);
            }
            waiters.add(resolve);
        });
    }

    private resolveWaiters(waiterMap: Map<string, Set<() => void>>, itemId: string): void {
        const waiters = waiterMap.get(itemId);
        if (!waiters) return;
        waiterMap.delete(itemId);
        for (const resolve of waiters) resolve();
    }
}

export class QueueRunLifecycle {
    private currentRun: Promise<void> | null = null;
    private shutdownRun: Promise<void> | null = null;

    constructor(private readonly registry: QueueProcessRegistry) { }

    schedule(run: () => Promise<void>, onError?: (error: unknown) => void): boolean {
        if (this.shutdownRun || this.currentRun) return false;
        const pending = Promise.resolve()
            .then(run)
            .catch((error) => onError?.(error));
        const tracked = pending.finally(() => {
            if (this.currentRun === tracked) this.currentRun = null;
        });
        this.currentRun = tracked;
        return true;
    }

    shutdown(beforeCancel: () => unknown | Promise<unknown>, persist: () => unknown | Promise<unknown>): Promise<void> {
        if (this.shutdownRun) return this.shutdownRun;
        this.registry.beginShutdown();
        this.shutdownRun = (async () => {
            try { await beforeCancel(); } catch { }
            await this.registry.cancelAll();
            if (this.currentRun) await this.currentRun;
            await this.registry.waitForIdle();
            await persist();
        })();
        return this.shutdownRun;
    }
}
