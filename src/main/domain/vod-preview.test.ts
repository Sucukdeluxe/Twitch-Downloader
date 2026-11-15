import { describe, expect, test } from 'vitest';
import { buildVodPreviewFrameUrls } from './vod-preview';

describe('buildVodPreviewFrameUrls', () => {
    test('builds four full-HD frame URLs from a Twitch thumb0 URL', () => {
        const input = 'https://static-cdn.jtvnw.net/cf_vods/example/thumb/thumb0-1920x1080.jpg';

        expect(buildVodPreviewFrameUrls(input)).toEqual([
            'https://static-cdn.jtvnw.net/cf_vods/example/thumb/thumb0-1920x1080.jpg',
            'https://static-cdn.jtvnw.net/cf_vods/example/thumb/thumb1-1920x1080.jpg',
            'https://static-cdn.jtvnw.net/cf_vods/example/thumb/thumb2-1920x1080.jpg',
            'https://static-cdn.jtvnw.net/cf_vods/example/thumb/thumb3-1920x1080.jpg'
        ]);
    });

    test('rejects URLs that are not Twitch full-HD VOD thumbnails', () => {
        expect(buildVodPreviewFrameUrls('https://example.invalid/thumb0-320x180.jpg')).toEqual([]);
    });
});
