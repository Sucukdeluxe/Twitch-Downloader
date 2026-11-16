import { z } from 'zod';
import type { VodTimeline } from '../domain/vod-timeline';
import type { McpHost } from './host';
import { PartPlanError, formatTimecode, type TimeRange } from './part-plan';

export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { [key: string]: unknown; content: ContentBlock[]; structuredContent?: Record<string, unknown>; isError?: boolean }

export class ToolError extends Error {}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
export const timeValue = z.union([z.number().min(0), z.string().min(1).max(24)]).describe('Seconds from the start, or a string such as 01:23:45 or 1h23m45s.');
export const vodId = z.string().min(1).max(64).describe('Twitch VOD ID such as 2929727033, or the VOD URL.');
export const channelName = z.string().regex(/^[A-Za-z0-9_]{1,25}$/).describe('Twitch channel login name, for example papaplatte.');
export const quality = z.string().regex(/^(?:source|[1-9][0-9]{2,3}p[0-9]{0,3})$/).optional().describe('Video quality such as source, 1080p60 or 720p60. Default: source.');
export const rangeSchema = z.object({ start: timeValue, end: timeValue });
export const filePath = z.string().min(3).max(1024).describe('Absolute path of a video file inside the download folder, as returned by list_recordings or get_queue.');

export function ok(data: Record<string, unknown>, extra: ContentBlock[] = []): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data) }, ...extra], structuredContent: data };
}

export function run<Args>(handler: (args: Args, signal: AbortSignal) => Promise<ToolResult>) {
    return async (args: Args, context: { mcpReq: { signal: AbortSignal } }): Promise<ToolResult> => {
        try {
            return await handler(args, context.mcpReq.signal);
        } catch (error) {
            if (error instanceof ToolError || error instanceof PartPlanError) return { content: [{ type: 'text', text: error.message }], isError: true };
            throw error;
        }
    };
}

export function normalizeVodId(value: string): string {
    const text = value.trim().replace(/\/$/, '');
    const id = ['https://www.twitch.tv/videos/', 'https://twitch.tv/videos/'].reduce((rest, prefix) => rest.startsWith(prefix) ? rest.slice(prefix.length) : rest, text);
    if (!/^[0-9]{1,20}$/.test(id)) throw new ToolError('vod_id must be a numeric Twitch VOD ID or a https://www.twitch.tv/videos/<id> address.');
    return id;
}

export function pad(value: number): string {
    return String(value).padStart(2, '0');
}

export function localDateTime(date: Date): string {
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function rangeView(range: TimeRange): Record<string, unknown> {
    return { start: range.start, end: range.end, start_tc: formatTimecode(range.start), end_tc: formatTimecode(range.end), duration_seconds: Math.round((range.end - range.start) * 1000) / 1000 };
}

export async function requireTimeline(host: McpHost, id: string, refresh = false): Promise<VodTimeline> {
    const timeline = await host.timeline(normalizeVodId(id), refresh);
    if (!timeline) throw new ToolError('The VOD was not found on Twitch or its metadata is currently unavailable. Check the ID with list_vods.');
    return timeline;
}
