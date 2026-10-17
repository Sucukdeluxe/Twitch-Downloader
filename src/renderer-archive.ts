let archivePageOffset = 0;
let archiveCriteriaKey = '';
let archiveRefreshRequested = false;
let archiveSearchInFlight = false;
let archiveSearchFailed = false;
let archiveSearchRequested = false;
let archiveSearchDebounceTimer: number | null = null;
let lastArchiveSearchResult: ArchiveSearchResult | null = null;
let lastArchiveFilterKey = '';
let archiveStreamerOptionsKey = '';
const archiveKnownStreamers = new Set<string>();
const archiveSelection = new Map<string, ArchiveSearchHit>();
let archiveActionInFlight = false;
let archiveUpdatesInitialized = false;
let archiveThumbnailObserver: IntersectionObserver | null = null;
let archiveThumbnailActive = 0;
let archiveThumbnailQueue: Array<{ element: HTMLElement; hit: ArchiveSearchHit; key: string }> = [];
const archiveThumbnailCache = new Map<string, string | null>();

function applyArchiveThumbnail(element: HTMLElement, source: string | null): void {
    if (!source || !source.startsWith('data:image/jpeg;base64,')) return;
    const image = document.createElement('img');
    image.alt = '';
    image.width = 256;
    image.height = 144;
    image.decoding = 'async';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = source;
    element.append(image);
}

function drainArchiveThumbnails(): void {
    while (archiveThumbnailActive < 2 && archiveThumbnailQueue.length) {
        const next = archiveThumbnailQueue.shift()!;
        if (!next.element.isConnected) continue;
        archiveThumbnailActive++;
        void window.api.getArchiveThumbnail(next.hit.fullPath).catch(() => null).then(source => {
            if (archiveThumbnailCache.size >= 256) archiveThumbnailCache.delete(archiveThumbnailCache.keys().next().value!);
            if (source) archiveThumbnailCache.set(next.key, source);
            if (next.element.isConnected) applyArchiveThumbnail(next.element, source);
        }).finally(() => {
            archiveThumbnailActive--;
            drainArchiveThumbnails();
        });
    }
}

function createArchiveThumbnail(hit: ArchiveSearchHit): HTMLElement {
    const element = archiveElement('div', 'archive-result-thumbnail');
    element.setAttribute('aria-hidden', 'true');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', 'M4 4h16v16H4z M10 8l6 4-6 4z');
    icon.append(shape);
    element.append(icon);
    const key = JSON.stringify([hit.fullPath, hit.size, hit.mtimeMs]);
    if (archiveThumbnailCache.has(key)) applyArchiveThumbnail(element, archiveThumbnailCache.get(key)!);
    else if (typeof window.api.getArchiveThumbnail === 'function') {
        const load = () => {
            archiveThumbnailQueue.push({ element, hit, key });
            drainArchiveThumbnails();
        };
        if (archiveThumbnailObserver) {
            element.addEventListener('archive-thumbnail-visible', load, { once: true });
            archiveThumbnailObserver.observe(element);
        } else queueMicrotask(load);
    }
    return element;
}

function resetArchiveThumbnails(results: HTMLElement): void {
    archiveThumbnailObserver?.disconnect();
    archiveThumbnailObserver = null;
    archiveThumbnailQueue = [];
    if (typeof IntersectionObserver === 'function') {
        archiveThumbnailObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                archiveThumbnailObserver?.unobserve(entry.target);
                entry.target.dispatchEvent(new Event('archive-thumbnail-visible'));
            }
        }, { root: results, rootMargin: '120px' });
    }
}

function archiveDateBoundary(id: string, end: boolean): number | null {
    const value = (document.getElementById(id) as HTMLInputElement | null)?.value;
    if (!value) return null;
    const date = new Date(value + 'T00:00:00');
    if (!Number.isFinite(date.getTime())) return null;
    if (end) date.setHours(23, 59, 59, 999);
    return date.getTime();
}

