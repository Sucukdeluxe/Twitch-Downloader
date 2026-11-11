import type { QueueProcessResource } from '../queue/process-registry';

export interface KillableProcess {
    kill(): unknown;
}

export interface PhaseBoundaryState {
    isPaused(itemId: string): boolean;
    isCancelled(itemId: string): boolean;
    whenResumed(itemId: string): Promise<void>;
}

export interface PhaseBoundaryTransition {
    onPaused?: () => unknown | Promise<unknown>;
    onResumed?: () => unknown | Promise<unknown>;
}

export function createPhaseBoundaryProcessResource(
    process: KillableProcess,
    wait: () => Promise<unknown>,
    cleanup?: () => unknown | Promise<unknown>,
): QueueProcessResource {
    return {
        kill: () => process.kill(),
        wait,
        cleanup,
    };
}

export async function waitForPhaseBoundary(itemId: string | null, state: PhaseBoundaryState, transition: PhaseBoundaryTransition = {}): Promise<boolean> {
    if (!itemId) return true;
    if (state.isPaused(itemId)) {
        await transition.onPaused?.();
        await state.whenResumed(itemId);
        if (state.isCancelled(itemId)) return false;
        await transition.onResumed?.();
    }
    return !state.isCancelled(itemId);
}
