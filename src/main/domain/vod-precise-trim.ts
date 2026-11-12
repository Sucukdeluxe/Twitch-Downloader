import { runMediaProcess, type MediaProcessOptions } from './media-process';

// Part recovery must never reuse the old keyframe-rounded copy output.
export const VOD_TRIM_VERSION = 'precise-mp4-v1';

// Keep sub-frame seek offsets: the default 1/fps encoder timebase can round
// the final in-range frame past -t and discard it. This does not resample fps.
export const preciseVideoEncodingArgs = (): string[] => [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', '-enc_time_base:v', '1:1000000', '-c:a', 'aac', '-b:a', '192k',
];

export function buildPreciseVodTrimArgs(options: {
    input: string; output: string; start?: string | number | null; duration?: string | number | null; inputArgs?: string[]; seekOffset?: number; seekAfterInput?: boolean; audioShiftSeconds?: number;
}): string[] {
    if (!options.output || options.output.startsWith('pipe:')) throw new Error('Precise trim requires a seekable MP4 output');
    const start = options.seekOffset
        ? (String(options.start ?? 0).split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) + options.seekOffset).toFixed(6)
        : options.start;
    const startSeconds = String(start ?? 0).split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(options.audioShiftSeconds ?? 0)) throw new Error('Invalid precise trim timeline');
    const audioFilters = options.audioShiftSeconds ? [`asetpts=PTS+(${options.audioShiftSeconds})/TB`] : [];
    if (options.seekAfterInput) {
        // The player fills the initial AAC gap with silence. Pad relative to the
        // requested start, then restore input coordinates before output seeking.
        // Existing samples keep their timestamps; neither video nor sound moves.
        audioFilters.push(`asetpts=PTS-(${startSeconds})/TB`, 'aresample=first_pts=0', `asetpts=PTS+(${startSeconds})/TB`);
    }
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror',
        ...(options.inputArgs ?? []),
        // HLS seeking can skip the only keyframe of a long GOP. Decode selected
        // snapshot segments and discard preroll with output-side seeking instead.
        // Indexed local MP4 splits retain fast, accurate input seeking.
        ...(!options.seekAfterInput && start !== null && start !== undefined ? ['-ss', String(start), '-accurate_seek'] : []),
        '-i', options.input,
        ...(options.seekAfterInput && start !== null && start !== undefined ? ['-ss', String(start)] : []),
        '-map', '0:v:0', '-map', '0:a:0?',
        ...(audioFilters.length ? ['-af', audioFilters.join(',')] : []),
        ...(options.duration !== null && options.duration !== undefined ? ['-t', String(options.duration)] : []),
        ...preciseVideoEncodingArgs(), '-map_metadata', '-1',
        '-movflags', '+faststart', '-progress', 'pipe:1', '-stats_period', '0.25', '-f', 'mp4', '-y', options.output,
    ];
}

// HLS.js rebases TS media against its first decoding timestamp, not the first
// displayed picture. B-frames therefore make video zero a different timeline.
// Preserve the signed difference from FFmpeg's presentation origin; clamping it
// loses the initial decoding delay and moves every player selection by frames.
interface VodPlaylistProbe {
    format?: { start_time?: string; format_name?: string };
    streams?: Array<{ index?: number; codec_type?: string; codec_name?: string; codec_tag_string?: string; sample_rate?: string; start_time?: string }>;
    packets?: Array<{ stream_index?: number; pts_time?: string; dts_time?: string }>;
}

export interface VodPlaylistTimeline { seekOffset: number; audioShiftSeconds: number; originSeconds: number; formatStartSeconds: number }

