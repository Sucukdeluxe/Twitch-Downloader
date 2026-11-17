import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpHost } from './host';
import { READ_ONLY, ToolError, filePath, ok, run } from './tool-kit';

export const downloadSettingsSchema = z.object({
    download_mode: z.enum(['full', 'parts']).optional(),
    part_minutes: z.number().int().min(10).max(480).optional(),
    parallel_downloads: z.number().int().min(1).max(2).optional(),
}).strict();

export function registerFileTools(server: McpServer, host: McpHost): void {
    server.registerTool('create_recording_folder', {
        title: 'Create a recording folder',
        description: 'Creates a folder inside the configured download folders. Existing folders are kept. Supports dry_run without changing files.',
        inputSchema: z.object({ path: filePath, dry_run: z.boolean().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, run(async args => ok(host.createRecordingFolder(args.path, args.dry_run === true))));

    server.registerTool('organize_recordings', {
        title: 'Move and rename completed recordings',
        description: 'Moves or renames up to 100 completed video files inside the configured download folders on the same drive, including matching chat and event sidecars. Supply absolute source and destination filenames with the same video extension. All paths are checked before moving; existing files are never overwritten. Refuses while downloads or file jobs are waiting/running. Use dry_run to preview. Reports copied if a source could not be removed.',
        inputSchema: z.object({ files: z.array(z.object({ source: filePath, destination: filePath }).strict()).min(1).max(100), dry_run: z.boolean().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, run(async args => ok({ ...await host.organizeRecordings(args.files, args.dry_run === true) })));

    server.registerTool('get_download_settings', {
        title: 'Read download settings',
        description: 'Reads the default quality, full-VOD mode, fixed part length and parallel download limit. No credentials or connection settings are returned.',
        inputSchema: z.object({}), annotations: { ...READ_ONLY, openWorldHint: false },
    }, run(async () => ok({ settings: host.downloadSettings() })));

    server.registerTool('set_download_settings', {
        title: 'Change download settings',
        description: 'Updates only full-VOD mode, fixed part length and parallel downloads for future jobs. Original source quality remains the app default; individual download requests can choose a quality. Does not change running jobs, credentials, network access or the configured root folders. Use dry_run to see before/after without saving.',
        inputSchema: z.object({ settings: downloadSettingsSchema, dry_run: z.boolean().optional() }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, run(async args => {
        if (!Object.keys(args.settings).length) throw new ToolError('Supply at least one download setting.');
        const before = host.downloadSettings();
        const after = args.dry_run ? { ...before, ...args.settings } : host.updateDownloadSettings(args.settings);
        return ok({ before, after, dry_run: args.dry_run === true });
    }));
}
