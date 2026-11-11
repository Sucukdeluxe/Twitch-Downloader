import { describe, expect, test } from 'vitest';
import {
    addCutAt,
    commitEditorState,
    createEditorHistory,
    createVideoEditorState,
    formatEditorTimecode,
    getPlayableSegments,
    movePreviewTimeOutOfCuts,
    parseEditorTimecode,
    redoEditorState,
    setCutRange,
    setTrimRange,
    timeToTimelinePercent,
    timelinePercentToTime,
    undoEditorState,
} from './video-editor';

describe('video editor timecodes', () => {
    test('formats minute and hour timecodes with a frame field', () => {
        expect(formatEditorTimecode(66.52, 25)).toBe('01:06:13');
        expect(formatEditorTimecode(3666.52, 25)).toBe('01:01:06:13');
    });

    test('parses minute and hour timecodes and snaps to a real frame', () => {
        expect(parseEditorTimecode('01:06:13', 25)).toBeCloseTo(66.52, 8);
        expect(parseEditorTimecode('01:01:06:13', 25)).toBeCloseTo(3666.52, 8);
        expect(parseEditorTimecode('00:02:29', 30)).toBeCloseTo(2.9666666667, 8);
    });
});

describe('video editor ranges', () => {
    test('keeps global trim boundaries frame-aligned and ordered', () => {
        const state = setTrimRange(createVideoEditorState(120, 25), 10.019, 90.021);
        expect(state.trimStart).toBe(10);
        expect(state.trimEnd).toBe(90.04);
    });

    test('adds multiple cuts in timeline order without allowing overlaps', () => {
        const first = addCutAt(createVideoEditorState(120, 25), 40, 8);
        const second = addCutAt(first.state, 12, 5);
        expect(second.state.cuts.map((cut) => [cut.start, cut.end])).toEqual([[12, 17], [40, 48]]);

        const rejected = setCutRange(second.state, first.cut.id, 15, 44);
        expect(rejected).toEqual(second.state);
    });

    test('removes cut ranges from the export while preserving every playable segment', () => {
        let state = setTrimRange(createVideoEditorState(100, 25), 5, 95);
        state = addCutAt(state, 20, 10).state;
        state = addCutAt(state, 60, 5).state;
        expect(getPlayableSegments(state)).toEqual([
            { start: 5, end: 20 },
            { start: 30, end: 60 },
            { start: 65, end: 95 },
        ]);
    });

    test('preview playback jumps to the end of any removed range', () => {
        let state = addCutAt(createVideoEditorState(100, 25), 20, 10).state;
        state = addCutAt(state, 60, 5).state;
        expect(movePreviewTimeOutOfCuts(state, 24)).toBe(30);
        expect(movePreviewTimeOutOfCuts(state, 64.99)).toBe(65);
        expect(movePreviewTimeOutOfCuts(state, 40)).toBe(40);
    });

    test('clips cuts to a smaller trim and removes empty remainders', () => {
        let state = addCutAt(createVideoEditorState(100, 25), 10, 15).state;
        state = addCutAt(state, 70, 20).state;
        state = setTrimRange(state, 20, 75);
        expect(state.cuts.map((cut) => [cut.start, cut.end])).toEqual([[20, 25], [70, 75]]);
        state = setTrimRange(state, 30, 60);
        expect(state.cuts).toEqual([]);
    });

    test('rejects empty cuts while allowing adjacent cut boundaries', () => {
        const initial = createVideoEditorState(100, 25);
        expect(() => addCutAt(initial, 10, 0)).toThrow();
        let state = addCutAt(initial, 10, 5).state;
        state = addCutAt(state, 15, 5).state;
        expect(movePreviewTimeOutOfCuts(state, 10)).toBe(20);
        expect(getPlayableSegments(state)).toEqual([
            { start: 0, end: 10 },
            { start: 20, end: 100 },
        ]);
    });

    test('keeps at least one playable frame', () => {
        const state = createVideoEditorState(10, 25);
        expect(() => addCutAt(state, 0, 10)).toThrow('playable frame');
        const cut = addCutAt(state, 1, 2);
        expect(setCutRange(cut.state, cut.cut.id, 0, 10)).toEqual(cut.state);
        expect(setTrimRange(cut.state, 1, 2)).toEqual(cut.state);
    });

    test('accepts exactly one playable frame at repeating frame rates', () => {
        const state = createVideoEditorState(1, 30);
        const edited = addCutAt(state, 0, 29 / 30).state;
        expect(getPlayableSegments(edited)).toEqual([{ start: 0.966666667, end: 1 }]);
    });

    test('limits an edit to 64 removed ranges', () => {
        let state = createVideoEditorState(200, 25);
        for (let index = 0; index < 64; index += 1) state = addCutAt(state, index * 2, 1).state;
        expect(state.cuts).toHaveLength(64);
        expect(() => addCutAt(state, 150, 1)).toThrow('64');
    });

    test('converts timeline percentages and times at frame precision', () => {
        const state = createVideoEditorState(120, 25);
        expect(timeToTimelinePercent(state, 60)).toBe(50);
        expect(timelinePercentToTime(state, 50.01)).toBe(60);
        expect(timelinePercentToTime(state, 100)).toBe(120);
    });
});

describe('video editor history', () => {
    test('undo and redo restore complete trim and cut states', () => {
        const initial = createVideoEditorState(100, 25);
        const trimmed = setTrimRange(initial, 5, 90);
        const cut = addCutAt(trimmed, 20, 10).state;
        let history = createEditorHistory(initial);
        history = commitEditorState(history, trimmed);
        history = commitEditorState(history, cut);

        history = undoEditorState(history);
        expect(history.present).toEqual(trimmed);
        history = undoEditorState(history);
        expect(history.present).toEqual(initial);
        history = redoEditorState(history);
        expect(history.present).toEqual(trimmed);
        history = redoEditorState(history);
        expect(history.present).toEqual(cut);
    });

    test('does not record no-op changes and clears redo after a new edit', () => {
        const initial = createVideoEditorState(100, 25);
        const trimmed = setTrimRange(initial, 5, 90);
        let history = commitEditorState(createEditorHistory(initial), trimmed);
        history = commitEditorState(history, trimmed);
        expect(history.past).toHaveLength(1);
        history = undoEditorState(history);
        expect(history.future).toHaveLength(1);
        history = commitEditorState(history, setTrimRange(history.present, 10, 80));
        expect(history.future).toEqual([]);
    });
});
