import { describe, expect, it } from 'vitest';
import { resolveApplicationDataDirectory } from './platform-paths';

describe('application data isolation', () => {
    it('uses the per-user macOS store without a Windows directory', () => {
        expect(resolveApplicationDataDirectory('darwin', '/Users/test/Library/Application Support/Twitch VOD Manager', {}))
            .toBe('/Users/test/Library/Application Support/Twitch VOD Manager');
    });
    it('retains the existing Windows store', () => {
        expect(resolveApplicationDataDirectory('win32', 'unused', {})).toBe('C:\\ProgramData\\Twitch_Downloader');
        expect(resolveApplicationDataDirectory('win32', 'unused', { PROGRAMDATA: 'D:\\Data' })).toBe('D:\\Data\\Twitch_Downloader');
    });
    it('isolates development and tests explicitly', () => {
        expect(resolveApplicationDataDirectory('darwin', 'unused', { TWITCH_VOD_MANAGER_DATA_DIR: '/tmp/test-data' })).toBe('/tmp/test-data');
        expect(() => resolveApplicationDataDirectory('darwin', 'unused', { TWITCH_VOD_MANAGER_DATA_DIR: 'relative' })).toThrow('absolute');
    });
});