function refreshArchiveSelection(): void {
    const count = document.getElementById('archiveSelectedCount');
    if (count) count.textContent = formatUiNumber(archiveSelection.size);
    const merge = document.getElementById('archiveMergeSelected') as HTMLButtonElement | null;
    if (merge) merge.disabled = archiveActionInFlight || archiveSelection.size < 2;
    const clear = document.getElementById('archiveClearSelection') as HTMLButtonElement | null;
    if (clear) clear.disabled = archiveActionInFlight || !archiveSelection.size;
    const all = document.getElementById('archiveSelectPage') as HTMLInputElement | null;
    if (all) {
        const hits = lastArchiveSearchResult?.hits || [];
        const selected = hits.filter(hit => archiveSelection.has(hit.fullPath)).length;
        all.checked = hits.length > 0 && selected === hits.length;
        all.indeterminate = selected > 0 && selected < hits.length;
        all.disabled = archiveActionInFlight || !hits.length;
    }
}

function setArchivePageSelection(selected: boolean): void {
    for (const hit of lastArchiveSearchResult?.hits || []) {
        if (selected && archiveSelection.size < 500) archiveSelection.set(hit.fullPath, hit);
        else if (!selected) archiveSelection.delete(hit.fullPath);
    }
    if (lastArchiveSearchResult) renderArchiveSearchResults(lastArchiveSearchResult, true);
}

function clearArchiveSelection(): void {
    archiveSelection.clear();
    if (lastArchiveSearchResult) renderArchiveSearchResults(lastArchiveSearchResult, true);
}

async function editArchiveVideos(paths: string[], target: 'cutter' | 'merge'): Promise<void> {
    if (archiveActionInFlight || !paths.length || (target === 'cutter' && paths.length !== 1)) return;
    archiveActionInFlight = true;
    refreshArchiveSelection();
    try {
        const files = await window.api.prepareArchiveVideos(paths, target);
        if (files.length !== paths.length) throw new Error('File access denied');
        if (target === 'cutter') {
            showTab('cutter');
            await requestCutterVideoReplacement(files[0]);
        } else {
            await addArchiveToMerge(files);
        }
    } catch { showArchiveActionError(); }
    finally { archiveActionInFlight = false; refreshArchiveSelection(); }
}

function mergeArchiveSelection(): void {
    void editArchiveVideos([...archiveSelection.keys()], 'merge');
}

function populateArchiveStreamerSelect(): void {
    const select = document.getElementById('archiveSearchStreamer') as HTMLSelectElement | null;
    if (!select) return;
    const selected = select.value;
    const configured = (config.streamers as string[] | undefined) || [];
    const names = new Map<string, string>();
    for (const name of [...configured, ...archiveKnownStreamers, ...(selected ? [selected] : [])]) names.set(name.toLowerCase(), name);
    const sorted = [...names.values()].sort((left, right) => left.localeCompare(right, getIntlLocale()));
    const key = JSON.stringify([currentLanguage, sorted]);
    if (key === archiveStreamerOptionsKey) return;
    archiveStreamerOptionsKey = key;
    select.replaceChildren(new Option(UI_TEXT.static.archiveAllStreamers, ''), ...sorted.map(name => new Option(name, name)));
    select.value = sorted.find(name => name.toLowerCase() === selected.toLowerCase()) || '';
}

function getArchiveSearchFilter() {
    const criteria = {
        query: (document.getElementById('archiveSearchQuery') as HTMLInputElement | null)?.value.trim() || '',
        type: ((document.getElementById('archiveSearchType') as HTMLSelectElement | null)?.value || 'all') as 'all' | 'live' | 'vod' | 'clip' | 'chat' | 'events',
        streamer: (document.getElementById('archiveSearchStreamer') as HTMLSelectElement | null)?.value || '',
        sinceMs: archiveDateBoundary('archiveSearchSince', false),
        untilMs: archiveDateBoundary('archiveSearchUntil', true),
        sort: ((document.getElementById('archiveSearchSort') as HTMLSelectElement | null)?.value || 'date_desc') as 'date_desc' | 'date_asc' | 'size_desc' | 'size_asc' | 'name_asc',
        limit: 200
    };
    const key = JSON.stringify(criteria);
    if (key !== archiveCriteriaKey) { archivePageOffset = 0; archiveCriteriaKey = key; }
    return { ...criteria, offset: archivePageOffset };
}

