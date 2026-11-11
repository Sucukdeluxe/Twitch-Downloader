import { test, expect, describe } from 'vitest';
import {
    normalizeUpdateVersion,
    compareUpdateVersions,
    isNewerUpdateVersion,
} from './update-version-utils';

describe('normalizeUpdateVersion', () => {
    test('strips v-prefix lowercase', () => {
        expect(normalizeUpdateVersion('v1.2.3')).toBe('1.2.3');
    });
    test('strips V-prefix uppercase', () => {
        expect(normalizeUpdateVersion('V1.2.3')).toBe('1.2.3');
    });
    test('trims whitespace', () => {
        expect(normalizeUpdateVersion(' 1.2.3 ')).toBe('1.2.3');
    });
    test('handles null and undefined as empty string', () => {
        expect(normalizeUpdateVersion(null)).toBe('');
        expect(normalizeUpdateVersion(undefined)).toBe('');
    });
    test('passes plain version unchanged', () => {
        expect(normalizeUpdateVersion('1.0.1')).toBe('1.0.1');
    });
});

describe('compareUpdateVersions', () => {
    test('older < newer in same minor', () => {
        expect(compareUpdateVersions('1.0.1', '1.0.2')).toBeLessThan(0);
    });
    test('newer > older in same minor', () => {
        expect(compareUpdateVersions('1.0.2', '1.0.1')).toBeGreaterThan(0);
    });
    test('equal versions return 0', () => {
        expect(compareUpdateVersions('1.0.1', '1.0.1')).toBe(0);
    });
    test('v-prefix is normalized away', () => {
        expect(compareUpdateVersions('v1.0.1', '1.0.1')).toBe(0);
    });
    test('extra trailing part is newer', () => {
        expect(compareUpdateVersions('1.0.1', '1.0.1.1')).toBeLessThan(0);
    });
    test('major bump wins', () => {
        expect(compareUpdateVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    });
    test('null versions sort lowest', () => {
        expect(compareUpdateVersions(null, '1.0.0')).toBeLessThan(0);
        expect(compareUpdateVersions('1.0.0', null)).toBeGreaterThan(0);
    });
    test('both null returns 0', () => {
        expect(compareUpdateVersions(null, null)).toBe(0);
        expect(compareUpdateVersions('', '')).toBe(0);
    });
});

describe('isNewerUpdateVersion', () => {
    test('strictly newer returns true', () => {
        expect(isNewerUpdateVersion('1.0.2', '1.0.1')).toBe(true);
    });
    test('equal returns false', () => {
        expect(isNewerUpdateVersion('1.0.1', '1.0.1')).toBe(false);
    });
    test('older returns false', () => {
        expect(isNewerUpdateVersion('1.0.1', '1.0.2')).toBe(false);
    });
});
