import { normalizeAutoVodRules } from './auto-vod-rules';
import {
    normalizeDownloadPolicy,
} from './download-policy';
import {
    isPlainObject,
    normalizeLogin,
    normalizeStreamlinkQuality,
} from './config-normalize';
import { isSecretBearingKey } from './config-export';

const TEMPLATE_KEYS = new Set(['filename_template_vod', 'filename_template_parts', 'filename_template_clip']);
const MAX_STREAMER_ENTRIES = 4096;
const MAX_TEMPLATE_LENGTH = 4096;
const MAX_WINDOWS_PATH_LENGTH = 32767;

const BOOLEAN_KEYS = new Set([
    'sidebar_split_view',
    'smart_queue_scheduler',
    'prevent_duplicate_downloads',
    'persist_queue_on_restart',
    'auto_resume_queue_on_startup',
    'notify_on_each_completion',
    'streamlink_disable_ads',
    'download_chat_replay',
    'capture_live_chat',
    'discord_notify_live_start',
    'discord_notify_live_end',
    'discord_notify_vod_complete',
    'discord_notify_vod_auto_queued',
    'auto_cleanup_enabled',
    'log_stream_events',
    'auto_resume_live_recording',
    'auto_merge_resumed_parts',
    'delete_parts_after_merge',
]);

const INTEGER_RANGES: Record<string, readonly [number, number]> = {
    part_minutes: [10, 480],
    metadata_cache_minutes: [1, 120],
    parallel_downloads: [1, 2],
    auto_record_poll_seconds: [30, 1800],
    auto_cleanup_days: [1, 3650],
    auto_vod_download_poll_minutes: [5, 360],
    auto_vod_max_age_hours: [1, 720],
};

export function normalizeStreamerLogins(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const streamers: string[] = [];
    const seen = new Set<string>();
    for (const entry of value.slice(0, MAX_STREAMER_ENTRIES)) {
        if (typeof entry !== 'string') continue;
        const login = normalizeLogin(entry);
        if (!/^[a-z0-9_]{1,25}$/.test(login) || seen.has(login)) continue;
        seen.add(login);
        streamers.push(login);
    }
    return streamers;
}

function normalizedStringArray(value: unknown, limit: number, isValid: (value: string) => boolean): string[] | null {
    if (!Array.isArray(value)) return null;
    const values: string[] = [];
    const seen = new Set<string>();
    for (let index = value.length - 1; index >= 0 && values.length < limit; index -= 1) {
        const entry = value[index];
        if (typeof entry !== 'string') continue;
        const normalized = entry.trim();
        if (!isValid(normalized) || seen.has(normalized)) continue;
        seen.add(normalized);
        values.push(normalized);
    }
    return values.reverse();
}

function normalizedDisplayNames(value: unknown): Record<string, string> | null {
    if (!isPlainObject(value)) return null;
    const names: Record<string, string> = {};
    for (const [rawLogin, rawDisplayName] of Object.entries(value).slice(0, MAX_STREAMER_ENTRIES)) {
        const login = normalizeLogin(rawLogin);
        const displayName = typeof rawDisplayName === 'string' ? rawDisplayName.trim() : '';
        if (/^[a-z0-9_]{1,25}$/.test(login) && displayName && displayName.length <= 100) names[login] = displayName;
    }
    return names;
}

function normalizedEnum(value: unknown, allowed: readonly string[]): string | null {
    return typeof value === 'string' && allowed.includes(value) ? value : null;
}

function normalizedDownloadPolicy(value: unknown): ReturnType<typeof normalizeDownloadPolicy> | null {
    if (!isPlainObject(value)
        || !Object.prototype.hasOwnProperty.call(value, 'throttle')
        || !Object.prototype.hasOwnProperty.call(value, 'windows')
        || !Array.isArray(value.windows)
        || value.windows.length > 32) return null;
    if (value.throttle !== null) {
        if (!isPlainObject(value.throttle)
            || typeof value.throttle.maxBytesPerSecond !== 'number'
            || !Number.isSafeInteger(value.throttle.maxBytesPerSecond)
            || value.throttle.maxBytesPerSecond <= 0) return null;
    }
    for (const window of value.windows) {
        if (!isPlainObject(window)
            || typeof window.start !== 'string'
            || typeof window.end !== 'string'
            || !/^\d{2}:\d{2}$/.test(window.start)
            || !/^\d{2}:\d{2}$/.test(window.end)) return null;
        const normalized = normalizeDownloadPolicy({ throttle: null, windows: [window] });
        if (normalized.windows.length !== 1) return null;
    }
    return normalizeDownloadPolicy(value);
}

