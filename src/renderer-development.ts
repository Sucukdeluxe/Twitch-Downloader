interface DevelopmentViewState {
    savedAt: number;
    tab: string;
    streamer: string | null;
    settingsPane: string;
    inputs: Record<string, string>;
    focus?: string;
    scroll: Record<string, number>;
}

const developmentViewKey = 'tvm:development-view';
let developmentRendererReady = false;
let developmentLastInput = 0;
const developmentEnabled = new URLSearchParams(location.search).get('development') === '1';
if (developmentEnabled) {
    document.addEventListener('input', () => { developmentLastInput = Date.now(); }, true);
    document.addEventListener('pointerdown', () => { developmentLastInput = Date.now(); }, true);
    document.addEventListener('keydown', () => { developmentLastInput = Date.now(); }, true);
}

function readDevelopmentView(): DevelopmentViewState | null {
    if (!developmentEnabled) return null;
    try {
        const state = JSON.parse(localStorage.getItem(developmentViewKey) || 'null');
        if (!state || !Number.isFinite(state.savedAt) || Date.now() - state.savedAt < 0 || Date.now() - state.savedAt >= 120000) return null;
        if (typeof state.tab !== 'string' || typeof state.settingsPane !== 'string' || (state.streamer !== null && typeof state.streamer !== 'string')) return null;
        if (!state.inputs || typeof state.inputs !== 'object' || !Object.values(state.inputs).every(value => typeof value === 'string')) return null;
        if (!state.scroll || typeof state.scroll !== 'object' || !Object.values(state.scroll).every(value => typeof value === 'number' && Number.isFinite(value))) return null;
        if (state.focus !== undefined && typeof state.focus !== 'string') return null;
        return state;
    } catch { return null; }
}

function developmentRefreshBlocked(): boolean {
    if (!developmentEnabled || !developmentRendererReady || Date.now() - developmentLastInput < 800) return true;
    if (workspaceLoading || clipDownloadInFlight || clipQueueInFlight || isCutting || isMerging || mergeFilePickerInFlight || streamerAddInFlight || vodBulkOperationInFlight || settingsAutoSaveInFlight || settingsSaveFailed || cutterEditorState) return true;
    if (Array.from(document.querySelectorAll<HTMLElement>('.modal.show, .modal.active, dialog[open], [aria-modal="true"]')).some(element => element.getClientRects().length > 0)) return true;
    if (Array.from(document.querySelectorAll('video,audio')).some(media => !(media as HTMLMediaElement).paused)) return true;
    return false;
}

async function prepareDevelopmentRefresh(): Promise<boolean> {
    if (developmentRefreshBlocked()) return false;
    await flushSettingsAutoSave();
    if (developmentRefreshBlocked()) return false;
    const inputs: Record<string, string> = {};
    for (const id of ['newStreamer', 'streamerListFilter', 'vodFilterInput', 'archiveSearchQuery', 'settingsSearchInput', 'clipUrl']) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) inputs[id] = input.value;
    }
    const scroll: Record<string, number> = {};
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('[id]'))) {
        if (element.scrollTop) scroll[element.id] = element.scrollTop;
    }
    try {
        localStorage.setItem(developmentViewKey, JSON.stringify({ savedAt: Date.now(), tab: document.querySelector('.tab-content.active')?.id.replace(/Tab$/, '') || 'vods', streamer: currentStreamer, settingsPane: document.getElementById('settingsTab')?.dataset.settingsPane || 'general', focus: document.activeElement?.id, inputs, scroll }));
        return true;
    } catch { return false; }
}

function restoreDevelopmentView(): void {
    if (!developmentEnabled) return;
    const state = readDevelopmentView();
    if (state) {
        for (const [id, value] of Object.entries(state.inputs)) {
            const input = document.getElementById(id) as HTMLInputElement | null;
            if (input) input.value = value;
        }
        onVodFilterInput();
        onStreamerListFilterChange();
        filterSettings(state.inputs.settingsSearchInput || '');
        setSettingsPane(state.settingsPane);
        showTab(state.tab);
        if (state.focus) document.getElementById(state.focus)?.focus({ preventScroll: true });
        requestAnimationFrame(() => {
            for (const [id, top] of Object.entries(state.scroll)) {
                const element = document.getElementById(id);
                if (element) element.scrollTop = top;
            }
        });
        localStorage.removeItem(developmentViewKey);
    }
    developmentRendererReady = true;
}