function changeArchivePage(direction: number): void {
    if (archiveSearchInFlight || !lastArchiveSearchResult || Math.abs(direction) !== 1) return;
    archivePageOffset = Math.max(0, Math.min(archivePageOffset + direction * 200, Math.max(0, Math.ceil(lastArchiveSearchResult.matchCount / 200) - 1) * 200));
    void performArchiveSearch();
}

function renderArchivePagination(): void {
    const result = lastArchiveSearchResult;
    const pages = Math.max(1, Math.ceil((result?.matchCount || 0) / 200));
    const page = Math.floor((result?.offset ?? 0) / 200) + 1;
    const pager = byId<HTMLElement>('archivePagination');
    if (!pager) return;
    pager.style.visibility = pages > 1 ? 'visible' : 'hidden';
    pager.setAttribute('aria-label', currentLanguage === 'de' ? 'Archiv-Seiten' : 'Archive pages');
    byId<HTMLButtonElement>('archivePrevious').disabled = archiveSearchInFlight || archiveSearchFailed || page <= 1;
    byId<HTMLButtonElement>('archiveNext').disabled = archiveSearchInFlight || archiveSearchFailed || page >= pages;
    byId('archivePrevious').textContent = currentLanguage === 'de' ? 'Zurück' : 'Previous';
    byId('archiveNext').textContent = currentLanguage === 'de' ? 'Weiter' : 'Next';
    byId('archivePageLabel').textContent = currentLanguage === 'de' ? 'Seite ' + formatUiNumber(page) + ' von ' + formatUiNumber(pages) : 'Page ' + formatUiNumber(page) + ' of ' + formatUiNumber(pages);
}

function onArchiveSearchInput(): void {
    if (archiveSearchDebounceTimer !== null) window.clearTimeout(archiveSearchDebounceTimer);
    archiveSearchDebounceTimer = window.setTimeout(() => {
        archiveSearchDebounceTimer = null;
        void performArchiveSearch();
    }, 250);
}

async function performArchiveSearch(refresh = false): Promise<void> {
    archiveRefreshRequested ||= refresh;
    if (archiveSearchDebounceTimer !== null) {
        window.clearTimeout(archiveSearchDebounceTimer);
        archiveSearchDebounceTimer = null;
    }
    archiveSearchRequested = true;
    if (archiveSearchInFlight) return;
    const results = document.getElementById('archiveSearchResults');
    const summary = document.getElementById('archiveSearchSummary');
    const button = document.getElementById('btnArchiveSearch') as HTMLButtonElement | null;
    if (!results) return;
    archiveSearchInFlight = true;
    archiveSearchFailed = false;
    renderArchivePagination();
    results.setAttribute('aria-busy', 'true');
    if (!lastArchiveSearchResult) results.replaceChildren(archiveElement('div', 'insights-empty archive-empty', UI_TEXT.static.archiveSearching));
    if (button) button.disabled = true;
    try {
        do {
            archiveSearchRequested = false;
            populateArchiveStreamerSelect();
            const filter = getArchiveSearchFilter();
            const key = JSON.stringify(filter);
            if (summary) {
                summary.textContent = UI_TEXT.static.archiveSearching;
                summary.classList.remove('is-error');
            }
            try {
                const refresh = archiveRefreshRequested;
                archiveRefreshRequested = false;
                if (filter.sinceMs !== null && filter.untilMs !== null && filter.sinceMs > filter.untilMs) throw new Error(currentLanguage === 'de' ? 'Zeitraum prüfen.' : 'Check the date range.');
                const result = await window.api.searchArchive({ ...filter, refresh });
                if (key !== JSON.stringify(getArchiveSearchFilter())) archiveSearchRequested = true;
                if (archiveSearchRequested) continue;
                const preserveScroll = key === lastArchiveFilterKey;
                result.offset ??= filter.offset;
                archivePageOffset = result.offset;
                lastArchiveFilterKey = JSON.stringify(getArchiveSearchFilter());
                lastArchiveSearchResult = result;
                for (const streamer of result.streamers || result.hits.map(hit => hit.streamer)) archiveKnownStreamers.add(streamer);
                populateArchiveStreamerSelect();
                renderArchiveSearchResults(result, preserveScroll);
            } catch (error) {
                if (key !== JSON.stringify(getArchiveSearchFilter())) archiveSearchRequested = true;
                if (!archiveSearchRequested) archiveSearchFailed = true;
                if (!archiveSearchRequested && summary) {
                    summary.textContent = UI_TEXT.static.errorPrefix + ': ' + (error instanceof Error ? error.message : String(error));
                    summary.classList.add('is-error');
                }
            }
        } while (archiveSearchRequested);
    } finally {
        archiveSearchInFlight = false;
        results.setAttribute('aria-busy', 'false');
        if (archiveSearchFailed && !lastArchiveSearchResult) results.replaceChildren();
        if (button) button.disabled = false;
        renderArchivePagination();
    }
}

