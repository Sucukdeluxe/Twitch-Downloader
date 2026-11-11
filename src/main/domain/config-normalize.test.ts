import { test, expect, describe } from 'vitest';
import {
    normalizeLogin,
    normalizeAutoRecordPollSeconds,
    normalizeAutoRecordList,
    normalizeStreamlinkQuality,
    normalizeFilenameTemplate,
    normalizeMetadataCacheMinutes,
    normalizePerformanceMode,
    isPlainObject,
    VALID_STREAMLINK_QUALITIES,
} from './config-normalize';

describe('normalizeLogin', () => {
    test('trim + lowercase', () => {
        expect(normalizeLogin(' Foo ')).toBe('foo');
    });
    test('strips single leading @', () => {
        expect(normalizeLogin('@foo')).toBe('foo');
    });
    test('strips multiple leading @', () => {
        expect(normalizeLogin('@@@foo')).toBe('foo');
    });
    test('preserves @ in middle of string', () => {
        expect(normalizeLogin('foo@bar')).toBe('foo@bar');
    });
    test('empty stays empty', () => {
        expect(normalizeLogin('')).toBe('');
    });
});

describe('normalizeAutoRecordPollSeconds', () => {
    test('default 90 for non-numeric (NaN producer)', () => {
        // Number('x') === NaN, Number(undefined) === NaN → default 90.
        // Number(null) === 0 (finite) → clamp to 30, see boundary test below.
        expect(normalizeAutoRecordPollSeconds('x')).toBe(90);
        expect(normalizeAutoRecordPollSeconds(undefined)).toBe(90);
        expect(normalizeAutoRecordPollSeconds({})).toBe(90);
    });
    test('null becomes 0 then clamps to 30', () => {
        expect(normalizeAutoRecordPollSeconds(null)).toBe(30);
    });
    test('clamps low to 30', () => {
        expect(normalizeAutoRecordPollSeconds(5)).toBe(30);
    });
    test('clamps high to 1800', () => {
        expect(normalizeAutoRecordPollSeconds(99999)).toBe(1800);
    });
    test('passes valid mid-range', () => {
        expect(normalizeAutoRecordPollSeconds(120)).toBe(120);
    });
    test('floors fractional', () => {
        expect(normalizeAutoRecordPollSeconds(120.9)).toBe(120);
    });
    test('boundary 30 stays', () => {
        expect(normalizeAutoRecordPollSeconds(30)).toBe(30);
    });
    test('boundary 1800 stays', () => {
        expect(normalizeAutoRecordPollSeconds(1800)).toBe(1800);
    });
});

describe('normalizeAutoRecordList', () => {
    test('empty for non-array', () => {
        expect(normalizeAutoRecordList(null)).toEqual([]);
        expect(normalizeAutoRecordList('x')).toEqual([]);
        expect(normalizeAutoRecordList(undefined)).toEqual([]);
    });
    test('empty array stays empty', () => {
        expect(normalizeAutoRecordList([])).toEqual([]);
    });
    test('lowercases + trims + dedupes', () => {
        expect(normalizeAutoRecordList(['Foo', 'foo', ' BAR '])).toEqual(['foo', 'bar']);
    });
    test('strips leading @ (twitch username paste-form)', () => {
        expect(normalizeAutoRecordList(['@foo', 'foo', '@@bar'])).toEqual(['foo', 'bar']);
    });
    test('drops non-string entries', () => {
        expect(normalizeAutoRecordList(['foo', 123, null, 'bar'])).toEqual(['foo', 'bar']);
    });
    test('drops empty strings after normalize', () => {
        expect(normalizeAutoRecordList(['', '@', '  ', 'foo'])).toEqual(['foo']);
    });
});

describe('normalizeStreamlinkQuality', () => {
    test('all valid values pass through', () => {
        for (const q of VALID_STREAMLINK_QUALITIES) {
            expect(normalizeStreamlinkQuality(q)).toBe(q);
        }
    });
    test('invalid string falls back to source', () => {
        expect(normalizeStreamlinkQuality('foo')).toBe('source');
    });
    test('null/undefined/number fall back to source', () => {
        expect(normalizeStreamlinkQuality(null)).toBe('source');
        expect(normalizeStreamlinkQuality(undefined)).toBe('source');
        expect(normalizeStreamlinkQuality(42)).toBe('source');
    });
});

describe('normalizeFilenameTemplate', () => {
    test('valid string used as-is', () => {
        expect(normalizeFilenameTemplate('{title}.mp4', 'FB')).toBe('{title}.mp4');
    });
    test('trims whitespace', () => {
        expect(normalizeFilenameTemplate('  hi  ', 'FB')).toBe('hi');
    });
    test('empty string falls back', () => {
        expect(normalizeFilenameTemplate('', 'FB')).toBe('FB');
    });
    test('whitespace-only falls back', () => {
        expect(normalizeFilenameTemplate('   ', 'FB')).toBe('FB');
    });
    test('undefined falls back', () => {
        expect(normalizeFilenameTemplate(undefined, 'FB')).toBe('FB');
    });
});

describe('normalizeMetadataCacheMinutes', () => {
    test('default 10 for NaN-producer', () => {
        expect(normalizeMetadataCacheMinutes('x')).toBe(10);
        expect(normalizeMetadataCacheMinutes(undefined)).toBe(10);
        expect(normalizeMetadataCacheMinutes({})).toBe(10);
    });
    test('null becomes 0 then clamps to 1', () => {
        expect(normalizeMetadataCacheMinutes(null)).toBe(1);
    });
    test('clamps low to 1', () => {
        expect(normalizeMetadataCacheMinutes(0)).toBe(1);
        expect(normalizeMetadataCacheMinutes(-5)).toBe(1);
    });
    test('clamps high to 120', () => {
        expect(normalizeMetadataCacheMinutes(999)).toBe(120);
    });
    test('passes valid mid-range', () => {
        expect(normalizeMetadataCacheMinutes(15)).toBe(15);
    });
    test('floors fractional', () => {
        expect(normalizeMetadataCacheMinutes(15.9)).toBe(15);
    });
});

describe('normalizePerformanceMode', () => {
    test('stability passes', () => {
        expect(normalizePerformanceMode('stability')).toBe('stability');
    });
    test('balanced passes', () => {
        expect(normalizePerformanceMode('balanced')).toBe('balanced');
    });
    test('speed passes', () => {
        expect(normalizePerformanceMode('speed')).toBe('speed');
    });
    test('invalid string falls back to balanced', () => {
        expect(normalizePerformanceMode('foo')).toBe('balanced');
    });
    test('null/undefined fall back to balanced', () => {
        expect(normalizePerformanceMode(null)).toBe('balanced');
        expect(normalizePerformanceMode(undefined)).toBe('balanced');
    });
});

describe('isPlainObject', () => {
    test('true for object literal', () => {
        expect(isPlainObject({})).toBe(true);
        expect(isPlainObject({ a: 1 })).toBe(true);
    });
    test('false for array', () => {
        expect(isPlainObject([])).toBe(false);
        expect(isPlainObject([1, 2, 3])).toBe(false);
    });
    test('false for null', () => {
        expect(isPlainObject(null)).toBe(false);
    });
    test('false for undefined', () => {
        expect(isPlainObject(undefined)).toBe(false);
    });
    test('false for primitives', () => {
        expect(isPlainObject('x')).toBe(false);
        expect(isPlainObject(42)).toBe(false);
        expect(isPlainObject(true)).toBe(false);
    });
});
