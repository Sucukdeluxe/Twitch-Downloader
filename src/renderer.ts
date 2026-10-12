const QUEUE_SYNC_FAST_MS = 900;
const QUEUE_SYNC_DEFAULT_MS = 1800;
const QUEUE_SYNC_IDLE_MS = 4500;
const QUEUE_SYNC_HIDDEN_MS = 9000;
const QUEUE_SYNC_RECENT_ACTIVITY_WINDOW_MS = 15000;

async function init(): Promise<void> {
    performance.mark('tvm:init-start');
    const [loadedConfig, loadedSecretStatus, initialQueue, isDown, version] = await Promise.all([
        window.api.getConfig(),
        window.api.getSecretStatus(),
        window.api.getQueue(),
        window.api.isDownloading(),
        window.api.getVersion()
    ]);
    performance.mark('tvm:config-ready');
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
    setPageTitle(UI_TEXT.appName);

    byId<HTMLInputElement>('clientId').value = config.client_id ?? '';
    byId<HTMLInputElement>('clientSecret').value = secretStatus.clientSecretConfigured ? SECRET_INPUT_MASK : '';
    byId<HTMLInputElement>('downloadPath').value = config.download_path ?? '';
    byId<HTMLSelectElement>('themeSelect').value = config.theme ?? 'twitch';
    byId<HTMLSelectElement>('languageSelect').value = config.language ?? 'en';
    updateLanguagePicker(config.language ?? 'en');
    setSettingsPane(byId<HTMLElement>('settingsTab').dataset.settingsPane || 'general');
    byId<HTMLSelectElement>('downloadMode').value = config.download_mode ?? 'full';
    byId<HTMLInputElement>('partMinutes').value = String(config.part_minutes ?? 120);
    byId<HTMLSelectElement>('performanceMode').value = (config.performance_mode as string) || 'balanced';
    byId<HTMLInputElement>('duplicatePreventionToggle').checked = (config.prevent_duplicate_downloads as boolean) !== false;
    byId<HTMLInputElement>('metadataCacheMinutes').value = String((config.metadata_cache_minutes as number) || 10);
    byId<HTMLInputElement>('vodFilenameTemplate').value = (config.filename_template_vod as string) || DEFAULT_VOD_TEMPLATE;
    byId<HTMLInputElement>('partsFilenameTemplate').value = (config.filename_template_parts as string) || DEFAULT_PARTS_TEMPLATE;
    byId<HTMLInputElement>('defaultClipFilenameTemplate').value = (config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE;
    initSettingsAutoSave();
    initializeCleanupPreview();

    applyRendererTheme(config.theme ?? 'twitch');
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
    initializeEditingWorkflows();
    initializeVodLibrary();
    const workspaceRestored = restoreWorkspace();

    // Restore last active tab from previous session (default 'vods')
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
    performance.mark('tvm:ui-ready');
    window.api.notifyRendererReady?.();
    setTimeout(() => { void startRendererServices(workspaceRestored).catch(error => console.error('startup-services-failed', error)); }, 0);
}

async function startRendererServices(workspaceRestored: Promise<void> = Promise.resolve()): Promise<void> {
    if (config.client_id && secretStatus.clientSecretConfigured) {
        await connect();
    } else {
        updateStatus(UI_TEXT.status.noLogin, false);
    }

    if (config.streamers && config.streamers.length > 0) {
        const preloader = (window as unknown as { preloadConfiguredStreamerData?: (streamers: string[]) => Promise<void> }).preloadConfiguredStreamerData;
        if (typeof preloader === 'function') void preloader(config.streamers as string[]);
        const remembered = readDevelopmentView()?.streamer;
        await selectStreamer(remembered && config.streamers.includes(remembered) ? remembered : config.streamers[0]);
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

    await workspaceRestored;
    restoreDevelopmentView();
    performance.mark('tvm:services-ready');
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
    return formatBytes(bytes);
}

function formatSpeedRenderer(bytesPerSec: number): string {
    return formatBytes(bytesPerSec) + '/s';
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
    const isDevelopment = new URLSearchParams(location.search).get('development') === '1';
    const developmentLabel = currentLanguage === 'en' ? 'Development version' : 'Entwickler-Version';
    const badge = document.getElementById('developmentBadge');
    if (badge) {
        badge.hidden = !isDevelopment;
        badge.textContent = developmentLabel;
    }
    const appName = UI_TEXT.appName + (isDevelopment ? ' · ' + developmentLabel : '');
    const versionSuffix = appVersion ? ` v${appVersion}` : '';
    document.title = text && text !== UI_TEXT.appName
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
            speed: item.speed === undefined ? prev.speed : item.speed,
            eta: item.eta === undefined ? prev.eta : item.eta,
            currentPart: item.currentPart === undefined ? prev.currentPart : item.currentPart,
            totalParts: item.totalParts === undefined ? prev.totalParts : item.totalParts,
            downloadedBytes: item.downloadedBytes === undefined ? prev.downloadedBytes : item.downloadedBytes,
            totalBytes: item.totalBytes === undefined ? prev.totalBytes : item.totalBytes,
            progressStatus: item.progressStatus === undefined ? prev.progressStatus : item.progressStatus,
            recordingHealth: item.recordingHealth === undefined ? prev.recordingHealth : item.recordingHealth
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
    byId(tab + 'Tab').classList.add('active');
    if (tab === 'cutter' && typeof activateCutterEditor === 'function') activateCutterEditor();
    syncWorkspaceChrome(tab);
    scheduleSegmentedIndicatorsSync();

    const titles: Record<string, string> = UI_TEXT.tabs;

    // Only show the streamer name on the VODs tab — otherwise the title would
    // mismatch the tab content (e.g. "streamer X" while on Settings)
    const pageTitleText = (tab === 'vods' && currentStreamer)
        ? getStreamerDisplayName(currentStreamer)
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
    endSec?: number;
    vodId?: string;
}

function buildTemplatePreview(template: string, context: TemplatePreviewContext): string {
    const dateStr = `${context.date.getDate().toString().padStart(2, '0')}.${(context.date.getMonth() + 1).toString().padStart(2, '0')}.${context.date.getFullYear()}`;
    const normalizedPart = context.partNum || '1';
    let output = template
        .replace(/\{title\}/g, context.title || 'Untitled')
        .replace(/\{id\}/g, context.vodId || '123456789')
        .replace(/\{channel\}/g, context.streamer || 'streamer')
        .replace(/\{channel_id\}/g, '0')
        .replace(/\{date\}/g, dateStr)
        .replace(/\{part\}/g, normalizedPart)
        .replace(/\{part_padded\}/g, normalizedPart.padStart(2, '0'))
        .replace(/\{trim_start\}/g, formatSecondsToTimeDashed(context.startSec))
        .replace(/\{trim_end\}/g, formatSecondsToTimeDashed(context.endSec ?? (context.startSec + context.durationSec)))
        .replace(/\{trim_length\}/g, formatSecondsToTimeDashed(context.durationSec))
        .replace(/\{length\}/g, formatSecondsToTimeDashed(context.totalSec))
        .replace(/\{ext\}/g, 'mp4')
        .replace(/\{random_string\}/g, 'abcd1234');

    output = output.replace(/\{date_custom="(.*?)"\}/g, (_, pattern: string) => formatDateWithPattern(context.date, pattern));
    output = output.replace(/\{trim_start_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.startSec, pattern));
    output = output.replace(/\{trim_end_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.endSec ?? (context.startSec + context.durationSec), pattern));
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
        { placeholder: '{trim_length}', description: text('Länge des Ausschnitts', 'Trimmed duration'), exampleTemplate: '{trim_length}' },
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
    const normalized = timeStr.trim().replace(',', '.');
    const numericParts = normalized.split('.');
    if (numericParts.length <= 2 && /^\d{1,7}$/.test(numericParts[0]) && (numericParts.length === 1 || /^\d{1,3}$/.test(numericParts[1]))) return Number(normalized);
    const parts = normalized.split(':');
    if (parts.length !== 3 || !/^\d{1,3}$/.test(parts[0]) || !/^[0-5]\d$/.test(parts[1])) return NaN;
    const seconds = parts[2].split('.');
    if (seconds.length > 2 || !/^[0-5]\d$/.test(seconds[0]) || (seconds.length === 2 && !/^\d{1,3}$/.test(seconds[1]))) return NaN;
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

function formatClipTime(seconds: number): string {
    const rounded = Math.round(Math.max(0, seconds) * 1000);
    const milliseconds = rounded % 1000;
    return formatSecondsToTime(Math.floor(rounded / 1000)) + (milliseconds ? '.' + String(milliseconds).padStart(3, '0') : '');
}

let clipOmissionState: { editing?: boolean; config: import('./main/domain/vod-edit-plan').OmissionConfig | null; plan: import('./main/domain/vod-edit-plan').EditedVodPlan | null } | null = null;
let clipSavedNaming: { format: CustomClip['filenameFormat']; template: string } | null = null;

let clipQueueInFlight = false;
let clipQueueError = '';

function getClipStartPart(): number {
    const value = byId<HTMLInputElement>('clipStartPart').value.trim();
    return value === '' ? 1 : /^\d{1,6}$/.test(value) && Number(value) >= 1 && Number(value) <= 100000 ? Number(value) : NaN;
}

function updateClipOmissionState(): void {
    const isEditing = clipOmissionState !== null;
    const plan = clipOmissionState?.plan;
    byId('clipDialogDurationLabel').textContent = UI_TEXT.clips.dialogDuration;
    byId('clipQueueHint').textContent = isEditing
        ? plan && plan.parts.length ? (currentLanguage === 'de' ? `${formatUiNumber(plan.parts.length)} ${plan.parts.length === 1 ? 'Datei' : 'Dateien'} · ${formatClipTime(plan.duration)}` : `${formatUiNumber(plan.parts.length)} ${plan.parts.length === 1 ? 'file' : 'files'} · ${formatClipTime(plan.duration)}`)
            : (currentLanguage === 'de' ? 'Kein gültiger Bereich.' : 'No valid range.')
        : '';
    const start = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value), end = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const validRange = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= clipTotalSeconds;
    if (plan && validRange) {
        const milliseconds = Math.round(plan.duration * 1000);
        byId('clipDurationTime').textContent = formatSecondsToTime(Math.floor(milliseconds / 1000));
    }
    const invalidPart = !Number.isInteger(getClipStartPart());
    byId('clipStartPart').setAttribute('aria-invalid', String(invalidPart));
    byId<HTMLButtonElement>('clipDialogConfirmBtn').disabled = clipQueueInFlight || invalidPart || Boolean(clipOmissionState?.editing)
        || !validRange || (isEditing && !plan?.parts.length);
    if (invalidPart) byId('clipQueueHint').textContent = currentLanguage === 'de' ? 'Startnummer: 1–100.000.' : 'Starting number: 1–100,000.';
    else if (clipOmissionState?.editing) byId('clipQueueHint').textContent = currentLanguage === 'de' ? 'Bereich bestätigen oder abbrechen.' : 'Confirm or cancel the range.';
    else if (clipQueueError) byId('clipQueueHint').textContent = clipQueueError;
}

function previewEditedFilename(part: import('./main/domain/vod-edit-plan').EditedVodPart): string {
    if (!clipDialogData) return '';
    const format = getSelectedFilenameFormat();
    const template = format === 'template' ? byId<HTMLInputElement>('clipFilenameTemplate').value : format === 'parts' ? '{date}_Part{part_padded}.mp4' : format === 'timestamp' ? '{date}_CLIP_{trim_start}_{part}.mp4' : '{date}_{part}.mp4';
    return buildTemplatePreview(template, { title: clipDialogData.title, date: new Date(clipDialogData.date), streamer: clipDialogData.streamer, partNum: String(part.number), startSec: part.ranges[0].start, durationSec: part.duration, totalSec: clipTotalSeconds, endSec: part.ranges[part.ranges.length - 1].end, vodId: clipDialogData.url.match(/videos\/(\d+)/)?.[1] });
}

let clipPlayer: ReturnType<Window['VodPlayer']['mount']> | null = null;

function openClipDialog(url: string, title: string, date: string, streamer: string, duration: string): void {
    clipQueueError = '';
    clipPlayer?.destroy();
    clipPlayer = null;
    clipOmissionState = null; clipSavedNaming = null;
    clipDialogData = { url, title, date, streamer, duration };
    clipTotalSeconds = parseDurationToSeconds(duration);

    byId('clipDialogTitle').textContent = UI_TEXT.clips.dialogTitle;
    byId('clipVodTitle').textContent = `${streamer} · ${title} · ${duration}`;
    byId<HTMLInputElement>('clipStartSlider').max = String(clipTotalSeconds);
    byId<HTMLInputElement>('clipEndSlider').max = String(clipTotalSeconds);
    byId<HTMLInputElement>('clipStartSlider').value = '0';
    byId<HTMLInputElement>('clipEndSlider').value = String(clipTotalSeconds);

    byId<HTMLInputElement>('clipStartTime').value = '00:00:00';
    byId<HTMLInputElement>('clipEndTime').value = formatSecondsToTime(clipTotalSeconds);
    byId<HTMLInputElement>('clipStartPart').value = '';
    byId<HTMLInputElement>('clipFilenameTemplate').value = (config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE;
    query<HTMLInputElement>('input[name="filenameFormat"][value="simple"]').checked = true;
    updateFilenameTemplateVisibility();

    updateClipDuration();
    updateFilenameExamples();
    RendererAccessibility.openDialog('clipModal', { onEscape: closeClipDialog });
    clipPlayer = window.VodPlayer.mount(byId('clipPlayer'), {
        url, title, date, duration: clipTotalSeconds, language: config.language || 'de', start: 0, end: clipTotalSeconds,
        partMinutes: config.part_minutes || 60,
        outputSettings: () => ({ startPart: getClipStartPart() }),
        filename: previewEditedFilename,
        onOmissions(state) {
            const changed = Boolean(state) !== Boolean(clipOmissionState);
            clipOmissionState = state;
            if (!changed) { updateClipOmissionState(); return; }
            if (state) {
                clipSavedNaming = { format: getSelectedFilenameFormat(), template: byId<HTMLInputElement>('clipFilenameTemplate').value };
                query<HTMLInputElement>('input[name="filenameFormat"][value="template"]').checked = true;
                byId<HTMLInputElement>('clipFilenameTemplate').value = config.filename_template_parts || DEFAULT_PARTS_TEMPLATE;
            } else if (clipSavedNaming) {
                query<HTMLInputElement>(`input[name="filenameFormat"][value="${clipSavedNaming.format}"]`).checked = true;
                byId<HTMLInputElement>('clipFilenameTemplate').value = clipSavedNaming.template;
                clipSavedNaming = null;
            }
            updateFilenameExamples();
        },
        onRange(start, end) {
            byId<HTMLInputElement>('clipStartTime').value = formatClipTime(start);
            byId<HTMLInputElement>('clipEndTime').value = formatClipTime(end);
            byId<HTMLInputElement>('clipStartSlider').value = String(start);
            byId<HTMLInputElement>('clipEndSlider').value = String(end);
            updateClipDuration(false);
        },
        onDuration(total) {
            clipTotalSeconds = total;
            byId<HTMLInputElement>('clipStartSlider').max = String(total);
            byId<HTMLInputElement>('clipEndSlider').max = String(total);
        },
    });
}

function closeClipDialog(): void {
    clipPlayer?.destroy();
    clipPlayer = null;
    RendererAccessibility.closeDialog('clipModal');
    clipDialogData = null;
    clipOmissionState = null; clipSavedNaming = null;
}

function seekClipBoundary(which: 'start' | 'end'): void {
    const value = parseTimeToSeconds(byId<HTMLInputElement>(which === 'start' ? 'clipStartTime' : 'clipEndTime').value);
    if (Number.isFinite(value)) clipPlayer?.seek(value);
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

function nudgeClipTime(which: 'start' | 'end', delta: number): void {
    const start = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const end = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > clipTotalSeconds || start >= end) return;
    const minimum = which === 'start' ? 0 : start + .001;
    const maximum = which === 'start' ? end - .001 : clipTotalSeconds;
    const next = Math.max(minimum, Math.min(maximum, Math.round(((which === 'start' ? start : end) + delta) * 1000) / 1000));
    byId<HTMLInputElement>(which === 'start' ? 'clipStartTime' : 'clipEndTime').value = formatClipTime(next);
    updateFromInput(which);
}

function normalizeClipTime(which: 'start' | 'end'): void {
    const input = byId<HTMLInputElement>(which === 'start' ? 'clipStartTime' : 'clipEndTime');
    const seconds = parseTimeToSeconds(input.value);
    if (Number.isFinite(seconds)) input.value = formatClipTime(seconds);
    updateClipDuration();
}

function updateFromInput(which: string): void {
    const seconds = parseTimeToSeconds(byId<HTMLInputElement>(which === 'start' ? 'clipStartTime' : 'clipEndTime').value);
    if (Number.isFinite(seconds)) byId<HTMLInputElement>(which === 'start' ? 'clipStartSlider' : 'clipEndSlider').value = String(seconds);
    updateClipDuration();
}

function updateClipDuration(syncPlayer: boolean = true): void {
    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const duration = endSec - startSec;
    const durationDisplay = byId('clipDurationDisplay');

    const isValid = Number.isFinite(duration) && startSec >= 0 && duration > 0 && endSec <= clipTotalSeconds;
    byId<HTMLButtonElement>('clipDialogConfirmBtn').disabled = !isValid;
    byId('clipStartTime').setAttribute('aria-invalid', String(!Number.isFinite(startSec) || startSec < 0 || startSec >= endSec || startSec >= clipTotalSeconds));
    byId('clipEndTime').setAttribute('aria-invalid', String(!Number.isFinite(endSec) || endSec <= startSec || endSec > clipTotalSeconds));
    byId<HTMLButtonElement>('clipStartEarlier').disabled = !isValid || startSec <= 0;
    byId<HTMLButtonElement>('clipStartLater').disabled = !isValid || endSec - startSec <= .001001;
    byId<HTMLButtonElement>('clipEndEarlier').disabled = !isValid || endSec - startSec <= .001001;
    byId<HTMLButtonElement>('clipEndLater').disabled = !isValid || endSec >= clipTotalSeconds;
    clipPlayer?.setInputValid(isValid);
    if (isValid && syncPlayer) clipPlayer?.updateRange(startSec, endSec);
    durationDisplay.classList.toggle('invalid', !isValid);
    const milliseconds = Math.round(duration * 1000);
    byId('clipDurationTime').textContent = isValid ? formatSecondsToTime(Math.floor(milliseconds / 1000)) : UI_TEXT.clips.invalidDuration;

    updateFilenameExamples();
    updateClipOmissionState();
}

function updateFilenameExamples(): void {
    if (!clipDialogData) {
        return;
    }

    clipPlayer?.refreshOutput();
    updateClipOmissionState();
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
        clipLint.textContent = '';
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
    if (!clipDialogData || clipQueueInFlight) {
        return;
    }

    if (clipOmissionState && (clipOmissionState.editing || !clipOmissionState.config || !clipOmissionState.plan?.parts.length)) return;
    const startSec = clipOmissionState ? 0 : parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = clipOmissionState ? clipTotalSeconds : parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const durationSec = endSec - startSec;
    const startPart = getClipStartPart();
    if (!Number.isInteger(startPart)) { updateClipOmissionState(); return; }
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
        filenameTemplate: filenameFormat === 'template' ? filenameTemplate : undefined,
        ...(clipOmissionState?.config ? { omissions: clipOmissionState.config } : {})
    };

    const submittingDialog = clipDialogData;
    const failureMessage = currentLanguage === 'de' ? 'Einreihen fehlgeschlagen. Bitte erneut versuchen.' : 'Could not add the download. Please try again.';
    let submissionError = '';
    clipQueueInFlight = true;
    clipQueueError = '';
    updateClipOmissionState();
    try {
        const selectedQuality = await chooseVodQuality(submittingDialog.url, submittingDialog.title);
        if (!selectedQuality || clipDialogData !== submittingDialog) return;
        const result = await window.api.addToQueueWithResult({
            url: submittingDialog.url, title: submittingDialog.title, date: submittingDialog.date,
            streamer: submittingDialog.streamer, duration_str: submittingDialog.duration, customClip,
            quality: selectedQuality.id, qualityLabel: selectedQuality.label,
        });
        queue = result.queue;
        renderQueue();
        if (result.accepted && clipDialogData === submittingDialog) closeClipDialog();
        if (!result.accepted) submissionError = result.reason === 'duplicate'
            ? (currentLanguage === 'de' ? 'Dieser Download ist bereits in der Warteschlange.' : 'This download is already in the queue.')
            : failureMessage;
    } catch {
        submissionError = failureMessage;
    } finally {
        clipQueueInFlight = false;
        if (clipDialogData) {
            if (clipDialogData === submittingDialog) clipQueueError = submissionError;
            updateClipOmissionState();
        }
    }
}

type ClipBatchState = 'ready' | 'active' | 'done' | 'failed' | 'invalid' | 'stopped';
type ClipMetadataState = 'pending' | 'loading' | 'ready' | 'missing' | 'unavailable';
interface ClipBatchItem {
    previouslyDownloaded?: boolean;
    url: string;
    label: string;
    streamer: string;
    metadataState: ClipMetadataState;
    state: ClipBatchState;
    filename?: string;
    error?: string;
    transfer?: ClipTransferProgress;
}
interface ClipBatchRow {
    row: HTMLLIElement;
    number: HTMLSpanElement;
    label: HTMLSpanElement;
    streamer: HTMLSpanElement;
    status: HTMLSpanElement;
    symbol: HTMLSpanElement;
    open: HTMLButtonElement;
    folder: HTMLButtonElement;
    remove: HTMLButtonElement;
    symbolKind?: string;
}
let clipDownloadInFlight = false;
let clipBatchStopRequested = false;
let clipBatchItems: ClipBatchItem[] = [];
let clipBatchLimitExceeded = false;
let clipNoticeTimer: ReturnType<typeof setTimeout> | undefined;
const clipMetadataRequests = new Set<string>();
const clipBatchRows = new Map<string, ClipBatchRow>();
let clipBatchRenderFrame: number | null = null;

const dirtyClipRows = new Set<ClipBatchItem>();
let clipMetadataDirty = false;
let activeClipRequestId: string | null = null;
let restoredClipDownload = false;
let workspaceLoading = true;
let restoredMergeDownload = false;
let latestMergeFinish: { success: boolean } | null = null;
const latestClipProgress = new Map<string, ClipTransferProgress>();

function scheduleClipBatchRender(item?: ClipBatchItem): void {
    if (item) dirtyClipRows.add(item);
    if (clipBatchRenderFrame !== null) return;
    clipBatchRenderFrame = requestAnimationFrame(() => {
        clipBatchRenderFrame = null;
        renderClipBatchSummary();
        for (const dirty of dirtyClipRows) {
            const index = clipBatchItems.indexOf(dirty);
            if (index >= 0) renderClipBatchRow(dirty, index);
        }
        dirtyClipRows.clear();
        if (clipMetadataDirty) { clipMetadataDirty = false; persistClipWorkspace(); }
    });
}

function persistClipWorkspace(): void {
    if (workspaceLoading) return;
    void window.api.saveClipWorkspace(clipBatchItems.map(({ transfer: _transfer, ...item }) => item)).then(saved => {
        if (saved === false) showClipNotice(currentLanguage === 'de' ? 'Liste konnte nicht gespeichert werden.' : 'Could not save the list.', true);
    }).catch(() => showClipNotice(currentLanguage === 'de' ? 'Liste konnte nicht gespeichert werden.' : 'Could not save the list.', true));
}

function receiveClipProgress(progress: ClipTransferProgress): void {
    latestClipProgress.set(progress.url, progress);
    const item = clipBatchItems.find(candidate => candidate.url === progress.url);
    if (!item || (activeClipRequestId && activeClipRequestId !== progress.requestId)) return;
    item.transfer = progress;
    item.state = progress.state;
    if (progress.state === 'done') RendererClipDiscovery.remember(item.url);
    item.error = progress.error;
    if (progress.filename) item.filename = progress.filename;
    if (progress.state === 'active') activeClipRequestId = progress.requestId;
    if (restoredClipDownload && progress.state !== 'active') {
        restoredClipDownload = false;
        clipDownloadInFlight = false;
        clipBatchStopRequested = false;
        activeClipRequestId = null;
        renderClipBatch();
    } else scheduleClipBatchRender(item);
}

async function restoreWorkspace(): Promise<void> {
    window.api.onClipProgress(receiveClipProgress);
    window.api.onMergeFinished(result => {
        if (workspaceLoading) latestMergeFinish = result;
        if (!restoredMergeDownload) return;
        restoredMergeDownload = false;
        isMerging = false;
        if (result.success) mergeFiles = [];
        byId('mergeProgress').classList.remove('show');
        renderMergeFiles();
        showAppToast(result.success ? UI_TEXT.merge.success : UI_TEXT.merge.failed, result.success ? 'info' : 'warn');
    });
    try {
        const session = await window.api.getWorkspaceSession();
        if (session) {
            if (session.automationPaused) showAppToast(currentLanguage === 'de' ? 'Sicherung wiederhergestellt. Automatik für diesen Start pausiert.' : 'Backup restored. Automation is paused for this session.');
            clipBatchItems = session.clips.map(item => ({ ...item, metadataState: item.metadataState === 'loading' ? 'pending' : item.metadataState }));
            byId<HTMLTextAreaElement>('clipUrl').value = clipBatchItems.map(item => item.url).join('\n');
            mergeFiles = session.mergeFiles;
            isMerging = restoredMergeDownload = Boolean(session.mergeActive && !latestMergeFinish);
            if (session.mergeActive && latestMergeFinish?.success) mergeFiles = [];
            byId('mergeProgress').classList.toggle('show', isMerging);
            byId('mergeProgressBar').style.width = (session.mergeProgress || 0) + '%';
            byId('mergeProgressText').textContent = Math.round(session.mergeProgress || 0) + '%';
            if (session.activeClip) {
                clipDownloadInFlight = restoredClipDownload = true;
                receiveClipProgress(latestClipProgress.get(session.activeClip.url) || session.activeClip);
            }
        }
    } catch { showAppToast(currentLanguage === 'de' ? 'Listen konnten nicht geladen werden.' : 'Could not restore the lists.', 'warn'); }
    finally {
        workspaceLoading = false;
        requestClipMetadata();
        requestMergeDurations();
        renderClipBatch();
        void RendererClipDiscovery.annotate(clipBatchItems, item => { if (clipBatchItems.includes(item)) scheduleClipBatchRender(item); });
        renderMergeFiles();
    }
}

function canonicalClipLink(line: string): { url: string; valid: boolean } {
    try {
        const url = new URL(line);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port && line.length <= 4096) {
            const parts = url.pathname.split('/').filter(Boolean);
            const slug = url.hostname === 'clips.twitch.tv' && parts.length === 1 ? parts[0]
                : ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname) && parts.length === 3 && parts[1] === 'clip' && /^[A-Za-z0-9_]+$/.test(parts[0]) ? parts[2] : '';
            if (/^[A-Za-z0-9_-]+$/.test(slug)) return { url: 'https://clips.twitch.tv/' + slug, valid: true };
        }
    } catch {}
    return { url: line, valid: false };
}