export function vodPlaylistTimeline(probe: VodPlaylistProbe, originalContainer?: 'mpegts' | 'fmp4'): VodPlaylistTimeline {
    const timestamp = (value: unknown): number => typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    const origin = timestamp(probe.format?.start_time);
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    const videoPacket = probe.packets?.find(packet => packet.stream_index === video?.index);
    const videoDts = timestamp(videoPacket?.dts_time);
    if (!Number.isFinite(origin) || !video || !Number.isInteger(video.index) || !Number.isFinite(videoDts)) {
        throw new Error('VOD source decoding timeline unavailable');
    }
    // TS timestamps wrap at 2^33 ticks. Demuxers may unwrap the stream start and
    // packets differently, so compare values in the same epoch as format start.
    const wrapSeconds = 2 ** 33 / 90000;
    const inEpoch = (value: number): number => value + Math.round((origin - value) / wrapSeconds) * wrapSeconds;
    let firstDts = inEpoch(videoDts);
    let audioPts = NaN;
    if (audio) {
        const packet = probe.packets?.find(item => item.stream_index === audio.index);
        // Fragmented MP4 interleaving can place audio after the bounded probe.
        // The demuxed audio stream start is the same presentation timestamp.
        audioPts = packet ? timestamp(packet.pts_time) : timestamp(audio.start_time);
        if (!Number.isInteger(audio.index) || !Number.isFinite(audioPts)) throw new Error('VOD source audio timeline unavailable');
        firstDts = Math.min(firstDts, inEpoch(audioPts));
    }
    // HLS.js fills larger AAC gaps, but snaps a sub-packet initial gap to the
    // video decoding origin. fMP4 is passed through and must not get that shift.
    const container = originalContainer ?? (/^(?:avc[13]|hev1|hvc1|av01)$/.test(video.codec_tag_string ?? '') ? 'fmp4' : 'mpegts');
    const sampleRate = Number(audio?.sample_rate);
    const gap = Number.isFinite(audioPts) ? inEpoch(audioPts) - firstDts : 0;
    const audioShiftSeconds = container === 'mpegts' && audio?.codec_name === 'aac' && sampleRate > 0
        && gap > 0 && gap < 1024 / sampleRate ? -gap : 0;
    return { seekOffset: firstDts - origin, audioShiftSeconds, originSeconds: firstDts, formatStartSeconds: origin };
}

export function vodPlaylistSeekOffset(probe: VodPlaylistProbe): number {
    return vodPlaylistTimeline(probe).seekOffset;
}

export async function readVodPlaylistTimeline(ffprobe: string, input: string, options: MediaProcessOptions = {}, localSnapshot = false, originalContainer?: 'mpegts' | 'fmp4'): Promise<VodPlaylistTimeline> {
    const raw = await runMediaProcess(ffprobe, ['-v', 'error', '-rw_timeout', '30000000', '-live_start_index', '0',
        ...(localSnapshot ? ['-protocol_whitelist', 'file,crypto,data,https,tls,tcp,httpproxy'] : []),
        '-read_intervals', '%+1', '-show_packets', '-show_entries',
        'format=start_time,format_name:stream=index,codec_type,codec_name,codec_tag_string,sample_rate,start_time:packet=stream_index,pts_time,dts_time', '-of', 'json', input,
    ], { ...options, timeoutMs: Math.min(options.timeoutMs ?? 60000, 60000) });
    return vodPlaylistTimeline(JSON.parse(raw) as VodPlaylistProbe, originalContainer);
}

export async function readVodPlaylistSeekOffset(ffprobe: string, input: string, options: MediaProcessOptions = {}, localSnapshot = false): Promise<number> {
    return (await readVodPlaylistTimeline(ffprobe, input, options, localSnapshot)).seekOffset;
}

export interface VodMediaInfo {
    duration: number; frameSeconds: number; width: number; height: number; hasAudio: boolean; signature: string; format: string; videoStartSeconds: number; audioStartSeconds: number;
}

