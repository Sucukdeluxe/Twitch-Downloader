const QUEUE_SYNC_FAST_MS = 900;
const QUEUE_SYNC_DEFAULT_MS = 1800;
const QUEUE_SYNC_IDLE_MS = 4500;
const QUEUE_SYNC_HIDDEN_MS = 9000;
const QUEUE_SYNC_RECENT_ACTIVITY_WINDOW_MS = 15000;

async function init(): Promise<void> {
    const [loadedConfig, loadedSecretStatus, initialQueue, isDown, version] = await Promise.all([
        window.api.getConfig(),
        window.api.getSecretStatus(),
        window.api.getQueue(),
        window.api.isDownloading(),
        window.api.getVersion()
    ]);
    config = loadedConfig;
    secretStatus = loadedSecretStatus;
    const language = setLanguage((config.language as string) || 'en');
    config.language = language;
    queue = Array.isArray(initialQueue) ? initialQueue : [];
    downloading = isDown;
    markQueueActivity();

    byId('versionText').textContent = `v${version}`;
    byId('versionInfo').textContent = `Version: v${version}`;
    appVersion = version;
    document.title = `${UI_TEXT.appName} v${version}`;

    byId<HTMLInputElement>('clientId').value = config.client_id ?? '';
    byId<HTMLInputElement>('clientSecret').value = secretStatus.clientSecretConfigured ? SECRET_INPUT_MASK : '';
    byId<HTMLInputElement>('downloadPath').value = config.download_path ?? '';
    byId<HTMLSelectElement>('themeSelect').value = config.theme ?? 'twitch';
    byId<HTMLSelectElement>('languageSelect').value = config.language ?? 'en';
    updateLanguagePicker(config.language ?? 'en');
    setSettingsPane(byId<HTMLElement>('settingsTab').dataset.settingsPane || 'design');
    byId<HTMLSelectElement>('downloadMode').value = config.download_mode ?? 'full';
    byId<HTMLInputElement>('partMinutes').value = String(config.part_minutes ?? 120);
    byId<HTMLSelectElement>('performanceMode').value = (config.performance_mode as string) || 'balanced';
    byId<HTMLInputElement>('smartSchedulerToggle').checked = (config.smart_queue_scheduler as boolean) !== false;
    byId<HTMLInputElement>('duplicatePreventionToggle').checked = (config.prevent_duplicate_downloads as boolean) !== false;
    byId<HTMLInputElement>('metadataCacheMinutes').value = String((config.metadata_cache_minutes as number) || 10);
    byId<HTMLInputElement>('vodFilenameTemplate').value = (config.filename_template_vod as string) || DEFAULT_VOD_TEMPLATE;
    byId<HTMLInputElement>('partsFilenameTemplate').value = (config.filename_template_parts as string) || DEFAULT_PARTS_TEMPLATE;
    byId<HTMLInputElement>('defaultClipFilenameTemplate').value = (config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE;
    initSettingsAutoSave();

    changeTheme(config.theme ?? 'twitch');
    renderStreamers();
    void hydrateStreamerDisplayNames();
    renderQueue();

    // Kick off live-status subscription so the sidebar dots populate.
    const liveStatusInit = (window as unknown as { initLiveStatusSubscription?: () => Promise<void> }).initLiveStatusSubscription;
    if (typeof liveStatusInit === 'function') void liveStatusInit();
    initQueueDragDrop();
    updateDownloadButtonState();
    updateStatusBarQueueSummary();

    // Restore persisted VOD filter into the input — the filter itself only
    // takes effect once VODs load (renderVODs reads vodFilterQuery).
    vodFilterQuery = loadPersistedVodFilter();
    const vodFilterInput = document.getElementById('vodFilterInput') as HTMLInputElement | null;
    if (vodFilterInput) vodFilterInput.value = vodFilterQuery;
    syncVodFilterClearButton();

    // Restore persisted VOD sort key. Apply localized labels to <option>s
    // before syncing the select value so the right option is preselected
    // even on first load before any language change fires.
    vodSortKey = loadPersistedVodSort();
    refreshVodSortSelectLabels();
    syncVodSortSelect();

    // Restore "hide downloaded" toggle state.
    vodHideDownloaded = loadPersistedHideDownloaded();
    syncVodHideDownloadedToggle();

    // Restore per-streamer VOD scroll positions from prior sessions.
    loadVodScrollPositions();
    initVodScrollTracking();
    initCutterDragDrop();
    initCutterEditor();

    // Restore last active tab from previous session (default 'vods')
    initTopNavActiveIndicator();
    initSegmentedIndicators();
    showTab(loadPersistedActiveTab());

    window.api.onQueueUpdated(async (q: QueueItem[]) => {
        const previouslyCompleted = new Set(queue.filter((i) => i.status === 'completed').map((i) => i.id));
        const next = Array.isArray(q) ? q : [];
        const newlyCompletedItem = next.some((i) => i.status === 'completed' && !previouslyCompleted.has(i.id));
        queue = mergeQueueState(next);

        // When an item flips to 'completed' the main process appends its
        // VOD ID to config.downloaded_vod_ids. Refresh our local config
        // copy so the "already downloaded" badge on the VOD grid updates
        // live without waiting for a settings save.
        if (newlyCompletedItem) {
            try {
                config = await window.api.getConfig();
            } catch { /* network blip — next sync will refresh */ }
            if (typeof renderVodGridFromCurrentState === 'function' && lastLoadedStreamer) {
                renderVodGridFromCurrentState();
            }
        }

        renderQueue();
        updateStatusBarQueueSummary();
        markQueueActivity();
    });

    window.api.onQueueDuplicateSkipped((payload) => {
        const title = payload?.title ? ` (${payload.title})` : '';
        showAppToast(`${UI_TEXT.queue.duplicateSkipped}${title}`, 'warn');
    });

    window.api.onDownloadProgress((progress: DownloadProgress) => {
        const item = queue.find((i: QueueItem) => i.id === progress.id);
        if (!item) {
            return;
        }

        item.status = 'downloading';
        if (progress.progress > 0) item.progress = Math.max(item.progress, progress.progress);
        item.speed = progress.speed;
        item.eta = progress.eta;
        item.currentPart = progress.currentPart;
        item.totalParts = progress.totalParts;
        item.downloadedBytes = progress.downloadedBytes;
        item.totalBytes = progress.totalBytes;
        item.progressStatus = progress.status;
        if (progress.recordingHealth) {
            item.recordingHealth = progress.recordingHealth;
        }
        updateQueueItemProgress(progress);
        updateStatusBarQueueSummary();
        markQueueActivity();
    });

    window.api.onAutoVodScanCompleted(({ queuedCount }) => {
        if (queuedCount > 0) {
            const tmpl = UI_TEXT.streamers.autoVodScanQueued || '{count} new VOD(s) auto-queued.';
            showAppToast(tmpl.replace('{count}', String(queuedCount)), 'info');
        }
    });

    window.api.onDownloadStarted(() => {
        downloading = true;
        updateDownloadButtonState();
        markQueueActivity();
    });

    window.api.onDownloadPaused(() => {
        downloading = false;
        updateDownloadButtonState();
        markQueueActivity();
    });

    window.api.onDownloadFinished(() => {
        downloading = false;
        updateDownloadButtonState();
        markQueueActivity();
    });

    window.api.onCutProgress((percent: number) => {
        const rounded = Math.round(percent);
        byId('cutProgressBar').style.width = percent + '%';
        byId('cutProgressText').textContent = rounded + '%';
        byId('cutProgressGauge').setAttribute('aria-valuenow', String(rounded));
    });

    window.api.onMergeProgress((percent: number) => {
        const rounded = Math.round(percent);
        byId('mergeProgressBar').style.width = percent + '%';
        byId('mergeProgressText').textContent = rounded + '%';
        byId('mergeProgressGauge').setAttribute('aria-valuenow', String(rounded));
    });

    // Update stats bar — paused while the window is hidden so we don't
    // burn IPC chatter on a tab nobody is looking at.
    void updateStatsBar();
    startStatsBarPolling();
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopStatsBarPolling();
        else startStatsBarPolling();
    });

    if (config.client_id && secretStatus.clientSecretConfigured) {
        await connect();
    } else {
        updateStatus(UI_TEXT.status.noLogin, false);
    }

    if (config.streamers && config.streamers.length > 0) {
        const preloader = (window as unknown as { preloadConfiguredStreamerData?: (streamers: string[]) => Promise<void> }).preloadConfiguredStreamerData;
        if (typeof preloader === 'function') void preloader(config.streamers as string[]);
        await selectStreamer(config.streamers[0]);
    }

    const startBackgroundRefresh = (window as unknown as { startStreamerBackgroundRefresh?: () => void }).startStreamerBackgroundRefresh;
    if (typeof startBackgroundRefresh === 'function') startBackgroundRefresh();

    setTimeout(() => {
        void checkUpdateSilent();
    }, 3000);

    void runPreflight(false);
    void refreshManagedToolStatus();
    void refreshDebugLog();
    validateFilenameTemplates();
    void refreshRuntimeMetrics();

    document.addEventListener('visibilitychange', () => {
        scheduleQueueSync(document.hidden ? 600 : 150);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Esc closes any open modal — works regardless of focus, so users can dismiss
        // a modal that took focus from inside an input field
        if (e.key === 'Escape') {
            if (closeTopmostOpenModal()) {
                e.preventDefault();
                return;
            }

            // No modal open: if the VOD filter has focus or content, clear it.
            // Otherwise let Esc bubble (e.g. blur).
            if (e.target instanceof HTMLInputElement && e.target.id === 'vodFilterInput') {
                if (vodFilterQuery) {
                    clearVodFilter();
                    e.preventDefault();
                }
                return;
            }
        }

        // Ctrl+F (or Cmd+F): focus the VOD filter — only when on the VODs tab.
        // Browser's default Ctrl+F is suppressed because Electron's renderer
        // doesn't have a native find bar anyway. Route the shortcut to the
        // active tab's search/filter input so the user lands in a useful
        // place regardless of which tab they happen to be on.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
            if (document.getElementById('vodsTab')?.classList.contains('active')) {
                e.preventDefault();
                focusVodFilter();
                return;
            }
            if (document.getElementById('archiveTab')?.classList.contains('active')) {
                const archiveInput = document.getElementById('archiveSearchQuery') as HTMLInputElement | null;
                if (archiveInput) {
                    e.preventDefault();
                    archiveInput.focus();
                    archiveInput.select();
                    return;
                }
            }
        }

        // Skip rest if user is typing in an input field
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

        // Ctrl+1..7 jumps directly to a tab (Cmd on macOS via metaKey)
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '7') {
            const tabIndex = parseInt(e.key, 10) - 1;
            if (tabIndex >= 0 && tabIndex < TAB_IDS.length) {
                e.preventDefault();
                showTab(TAB_IDS[tabIndex]);
                return;
            }
        }

        if (e.key === 'Delete' && selectedQueueIds.length > 0) {
            // Delete selected queue items
            const idsToRemove = [...selectedQueueIds];
            selectedQueueIds = [];
            (async () => {
                for (const id of idsToRemove) {
                    queue = await window.api.removeFromQueue(id);
                }
                renderQueue();
            })();
        }

        if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            toggleDownload();
        }
    });

    scheduleQueueSync(QUEUE_SYNC_DEFAULT_MS);
}

