import { describe, expect, it } from 'vitest';
import { planEditedVod } from '../domain/vod-edit-plan';
import {
    DEFAULT_PART_FILENAME_TEMPLATE,
    PartPlanError,
    describeCoverageProblems,
    formatTimecode,
    parseTimeValue,
    partOmissions,
    planParts,
    renderPartFilename,
    splitLongParts,
    suggestPartsFromChapters,
    uniqueFilenames,
} from './part-plan';

describe('parseTimeValue', () => {
    it('accepts seconds, clock strings and unit strings', () => {
        expect(parseTimeValue(90)).toBe(90);
        expect(parseTimeValue('90.5')).toBe(90.5);
        expect(parseTimeValue('01:02:03')).toBe(3723);
        expect(parseTimeValue('12:34')).toBe(754);
        expect(parseTimeValue('26:00:00.250')).toBe(93600.25);
        expect(parseTimeValue('1h2m3s')).toBe(3723);
        expect(parseTimeValue('45m')).toBe(2700);
        expect(parseTimeValue('1h 30m')).toBe(5400);
        expect(parseTimeValue('90s')).toBe(90);
        expect(parseTimeValue('1M30.5S')).toBe(90.5);
    });

    it('rejects ambiguous or invalid values', () => {
        for (const value of [-1, Number.NaN, '', '1:75:00', 'abc', '1:2:3:4', '5m1h', '1.5h', '1h1h', '1:2.5:3', ':30', '1::2', '1.2.3', '0'.repeat(40), null, {}]) {
            expect(() => parseTimeValue(value)).toThrow(PartPlanError);
        }
    });
});

describe('formatTimecode', () => {
    it('keeps hours above 24 and shows milliseconds only when present', () => {
        expect(formatTimecode(0)).toBe('00:00:00');
        expect(formatTimecode(93600.25)).toBe('26:00:00.250');
    });
});

describe('planParts', () => {
    const duration = 6 * 3600;

    it('joins separate ranges of one topic and confirms complete coverage', () => {
        const plan = planParts([
            { name: 'TikTok', ranges: [{ start: 0, end: '01:00:00' }, { start: '04:00:00', end: '05:00:00' }] },
            { name: 'Spiel', ranges: [{ start: 3600, end: 14400 }] },
            { name: 'Abschied', ranges: [{ start: 18000, end: duration }] },
        ], duration);
        expect(plan.parts.map(part => [part.number, part.name, part.duration])).toEqual([[1, 'TikTok', 7200], [2, 'Spiel', 10800], [3, 'Abschied', 3600]]);
        expect(plan.coverage).toMatchObject({ complete: true, coveredSeconds: duration, gaps: [], overlaps: [] });
    });

    it('reports gaps and double coverage with their positions', () => {
        const plan = planParts([
            { name: 'A', ranges: [{ start: 0, end: 3600 }] },
            { name: 'B', ranges: [{ start: 3000, end: 7200 }] },
            { name: 'C', ranges: [{ start: 9000, end: 20000 }] },
        ], duration);
        expect(plan.coverage.complete).toBe(false);
        expect(plan.coverage.gaps).toEqual([{ start: 7200, end: 9000 }, { start: 20000, end: duration }]);
        expect(plan.coverage.overlaps).toEqual([{ start: 3000, end: 3600, parts: [1, 2] }]);
        expect(describeCoverageProblems(plan.coverage)).toEqual([
            'Not covered: 02:00:00–02:30:00 (00:30:00)',
            'Not covered: 05:33:20–06:00:00 (00:26:40)',
            'Covered twice by parts 1 and 2: 00:50:00–01:00:00',
        ]);
    });

    it('tolerates boundary differences of up to one second', () => {
        const plan = planParts([
            { name: 'A', ranges: [{ start: 0.5, end: 3600 }] },
            { name: 'B', ranges: [{ start: 3600.8, end: duration + 0.6 }] },
        ], duration);
        expect(plan.coverage.complete).toBe(true);
        expect(plan.parts[1].ranges[0].end).toBe(duration);
    });

    it('merges touching ranges inside a part and keeps the requested part order', () => {
        const plan = planParts([
            { name: 'Zweiter Block', ranges: [{ start: 7200, end: 10800 }, { start: 3600, end: 7200 }] },
            { name: 'Erster Block', ranges: [{ start: 0, end: 3600 }] },
        ], 10800, 5);
        expect(plan.parts[0]).toMatchObject({ number: 5, ranges: [{ start: 3600, end: 10800 }] });
        expect(plan.parts[1].number).toBe(6);
        expect(plan.coverage.complete).toBe(true);
    });

    it('rejects ranges outside the source, too short ranges and missing names', () => {
        expect(() => planParts([{ name: 'A', ranges: [{ start: 0, end: duration + 5 }] }], duration)).toThrow(/after the end/);
        expect(() => planParts([{ name: 'A', ranges: [{ start: 100, end: 105 }] }], duration)).toThrow(/shorter than 10 seconds/);
        expect(() => planParts([{ name: ' ', ranges: [{ start: 0, end: 100 }] }], duration)).toThrow(/needs a name/);
        expect(() => planParts([{ name: 'A', ranges: [] }], duration)).toThrow(/at least one range/);
        expect(() => planParts([], duration)).toThrow(/At least one part/);
        expect(() => planParts([{ name: 'A', ranges: [{ start: 200, end: 100 }] }], duration)).toThrow(/end after it starts/);
    });
});