export function sanitizeConfigInput(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) return {};
    const sanitized: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
        if (isSecretBearingKey(key)) continue;

        if (key === 'client_id') {
            if (typeof entry === 'string') {
                const clientId = entry.trim();
                if (clientId === '' || /^[A-Za-z0-9_-]{1,128}$/.test(clientId)) sanitized[key] = clientId;
            }
            continue;
        }

        if (key === 'clip_download_path' && entry === '') { sanitized[key] = ''; continue; }
        if (key === 'download_path' || key === 'clip_download_path') {
            if (typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_WINDOWS_PATH_LENGTH && !entry.includes('\0')) sanitized[key] = entry;
            continue;
        }

        if (TEMPLATE_KEYS.has(key)) {
            if (typeof entry === 'string' && entry.trim().length > 0 && entry.length <= MAX_TEMPLATE_LENGTH) sanitized[key] = entry;
            continue;
        }

        if (BOOLEAN_KEYS.has(key)) {
            if (typeof entry === 'boolean') sanitized[key] = entry;
            continue;
        }

        const range = INTEGER_RANGES[key];
        if (range) {
            if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= range[0] && entry <= range[1]) sanitized[key] = entry;
            continue;
        }

        if (key === 'auto_vod_rules') { sanitized[key] = normalizeAutoVodRules(entry); continue; }
        if (key === 'streamers' || key === 'auto_record_streamers' || key === 'auto_vod_download_streamers') {
            const streamers = normalizeStreamerLogins(entry);
            if (streamers) sanitized[key] = streamers;
            continue;
        }

        if (key === 'downloaded_vod_ids') {
            const ids = normalizedStringArray(entry, 4096, (id) => /^[A-Za-z0-9_-]{1,128}$/.test(id));
            if (ids) sanitized[key] = ids;
            continue;
        }

        if (key === 'streamer_display_names') {
            const displayNames = normalizedDisplayNames(entry);
            if (displayNames) sanitized[key] = displayNames;
            continue;
        }

        if (key === 'download_policy') {
            const policy = normalizedDownloadPolicy(entry);
            if (policy) sanitized[key] = policy;
            continue;
        }

        if (key === 'theme') {
            const theme = normalizedEnum(entry, ['twitch', 'discord', 'youtube', 'apple', 'light', 'system']);
            if (theme) sanitized[key] = theme;
            continue;
        }

        if (key === 'download_mode') {
            const mode = normalizedEnum(entry, ['parts', 'full']);
            if (mode) sanitized[key] = mode;
            continue;
        }

        if (key === 'language') {
            const language = normalizedEnum(entry, ['de', 'en']);
            if (language) sanitized[key] = language;
            continue;
        }

        if (key === 'performance_mode') {
            const performanceMode = normalizedEnum(entry, ['stability', 'balanced', 'speed']);
            if (performanceMode) sanitized[key] = performanceMode;
            continue;
        }

        if (key === 'streamlink_quality') {
            sanitized[key] = normalizeStreamlinkQuality(entry);
            continue;
        }

        if (key === 'auto_cleanup_target') {
            const target = normalizedEnum(entry, ['live_only', 'all']);
            if (target) sanitized[key] = target;
            continue;
        }

        if (key === 'auto_cleanup_action') {
            const action = normalizedEnum(entry, ['delete', 'archive']);
            if (action) sanitized[key] = action;
        }
    }

    return sanitized;
}

export function sanitizeImportedConfig(value: unknown): Record<string, unknown> {
    const sanitized = sanitizeConfigInput(value);
    delete sanitized.download_path;
    delete sanitized.clip_download_path;
    return sanitized;
}
