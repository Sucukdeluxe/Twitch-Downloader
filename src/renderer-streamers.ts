let selectStreamerRequestId = 0;
let vodRenderTaskId = 0;
let streamerIndicatorFrame: number | null = null;
const VOD_RENDER_CHUNK_SIZE = 64;

function scheduleStreamerActiveIndicatorSync(): void {
    if (streamerIndicatorFrame !== null) return;
    streamerIndicatorFrame = requestAnimationFrame(() => {
        streamerIndicatorFrame = null;
        const list = document.getElementById('streamerList');
        const activeItem = list?.querySelector<HTMLElement>('.streamer-item.active');
        if (!list || !activeItem) {
            list?.classList.remove('streamer-indicator-visible');
            return;
        }
        list.style.setProperty('--streamer-active-x', `${activeItem.offsetLeft}px`);
        list.style.setProperty('--streamer-active-y', `${activeItem.offsetTop}px`);
        list.style.setProperty('--streamer-active-width', `${activeItem.offsetWidth}px`);
        list.style.setProperty('--streamer-active-height', `${activeItem.offsetHeight}px`);
        list.classList.add('streamer-indicator-visible');
        requestAnimationFrame(() => list.classList.add('streamer-indicator-ready'));
    });
}

// Live status snapshot — updated by the main process via the
// 'live-status-batch-update' IPC event. Keys are lowercase logins so
// the lookup is case-insensitive regardless of how the streamer's
// name was added (display-cased vs login-cased).
const liveStatusByLogin = new Map<string, boolean>();
const liveVodIdByLogin = new Map<string, string>();
const lastLiveVodCovers = new Map<string, string>();
const finishedVodCoverRefreshes = new Map<string, number>();
const streamerDisplayNames = new Map<string, string>();

function getStreamerDisplayName(login: string): string {
    return streamerDisplayNames.get(login.trim().toLowerCase()) || login;
}

(window as unknown as { getStreamerDisplayName: typeof getStreamerDisplayName }).getStreamerDisplayName = getStreamerDisplayName;

function rememberStreamerDisplayName(login: string, displayName: string): void {
    const normalizedLogin = login.trim().toLowerCase();
    const normalizedDisplayName = displayName.trim();
    if (!normalizedLogin || !normalizedDisplayName) return;
    const changed = streamerDisplayNames.get(normalizedLogin) !== normalizedDisplayName;
    if (changed) streamerDisplayNames.set(normalizedLogin, normalizedDisplayName);
    if (currentStreamer?.toLowerCase() === normalizedLogin) {
        const setTitle = (window as unknown as { setPageTitle?: (text: string) => void }).setPageTitle;
        if (typeof setTitle === 'function') setTitle(normalizedDisplayName);
    }
    if (changed) {
        renderStreamers();
        renderQueue();
    }
}

(window as unknown as { rememberStreamerDisplayName: typeof rememberStreamerDisplayName }).rememberStreamerDisplayName = rememberStreamerDisplayName;

function renderHydratedStreamerDisplayNames(): void {
    if (currentStreamer) {
        const setTitle = (window as unknown as { setPageTitle?: (text: string) => void }).setPageTitle;
        if (typeof setTitle === 'function') setTitle(getStreamerDisplayName(currentStreamer));
    }
    renderStreamers();
    renderQueue();
}

async function hydrateStreamerDisplayNames(): Promise<void> {
    const configuredNames = config.streamer_display_names || {};
    let changed = false;
    for (const [login, displayName] of Object.entries(configuredNames)) {
        const normalizedLogin = login.trim().toLowerCase();
        const normalizedDisplayName = displayName.trim();
        if (normalizedLogin && normalizedDisplayName && streamerDisplayNames.get(normalizedLogin) !== normalizedDisplayName) {
            streamerDisplayNames.set(normalizedLogin, normalizedDisplayName);
            changed = true;
        }
    }
    if (changed) {
        renderHydratedStreamerDisplayNames();
        changed = false;
    }

    const streamers = (config.streamers ?? []) as string[];
    if (streamers.length === 0) return;

    try {
        const resolvedNames = await window.api.getStreamerDisplayNames(streamers);
        for (const [login, displayName] of Object.entries(resolvedNames)) {
            const normalizedLogin = login.trim().toLowerCase();
            const normalizedDisplayName = displayName.trim();
            if (normalizedLogin && normalizedDisplayName && streamerDisplayNames.get(normalizedLogin) !== normalizedDisplayName) {
                streamerDisplayNames.set(normalizedLogin, normalizedDisplayName);
                changed = true;
            }
        }
    } catch { }

    if (changed) renderHydratedStreamerDisplayNames();
}

(window as unknown as { hydrateStreamerDisplayNames: typeof hydrateStreamerDisplayNames }).hydrateStreamerDisplayNames = hydrateStreamerDisplayNames;

function applyLiveVodStatusChanges(changes: Array<{ login: string; isLive: boolean; vodId?: string | null }>): void {
    let touched = false;
    for (const change of changes) {
        const key = change.login.toLowerCase();
        const previousVodId = liveVodIdByLogin.get(key);
        const vodId = change.isLive && typeof change.vodId === 'string' ? change.vodId : null;
        const changed = liveStatusByLogin.get(key) !== change.isLive || (liveVodIdByLogin.get(key) ?? null) !== vodId;
        if (changed) {
            touched = true;
            if (previousVodId && previousVodId !== vodId) void refreshFinishedVodCover(key, previousVodId);
        }
        liveStatusByLogin.set(key, change.isLive);
        if (vodId) liveVodIdByLogin.set(key, vodId);
        else liveVodIdByLogin.delete(key);
        if (changed) {
            const refreshProfile = (window as unknown as { syncStreamerProfileLiveStatus?: (login: string, isLive: boolean) => void }).syncStreamerProfileLiveStatus;
            refreshProfile?.(key, change.isLive);
        }
    }
    if (touched) {
        renderStreamers();
        updateVodLiveBadges();
    }
}

function getStreamerLiveVodStatus(login: string): { isLive: boolean; vodId: string | null } | undefined {
    const key = login.toLowerCase();
    const isLive = liveStatusByLogin.get(key);
    return isLive === undefined ? undefined : { isLive, vodId: liveVodIdByLogin.get(key) ?? null };
}

(window as unknown as { getStreamerLiveVodStatus: typeof getStreamerLiveVodStatus }).getStreamerLiveVodStatus = getStreamerLiveVodStatus;

async function initLiveStatusSubscription(): Promise<void> {
    const changedWhileLoading = new Set<string>();
    let loading = true;
    window.api.onLiveStatusBatchUpdate(({ changes }) => {
        if (loading) for (const change of changes) changedWhileLoading.add(change.login.toLowerCase());
        applyLiveVodStatusChanges(changes);
    });
    try {
        const initial = typeof window.api.getLiveVodStatusSnapshot === 'function'
            ? await window.api.getLiveVodStatusSnapshot()
            : Object.fromEntries(Object.entries(await window.api.getLiveStatusSnapshot()).map(([login, isLive]) => [login, { isLive, vodId: null }]));
        applyLiveVodStatusChanges(Object.entries(initial).filter(([login]) => !changedWhileLoading.has(login.toLowerCase()))
            .map(([login, status]) => ({ login, ...status })));
    } catch { }
    finally { loading = false; }
}
(window as unknown as { initLiveStatusSubscription: typeof initLiveStatusSubscription }).initLiveStatusSubscription = initLiveStatusSubscription;

// VOD filter state — persists across renderer reloads via localStorage so the
// user's search query survives an app restart. Cleared explicitly via Esc /
// the clear button. Shared across streamers (acts like a search bar).
let lastLoadedVods: VOD[] = [];
let lastLoadedStreamer: string | null = null;
interface CachedStreamerVods {
    userId: string;
    vods: VOD[];
    updatedAt: number;
}
const streamerVodCache = new Map<string, CachedStreamerVods>();
const streamerVodLoads = new Map<string, Promise<CachedStreamerVods | null>>();
let streamerBackgroundRefreshTimer: number | null = null;
const STREAMER_BACKGROUND_REFRESH_MS = 5 * 60 * 1000;
let vodFilterQuery = '';
const VOD_FILTER_STORAGE_KEY = 'twitch-vod-manager:vod-filter';

// Bulk-select state — keyed by VOD URL since URL is unique per VOD. Cleared
// on streamer switch (selection is per-streamer mental model). NOT persisted
// because a stale selection across reloads is more confusing than helpful.
const selectedVodUrls = new Set<string>();
const selectedVodUrlRevisions = new Map<string, number>();
let vodSelectionRevision = 0;
let vodBulkOperationInFlight = false;
let vodGridDelegationInitialized = false;

// Hide-downloaded toggle: when enabled, the VOD grid skips entries whose
// vod.id is in config.downloaded_vod_ids. Persisted to localStorage so a
// power user who keeps it enabled doesn't have to re-flip it every launch.
const VOD_HIDE_DOWNLOADED_STORAGE_KEY = 'twitch-vod-manager:vod-hide-downloaded';
let vodHideDownloaded = false;

function loadPersistedHideDownloaded(): boolean {
    return safeLocalStorageGet(VOD_HIDE_DOWNLOADED_STORAGE_KEY) === '1';
}

function persistHideDownloaded(value: boolean): void {
    safeLocalStorageSet(VOD_HIDE_DOWNLOADED_STORAGE_KEY, value ? '1' : '0');
}