function refreshArchiveSearchTexts(): void {
    populateArchiveStreamerSelect();
    const texts = currentLanguage === 'de' ? { archiveSinceLabel: 'Von', archiveUntilLabel: 'Bis', archiveSelectPageLabel: 'Seite auswählen', archiveClearSelection: 'Auswahl aufheben', archiveMergeSelected: 'Zusammenfügen' } : { archiveSinceLabel: 'From', archiveUntilLabel: 'Until', archiveSelectPageLabel: 'Select page', archiveClearSelection: 'Clear selection', archiveMergeSelected: 'Merge' };
    for (const [id, text] of Object.entries(texts)) setText(id, text);
    if (lastArchiveSearchResult) renderArchiveSearchResults(lastArchiveSearchResult, true);
    if (archiveSearchInFlight) setText('archiveSearchSummary', UI_TEXT.static.archiveSearching);
}

function archiveElement(tag: string, className: string, text = ''): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
}

function renderArchiveSearchResults(result: ArchiveSearchResult, preserveScroll = false): void {
    const summary = document.getElementById('archiveSearchSummary');
    const results = document.getElementById('archiveSearchResults');
    if (!results) return;
    resetArchiveThumbnails(results);
    const visible = document.getElementById('archiveTab')?.classList.contains('active');
    const scrollTop = preserveScroll && !visible ? null
        : preserveScroll && result.rootExists && result.hits.length > 0 ? results.scrollTop : 0;
    summary?.classList.remove('is-error');
    renderArchivePagination();
    refreshArchiveSelection();
    if (!result.rootExists) {
        if (summary) summary.textContent = '';
        results.replaceChildren(archiveElement('div', 'insights-empty archive-empty', UI_TEXT.static.archiveNoRoot));
        return;
    }
    if (summary) {
        summary.textContent = (result.matchCount > 200 ? UI_TEXT.static.archiveSummaryTruncated : UI_TEXT.static.archiveSummary)
            .replace('{first}', formatUiNumber((result.offset ?? 0) + 1))
            .replace('{last}', formatUiNumber((result.offset ?? 0) + result.hits.length))
            .replace('{matchCount}', formatUiNumber(result.matchCount))
            .replace('{scanned}', formatUiNumber(result.totalScanned))
            .replace('{shown}', formatUiNumber(result.hits.length));
        if (result.refreshing) summary.textContent += currentLanguage === 'de' ? ' · Wird aktualisiert …' : ' · Updating …';
    }
    if (result.hits.length === 0) {
        results.replaceChildren(archiveElement('div', 'insights-empty archive-empty', UI_TEXT.static.archiveNoMatches));
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const hit of result.hits) {
        const row = archiveElement('article', 'archive-result-row');
        const selection = document.createElement('input');
        selection.type = 'checkbox';
        selection.className = 'archive-row-select';
        selection.checked = archiveSelection.has(hit.fullPath);
        selection.setAttribute('aria-label', (currentLanguage === 'de' ? 'Auswählen: ' : 'Select: ') + hit.fileName);
        selection.addEventListener('change', () => {
            if (selection.checked && archiveSelection.size < 500) archiveSelection.set(hit.fullPath, hit);
            else { archiveSelection.delete(hit.fullPath); selection.checked = false; }
            refreshArchiveSelection();
        });
        row.append(selection, createArchiveThumbnail(hit));
        const body = archiveElement('div', 'archive-result-body');
        const meta = archiveElement('div', 'archive-result-meta');
        const kind = hit.type === 'live' ? 'LIVE' : hit.type === 'clip' ? 'CLIP' : 'VOD';
        meta.append(archiveElement('span', 'archive-type-badge ' + hit.type, kind), archiveElement('strong', 'archive-result-streamer', hit.streamer));
        const filename = archiveElement('div', 'archive-result-filename', hit.fileName);
        filename.title = hit.fullPath;
        const details = archiveElement('div', 'archive-result-details');
        details.append(archiveElement('span', 'archive-result-date', formatUiDateTime(new Date(hit.mtimeMs))), archiveElement('span', 'archive-result-size', formatBytes(hit.size)));
        body.append(meta, filename, details);
        const actions = archiveElement('div', 'archive-result-actions');
        const action = (label: string, callback: () => void) => {
            const element = document.createElement('button');
            element.type = 'button';
            element.className = 'queue-detail-btn';
            element.textContent = label;
            element.addEventListener('click', callback);
            actions.append(element);
        };
        action(currentLanguage === 'de' ? 'Schneiden' : 'Edit', () => { void editArchiveVideos([hit.fullPath], 'cutter'); });
        action(UI_TEXT.static.archiveOpen, () => openFilePath(hit.fullPath));
        action(UI_TEXT.static.archiveShowInFolder, () => showFileInFolder(hit.fullPath));
        if (hit.chatPath) action(UI_TEXT.static.archiveViewChat, () => openEventsOrChat(hit.chatPath!, hit.fileName, 'chat'));
        if (hit.eventsPath) action(UI_TEXT.static.archiveViewEvents, () => openEventsOrChat(hit.eventsPath!, hit.fileName, 'events'));
        row.append(body, actions);
        fragment.append(row);
    }
    results.replaceChildren(fragment);
    if (scrollTop !== null) results.scrollTop = scrollTop;
}

