export interface VideoSourceFormat {
    pixelFormat: string;
    bitDepth: number;
    colorPrimaries: string | null;
    colorTransfer: string | null;
    colorSpace: string | null;
    colorRange: string | null;
    hdr: boolean;
    dynamicHdr: boolean;
}

export type CutterColorMode = 'source' | 'sdr';
export type CutterSoftwareCodec = 'libx264' | 'libx265' | 'libx264rgb' | 'ffv1';

function colorTag(value: unknown): string | null {
    return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) && !['unknown', 'unspecified', 'reserved'].includes(value) ? value : null;
}

export function readVideoSourceFormat(stream: Record<string, unknown>): VideoSourceFormat {
    const pixelFormat = typeof stream.pix_fmt === 'string' && /^[a-z0-9]{1,32}$/.test(stream.pix_fmt) ? stream.pix_fmt : 'unknown';
    const depth = pixelFormat.match(/(?:p|gray|rgb|rgba)(9|10|12|14|16)(?:le|be)?$/);
    const rawDepth = Number(stream.bits_per_raw_sample);
    const bitDepth = depth ? Number(depth[1]) : rawDepth >= 8 && rawDepth <= 32 ? rawDepth : pixelFormat.includes('48') || pixelFormat.includes('64') ? 16 : 8;
    const colorTransfer = colorTag(stream.color_transfer);
    const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
    return {
        pixelFormat, bitDepth,
        colorPrimaries: colorTag(stream.color_primaries),
        colorTransfer,
        colorSpace: colorTag(stream.color_space),
        colorRange: colorTag(stream.color_range),
        hdr: colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67',
        dynamicHdr: sideData.some(entry => entry && typeof entry === 'object' && /dovi|dolby|hdr10\+/i.test(String(entry.side_data_type))),
    };
}

export function cutterVideoFormat(source: VideoSourceFormat, archive: boolean, mode: CutterColorMode = 'source'): {
    codec: CutterSoftwareCodec; pixelFormat: string; bitDepth: number; hdr: boolean; filters: string[]; args: string[];
} {
    if (mode !== 'source' && mode !== 'sdr') throw new Error('Unsupported color mode');
    if (source.dynamicHdr && mode === 'source') throw new Error('Dynamic HDR requires SDR conversion for editing');
    const convert = mode === 'sdr' && source.hdr;
    if (convert && (!source.colorPrimaries || !source.colorSpace || !source.colorTransfer)) throw new Error('HDR color metadata is incomplete');
    const filters: string[] = [];
    if (convert) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA', 'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL');
    let pixelFormat = mode === 'sdr' ? 'yuv420p' : source.pixelFormat.replace(/^yuvj/, 'yuv');
    let codec: CutterSoftwareCodec = archive ? 'ffv1' : source.hdr && mode === 'source' ? 'libx265' : 'libx264';
    if (archive) {
        if (pixelFormat === 'rgb24' || pixelFormat === 'bgr24' || pixelFormat === 'gbrp') pixelFormat = 'bgr0';
        if (pixelFormat === 'rgba' || pixelFormat === 'argb' || pixelFormat === 'abgr') pixelFormat = 'bgra';
    } else if (mode === 'source' && /^(rgb24|bgr24|bgr0|gbrp)$/.test(pixelFormat)) {
        codec = 'libx264rgb';
        if (pixelFormat === 'gbrp') pixelFormat = 'rgb24';
    }
    else if (mode === 'source' && source.bitDepth > 10) codec = 'libx265';
    const supported = codec === 'ffv1'
        ? /^(yuv(?:a)?(?:420|422|444|440|411|410)p(?:(?:9|10|12|14|16)le)?|gbr(?:a)?p(?:9|10|12|14|16)le|gray(?:(?:9|10|12|14|16)le)?|bgr0|bgra|rgb48le|rgba64le|ya8)$/
        : codec === 'libx264rgb' ? /^(rgb24|bgr24|bgr0)$/
        : codec === 'libx265' ? /^(yuv(?:420|422|444)p(?:(?:10|12)le)?|gbrp(?:(?:10|12)le)?|gray(?:(?:10|12)le)?)$/
        : /^(yuv(?:420|422|444)p(?:10le)?|gray(?:10le)?)$/;
    if (!supported.test(pixelFormat)) throw new Error('Source pixel format requires a different export profile: ' + source.pixelFormat);
    const tags = convert
        ? { colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv' }
        : source;
    const args: string[] = [];
    for (const [key, flag] of [['colorPrimaries', '-color_primaries'], ['colorTransfer', '-color_trc'], ['colorSpace', '-colorspace'], ['colorRange', '-color_range']] as const) {
        if (tags[key]) args.push(flag, tags[key]!);
    }
    if (tags.colorPrimaries && tags.colorTransfer && tags.colorSpace) filters.push('setparams=color_primaries=' + tags.colorPrimaries + ':color_trc=' + tags.colorTransfer + ':colorspace=' + tags.colorSpace + (tags.colorRange ? ':range=' + tags.colorRange : ''));
    return { codec, pixelFormat, bitDepth: mode === 'sdr' ? 8 : source.bitDepth, hdr: mode === 'source' && source.hdr, filters, args };
}
