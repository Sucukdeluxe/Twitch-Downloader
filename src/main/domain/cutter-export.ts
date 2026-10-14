import { createAudioTimelineFilter, createAudioProcessingFilters, type AudioProcessingOptions } from './audio-processing';
import * as path from 'node:path';
import type { EditorSegment } from './video-editor';
import { cutterVideoFormat, readVideoSourceFormat, type VideoSourceFormat, type CutterColorMode, type CutterSoftwareCodec } from './media-format';

export type CutterExportProfile = 'quality' | 'balanced' | 'fast' | 'archive';
export type CutterHardwareEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf';
export type CutterExportEncoder = 'software' | CutterHardwareEncoder;

export interface CutterExportProfileDefinition {
    id: CutterExportProfile;
    label: string;
    container: 'mp4' | 'mkv';
}

export const CUTTER_EXPORT_PROFILES: CutterExportProfileDefinition[] = [
    { id: 'quality', label: 'Quality', container: 'mp4' },
    { id: 'balanced', label: 'Balanced', container: 'mp4' },
    { id: 'fast', label: 'Fast', container: 'mp4' },
    { id: 'archive', label: 'Archive', container: 'mkv' },
];

export interface CutterExportPlanOptions {
    startTime?: number;
    audioProcessing?: AudioProcessingOptions;
    inputFile: string;
    outputFile: string;
    segments: readonly EditorSegment[];
    hasAudio: boolean;
    profile?: CutterExportProfile;
    encoder?: CutterExportEncoder;
    availableHardwareEncoders?: readonly CutterHardwareEncoder[];
    audioStreamIndex?: number;
    audioStreamIndices?: readonly number[];
    audioStreams?: readonly { index: number; language: string | null }[];
    sourceFormat?: VideoSourceFormat;
    colorMode?: CutterColorMode;
    rotation?: number;
}

export interface CutterExportPlan {
    segments: EditorSegment[];
    remainingDuration: number;
    filterComplex: string;
    ffmpegArgs: string[];
    profile: CutterExportProfile;
    selectedEncoder: CutterSoftwareCodec | CutterHardwareEncoder;
    hardwareFallback: boolean;
    pixelFormat: string;
    bitDepth: number;
    hdr: boolean;
    audioStreamIndices: number[];
}

const precision = 9;
const hardwareEncoders: CutterHardwareEncoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

function round(value: number): number {
    return Number(value.toFixed(precision));
}

function formatSeconds(value: number): string {
    return value.toFixed(precision).replace(/\.?0+$/, '');
}

function validatePath(value: string, name: string): string {
    if (!value.trim()) throw new Error(`${name} must not be empty`);
    return value;
}

function normalizeSegments(segments: readonly EditorSegment[]): EditorSegment[] {
    if (segments.length === 0) throw new Error('At least one playable segment is required');
    const normalized = segments.map((segment) => {
        if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
            throw new Error('Segment boundaries must be finite');
        }
        if (segment.start < 0 || segment.end <= segment.start) {
            throw new Error('Segment boundaries must be ordered and non-negative');
        }
        const start = round(segment.start);
        const end = round(segment.end);
        if (end <= start) throw new Error('Segment duration is below export precision');
        return { start, end };
    }).sort((left, right) => left.start - right.start || left.end - right.end);

    for (let index = 1; index < normalized.length; index += 1) {
        if (normalized[index].start < normalized[index - 1].end) {
            throw new Error('Playable segments must not overlap');
        }
    }

    return normalized;
}

function getProfileDefinition(profile: CutterExportProfile): CutterExportProfileDefinition {
    const definition = CUTTER_EXPORT_PROFILES.find((entry) => entry.id === profile);
    if (!definition) throw new Error('Unsupported cutter export profile');
    return definition;
}

function normalizeRotation(rotation: number | undefined): 0 | 90 | 180 | 270 {
    const normalized = ((rotation ?? 0) % 360 + 360) % 360;
    if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) return normalized;
    throw new Error('Rotation must be 0, 90, 180, or 270 degrees');
}

function normalizeAudioStreamIndex(value: number | undefined): number {
    const index = value ?? 0;
    if (!Number.isInteger(index) || index < 0) throw new Error('audioStreamIndex must be a non-negative integer');
    return index;
}

function videoRotationFilter(rotation: 0 | 90 | 180 | 270): string | null {
    if (rotation === 90) return 'transpose=1';
    if (rotation === 180) return 'hflip,vflip';
    if (rotation === 270) return 'transpose=2';
    return null;
}