function openTwitchDevConsole(): void {
    void window.api.openExternal('https://dev.twitch.tv/console/apps');
}

interface EventLogEntry {
    t?: string;
    type?: string;
    title?: string;
    game?: string;
    from?: string;
    to?: string;
    streamer?: string;
    durationSeconds?: number;
    success?: boolean;
    error?: string;
    part?: number;
}

interface ViewerListboxController {
    activeIndex(): number;
    synchronizeRange(range: { start: number; end: number }): number;
    dispose(): void;
}

interface ViewerListboxOptions {
    list: HTMLElement;
    itemCount: () => number;
    rowHeight: number;
    optionId: (index: number) => string;
    label: string;
    detailTitle: string;
    detailText: (index: number) => string;
    requestRender: () => void;
}

function ensureViewerDetailDialog(): { dialog: HTMLElement; title: HTMLElement; text: HTMLElement; closeButton: HTMLButtonElement } {
    const existing = document.getElementById('viewerDetailModal');
    if (existing instanceof HTMLElement) {
        const title = existing.querySelector<HTMLElement>('#viewerDetailTitle');
        const text = existing.querySelector<HTMLElement>('#viewerDetailText');
        const closeButton = existing.querySelector<HTMLButtonElement>('#viewerDetailClose');
        if (title && text && closeButton) return { dialog: existing, title, text, closeButton };
        existing.remove();
    }
    const dialog = document.createElement('div');
    dialog.id = 'viewerDetailModal';
    dialog.className = 'viewer-detail-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'viewerDetailTitle');
    const panel = document.createElement('div');
    panel.className = 'viewer-detail-dialog';
    const header = document.createElement('div');
    header.className = 'viewer-detail-header';
    const title = document.createElement('h2');
    title.id = 'viewerDetailTitle';
    const closeButton = document.createElement('button');
    closeButton.id = 'viewerDetailClose';
    closeButton.type = 'button';
    closeButton.className = 'viewer-detail-close';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', UI_TEXT.streamers.modalCloseAria);
    closeButton.addEventListener('click', () => RendererAccessibility.closeDialog('viewerDetailModal'));
    const text = document.createElement('div');
    text.id = 'viewerDetailText';
    text.className = 'viewer-detail-text';
    header.append(title, closeButton);
    panel.append(header, text);
    dialog.appendChild(panel);
    document.body.appendChild(dialog);
    return { dialog, title, text, closeButton };
}

function openViewerDetail(title: string, text: string, returnFocus: HTMLElement): void {
    const detail = ensureViewerDetailDialog();
    detail.title.textContent = title;
    detail.text.textContent = text;
    if (document.activeElement !== returnFocus) returnFocus.focus();
    RendererAccessibility.openDialog('viewerDetailModal', { initialFocus: detail.closeButton });
}

function createViewerListbox(options: ViewerListboxOptions): ViewerListboxController {
    const { list } = options;
    let active = options.itemCount() > 0 ? 0 : -1;
    const updateActiveDescendant = (): void => {
        if (active < 0) list.removeAttribute('aria-activedescendant');
        else list.setAttribute('aria-activedescendant', options.optionId(active));
    };
    const synchronizeRange = (range: { start: number; end: number }): number => {
        const count = options.itemCount();
        if (count === 0 || range.end <= range.start) {
            active = -1;
            updateActiveDescendant();
            return active;
        }
        if (active < range.start || active >= range.end) {
            const firstVisible = Math.max(range.start, Math.floor(list.scrollTop / options.rowHeight));
            active = Math.min(range.end - 1, Math.max(range.start, firstVisible));
        }
        updateActiveDescendant();
        return active;
    };
    const setActive = (next: number): void => {
        const count = options.itemCount();
        if (count === 0) return;
        active = Math.max(0, Math.min(count - 1, next));
        const firstVisible = Math.floor(list.scrollTop / options.rowHeight);
        const visibleCount = Math.max(1, Math.ceil(list.clientHeight / options.rowHeight));
        if (active < firstVisible || active >= firstVisible + visibleCount) {
            list.scrollTop = Math.max(0, active * options.rowHeight - Math.floor(Math.max(0, list.clientHeight - options.rowHeight) / 2));
        }
        updateActiveDescendant();
        options.requestRender();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
        const count = options.itemCount();
        if (count === 0) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(active + 1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(active - 1);
            return;
        }
        if (event.key === 'Home') {
            event.preventDefault();
            setActive(0);
            return;
        }
        if (event.key === 'End') {
            event.preventDefault();
            setActive(count - 1);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openViewerDetail(options.detailTitle, options.detailText(active), list);
        }
    };
    list.setAttribute('role', 'listbox');
    list.setAttribute('tabindex', '0');
    list.setAttribute('aria-label', options.label);
    updateActiveDescendant();
    list.addEventListener('keydown', onKeyDown);
    return {
        activeIndex: () => active,
        synchronizeRange,
        dispose: () => {
            list.removeEventListener('keydown', onKeyDown);
            list.removeAttribute('aria-activedescendant');
            list.removeAttribute('aria-label');
            list.removeAttribute('role');
            list.removeAttribute('tabindex');
        }
    };
}

let eventsViewerMessages: EventLogEntry[] = [];
let eventsViewerSessionGeneration = 0;
let eventsViewerReadAbort: AbortController | null = null;
let eventsViewerVirtualList: ReturnType<typeof RendererAccessibility.createFixedHeightVirtualList> | null = null;
let eventsViewerListbox: ViewerListboxController | null = null;
const eventsViewerRenderGeneration = new RendererAccessibility.RenderGeneration();
const EVENT_VIEWER_ROW_HEIGHT = 36;
const EVENT_VIEWER_OVERSCAN = 12;

function disposeEventsViewerVirtualList(): void {
    eventsViewerVirtualList?.dispose();
    eventsViewerVirtualList = null;
    eventsViewerListbox?.dispose();
    eventsViewerListbox = null;
}

async function openEventsViewer(filePath: string, title: string): Promise<void> {
    const sessionGeneration = ++eventsViewerSessionGeneration;
    eventsViewerReadAbort?.abort();
    eventsViewerRenderGeneration.cancel();
    const abortController = new AbortController();
    eventsViewerReadAbort = abortController;
    const list = byId('eventsViewerList');
    const status = byId('eventsViewerStatus');
    byId('eventsViewerTitle').textContent = title || UI_TEXT.queue.viewEvents;
    disposeEventsViewerVirtualList();
    list.replaceChildren();
    RendererAccessibility.setBusy(list, true);
    status.textContent = UI_TEXT.queue.viewChatLoading;
    RendererAccessibility.openDialog('eventsViewerModal', { onEscape: closeEventsViewer });

    const result = await window.api.readChatFile(filePath, abortController.signal);
    if (sessionGeneration !== eventsViewerSessionGeneration || abortController.signal.aborted || !RendererAccessibility.isDialogOpen('eventsViewerModal')) return;
    RendererAccessibility.setBusy(list, false);
    if (!result.success || !Array.isArray(result.messages)) {
        if (result.cancelled) return;
        status.textContent = UI_TEXT.queue.viewChatFailed + (result.error ? `: ${result.error}` : '');
        return;
    }
    eventsViewerMessages = result.messages as EventLogEntry[];
    status.textContent = UI_TEXT.queue.viewEventsCount.replace('{count}', String(result.total ?? eventsViewerMessages.length));
    renderEventsList(eventsViewerMessages, eventsViewerRenderGeneration.next());
}

function closeEventsViewer(): void {
    eventsViewerSessionGeneration++;
    eventsViewerReadAbort?.abort();
    eventsViewerReadAbort = null;
    eventsViewerRenderGeneration.cancel();
    disposeEventsViewerVirtualList();
    RendererAccessibility.setBusy(byId('eventsViewerList'), false);
    RendererAccessibility.closeDialog('eventsViewerModal');
    eventsViewerMessages = [];
}

function formatEventTime(iso?: string): string {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        return d.toLocaleString(currentLanguage === 'en' ? 'en-US' : 'de-DE');
    } catch { return iso; }
}