function onVodHideDownloadedChange(): void {
    const cb = byId<HTMLInputElement>('vodHideDownloadedToggle');
    vodHideDownloaded = cb.checked;
    persistHideDownloaded(vodHideDownloaded);
    if (lastLoadedStreamer) renderVodGridFromCurrentState();
}

function syncVodHideDownloadedToggle(): void {
    const cb = document.getElementById('vodHideDownloadedToggle') as HTMLInputElement | null;
    if (cb) cb.checked = vodHideDownloaded;
}

type VodSortKey = 'date_desc' | 'date_asc' | 'views_desc' | 'duration_desc' | 'duration_asc';
const VALID_VOD_SORTS: ReadonlyArray<VodSortKey> = ['date_desc', 'date_asc', 'views_desc', 'duration_desc', 'duration_asc'];
const VOD_SORT_STORAGE_KEY = 'twitch-vod-manager:vod-sort';
let vodSortKey: VodSortKey = 'date_desc';

function loadPersistedVodSort(): VodSortKey {
    const stored = safeLocalStorageGet(VOD_SORT_STORAGE_KEY);
    if (stored && (VALID_VOD_SORTS as readonly string[]).includes(stored)) {
        return stored as VodSortKey;
    }
    return 'date_desc';
}

function persistVodSort(key: VodSortKey): void {
    safeLocalStorageSet(VOD_SORT_STORAGE_KEY, key);
}

function vodDurationToSeconds(durationStr: string): number {
    let total = 0;
    const h = durationStr.match(/(\d+)h/);
    const m = durationStr.match(/(\d+)m/);
    const s = durationStr.match(/(\d+)s/);
    if (h) total += parseInt(h[1], 10) * 3600;
    if (m) total += parseInt(m[1], 10) * 60;
    if (s) total += parseInt(s[1], 10);
    return total;
}

function sortVods(vods: VOD[], key: VodSortKey): VOD[] {
    const sorted = [...vods];
    const ts = (s: string): number => {
        const n = new Date(s).getTime();
        return Number.isFinite(n) ? n : 0;
    };
    switch (key) {
        case 'date_desc':
            sorted.sort((a, b) => ts(b.created_at) - ts(a.created_at));
            break;
        case 'date_asc':
            sorted.sort((a, b) => ts(a.created_at) - ts(b.created_at));
            break;
        case 'views_desc':
            sorted.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
            break;
        case 'duration_desc':
            sorted.sort((a, b) => vodDurationToSeconds(b.duration) - vodDurationToSeconds(a.duration));
            break;
        case 'duration_asc':
            sorted.sort((a, b) => vodDurationToSeconds(a.duration) - vodDurationToSeconds(b.duration));
            break;
    }
    return sorted;
}

function onVodSortChange(): void {
    const select = byId<HTMLSelectElement>('vodSortSelect');
    const value = select.value;
    if ((VALID_VOD_SORTS as readonly string[]).includes(value)) {
        vodSortKey = value as VodSortKey;
        persistVodSort(vodSortKey);
        if (lastLoadedStreamer) {
            renderVodGridFromCurrentState();
        }
    }
}

function syncVodSortSelect(): void {
    const select = document.getElementById('vodSortSelect') as HTMLSelectElement | null;
    if (select) select.value = vodSortKey;
}

function refreshVodSortSelectLabels(): void {
    const select = document.getElementById('vodSortSelect') as HTMLSelectElement | null;
    if (!select) return;
    const labels: Record<VodSortKey, string> = {
        date_desc: UI_TEXT.vods.sortDateDesc,
        date_asc: UI_TEXT.vods.sortDateAsc,
        views_desc: UI_TEXT.vods.sortViewsDesc,
        duration_desc: UI_TEXT.vods.sortDurationDesc,
        duration_asc: UI_TEXT.vods.sortDurationAsc
    };
    for (const opt of Array.from(select.options)) {
        const k = opt.value as VodSortKey;
        if (labels[k]) opt.textContent = labels[k];
    }
}

function loadPersistedVodFilter(): string {
    return safeLocalStorageGet(VOD_FILTER_STORAGE_KEY);
}

function persistVodFilter(query: string): void {
    safeLocalStorageSet(VOD_FILTER_STORAGE_KEY, query);
}

function filterVodsByQuery(vods: VOD[], query: string): VOD[] {
    const q = query.trim().toLowerCase();
    if (!q) return vods;
    return vods.filter((vod) => (vod.title || '').toLowerCase().includes(q));
}

function updateVodFilterCount(filteredCount: number, totalCount: number): void {
    const node = document.getElementById('vodFilterCount');
    if (!node) return;
    if (!totalCount || !vodFilterQuery.trim()) {
        node.textContent = '';
        return;
    }
    node.textContent = UI_TEXT.vods.filterMatchCount
        .replace('{shown}', String(filteredCount))
        .replace('{total}', String(totalCount));
}