function createFilterComplex(segments: readonly EditorSegment[], indices: readonly number[], rotation: 0 | 90 | 180 | 270, videoFormatFilters: readonly string[], audioFilters: readonly string[]): string {
    const filters: string[] = [];
    const concatInputs: string[] = [];
    const rotationFilter = videoRotationFilter(rotation);
    const audioInputLabel = (index: number, audioIndex: number): string => '[s' + (index * indices.length + audioIndex) + ']';
    indices.forEach((stream, audioIndex) => {
        const input = stream === 0 ? '[0:a]' : '[0:a:' + stream + ']';
        const outputs = segments.map((_, index) => audioInputLabel(index, audioIndex)).join('');
        filters.push(input + createAudioTimelineFilter() + ',apad=whole_dur=' + formatSeconds(segments[segments.length - 1].end)
            + (segments.length > 1 ? ',asplit=' + segments.length : '') + outputs);
    });
    segments.forEach((segment, index) => {
        const start = formatSeconds(segment.start);
        const end = formatSeconds(segment.end);
        const videoFilters = ["trim=start=" + start + ":end=" + end, 'setpts=PTS-STARTPTS', ...videoFormatFilters];
        if (rotationFilter) videoFilters.push(rotationFilter);
        filters.push('[0:v]' + videoFilters.join(',') + '[v' + index + ']');
        concatInputs.push('[v' + index + ']');
        indices.forEach((_, audioIndex) => {
            const input = audioInputLabel(index, audioIndex);
            const label = '[a' + index + (audioIndex ? '_' + audioIndex : '') + ']';
            filters.push(input + 'atrim=start=' + start + ':end=' + end + ',asetpts=PTS-STARTPTS' + label);
            concatInputs.push(label);
        });
    });
    filters.push(concatInputs.join('') + 'concat=n=' + segments.length + ':v=1:a=' + indices.length + '[outv]' + indices.map((_, index) => '[' + (audioFilters.length ? 'rawa' : 'outa') + (index || '') + ']').join(''));
    if (audioFilters.length) indices.forEach((_, index) => filters.push('[rawa' + (index || '') + ']' + audioFilters.join(',') + '[outa' + (index || '') + ']'));
    return filters.join(';');
}

function resolveEncoder(profile: CutterExportProfile, requested: CutterExportEncoder, availableHardwareEncoders: readonly CutterHardwareEncoder[]): { selectedEncoder: CutterExportPlan['selectedEncoder']; hardwareFallback: boolean } {
    if (profile === 'archive') {
        return { selectedEncoder: 'ffv1', hardwareFallback: requested !== 'software' };
    }
    if (requested === 'software') {
        return { selectedEncoder: 'libx264', hardwareFallback: false };
    }
    if (hardwareEncoders.includes(requested) && availableHardwareEncoders.includes(requested)) {
        return { selectedEncoder: requested, hardwareFallback: false };
    }
    return { selectedEncoder: 'libx264', hardwareFallback: true };
}

function softwareVideoArgs(profile: CutterExportProfile): string[] {
    if (profile === 'quality') return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18'];
    if (profile === 'fast') return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'];
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
}

function hardwareVideoArgs(profile: Exclude<CutterExportProfile, 'archive'>, encoder: CutterHardwareEncoder): string[] {
    const quality = profile === 'quality' ? '18' : profile === 'balanced' ? '20' : '23';
    if (encoder === 'h264_nvenc') {
        return ['-c:v', encoder, '-preset', profile === 'quality' ? 'p6' : profile === 'balanced' ? 'p4' : 'p1', '-cq', quality, '-b:v', '0'];
    }
    if (encoder === 'h264_qsv') {
        return ['-c:v', encoder, '-preset', profile === 'quality' ? 'slow' : profile === 'balanced' ? 'medium' : 'veryfast', '-global_quality', quality];
    }
    return ['-c:v', encoder, '-quality', profile === 'quality' ? 'quality' : profile === 'balanced' ? 'balanced' : 'speed', '-rc', 'cqp', '-qp_i', quality, '-qp_p', quality];
}

function audioArgs(profile: CutterExportProfile, hasAudio: boolean): string[] {
    if (!hasAudio) return ['-an'];
    if (profile === 'archive') return ['-c:a', 'pcm_f64le'];
    const bitrate = profile === 'quality' ? '192k' : profile === 'balanced' ? '160k' : '128k';
    return ['-c:a', 'aac', '-b:a', bitrate];
}

function createFfmpegArgs(inputFile: string, outputFile: string, filterComplex: string, indices: readonly number[], profile: CutterExportProfile, selectedEncoder: CutterExportPlan['selectedEncoder'], rotation: 0 | 90 | 180 | 270, format: ReturnType<typeof cutterVideoFormat>, audioStreams: CutterExportPlanOptions['audioStreams'], startTime: number): string[] {
    const args: string[] = [];
    if (rotation !== 0) args.push('-noautorotate');
    args.push('-copyts', '-itsoffset', formatSeconds(-startTime), '-i', inputFile, '-filter_complex', filterComplex, '-map', '[outv]');
    indices.forEach((_, index) => args.push('-map', '[outa' + (index || '') + ']'));
    if (selectedEncoder === 'ffv1') args.push('-c:v', 'ffv1', '-level', '3', '-g', '1');
    else if (selectedEncoder === 'libx264' || selectedEncoder === 'libx265' || selectedEncoder === 'libx264rgb') {
        const software = softwareVideoArgs(profile);
        software[1] = selectedEncoder;
        args.push(...software);
        if (selectedEncoder === 'libx265') args.push('-tag:v', 'hvc1', '-x265-params', 'pools=2:frame-threads=2');
    } else args.push(...hardwareVideoArgs(profile as Exclude<CutterExportProfile, 'archive'>, selectedEncoder));
    args.push('-pix_fmt', format.pixelFormat, ...format.args, ...audioArgs(profile, indices.length > 0));
    indices.forEach((stream, index) => {
        const language = audioStreams?.find(entry => entry.index === stream)?.language;
        if (language) args.push('-metadata:s:a:' + index, 'language=' + language);
    });
    if (profile !== 'archive') args.push('-movflags', '+faststart');
    args.push('-progress', 'pipe:1', '-y', outputFile);
    return args;
}

