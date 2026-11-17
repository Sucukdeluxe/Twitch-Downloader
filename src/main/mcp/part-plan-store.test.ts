import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PartPlanStore, type StoredPlan } from './part-plan-store';

const directories: string[] = [];

function storeFile(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-downloader-plan-store-'));
    directories.push(directory);
    return path.join(directory, 'nested', 'mcp-part-plans.json');
}

function plan(vodId: string, name: string, savedAt: string): StoredPlan {
    return {
        vodId, channel: 'kanal', title: 'Stream', startedAt: '2026-11-14T11:00:00.000Z', durationSeconds: 21600, savedAt,
        parts: [{ number: 1, name, ranges: [{ start: 0, end: 3600 }, { start: 7200, end: 9000 }], duration: 5400, outputFile: path.resolve('/downloads/kanal/a.mp4'), queueItemId: '1700000000000-1' }],
    };
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('PartPlanStore', () => {
    it('keeps plans across restarts with the newest first', async () => {
        const file = storeFile();
        const first = new PartPlanStore(file);
        await first.save(plan('900', 'Erster Plan', '2026-11-15T08:00:00.000Z'));
        await first.save(plan('900', 'Zweiter Plan', '2026-11-15T09:00:00.000Z'));
        await first.save(plan('901', 'Anderes VOD', '2026-11-15T10:00:00.000Z'));
        const second = new PartPlanStore(file);
        expect((await second.history('900')).map(entry => entry.parts[0].name)).toEqual(['Zweiter Plan', 'Erster Plan']);
        expect(await second.vodIds()).toEqual(new Set(['900', '901']));
        expect(await second.history('999')).toEqual([]);
        expect(fs.existsSync(file + '.tmp')).toBe(false);
    });

    it('keeps at most five plans per VOD', async () => {
        const store = new PartPlanStore(storeFile());
        for (let index = 1; index <= 7; index++) await store.save(plan('900', 'Plan ' + index, `2026-11-15T0${index}:00:00.000Z`));
        expect((await store.history('900')).map(entry => entry.parts[0].name)).toEqual(['Plan 7', 'Plan 6', 'Plan 5', 'Plan 4', 'Plan 3']);
    });

    it('ignores a damaged file and unusable entries instead of failing', async () => {
        const file = storeFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json');
        const errors: unknown[] = [];
        const damaged = new PartPlanStore(file, error => errors.push(error));
        expect(await damaged.history('900')).toEqual([]);
        expect(errors).toHaveLength(1);
        fs.writeFileSync(file, JSON.stringify({ version: 1, plans: [plan('900', 'Gut', '2026-11-15T08:00:00.000Z'), { vodId: '../x', parts: [] }, { ...plan('902', 'Relativ', 'x'), parts: [{ number: 1, name: 'x', ranges: [{ start: 5, end: 1 }], duration: 1, outputFile: 'relative.mp4', queueItemId: null }] }] }));
        const mixed = new PartPlanStore(file);
        expect(await mixed.vodIds()).toEqual(new Set(['900']));
    });

    it('rejects invalid plans and returns copies', async () => {
        const store = new PartPlanStore(storeFile());
        await expect(store.save({ ...plan('900', 'x', 'y'), vodId: 'abc' })).rejects.toThrow(/Invalid part plan/);
        await store.save(plan('900', 'Original', '2026-11-15T08:00:00.000Z'));
        const [copy] = await store.history('900');
        copy.parts[0].name = 'Verändert';
        expect((await store.history('900'))[0].parts[0].name).toBe('Original');
        await store.flush();
    });
});

it('persists moved output paths without changing time ranges', async () => {
    const file = storeFile(), store = new PartPlanStore(file);
    const original = plan('900', 'Game', '2026-11-15T08:00:00.000Z');
    await store.save(original);
    const destination = path.resolve('/downloads/new/game.mp4');
    await store.relocatePaths([{ source: original.parts[0].outputFile, destination }]);
    const [saved] = await new PartPlanStore(file).history('900');
    expect(saved.parts[0]).toEqual({ ...original.parts[0], outputFile: destination });
});
