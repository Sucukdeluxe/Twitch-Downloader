import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpHost } from './host';
import { formatTimecode } from './part-plan';
import { READ_ONLY, ToolError, channelName, formatBytes, localDateTime, normalizeVodId, ok, rangeView, run, vodId } from './tool-kit';

export const SPLIT_PROMPT_NAME = 'split_stream_into_parts';

export function splitPromptText(channel: string, day: string): string {
    return [
        `Bereite den Stream von ${channel} vom Tag "${day}" mit dem Twitch Downloader in Parts nach Themen auf.`,
        'Vorgehen:',
        '1. Mit list_vods das VOD des Tages finden. Mit get_vod_parts_state prüfen, ob es schon vorbereitet wurde.',
        '2. Mit get_vod_timeline Kategorien, Titelwechsel und Zuschauerzahlen holen, dazu get_vod_clips und get_vod_chat_activity.',
        '3. Das VOD selbst ansehen: zuerst scan_vod_frames über die ganze Länge, danach an jedem Übergang mit kleinem Abstand nachschauen, bis der Wechsel auf wenige Sekunden genau feststeht. Die Themen bestimmst du aus dem, was du siehst, nicht nur aus den Kategorien.',
        '4. Parts nach Thema bilden. Gleiche Themen zu verschiedenen Zeiten kommen in denselben Part. Jede Sekunde des VODs gehört in genau einen Part, auch Anfang und Verabschiedung.',
        '5. Den Plan mit queue_vod_parts und dry_run=true prüfen, mir die Parts mit Zeiten und Dateinamen zeigen und nach meiner Bestätigung ohne dry_run starten.',
        '6. Mit wait_for_queue verfolgen und am Ende die fertigen Dateien nennen.',
    ].join('\n');
}

export function registerWorkflowTools(server: McpServer, host: McpHost): void {
    server.registerPrompt(SPLIT_PROMPT_NAME, {
        title: 'Stream in Themen-Parts aufteilen',
        description: 'Arbeitsauftrag: das VOD eines Tages ansehen, nach Themen aufteilen und als Parts laden.',
        argsSchema: z.object({
            channel: z.string().min(1).max(25).describe('Twitch-Kanal'),
            day: z.string().max(10).optional().describe('today, yesterday oder ein Datum wie 2026-11-15. Standard: yesterday'),
        }),
    }, ({ channel, day }) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: splitPromptText(channel, day || 'yesterday') } }],
    }));

    server.registerTool('get_vod_parts_state', {
        title: 'What has already been prepared for a VOD',
        description: 'Shows the parts that were queued for a VOD through queue_vod_parts in earlier calls or sessions: names, ranges, output files and whether each part is waiting, downloading, finished, failed or no longer present. Call it before planning a VOD to avoid doing work twice.',
        inputSchema: z.object({ vod_id: vodId }),
        annotations: { ...READ_ONLY, openWorldHint: false },
    }, run(async (args) => {
        const id = normalizeVodId(args.vod_id);
        const plans = await host.partPlans(id);
        if (!plans.length) return ok({ vod_id: id, prepared: false, parts: [] });
        const [latest] = plans;
        const queue = host.queue();
        const parts = [];
        for (const part of latest.parts) {
            const item = part.queueItemId ? queue.find(entry => entry.id === part.queueItemId) : undefined;
            const finishedFile = item?.status === 'completed' ? item.outputFiles?.[0] ?? part.outputFile : part.outputFile;
            const size = !item || item.status === 'completed' ? await host.fileSize(finishedFile) : null;
            const progress = Number(item?.progress);
            parts.push({
                number: part.number, name: part.name, duration_seconds: part.duration, duration: formatTimecode(part.duration), ranges: part.ranges.map(rangeView),
                output_file: finishedFile,
                state: item?.status === 'pending' ? 'waiting' : item?.status === 'downloading' ? 'downloading' : item?.status === 'paused' ? 'paused'
                    : item?.status === 'error' ? 'failed' : size !== null ? 'finished' : 'not present',
                ...(item && item.status !== 'completed' ? { queue_item_id: item.id, progress_percent: Number.isFinite(progress) && progress >= 0 ? Math.round(progress * 10) / 10 : null } : {}),
                ...(item?.last_error ? { error: item.last_error } : {}),
                ...(size !== null ? { file_size_bytes: size, file_size: formatBytes(size) } : {}),
            });
        }
        return ok({
            vod_id: id, prepared: true, channel: latest.channel, title: latest.title, duration_seconds: latest.durationSeconds,
            planned_at: latest.savedAt, planned_local: localDateTime(new Date(latest.savedAt)), earlier_plans: plans.length - 1,
            all_parts_finished: parts.every(part => part.state === 'finished'), parts,
        });
    }));

    server.registerTool('set_channel_automation', {
        title: 'Automatic downloads and recordings of a channel',
        description: 'Switches the automatic VOD download and the automatic live recording of a channel on or off, or only reads the current setting when no change is given. Switch the automatic VOD download off for a channel whose streams are prepared as topic parts; otherwise the app also downloads the same VODs in fixed parts.',
        inputSchema: z.object({
            channel: channelName,
            auto_download_vods: z.boolean().optional().describe('Download every new VOD of the channel automatically.'),
            auto_record_live: z.boolean().optional().describe('Record the channel automatically when it goes live.'),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, run(async (args) => {
        const channel = args.channel.toLowerCase();
        const changed = args.auto_download_vods !== undefined || args.auto_record_live !== undefined;
        if ((args.auto_download_vods === true || args.auto_record_live === true) && !host.streamers().some(streamer => streamer.login === channel)) {
            throw new ToolError(`${channel} is not saved in the app. Automation can only be switched on for saved channels; add the channel in the app first.`);
        }
        const state = changed
            ? host.setChannelAutomation(channel, { ...(args.auto_download_vods === undefined ? {} : { autoDownloadVods: args.auto_download_vods }), ...(args.auto_record_live === undefined ? {} : { autoRecord: args.auto_record_live }) })
            : host.channelAutomation(channel);
        return ok({ channel, changed, auto_download_vods: state.autoDownloadVods, auto_record_live: state.autoRecord });
    }));

    server.registerTool('start_live_recording', {
        title: 'Record a live stream now',
        description: 'Starts recording the running live stream of a channel. The recording appears in the download queue and ends when the stream ends.',
        inputSchema: z.object({ channel: channelName }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, run(async (args) => {
        const result = await host.startLiveRecording(args.channel.toLowerCase());
        if (!result.started) {
            throw new ToolError(result.reason === 'offline' ? `${args.channel} is not live at the moment.`
                : result.reason === 'already-recording' ? `${args.channel} is already being recorded.`
                    : result.reason === 'unavailable' ? 'The live state could not be checked. Try again.' : 'The recording could not be started.');
        }
        return ok({ channel: args.channel.toLowerCase(), recording: true, title: result.title, ...host.queueState() });
    }));
}