describe('partOmissions', () => {
    it('expresses a multi-range part as one edited download with the same kept ranges', () => {
        const duration = 16 * 3600;
        const plan = planParts([{ name: 'TikTok', ranges: [{ start: 3600, end: 7200 }, { start: 18000, end: 21600 }, { start: 50000, end: 50030 }] }], duration);
        const omissions = partOmissions(plan.parts[0], duration);
        expect(omissions.selection).toEqual({ start: 3600, end: 50030 });
        expect(omissions.ranges).toEqual([{ start: 7200, end: 18000 }, { start: 21600, end: 50000 }]);
        const edited = planEditedVod(duration, omissions.partDurationSec, omissions.ranges, 1, omissions.selection);
        expect(edited.parts).toHaveLength(1);
        expect(edited.ranges).toEqual(plan.parts[0].ranges);
        expect(edited.duration).toBe(7230);
    });

    it('keeps short single ranges in one file', () => {
        const plan = planParts([{ name: 'Kurz', ranges: [{ start: 100, end: 130 }] }], 1000);
        const omissions = partOmissions(plan.parts[0], 1000);
        expect(omissions).toEqual({ version: 1, partDurationSec: 60, ranges: [], selection: { start: 100, end: 130 } });
    });

    it('supports sources of up to 48 hours and names a usable alternative beyond that', () => {
        const long = 30 * 3600;
        const longPlan = planParts([{ name: 'Lang', ranges: [{ start: 0, end: 3600 }, { start: 26 * 3600, end: long }] }], long);
        const omissions = partOmissions(longPlan.parts[0], long);
        expect(omissions.ranges).toEqual([{ start: 3600, end: 26 * 3600 }]);
        expect(planEditedVod(long, omissions.partDurationSec, omissions.ranges, 1, omissions.selection).parts).toHaveLength(1);
        const whole = planParts([{ name: 'Ganz', ranges: [{ start: 0, end: 47 * 3600 }] }], 47 * 3600);
        expect(partOmissions(whole.parts[0], 47 * 3600).partDurationSec).toBe(47 * 3600);
        const tooLong = 50 * 3600;
        const plan = planParts([{ name: 'Zu lang', ranges: [{ start: 0, end: tooLong }] }], tooLong);
        expect(() => partOmissions(plan.parts[0], tooLong)).toThrow(/up to 48 hours/);
    });
});

describe('renderPartFilename', () => {
    const context = { date: new Date(2026, 10, 15, 12, 0, 0), part: 3, name: 'Just Chatting: Q&A / React?', title: 'Titel', channel: 'kanal', vodId: '123' };

    it('renders the default template with safe characters', () => {
        expect(renderPartFilename(DEFAULT_PART_FILENAME_TEMPLATE, context)).toBe('15.11.2026_Part03_Just Chatting_ Q&A _ React_.mp4');
    });

    it('supports every placeholder and appends the extension once', () => {
        expect(renderPartFilename('{date_iso} {channel} {vod_id} {part} {title} {name}.MP4', { ...context, name: 'Spiel' })).toBe('2026-11-15 kanal 123 3 Titel Spiel.mp4');
    });

    it('rejects unknown placeholders and protects reserved names', () => {
        expect(() => renderPartFilename('{date}_{game}', context)).toThrow(/Unknown filename placeholder \{game\}/);
        expect(renderPartFilename('{name}', { ...context, name: 'CON' })).toBe('_CON.mp4');
        expect(renderPartFilename('{name}', { ...context, name: 'Ende...' })).toBe('Ende.mp4');
    });

    it('limits the filename length', () => {
        const filename = renderPartFilename('{name}', { ...context, name: 'x'.repeat(120) + 'y'.repeat(200) });
        expect(filename.length).toBeLessThanOrEqual(204);
    });
});