export async function probeVodMedia(ffprobe: string, filename: string, options: MediaProcessOptions = {}): Promise<VodMediaInfo> {
    const raw = await runMediaProcess(ffprobe, [
        '-v', 'error', '-show_entries',
        'format=format_name,duration,start_time:stream=start_time,codec_type,codec_name,profile,level,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,time_base,sample_rate,channels,channel_layout,extradata_hash',
        '-show_data_hash', 'sha256', '-of', 'json', filename,
    ], options);
    const data = JSON.parse(raw) as { format?: { duration?: string; format_name?: string; start_time?: string }; streams?: Array<Record<string, unknown>> };
    const streams = data.streams?.filter(stream => stream.codec_type === 'video' || stream.codec_type === 'audio') ?? [];
    const video = streams.find(stream => stream.codec_type === 'video');
    const [numerator, denominator] = String(video?.r_frame_rate ?? '').split('/').map(Number);
    const frameSeconds = denominator / numerator;
    const duration = Number(data.format?.duration);
    if (!video || !(duration > 0)
        || !(frameSeconds > 0) || !Number.isFinite(frameSeconds)) throw new Error('Invalid precise VOD media');
    return { duration, frameSeconds, width: Number(video.width), height: Number(video.height),
        hasAudio: streams.some(stream => stream.codec_type === 'audio'), signature: JSON.stringify(streams.map(({ start_time: _start, ...stream }) => stream)),
        videoStartSeconds: Math.max(0, (Number(video.start_time) || 0) - (Number(data.format?.start_time) || 0)),
        audioStartSeconds: Math.max(0, (Number(streams.find(stream => stream.codec_type === 'audio')?.start_time) || 0) - (Number(data.format?.start_time) || 0)), format: data.format?.format_name ?? '' };
}

export async function verifyPreciseVodOutput(ffprobe: string, filename: string, duration: number | null, options: MediaProcessOptions = {}): Promise<VodMediaInfo> {
    const info = await probeVodMedia(ffprobe, filename, options);
    if (!info.format.split(',').includes('mp4')) throw new Error('Invalid precise VOD container');
    // Video is sampled on the source frame grid; AAC's final packet is padded.
    if (duration !== null && Math.abs(info.duration - duration) > info.frameSeconds + 0.025) {
        throw new Error(`Precise VOD duration differs: ${info.duration} instead of ${duration}`);
    }
    return info;
}

// Separate decoders are essential when source codecs differ (e.g. HEVC whole
// VOD plus H.264 trim). The concat demuxer cannot safely switch codec parameters.
export function buildVodConcatArgs(inputs: Array<{ filename: string; info: VodMediaInfo; duration?: number }>, output: string): string[] {
    if (!inputs.length) throw new Error('No VOD inputs');
    const first = inputs[0].info;
    const width = Math.ceil(first.width / 2) * 2, height = Math.ceil(first.height / 2) * 2;
    const audio = inputs.some(input => input.info.hasAudio);
    const filters: string[] = [], videoLabels: string[] = [], audioLabels: string[] = [];
    let offset = 0;
    inputs.forEach((input, index) => {
        const duration = input.duration ?? input.info.duration;
        filters.push(`[${index}:v:0]trim=duration=${duration},settb=AVTB,setpts=PTS-STARTPTS+${offset + input.info.videoStartSeconds}/TB,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`);
        videoLabels.push(`[v${index}]`);
        if (audio) {
            filters.push(input.info.hasAudio
                ? `[${index}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(input.info.audioStartSeconds * 48000)}S:all=1,apad,atrim=duration=${duration}[a${index}]`
                : `anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${index}]`);
            audioLabels.push(`[a${index}]`);
        }
        offset += duration;
    });
    // A/V concat pads to the longest stream in each segment, accumulating a
    // frame of audio drift at every fractional cut. Interleave video on the
    // requested timeline while concatenating exact audio durations separately.
    filters.push(`${videoLabels.join('')}interleave=nb_inputs=${inputs.length}[v]`);
    if (audio) filters.push(`${audioLabels.join('')}concat=n=${inputs.length}:v=0:a=1[a]`);
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', ...inputs.flatMap(input => ['-i', input.filename]),
        '-filter_complex', filters.join(';'), '-map', '[v]', ...(audio ? ['-map', '[a]'] : []),
        ...preciseVideoEncodingArgs(), '-map_metadata', '-1', '-movflags', '+faststart',
        '-progress', 'pipe:1', '-stats_period', '0.25', '-f', 'mp4', '-y', output];
}