function getEventViewerDetail(event: EventLogEntry): string {
    if (event.type === 'recording_start') return `${UI_TEXT.queue.eventStartedAs}: "${event.title || '-'}" — ${event.game || '-'}`;
    if (event.type === 'recording_end') {
        const duration = typeof event.durationSeconds === 'number'
            ? `${Math.floor(event.durationSeconds / 3600)}h ${Math.floor((event.durationSeconds % 3600) / 60)}m ${event.durationSeconds % 60}s`
            : '?';
        const outcome = event.success ? '✓' : '✗';
        return `${outcome} ${UI_TEXT.queue.eventEndedAfter}: ${duration}${event.error ? ` — ${event.error}` : ''}`;
    }
    if (event.type === 'recording_resume') return (UI_TEXT.queue.eventRecordingResume || 'Resume started — part {part}').replace('{part}', String(event.part || '?'));
    if (event.type === 'title_change') return UI_TEXT.queue.eventTitleFromTo.replace('{from}', `"${event.from || '-'}"`).replace('{to}', `"${event.to || '-'}"`);
    if (event.type === 'game_change') return UI_TEXT.queue.eventGameFromTo.replace('{from}', event.from || '-').replace('{to}', event.to || '-');
    return JSON.stringify(event);
}

function getEventViewerAccessibleLabel(event: EventLogEntry): string {
    return `${formatEventTime(event.t)} ${event.type || 'event'} ${getEventViewerDetail(event)}`.trim();
}

function createEventViewerRow(event: EventLogEntry, index: number, activeIndex: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'event-viewer-row';
    row.id = `eventsViewerOption-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === activeIndex));
    const time = document.createElement('span');
    time.className = 'event-viewer-time';
    time.textContent = formatEventTime(event.t);
    const tag = document.createElement('span');
    tag.className = 'event-viewer-tag';
    if (event.type) tag.dataset.type = event.type;
    tag.textContent = event.type || 'event';
    const detail = document.createElement('div');
    detail.className = 'event-viewer-detail';
    detail.textContent = getEventViewerDetail(event);
    const accessibleLabel = getEventViewerAccessibleLabel(event);
    row.title = accessibleLabel;
    row.setAttribute('aria-label', accessibleLabel);
    row.append(time, tag, detail);
    return row;
}

function renderEventsList(events: EventLogEntry[], generation: number): void {
    if (!eventsViewerRenderGeneration.isCurrent(generation) || !RendererAccessibility.isDialogOpen('eventsViewerModal')) return;
    const list = byId('eventsViewerList');
    disposeEventsViewerVirtualList();
    list.replaceChildren();
    if (events.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'event-viewer-empty';
        empty.textContent = UI_TEXT.queue.viewEventsEmpty;
        list.appendChild(empty);
        return;
    }
    const canvas = document.createElement('div');
    canvas.className = 'event-viewer-virtual-canvas';
    canvas.style.height = `${events.length * EVENT_VIEWER_ROW_HEIGHT}px`;
    const rows = document.createElement('div');
    rows.className = 'event-viewer-virtual-rows';
    canvas.appendChild(rows);
    list.appendChild(canvas);
    eventsViewerListbox = createViewerListbox({
        list,
        itemCount: () => events.length,
        rowHeight: EVENT_VIEWER_ROW_HEIGHT,
        optionId: (index) => `eventsViewerOption-${index}`,
        label: UI_TEXT.queue.viewEvents,
        detailTitle: UI_TEXT.queue.viewEvents,
        detailText: (index) => getEventViewerAccessibleLabel(events[index]),
        requestRender: () => eventsViewerVirtualList?.render(),
    });
    eventsViewerVirtualList = RendererAccessibility.createFixedHeightVirtualList(list, {
        itemCount: () => events.length,
        rowHeight: EVENT_VIEWER_ROW_HEIGHT,
        overscan: EVENT_VIEWER_OVERSCAN,
        render: (range) => {
            if (!eventsViewerRenderGeneration.isCurrent(generation) || !RendererAccessibility.isDialogOpen('eventsViewerModal')) return;
            const activeIndex = eventsViewerListbox?.synchronizeRange(range) ?? -1;
            rows.style.transform = `translateY(${range.start * EVENT_VIEWER_ROW_HEIGHT}px)`;
            const fragment = document.createDocumentFragment();
            for (let index = range.start; index < range.end; index++) fragment.appendChild(createEventViewerRow(events[index], index, activeIndex));
            rows.replaceChildren(fragment);
        }
    });
}

interface ChatViewerMessage {
    t?: string;
    type?: string;
    u?: string;
    user?: string;
    login?: string;
    color?: string;
    msg?: string;
    text?: string;
    offset?: number;
    badges?: string;
    bits?: string;
    msgId?: string;
    systemMsg?: string;
}

let chatViewerMessages: ChatViewerMessage[] = [];
let chatViewerFormat: 'replay' | 'live' = 'replay';
let chatViewerSessionGeneration = 0;
let chatViewerReadAbort: AbortController | null = null;
let chatViewerVirtualList: ReturnType<typeof RendererAccessibility.createFixedHeightVirtualList> | null = null;
let chatViewerListbox: ViewerListboxController | null = null;
const chatViewerRenderGeneration = new RendererAccessibility.RenderGeneration();
const CHAT_VIEWER_ROW_HEIGHT = 29;
const CHAT_VIEWER_OVERSCAN = 12;

function disposeChatViewerVirtualList(): void {
    chatViewerVirtualList?.dispose();
    chatViewerVirtualList = null;
    chatViewerListbox?.dispose();
    chatViewerListbox = null;
}

async function openChatViewer(filePath: string, title: string): Promise<void> {
    const sessionGeneration = ++chatViewerSessionGeneration;
    chatViewerReadAbort?.abort();
    chatViewerRenderGeneration.cancel();
    const abortController = new AbortController();
    chatViewerReadAbort = abortController;
    const modal = byId('chatViewerModal');
    const list = byId('chatViewerList');
    const status = byId('chatViewerStatus');
    const filterInput = byId<HTMLInputElement>('chatViewerFilter');
    byId('chatViewerTitle').textContent = title || UI_TEXT.queue.viewChat;
    disposeChatViewerVirtualList();
    list.replaceChildren();
    RendererAccessibility.setBusy(list, true);
    filterInput.value = '';
    status.textContent = UI_TEXT.queue.viewChatLoading;
    RendererAccessibility.openDialog('chatViewerModal', { initialFocus: filterInput, onEscape: closeChatViewer });

    const result = await window.api.readChatFile(filePath, abortController.signal);
    if (sessionGeneration !== chatViewerSessionGeneration || abortController.signal.aborted || !modal.classList.contains('show')) return;
    RendererAccessibility.setBusy(list, false);
    if (!result.success || !Array.isArray(result.messages)) {
        if (result.cancelled) return;
        status.textContent = UI_TEXT.queue.viewChatFailed + (result.error ? `: ${result.error}` : '');
        return;
    }

    chatViewerMessages = result.messages as ChatViewerMessage[];
    chatViewerFormat = result.format === 'live' ? 'live' : 'replay';
    status.textContent = UI_TEXT.queue.viewChatCount.replace('{count}', String(result.total ?? chatViewerMessages.length))
        + (result.truncated ? UI_TEXT.queue.viewChatTruncatedSuffix : '');
    onChatViewerFilterChange();
}

function closeChatViewer(): void {
    chatViewerSessionGeneration++;
    chatViewerReadAbort?.abort();
    chatViewerReadAbort = null;
    chatViewerRenderGeneration.cancel();
    disposeChatViewerVirtualList();
    RendererAccessibility.setBusy(byId('chatViewerList'), false);
    RendererAccessibility.closeDialog('chatViewerModal');
    chatViewerMessages = [];
}

function onChatViewerFilterChange(): void {
    const generation = chatViewerRenderGeneration.next();
    const list = byId('chatViewerList');
    disposeChatViewerVirtualList();
    RendererAccessibility.setBusy(list, false);
    list.scrollTop = 0;
    list.replaceChildren();
    const filter = byId<HTMLInputElement>('chatViewerFilter').value.trim().toLowerCase();
    if (!filter) {
        renderChatViewerList(chatViewerMessages, generation);
        return;
    }
    RendererAccessibility.setBusy(list, true);
    const filtered: ChatViewerMessage[] = [];
    let index = 0;
    const filterChunk = (): void => {
        if (!chatViewerRenderGeneration.isCurrent(generation) || !RendererAccessibility.isDialogOpen('chatViewerModal')) return;
        const deadline = performance.now() + 8;
        while (index < chatViewerMessages.length && performance.now() < deadline) {
            const m = chatViewerMessages[index++];
            const u = (m.u || m.user || m.login || '').toLowerCase();
            const text = (m.msg || m.text || '').toLowerCase();
            if (u.includes(filter) || text.includes(filter)) filtered.push(m);
        }
        if (index < chatViewerMessages.length) {
            window.setTimeout(filterChunk, 0);
            return;
        }
        RendererAccessibility.setBusy(list, false);
        renderChatViewerList(filtered, generation);
    };
    filterChunk();
}

function getChatViewerAccessibleLabel(m: ChatViewerMessage): string {
    return [formatChatTimeMarker(m), m.u || m.user || m.login || '', m.msg || m.text || ''].filter(Boolean).join(' ');
}

function createChatViewerRow(m: ChatViewerMessage, index: number, activeIndex: number): HTMLElement {
    const row = document.createElement('div');
    const isMessageType = m.type === 'msg' || !m.type;
    row.className = 'chat-viewer-row' + (!isMessageType ? ' is-system' : '');
    row.id = `chatViewerOption-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === activeIndex));

    if (!isMessageType) {
        const tag = document.createElement('span');
        tag.className = 'chat-viewer-tag';
        tag.textContent = m.type || 'event';
        row.appendChild(tag);
    }

    const time = formatChatTimeMarker(m);
    if (time) {
        const timeElement = document.createElement('span');
        timeElement.className = 'chat-viewer-time';
        timeElement.textContent = time;
        row.appendChild(timeElement);
    }

    const user = m.u || m.user || m.login || '';
    if (user) {
        const userElement = document.createElement('span');
        userElement.className = 'chat-viewer-user';
        if (m.color) userElement.style.color = m.color;
        userElement.textContent = `${user}:`;
        row.appendChild(userElement);
    }

    const message = document.createElement('span');
    message.textContent = ' ' + (m.msg || m.text || '');
    row.appendChild(message);
    const accessibleLabel = getChatViewerAccessibleLabel(m);
    row.title = accessibleLabel;
    row.setAttribute('aria-label', accessibleLabel);
    return row;
}

