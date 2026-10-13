import type { Mp4FinalizationProgress } from '../../types';

export class Mp4ProgressTracker {
    private pending = '';
    private fields: Record<string, string> = {};
    private readonly startedAt: number;
    private previousAt: number;
    private previousBytes = 0;
    private state: Mp4FinalizationProgress;

    constructor(duration: number | undefined, private readonly emit: (progress: Mp4FinalizationProgress) => void, private readonly now: () => number = Date.now) {
        this.startedAt = this.previousAt = now();
        this.state = { stage: 'writing', elapsedSeconds: 0, ...(Number.isFinite(duration) && duration! > 0 ? { durationSeconds: duration } : {}) };
    }

    setStage(stage: Mp4FinalizationProgress['stage']): void {
        this.state.stage = stage;
        if (stage !== 'writing') {
            delete this.state.percent;
            delete this.state.etaSeconds;
            delete this.state.speedBytesPerSec;
        }
        this.publish();
    }

    push(chunk: string): void {
        const lines = (this.pending + chunk).split(/\r?\n/);
        this.pending = (lines.pop() || '').slice(-4096);
        for (const line of lines) {
            const separator = line.indexOf('=');
            if (separator < 1) continue;
            const key = line.slice(0, separator), value = line.slice(separator + 1).trim();
            if (['out_time_us', 'out_time_ms', 'total_size', 'speed'].includes(key)) this.fields[key] = value;
            if (key !== 'progress') continue;
            const time = Number(this.fields.out_time_us ?? this.fields.out_time_ms);
            if (Number.isFinite(time) && time >= 0) this.state.processedSeconds = Math.max(this.state.processedSeconds || 0, time / 1000000);
            const bytes = Number(this.fields.total_size);
            const now = this.now();
            if (Number.isFinite(bytes) && bytes >= this.previousBytes) {
                this.state.writtenBytes = bytes;
                if (this.state.stage === 'writing' && now > this.previousAt && bytes > this.previousBytes) this.state.speedBytesPerSec = (bytes - this.previousBytes) / ((now - this.previousAt) / 1000);
                this.previousBytes = bytes;
            }
            this.previousAt = now;
            if (this.state.stage === 'writing' && this.state.durationSeconds && this.state.processedSeconds !== undefined) {
                this.state.percent = Math.min(100, this.state.processedSeconds / this.state.durationSeconds * 100);
                const rate = Number(this.fields.speed?.replace(/x$/, ''));
                if (Number.isFinite(rate) && rate > 0) this.state.etaSeconds = Math.max(0, this.state.durationSeconds - this.state.processedSeconds) / rate;
            }
            this.fields = {};
            this.publish();
        }
    }

    private publish(): void {
        this.state.elapsedSeconds = Math.max(0, (this.now() - this.startedAt) / 1000);
        this.emit({ ...this.state });
    }
}