export function parseCutterHardwareEncoders(ffmpegEncodersOutput: string): CutterHardwareEncoder[] {
    const available = new Set(ffmpegEncodersOutput.toLowerCase().match(/\bh264_(?:nvenc|qsv|amf)\b/g) || []);
    return hardwareEncoders.filter(encoder => available.has(encoder));
}

export function getCutterHardwareProbeArguments(encoder: CutterHardwareEncoder): string[] {
    return ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-'];
}

export async function probeCutterHardwareEncoders(
    candidates: readonly CutterHardwareEncoder[],
    probe: (encoder: CutterHardwareEncoder, args: readonly string[]) => Promise<boolean>,
): Promise<CutterHardwareEncoder[]> {
    const verified: CutterHardwareEncoder[] = [];
    for (const encoder of hardwareEncoders) {
        if (candidates.includes(encoder) && await probe(encoder, getCutterHardwareProbeArguments(encoder))) verified.push(encoder);
    }
    return verified;
}

export function getCutterExportProfile(profile: CutterExportProfile): CutterExportProfileDefinition {
    return getProfileDefinition(profile);
}

export function createCutterExportPlan(options: CutterExportPlanOptions): CutterExportPlan {
    const inputFile = validatePath(options.inputFile, 'inputFile');
    const startTime = options.startTime ?? 0;
    if (!Number.isFinite(startTime)) throw new Error('Start time must be finite');
    const outputFile = validatePath(options.outputFile, 'outputFile');
    const profile = options.profile ?? 'balanced';
    const profileDefinition = getProfileDefinition(profile);
    const expectedExtension = `.${profileDefinition.container}`;
    if (path.extname(outputFile).toLowerCase() !== expectedExtension) {
        throw new Error(`${profileDefinition.container.toUpperCase()} output is required for the ${profile} profile`);
    }
    const segments = normalizeSegments(options.segments);
    const audioStreamIndex = normalizeAudioStreamIndex(options.audioStreamIndex);
    const indices = options.hasAudio ? (options.audioStreamIndices ? [...new Set(options.audioStreamIndices.map(normalizeAudioStreamIndex))] : [audioStreamIndex]) : [];
    if (indices.length > 32) throw new Error('Too many audio streams');
    const format = cutterVideoFormat(options.sourceFormat ?? readVideoSourceFormat({ pix_fmt: 'yuv420p' }), profile === 'archive', options.colorMode);
    const rotation = normalizeRotation(options.rotation);
    const requestedEncoder = options.encoder ?? 'software';
    const canUseHardware = format.codec === 'libx264' && format.pixelFormat === 'yuv420p';
    const encoder = canUseHardware ? resolveEncoder(profile, requestedEncoder, options.availableHardwareEncoders ?? []) : { selectedEncoder: format.codec, hardwareFallback: requestedEncoder !== 'software' };
    const remainingDuration = round(segments.reduce((total, segment) => total + segment.end - segment.start, 0));
    const filterComplex = createFilterComplex(segments, indices, rotation, format.filters, createAudioProcessingFilters(options.audioProcessing, remainingDuration));
    return {
        segments,
        remainingDuration,
        filterComplex,
        ffmpegArgs: createFfmpegArgs(inputFile, outputFile, filterComplex, indices, profile, encoder.selectedEncoder, rotation, format, options.audioStreams, startTime),
        profile,
        selectedEncoder: encoder.selectedEncoder,
        hardwareFallback: encoder.hardwareFallback,
        pixelFormat: format.pixelFormat,
        bitDepth: format.bitDepth,
        hdr: format.hdr,
        audioStreamIndices: indices,
    };
}

export function calculateCutterExportProgress(processedSeconds: number, plan: Pick<CutterExportPlan, 'remainingDuration'>): number {
    if (!Number.isFinite(processedSeconds) || processedSeconds <= 0) return 0;
    if (!Number.isFinite(plan.remainingDuration) || plan.remainingDuration <= 0) {
        throw new Error('remainingDuration must be greater than zero');
    }
    return Math.min(100, round(processedSeconds / plan.remainingDuration * 100));
}