function syncVodFilterClearButton(): void {
    const btn = document.getElementById('vodFilterClearBtn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.classList.toggle('is-hidden', !vodFilterQuery.trim());
}

function onVodFilterInput(): void {
    const input = byId<HTMLInputElement>('vodFilterInput');
    vodFilterQuery = input.value;
    persistVodFilter(vodFilterQuery);
    syncVodFilterClearButton();
    if (lastLoadedStreamer) {
        renderVodGridFromCurrentState();
    }
}

function clearVodFilter(): void {
    vodFilterQuery = '';
    const input = byId<HTMLInputElement>('vodFilterInput');
    if (input) input.value = '';
    persistVodFilter('');
    syncVodFilterClearButton();
    if (lastLoadedStreamer) {
        renderVodGridFromCurrentState();
    }
}

function focusVodFilter(): void {
    const input = document.getElementById('vodFilterInput') as HTMLInputElement | null;
    if (input) {
        input.focus();
        input.select();
    }
}

function renderVodLiveBadge(): string {
    return `<span class="vod-live-badge" title="${escapeHtml(UI_TEXT.vods.liveNowTooltip)}">${escapeHtml(UI_TEXT.vods.liveBadge)}</span>`;
}

function usableVodThumbnail(url: string): boolean {
    return Boolean(url) && !/(?:^|[/_-])404(?:[/_.-]|$)|not_found|processing/i.test(url);
}

function getVodCoverUrl(vodId: string, streamer: string, thumbnail: string): string {
    const login = streamer.toLowerCase();
    const key = login + '/' + vodId;
    if (liveVodIdByLogin.get(login) === vodId) {
        const getCover = (window as unknown as { getLiveVodCover?: (login: string, vodId: string) => string }).getLiveVodCover;
        const cover = getCover?.(login, vodId);
        if (cover) {
            lastLiveVodCovers.set(key, cover);
            if (lastLiveVodCovers.size > 64) lastLiveVodCovers.delete(lastLiveVodCovers.keys().next().value!);
            return cover;
        }
        return lastLiveVodCovers.get(key) || thumbnail;
    }
    return usableVodThumbnail(thumbnail) ? thumbnail : lastLiveVodCovers.get(key) || thumbnail;
}

function onVodThumbnailError(image: HTMLImageElement): void {
    const card = image.closest<HTMLElement>('.vod-card');
    const key = (card?.dataset.vodStreamer || '').toLowerCase() + '/' + card?.dataset.vodId;
    const fallback = lastLiveVodCovers.get(key);
    if (fallback && image.getAttribute('src') !== fallback) image.src = fallback;
    else {
        image.onerror = null;
        image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect fill="%23333" width="320" height="180"/></svg>';
    }
}

function syncVodCardCovers(): void {
    document.querySelectorAll<HTMLElement>('#vodGrid .vod-card[data-vod-id]').forEach(card => {
        const image = card.querySelector<HTMLImageElement>('.vod-thumbnail');
        if (!image) return;
        const source = getVodCoverUrl(card.dataset.vodId || '', card.dataset.vodStreamer || '', card.dataset.vodThumbnail || '');
        const key = (card.dataset.vodStreamer || '').toLowerCase() + '/' + card.dataset.vodId;
        const finalCover = card.dataset.liveVod !== 'true' && source === card.dataset.vodThumbnail && usableVodThumbnail(source);
        if (image.getAttribute('src') === source && image.complete && image.naturalWidth > 0 && finalCover) finishedVodCoverRefreshes.delete(key);
        if (image.getAttribute('src') === source) {
            delete image.dataset.coverRequest;
            return;
        }
        if (!source || image.dataset.coverRequest === source) return;
        image.dataset.coverRequest = source;
        const next = new Image();
        next.onload = () => {
            if (!image.isConnected || image.dataset.coverRequest !== source) return;
            image.src = source;
            delete image.dataset.coverRequest;
            if (finalCover) finishedVodCoverRefreshes.delete(key);
        };
        next.onerror = () => {
            if (image.dataset.coverRequest === source) delete image.dataset.coverRequest;
        };
        next.src = source;
    });
}

async function refreshFinishedVodCover(login: string, vodId: string, attempt = 0): Promise<void> {
    const key = login + '/' + vodId;
    if (attempt > 0 && !finishedVodCoverRefreshes.has(key)) return;
    const revision = (finishedVodCoverRefreshes.get(key) ?? 0) + 1;
    finishedVodCoverRefreshes.set(key, revision);
    try {
        const entry = await loadStreamerVods(login, true);
        if (finishedVodCoverRefreshes.get(key) !== revision || !entry) return;
        if (lastLoadedStreamer?.toLowerCase() !== login) { finishedVodCoverRefreshes.delete(key); return; }
        const thumbnails = new Map(entry.vods.map(vod => [vod.id, vod.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180')]));
        lastLoadedVods = lastLoadedVods.map(vod => ({ ...vod, thumbnail_url: thumbnails.get(vod.id) ?? vod.thumbnail_url }));
        document.querySelectorAll<HTMLElement>('#vodGrid .vod-card').forEach(card => {
            if ((card.dataset.vodStreamer || '').toLowerCase() !== login) return;
            const thumbnail = thumbnails.get(card.dataset.vodId || '');
            if (thumbnail) card.dataset.vodThumbnail = thumbnail;
        });
        syncVodCardCovers();
    } catch { }
    finally {
        if (finishedVodCoverRefreshes.get(key) === revision) {
            if (attempt < 4) window.setTimeout(() => { void refreshFinishedVodCover(login, vodId, attempt + 1); }, [5000, 15000, 30000, 60000][attempt]);
            else finishedVodCoverRefreshes.delete(key);
        }
    }
}

(window as unknown as { syncVodCardCovers: typeof syncVodCardCovers }).syncVodCardCovers = syncVodCardCovers;
(window as unknown as { onVodThumbnailError: typeof onVodThumbnailError }).onVodThumbnailError = onVodThumbnailError;

function updateVodLiveBadges(): void {
    document.querySelectorAll<HTMLElement>('#vodGrid .vod-card[data-vod-id]').forEach(card => {
        const badges = card.querySelector('.vod-status-badges');
        if (!badges) return;
        const isLive = liveVodIdByLogin.get((card.dataset.vodStreamer || '').toLowerCase()) === card.dataset.vodId;
        card.dataset.liveVod = String(isLive);
        const badge = badges.querySelector('.vod-live-badge');
        if (isLive && !badge) badges.insertAdjacentHTML('afterbegin', renderVodLiveBadge());
        else if (!isLive) badge?.remove();
    });
    syncVodCardCovers();
}

function buildVodCardHtml(vod: VOD, streamer: string, downloadedIds?: Set<string>): string {
    const thumb = vod.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180');
    const cover = getVodCoverUrl(vod.id, streamer, thumb);
    const date = formatVodCardDate(vod.created_at);
    const safeDisplayTitle = escapeHtml(vod.title || UI_TEXT.vods.untitled);
    const safeUrlAttr = escapeHtml(vod.url);
    const safeTitleAttr = escapeHtml(vod.title || '');
    const safeStreamerAttr = escapeHtml(streamer);
    const safeDateAttr = escapeHtml(vod.created_at);
    const safeDurationAttr = escapeHtml(vod.duration);
    const safeIdAttr = escapeHtml(vod.id);
    const isChecked = selectedVodUrls.has(vod.url);
    const isAlreadyDownloaded = downloadedIds ? downloadedIds.has(vod.id) : false;
    const downloadedBadge = isAlreadyDownloaded
        ? `<div class="vod-downloaded-badge" role="img" aria-label="${escapeHtml(UI_TEXT.vods.alreadyDownloaded)}" title="${escapeHtml(UI_TEXT.vods.alreadyDownloaded)}"><img src="./vod-downloaded-check.webp" width="24" height="24" alt="" draggable="false"></div>`
        : '';

    // All identity attributes go on data-* — a delegated listener on #vodGrid
    // reads them at click time. This removes the previous inline-onclick
    // template-injection pattern (escapedTitle dance) which was fragile for
    // titles containing backslashes / HTML entities like &apos;.
    return `
        <div class="vod-card${isChecked ? ' selected' : ''}${isAlreadyDownloaded ? ' already-downloaded' : ''}"
             role="button"
             tabindex="0"
             aria-label="${safeTitleAttr}"
             data-vod-id="${safeIdAttr}"
             data-vod-url="${safeUrlAttr}"
             data-vod-title="${safeTitleAttr}"
             data-vod-date="${safeDateAttr}"
             data-vod-streamer="${safeStreamerAttr}"
             data-live-vod="${liveVodIdByLogin.get(streamer.toLowerCase()) === vod.id}"
             data-vod-thumbnail="${escapeHtml(thumb)}"
             data-vod-duration="${safeDurationAttr}">
            <input type="checkbox" class="vod-select-checkbox" data-vod-url="${safeUrlAttr}" ${isChecked ? 'checked' : ''} aria-label="${escapeHtml(UI_TEXT.vods.selectAriaLabel)}">
            <div class="vod-status-badges">${liveVodIdByLogin.get(streamer.toLowerCase()) === vod.id ? renderVodLiveBadge() : ''}${downloadedBadge}</div>
            <div class="vod-thumb-wrap">
                <img class="vod-thumbnail" loading="lazy" decoding="async" src="${escapeHtml(cover)}" alt="" onerror="onVodThumbnailError(this)">
                <div class="vod-duration-badge">${escapeHtml(vod.duration)}</div>
            </div>
            <div class="vod-info">
                <div class="vod-title" title="${escapeHtml(vod.title || '')}">${safeDisplayTitle}</div>
                <div class="vod-meta">
                    <span class="vod-date"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1z"></path></svg>${date}</span>
                    <span class="vod-views"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>${formatUiNumber(vod.view_count)} ${escapeHtml(UI_TEXT.vods.views)}</span>
                </div>
            </div>
            <div class="vod-actions">
                <button type="button" class="vod-btn secondary" data-vod-action="trim">${escapeHtml(UI_TEXT.vods.trimButton)}</button>
                <button type="button" class="vod-btn primary" data-vod-action="queue">${escapeHtml(UI_TEXT.vods.addQueue)}</button>
            </div>
        </div>
    `;
}

interface VodCardContext {
    id: string;
    url: string;
    title: string;
    date: string;
    streamer: string;
    duration: string;
}

function readVodCardContext(card: HTMLElement | null): VodCardContext | null {
    if (!card) return null;
    const url = card.dataset.vodUrl;
    if (!url) return null;
    return {
        id: card.dataset.vodId || '',
        url,
        title: card.dataset.vodTitle || '',
        date: card.dataset.vodDate || '',
        streamer: card.dataset.vodStreamer || '',
        duration: card.dataset.vodDuration || ''
    };
}

let streamerDragInitialized = false;
let draggedStreamerName: string | null = null;

// Streamer list filter — only kicks in once the user has more than a handful
// of streamers. The input stays display:none below the threshold to avoid
// visual clutter for normal users with 1-3 streamers.
const STREAMER_FILTER_THRESHOLD = 6;
let streamerListFilterQuery = '';

// Per-streamer VOD scroll position. When the user clicks back to a streamer
// they've already viewed, restore where they were instead of jumping to top.
// Lives in localStorage so it survives reloads.
const VOD_SCROLL_POSITIONS_KEY = 'twitch-vod-manager:vod-scroll-positions';
let vodScrollPositions: Record<string, number> = {};
let pendingScrollRestore: { streamer: string; y: number } | null = null;
let vodScrollRestoreTimer: number | null = null;

function loadVodScrollPositions(): void {
    try {
        const raw = localStorage.getItem(VOD_SCROLL_POSITIONS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const cleaned: Record<string, number> = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cleaned[k] = v;
            }
            vodScrollPositions = cleaned;
        }
    } catch { /* localStorage unavailable */ }
}

function persistVodScrollPositions(): void {
    try {
        // Cap to last 32 entries to bound storage size.
        const entries = Object.entries(vodScrollPositions);
        if (entries.length > 32) {
            vodScrollPositions = Object.fromEntries(entries.slice(entries.length - 32));
        }
        localStorage.setItem(VOD_SCROLL_POSITIONS_KEY, JSON.stringify(vodScrollPositions));
    } catch { /* ignore */ }
}

function rememberCurrentVodScroll(): void {
    if (!lastLoadedStreamer) return;
    const grid = document.getElementById('vodGrid');
    if (!grid) return;
    // Find the scroll container — vodGrid sits inside a scrollable .content
    const scrollable = (grid.closest('.content') as HTMLElement | null) || grid;
    const y = scrollable.scrollTop;
    if (Number.isFinite(y) && y >= 0) {
        vodScrollPositions[lastLoadedStreamer] = y;
        persistVodScrollPositions();
    }
}

let vodScrollSaveTimer: number | null = null;

function initVodScrollTracking(): void {
    const grid = document.getElementById('vodGrid');
    if (!grid) return;
    const scrollable = (grid.closest('.content') as HTMLElement | null) || grid;
    scrollable.addEventListener('scroll', () => {
        if (vodScrollSaveTimer) window.clearTimeout(vodScrollSaveTimer);
        vodScrollSaveTimer = window.setTimeout(() => {
            vodScrollSaveTimer = null;
            rememberCurrentVodScroll();
        }, 250);
    }, { passive: true });
}

function isSupportedCutterVideoFile(file: { name: string }): boolean {
    return /\.(mp4|m4v|mov|webm|mkv|ts|avi)$/i.test(file.name);
}

function initCutterDragDrop(): void {
    const tab = document.getElementById('cutterTab');
    if (!tab) return;

    let dragOverCount = 0;
    const setDragVisual = (active: boolean): void => {
        const preview = document.getElementById('cutterPreview');
        if (preview) preview.classList.toggle('drag-over', active);
    };

    tab.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        dragOverCount++;
        setDragVisual(true);
    });
    tab.addEventListener('dragover', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    tab.addEventListener('dragleave', () => {
        dragOverCount = Math.max(0, dragOverCount - 1);
        if (dragOverCount === 0) setDragVisual(false);
    });
    tab.addEventListener('drop', async (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        dragOverCount = 0;
        setDragVisual(false);

        const files = Array.from(e.dataTransfer.files || []);
        if (files.length === 0) return;
        const file = files.find(isSupportedCutterVideoFile);
        if (!file) {
            showAppToast(UI_TEXT.cutter.unsupportedFile, 'warn');
            return;
        }
        const selection = await window.api.selectDroppedVideo(file);
        if (!selection) return;

        const loader = (window as unknown as { requestCutterVideoReplacement?: (selection: FileCapabilityReference) => Promise<void> }).requestCutterVideoReplacement;
        if (typeof loader === 'function') {
            await loader(selection);
        }
    });
}

let streamerContextMenu: HTMLDivElement | null = null;
let streamerContextMenuCleanup: (() => void) | null = null;

function dismissStreamerContextMenu(): void {
    streamerContextMenuCleanup?.();
    streamerContextMenuCleanup = null;
    streamerContextMenu = null;
}

function showStreamerContextMenu(event: MouseEvent, streamer: string): void {
    event.preventDefault();
    event.stopPropagation();
    dismissStreamerContextMenu();

    const autoList = (config.auto_record_streamers as string[] | undefined) || [];
    const vodList = (config.auto_vod_download_streamers as string[] | undefined) || [];
    const menu = document.createElement('div');
    menu.className = 'streamer-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', getStreamerDisplayName(streamer));

    const appendAction = (action: 'auto' | 'vod' | 'record', label: string, active: boolean, handler: () => void): void => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.streamerAction = action;
        button.className = `streamer-context-action streamer-context-${action}${active ? ' is-active' : ''}`;
        button.textContent = label;
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-label', action === 'auto'
            ? UI_TEXT.streamers?.autoRecordTitle || 'Auto-record'
            : action === 'vod'
                ? UI_TEXT.streamers?.autoVodTitle || 'Auto-download VODs'
                : UI_TEXT.streamers?.recordLiveTitle || 'Record live now');
        button.addEventListener('click', () => {
            dismissStreamerContextMenu();
            handler();
        });
        menu.appendChild(button);
    };

    appendAction('auto', 'AUTO', autoList.includes(streamer), () => { void toggleAutoRecord(streamer); });
    appendAction('vod', 'VOD', vodList.includes(streamer), () => { void toggleAutoVodDownload(streamer); });
    appendAction('record', 'REC', false, () => { void triggerLiveRecording(streamer); });
    document.body.appendChild(menu);

    const bounds = menu.getBoundingClientRect();
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - bounds.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - bounds.height - margin))}px`;

    const onPointerDown = (pointerEvent: PointerEvent): void => {
        if (!menu.contains(pointerEvent.target as Node)) dismissStreamerContextMenu();
    };
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key === 'Escape') dismissStreamerContextMenu();
    };
    const onResize = (): void => dismissStreamerContextMenu();
    streamerContextMenu = menu;
    streamerContextMenuCleanup = () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('resize', onResize);
        menu.remove();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    menu.querySelector<HTMLButtonElement>('button')?.focus();
}

function createStreamerAvatar(streamer: string): HTMLElement {
    const fallback = document.createElement('span');
    fallback.className = 'streamer-avatar-fallback';
    fallback.textContent = Array.from(getStreamerDisplayName(streamer))[0]?.toUpperCase() || '?';
    fallback.setAttribute('aria-hidden', 'true');
    const profile = streamerProfileCache.get(streamer.trim().toLowerCase());
    if (!profile?.avatarUrl) return fallback;
    const image = document.createElement('img');
    image.className = 'streamer-avatar';
    image.alt = '';
    image.draggable = false;
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
    image.src = profile.avatarUrl;
    return image;
}

function updateStreamerAvatars(login: string): void {
    const key = login.trim().toLowerCase();
    for (const item of Array.from(document.querySelectorAll<HTMLElement>('#streamerList .streamer-item'))) {
        if (item.dataset.streamerName?.trim().toLowerCase() !== key) continue;
        item.querySelector('.streamer-avatar, .streamer-avatar-fallback')?.replaceWith(createStreamerAvatar(login));
    }
}

function syncVodSelectionState(): void {
    const hasStreamers = (config.streamers ?? []).length > 0;
    const hasSelection = hasStreamers && Boolean(currentStreamer);
    document.getElementById('vodsTab')?.classList.toggle('vod-selection-empty', !hasSelection);
    const filters = document.getElementById('vodFilterRow');
    if (filters) filters.hidden = !hasSelection;
    const refresh = document.getElementById('toolbarRefreshVodsBtn') as HTMLButtonElement | null;
    if (refresh) refresh.disabled = !hasSelection;
    if (hasSelection) return;
    const grid = document.getElementById('vodGrid');
    if (grid) setVodGridEmptyState(grid,
        hasStreamers ? UI_TEXT.vods.noneTitle : UI_TEXT.vods.noStreamersTitle,
        hasStreamers ? UI_TEXT.vods.noneText : UI_TEXT.vods.noStreamersText);
}

function renderStreamers(): void {
    syncVodSelectionState();
    const list = byId('streamerList');
    list.replaceChildren();

    const all = (config.streamers ?? []) as string[];
    list.classList.toggle('streamers-empty', all.length === 0);
    const filterInput = document.getElementById('streamerListFilter') as HTMLInputElement | null;
    const sectionTitle = document.getElementById('streamerSectionTitle');
    const showFilter = all.length >= STREAMER_FILTER_THRESHOLD;
    if (filterInput) filterInput.classList.toggle('is-hidden', !showFilter);
    // Compact title margin when filter is shown — avoids double gap.
    if (sectionTitle) sectionTitle.classList.toggle('compact', showFilter);

    // Empty state — small hint inside the sidebar when no streamers have
    // been added yet. Without this the user sees a heading + blank space
    // and has to guess where to add the first streamer.
    if (all.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'streamer-list-empty';
        empty.textContent = UI_TEXT.streamers.sidebarEmpty;
        list.appendChild(empty);
        const counter = document.getElementById('streamerSectionCounter');
        if (counter) counter.textContent = '';
        const bulkBtn = document.getElementById('btnStreamerBulkRemove') as HTMLButtonElement | null;
        if (bulkBtn) bulkBtn.classList.add('is-hidden');
        scheduleStreamerActiveIndicatorSync();
        return;
    }

    // Section counter — "X · Y live". Updates on every re-render, so it
    // stays accurate after add/remove/live-status changes.
    const counter = document.getElementById('streamerSectionCounter');
    if (counter) {
        counter.textContent = all.length === 0 ? '' : formatUiNumber(all.length);
    }

    const q = (streamerListFilterQuery || '').trim().toLowerCase();
    const grouped = RendererVodLibrary.channels(all);
    const visible = q ? grouped.filter((s) => s.toLowerCase().includes(q)) : grouped;

    visible.forEach((streamer: string) => {
        const item = document.createElement('div');
        item.className = 'streamer-item' + (currentStreamer === streamer ? ' active' : '');
        item.setAttribute('draggable', 'true');
        item.dataset.streamerName = streamer;
        // Keyboard a11y for the row itself — click selects the streamer.
        // Each chip inside still gets its own focus + Enter/Space wiring
        // and stops propagation, so tabbing through a row lands on row
        // first, then AUTO / VOD / REC / remove in order.
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', getStreamerDisplayName(streamer));
        item.title = getStreamerDisplayName(streamer);
        if (currentStreamer === streamer) item.setAttribute('aria-current', 'true');

        // Live-dot — red pulsing dot when this streamer is currently
        // broadcasting on Twitch. Populated from the live-status batch
        // poller's snapshot. Renders before the name so the streamer
        // identity stays primary visually.
        const isLive = liveStatusByLogin.get(streamer.toLowerCase()) === true;
        if (isLive) {
            const dot = document.createElement('span');
            dot.className = 'streamer-live-dot';
            const liveLabel = UI_TEXT.streamers.liveNowTooltip || 'Live now';
            dot.title = liveLabel;
            dot.setAttribute('role', 'img');
            dot.setAttribute('aria-label', liveLabel);
            item.appendChild(dot);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'streamer-name' + (isLive ? ' is-live' : '');
        nameSpan.textContent = getStreamerDisplayName(streamer);
        const removeSpan = document.createElement('span');
        removeSpan.className = 'remove';
        removeSpan.appendChild(createStreamerRemoveIcon());
        removeSpan.setAttribute('role', 'button');
        removeSpan.setAttribute('tabindex', '0');
        removeSpan.setAttribute('aria-label', UI_TEXT.streamers.removeAria);
        removeSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            void removeStreamer(streamer);
        });
        removeSpan.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                void removeStreamer(streamer);
            }
        });
        item.append(createStreamerAvatar(streamer), nameSpan, removeSpan);

        item.addEventListener('contextmenu', (contextEvent) => {
            showStreamerContextMenu(contextEvent, streamer);
        });
        item.addEventListener('keydown', (keyEvent) => {
            if (keyEvent.key !== 'ContextMenu' && !(keyEvent.shiftKey && keyEvent.key === 'F10')) return;
            keyEvent.preventDefault();
            const rect = item.getBoundingClientRect();
            showStreamerContextMenu(new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + 12,
                clientY: rect.top + 12
            }), streamer);
        });

        item.addEventListener('click', () => {
            // Skip click if drag was just released — drop fires after dragend
            if (draggedStreamerName === streamer) return;
            void selectStreamer(streamer);
        });
        item.addEventListener('keydown', (e) => {
            // Activate row on Enter / Space when the row itself (not a
            // chip child) is focused. The chips already preventDefault
            // + stopPropagation on their own keydowns so they won't reach
            // this handler.
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (e.target !== item) return;
            e.preventDefault();
            void selectStreamer(streamer);
        });
        list.appendChild(item);
    });

    // Reveal bulk-remove button only above the filter threshold.
    const bulkBtn = document.getElementById('btnStreamerBulkRemove') as HTMLButtonElement | null;
    if (bulkBtn) bulkBtn.classList.toggle('is-hidden', all.length < STREAMER_FILTER_THRESHOLD);

    initStreamerDragDrop();
    scheduleStreamerActiveIndicatorSync();
}

function onStreamerListFilterChange(): void {
    const input = byId<HTMLInputElement>('streamerListFilter');
    streamerListFilterQuery = input.value;
    renderStreamers();
}

function clearActiveVodHoverPreview(): void {
    const clear = (window as unknown as { clearVodHoverPreview?: () => void }).clearVodHoverPreview;
    if (typeof clear === 'function') clear();
}

function cancelVodScrollRestore(): void {
    pendingScrollRestore = null;
    if (vodScrollRestoreTimer === null) return;
    window.clearTimeout(vodScrollRestoreTimer);
    vodScrollRestoreTimer = null;
}

function clearActiveStreamerSelection(): void {
    selectStreamerRequestId += 1;
    vodRenderTaskId += 1;
    currentStreamer = null;
    lastLoadedVods = [];
    lastLoadedStreamer = null;
    cancelVodScrollRestore();
    selectedVodUrls.clear();
    selectedVodUrlRevisions.clear();
    clearActiveVodHoverPreview();
    closeVodContextMenu();
    const hide = (window as unknown as { hideStreamerProfileHeader?: () => void }).hideStreamerProfileHeader;
    if (typeof hide === 'function') hide();
    updateVodBulkBar();
    updateVodFilterCount(0, 0);
    syncVodSelectionState();
    const setTitle = (window as unknown as { setPageTitle?: (text: string) => void }).setPageTitle;
    if (typeof setTitle === 'function') setTitle(UI_TEXT.tabs.vods);
}

let streamerListSaveQueue: Promise<boolean> = Promise.resolve(true);
let streamerAddInFlight = false;

function persistStreamerList(change: (current: string[]) => string[]): Promise<boolean> {
    const save = async (): Promise<boolean> => {
        const previous = [...(config.streamers || [])];
        const streamers = change(previous);
        if (JSON.stringify(streamers) === JSON.stringify(config.streamers || [])) return true;
        try {
            const saved = await window.api.saveConfig({ streamers });
            config = { ...config, streamers: saved.streamers };
            renderStreamers();
            return true;
        } catch {
            showAppToast(currentLanguage === 'de' ? 'Streamerliste konnte nicht gespeichert werden.' : 'Could not save the streamer list.', 'warn');
            return false;
        }
    };
    const pending = streamerListSaveQueue.then(save, save);
    streamerListSaveQueue = pending;
    return pending;
}

async function bulkRemoveStreamers(): Promise<void> {
    const all = (config.streamers ?? []) as string[];
    if (all.length === 0) return;
    const q = (streamerListFilterQuery || '').trim().toLowerCase();
    // If a filter is active, target only the matching streamers; else
    // require explicit confirmation to clear the entire list.
    const targets = q ? all.filter((s) => s.toLowerCase().includes(q)) : all;
    if (targets.length === 0) return;

    const messageTemplate = q ? UI_TEXT.static.streamerBulkRemoveFiltered : UI_TEXT.static.streamerBulkRemoveAll;
    if (!confirm(messageTemplate.replace('{count}', String(targets.length)))) return;

    if (!await persistStreamerList(current => current.filter(name => !targets.includes(name)))) return;
    if (currentStreamer && targets.includes(currentStreamer)) {
        clearActiveStreamerSelection();
    }
    streamerListFilterQuery = '';
    const input = document.getElementById('streamerListFilter') as HTMLInputElement | null;
    if (input) input.value = '';
    renderStreamers();
}

function initStreamerDragDrop(): void {
    if (streamerDragInitialized) return;
    streamerDragInitialized = true;

    const list = byId('streamerList');

    list.addEventListener('dragstart', (e: DragEvent) => {
        const target = e.target as HTMLElement;
        const item = target.closest('.streamer-item') as HTMLElement | null;
        if (!item || !item.dataset.streamerName) return;
        draggedStreamerName = item.dataset.streamerName;
        item.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            // Some browsers refuse the drag without setData
            e.dataTransfer.setData('text/plain', draggedStreamerName);
        }
    });

    list.addEventListener('dragover', (e: DragEvent) => {
        if (!draggedStreamerName) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    list.addEventListener('drop', async (e: DragEvent) => {
        e.preventDefault();
        const target = (e.target as HTMLElement).closest('.streamer-item') as HTMLElement | null;
        if (!target || !draggedStreamerName) return;
        const targetName = target.dataset.streamerName;
        if (!targetName || targetName === draggedStreamerName) return;

        const dragged = draggedStreamerName;
        await persistStreamerList(current => {
            const from = current.indexOf(dragged);
            const to = current.indexOf(targetName);
            if (from < 0 || to < 0) return current;
            const [moved] = current.splice(from, 1);
            current.splice(to, 0, moved);
            return current;
        });
    });

    list.addEventListener('dragend', () => {
        document.querySelectorAll('.streamer-item.dragging').forEach((el) => el.classList.remove('dragging'));
        // Defer clearing draggedStreamerName so the click handler that fires
        // after dragend can suppress the spurious select.
        const wasDragging = draggedStreamerName;
        window.setTimeout(() => {
            if (draggedStreamerName === wasDragging) draggedStreamerName = null;
        }, 50);
    });
}

async function addStreamer(): Promise<void> {
    if (streamerAddInFlight) return;
    const input = byId<HTMLInputElement>('newStreamer');
    const name = input.value.trim().toLowerCase();
    if (!name) {
        return;
    }

    if (!/^[a-zA-Z0-9_]{1,25}$/.test(name)) {
        showAppToast(UI_TEXT.static.streamerInvalid, 'warn');
        return;
    }

    if ((config.streamers ?? []).includes(name)) {
        return;
    }

    streamerAddInFlight = true;
    const button = byId<HTMLButtonElement>('btnAddStreamer');
    button.disabled = true;
    try {
        if (!await persistStreamerList(current => current.includes(name) ? current : [...current, name])) return;
        if (input.value.trim().toLowerCase() === name) input.value = '';
    } finally {
        streamerAddInFlight = false;
        button.disabled = false;
    }
    void hydrateStreamerDisplayNames();
    try { await selectStreamer(name); }
    catch { showAppToast(currentLanguage === 'de' ? 'VODs konnten nicht geladen werden.' : 'Could not load VODs.', 'warn'); }
}

async function removeStreamer(name: string): Promise<void> {
    if (!await persistStreamerList(current => current.filter(streamer => streamer !== name))) return;
    if (currentStreamer === name) clearActiveStreamerSelection();
    renderStreamers();
}

function normalizeStreamerCacheKey(name: string): string {
    return name.trim().toLowerCase();
}

function vodCollectionsMatch(left: VOD[], right: VOD[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((vod, index) => {
        const other = right[index];
        return Boolean(other)
            && vod.id === other.id
            && vod.title === other.title
            && vod.created_at === other.created_at
            && vod.duration === other.duration
            && vod.thumbnail_url === other.thumbnail_url
            && vod.url === other.url
            && vod.view_count === other.view_count;
    });
}

async function loadStreamerVods(name: string, forceRefresh = false): Promise<CachedStreamerVods | null> {
    const key = normalizeStreamerCacheKey(name);
    const cached = streamerVodCache.get(key);
    if (!forceRefresh && cached) return cached;
    const pending = streamerVodLoads.get(key);
    if (pending) return pending;

    const task = (async () => {
        const userId = await window.api.getUserId(name);
        if (!userId) return null;
        const vods = await window.api.getVODs(userId, forceRefresh);
        const entry = { userId, vods: Array.isArray(vods) ? vods : [], updatedAt: Date.now() };
        streamerVodCache.set(key, entry);
        return entry;
    })();
    streamerVodLoads.set(key, task);
    try {
        return await task;
    } finally {
        if (streamerVodLoads.get(key) === task) streamerVodLoads.delete(key);
    }
}

async function preloadConfiguredStreamerData(streamers: string[] = (config.streamers ?? []) as string[]): Promise<void> {
    const profilePreloader = (window as unknown as { preloadStreamerProfiles?: (logins: string[]) => Promise<void> }).preloadStreamerProfiles;
    const jobs: Promise<unknown>[] = streamers.map((name) => loadStreamerVods(name));
    if (typeof profilePreloader === 'function') jobs.push(profilePreloader(streamers));
    await Promise.allSettled(jobs);
}

async function refreshConfiguredStreamersInBackground(): Promise<void> {
    const streamers = [...((config.streamers ?? []) as string[])];
    const profileRefresher = (window as unknown as { refreshStreamerProfilesInBackground?: (logins: string[]) => Promise<void> }).refreshStreamerProfilesInBackground;
    const activeKey = currentStreamer ? normalizeStreamerCacheKey(currentStreamer) : '';
    const previousActiveVods = activeKey ? streamerVodCache.get(activeKey)?.vods ?? [] : [];
    const jobs = streamers.map((name) => loadStreamerVods(name, true));
    await Promise.allSettled([
        ...jobs,
        ...(typeof profileRefresher === 'function' ? [profileRefresher(streamers)] : [])
    ]);
    if (!currentStreamer || normalizeStreamerCacheKey(currentStreamer) !== activeKey) return;
    const updated = streamerVodCache.get(activeKey)?.vods;
    if (updated && !vodCollectionsMatch(previousActiveVods, updated)) renderVODs(updated, currentStreamer, true);
}

function startStreamerBackgroundRefresh(): void {
    if (streamerBackgroundRefreshTimer !== null) window.clearInterval(streamerBackgroundRefreshTimer);
    streamerBackgroundRefreshTimer = window.setInterval(() => {
        void refreshConfiguredStreamersInBackground();
    }, STREAMER_BACKGROUND_REFRESH_MS);
}

function renderVodGridLoadingState(): void {
    byId('vodGrid').innerHTML = Array.from({ length: 6 }, () => `
        <div class="vod-card vod-card-skeleton">
            <div class="vod-skel-thumb"></div>
            <div class="vod-info">
                <div class="vod-skel-line title"></div>
                <div class="vod-skel-line meta-1"></div>
                <div class="vod-skel-line meta-2"></div>
            </div>
        </div>
    `).join('');
}

async function selectStreamer(name: string, forceRefresh = false): Promise<void> {
    clearActiveVodHoverPreview();
    // Save where we were on the OLD streamer before navigating away.
    rememberCurrentVodScroll();
    cancelVodScrollRestore();

    const requestId = ++selectStreamerRequestId;
    const isStaleRequest = () => requestId !== selectStreamerRequestId || currentStreamer !== name;

    if (currentStreamer !== name) {
        vodRenderTaskId += 1;
        lastLoadedStreamer = null;
        lastLoadedVods = [];
        closeVodContextMenu();
        renderVodGridLoadingState();
        if (selectedVodUrls.size > 0) {
            selectedVodUrls.clear();
            selectedVodUrlRevisions.clear();
            updateVodBulkBar();
        }
    }
    currentStreamer = name;
    // Schedule a scroll-restore once the VOD grid renders. The actual
    // restore runs after renderVODs replaces the grid.
    const savedY = vodScrollPositions[name];
    pendingScrollRestore = (typeof savedY === 'number' && savedY > 0) ? { streamer: name, y: savedY } : null;
    renderStreamers();
    const setTitle = (window as unknown as { setPageTitle?: (text: string) => void }).setPageTitle;
    const displayName = getStreamerDisplayName(name);
    if (typeof setTitle === 'function') setTitle(displayName);
    else byId('pageTitle').textContent = displayName;

    // Kick off the profile header load in parallel with VOD fetching.
    // It's a separate request stream and not strictly needed for the VOD
    // grid, so we don't await it here — the skeleton appears immediately.
    const profileLoader = (window as unknown as { loadStreamerProfile?: (login: string, forceRefresh?: boolean) => Promise<void> }).loadStreamerProfile;
    if (typeof profileLoader === 'function') {
        void profileLoader(name, forceRefresh);
    }

    if (!isConnected) {
        await connect();
        if (isStaleRequest()) {
            return;
        }
    }

    if (!isConnected) {
        updateStatus(UI_TEXT.status.noLogin, false);
    }

    const key = normalizeStreamerCacheKey(name);
    const cached = streamerVodCache.get(key);
    if (cached) {
        renderVODs(cached.vods, name);
    } else {
        renderVodGridLoadingState();
    }

    const loaded = await loadStreamerVods(name, forceRefresh);
    if (isStaleRequest()) return;

    if (!loaded) {
        byId('vodGrid').innerHTML = `<div class="empty-state"><h3>${UI_TEXT.vods.notFound}</h3></div>`;
        return;
    }

    if (!cached || !vodCollectionsMatch(cached.vods, loaded.vods)) renderVODs(loaded.vods, name, Boolean(cached));
}

function createStreamerRemoveIcon(): SVGSVGElement {
    const namespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(namespace, 'svg');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2.2');
    icon.setAttribute('stroke-linecap', 'round');
    const cross = document.createElementNS(namespace, 'path');
    cross.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    icon.appendChild(cross);
    return icon;
}

function createVodEmptyStateIcon(): SVGSVGElement {
    const namespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(namespace, 'svg');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.5');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    const page = document.createElementNS(namespace, 'path');
    page.setAttribute('d', 'M6 2h8l4 4v16H6zM14 2v5h5');
    const play = document.createElementNS(namespace, 'path');
    play.setAttribute('d', 'M10 11l5 3-5 3z');
    icon.append(page, play);
    return icon;
}

function setVodGridEmptyState(grid: HTMLElement, title: string, text: string): void {
    // Build via DOM API so the (locale-only) strings can never escape into HTML.
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    const p = document.createElement('p');
    p.textContent = text;
    wrap.append(createVodEmptyStateIcon(), h3, p);
    grid.replaceChildren(wrap);
}

function renderVODs(vods: VOD[] | null | undefined, streamer: string, animateChanges = false): void {
    // Clear bulk-selection on streamer switch — selection is per-streamer
    if (lastLoadedStreamer && lastLoadedStreamer !== streamer && selectedVodUrls.size > 0) {
        selectedVodUrls.clear();
        selectedVodUrlRevisions.clear();
        updateVodBulkBar();
    }
    const motion = animateChanges ? captureVodGridMotion() : undefined;
    lastLoadedVods = Array.isArray(vods) ? vods : [];
    lastLoadedStreamer = streamer;
    initVodGridSelectionDelegation();
    renderVodGridFromCurrentState(motion);

    // After the first chunk lands the grid has size, so scroll-restore can
    // succeed. Use a small delay to let chunked rendering paint.
    if (pendingScrollRestore && pendingScrollRestore.streamer === streamer) {
        const target = pendingScrollRestore;
        pendingScrollRestore = null;
        vodScrollRestoreTimer = window.setTimeout(() => {
            vodScrollRestoreTimer = null;
            if (lastLoadedStreamer !== target.streamer) return;
            const grid = document.getElementById('vodGrid');
            if (!grid) return;
            const scrollable = (grid.closest('.content') as HTMLElement | null) || grid;
            scrollable.scrollTop = target.y;
        }, 80);
    }
}

function initVodGridSelectionDelegation(): void {
    if (vodGridDelegationInitialized) return;
    vodGridDelegationInitialized = true;

    const grid = document.getElementById('vodGrid');
    if (!grid) return;

    grid.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        // 1) Checkbox toggles (bulk-select)
        if (target instanceof HTMLInputElement && target.classList.contains('vod-select-checkbox')) {
            const card = target.closest('.vod-card') as HTMLElement | null;
            if (card) setVodCardSelection(card, target.checked);
            return;
        }

        // 2) Action buttons (trim / queue) — replaces the previous inline
        // onclick template that mangled titles with special characters
        const btn = target.closest('button[data-vod-action]') as HTMLButtonElement | null;
        if (btn) {
            const ctx = readVodCardContext(btn.closest('.vod-card') as HTMLElement | null);
            if (!ctx) return;
            if (btn.dataset.vodAction === 'trim') {
                openClipDialog(ctx.url, ctx.title, ctx.date, ctx.streamer, ctx.duration);
            } else if (btn.dataset.vodAction === 'queue') {
                void addToQueue(ctx.url, ctx.title, ctx.date, ctx.streamer, ctx.duration);
            }
            return;
        }

        const card = target.closest('.vod-card') as HTMLElement | null;
        if (!card) return;
        if (target.closest('.vod-actions') || target.classList.contains('vod-select-checkbox')) return;
        toggleVodCardSelection(card);
    });

    grid.addEventListener('contextmenu', (e) => {
        const card = (e.target as HTMLElement).closest('.vod-card') as HTMLElement | null;
        if (!card) return;
        const ctx = readVodCardContext(card);
        if (!ctx) return;
        e.preventDefault();
        showVodContextMenu(e.clientX, e.clientY, ctx, card);
    });

    grid.addEventListener('keydown', (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const card = target.closest('.vod-card') as HTMLElement | null;
        if (!card || card !== target) return;
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            const ctx = readVodCardContext(card);
            if (!ctx) return;
            e.preventDefault();
            const rect = card.getBoundingClientRect();
            showVodContextMenu(rect.left + 12, rect.top + 12, ctx, card);
            return;
        }
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleVodCardSelection(card);
    });
}

function setVodCardSelection(card: HTMLElement, selected: boolean): void {
    const checkbox = card.querySelector<HTMLInputElement>('.vod-select-checkbox');
    const url = checkbox?.dataset.vodUrl || '';
    if (!checkbox || !url) return;
    checkbox.checked = selected;
    card.classList.toggle('selected', selected);
    if (selected !== selectedVodUrls.has(url)) {
        vodSelectionRevision += 1;
        if (selected) {
            selectedVodUrls.add(url);
            selectedVodUrlRevisions.set(url, vodSelectionRevision);
        } else {
            selectedVodUrls.delete(url);
            selectedVodUrlRevisions.delete(url);
        }
    }
    updateVodBulkBar();
}

function toggleVodCardSelection(card: HTMLElement): void {
    const checkbox = card.querySelector<HTMLInputElement>('.vod-select-checkbox');
    if (!checkbox) return;
    setVodCardSelection(card, !checkbox.checked);
}

let activeVodContextMenu: HTMLElement | null = null;
let activeVodContextMenuInvoker: HTMLElement | null = null;
let activeVodContextMenuCleanup: (() => void) | null = null;

function closeVodContextMenu(restoreFocus = false): void {
    const cleanup = activeVodContextMenuCleanup;
    activeVodContextMenuCleanup = null;
    cleanup?.();
    if (!activeVodContextMenu) return;
    activeVodContextMenu.remove();
    activeVodContextMenu = null;
    const invoker = activeVodContextMenuInvoker;
    activeVodContextMenuInvoker = null;
    if (restoreFocus && invoker?.isConnected) invoker.focus();
}

async function copyVodUrl(url: string): Promise<void> {
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    try {
        await navigator.clipboard.writeText(url);
        if (toast) toast(UI_TEXT.vods.ctxCopiedUrl, 'info');
    } catch {
        if (toast) toast(UI_TEXT.vods.ctxCopyFailed, 'warn');
    }
}

function showVodContextMenu(x: number, y: number, ctx: VodCardContext, invoker: HTMLElement | null): void {
    closeVodContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    const downloadedIds = new Set(
        Array.isArray(config.downloaded_vod_ids)
            ? (config.downloaded_vod_ids as string[]).filter((id) => typeof id === 'string')
            : []
    );
    const isMarkedDownloaded = downloadedIds.has(ctx.id);

    const cleanup = (restoreFocus = false): void => closeVodContextMenu(restoreFocus);
    const makeItem = (label: string, onClick: () => void): HTMLElement => {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = label;
        el.className = 'context-menu-item';
        el.setAttribute('role', 'menuitem');
        el.addEventListener('click', () => {
            try { onClick(); } finally { cleanup(); }
        });
        return el;
    };

    menu.appendChild(makeItem(UI_TEXT.vods.ctxOpenOnTwitch, () => {
        void window.api.openExternal(ctx.url);
    }));
    menu.appendChild(makeItem(UI_TEXT.vods.ctxCopyUrl, () => {
        void copyVodUrl(ctx.url);
    }));
    menu.appendChild(makeItem(UI_TEXT.vods.trimButton, () => {
        openClipDialog(ctx.url, ctx.title, ctx.date, ctx.streamer, ctx.duration);
    }));
    menu.appendChild(makeItem(UI_TEXT.vods.addQueue, () => {
        void addToQueue(ctx.url, ctx.title, ctx.date, ctx.streamer, ctx.duration);
    }));
    menu.appendChild(makeItem(
        isMarkedDownloaded ? UI_TEXT.vods.ctxUnmarkDownloaded : UI_TEXT.vods.ctxMarkDownloaded,
        () => { void toggleVodDownloadedMark(ctx.id, !isMarkedDownloaded); }
    ));

    document.body.appendChild(menu);
    activeVodContextMenu = menu;
    activeVodContextMenuInvoker = invoker;

    // Reposition if it would clip off the viewport
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4);
    if (top + rect.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - rect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const dismissOnClick = (ev: MouseEvent) => {
        if (!activeVodContextMenu) return;
        if (ev.target instanceof Node && activeVodContextMenu.contains(ev.target)) return;
        cleanup();
    };
    const dismissOnScroll = () => cleanup();
    activeVodContextMenuCleanup = () => {
        document.removeEventListener('mousedown', dismissOnClick, true);
        document.removeEventListener('scroll', dismissOnScroll, true);
    };
    document.addEventListener('mousedown', dismissOnClick, true);
    document.addEventListener('scroll', dismissOnScroll, true);
    RendererAccessibility.installMenuKeyboardNavigation(menu, () => cleanup(true));
    RendererAccessibility.focusFirstMenuItem(menu);
}

async function toggleVodDownloadedMark(vodId: string, mark: boolean): Promise<void> {
    const result = await window.api.markVodDownloaded(vodId, mark);
    if (!result?.success) return;
    try {
        config = await window.api.getConfig();
    } catch { /* ignore */ }
    if (lastLoadedStreamer) renderVodGridFromCurrentState();
}

function updateVodBulkBar(): void {
    const bar = document.getElementById('vodBulkBar');
    if (!bar) return;
    const count = selectedVodUrls.size;
    bar.classList.toggle('is-visible', count > 0);
    const countEl = document.getElementById('vodBulkCount');
    if (countEl) {
        countEl.textContent = UI_TEXT.vods.bulkSelectedCount.replace('{count}', String(count));
    }
}

function clearVodSelection(): void {
    if (selectedVodUrls.size === 0) return;
    selectedVodUrls.clear();
    selectedVodUrlRevisions.clear();
    updateVodBulkBar();
    if (lastLoadedStreamer) renderVodGridFromCurrentState();
}

function removeVodSelectionIfUnchanged(url: string, revision: number | undefined): void {
    if (!selectedVodUrls.has(url) || selectedVodUrlRevisions.get(url) !== revision) return;
    selectedVodUrls.delete(url);
    selectedVodUrlRevisions.delete(url);
}

function setVodBulkActionsDisabled(disabled: boolean): void {
    for (const id of ['vodBulkAddBtn', 'vodBulkMarkBtn', 'vodBulkUnmarkBtn']) {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        if (button) button.disabled = disabled;
    }
}

function beginVodBulkOperation(): boolean {
    if (vodBulkOperationInFlight) return false;
    vodBulkOperationInFlight = true;
    setVodBulkActionsDisabled(true);
    return true;
}

function endVodBulkOperation(): void {
    vodBulkOperationInFlight = false;
    setVodBulkActionsDisabled(false);
}

async function toggleAutoRecord(streamer: string): Promise<void> {
    const current = ((config.auto_record_streamers as string[]) || []).slice();
    const idx = current.indexOf(streamer);
    if (idx >= 0) {
        current.splice(idx, 1);
    } else {
        current.push(streamer);
    }
    config = await window.api.saveConfig({ auto_record_streamers: current });
    renderStreamers();

    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) {
        const wasAdded = idx < 0;
        const tmpl = wasAdded ? UI_TEXT.streamers.autoRecordEnabled : UI_TEXT.streamers.autoRecordDisabled;
        toast(tmpl.replace('{streamer}', streamer), 'info');
    }
}

async function toggleAutoVodDownload(streamer: string): Promise<void> {
    const current = ((config.auto_vod_download_streamers as string[]) || []).slice();
    const idx = current.indexOf(streamer);
    if (idx >= 0) {
        current.splice(idx, 1);
    } else {
        current.push(streamer);
    }
    config = await window.api.saveConfig({ auto_vod_download_streamers: current });
    renderStreamers();

    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) {
        const wasAdded = idx < 0;
        const tmpl = wasAdded ? UI_TEXT.streamers.autoVodEnabled : UI_TEXT.streamers.autoVodDisabled;
        toast(tmpl.replace('{streamer}', streamer), 'info');
    }
}

async function triggerLiveRecording(streamer: string): Promise<void> {
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    const result = await window.api.startLiveRecording(streamer);
    if (!toast) return;
    if (result.success) {
        toast(UI_TEXT.streamers.liveRecordingStarted.replace('{streamer}', streamer), 'info');
        return;
    }
    if (result.error === 'OFFLINE') {
        toast(UI_TEXT.streamers.liveRecordingOffline.replace('{streamer}', streamer), 'warn');
        return;
    }
    if (result.error === 'ALREADY_RECORDING') {
        toast(UI_TEXT.streamers.liveRecordingAlreadyActive.replace('{streamer}', streamer), 'warn');
        return;
    }
    toast(UI_TEXT.streamers.liveRecordingFailed + (result.error ? `: ${result.error}` : ''), 'warn');
}

async function bulkMarkSelectedDownloaded(mark: boolean): Promise<void> {
    const urls = Array.from(selectedVodUrls);
    if (urls.length === 0) return;
    if (!beginVodBulkOperation()) return;
    const vods = new Map(lastLoadedVods.map((vod) => [vod.url, { id: vod.id }]));
    const selectionRevisions = new Map(urls.map((url) => [url, selectedVodUrlRevisions.get(url)]));

    try {
        let updated = 0;
        let failed = 0;
        for (const url of urls) {
            const vod = vods.get(url);
            if (!vod || !vod.id) {
                failed++;
                continue;
            }
            try {
                const result = await window.api.markVodDownloaded(vod.id, mark);
                if (result?.success) {
                    updated++;
                    removeVodSelectionIfUnchanged(url, selectionRevisions.get(url));
                } else {
                    failed++;
                }
            } catch {
                failed++;
            }
        }

        updateVodBulkBar();
        if (updated > 0) {
            try { config = await window.api.getConfig(); } catch { /* ignore */ }
            if (lastLoadedStreamer) renderVodGridFromCurrentState();
        }

        const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
        if (toast && updated > 0 && failed === 0) {
            const template = updated === 1
                ? (mark ? UI_TEXT.vods.bulkMarkedDownloadedOne : UI_TEXT.vods.bulkUnmarkedDownloadedOne)
                : (mark ? UI_TEXT.vods.bulkMarkedDownloaded : UI_TEXT.vods.bulkUnmarkedDownloaded);
            toast(template.replace('{count}', String(updated)), 'info');
        } else if (toast && updated === 0 && failed > 0) {
            const template = failed === 1 ? UI_TEXT.vods.bulkMarkFailedOne : UI_TEXT.vods.bulkMarkFailed;
            toast(template.replace('{count}', String(failed)), 'warn');
        } else if (toast && updated > 0 && failed > 0) {
            toast(UI_TEXT.vods.bulkMarkResult
                .replace('{updated}', String(updated))
                .replace('{failed}', String(failed)), 'warn');
        }
    } finally {
        endVodBulkOperation();
    }
}

async function bulkAddSelectedVodsToQueue(): Promise<void> {
    const urls = Array.from(selectedVodUrls);
    if (urls.length === 0 || !lastLoadedStreamer) return;
    if (!beginVodBulkOperation()) return;
    const streamer = lastLoadedStreamer;
    const vods = new Map(lastLoadedVods.map((vod) => [vod.url, {
        url: vod.url,
        title: vod.title,
        date: vod.created_at,
        streamer,
        duration_str: vod.duration
    }]));
    const selectionRevisions = new Map(urls.map((url) => [url, selectedVodUrlRevisions.get(url)]));

    const btn = document.getElementById('vodBulkAddBtn') as HTMLButtonElement | null;
    const originalText = btn?.textContent || '';
    if (btn) btn.textContent = UI_TEXT.vods.bulkAdding;

    try {
        let added = 0;
        let duplicates = 0;
        let invalid = 0;
        let failed = 0;
        for (const [index, url] of urls.entries()) {
            const vod = vods.get(url);
            if (!vod) {
                invalid++;
                removeVodSelectionIfUnchanged(url, selectionRevisions.get(url));
                continue;
            }
            try {
                const result = await window.api.addToQueueWithResult(vod);
                if (result.accepted) {
                    added++;
                } else if (result.reason === 'duplicate') {
                    duplicates++;
                } else if (result.reason === 'invalid') {
                    invalid++;
                } else {
                    failed++;
                    if (result.reason === 'shutting-down' || result.reason === 'access-denied') {
                        failed += urls.length - index - 1;
                        break;
                    }
                    continue;
                }
                removeVodSelectionIfUnchanged(url, selectionRevisions.get(url));
            } catch {
                failed++;
            }
        }

        updateVodBulkBar();
        renderQueue();
        if (lastLoadedStreamer === streamer) renderVodGridFromCurrentState();

        const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
        const categoryCount = Number(added > 0) + Number(duplicates > 0) + Number(invalid > 0) + Number(failed > 0);
        if (toast && categoryCount === 1 && added > 0) {
            const template = added === 1 ? UI_TEXT.vods.bulkAddedToQueueOne : UI_TEXT.vods.bulkAddedToQueue;
            toast(template.replace('{count}', String(added)), 'info');
        } else if (toast && categoryCount === 1 && duplicates > 0) {
            const template = duplicates === 1 ? UI_TEXT.vods.bulkAddDuplicateOne : UI_TEXT.vods.bulkAddDuplicate;
            toast(template.replace('{count}', String(duplicates)), 'warn');
        } else if (toast && categoryCount === 1 && invalid > 0) {
            const template = invalid === 1 ? UI_TEXT.vods.bulkAddInvalidOne : UI_TEXT.vods.bulkAddInvalid;
            toast(template.replace('{count}', String(invalid)), 'warn');
        } else if (toast && categoryCount === 1 && failed > 0) {
            const template = failed === 1 ? UI_TEXT.vods.bulkAddFailedOne : UI_TEXT.vods.bulkAddFailed;
            toast(template.replace('{count}', String(failed)), 'warn');
        } else if (toast && categoryCount > 1) {
            toast(UI_TEXT.vods.bulkAddResult
                .replace('{added}', String(added))
                .replace('{duplicates}', String(duplicates))
                .replace('{invalid}', String(invalid))
                .replace('{failed}', String(failed)), 'warn');
        }
    } finally {
        if (btn) btn.textContent = originalText;
        endVodBulkOperation();
    }
}

interface VodGridMotion {
    rects: Map<string, { left: number; top: number }>;
    ids: Set<string>;
}

function captureVodGridMotion(): VodGridMotion {
    const rects = new Map<string, { left: number; top: number }>();
    const ids = new Set<string>();
    document.querySelectorAll<HTMLElement>('#vodGrid .vod-card[data-vod-id]').forEach((card) => {
        const id = card.dataset.vodId;
        if (!id) return;
        const rect = card.getBoundingClientRect();
        rects.set(id, { left: rect.left, top: rect.top });
        ids.add(id);
    });
    return { rects, ids };
}

function animateVodGridMotion(motion: VodGridMotion): void {
    document.querySelectorAll<HTMLElement>('#vodGrid .vod-card[data-vod-id]').forEach((card, index) => {
        const id = card.dataset.vodId || '';
        const previous = motion.rects.get(id);
        if (previous) {
            const rect = card.getBoundingClientRect();
            const x = previous.left - rect.left;
            const y = previous.top - rect.top;
            if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
                card.animate([
                    { transform: `translate(${x}px, ${y}px)` },
                    { transform: 'translate(0, 0)' }
                ], { duration: 420, easing: 'cubic-bezier(.22, 1, .36, 1)' });
            }
            return;
        }
        card.animate([
            { opacity: 0, transform: 'translateY(16px) scale(.98)' },
            { opacity: 1, transform: 'translateY(0) scale(1)' }
        ], { duration: 360, delay: Math.min(index * 24, 144), easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards' });
    });
}

function renderVodGridFromCurrentState(motion?: VodGridMotion): void {
    clearActiveVodHoverPreview();
    if (!lastLoadedStreamer) return;

    const grid = byId('vodGrid');
    const renderTaskId = ++vodRenderTaskId;
    const total = lastLoadedVods.length;

    if (total === 0) {
        setVodGridEmptyState(grid, UI_TEXT.vods.noResultsTitle, UI_TEXT.vods.noResultsText);
        updateVodFilterCount(0, 0);
        return;
    }

    const sorted = sortVods(lastLoadedVods, vodSortKey);
    const downloadedIdsForFilter = new Set(
        Array.isArray(config.downloaded_vod_ids)
            ? (config.downloaded_vod_ids as string[]).filter((id) => typeof id === 'string')
            : []
    );
    const sortedAndHidden = vodHideDownloaded
        ? sorted.filter((vod) => !downloadedIdsForFilter.has(vod.id))
        : sorted;
    const filtered = filterVodsByQuery(sortedAndHidden, vodFilterQuery);

    if (filtered.length === 0 && vodHideDownloaded && sortedAndHidden.length === 0 && !vodFilterQuery.trim()) {
        setVodGridEmptyState(grid, UI_TEXT.vods.hideDownloadedEmptyTitle, UI_TEXT.vods.hideDownloadedEmptyText);
        updateVodFilterCount(0, total);
        return;
    }

    if (filtered.length === 0 && vodFilterQuery.trim()) {
        setVodGridEmptyState(grid, UI_TEXT.vods.filterNoMatchTitle, UI_TEXT.vods.filterNoMatchText);
        updateVodFilterCount(0, total);
        return;
    }

    grid.replaceChildren();
    updateVodFilterCount(filtered.length, total);

    // Build the downloaded-ids lookup once per render — Set.has is O(1) vs
    // Array.includes which would be O(n*m) across all cards.
    const downloadedIds = new Set(
        Array.isArray(config.downloaded_vod_ids)
            ? (config.downloaded_vod_ids as string[]).filter((id) => typeof id === 'string')
            : []
    );

    const scheduleNextChunk = (nextStartIndex: number): void => {
        const delayMs = document.hidden ? 16 : 0;
        window.setTimeout(() => {
            renderChunk(nextStartIndex);
        }, delayMs);
    };

    const renderChunk = (startIndex: number): void => {
        if (renderTaskId !== vodRenderTaskId) {
            return;
        }

        const chunk = filtered.slice(startIndex, startIndex + VOD_RENDER_CHUNK_SIZE);
        if (!chunk.length) {
            return;
        }

        grid.insertAdjacentHTML('beforeend', chunk.map((vod) => buildVodCardHtml(vod, lastLoadedStreamer || '', downloadedIds)).join(''));

        if (startIndex + chunk.length < filtered.length) {
            scheduleNextChunk(startIndex + chunk.length);
        } else if (motion) {
            requestAnimationFrame(() => animateVodGridMotion(motion));
        }
    };

    renderChunk(0);
}

async function refreshVODs(): Promise<void> {
    if (!currentStreamer) {
        return;
    }

    await selectStreamer(currentStreamer, true);
}

(window as unknown as {
    preloadConfiguredStreamerData: typeof preloadConfiguredStreamerData;
    refreshConfiguredStreamersInBackground: typeof refreshConfiguredStreamersInBackground;
    startStreamerBackgroundRefresh: typeof startStreamerBackgroundRefresh;
}).preloadConfiguredStreamerData = preloadConfiguredStreamerData;
(window as unknown as { refreshConfiguredStreamersInBackground: typeof refreshConfiguredStreamersInBackground }).refreshConfiguredStreamersInBackground = refreshConfiguredStreamersInBackground;
(window as unknown as { startStreamerBackgroundRefresh: typeof startStreamerBackgroundRefresh }).startStreamerBackgroundRefresh = startStreamerBackgroundRefresh;