function renderChatViewerList(messages: ChatViewerMessage[], generation: number): void {
    if (!chatViewerRenderGeneration.isCurrent(generation) || !RendererAccessibility.isDialogOpen('chatViewerModal')) return;
    const list = byId('chatViewerList');
    disposeChatViewerVirtualList();
    RendererAccessibility.setBusy(list, false);
    list.replaceChildren();
    const canvas = document.createElement('div');
    canvas.className = 'chat-viewer-virtual-canvas';
    canvas.style.height = `${messages.length * CHAT_VIEWER_ROW_HEIGHT}px`;
    const rows = document.createElement('div');
    rows.className = 'chat-viewer-virtual-rows';
    canvas.appendChild(rows);
    list.appendChild(canvas);
    chatViewerListbox = createViewerListbox({
        list,
        itemCount: () => messages.length,
        rowHeight: CHAT_VIEWER_ROW_HEIGHT,
        optionId: (index) => `chatViewerOption-${index}`,
        label: UI_TEXT.queue.viewChat,
        detailTitle: UI_TEXT.queue.viewChat,
        detailText: (index) => getChatViewerAccessibleLabel(messages[index]),
        requestRender: () => chatViewerVirtualList?.render(),
    });
    chatViewerVirtualList = RendererAccessibility.createFixedHeightVirtualList(list, {
        itemCount: () => messages.length,
        rowHeight: CHAT_VIEWER_ROW_HEIGHT,
        overscan: CHAT_VIEWER_OVERSCAN,
        render: (range) => {
            if (!chatViewerRenderGeneration.isCurrent(generation) || !RendererAccessibility.isDialogOpen('chatViewerModal')) return;
            const activeIndex = chatViewerListbox?.synchronizeRange(range) ?? -1;
            rows.style.transform = `translateY(${range.start * CHAT_VIEWER_ROW_HEIGHT}px)`;
            const fragment = document.createDocumentFragment();
            for (let index = range.start; index < range.end; index++) fragment.appendChild(createChatViewerRow(messages[index], index, activeIndex));
            rows.replaceChildren(fragment);
        }
    });
}

function formatChatTimeMarker(m: ChatViewerMessage): string {
    if (chatViewerFormat === 'replay' && typeof m.offset === 'number') {
        const total = Math.max(0, Math.floor(m.offset));
        const h = Math.floor(total / 3600);
        const min = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }
    if (m.t) {
        try {
            const d = new Date(m.t);
            const h = d.getHours().toString().padStart(2, '0');
            const min = d.getMinutes().toString().padStart(2, '0');
            const sec = d.getSeconds().toString().padStart(2, '0');
            return `${h}:${min}:${sec}`;
        } catch { /* ignore */ }
    }
    return '';
}

function closeTopmostOpenModal(): boolean {
    // Try each known modal in priority order
    const cutterDiscardModal = document.getElementById('cutterDiscardModal');
    if (cutterDiscardModal?.classList.contains('show')) {
        resolveCutterDiscard(false);
        return true;
    }

    const commandPaletteModal = document.getElementById('commandPaletteModal');
    if (commandPaletteModal?.classList.contains('show')) {
        const closeCp = (window as unknown as { closeCommandPalette?: () => void }).closeCommandPalette;
        if (typeof closeCp === 'function') {
            closeCp();
            return true;
        }
    }

    const eventsViewerModal = document.getElementById('eventsViewerModal');
    if (eventsViewerModal?.classList.contains('show')) {
        closeEventsViewer();
        return true;
    }

    const chatViewerModal = document.getElementById('chatViewerModal');
    if (chatViewerModal?.classList.contains('show')) {
        closeChatViewer();
        return true;
    }

    const clipModal = document.getElementById('clipModal');
    if (clipModal?.classList.contains('show')) {
        closeClipDialog();
        return true;
    }

    const templateGuideModal = document.getElementById('templateGuideModal');
    if (templateGuideModal?.classList.contains('show')) {
        closeTemplateGuide();
        return true;
    }

    const updateModal = document.getElementById('updateModal');
    if (updateModal?.classList.contains('show')) {
        dismissUpdateModal();
        return true;
    }

    return false;
}