describe('uniqueFilenames', () => {
    it('numbers repeated names without changing the first one', () => {
        expect(uniqueFilenames(['a.mp4', 'A.mp4', 'b.mp4', 'a.mp4'])).toEqual(['a.mp4', 'A (2).mp4', 'b.mp4', 'a (3).mp4']);
    });
});

describe('suggestPartsFromChapters', () => {
    const chapters = [
        { start: 0, end: 600, name: 'Just Chatting' },
        { start: 600, end: 4200, name: 'TikTok' },
        { start: 4200, end: 4290, name: 'Just Chatting' },
        { start: 4290, end: 12000, name: 'Minecraft' },
        { start: 12000, end: 16000, name: 'TikTok' },
        { start: 16000, end: 20000, name: 'Just Chatting' },
    ];

    it('groups repeated categories into one part and covers the whole source', () => {
        const drafts = suggestPartsFromChapters(chapters, 20000);
        expect(drafts).toEqual([
            { name: 'Just Chatting', ranges: [{ start: 0, end: 600 }, { start: 16000, end: 20000 }] },
            { name: 'TikTok', ranges: [{ start: 600, end: 4290 }, { start: 12000, end: 16000 }] },
            { name: 'Minecraft', ranges: [{ start: 4290, end: 12000 }] },
        ]);
        expect(planParts(drafts, 20000).coverage.complete).toBe(true);
    });

    it('keeps chronological segments when grouping is disabled', () => {
        const drafts = suggestPartsFromChapters(chapters, 20000, { groupByCategory: false });
        expect(drafts.map(draft => draft.name)).toEqual(['Just Chatting', 'TikTok', 'Minecraft', 'TikTok', 'Just Chatting']);
        expect(planParts(drafts, 20000).coverage.complete).toBe(true);
    });

    it('fills a late first chapter and missing chapters', () => {
        expect(suggestPartsFromChapters([{ start: 300, end: 900, name: 'Spiel' }], 900)).toEqual([{ name: 'Spiel', ranges: [{ start: 0, end: 900 }] }]);
        expect(suggestPartsFromChapters([], 900, { fallbackName: 'Stream vom 15.11.' })).toEqual([{ name: 'Stream vom 15.11.', ranges: [{ start: 0, end: 900 }] }]);
    });

    it('absorbs a short first segment into the following one', () => {
        const drafts = suggestPartsFromChapters([{ start: 0, end: 60, name: 'Intro' }, { start: 60, end: 5000, name: 'Spiel' }], 5000);
        expect(drafts).toEqual([{ name: 'Spiel', ranges: [{ start: 0, end: 5000 }] }]);
    });
});

describe('splitLongParts', () => {
    it('splits long parts evenly and keeps every second exactly once', () => {
        const drafts = splitLongParts([{ name: 'Just Chatting', ranges: [{ start: 0, end: 10000 }, { start: 20000, end: 35000 }] }, { name: 'Kurz', ranges: [{ start: 10000, end: 20000 }] }], 4 * 3600);
        expect(drafts.map(draft => draft.name)).toEqual(['Just Chatting (1/2)', 'Just Chatting (2/2)', 'Kurz']);
        expect(drafts[0].ranges).toEqual([{ start: 0, end: 10000 }, { start: 20000, end: 22500 }]);
        expect(drafts[1].ranges).toEqual([{ start: 22500, end: 35000 }]);
        expect(planParts(drafts, 35000).coverage.complete).toBe(true);
    });

    it('moves a cut to a range boundary instead of creating a tiny range', () => {
        const drafts = splitLongParts([{ name: 'A', ranges: [{ start: 0, end: 3605 }, { start: 5000, end: 8595 }] }], 3600);
        expect(drafts).toEqual([
            { name: 'A (1/2)', ranges: [{ start: 0, end: 3605 }] },
            { name: 'A (2/2)', ranges: [{ start: 5000, end: 8595 }] },
        ]);
    });

    it('leaves parts below the limit unchanged', () => {
        const part = { name: 'A', ranges: [{ start: 0, end: 3600 }] };
        expect(splitLongParts([part], 3600)).toEqual([part]);
    });
});
