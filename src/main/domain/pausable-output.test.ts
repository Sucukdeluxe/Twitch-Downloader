import { PassThrough, Writable } from 'stream';
import { describe, expect, it } from 'vitest';
import { createPausableOutput } from './pausable-output';
import { createTokenBucketTransform } from './token-bucket-transform';

function waitForTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('createPausableOutput', () => {
    it('setzt denselben Ausgabestrom ohne Datenverlust fort', async () => {
        const source = new PassThrough();
        const chunks: Buffer[] = [];
        const target = new Writable({
            write(chunk, _encoding, callback) {
                chunks.push(Buffer.from(chunk));
                callback();
            }
        });
        const output = createPausableOutput(source, target);

        source.write('erster-');
        await waitForTurn();
        output.pause();
        source.write('zweiter-');
        await waitForTurn();

        expect(Buffer.concat(chunks).toString()).toBe('erster-');

        output.resume();
        source.end('dritter');
        await output.finished;

        expect(Buffer.concat(chunks).toString()).toBe('erster-zweiter-dritter');
        expect(output.isPaused()).toBe(false);
    });

    it('schließt einen während der Pause beendeten Quellstrom erst nach dem Fortsetzen ab', async () => {
        const source = new PassThrough();
        const chunks: Buffer[] = [];
        const target = new Writable({
            write(chunk, _encoding, callback) {
                chunks.push(Buffer.from(chunk));
                callback();
            }
        });
        const output = createPausableOutput(source, target);
        let finished = false;
        void output.finished.then(() => {
            finished = true;
        });

        source.write('vorher-');
        await waitForTurn();
        output.pause();
        source.end('nachher');
        await waitForTurn();

        expect(finished).toBe(false);
        expect(Buffer.concat(chunks).toString()).toBe('vorher-');

        output.resume();
        await output.finished;

        expect(Buffer.concat(chunks).toString()).toBe('vorher-nachher');
    });

    it('schließt Quell- und Zielstrom bei einem Abbruch zuverlässig', async () => {
        const source = new PassThrough();
        const chunks: Buffer[] = [];
        const target = new Writable({
            write(chunk, _encoding, callback) {
                chunks.push(Buffer.from(chunk));
                callback();
            }
        });
        const output = createPausableOutput(source, target);

        source.write('behalten');
        await waitForTurn();
        output.pause();

        await output.cancel();
        await output.finished;

        expect(source.destroyed).toBe(true);
        expect(target.destroyed).toBe(true);
        expect(Buffer.concat(chunks).toString()).toBe('behalten');
    });

    it('bricht eine wartende app-seitige Drosselung zusammen mit dem Ausgabestrom ab', async () => {
        const source = new PassThrough();
        const target = new Writable({
            write(_chunk, _encoding, callback) {
                callback();
            }
        });
        const throttle = createTokenBucketTransform(1);
        const output = createPausableOutput(source, target, throttle);

        source.write('a');
        source.write('b');
        await output.cancel();

        expect(source.destroyed).toBe(true);
        expect(target.destroyed).toBe(true);
        expect(throttle.destroyed).toBe(true);
    });
});
