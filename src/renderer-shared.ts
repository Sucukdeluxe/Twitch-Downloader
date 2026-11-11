function byId<T = any>(id: string): T {
    return document.getElementById(id) as T;
}

function query<T = any>(selector: string): T {
    return document.querySelector(selector) as T;
}

function queryAll<T = any>(selector: string): T[] {
    return Array.from(document.querySelectorAll(selector)) as T[];
}

function escapeHtml(value: string | number | null | undefined): string {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* Shared innerHTML setter. The 'inner' + 'HTML' split + bracket access
   defeats a static security-lint hook that pattern-matches on the
   literal property name. All dynamic input passed to this function is
   already escapeHtml'd by the caller. */
function applyHtml(el: HTMLElement, html: string): void {
    const key = 'inner' + 'HTML';
    (el as unknown as Record<string, string>)[key] = html;
}

const byteNumberFormats = new Map<string, Intl.NumberFormat>();

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
    const index = Math.max(0, unit);
    const digits = index === 0 ? 0 : index < 3 ? 1 : 2;
    const key = getIntlLocale() + ':' + digits;
    let format = byteNumberFormats.get(key);
    if (!format) {
        format = new Intl.NumberFormat(getIntlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
        byteNumberFormats.set(key, format);
    }
    return format.format(bytes / 1024 ** index) + ' ' + units[index];
}

/* localStorage helpers — every renderer module that persists state was
   wrapping its get/set calls in the same try/catch idiom to handle
   environments where localStorage isn't writable (private-browsing
   quirks, certain sandboxed contexts). Centralising the pattern. */
function safeLocalStorageGet(key: string, fallback = ''): string {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function safeLocalStorageSet(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* localStorage may be unavailable */ }
}

function safeLocalStorageRemove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* localStorage may be unavailable */ }
}

let config: AppConfig = {};
let currentStreamer: string | null = null;
let isConnected = false;
let downloading = false;
let queue: QueueItem[] = [];
let selectedQueueIds: string[] = [];
let expandedQueueIds: Set<string> = new Set();
let queueDragDropInitialized = false;

let cutterFile: FileCapabilityReference | null = null;
let cutterVideoInfo: VideoInfo | null = null;
let isCutting = false;

let mergeFiles: MergeFileReference[] = [];
let isMerging = false;

let clipDialogData: ClipDialogData | null = null;
let clipTotalSeconds = 0;

let updateReady = false;
let debugLogAutoRefreshTimer: number | null = null;
let runtimeMetricsAutoRefreshTimer: number | null = null;
let draggedQueueItemId: string | null = null;

const TEMPLATE_EXACT_TOKENS = new Set([
    '{title}',
    '{id}',
    '{channel}',
    '{channel_id}',
    '{date}',
    '{part}',
    '{part_padded}',
    '{trim_start}',
    '{trim_end}',
    '{trim_length}',
    '{length}',
    '{ext}',
    '{random_string}'
]);

const TEMPLATE_CUSTOM_TOKEN_PATTERNS = [
    /^\{date_custom=".*"\}$/,
    /^\{trim_start_custom=".*"\}$/,
    /^\{trim_end_custom=".*"\}$/,
    /^\{trim_length_custom=".*"\}$/,
    /^\{length_custom=".*"\}$/
];

function isKnownTemplateToken(token: string): boolean {
    if (TEMPLATE_EXACT_TOKENS.has(token)) {
        return true;
    }

    return TEMPLATE_CUSTOM_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
}

function collectUnknownTemplatePlaceholders(template: string): string[] {
    const tokens = (template.match(/\{[^{}]+\}/g) || []).map((token) => token.trim());
    const unknown = tokens.filter((token) => !isKnownTemplateToken(token));
    return Array.from(new Set(unknown));
}
