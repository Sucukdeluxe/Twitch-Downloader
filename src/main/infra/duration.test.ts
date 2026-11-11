import { test, expect, describe } from 'vitest';
import { parseDuration, formatDuration, formatDurationDashed } from './duration';

describe('parseDuration', () => {
    test('1h2m3s = 3723', () => {
        expect(parseDuration('1h2m3s')).toBe(3723);
    });
    test('45m = 2700', () => {
        expect(parseDuration('45m')).toBe(2700);
    });
    test('10s = 10', () => {
        expect(parseDuration('10s')).toBe(10);
    });
    test('empty string = 0', () => {
        expect(parseDuration('')).toBe(0);
    });
    test('unknown format = 0', () => {
        expect(parseDuration('abcdef')).toBe(0);
    });
    test('partial 2h = 7200', () => {
        expect(parseDuration('2h')).toBe(7200);
    });
    test('h and s without m = 3601', () => {
        expect(parseDuration('1h1s')).toBe(3601);
    });
});

describe('formatDuration', () => {
    test('3723 = 01:02:03', () => {
        expect(formatDuration(3723)).toBe('01:02:03');
    });
    test('0 = 00:00:00', () => {
        expect(formatDuration(0)).toBe('00:00:00');
    });
    test('negative = 00:00:00', () => {
        expect(formatDuration(-1)).toBe('00:00:00');
    });
    test('Infinity = 00:00:00', () => {
        expect(formatDuration(Infinity)).toBe('00:00:00');
    });
    test('NaN = 00:00:00', () => {
        expect(formatDuration(NaN)).toBe('00:00:00');
    });
    test('3600 = 01:00:00', () => {
        expect(formatDuration(3600)).toBe('01:00:00');
    });
    test('86399 = 23:59:59', () => {
        expect(formatDuration(86399)).toBe('23:59:59');
    });
    test('fractional seconds floored', () => {
        expect(formatDuration(3723.9)).toBe('01:02:03');
    });
});

describe('formatDurationDashed', () => {
    test('3723 = 01-02-03', () => {
        expect(formatDurationDashed(3723)).toBe('01-02-03');
    });
    test('negative = 00-00-00', () => {
        expect(formatDurationDashed(-1)).toBe('00-00-00');
    });
    test('NaN = 00-00-00', () => {
        expect(formatDurationDashed(NaN)).toBe('00-00-00');
    });
});