function removeClipLink(url: string): void {
    if (clipDownloadInFlight) return;
    const input = byId<HTMLTextAreaElement>('clipUrl');
    input.value = input.value.split(/\r?\n/).filter(line => canonicalClipLink(line.trim()).url !== url).join('\n');
    updateClipLinks();
}

async function openClipFile(url: string, folder: boolean): Promise<void> {
    const filename = clipBatchItems.find(item => item.url === url)?.filename;
    if (!filename) return;
    try {
        const opened = folder ? await window.api.showInFolder(filename) : await window.api.openFile(filename);
        if (!opened) showClipNotice(UI_TEXT.static.archiveActionFailed, true);
    } catch { showClipNotice(UI_TEXT.static.archiveActionFailed, true); }
}

function positionClipInfo(): void {
    const panel = byId<HTMLElement>('clipsInfoPopover');
    if (!panel?.matches(':popover-open')) return;
    const button = byId<HTMLElement>('clipsInfoButton');
    if (!button.getClientRects().length) { panel.hidePopover(); return; }
    const bounds = button.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const left = Math.max(12, Math.min(bounds.right - box.width, window.innerWidth - box.width - 12));
    const top = bounds.bottom + box.height + 8 <= window.innerHeight - 12 ? bounds.bottom + 8 : Math.max(12, bounds.top - box.height - 8);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
}