function showArchiveActionError(): void {
    const summary = document.getElementById('archiveSearchSummary');
    if (!summary) return;
    summary.textContent = UI_TEXT.static.archiveActionFailed;
    summary.classList.add('is-error');
}

function openFilePath(filePath: string): void {
    void window.api.openFile(filePath).then(success => { if (!success) showArchiveActionError(); }).catch(showArchiveActionError);
}

function showFileInFolder(filePath: string): void {
    void window.api.showInFolder(filePath).then(success => { if (!success) showArchiveActionError(); }).catch(showArchiveActionError);
}

function openEventsOrChat(filePath: string, title: string, kind: 'chat' | 'events'): void {
    const api = window as unknown as { openEventsViewer?: (path: string, title: string) => void; openChatViewer?: (path: string, title: string) => void };
    const open = kind === 'events' ? api.openEventsViewer : api.openChatViewer;
    if (typeof open === 'function') open(filePath, title);
    else showArchiveActionError();
}

function initArchiveSearchInput(): void {
    if (!archiveUpdatesInitialized && typeof window.api.onArchiveIndexUpdated === 'function') {
        archiveUpdatesInitialized = true;
        window.api.onArchiveIndexUpdated(() => {
            if (document.getElementById('archiveTab')?.classList.contains('active')) void performArchiveSearch();
        });
    }
    const query = document.getElementById('archiveSearchQuery') as HTMLInputElement | null;
    if (query && !query.dataset.bound) {
        query.addEventListener('input', onArchiveSearchInput);
        query.addEventListener('keydown', event => { if (event.key === 'Enter') void performArchiveSearch(); });
        query.dataset.bound = '1';
    }
    for (const id of ['archiveSearchType', 'archiveSearchStreamer', 'archiveSearchSort', 'archiveSearchSince', 'archiveSearchUntil']) {
        const select = document.getElementById(id) as HTMLSelectElement | null;
        if (select && !select.dataset.bound) {
            select.addEventListener('change', () => { void performArchiveSearch(); });
            select.dataset.bound = '1';
        }
    }
}

Object.assign(window, { setArchivePageSelection, clearArchiveSelection, mergeArchiveSelection, changeArchivePage, performArchiveSearch, onArchiveSearchInput, openFilePath, showFileInFolder, openEventsOrChat, initArchiveSearchInput });
