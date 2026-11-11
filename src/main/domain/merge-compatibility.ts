import type { VideoSourceFormat } from './media-format';
import { readVideoSourceFormat } from './media-format';

export interface MergeProbe {
    streams: Array<Record<string, any>>;
    format: { duration?: string };
}
export interface MergeCompatibility {
    copyAllowed: boolean;
    encodeAllowed: boolean;
    differences: string[];
    files: Array<{ name: string; duration: number; width: number; height: number; fps: number; codec: string; audioTracks: number; format: VideoSourceFormat }>;
}
const fields = ['codec_type', 'codec_name', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels', 'channel_layout', 'color_primaries', 'color_transfer', 'color_space', 'color_range', 'time_base', 'profile', 'level', 'extradata_hash', 'sample_aspect_ratio'] as const;
const fps = (stream: Record<string, unknown>) => { const [n, d = 1] = String(stream.avg_frame_rate || '0').split('/').map(Number); return d ? n / d : 0; };
const rotation = (stream: Record<string, any>) => Number(stream.side_data_list?.find((value: Record<string, unknown>) => value.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
export function compareMergeMedia(probes: MergeProbe[], names: string[]): MergeCompatibility {
    if (probes.length < 2 || probes.length !== names.length) throw new Error('At least two merge sources are required');
    const base = probes[0].streams;
    const differences = new Set<string>();
    for (const probe of probes.slice(1)) {
        if (base.length !== probe.streams.length) differences.add('streams');
        for (let index = 0; index < Math.max(base.length, probe.streams.length); index++) {
            const left = base[index], right = probe.streams[index];
            if (!left || !right) continue;
            for (const field of fields) if (left[field] !== right[field]) differences.add(field);
            if (Math.abs(fps(left) - fps(right)) > 0.00001) differences.add('frame_rate');
            if (rotation(left) !== rotation(right)) differences.add('rotation');
            if (left.tags?.language !== right.tags?.language) differences.add('language');
        }
    }
    const files = probes.map((probe, index) => {
        const video = probe.streams.find(stream => stream.codec_type === 'video');
        if (!video) throw new Error('Source contains no video');
        return { name: names[index], duration: Number(probe.format.duration), width: Number(video.width), height: Number(video.height), fps: fps(video), codec: String(video.codec_name || ''), audioTracks: probe.streams.filter(stream => stream.codec_type === 'audio').length, format: readVideoSourceFormat(video) };
    });
    const encodeAllowed = files.every(file => !file.format.hdr && file.format.bitDepth === 8 && ['yuv420p', 'yuvj420p'].includes(file.format.pixelFormat) && file.audioTracks === files[0].audioTracks) && probes.every(probe => probe.streams.filter(stream => stream.codec_type === 'video').length === 1 && probe.streams.every(stream => ['audio', 'video'].includes(stream.codec_type))) && files[0].width > 0 && files[0].height > 0 && files[0].width % 2 === 0 && files[0].height % 2 === 0;
    return { copyAllowed: differences.size === 0, encodeAllowed, differences: [...differences], files };
}