function toggleClipInfo(): void {
    const panel = byId<HTMLElement>('clipsInfoPopover');
    if (!panel.dataset.bound) {
        panel.dataset.bound = 'true';
        panel.addEventListener('toggle', () => {
            byId('clipsInfoButton').setAttribute('aria-expanded', String(panel.matches(':popover-open')));
            positionClipInfo();
        });
        window.addEventListener('resize', positionClipInfo);
        document.addEventListener('scroll', positionClipInfo, true);
        new ResizeObserver(positionClipInfo).observe(byId('clipsInfoButton'));
    }
    panel.togglePopover();
    positionClipInfo();
}

function showClipNotice(message: string, error = false): void {
    clearTimeout(clipNoticeTimer);
    const notice = byId('clipStatus');
    notice.textContent = message;
    notice.className = 'clip-notice' + (error ? ' error' : '') + (message ? ' visible' : '');
    if (message) clipNoticeTimer = setTimeout(() => notice.classList.remove('visible'), 5000);
}

function completeClipMetadata(url: string, info: { title: string; broadcaster_name: string } | null | undefined): void {
    clipMetadataRequests.delete(url);
    const item = clipBatchItems.find(candidate => candidate.url === url && candidate.state !== 'invalid');
    if (item) {
        if (info && typeof info.title === 'string' && typeof info.broadcaster_name === 'string') {
            item.label = info.title.trim();
            item.streamer = info.broadcaster_name.trim();
            item.metadataState = 'ready';
        } else {
            item.metadataState = info === null ? 'missing' : 'unavailable';
            if (info === null && (item.state === 'ready' || item.state === 'stopped')) {
                item.state = 'failed';
                item.error = UI_TEXT.clips.notAvailable;
            }
        }
    }
    requestClipMetadata();
    clipMetadataDirty = true;
    scheduleClipBatchRender(item);
}

