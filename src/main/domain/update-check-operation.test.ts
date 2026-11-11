import { describe, expect, it, vi } from 'vitest';
import { createUpdateCheckCoordinator } from './update-check-operation';

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason?: unknown) => void = () => {};
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('update check coordinator', () => {
    it('keeps a timed-out check exclusive until the underlying operation settles', async () => {
        vi.useFakeTimers();
        const coordinator = createUpdateCheckCoordinator();
        const firstCheck = deferred<void>();
        const firstFactory = vi.fn(() => firstCheck.promise);
        const secondFactory = vi.fn(() => Promise.resolve());

        const first = coordinator.run(firstFactory, 100);
        await vi.advanceTimersByTimeAsync(100);

        expect(await first).toEqual({ state: 'timed-out' });
        expect(coordinator.inProgress).toBe(true);
        expect(await coordinator.run(secondFactory, 100)).toEqual({ state: 'in-progress' });
        expect(secondFactory).not.toHaveBeenCalled();

        firstCheck.resolve();
        await firstCheck.promise;
        await Promise.resolve();
        await Promise.resolve();
        expect(coordinator.inProgress).toBe(false);

        expect(await coordinator.run(secondFactory, 100)).toEqual({ state: 'completed' });
        expect(secondFactory).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('releases the operation only after its rejection settles', async () => {
        const coordinator = createUpdateCheckCoordinator();
        const failedCheck = deferred<void>();

        const attempt = coordinator.run(() => failedCheck.promise, 1000);
        failedCheck.reject(new Error('network failed'));

        await expect(attempt).resolves.toMatchObject({ state: 'failed' });
        expect(coordinator.inProgress).toBe(false);
    });
});
