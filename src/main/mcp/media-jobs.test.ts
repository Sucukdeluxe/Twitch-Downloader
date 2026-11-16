import { describe, expect, it } from 'vitest';
import { MediaJobQueue, type MediaJobContext, type MediaJobRequest } from './media-jobs';

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function request(name: string): MediaJobRequest {
    return { name, outputPath: 'C:\\out\\' + name + '.mp4', segments: [{ path: 'C:\\in\\a.mp4' }, { path: 'C:\\in\\b.mp4', start: 1, end: 5 }] };
}

async function settle(queue: MediaJobQueue, id: string): Promise<void> {
    while (['queued', 'running'].includes(queue.get(id)!.status)) await queue.waitForChange(50);
}

describe('MediaJobQueue', () => {
    it('runs jobs one after another and records the result', async () => {
        const running: string[] = [];
        let active = 0, maxActive = 0;
        const queue = new MediaJobQueue(async (job, context) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            running.push(job.name);
            context.onProgress(40);
            await new Promise(resolve => setTimeout(resolve, 15));
            active -= 1;
            return { outputPath: job.outputPath, duration: 12.5, bytes: 2048 };
        });
        const first = queue.enqueue(request('eins')), second = queue.enqueue(request('zwei'));
        expect(queue.busy).toBe(true);
        await settle(queue, second.id);
        expect(running).toEqual(['eins', 'zwei']);
        expect(maxActive).toBe(1);
        expect(queue.get(first.id)).toMatchObject({ status: 'completed', progress: 100, outputBytes: 2048, outputDuration: 12.5, error: null });
        expect(queue.busy).toBe(false);
    });

    it('keeps the error of a failed job and continues with the next one', async () => {
        const queue = new MediaJobQueue(async (job) => {
            if (job.name === 'kaputt') throw new Error('Output file already exists: kaputt.mp4');
            return { outputPath: job.outputPath, duration: 1, bytes: 1 };
        });
        const failed = queue.enqueue(request('kaputt')), next = queue.enqueue(request('danach'));
        await settle(queue, next.id);
        expect(queue.get(failed.id)).toMatchObject({ status: 'failed', error: 'Output file already exists: kaputt.mp4' });
        expect(queue.get(next.id)!.status).toBe('completed');
    });

    it('cancels waiting jobs immediately and running jobs through the abort signal', async () => {
        const started = deferred<MediaJobContext>();
        const queue = new MediaJobQueue((_job, context) => {
            started.resolve(context);
            return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        });
        const running = queue.enqueue(request('laeuft')), waiting = queue.enqueue(request('wartet'));
        await started.promise;
        expect(queue.cancel(waiting.id)).toBe(true);
        expect(queue.get(waiting.id)!.status).toBe('cancelled');
        expect(queue.cancel(running.id)).toBe(true);
        await settle(queue, running.id);
        expect(queue.get(running.id)).toMatchObject({ status: 'cancelled', error: null });
        expect(queue.cancel(running.id)).toBe(false);
        expect(queue.cancel('unbekannt')).toBe(false);
    });

    it('refuses a second waiting job for the same output file', () => {
        const queue = new MediaJobQueue(() => new Promise(() => undefined));
        queue.enqueue(request('gleich'));
        expect(() => queue.enqueue({ ...request('gleich'), outputPath: 'c:\\OUT\\gleich.mp4' })).toThrow(/already waiting/);
    });

    it('stops everything when the application closes', async () => {
        const queue = new MediaJobQueue((_job, context) => new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted')))));
        const running = queue.enqueue(request('a')), waiting = queue.enqueue(request('b'));
        await queue.dispose();
        expect(queue.get(running.id)!.status).toBe('cancelled');
        expect(queue.get(waiting.id)!.status).toBe('cancelled');
        expect(() => queue.enqueue(request('c'))).toThrow(/closing/);
    });

    it('returns copies so callers cannot change job state', async () => {
        const queue = new MediaJobQueue(async job => ({ outputPath: job.outputPath, duration: 1, bytes: 1 }));
        const job = queue.enqueue(request('kopie'));
        job.status = 'failed';
        queue.list()[0].segments.length = 0;
        await settle(queue, job.id);
        expect(queue.get(job.id)).toMatchObject({ status: 'completed' });
        expect(queue.get(job.id)!.segments).toHaveLength(2);
    });
});