function requestClipMetadata(): void {
    for (const item of clipBatchItems) {
        if (item.state === 'invalid' || item.metadataState !== 'pending') continue;
        if (clipMetadataRequests.has(item.url)) {
            item.metadataState = 'loading';
            continue;
        }
        if (clipMetadataRequests.size >= 4) continue;
        const url = item.url;
        item.metadataState = 'loading';
        clipMetadataRequests.add(url);
        scheduleClipBatchRender(item);
        void Promise.resolve().then(() => window.api.getClipInfo(url)).then(
            info => completeClipMetadata(url, info),
            () => completeClipMetadata(url, undefined)
        );
    }
}

function updateClipLinks(): void {
    if (clipDownloadInFlight || workspaceLoading) return;
    const lines = byId<HTMLTextAreaElement>('clipUrl').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const seen = new Set<string>();
    const previous = new Map(clipBatchItems.map(item => [item.url, item]));
    clipBatchItems = [];
    clipBatchLimitExceeded = false;
    for (const line of lines) {
        const parsed = canonicalClipLink(line);
        if (seen.has(parsed.url)) continue;
        seen.add(parsed.url);
        if (clipBatchItems.length >= 200) { clipBatchLimitExceeded = true; break; }
        clipBatchItems.push(previous.get(parsed.url) || { url: parsed.url, label: '', streamer: '', metadataState: parsed.valid ? 'pending' : 'unavailable', state: parsed.valid ? 'ready' : 'invalid' });
    }
    showClipNotice(clipBatchLimitExceeded ? UI_TEXT.clips.limitReached : '', true);
    requestClipMetadata();
    renderClipBatch();
    persistClipWorkspace();
    void RendererClipDiscovery.annotate(clipBatchItems, item => { if (clipBatchItems.includes(item)) scheduleClipBatchRender(item); });
}

