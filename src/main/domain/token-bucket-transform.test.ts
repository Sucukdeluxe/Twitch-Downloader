import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTokenBucketBudget, createTokenBucketTransform, type TokenBucketClock } from './token-bucket-transform';

class ManualClock implements TokenBucketClock {
    private nextTimerId = 0;
    private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();
    nowMs = 0;

    now(): number {
        return this.nowMs;
    }

    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
        const id = ++this.nextTimerId;
        this.timers.set(id, { dueAt: this.nowMs + delayMs, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
    }

    clearTimeout(handle: ReturnType<typeof setTimeout>): void {
        this.timers.delete(handle as unknown as number);
    }

    advance(ms: number): void {
        this.nowMs += ms;
        while (true) {
            const due = [...this.timers.entries()]
                .filter(([, timer]) => timer.dueAt <= this.nowMs)
                .sort(([, left], [, right]) => left.dueAt - right.dueAt)[0];
            if (!due) return;
            this.timers.delete(due[0]);
            due[1].callback();
        }
    }

    get timerCount(): number {
        return this.timers.size;
    }
}

describe('app-side token bucket transform', () => {
    it('backpressures stdout after its initial bucket without changing the source bytes', () => {
        const clock = new ManualClock();
        const transform = createTokenBucketTransform(2, clock);
        const output: Buffer[] = [];
        transform.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));

        transform.write(Buffer.from('ab'));
        transform.write(Buffer.from('cd'));

        expect(Buffer.concat(output).toString()).toBe('ab');
        expect(clock.timerCount).toBe(1);

        clock.advance(999);
        expect(Buffer.concat(output).toString()).toBe('ab');

        clock.advance(1);
        expect(Buffer.concat(output).toString()).toBe('abcd');
    });

    it('cancels a pending throttle timer when the output stream is destroyed', () => {
        const clock = new ManualClock();
        const source = new PassThrough();
        const transform = createTokenBucketTransform(1, clock);
        const output: Buffer[] = [];
        source.pipe(transform).on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));

        source.write(Buffer.from('a'));
        source.write(Buffer.from('b'));
        expect(clock.timerCount).toBe(1);

        transform.destroy();
        clock.advance(10_000);

        expect(clock.timerCount).toBe(0);
        expect(Buffer.concat(output).toString()).toBe('a');
    });

    it('shares one byte budget across concurrent output transforms', () => {
        const clock = new ManualClock();
        const budget = createTokenBucketBudget(2, clock);
        const first = createTokenBucketTransform(2, clock, budget);
        const second = createTokenBucketTransform(2, clock, budget);
        const firstOutput: Buffer[] = [];
        const secondOutput: Buffer[] = [];
        first.on('data', (chunk: Buffer) => firstOutput.push(Buffer.from(chunk)));
        second.on('data', (chunk: Buffer) => secondOutput.push(Buffer.from(chunk)));

        first.write(Buffer.from('ab'));
        second.write(Buffer.from('cd'));

        expect(Buffer.concat(firstOutput).toString()).toBe('ab');
        expect(Buffer.concat(secondOutput).toString()).toBe('');
        expect(clock.timerCount).toBe(1);

        clock.advance(1_000);

        expect(Buffer.concat(secondOutput).toString()).toBe('cd');
    });

    it('seeds an app-wide budget when throttling is enabled after startup', () => {
        const clock = new ManualClock();
        const budget = createTokenBucketBudget(null, clock);
        budget.setMaxBytesPerSecond(2);
        const transform = createTokenBucketTransform(2, clock, budget);
        const output: Buffer[] = [];
        transform.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));

        transform.write(Buffer.from('ab'));

        expect(Buffer.concat(output).toString()).toBe('ab');
    });
});
