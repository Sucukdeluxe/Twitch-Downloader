import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpHost } from './host';
import { startMcpHttpServer, type McpHttpActivity, type McpHttpServer } from './http-server';
import { createMcpServer } from './tools';

export { MediaJobDeferred, MediaJobQueue, type MediaJob, type MediaJobRequest } from './media-jobs';
export { composeLossless, formatDifferences, probeComposeSource } from './lossless-compose';
export { decodeToRgb, encodeJpeg, grabFrames, grabRawFrames, qualitiesForWidth } from './frame-grab';
export { loadChatActivity, loadChatRange, loadVodClips, type GqlRequest } from './vod-signals';
export { PartPlanStore } from './part-plan-store';
export { parseMediaJobs } from './media-jobs';
export { loadStoryboard } from './vod-storyboard';
export { generateAccessToken, isValidAccessToken, normalizeMcpPort, normalizeMcpPublicUrl, MCP_DEFAULT_PORT, MCP_ENDPOINT_PATH, MCP_MAX_PORT, MCP_MIN_PORT } from './access';
export type { McpChannelAutomation, McpLiveRecordingResult, McpHost, McpAppStatus, McpQueueDraft, McpQueueAddResult, McpRecordingEvent, McpStreamer, McpVideoInfo, McpVod } from './host';

export interface McpServiceSettings { enabled: boolean; port: number; network: boolean }
export interface McpServiceStatus {
    running: boolean;
    bindAddress: string | null;
    port: number | null;
    error: 'port-in-use' | 'no-access' | 'failed' | null;
    requests: number;
    lastActivity: McpHttpActivity | null;
    recentCalls: McpHttpActivity[];
}
export interface McpServiceOptions {
    host: McpHost;
    version: string;
    token(): string | null;
    log(event: string, details?: unknown): void;
    onStatusChange?(): void;
}

export class McpService {
    private server: McpHttpServer | null = null;
    private current: McpServiceSettings | null = null;
    private error: McpServiceStatus['error'] = null;
    private requests = 0;
    private lastActivity: McpHttpActivity | null = null;
    private recentCalls: McpHttpActivity[] = [];
    private pending: Promise<void> = Promise.resolve();
    private readonly handler;

    constructor(private readonly options: McpServiceOptions) {
        this.handler = createMcpHandler(() => createMcpServer(options.host, options.version), {
            onerror: error => options.log('mcp-handler-error', String(error)),
            maxRequestBodySize: 1024 * 1024,
        });
    }

    status(): McpServiceStatus {
        return {
            running: this.server !== null,
            bindAddress: this.server?.host ?? null,
            port: this.server?.port ?? null,
            error: this.error,
            requests: this.requests,
            lastActivity: this.lastActivity,
            recentCalls: [...this.recentCalls],
        };
    }

    apply(settings: McpServiceSettings): Promise<void> {
        this.pending = this.pending.then(() => this.reconcile(settings)).catch(error => this.options.log('mcp-apply-failed', String(error)));
        return this.pending;
    }

    async stop(): Promise<void> {
        await this.apply({ enabled: false, port: this.current?.port ?? 0, network: false });
        await this.handler.close().catch(() => undefined);
    }

    private async reconcile(settings: McpServiceSettings): Promise<void> {
        const unchanged = this.current && this.server && settings.enabled
            && this.current.port === settings.port && this.current.network === settings.network;
        if (unchanged) return;
        if (this.server) {
            const server = this.server;
            this.server = null;
            await server.close();
            this.options.log('mcp-server-stopped');
        }
        this.current = settings;
        this.error = null;
        if (settings.enabled) {
            const bindAddress = settings.network ? '0.0.0.0' : '127.0.0.1';
            try {
                this.server = await startMcpHttpServer({
                    host: bindAddress,
                    port: settings.port,
                    token: this.options.token,
                    handler: this.handler,
                    log: this.options.log,
                    onActivity: activity => {
                        this.requests += 1;
                        this.lastActivity = activity;
                        if (activity.tool) {
                            this.recentCalls = [...this.recentCalls, activity].slice(-30);
                            this.options.log('mcp-tool-call', { tool: activity.tool, client: activity.client });
                            this.options.onStatusChange?.();
                        }
                    },
                });
                this.options.log('mcp-server-started', { bindAddress, port: this.server.port });
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                this.error = code === 'EADDRINUSE' ? 'port-in-use' : code === 'EACCES' ? 'no-access' : 'failed';
                this.options.log('mcp-server-start-failed', { bindAddress, port: settings.port, error: String(error) });
            }
        }
        this.options.onStatusChange?.();
    }
}
