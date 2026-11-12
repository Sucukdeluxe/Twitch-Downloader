export interface AudioProcessingOptions {
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    normalize?: boolean;
}
export interface LoudnessMeasurement {
    inputI: number;
    inputTp: number;
    inputLra: number;
    inputThresh: number;
    targetOffset: number;
}
export function normalizeAudioProcessing(value: unknown, duration: number): Required<AudioProcessingOptions> {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid audio duration');
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid audio processing');
    const options = (value || {}) as Record<string, unknown>;
    const fadeInSeconds = options.fadeInSeconds ?? 0;
    const fadeOutSeconds = options.fadeOutSeconds ?? 0;
    if (typeof fadeInSeconds !== 'number' || !Number.isFinite(fadeInSeconds) || fadeInSeconds < 0
        || typeof fadeOutSeconds !== 'number' || !Number.isFinite(fadeOutSeconds) || fadeOutSeconds < 0
        || fadeInSeconds + fadeOutSeconds > duration || (options.normalize !== undefined && typeof options.normalize !== 'boolean')) throw new Error('Invalid audio processing');
    return { fadeInSeconds, fadeOutSeconds, normalize: options.normalize === true };
}
function number(value: number): string { return Number(value.toFixed(6)).toString(); }
export function parseLoudnessMeasurement(stderr: string): LoudnessMeasurement | null {
    const matches = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
    if (!matches?.length) return null;
    const data = JSON.parse(matches[matches.length - 1]) as Record<string, unknown>;
    const measurement = { inputI: Number(data.input_i), inputTp: Number(data.input_tp), inputLra: Number(data.input_lra), inputThresh: Number(data.input_thresh), targetOffset: Number(data.target_offset) };
    if (!Object.values(measurement).every(Number.isFinite)) return null;
    if (measurement.inputI < -99 || measurement.inputI > 0 || measurement.inputTp < -99 || measurement.inputTp > 99
        || measurement.inputLra < 0 || measurement.inputLra > 99 || measurement.inputThresh < -99 || measurement.inputThresh > 0
        || Math.abs(measurement.targetOffset) > 99) return null;
    return measurement;
}
export function createAudioTimelineFilter(sampleRate?: number): string {
    return 'aresample=' + (sampleRate === undefined ? '' : sampleRate + ':') + 'async=1:first_pts=0';
}

export function createAudioProcessingFilters(value: AudioProcessingOptions | undefined, duration: number, measurement?: LoudnessMeasurement): string[] {
    const options = normalizeAudioProcessing(value, duration);
    const filters: string[] = [];
    if (options.normalize) {
        let loudnorm = 'loudnorm=I=-16:TP=-1.5:LRA=11';
        if (measurement) {
            if (!Object.values(measurement).every(Number.isFinite)) throw new Error('Invalid loudness measurement');
            loudnorm += ':measured_I=' + number(measurement.inputI) + ':measured_TP=' + number(measurement.inputTp)
                + ':measured_LRA=' + number(measurement.inputLra) + ':measured_thresh=' + number(measurement.inputThresh)
                + ':offset=' + number(measurement.targetOffset) + ':linear=true';
        }
        filters.push(loudnorm, 'aresample=48000');
    }
    if (options.fadeInSeconds > 0) filters.push('afade=t=in:st=0:d=' + number(options.fadeInSeconds));
    if (options.fadeOutSeconds > 0) filters.push('afade=t=out:st=' + number(duration - options.fadeOutSeconds) + ':d=' + number(options.fadeOutSeconds));
    return filters;
}

export function validAudioProcessing(value: unknown, duration: number): boolean {
    try { normalizeAudioProcessing(value, duration); return true; } catch { return false; }
}
