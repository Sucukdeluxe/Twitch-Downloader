import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveVodPlaybackSource } from './vod-quality';
import { runMediaProcess } from './media-process';
import { resolveVodTrimSource } from './vod-source-download';

vi.mock('./vod-quality', async importOriginal => ({
    ...await importOriginal<typeof import('./vod-quality')>(), resolveVodPlaybackSource: vi.fn(),
}));
vi.mock('./media-process', () => ({ runMediaProcess: vi.fn() }));

describe('trim playlist resolution', () => {
    const url = 'https://www.twitch.tv/videos/2222222';
    const media = 'https://vod.ttvnw.net/archive/chunked/index.m3u8';
    beforeEach(() => vi.resetAllMocks());
    const request = () => ({ url, quality: 'source', signal: new AbortController().signal,
        streamlink: vi.fn().mockResolvedValue({ command: '/private/python', prefixArgs: ['-m', 'streamlink'] }) });

    it('uses the player playlist for ordinary source-quality trims', async () => {
        vi.mocked(resolveVodPlaybackSource).mockResolvedValue(media);
        const options = request();
        await expect(resolveVodTrimSource(options)).resolves.toBe(media);
        expect(resolveVodPlaybackSource).toHaveBeenCalledWith(url, 'source', options.signal);
        expect(options.streamlink).not.toHaveBeenCalled();
    });

    it('asks Streamlink for a playlist, preserving quality, cancellation and process tracking', async () => {
        vi.mocked(resolveVodPlaybackSource).mockResolvedValue(null);
        vi.mocked(runMediaProcess).mockResolvedValue(media + '\n');
        const options = { ...request(), quality: '720p60', onProcess: vi.fn() };
        await expect(resolveVodTrimSource(options)).resolves.toBe(media);
        expect(runMediaProcess).toHaveBeenCalledWith('/private/python', [
            '-m', 'streamlink', '--twitch-supported-codecs', 'h264,h265,av1',
            '--loglevel', 'none', '--stream-url', url, '720p60',
        ], { signal: options.signal, timeoutMs: 60000, onProcess: options.onProcess });
    });

    it.each(['file:///etc/passwd', 'http://127.0.0.1/index.m3u8', 'https://untrusted.example/video.m3u8'])(
        'rejects an untrusted fallback playlist: %s', async source => {
            vi.mocked(resolveVodPlaybackSource).mockResolvedValue(null);
            vi.mocked(runMediaProcess).mockResolvedValue(source);
            await expect(resolveVodTrimSource(request())).rejects.toThrow('Invalid VOD media host');
        },
    );

    it('does not start discovery for a cancelled request', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(resolveVodTrimSource({ ...request(), signal: controller.signal })).rejects.toThrow();
        expect(resolveVodPlaybackSource).not.toHaveBeenCalled();
    });

    it('does not start the fallback if direct discovery was cancelled', async () => {
        const controller = new AbortController(), options = { ...request(), signal: controller.signal };
        vi.mocked(resolveVodPlaybackSource).mockImplementation(async () => { controller.abort(); return null; });
        await expect(resolveVodTrimSource(options)).rejects.toThrow();
        expect(options.streamlink).not.toHaveBeenCalled();
    });

    it('propagates discovery failure instead of downloading a segment-rounded range', async () => {
        vi.mocked(resolveVodPlaybackSource).mockResolvedValue(null);
        vi.mocked(runMediaProcess).mockRejectedValue(new Error('source unavailable'));
        await expect(resolveVodTrimSource(request())).rejects.toThrow('source unavailable');
    });
});

describe('source output modes', () => {
    it('keeps whole downloads lossless and explicitly bounded downloads precise', async () => {
        const { buildVodSourceDownloadArgs } = await import('./vod-source-download');
        expect(buildVodSourceDownloadArgs('source', null, null, 120)).toContain('copy');
        const args = buildVodSourceDownloadArgs('source', '00:00:00', '00:00:02', 120, 'output.mp4');
        expect(args).toContain('libx264');
        expect(args).not.toContain('mpegts');
        expect(args[args.indexOf('-t') + 1]).toBe('00:00:02');
        expect(() => buildVodSourceDownloadArgs('source', '00:00:01', '00:00:02')).toThrow('seekable');
    });
});
