import * as path from 'node:path';

/** Keep the Windows store unchanged; macOS uses the current user's Application Support. */
export function resolveApplicationDataDirectory(
    platform: NodeJS.Platform,
    userData: string,
    environment: NodeJS.ProcessEnv = process.env,
): string {
    if (environment.TWITCH_VOD_MANAGER_DATA_DIR) {
        if (!path.isAbsolute(environment.TWITCH_VOD_MANAGER_DATA_DIR)) {
            throw new Error('TWITCH_VOD_MANAGER_DATA_DIR must be absolute');
        }
        return environment.TWITCH_VOD_MANAGER_DATA_DIR;
    }
    return platform === 'win32'
        ? path.win32.join(environment.PROGRAMDATA || 'C:\\ProgramData', 'Twitch_VOD_Manager')
        : userData;
}