function clearClipLinks(): void {
    if (clipDownloadInFlight) return;
    byId<HTMLTextAreaElement>('clipUrl').value = '';
    updateClipLinks();
}

function stopClipBatch(): void {
    if (!clipDownloadInFlight || clipBatchStopRequested) return;
    clipBatchStopRequested = true;
    renderClipBatchSummary();
    if (activeClipRequestId) void window.api.cancelClipDownload(activeClipRequestId).catch(() => {
        clipBatchStopRequested = false;
        renderClipBatchSummary();
        showClipNotice(currentLanguage === 'de' ? 'Abbruch fehlgeschlagen.' : 'Could not cancel the download.', true);
    });
}

function createClipBatchRow(url: string): ClipBatchRow {
    const row = document.createElement('li');
    const span = (className: string) => {
        const element = document.createElement('span');
        element.className = className;
        return element;
    };
    const number = span('clip-result-number');
    const label = span('clip-result-label');
    const streamer = span('clip-result-streamer');
    const status = span('clip-result-status');
    const symbol = span('clip-result-symbol');
    symbol.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div');
    content.className = 'clip-result-content';
    const meta = document.createElement('div');
    meta.className = 'clip-result-meta';
    meta.append(streamer, status);
    content.append(label, meta);
    const actions = document.createElement('div');
    actions.className = 'clip-result-actions';
    const action = (pathData: string, callback: () => void) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'clip-row-action';
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData);
        icon.append(path);
        button.append(icon);
        button.addEventListener('click', callback);
        actions.append(button);
        return button;
    };
    const open = action('m8 5 11 7-11 7z', () => { void openClipFile(url, false); });
    const folder = action('M3 7V4h6l2 3h10v13H3z', () => { void openClipFile(url, true); });
    const remove = action('M6 6l12 12M6 18 18 6', () => removeClipLink(url));
    row.append(number, content, symbol, actions);
    return { row, number, label, streamer, status, symbol, open, folder, remove };
}

