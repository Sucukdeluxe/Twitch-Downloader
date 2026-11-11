export interface VideoEditorWaveformProgress {
    jobId: number;
    startIndex: number;
    totalBins: number;
    completedBins: number;
    peaks: number[][];
}

export function createCutterWaveformAccumulator(duration: number, channelCount: number) {
    const channels = Math.max(1, Math.min(8, Math.floor(channelCount)));
    const samplesPerBin = Math.max(256, Math.ceil(duration * 48000 / 32000));
    const totalBins = Math.max(1, Math.min(32000, Math.ceil(duration * 48000 / samplesPerBin)));
    const peaks = Array.from({ length: channels }, () => new Uint8Array(totalBins));
    let pending = '';
    let frameIndex = -1;
    let completedBins = 0;
    let emittedBins = 0;
    let framePeaks = new Map<number, number>();
    const finishFrame = (): void => {
        if (frameIndex < 0 || framePeaks.size !== channels) return;
        const index = Math.min(totalBins - 1, frameIndex);
        framePeaks.forEach((peak, channel) => { peaks[channel][index] = Math.max(peaks[channel][index], peak); });
        completedBins = Math.max(completedBins, index + 1);
    };
    const parseLine = (line: string): void => {
        const frame = /^frame:(\d+)\s/.exec(line);
        if (frame) {
            finishFrame();
            frameIndex = Number(frame[1]);
            framePeaks = new Map();
            return;
        }
        const peak = /^lavfi\.astats\.(\d+)\.Peak_level=(-?inf|[-+\d.eE]+)$/.exec(line.trim());
        if (!peak || frameIndex < 0) return;
        const channel = Number(peak[1]) - 1;
        const decibels = peak[2] === '-inf' ? -Infinity : Number(peak[2]);
        if (channel < 0 || channel >= channels || Number.isNaN(decibels)) return;
        const amplitude = Math.pow(10, decibels / 40);
        framePeaks.set(channel, Math.round(Math.max(0, Math.min(1, amplitude)) * 255));
    };
    return {
        samplesPerBin,
        totalBins,
        peaks,
        get completedBins() { return completedBins; },
        push(chunk: string): void {
            const lines = (pending + chunk).split('\n');
            pending = lines.pop() || '';
            lines.forEach(parseLine);
        },
        finish(): void {
            if (pending) parseLine(pending);
            pending = '';
            finishFrame();
        },
        takeUpdate(jobId: number): VideoEditorWaveformProgress | null {
            if (completedBins <= emittedBins) return null;
            const update = {
                jobId,
                startIndex: emittedBins,
                totalBins,
                completedBins,
                peaks: peaks.map(channel => Array.from(channel.subarray(emittedBins, completedBins))),
            };
            emittedBins = completedBins;
            return update;
        },
    };
}
