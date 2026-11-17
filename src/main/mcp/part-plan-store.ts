import { relocateRecordingPath, type RecordingPathMove } from '../domain/recording-paths';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TimeRange } from './part-plan';

export interface StoredPart { number: number; name: string; ranges: TimeRange[]; duration: number; outputFile: string; queueItemId: string | null }
export interface StoredPlan { vodId: string; channel: string; title: string; startedAt: string; durationSeconds: number; savedAt: string; parts: StoredPart[] }

const MAX_PLANS = 300;
const MAX_PLANS_PER_VOD = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function isRange(value: unknown): value is TimeRange {
    const range = value as TimeRange | null;
    return Boolean(range) && Number.isFinite(range!.start) && Number.isFinite(range!.end) && range!.start >= 0 && range!.end > range!.start;
}

function parsePlan(value: unknown): StoredPlan | null {
    const plan = value as StoredPlan | null;
    if (!plan || typeof plan !== 'object' || typeof plan.vodId !== 'string' || !/^[0-9]{1,20}$/.test(plan.vodId) || typeof plan.channel !== 'string'
        || typeof plan.title !== 'string' || typeof plan.startedAt !== 'string' || typeof plan.savedAt !== 'string'
        || !Number.isFinite(plan.durationSeconds) || !Array.isArray(plan.parts) || plan.parts.length === 0 || plan.parts.length > 200) return null;
    const parts = plan.parts.flatMap((part): StoredPart[] => {
        if (!part || !Number.isInteger(part.number) || typeof part.name !== 'string' || !Array.isArray(part.ranges) || !part.ranges.every(isRange)
            || !Number.isFinite(part.duration) || typeof part.outputFile !== 'string' || !path.isAbsolute(part.outputFile)) return [];
        return [{
            number: part.number, name: part.name.slice(0, 200), ranges: part.ranges.map(range => ({ start: range.start, end: range.end })), duration: part.duration,
            outputFile: part.outputFile, queueItemId: typeof part.queueItemId === 'string' ? part.queueItemId : null,
        }];
    });
    if (parts.length !== plan.parts.length) return null;
    return { vodId: plan.vodId, channel: plan.channel.slice(0, 60), title: plan.title.slice(0, 500), startedAt: plan.startedAt, durationSeconds: plan.durationSeconds, savedAt: plan.savedAt, parts };
}

export class PartPlanStore {
    private plans: StoredPlan[] | null = null;
    private pending: Promise<unknown> = Promise.resolve();

    constructor(private readonly filePath: string, private readonly onError: (error: unknown) => void = () => undefined) {}

    private async load(): Promise<StoredPlan[]> {
        if (this.plans) return this.plans;
        let plans: StoredPlan[] = [];
        try {
            const stat = await fs.stat(this.filePath);
            if (stat.size <= MAX_FILE_BYTES) {
                const document = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as { version?: unknown; plans?: unknown };
                if (document?.version === 1 && Array.isArray(document.plans)) plans = document.plans.flatMap(entry => parsePlan(entry) ?? []);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error);
        }
        this.plans = plans;
        return plans;
    }

    async history(vodId: string): Promise<StoredPlan[]> {
        return structuredClone((await this.load()).filter(plan => plan.vodId === vodId).reverse());
    }

    async vodIds(): Promise<Set<string>> {
        return new Set((await this.load()).map(plan => plan.vodId));
    }

    save(plan: StoredPlan): Promise<void> {
        const task = this.pending.then(async () => {
            const valid = parsePlan(plan);
            if (!valid) throw new Error('Invalid part plan');
            const current = await this.load();
            const others = current.filter(entry => entry.vodId !== valid.vodId);
            const same = [...current.filter(entry => entry.vodId === valid.vodId), valid].slice(-MAX_PLANS_PER_VOD);
            const next = [...others, ...same].slice(-MAX_PLANS);
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const temporary = this.filePath + '.tmp';
            await fs.writeFile(temporary, JSON.stringify({ version: 1, plans: next }));
            await fs.rename(temporary, this.filePath);
            this.plans = next;
        });
        this.pending = task.catch(error => this.onError(error));
        return task;
    }

    relocatePaths(moves: readonly RecordingPathMove[]): Promise<void> {
        const task = this.pending.then(async () => {
            const current = await this.load();
            const next = current.map(plan => ({ ...plan, parts: plan.parts.map(part => ({ ...part, outputFile: relocateRecordingPath(part.outputFile, moves) })) }));
            if (JSON.stringify(current) === JSON.stringify(next)) return;
            const temporary = this.filePath + '.tmp';
            await fs.writeFile(temporary, JSON.stringify({ version: 1, plans: next }));
            await fs.rename(temporary, this.filePath);
            this.plans = next;
        });
        this.pending = task.catch(error => this.onError(error));
        return task;
    }

    flush(): Promise<void> {
        return this.pending.then(() => undefined);
    }
}