function updateClipBatchSymbol(elements: ClipBatchRow, kind: string): void {
    if (elements.symbolKind === kind) return;
    elements.symbolKind = kind;
    if (kind === 'loading') {
        const loader = document.createElement('span');
        loader.className = 'clip-result-loader';
        elements.symbol.replaceChildren(loader);
        return;
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('viewBox', '0 0 24 24');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', kind === 'done' ? '12' : '9');
    circle.setAttribute('fill', kind === 'done' ? '#2E9E5B' : 'none');
    if (kind !== 'done') {
        circle.setAttribute('stroke', 'currentColor');
        circle.setAttribute('stroke-width', '1.5');
    }
    path.setAttribute('d', kind === 'done' ? 'M6.6 12.3 10.4 16 17.4 8.6' : kind === 'error' ? 'M12 7v6m0 4h.01' : 'M8 12h8');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', kind === 'done' ? 'white' : 'currentColor');
    path.setAttribute('stroke-width', kind === 'done' ? '2.2' : '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(circle, path);
    elements.symbol.replaceChildren(svg);
}

function clipBatchTitle(item: ClipBatchItem): string {
    const de = currentLanguage === 'de';
    if (item.state === 'invalid') return de ? 'Ungültiger Link' : 'Invalid link';
    if (item.metadataState === 'ready') return item.label || (de ? 'Clip ohne Titel' : 'Untitled clip');
    if (item.metadataState === 'missing') return de ? 'Clip nicht gefunden' : 'Clip not found';
    if (item.metadataState === 'unavailable') return de ? 'Titel nicht verfügbar' : 'Title unavailable';
    return de ? 'Titel wird geladen …' : 'Loading title …';
}

function setClipText(element: HTMLElement, value: string): void {
    if (element.textContent !== value) element.textContent = value;
}

function renderClipBatchSummary(): void {
    const done = clipBatchItems.filter(item => item.state === 'done').length;
    const failed = clipBatchItems.filter(item => item.state === 'failed' || item.state === 'invalid').length;
    const ready = clipBatchItems.some(item => item.state === 'ready' || item.state === 'stopped');
    const format = (message: string) => message.replace('{done}', formatUiNumber(done)).replace('{total}', formatUiNumber(clipBatchItems.length)).replace('{failed}', formatUiNumber(failed));
    byId('clipsLinkCount').textContent = clipBatchItems.length === 1 ? UI_TEXT.clips.linkCountOne : UI_TEXT.clips.linksCount.replace('{count}', formatUiNumber(clipBatchItems.length));
    byId('clipsResults').dataset.empty = String(clipBatchItems.length === 0);
    byId('clipsBatchSummary').textContent = format(UI_TEXT.clips.summary);
    const progress = clipBatchItems.length ? Math.round((done + failed) * 100 / clipBatchItems.length) : 0;
    const gauge = byId<HTMLElement>('clipsBatchProgress');
    gauge.setAttribute('aria-valuenow', String(progress));
    gauge.querySelector<HTMLElement>('span')!.style.transition = clipDownloadInFlight ? '' : 'none';
    gauge.querySelector<HTMLElement>('span')!.style.width = progress + '%';
    byId<HTMLTextAreaElement>('clipUrl').disabled = clipDownloadInFlight || workspaceLoading;
    byId<HTMLButtonElement>('clipsClearBtn').disabled = clipDownloadInFlight || workspaceLoading || !clipBatchItems.length;
    const button = byId<HTMLButtonElement>('btnClip');
    button.disabled = clipDownloadInFlight || workspaceLoading || clipBatchLimitExceeded || !ready;
    button.textContent = clipDownloadInFlight ? UI_TEXT.clips.loadingButton : UI_TEXT.clips.downloadButton;
    const toolbarButton = byId<HTMLButtonElement>('toolbarClipDownloadBtn');
    toolbarButton.disabled = button.disabled;
    const stop = byId<HTMLButtonElement>('clipsStopBtn');
    stop.hidden = !clipDownloadInFlight;
    stop.disabled = clipBatchStopRequested;
    stop.textContent = clipBatchStopRequested ? UI_TEXT.clips.stopping : UI_TEXT.clips.stopBatch;
    const retry = byId<HTMLButtonElement>('clipsRetryBtn');
    retry.hidden = !clipBatchItems.some(item => item.state === 'failed');
    retry.disabled = clipDownloadInFlight || workspaceLoading || clipBatchLimitExceeded;
}

function renderClipBatchRow(item: ClipBatchItem, index: number): void {
    const list = byId<HTMLElement>('clipsDownloadList');
    let elements = clipBatchRows.get(item.url);
    if (!elements) {
        elements = createClipBatchRow(item.url);
        elements.row.dataset.clipUrl = item.url;
        clipBatchRows.set(item.url, elements);
    }
    const rowClass = 'clip-result-row ' + item.state;
    if (elements.row.className !== rowClass) elements.row.className = rowClass;
    setClipText(elements.number, formatUiNumber(index + 1));
    const title = clipBatchTitle(item);
    setClipText(elements.label, title);
    elements.label.title = item.metadataState === 'ready' ? title : item.url;
    setClipText(elements.streamer, item.streamer);
    elements.streamer.hidden = !item.streamer;
    elements.streamer.title = item.streamer;
    const transfer = item.state === 'active' ? item.transfer : undefined;
    const status = transfer ? transfer.phase === 'preparing' ? (currentLanguage === 'de' ? 'Vorbereiten …' : 'Preparing …')
        : transfer.phase === 'saving' ? (currentLanguage === 'de' ? 'Speichern …' : 'Saving …')
        : formatBytesForMetrics(transfer.bytes) + ' · ' + formatBytesForMetrics(transfer.bytesPerSecond) + '/s'
        : item.state === 'invalid' ? UI_TEXT.clips.invalidUrl : item.error || RendererClipDiscovery.status(item) || UI_TEXT.clips[item.state];
    setClipText(elements.status, status);
    elements.status.title = status;
    const kind = item.state === 'done' ? 'done' : item.state === 'failed' || item.state === 'invalid' ? 'error' : item.state === 'active' || item.metadataState === 'loading' ? 'loading' : 'ready';
    updateClipBatchSymbol(elements, kind);
    for (const [button, label] of [[elements.open, UI_TEXT.static.archiveOpen], [elements.folder, UI_TEXT.static.archiveShowInFolder], [elements.remove, UI_TEXT.merge.removeAria]] as const) {
        button.setAttribute('aria-label', label);
        button.title = label;
    }
    elements.open.style.visibility = elements.folder.style.visibility = item.filename ? 'visible' : 'hidden';
    elements.open.disabled = elements.folder.disabled = !item.filename;
    elements.remove.disabled = clipDownloadInFlight || workspaceLoading;
    if (list.children[index] !== elements.row) list.insertBefore(elements.row, list.children[index] || null);
}

function renderClipBatch(): void {
    if (clipBatchRenderFrame !== null) { cancelAnimationFrame(clipBatchRenderFrame); clipBatchRenderFrame = null; }
    dirtyClipRows.clear();
    renderClipBatchSummary();
    const list = byId<HTMLElement>('clipsDownloadList');
    const scrollTop = list.scrollTop;
    const urls = new Set(clipBatchItems.map(item => item.url));
    for (const [url, elements] of clipBatchRows) {
        if (!urls.has(url)) {
            elements.row.remove();
            clipBatchRows.delete(url);
        }
    }
    if (!clipBatchItems.length) {
        let empty = list.querySelector<HTMLLIElement>('.clips-list-empty');
        if (!empty) {
            empty = document.createElement('li');
            empty.className = 'clips-list-empty';
            list.append(empty);
        }
        setClipText(empty, UI_TEXT.clips.listEmpty);
    } else {
        list.querySelector('.clips-list-empty')?.remove();
    }
    clipBatchItems.forEach(renderClipBatchRow);
    list.scrollTop = scrollTop;
}

async function downloadClip(retryFailed = false): Promise<void> {
    if (clipDownloadInFlight || workspaceLoading) return;
    if (!clipBatchItems.length) updateClipLinks();
    if (clipBatchLimitExceeded) {
        showClipNotice(UI_TEXT.clips.limitReached, true);
        return;
    }
    const pending = clipBatchItems.filter(item => retryFailed ? item.state === 'failed' : item.state === 'ready' || item.state === 'stopped');
    if (!pending.length) {
        showClipNotice(clipBatchItems.length ? UI_TEXT.clips.emptyBatch : UI_TEXT.clips.enterUrl, true);
        return;
    }
    clipDownloadInFlight = true;
    clipBatchStopRequested = false;
    showClipNotice('');
    for (const item of pending) {
        item.state = 'ready';
        item.error = undefined;
        if (item.metadataState === 'missing' || item.metadataState === 'unavailable') item.metadataState = 'pending';
    }
    requestClipMetadata();
    renderClipBatch();
    persistClipWorkspace();
    try {
        for (const item of pending) {
            if (clipBatchStopRequested) {
                item.state = 'stopped';
                continue;
            }
            if (item.state === 'failed' && item.metadataState === 'missing') continue;
            item.state = 'active';
            item.transfer = undefined;
            activeClipRequestId = crypto.randomUUID();
            scheduleClipBatchRender(item);
            try {
                const result = await window.api.downloadClip(item.url, activeClipRequestId);
                item.state = result?.cancelled ? 'stopped' : result?.success ? 'done' : 'failed';
                if (result?.success) item.filename = result.filename;
                if (!result?.success && !result?.cancelled) item.error = result?.error?.trim() || UI_TEXT.clips.unknownError;
                else if (item.metadataState === 'missing' || item.metadataState === 'unavailable') {
                    item.metadataState = 'pending';
                    requestClipMetadata();
                }
            } catch {
                item.state = 'failed';
                item.error = UI_TEXT.clips.unknownError;
            }
            scheduleClipBatchRender(item);
        }
    } finally {
        activeClipRequestId = null;
        clipDownloadInFlight = false;
        clipBatchStopRequested = false;
        renderClipBatch();
        persistClipWorkspace();
    }
    const done = clipBatchItems.filter(item => item.state === 'done').length;
    const failed = clipBatchItems.filter(item => item.state === 'failed' || item.state === 'invalid').length;
    const result = [
        done > 0 ? (done === 1 ? UI_TEXT.clips.finishedOne : UI_TEXT.clips.finished.replace('{done}', formatUiNumber(done))) : '',
        failed > 0 ? UI_TEXT.clips.failedCount.replace('{failed}', formatUiNumber(failed)) : ''
    ].filter(Boolean).join(' · ');
    showClipNotice(result, failed > 0);
}

const segmentedIndicatorFrames = new WeakMap<HTMLElement, number>();

function syncSegmentedIndicator(control: HTMLElement): void {
    const activeButton = control.querySelector<HTMLElement>('button.active');
    if (!control.offsetWidth || !activeButton?.offsetWidth) {
        control.classList.remove('segmented-indicator-ready', 'segmented-indicator-visible');
        return;
    }
    control.style.setProperty('--segment-active-x', `${activeButton.offsetLeft}px`);
    control.style.setProperty('--segment-active-y', `${activeButton.offsetTop}px`);
    control.style.setProperty('--segment-active-width', `${activeButton.offsetWidth}px`);
    control.style.setProperty('--segment-active-height', `${activeButton.offsetHeight}px`);
    control.classList.add('segmented-indicator-visible');
    if (!control.classList.contains('segmented-indicator-ready')) {
        control.getBoundingClientRect();
        requestAnimationFrame(() => {
            if (control.offsetWidth) control.classList.add('segmented-indicator-ready');
        });
    }
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
    document.querySelectorAll<HTMLElement>('.context-switcher, .language-picker, .workspace-theme-picker, [data-context-for="settings"] .context-list').forEach(scheduleSegmentedIndicatorSync);
}

function initSegmentedIndicators(): void {
    const observer = new ResizeObserver((entries) => {
        entries.forEach((entry) => {
            const control = entry.target.closest<HTMLElement>('.context-switcher, .language-picker, .workspace-theme-picker, [data-context-for="settings"] .context-list');
            if (control) scheduleSegmentedIndicatorSync(control);
        });
    });
    document.querySelectorAll<HTMLElement>('.context-switcher, .language-picker, .workspace-theme-picker, [data-context-for="settings"] .context-list').forEach((control) => {
        observer.observe(control);
        control.querySelectorAll<HTMLElement>('button').forEach((button) => observer.observe(button));
        syncSegmentedIndicator(control);
    });
    window.addEventListener('resize', scheduleSegmentedIndicatorsSync);
}

let mergeFilePickerInFlight = false;

const mergeInfoRequests = new Set<string>();
const mergeInfoRequested = new Set<string>();
let mergeDurationFrame: number | null = null;
let draggedMergeId: string | null = null;

function persistMergeWorkspace(): void {
    if (workspaceLoading) return;
    void window.api.saveMergeWorkspace(mergeFiles.map(file => file.id)).then(saved => {
        if (saved === false) showAppToast(currentLanguage === 'de' ? 'Liste konnte nicht gespeichert werden.' : 'Could not save the list.', 'warn');
    }).catch(() => showAppToast(currentLanguage === 'de' ? 'Liste konnte nicht gespeichert werden.' : 'Could not save the list.', 'warn'));
}

function formatMergeDuration(seconds: number): string {
    const total = Math.round(Math.max(0, seconds));
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(value => String(value).padStart(2, '0')).join(':');
}

function renderMergeDurations(): void {
    const durations = new Map(mergeFiles.map(file => [file.id, file]));
    byId<HTMLElement>('mergeFileList').querySelectorAll<HTMLElement>('[data-file-id]').forEach(row => {
        const file = durations.get(row.dataset.fileId!);
        if (!file) return;
        const duration = row.querySelector<HTMLElement>('.file-duration')!;
        duration.textContent = file.missing ? (currentLanguage === 'de' ? 'Datei fehlt oder wurde geändert' : 'File missing or changed')
            : file.durationSeconds === undefined ? mergeInfoRequests.has(file.id) ? '…' : '—' : formatMergeDuration(file.durationSeconds);
        row.classList.toggle('file-unavailable', Boolean(file.missing));
    });
    const total = mergeFiles.reduce((sum, file) => sum + (file.durationSeconds || 0), 0);
    const complete = mergeFiles.every(file => file.durationSeconds !== undefined && !file.missing);
    byId('mergeTotalDuration').textContent = mergeFiles.length ? formatUiNumber(mergeFiles.length) + (mergeFiles.length === 1 ? ' Video · ' : currentLanguage === 'de' ? ' Videos · ' : ' videos · ') + (complete ? formatMergeDuration(total) : '—') : '';
    byId<HTMLButtonElement>('btnMerge').disabled = workspaceLoading || isMerging || mergeFilePickerInFlight || mergeFiles.length < 2 || mergeFiles.some(file => file.missing);
}

function requestMergeDurations(): void {
    for (const file of mergeFiles) {
        if (mergeInfoRequests.size >= 3) break;
        if (file.durationSeconds !== undefined || file.missing || mergeInfoRequested.has(file.id)) continue;
        mergeInfoRequested.add(file.id);
        mergeInfoRequests.add(file.id);
        void window.api.getMergeVideoInfo(file.id).then(info => {
            if (info && mergeFiles.includes(file)) Object.assign(file, info);
        }).catch(() => {}).finally(() => {
            mergeInfoRequests.delete(file.id);
            requestMergeDurations();
            if (mergeDurationFrame === null) mergeDurationFrame = requestAnimationFrame(() => { mergeDurationFrame = null; renderMergeDurations(); });
        });
    }
}

function clearMergeDrag(): void {
    draggedMergeId = null;
    byId<HTMLElement>('mergeFileList').querySelectorAll('.file-item').forEach(row => row.classList.remove('dragging', 'drop-before', 'drop-after'));
}

function dropMergeFile(targetId: string, after: boolean): void {
    if (isMerging || mergeFilePickerInFlight || !draggedMergeId || draggedMergeId === targetId) return;
    const source = mergeFiles.findIndex(file => file.id === draggedMergeId);
    const target = mergeFiles.find(file => file.id === targetId);
    if (source < 0 || !target) return;
    const [file] = mergeFiles.splice(source, 1);
    mergeFiles.splice(mergeFiles.indexOf(target) + Number(after), 0, file);
    clearMergeDrag();
    renderMergeFiles();
    persistMergeWorkspace();
}




async function addArchiveToMerge(files: MergeFileReference[]): Promise<void> {
    if (workspaceLoading || isMerging || mergeFilePickerInFlight) throw new Error('Merge unavailable');
    if (mergeFiles.length + files.length > 500) throw new Error('Maximum 500 videos');
    mergeFiles = [...mergeFiles, ...files];
    persistMergeWorkspace();
    requestMergeDurations();
    renderMergeFiles();
    showTab('merge');
}

async function addMergeFiles(): Promise<void> {
    if (workspaceLoading || isMerging || mergeFilePickerInFlight) return;
    mergeFilePickerInFlight = true;
    renderMergeFiles();
    try {
        const files = await window.api.selectMultipleVideos();
        if (files?.length) {
            if (mergeFiles.length + files.length > 500) showAppToast(currentLanguage === 'de' ? 'Maximal 500 Videos.' : 'Maximum 500 videos.', 'warn');
            mergeFiles = [...mergeFiles, ...files].slice(0, 500);
            persistMergeWorkspace();
            requestMergeDurations();
        }
    } catch {
        showAppToast(UI_TEXT.merge.selectFailed, 'warn');
    } finally {
        mergeFilePickerInFlight = false;
        renderMergeFiles();
    }
}

function renderMergeFiles(): void {
    const list = byId<HTMLElement>('mergeFileList');
    byId<HTMLButtonElement>('btnMerge').disabled = workspaceLoading || isMerging || mergeFilePickerInFlight || mergeFiles.length < 2 || mergeFiles.some(file => file.missing);
    byId('btnMerge').textContent = isMerging ? UI_TEXT.merge.merging : UI_TEXT.merge.merge;
    byId<HTMLButtonElement>('mergeAddBtn').disabled = workspaceLoading || isMerging || mergeFilePickerInFlight || mergeFiles.length >= 500;
    if (!mergeFiles.length) {
        const wrap = document.createElement('div');
        wrap.className = 'empty-state merge-empty-state';
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'currentColor');
        icon.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
        icon.append(path);
        const text = document.createElement('p');
        text.textContent = UI_TEXT.merge.empty;
        wrap.append(icon, text);
        list.replaceChildren(wrap);
        renderMergeDurations();
        return;
    }
    const scrollTop = list.scrollTop;
    const fragment = document.createDocumentFragment();
    mergeFiles.forEach((file, index) => {
        const row = document.createElement('div');
        row.className = 'file-item';
        row.dataset.index = String(index);
        row.dataset.fileId = file.id;
        const grip = document.createElement('button');
        grip.type = 'button';
        grip.className = 'file-drag';
        grip.draggable = !isMerging && !mergeFilePickerInFlight;
        grip.disabled = isMerging || mergeFilePickerInFlight;
        grip.setAttribute('aria-label', currentLanguage === 'de' ? 'Reihenfolge ändern' : 'Reorder');
        const gripIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        gripIcon.setAttribute('viewBox', '0 0 24 24');
        gripIcon.setAttribute('aria-hidden', 'true');
        for (const x of [8, 16]) for (const y of [5, 12, 19]) {
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y)); dot.setAttribute('r', '1.6'); gripIcon.append(dot);
        }
        grip.append(gripIcon);
        grip.addEventListener('dragstart', event => {
            if (isMerging || mergeFilePickerInFlight) { event.preventDefault(); return; }
            draggedMergeId = file.id;
            event.dataTransfer!.effectAllowed = 'move';
            event.dataTransfer!.setData('text/plain', file.id);
            event.dataTransfer!.setDragImage(row, 30, row.clientHeight / 2);
            row.classList.add('dragging');
        });
        grip.addEventListener('dragend', clearMergeDrag);
        row.addEventListener('dragover', event => {
            if (!draggedMergeId || isMerging || mergeFilePickerInFlight) return;
            event.preventDefault();
            event.dataTransfer!.dropEffect = 'move';
            const after = event.clientY >= row.getBoundingClientRect().top + row.clientHeight / 2;
            list.querySelectorAll('.drop-before, .drop-after').forEach(item => item.classList.remove('drop-before', 'drop-after'));
            if (draggedMergeId !== file.id) row.classList.add(after ? 'drop-after' : 'drop-before');
            const bounds = list.getBoundingClientRect();
            if (event.clientY < bounds.top + 40) list.scrollTop -= 24;
            if (event.clientY > bounds.bottom - 40) list.scrollTop += 24;
        });
        row.addEventListener('drop', event => {
            if (!draggedMergeId) return;
            event.preventDefault();
            dropMergeFile(file.id, event.clientY >= row.getBoundingClientRect().top + row.clientHeight / 2);
        });
        const number = document.createElement('div');
        number.className = 'file-order';
        number.textContent = formatUiNumber(index + 1);
        const name = document.createElement('div');
        name.className = 'file-name';
        name.textContent = file.name;
        name.title = file.name;
        const content = document.createElement('div');
        content.className = 'file-content';
        const duration = document.createElement('span');
        duration.className = 'file-duration';
        content.append(name, duration);
        const actions = document.createElement('div');
        actions.className = 'file-actions';
        const addAction = (label: string, pathData: string, disabled: boolean, callback: () => void, remove = false) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'file-btn' + (remove ? ' remove' : '');
            button.disabled = disabled || isMerging || mergeFilePickerInFlight;
            button.setAttribute('aria-label', label);
            button.title = label;
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('viewBox', '0 0 24 24');
            icon.setAttribute('aria-hidden', 'true');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', pathData);
            icon.append(path);
            button.append(icon);
            button.addEventListener('click', callback);
            actions.append(button);
        };
        addAction(UI_TEXT.merge.moveUpAria, 'm6 14 6-6 6 6', index === 0, () => moveMergeFile(index, -1));
        addAction(UI_TEXT.merge.moveDownAria, 'm6 10 6 6 6-6', index === mergeFiles.length - 1, () => moveMergeFile(index, 1));
        addAction(UI_TEXT.merge.removeAria, 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', false, () => removeMergeFile(index), true);
        row.append(grip, number, content, actions);
        fragment.append(row);
    });
    list.replaceChildren(fragment);
    renderMergeDurations();
    list.scrollTop = scrollTop;
}