function formatBytesRenderer(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeedRenderer(bytesPerSec: number): string {
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function updateStatusBarQueueSummary(): void {
    const node = document.getElementById('statusBarQueueSummary');
    if (!node) return;
    if (!Array.isArray(queue) || queue.length === 0) {
        node.textContent = '';
        return;
    }

    let downloading = 0;
    let pending = 0;
    for (const item of queue) {
        if (item.status === 'downloading') downloading++;
        else if (item.status === 'pending') pending++;
    }

    if (downloading === 0 && pending === 0) {
        node.textContent = '';
        return;
    }

    node.textContent = UI_TEXT.queue.statusBarSummary
        .replace('{downloading}', String(downloading))
        .replace('{pending}', String(pending));
}

let statsBarPollTimer: number | null = null;

function startStatsBarPolling(): void {
    stopStatsBarPolling();
    if (document.hidden) return;
    statsBarPollTimer = window.setInterval(updateStatsBar, 5000);
}

function stopStatsBarPolling(): void {
    if (statsBarPollTimer !== null) {
        window.clearInterval(statsBarPollTimer);
        statsBarPollTimer = null;
    }
}

async function updateStatsBar(): Promise<void> {
    try {
        const metrics = await window.api.getRuntimeMetrics();
        const bar = byId('statsBar');
        if (!bar) return;
        const totalDL = formatBytesRenderer(metrics.downloadedBytesTotal);
        const avgSpeed = metrics.avgSpeedBytesPerSec > 0 ? formatSpeedRenderer(metrics.avgSpeedBytesPerSec) : '-';
        bar.textContent = `${totalDL} | ${avgSpeed} avg | ${metrics.downloadsCompleted} done | ${metrics.downloadsFailed} failed`;
    } catch { }
}

let toastHideTimer: number | null = null;
let queueSyncTimer: number | null = null;
let appVersion = '';

// Single source of truth for what the user is looking at — keeps the
// visible H1, the document title (which drives the OS task bar / Alt+Tab
// label), and the app version pill in sync. Previously document.title was
// stamped once at boot, so the OS task bar always read "Twitch VOD
// Manager v4.6.76" no matter what tab or streamer was active.
(window as unknown as { setPageTitle: (text: string) => void }).setPageTitle = setPageTitle;

function setPageTitle(text: string): void {
    const titleEl = document.getElementById('pageTitle');
    if (titleEl) titleEl.textContent = text;
    const appName = UI_TEXT.appName;
    const versionSuffix = appVersion ? ` v${appVersion}` : '';
    document.title = text && text !== appName
        ? `${text} - ${appName}${versionSuffix}`
        : `${appName}${versionSuffix}`;
}
let queueSyncInFlight = false;
let lastQueueActivityAt = Date.now();

function markQueueActivity(): void {
    lastQueueActivityAt = Date.now();
}

function hasActiveQueueWork(): boolean {
    return queue.some((item) => item.status === 'pending' || item.status === 'downloading' || item.status === 'paused');
}

function getNextQueueSyncDelayMs(): number {
    if (document.hidden) {
        return QUEUE_SYNC_HIDDEN_MS;
    }

    if (downloading || queue.some((item) => item.status === 'downloading')) {
        return QUEUE_SYNC_FAST_MS;
    }

    if (hasActiveQueueWork()) {
        return QUEUE_SYNC_DEFAULT_MS;
    }

    const idleForMs = Date.now() - lastQueueActivityAt;
    return idleForMs > QUEUE_SYNC_RECENT_ACTIVITY_WINDOW_MS ? QUEUE_SYNC_IDLE_MS : QUEUE_SYNC_DEFAULT_MS;
}

function scheduleQueueSync(delayMs = getNextQueueSyncDelayMs()): void {
    if (queueSyncTimer) {
        clearTimeout(queueSyncTimer);
        queueSyncTimer = null;
    }

    queueSyncTimer = window.setTimeout(() => {
        queueSyncTimer = null;
        void runQueueSyncCycle();
    }, Math.max(300, Math.floor(delayMs)));
}

async function runQueueSyncCycle(): Promise<void> {
    if (queueSyncInFlight) {
        scheduleQueueSync(400);
        return;
    }

    queueSyncInFlight = true;
    try {
        await syncQueueAndDownloadState();
    } catch {
        // ignore transient IPC errors and retry on next cycle
    } finally {
        queueSyncInFlight = false;
        scheduleQueueSync();
    }
}

function showAppToast(message: string, type: 'info' | 'warn' = 'info'): void {
    let toast = document.getElementById('appToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'appToast';
        toast.className = 'app-toast';
        // Live region — screen readers announce the toast text whenever
        // it changes. Warn toasts go through aria-live="assertive" so the
        // reader interrupts whatever it was speaking; info toasts use
        // "polite" so they wait for a natural break in current speech.
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.setAttribute('aria-atomic', 'true');
        document.body.appendChild(toast);
    }

    toast.classList.remove('warn', 'show');
    if (type === 'warn') {
        toast.classList.add('warn');
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
    } else {
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
    }
    // Setting textContent AFTER the aria-live attribute is in place
    // ensures the change is captured as a live-region update by AT.
    toast.textContent = message;

    requestAnimationFrame(() => {
        toast?.classList.add('show');
    });

    if (toastHideTimer) {
        clearTimeout(toastHideTimer);
        toastHideTimer = null;
    }

    toastHideTimer = window.setTimeout(() => {
        toast?.classList.remove('show');
    }, 3200);
}

function mergeQueueState(nextQueue: QueueItem[]): QueueItem[] {
    const prevById = new Map(queue.map((item) => [item.id, item]));

    return nextQueue.map((item) => {
        const prev = prevById.get(item.id);
        if (!prev) {
            return item;
        }

        if (item.status !== 'downloading') {
            return item;
        }

        // Keep the higher progress value to prevent backward jumps from stale data
        const bestProgress = (prev.status === 'downloading' && prev.progress > item.progress)
            ? prev.progress
            : (item.progress > 0 ? item.progress : prev.progress);

        return {
            ...item,
            progress: bestProgress,
            speed: item.speed || prev.speed,
            eta: item.eta || prev.eta,
            currentPart: item.currentPart || prev.currentPart,
            totalParts: item.totalParts || prev.totalParts,
            downloadedBytes: item.downloadedBytes || prev.downloadedBytes,
            totalBytes: item.totalBytes || prev.totalBytes,
            progressStatus: item.progressStatus || prev.progressStatus
        };
    });
}

function getQueueStateFingerprint(items: QueueItem[]): string {
    return items.map((item) => [
        item.id,
        item.status,
        Math.round((Number(item.progress) || 0) * 10),
        item.currentPart || 0,
        item.totalParts || 0,
        item.last_error || '',
        item.progressStatus || ''
    ].join(':')).join('|');
}

function updateDownloadButtonState(): void {
    const btn = byId<HTMLButtonElement>('btnStart');
    const hasPaused = queue.some((item) => item.status === 'paused');
    const hasRunnable = queue.some((item) => item.status === 'pending' || item.status === 'paused');
    btn.textContent = downloading ? UI_TEXT.queue.stop : (hasPaused ? UI_TEXT.queue.resume : UI_TEXT.queue.start);
    btn.classList.toggle('downloading', downloading);
    btn.disabled = !downloading && !hasRunnable;
}

async function syncQueueAndDownloadState(): Promise<void> {
    const previousFingerprint = getQueueStateFingerprint(queue);
    const latestQueue = await window.api.getQueue();
    queue = mergeQueueState(Array.isArray(latestQueue) ? latestQueue : []);
    const nextFingerprint = getQueueStateFingerprint(queue);
    if (nextFingerprint !== previousFingerprint) {
        markQueueActivity();
    }
    renderQueue();

    const backendDownloading = await window.api.isDownloading();
    if (backendDownloading !== downloading) {
        downloading = backendDownloading;
        updateDownloadButtonState();
    }
}

// Must include every nav-item from index.html — otherwise:
//  - Ctrl+N keyboard shortcut won't reach tabs past index 4
//  - persistActiveTab silently no-ops, so the tab won't restore on reboot
// 'stats' (4.6.14) and 'archive' (4.6.15) were added to the nav but the
// const was never updated, leaving them effectively second-class tabs.
const TAB_IDS = ['vods', 'clips', 'cutter', 'merge', 'stats', 'archive', 'settings'] as const;
const ACTIVE_TAB_STORAGE_KEY = 'twitch-vod-manager:active-tab';

function isKnownTab(value: string): value is typeof TAB_IDS[number] {
    return (TAB_IDS as readonly string[]).includes(value);
}

function loadPersistedActiveTab(): string {
    const stored = safeLocalStorageGet(ACTIVE_TAB_STORAGE_KEY);
    if (stored && isKnownTab(stored)) return stored;
    return 'vods';
}

function persistActiveTab(tab: string): void {
    if (!isKnownTab(tab)) return;
    safeLocalStorageSet(ACTIVE_TAB_STORAGE_KEY, tab);
}

function syncWorkspaceLabels(): void {
    document.querySelectorAll<HTMLElement>('[data-label-source]').forEach((node) => {
        const sourceId = node.dataset.labelSource;
        if (!sourceId) return;
        const source = document.getElementById(sourceId);
        if (!source) return;
        const value = source instanceof HTMLSelectElement
            ? source.selectedOptions[0]?.textContent?.trim()
            : source.textContent?.trim();
        if (value) node.textContent = value;
    });

    document.querySelectorAll<HTMLElement>('.top-nav-item').forEach((item) => {
        const label = item.querySelector<HTMLElement>('.top-nav-label')?.textContent?.trim();
        if (label) item.title = label;
    });
}

function syncWorkspaceChrome(tab: string): void {
    syncWorkspaceLabels();

    document.querySelectorAll<HTMLElement>('[data-context-for]').forEach((panel) => {
        panel.hidden = panel.dataset.contextFor !== tab;
    });
    document.querySelectorAll<HTMLElement>('[data-toolbar-for]').forEach((toolbar) => {
        toolbar.hidden = toolbar.dataset.toolbarFor !== tab;
    });
    document.querySelectorAll<HTMLElement>('[data-toolbar-search-for]').forEach((search) => {
        search.hidden = search.dataset.toolbarSearchFor !== tab;
    });

    const navLabel = document.querySelector<HTMLElement>(`.top-nav-item[data-tab="${tab}"] .top-nav-label`)?.textContent?.trim();
    const activeContext = document.querySelector<HTMLElement>(`[data-context-for="${tab}"]`);
    const contextHeading = activeContext?.querySelector<HTMLElement>('[data-context-heading]');
    if (contextHeading && navLabel) contextHeading.textContent = navLabel;
    if (activeContext) syncWorkspaceContextSelection(activeContext);

    const workspace = document.querySelector<HTMLElement>('.workspace-shell');
    if (workspace) workspace.dataset.activeWorkspace = tab;
}

function syncWorkspaceContextSelection(panel: HTMLElement): void {
    const links = Array.from(panel.querySelectorAll<HTMLButtonElement>('.context-list .context-link'));
    const activeLink = links.find((link) => link.classList.contains('active')) || links[0];
    links.forEach((link) => {
        const active = link === activeLink;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });

    const switchers = Array.from(panel.querySelectorAll<HTMLButtonElement>('.context-switcher button'));
    const activeSwitcher = switchers.find((button) => button.classList.contains('active')) || switchers[0];
    switchers.forEach((button) => {
        const active = button === activeSwitcher;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

function setVodsWorkspace(view: 'streamers' | 'queue', source?: HTMLElement): void {
    const panel = document.querySelector<HTMLElement>('[data-context-for="vods"]');
    if (!panel) return;

    panel.dataset.vodsWorkspace = view;
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('.context-switcher button'));
    buttons.forEach((button) => {
        const active = source ? button === source : button.id === `${view === 'queue' ? 'queue' : 'streamer'}WorkspaceSwitch`;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    const switcher = panel.querySelector<HTMLElement>('.context-switcher');
    if (switcher) scheduleSegmentedIndicatorSync(switcher);
}

function applySidebarLayoutPreference(enabled: boolean): void {
    const panel = document.querySelector<HTMLElement>('[data-context-for="vods"]');
    if (!panel) return;

    panel.dataset.vodsLayout = enabled ? 'split' : 'tabs';
    const toggle = document.getElementById('sidebarSplitViewToggle') as HTMLInputElement | null;
    if (toggle) toggle.checked = enabled;
    if (!enabled) {
        setVodsWorkspace(panel.dataset.vodsWorkspace === 'queue' ? 'queue' : 'streamers');
    }
}

function focusWorkspaceTarget(id: string, source?: HTMLElement): void {
    const target = document.getElementById(id) as HTMLElement | null;
    if (!target) return;

    const group = source?.closest<HTMLElement>('.context-list, .context-switcher');
    if (group && source) {
        const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('button'));
        buttons.forEach((button) => {
            const active = button === source;
            button.classList.toggle('active', active);
            if (group.classList.contains('context-list')) {
                if (active) button.setAttribute('aria-current', 'page');
                else button.removeAttribute('aria-current');
            } else {
                button.setAttribute('aria-pressed', String(active));
            }
        });
        if (group.matches('[data-context-for="settings"] .context-list')) {
            scheduleSegmentedIndicatorSync(group);
        }
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const focusTarget = target.matches('button, input, select, textarea, [tabindex]')
        ? target
        : target.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]');

    if (focusTarget) {
        focusTarget.focus({ preventScroll: true });
        return;
    }

    target.tabIndex = -1;
    target.focus({ preventScroll: true });
}

function showTab(tab: string): void {
    if (tab !== 'cutter' && byId('cutterTab').classList.contains('active') && typeof deactivateCutterEditor === 'function') deactivateCutterEditor();
    queryAll('.nav-item').forEach((i) => {
        i.classList.remove('active');
        i.removeAttribute('aria-current');
    });
    queryAll('.tab-content').forEach((c) => c.classList.remove('active'));

    const navItem = query(`.nav-item[data-tab="${tab}"]`);
    if (!navItem) {
        // Unknown tab — fall back to vods so the user is never stuck on an empty screen
        showTab('vods');
        return;
    }
    navItem.classList.add('active');
    navItem.setAttribute('aria-current', 'page');
    syncTopNavActiveIndicator();
    byId(tab + 'Tab').classList.add('active');
    if (tab === 'cutter' && typeof activateCutterEditor === 'function') activateCutterEditor();
    syncWorkspaceChrome(tab);
    scheduleSegmentedIndicatorsSync();

    const titles: Record<string, string> = UI_TEXT.tabs;

    // Only show the streamer name on the VODs tab — otherwise the title would
    // mismatch the tab content (e.g. "streamer X" while on Settings)
    const pageTitleText = (tab === 'vods' && currentStreamer)
        ? currentStreamer
        : (titles[tab] || UI_TEXT.appName);
    setPageTitle(pageTitleText);

    persistActiveTab(tab);

    if (tab === 'stats') {
        const fn = (window as unknown as { refreshArchiveStats?: () => Promise<void> }).refreshArchiveStats;
        if (typeof fn === 'function') void fn();
    }
    if (tab === 'archive') {
        const init = (window as unknown as { initArchiveSearchInput?: () => void }).initArchiveSearchInput;
        const search = (window as unknown as { performArchiveSearch?: () => Promise<void> }).performArchiveSearch;
        if (typeof init === 'function') init();
        if (typeof search === 'function') void search();
    }
}

function parseDurationToSeconds(durStr: string): number {
    let seconds = 0;
    const hours = durStr.match(/(\d+)h/);
    const minutes = durStr.match(/(\d+)m/);
    const secs = durStr.match(/(\d+)s/);

    if (hours) seconds += parseInt(hours[1], 10) * 3600;
    if (minutes) seconds += parseInt(minutes[1], 10) * 60;
    if (secs) seconds += parseInt(secs[1], 10);

    return seconds;
}

function formatSecondsToTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatSecondsToTimeDashed(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}-${m.toString().padStart(2, '0')}-${s.toString().padStart(2, '0')}`;
}

const DEFAULT_VOD_TEMPLATE = '{title}.mp4';
const DEFAULT_PARTS_TEMPLATE = '{date}_Part{part_padded}.mp4';
const DEFAULT_CLIP_TEMPLATE = '{date}_{part}.mp4';

type TemplateGuideSource = 'vod' | 'parts' | 'clip';

let templateGuideSource: TemplateGuideSource = 'vod';

function formatDateWithPattern(date: Date, pattern: string): string {
    const tokenMap: Record<string, string> = {
        yyyy: date.getFullYear().toString(),
        yy: date.getFullYear().toString().slice(-2),
        MM: (date.getMonth() + 1).toString().padStart(2, '0'),
        M: (date.getMonth() + 1).toString(),
        dd: date.getDate().toString().padStart(2, '0'),
        d: date.getDate().toString(),
        HH: date.getHours().toString().padStart(2, '0'),
        H: date.getHours().toString(),
        hh: date.getHours().toString().padStart(2, '0'),
        h: date.getHours().toString(),
        mm: date.getMinutes().toString().padStart(2, '0'),
        m: date.getMinutes().toString(),
        ss: date.getSeconds().toString().padStart(2, '0'),
        s: date.getSeconds().toString()
    };

    return pattern
        .replace(/yyyy|yy|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s/g, (token) => tokenMap[token] ?? token)
        .replace(/\\(.)/g, '$1');
}

function formatSecondsWithPattern(totalSeconds: number, pattern: string): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    const tokenMap: Record<string, string> = {
        HH: hours.toString().padStart(2, '0'),
        H: hours.toString(),
        hh: hours.toString().padStart(2, '0'),
        h: hours.toString(),
        mm: minutes.toString().padStart(2, '0'),
        m: minutes.toString(),
        ss: seconds.toString().padStart(2, '0'),
        s: seconds.toString()
    };

    return pattern
        .replace(/HH|H|hh|h|mm|m|ss|s/g, (token) => tokenMap[token] ?? token)
        .replace(/\\(.)/g, '$1');
}

function getSelectedFilenameFormat(): 'simple' | 'timestamp' | 'template' | 'parts' {
    const selected = query<HTMLInputElement>('input[name="filenameFormat"]:checked').value;
    if (selected === 'template') return 'template';
    if (selected === 'timestamp') return 'timestamp';
    if (selected === 'parts') return 'parts';
    return 'simple';
}

function updateFilenameTemplateVisibility(): void {
    const selected = getSelectedFilenameFormat();
    const wrap = byId('clipFilenameTemplateWrap');
    wrap.classList.toggle('shown', selected === 'template');
}

interface TemplatePreviewContext {
    title: string;
    date: Date;
    streamer: string;
    partNum: string;
    startSec: number;
    durationSec: number;
    totalSec: number;
}

function buildTemplatePreview(template: string, context: TemplatePreviewContext): string {
    const dateStr = `${context.date.getDate().toString().padStart(2, '0')}.${(context.date.getMonth() + 1).toString().padStart(2, '0')}.${context.date.getFullYear()}`;
    const normalizedPart = context.partNum || '1';
    let output = template
        .replace(/\{title\}/g, context.title || 'Untitled')
        .replace(/\{id\}/g, '123456789')
        .replace(/\{channel\}/g, context.streamer || 'streamer')
        .replace(/\{channel_id\}/g, '0')
        .replace(/\{date\}/g, dateStr)
        .replace(/\{part\}/g, normalizedPart)
        .replace(/\{part_padded\}/g, normalizedPart.padStart(2, '0'))
        .replace(/\{trim_start\}/g, formatSecondsToTimeDashed(context.startSec))
        .replace(/\{trim_end\}/g, formatSecondsToTimeDashed(context.startSec + context.durationSec))
        .replace(/\{trim_length\}/g, formatSecondsToTimeDashed(context.durationSec))
        .replace(/\{length\}/g, formatSecondsToTimeDashed(context.totalSec))
        .replace(/\{ext\}/g, 'mp4')
        .replace(/\{random_string\}/g, 'abcd1234');

    output = output.replace(/\{date_custom="(.*?)"\}/g, (_, pattern: string) => formatDateWithPattern(context.date, pattern));
    output = output.replace(/\{trim_start_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.startSec, pattern));
    output = output.replace(/\{trim_end_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.startSec + context.durationSec, pattern));
    output = output.replace(/\{trim_length_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.durationSec, pattern));
    output = output.replace(/\{length_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.totalSec, pattern));

    return output;
}

function getTemplateForSource(source: TemplateGuideSource): string {
    if (source === 'vod') {
        return ((config.filename_template_vod as string) || DEFAULT_VOD_TEMPLATE).trim() || DEFAULT_VOD_TEMPLATE;
    }

    if (source === 'parts') {
        return ((config.filename_template_parts as string) || DEFAULT_PARTS_TEMPLATE).trim() || DEFAULT_PARTS_TEMPLATE;
    }

    const clipField = document.getElementById('clipFilenameTemplate') as HTMLInputElement | null;
    const clipFromDialog = clipField?.value.trim() || '';
    if (clipFromDialog) {
        return clipFromDialog;
    }

    return ((config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE).trim() || DEFAULT_CLIP_TEMPLATE;
}

function getTemplateGuidePreviewContext(source: TemplateGuideSource): { context: TemplatePreviewContext; contextText: string } {
    const now = new Date();
    const sampleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 15, 8);
    const sampleStreamer = currentStreamer || 'sample_streamer';

    if (source === 'clip' && clipDialogData) {
        const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
        const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
        const clipDuration = Math.max(1, endSec - startSec);
        const totalSec = Math.max(1, clipTotalSeconds || parseDurationToSeconds(clipDialogData.duration));

        return {
            context: {
                title: clipDialogData.title || 'Clip Title',
                date: new Date(clipDialogData.date),
                streamer: clipDialogData.streamer || sampleStreamer,
                partNum: byId<HTMLInputElement>('clipStartPart').value.trim() || '1',
                startSec,
                durationSec: clipDuration,
                totalSec
            },
            contextText: UI_TEXT.static.templateGuideContextClipLive
        };
    }

    if (source === 'parts') {
        const partLen = Math.max(60, Number(config.part_minutes ?? 120) * 60);
        return {
            context: {
                title: 'Epic Ranked Session',
                date: sampleDate,
                streamer: sampleStreamer,
                partNum: '3',
                startSec: partLen * 2,
                durationSec: partLen,
                totalSec: partLen * 5
            },
            contextText: UI_TEXT.static.templateGuideContextParts
        };
    }

    if (source === 'clip') {
        return {
            context: {
                title: 'Funny Clip Moment',
                date: sampleDate,
                streamer: sampleStreamer,
                partNum: '1',
                startSec: 95,
                durationSec: 45,
                totalSec: 5400
            },
            contextText: UI_TEXT.static.templateGuideContextClip
        };
    }

    return {
        context: {
            title: 'Epic Ranked Session',
            date: sampleDate,
            streamer: sampleStreamer,
            partNum: '1',
            startSec: 0,
            durationSec: 3 * 3600 + 12 * 60 + 5,
            totalSec: 3 * 3600 + 12 * 60 + 5
        },
        contextText: UI_TEXT.static.templateGuideContextVod
    };
}

interface TemplateVariableDoc {
    placeholder: string;
    description: string;
    exampleTemplate: string;
}

function getTemplateVariableDocs(): TemplateVariableDoc[] {
    const de = currentLanguage !== 'en';
    const text = (deText: string, enText: string) => de ? deText : enText;

    return [
        { placeholder: '{title}', description: text('Titel des VODs/Clips', 'Title of the VOD/clip'), exampleTemplate: '{title}' },
        { placeholder: '{id}', description: text('VOD-ID', 'VOD id'), exampleTemplate: '{id}' },
        { placeholder: '{channel}', description: text('Kanalname', 'Channel name'), exampleTemplate: '{channel}' },
        { placeholder: '{date}', description: text('Datum (DD.MM.YYYY)', 'Date (DD.MM.YYYY)'), exampleTemplate: '{date}' },
        { placeholder: '{part}', description: text('Teilnummer', 'Part number'), exampleTemplate: '{part}' },
        { placeholder: '{part_padded}', description: text('Teilnummer mit 2 Stellen', 'Part number padded to 2 digits'), exampleTemplate: '{part_padded}' },
        { placeholder: '{trim_start}', description: text('Startzeit des Ausschnitts', 'Trim start time'), exampleTemplate: '{trim_start}' },
        { placeholder: '{trim_end}', description: text('Endzeit des Ausschnitts', 'Trim end time'), exampleTemplate: '{trim_end}' },
        { placeholder: '{trim_length}', description: text('Lange des Ausschnitts', 'Trimmed duration'), exampleTemplate: '{trim_length}' },
        { placeholder: '{length}', description: text('Gesamtdauer', 'Total duration'), exampleTemplate: '{length}' },
        { placeholder: '{ext}', description: text('Dateiendung', 'File extension'), exampleTemplate: '{ext}' },
        { placeholder: '{random_string}', description: text('Zufallsstring (8 Zeichen)', 'Random string (8 chars)'), exampleTemplate: '{random_string}' },
        { placeholder: '{date_custom="yyyy-MM-dd"}', description: text('Datum mit eigenem Format', 'Custom-formatted date'), exampleTemplate: '{date_custom="yyyy-MM-dd"}' },
        { placeholder: '{trim_start_custom="HH-mm-ss"}', description: text('Startzeit mit eigenem Format', 'Custom-formatted trim start'), exampleTemplate: '{trim_start_custom="HH-mm-ss"}' },
        { placeholder: '{trim_end_custom="HH-mm-ss"}', description: text('Endzeit mit eigenem Format', 'Custom-formatted trim end'), exampleTemplate: '{trim_end_custom="HH-mm-ss"}' },
        { placeholder: '{trim_length_custom="HH-mm-ss"}', description: text('Trim-Dauer mit eigenem Format', 'Custom-formatted trim length'), exampleTemplate: '{trim_length_custom="HH-mm-ss"}' },
        { placeholder: '{length_custom="HH-mm-ss"}', description: text('Gesamtdauer mit eigenem Format', 'Custom-formatted total duration'), exampleTemplate: '{length_custom="HH-mm-ss"}' }
    ];
}

function renderTemplateGuideTable(context: TemplatePreviewContext): void {
    const body = byId('templateGuideBody');
    body.innerHTML = '';

    for (const item of getTemplateVariableDocs()) {
        const row = document.createElement('tr');
        const varCell = document.createElement('td');
        const descCell = document.createElement('td');
        const exampleCell = document.createElement('td');

        varCell.textContent = item.placeholder;
        descCell.textContent = item.description;
        exampleCell.textContent = buildTemplatePreview(item.exampleTemplate, context);

        row.append(varCell, descCell, exampleCell);
        body.appendChild(row);
    }
}

function updateTemplateGuidePresetButtons(): void {
    const activeId: Record<TemplateGuideSource, string> = {
        vod: 'templateGuideUseVod',
        parts: 'templateGuideUseParts',
        clip: 'templateGuideUseClip'
    };

    (Object.keys(activeId) as TemplateGuideSource[]).forEach((key) => {
        const btn = byId<HTMLButtonElement>(activeId[key]);
        btn.classList.toggle('active', key === templateGuideSource);
    });
}

function refreshTemplateGuideTexts(): void {
    setText('settingsTemplateGuideBtn', UI_TEXT.static.templateGuideButton);
    setText('clipTemplateGuideBtn', UI_TEXT.static.templateGuideButton);
    setText('templateGuideTitle', UI_TEXT.static.templateGuideTitle);
    setText('templateGuideIntro', UI_TEXT.static.templateGuideIntro);
    setText('templateGuideTemplateLabel', UI_TEXT.static.templateGuideTemplateLabel);
    setText('templateGuideOutputLabel', UI_TEXT.static.templateGuideOutputLabel);
    setText('templateGuideVarsTitle', UI_TEXT.static.templateGuideVarsTitle);
    setText('templateGuideVarCol', UI_TEXT.static.templateGuideVarCol);
    setText('templateGuideDescCol', UI_TEXT.static.templateGuideDescCol);
    setText('templateGuideExampleCol', UI_TEXT.static.templateGuideExampleCol);
    setText('templateGuideUseVod', UI_TEXT.static.templateGuideUseVod);
    setText('templateGuideUseParts', UI_TEXT.static.templateGuideUseParts);
    setText('templateGuideUseClip', UI_TEXT.static.templateGuideUseClip);
    setText('templateGuideCloseBtn', UI_TEXT.static.templateGuideClose);
    setPlaceholder('templateGuideInput', getTemplateForSource(templateGuideSource));
    updateTemplateGuidePresetButtons();

    const modal = document.getElementById('templateGuideModal');
    if (modal?.classList.contains('show')) {
        updateTemplateGuidePreview();
    }
}

function openTemplateGuide(source: TemplateGuideSource = 'vod'): void {
    templateGuideSource = source;
    RendererAccessibility.openDialog('templateGuideModal', { onEscape: closeTemplateGuide });
    refreshTemplateGuideTexts();
    setTemplateGuidePreset(source);
}

function closeTemplateGuide(): void {
    RendererAccessibility.closeDialog('templateGuideModal');
}

function setTemplateGuidePreset(source: TemplateGuideSource): void {
    templateGuideSource = source;
    const template = getTemplateForSource(source);
    byId<HTMLInputElement>('templateGuideInput').value = template;
    setPlaceholder('templateGuideInput', template);
    updateTemplateGuidePresetButtons();
    updateTemplateGuidePreview();
}

function updateTemplateGuidePreview(): void {
    const input = byId<HTMLInputElement>('templateGuideInput');
    const template = input.value.trim() || getTemplateForSource(templateGuideSource);
    const { context, contextText } = getTemplateGuidePreviewContext(templateGuideSource);

    byId('templateGuideOutput').textContent = buildTemplatePreview(template, context);
    byId('templateGuideContext').textContent = contextText;
    renderTemplateGuideTable(context);
}

function parseTimeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':').map((p: string) => parseInt(p, 10) || 0);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return 0;
}

function openClipDialog(url: string, title: string, date: string, streamer: string, duration: string): void {
    clipDialogData = { url, title, date, streamer, duration };
    clipTotalSeconds = parseDurationToSeconds(duration);

    byId('clipDialogTitle').textContent = `${UI_TEXT.clips.dialogTitle} (${duration})`;
    byId<HTMLInputElement>('clipStartSlider').max = String(clipTotalSeconds);
    byId<HTMLInputElement>('clipEndSlider').max = String(clipTotalSeconds);
    byId<HTMLInputElement>('clipStartSlider').value = '0';
    byId<HTMLInputElement>('clipEndSlider').value = String(Math.min(60, clipTotalSeconds));

    byId<HTMLInputElement>('clipStartTime').value = '00:00:00';
    byId<HTMLInputElement>('clipEndTime').value = formatSecondsToTime(Math.min(60, clipTotalSeconds));
    byId<HTMLInputElement>('clipStartPart').value = '';
    byId<HTMLInputElement>('clipFilenameTemplate').value = (config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE;
    query<HTMLInputElement>('input[name="filenameFormat"][value="simple"]').checked = true;
    updateFilenameTemplateVisibility();

    updateClipDuration();
    updateFilenameExamples();
    RendererAccessibility.openDialog('clipModal', { onEscape: closeClipDialog });
}

function closeClipDialog(): void {
    RendererAccessibility.closeDialog('clipModal');
    clipDialogData = null;
}

function updateFromSlider(which: string): void {
    const startSlider = byId<HTMLInputElement>('clipStartSlider');
    const endSlider = byId<HTMLInputElement>('clipEndSlider');

    if (which === 'start') {
        byId<HTMLInputElement>('clipStartTime').value = formatSecondsToTime(parseInt(startSlider.value, 10));
    } else {
        byId<HTMLInputElement>('clipEndTime').value = formatSecondsToTime(parseInt(endSlider.value, 10));
    }

    updateClipDuration();
}

function updateFromInput(which: string): void {
    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);

    if (which === 'start') {
        byId<HTMLInputElement>('clipStartSlider').value = String(Math.max(0, Math.min(startSec, clipTotalSeconds)));
    } else {
        byId<HTMLInputElement>('clipEndSlider').value = String(Math.max(0, Math.min(endSec, clipTotalSeconds)));
    }

    updateClipDuration();
}

function updateClipDuration(): void {
    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const duration = endSec - startSec;
    const durationDisplay = byId('clipDurationDisplay');

    const isValid = duration > 0;
    durationDisplay.classList.toggle('invalid', !isValid);
    durationDisplay.textContent = isValid
        ? formatSecondsToTime(duration)
        : UI_TEXT.clips.invalidDuration;

    updateFilenameExamples();
}

function updateFilenameExamples(): void {
    if (!clipDialogData) {
        return;
    }

    const date = new Date(clipDialogData.date);
    const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
    const partNum = byId<HTMLInputElement>('clipStartPart').value || '1';
    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const durationSec = Math.max(1, endSec - startSec);
    const timeStr = formatSecondsToTimeDashed(startSec);
    const template = byId<HTMLInputElement>('clipFilenameTemplate').value.trim() || (config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE;
    const unknownTokens = collectUnknownTemplatePlaceholders(template);
    const clipLint = byId('clipTemplateLint');

    updateFilenameTemplateVisibility();

    if (!unknownTokens.length) {
        clipLint.className = 'template-lint ok';
        clipLint.textContent = UI_TEXT.static.templateLintOk;
    } else {
        clipLint.className = 'template-lint warn';
        clipLint.textContent = `${UI_TEXT.static.templateLintWarn}: ${unknownTokens.join(' ')}`;
    }

    byId('formatSimple').textContent = `${dateStr}_${partNum}.mp4 ${UI_TEXT.clips.formatSimple}`;
    byId('formatTimestamp').textContent = `${dateStr}_CLIP_${timeStr}_${partNum}.mp4 ${UI_TEXT.clips.formatTimestamp}`;
    byId('formatParts').textContent = `${dateStr}_Part${partNum.padStart(2, '0')}.mp4 ${UI_TEXT.clips.formatParts}`;
    byId('formatTemplate').textContent = `${buildTemplatePreview(template, {
        title: clipDialogData.title,
        date,
        streamer: clipDialogData.streamer,
        partNum,
        startSec,
        durationSec,
        totalSec: clipTotalSeconds
    })} ${UI_TEXT.clips.formatTemplate}`;

    const guideModal = document.getElementById('templateGuideModal');
    if (guideModal?.classList.contains('show') && templateGuideSource === 'clip') {
        updateTemplateGuidePreview();
    }
}

async function confirmClipDialog(): Promise<void> {
    if (!clipDialogData) {
        return;
    }

    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const durationSec = endSec - startSec;
    const startPartStr = byId<HTMLInputElement>('clipStartPart').value.trim();
    const startPart = startPartStr ? parseInt(startPartStr, 10) : 1;
    const filenameFormat = getSelectedFilenameFormat();
    const filenameTemplate = byId<HTMLInputElement>('clipFilenameTemplate').value.trim();

    if (isNaN(startSec) || isNaN(endSec) || isNaN(durationSec)) {
        alert(UI_TEXT.clips.invalidTime);
        return;
    }

    if (startSec < 0) {
        alert(UI_TEXT.clips.outOfRange);
        return;
    }

    if (durationSec <= 0) {
        alert(UI_TEXT.clips.endBeforeStart);
        return;
    }

    if (endSec > clipTotalSeconds) {
        alert(UI_TEXT.clips.outOfRange);
        return;
    }

    if (filenameFormat === 'template' && !filenameTemplate) {
        alert(UI_TEXT.clips.templateEmpty);
        return;
    }

    if (filenameFormat === 'template') {
        const unknownTokens = collectUnknownTemplatePlaceholders(filenameTemplate);
        if (unknownTokens.length > 0) {
            alert(`${UI_TEXT.static.templateLintWarn}: ${unknownTokens.join(' ')}`);
            return;
        }
    }

    const customClip: CustomClip = {
        startSec,
        durationSec,
        startPart,
        filenameFormat,
        filenameTemplate: filenameFormat === 'template' ? filenameTemplate : undefined
    };

    if ((config.prevent_duplicate_downloads as boolean) !== false && hasActiveQueueDuplicate(
        clipDialogData.url,
        clipDialogData.streamer,
        clipDialogData.date,
        customClip
    )) {
        alert(UI_TEXT.queue.duplicateSkipped);
        return;
    }

    queue = await window.api.addToQueue({
        url: clipDialogData.url,
        title: clipDialogData.title,
        date: clipDialogData.date,
        streamer: clipDialogData.streamer,
        duration_str: clipDialogData.duration,
        customClip
    });

    renderQueue();
    closeClipDialog();
}

let clipDownloadInFlight = false;

async function downloadClip(): Promise<void> {
    if (clipDownloadInFlight) return;

    const url = byId<HTMLInputElement>('clipUrl').value.trim();
    const status = byId('clipStatus');
    const btn = byId<HTMLButtonElement>('btnClip');
    const toolbarBtn = byId<HTMLButtonElement>('toolbarClipDownloadBtn');

    if (!url) {
        status.textContent = UI_TEXT.clips.enterUrl;
        status.className = 'clip-status error';
        return;
    }

    clipDownloadInFlight = true;
    btn.disabled = true;
    toolbarBtn.disabled = true;
    btn.textContent = UI_TEXT.clips.loadingButton;
    status.textContent = UI_TEXT.clips.loadingStatus;
    status.className = 'clip-status loading';

    try {
        const result = await window.api.downloadClip(url);
        if (result.success) {
            status.textContent = UI_TEXT.clips.success;
            status.className = 'clip-status success';
            return;
        }

        const backendError = (result.error || '').trim();
        status.textContent = UI_TEXT.clips.errorPrefix + (backendError || UI_TEXT.clips.unknownError);
        status.className = 'clip-status error';
    } catch {
        status.textContent = UI_TEXT.clips.errorPrefix + UI_TEXT.clips.unknownError;
        status.className = 'clip-status error';
    } finally {
        clipDownloadInFlight = false;
        btn.disabled = false;
        toolbarBtn.disabled = false;
        btn.textContent = UI_TEXT.clips.downloadButton;
    }
}

let topNavIndicatorFrame: number | null = null;

function syncTopNavActiveIndicator(): void {
    const topNav = document.querySelector<HTMLElement>('.top-nav');
    const activeItem = topNav?.querySelector<HTMLElement>('.top-nav-item.active');
    if (!topNav || !activeItem) return;
    const navRect = topNav.getBoundingClientRect();
    const itemRect = activeItem.getBoundingClientRect();
    topNav.style.setProperty('--top-nav-active-x', `${itemRect.left - navRect.left}px`);
    topNav.style.setProperty('--top-nav-active-y', `${itemRect.top - navRect.top}px`);
    topNav.style.setProperty('--top-nav-active-width', `${itemRect.width}px`);
    topNav.style.setProperty('--top-nav-active-height', `${itemRect.height}px`);
}

function scheduleTopNavActiveIndicatorSync(): void {
    if (topNavIndicatorFrame !== null) return;
    topNavIndicatorFrame = requestAnimationFrame(() => {
        topNavIndicatorFrame = null;
        syncTopNavActiveIndicator();
    });
}

function initTopNavActiveIndicator(): void {
    const topNav = document.querySelector<HTMLElement>('.top-nav');
    if (!topNav) return;
    const observer = new ResizeObserver(scheduleTopNavActiveIndicatorSync);
    observer.observe(topNav);
    topNav.querySelectorAll<HTMLElement>('.top-nav-item').forEach((item) => observer.observe(item));
    window.addEventListener('resize', scheduleTopNavActiveIndicatorSync);
}

const segmentedIndicatorFrames = new WeakMap<HTMLElement, number>();

function syncSegmentedIndicator(control: HTMLElement): void {
    const activeButton = control.querySelector<HTMLElement>('button.active');
    if (!activeButton) {
        control.classList.remove('segmented-indicator-visible');
        return;
    }
    control.style.setProperty('--segment-active-x', `${activeButton.offsetLeft}px`);
    control.style.setProperty('--segment-active-y', `${activeButton.offsetTop}px`);
    control.style.setProperty('--segment-active-width', `${activeButton.offsetWidth}px`);
    control.style.setProperty('--segment-active-height', `${activeButton.offsetHeight}px`);
    control.classList.add('segmented-indicator-visible');
    requestAnimationFrame(() => control.classList.add('segmented-indicator-ready'));
}

function scheduleSegmentedIndicatorSync(control: HTMLElement): void {
    if (segmentedIndicatorFrames.has(control)) return;
    const frame = requestAnimationFrame(() => {
        segmentedIndicatorFrames.delete(control);
        syncSegmentedIndicator(control);
    });
    segmentedIndicatorFrames.set(control, frame);
}

function scheduleSegmentedIndicatorsSync(): void {
    document.querySelectorAll<HTMLElement>('.context-switcher, .language-picker, [data-context-for="settings"] .context-list').forEach(scheduleSegmentedIndicatorSync);
}

function initSegmentedIndicators(): void {
    const observer = new ResizeObserver((entries) => {
        entries.forEach((entry) => {
            const control = entry.target.closest<HTMLElement>('.context-switcher, .language-picker, [data-context-for="settings"] .context-list');
            if (control) scheduleSegmentedIndicatorSync(control);
        });
    });
    document.querySelectorAll<HTMLElement>('.context-switcher, .language-picker, [data-context-for="settings"] .context-list').forEach((control) => {
        observer.observe(control);
        control.querySelectorAll<HTMLElement>('button').forEach((button) => observer.observe(button));
        syncSegmentedIndicator(control);
    });
    window.addEventListener('resize', scheduleSegmentedIndicatorsSync);
}

async function addMergeFiles(): Promise<void> {
    const files = await window.api.selectMultipleVideos();
    if (!files || files.length === 0) {
        return;
    }

    mergeFiles = [...mergeFiles, ...files];
    renderMergeFiles();
}

function renderMergeFiles(): void {
    const list = byId('mergeFileList');
    byId('btnMerge').disabled = mergeFiles.length < 2;

    if (mergeFiles.length === 0) {
        // Build via DOM API to keep the renderer clean of inline-styled
        // HTML strings. The empty-state SVG is the same plus-icon the
        // static HTML uses, just built programmatically.
        list.replaceChildren();
        const wrap = document.createElement('div');
        wrap.className = 'empty-state merge-empty-state';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'currentColor');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
        svg.appendChild(path);
        wrap.appendChild(svg);
        const p = document.createElement('p');
        p.textContent = UI_TEXT.merge.empty;
        wrap.appendChild(p);
        list.appendChild(wrap);
        return;
    }

    list.innerHTML = mergeFiles.map((file: FileCapabilityReference, index: number) => {
        const name = file.name;
        return `
            <div class="file-item" draggable="true" data-index="${index}">
                <div class="file-order">${index + 1}</div>
                <div class="file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="file-actions">
                    <button type="button" class="file-btn" aria-label="${escapeHtml(UI_TEXT.merge.moveUpAria)}" title="${escapeHtml(UI_TEXT.merge.moveUpAria)}" onclick="moveMergeFile(${index}, -1)" ${index === 0 ? 'disabled' : ''}>&#9650;</button>
                    <button type="button" class="file-btn" aria-label="${escapeHtml(UI_TEXT.merge.moveDownAria)}" title="${escapeHtml(UI_TEXT.merge.moveDownAria)}" onclick="moveMergeFile(${index}, 1)" ${index === mergeFiles.length - 1 ? 'disabled' : ''}>&#9660;</button>
                    <button type="button" class="file-btn remove" aria-label="${escapeHtml(UI_TEXT.merge.removeAria)}" title="${escapeHtml(UI_TEXT.merge.removeAria)}" onclick="removeMergeFile(${index})">x</button>
                </div>
            </div>
        `;
    }).join('');
}

function moveMergeFile(index: number, direction: number): void {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= mergeFiles.length) {
        return;
    }

    const temp = mergeFiles[index];
    mergeFiles[index] = mergeFiles[newIndex];
    mergeFiles[newIndex] = temp;
    renderMergeFiles();
}

function removeMergeFile(index: number): void {
    mergeFiles.splice(index, 1);
    renderMergeFiles();
}

async function startMerging(): Promise<void> {
    if (mergeFiles.length < 2 || isMerging) {
        return;
    }

    const output = await window.api.saveVideoDialog('merged_video.mp4');
    if (!output) {
        return;
    }

    isMerging = true;
    byId('btnMerge').disabled = true;
    byId('btnMerge').textContent = UI_TEXT.merge.merging;
    byId('mergeProgress').classList.add('show');

    const result = await window.api.mergeVideos(mergeFiles.map((file) => file.token), output.token);

    isMerging = false;
    byId('btnMerge').disabled = false;
    byId('btnMerge').textContent = UI_TEXT.merge.merge;
    byId('mergeProgress').classList.remove('show');

    if (result.success) {
        alert(`${UI_TEXT.merge.success}\n\n${result.outputName || output.name}`);
        mergeFiles = [];
        renderMergeFiles();
        return;
    }

    alert(UI_TEXT.merge.failed);
}

void init().then(() => window.api.rendererReady());
