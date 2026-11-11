import { test, expect, describe } from 'vitest';
import {
    sanitizeFilenamePart,
    formatTwitchDurationFromSeconds,
    formatDateWithPattern,
    getMergeGroupPhaseText,
} from './format-helpers';

describe('sanitizeFilenamePart', () => {
    test('replaces Windows-invalid chars with underscore', () => {
        expect(sanitizeFilenamePart('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
    });
    test('replaces path separators', () => {
        expect(sanitizeFilenamePart('a/b\\c')).toBe('a_b_c');
    });
    test('strips control chars', () => {
        expect(sanitizeFilenamePart('a\x00b\x1fc')).toBe('a_b_c');
    });
    test('trims whitespace', () => {
        expect(sanitizeFilenamePart('  hi  ')).toBe('hi');
    });
    test('empty falls back to default', () => {
        expect(sanitizeFilenamePart('')).toBe('unnamed');
    });
    test('custom fallback', () => {
        expect(sanitizeFilenamePart('', 'FB')).toBe('FB');
    });
    test('only-invalid-chars falls back', () => {
        expect(sanitizeFilenamePart('////').trim()).not.toBe('');
        // '////' becomes '____' which is non-empty, so no fallback
        expect(sanitizeFilenamePart('////')).toBe('____');
    });
});

describe('formatTwitchDurationFromSeconds', () => {
    test('0 = 0s', () => {
        expect(formatTwitchDurationFromSeconds(0)).toBe('0s');
    });
    test('45 = 45s', () => {
        expect(formatTwitchDurationFromSeconds(45)).toBe('45s');
    });
    test('65 = 1m5s', () => {
        expect(formatTwitchDurationFromSeconds(65)).toBe('1m5s');
    });
    test('3725 = 1h2m5s', () => {
        expect(formatTwitchDurationFromSeconds(3725)).toBe('1h2m5s');
    });
    test('3600 = 1h0m0s', () => {
        expect(formatTwitchDurationFromSeconds(3600)).toBe('1h0m0s');
    });
    test('negative clamped to 0', () => {
        expect(formatTwitchDurationFromSeconds(-5)).toBe('0s');
    });
    test('NaN clamped to 0', () => {
        expect(formatTwitchDurationFromSeconds(NaN)).toBe('0s');
    });
    test('Infinity clamped to 0', () => {
        expect(formatTwitchDurationFromSeconds(Infinity)).toBe('0s');
    });
});

describe('formatDateWithPattern', () => {
    const d = new Date(2026, 4, 11, 23, 5, 7); // 2026-05-11 23:05:07

    test('yyyy-MM-dd', () => {
        expect(formatDateWithPattern(d, 'yyyy-MM-dd')).toBe('2026-05-11');
    });
    test('yy MM dd', () => {
        expect(formatDateWithPattern(d, 'yy/MM/dd')).toBe('26/05/11');
    });
    test('HH:mm:ss', () => {
        expect(formatDateWithPattern(d, 'HH:mm:ss')).toBe('23:05:07');
    });
    test('combined pattern', () => {
        expect(formatDateWithPattern(d, 'yyyy-MM-dd_HH-mm-ss')).toBe('2026-05-11_23-05-07');
    });
    test('backslashes are stripped after token substitution', () => {
        // Note: \ does NOT escape the date-token (no negative-lookbehind in regex).
        // It only removes the literal backslash from the output. So 'yyyy\\X' → 'YYYYX'.
        expect(formatDateWithPattern(d, 'yyyy\\X')).toBe('2026X');
    });
});

describe('getMergeGroupPhaseText', () => {
    test('known DE phases', () => {
        expect(getMergeGroupPhaseText('downloading', 'de')).toBe('VOD wird heruntergeladen');
        expect(getMergeGroupPhaseText('merging', 'de')).toBe('Zusammenfügen...');
        expect(getMergeGroupPhaseText('splitting', 'de')).toBe('Part wird erstellt');
        expect(getMergeGroupPhaseText('cleanup', 'de')).toBe('Aufräumen...');
    });
    test('known EN phases', () => {
        expect(getMergeGroupPhaseText('downloading', 'en')).toBe('Downloading VOD');
        expect(getMergeGroupPhaseText('merging', 'en')).toBe('Merging...');
        expect(getMergeGroupPhaseText('splitting', 'en')).toBe('Splitting Part');
        expect(getMergeGroupPhaseText('cleanup', 'en')).toBe('Cleaning up...');
    });
    test('unknown phase passes through', () => {
        expect(getMergeGroupPhaseText('unknown', 'de')).toBe('unknown');
    });
    test('unknown language falls back to DE', () => {
        expect(getMergeGroupPhaseText('downloading', 'fr')).toBe('VOD wird heruntergeladen');
    });
});