function moveMergeFile(index: number, direction: number): void {
    const next = index + direction;
    if (isMerging || mergeFilePickerInFlight || !Number.isInteger(index) || !mergeFiles[index] || !mergeFiles[next] || Math.abs(direction) !== 1) return;
    [mergeFiles[index], mergeFiles[next]] = [mergeFiles[next], mergeFiles[index]];
    renderMergeFiles();
    persistMergeWorkspace();
    byId<HTMLElement>('mergeFileList').children[next]?.querySelector<HTMLButtonElement>(direction < 0 ? '.file-btn' : '.file-btn:nth-child(2)')?.focus({ preventScroll: true });
}

function removeMergeFile(index: number): void {
    if (isMerging || mergeFilePickerInFlight || !Number.isInteger(index) || !mergeFiles[index]) return;
    mergeFiles.splice(index, 1);
    renderMergeFiles();
    persistMergeWorkspace();
}

async function startMerging(): Promise<void> {
    await showMergeExportOptions(true);
}

void init();

function importDiscoveredClips(clips: import('./main/domain/clip-discovery').DiscoveredClip[]): void {
    if (workspaceLoading || clipDownloadInFlight) throw new Error('Clip import unavailable');
    const existing = new Set(clipBatchItems.map(item => item.url));
    const added = clips.filter(clip => !existing.has(clip.url));
    if (clipBatchItems.length + added.length > 200) throw new Error('Clip limit exceeded');
    for (const clip of added) clipBatchItems.push({ url: clip.url, label: clip.title, streamer: clip.channel, metadataState: 'ready', state: 'ready', previouslyDownloaded: clip.downloaded });
    byId<HTMLTextAreaElement>('clipUrl').value = clipBatchItems.map(item => item.url).join('\n');
    renderClipBatch();
    persistClipWorkspace();
}
Object.assign(window, { importDiscoveredClips });
