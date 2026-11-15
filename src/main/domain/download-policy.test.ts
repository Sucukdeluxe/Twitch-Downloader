import { describe, expect, test } from 'vitest';
import {
    decideDownloadStart,
    isWithinLocalDownloadWindow,
    normalizeDownloadPolicy,
} from './download-policy';

describe('download policy normalization', () => {
    test('keeps the persistent shape for a valid app-side throttle and local windows', () => {
        const policy = normalizeDownloadPolicy({
            throttle: { maxBytesPerSecond: 524_288 },
            windows: [{ start: '22:00', end: '06:00' }, { start: '09:30', end: '12:00' }]
        });

        expect(policy).toEqual({
            throttle: { maxBytesPerSecond: 524_288 },
            windows: [{ start: '22:00', end: '06:00' }, { start: '09:30', end: '12:00' }]
        });
        expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
    });

    test('drops invalid throttle limits instead of inventing a process argument', () => {
        for (const maxBytesPerSecond of [0, -1, 1.5, Number.POSITIVE_INFINITY, '500000']) {
            expect(normalizeDownloadPolicy({ throttle: { maxBytesPerSecond } }).throttle).toBeNull();
        }
    });

    test('drops invalid local window records from the persisted shape', () => {
        expect(normalizeDownloadPolicy({
            windows: [
                { start: '9:00', end: '12:00' },
                { start: '12:00', end: '12:00' },
                { start: '24:00', end: '01:00' },
                { start: '08:00', end: '10:30' }
            ]
        }).windows).toEqual([{ start: '08:00', end: '10:30' }]);
    });
});

describe('local download windows', () => {
    test('accepts both sides of an overnight window', () => {
        const window = { start: '22:00', end: '06:00' };

        expect(isWithinLocalDownloadWindow(new Date(2026, 0, 12, 23, 30), window)).toBe(true);
        expect(isWithinLocalDownloadWindow(new Date(2026, 0, 13, 5, 30), window)).toBe(true);
        expect(isWithinLocalDownloadWindow(new Date(2026, 0, 13, 6, 0), window)).toBe(false);
    });

    test('waits for the next overnight start after the morning close', () => {
        const decision = decideDownloadStart(
            normalizeDownloadPolicy({ windows: [{ start: '22:00', end: '06:00' }] }),
            new Date(2026, 0, 13, 7, 15)
        );

        expect(decision).toMatchObject({ allowed: false, reason: 'outside-window' });
        expect(decision.nextStart).toEqual(new Date(2026, 0, 13, 22, 0));
    });

    test('uses local Date normalization when the next start falls in a DST gap', () => {
        const now = new Date(2026, 2, 29, 1, 45);
        const decision = decideDownloadStart(
            normalizeDownloadPolicy({ windows: [{ start: '02:30', end: '04:00' }] }),
            now
        );

        expect(decision).toMatchObject({ allowed: false, reason: 'outside-window' });
        expect(decision.nextStart).toEqual(new Date(2026, 2, 29, 2, 30));
    });
});

describe('manual download policy override', () => {
    test('allows a manual start outside the configured window without removing the app-side throttle', () => {
        const policy = normalizeDownloadPolicy({
            throttle: { maxBytesPerSecond: 256_000 },
            windows: [{ start: '22:00', end: '06:00' }]
        });
        const decision = decideDownloadStart(policy, new Date(2026, 0, 13, 13, 0), true);

        expect(decision).toEqual({
            allowed: true,
            reason: 'manual-override',
            maxBytesPerSecond: 256_000,
            nextStart: null
        });
    });
});
