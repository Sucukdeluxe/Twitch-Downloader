function renderRecordingHealthBadge(health: 'ok' | 'stale' | 'unknown' | undefined): string {
    if (!health) return '';
    const labels = UI_TEXT.queue.recordingHealth || { ok: 'Healthy', stale: 'Stalled', unknown: 'Pending data' };
    const cls = health === 'ok' ? 'health-ok' : (health === 'stale' ? 'health-stale' : 'health-unknown');
    const title = labels[health] || '';
    return `<span class="queue-health-dot ${cls}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`;
}

function renderQueueOmissions(item: QueueItem): string {
    const clip = item.customClip;
    if (!clip?.omissions) return '';
    try {
        const plan = window.VodPlayer.planEditedVod(clip.durationSec, clip.omissions.partDurationSec, clip.omissions.ranges, clip.startPart, clip.omissions.selection);
        const label = currentLanguage === 'de' ? 'Auslassungen' : 'Exclusions';
        const selection = clip.omissions.selection;
        const selected = selection ? `<div>${currentLanguage === 'de' ? 'Ausschnitt' : 'Excerpt'}: ${escapeHtml(formatClipTime(selection.start))}–${escapeHtml(formatClipTime(selection.end))}</div>` : '';
        return `<div class="queue-omissions">${selected}<strong>${escapeHtml(label)}:</strong> ${escapeHtml(plan.omitted.map(range => formatClipTime(range.start) + "–" + formatClipTime(range.end)).join(" · "))}</div>`;
    } catch { return ''; }
}

function renderQueueItemFileActions(item: QueueItem): string {
    if (item.status !== 'completed' || !item.outputFiles?.length) return '';
    const files = item.outputFiles.filter((file) => typeof file === 'string' && file.length > 0);
    const mediaFiles = files.filter((file) => !/\.(?:chat\.jsonl?|events\.jsonl)$/i.test(file));
    const first = mediaFiles[0] || files[0];
    if (!first) return '';
    const button = (action: string, file: string, label: string): string =>
        `<button type="button" class="queue-detail-btn" data-queue-file-action="${action}" data-queue-file-path="${escapeHtml(file)}" data-queue-file-title="${escapeHtml(item.title || item.streamer || '')}">${escapeHtml(label)}</button>`;
    const primary = mediaFiles.length === 1 ? [button('open', first, UI_TEXT.queue.openFile)] : [];
    primary.push(button('folder', first, UI_TEXT.queue.showInFolder));
    const secondary: string[] = [];
    const chatFile = files.find((file) => /\.chat\.jsonl?$/i.test(file));
    if (chatFile) secondary.push(button('chat', chatFile, UI_TEXT.queue.viewChat));
    const eventsFile = files.find((file) => /\.events\.jsonl$/i.test(file));
    if (eventsFile) secondary.push(button('events', eventsFile, UI_TEXT.queue.viewEvents));
    return `<div class="queue-output-row">${primary.join('')}</div>${secondary.length ? `<div class="queue-output-row queue-output-secondary">${secondary.join('')}</div>` : ''}`;
}

async function invokeOpenFile(filePath: string): Promise<void> {
    let ok: boolean;
    try {
        ok = await window.api.openFile(filePath);
    } catch {
        ok = false;
    }
    if (ok) return;
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) toast(UI_TEXT.queue.openFileFailed, 'warn');
}

async function invokeShowInFolder(filePath: string): Promise<void> {
    let ok: boolean;
    try {
        ok = await window.api.showInFolder(filePath);
    } catch {
        ok = false;
    }
    if (ok) return;
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) toast(UI_TEXT.queue.openFileFailed, 'warn');
}

async function invokeQueueFileAction(action: string, filePath: string, title = ''): Promise<void> {
    if (action === 'open') {
        await invokeOpenFile(filePath);
    } else if (action === 'folder') {
        await invokeShowInFolder(filePath);
    } else if (action === 'chat') {
        await openChatViewer(filePath, title);
    } else if (action === 'events') {
        await openEventsViewer(filePath, title);
    }
}

let queueActionsInitialized = false;

async function invokeQueueItemAction(action: string, id: string): Promise<void> {
    if (action === 'details') {
        toggleQueueDetails(id);
    } else if (action === 'remove') {
        await removeFromQueue(id);
    } else if (action === 'retry') {
        await retryQueueItem(id);
    } else if (action === 'copy-url') {
        const item = queue.find((candidate) => candidate.id === id);
        if (item) await copyQueueUrl(item.url);
    }
}

async function invokeQueueActionSafely(action: () => void | Promise<void>): Promise<void> {
    try {
        await action();
    } catch {
        const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
        if (toast) toast(UI_TEXT.queue.failed, 'warn');
    }
}

async function activateQueueControl(control: HTMLElement): Promise<void> {
    await invokeQueueActionSafely(async () => {
        const fileAction = control.dataset.queueFileAction;
        const filePath = control.dataset.queueFilePath;
        if (fileAction && filePath) {
            await invokeQueueFileAction(fileAction, filePath, control.dataset.queueFileTitle || '');
            return;
        }

        const action = control.dataset.queueAction;
        const item = control.closest<HTMLElement>('.queue-item');
        const id = item?.dataset.id;
        if (!action || !id) return;
        await invokeQueueItemAction(action, id);
    });
}

function resolveQueueControl(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>('[data-queue-action], [data-queue-file-action]');
}

function initQueueActions(): void {
    if (queueActionsInitialized) return;
    queueActionsInitialized = true;
    const list = byId('queueList');
    list.addEventListener('click', (event: MouseEvent) => {
        const control = resolveQueueControl(event.target);
        if (!control || !list.contains(control)) return;
        void activateQueueControl(control);
    });
    list.addEventListener('dblclick', (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest('button, a, input, select, textarea, [role="button"], [data-queue-action], [data-queue-file-action]')) return;
        const item = event.target.closest<HTMLElement>('.queue-item');
        if (!item?.dataset.id || !list.contains(item)) return;
        event.preventDefault();
        toggleQueueDetails(item.dataset.id);
    });
    list.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const control = resolveQueueControl(event.target);
        if (!control || !list.contains(control)) return;
        event.preventDefault();
        control.click();
    });
}

async function copyQueueUrl(url: string): Promise<void> {
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    try {
        await navigator.clipboard.writeText(url);
        if (toast) toast(UI_TEXT.queue.ctxCopiedUrl, 'info');
    } catch {
        if (toast) toast(UI_TEXT.queue.ctxCopyFailed, 'warn');
    }
}

function buildQueueFingerprint(url: string, streamer: string, date: string, customClip?: CustomClip, quality?: string): string {
    const clipFingerprint = customClip
        ? [
            'clip',
            customClip.startSec,
            customClip.durationSec,
            customClip.startPart,
            customClip.filenameFormat,
            (customClip.filenameTemplate || '').trim().toLowerCase(),
            customClip.omissions ? JSON.stringify(customClip.omissions) : ''
        ].join(':')
        : 'vod';

    return [
        (url || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, ''),
        (streamer || '').trim().toLowerCase(),
        (date || '').trim(),
        clipFingerprint,
        quality || 'source'
    ].join('|');
}

let lastQueueRenderFingerprint = '';

function getQueueItemFingerprint(item: QueueItem): string {
    return JSON.stringify([currentLanguage, getStreamerDisplayName(item.streamer), selectedQueueIds.indexOf(item.id), expandedQueueIds.has(item.id), item]);
}

function getQueueRenderFingerprint(items: QueueItem[]): string {
    return JSON.stringify([currentLanguage, selectedQueueIds, [...expandedQueueIds], items.map(getQueueItemFingerprint)]);
}

const queueRowCache = new Map<string, { element: HTMLElement; fingerprint: string }>();

function hasActiveQueueDuplicate(url: string, streamer: string, date: string, customClip?: CustomClip, quality?: string): boolean {
    const target = buildQueueFingerprint(url, streamer, date, customClip, quality);
    return queue.some((item) => {
        if (item.status !== 'pending' && item.status !== 'downloading' && item.status !== 'paused') {
            return false;
        }

        return buildQueueFingerprint(item.url, item.streamer, item.date, item.customClip, item.quality) === target;
    });
}

let vodQualityDialogOpen = false;

interface SelectedVodQuality { id: string; label: string }

async function chooseVodQuality(url: string, title: string): Promise<SelectedVodQuality | null> {
    if (vodQualityDialogOpen) return null;
    vodQualityDialogOpen = true;
    const english = currentLanguage === 'en';
    const dialog = document.createElement('dialog');
    dialog.className = 'vod-quality-dialog';
    dialog.setAttribute('aria-labelledby', 'vodQualityTitle');
    const heading = document.createElement('h2');
    heading.id = 'vodQualityTitle';
    heading.textContent = english ? 'Video quality' : 'Videoqualität';
    const subtitle = document.createElement('p');
    subtitle.className = 'vod-quality-subtitle';
    subtitle.textContent = title;
    const status = document.createElement('p');
    status.className = 'vod-quality-status';
    status.setAttribute('role', 'status');
    const options = document.createElement('div');
    options.className = 'vod-quality-options';
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-labelledby', heading.id);
    const actions = document.createElement('div');
    actions.className = 'vod-quality-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn-secondary';
    cancel.autofocus = true;
    cancel.textContent = english ? 'Cancel' : 'Abbrechen';
    const retry = document.createElement('button');
    retry.className = 'btn-secondary';
    retry.textContent = english ? 'Retry' : 'Erneut versuchen';
    retry.hidden = true;
    const confirm = document.createElement('button');
    confirm.className = 'btn-primary';
    confirm.textContent = english ? 'Add to queue' : 'Zur Warteschlange';
    confirm.disabled = true;
    actions.append(cancel, retry, confirm);
    dialog.append(heading, subtitle, options, actions);
    document.body.append(dialog);
    let selected = 'source';
    let requestId = '';
    let settled = false;
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    return await new Promise<SelectedVodQuality | null>(resolve => {
        let selectedQuality: SelectedVodQuality = { id: 'source', label: 'Source' };
        const finish = (value: SelectedVodQuality | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(loadingTimer);
            void window.api.cancelVodQualities(requestId).catch(() => {});
            dialog.close();
            dialog.remove();
            vodQualityDialogOpen = false;
            resolve(value);
        };
        const load = async (): Promise<void> => {
            requestId = crypto.randomUUID();
            const id = requestId;
            confirm.disabled = true;
            retry.hidden = true;
            options.replaceChildren(status);
            options.setAttribute('aria-busy', 'true');
            for (let index = 0; index < 7; index++) {
                const placeholder = document.createElement('div');
                placeholder.className = 'vod-quality-placeholder';
                placeholder.setAttribute('aria-hidden', 'true');
                const radio = document.createElement('span');
                radio.className = 'vod-quality-placeholder-radio';
                placeholder.append(radio);
                options.append(placeholder);
            }
            status.hidden = false;
            status.classList.add('is-loading');
            status.textContent = english ? 'Loading qualities…' : 'Qualitäten laden…';
            clearTimeout(loadingTimer);
            loadingTimer = setTimeout(() => {
                if (!settled && requestId === id) status.textContent = english ? 'Still waiting for Twitch…' : 'Warte auf Twitch…';
            }, 4000);
            try {
                const qualities = await window.api.getVodQualities({ id, url });
                if (settled || requestId !== id) return;
                if (!qualities?.length) throw new Error('No qualities');
                selected = 'source';
                selectedQuality = qualities.find(quality => quality.id === selected) || { id: 'source', label: 'Source' };
                options.replaceChildren();
                for (const quality of qualities) {
                    const label = document.createElement('label');
                    label.className = 'vod-quality-option';
                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = 'vod-quality';
                    radio.value = quality.id;
                    radio.checked = quality.id === selected;
                    radio.addEventListener('change', () => { selected = quality.id; selectedQuality = quality; });
                    const text = document.createElement('span');
                    text.className = 'vod-quality-description';
                    const name = document.createElement('strong');
                    const details = document.createElement('span');
                    details.className = 'vod-quality-details';
                    const parts = quality.label.split(' · ');
                    name.textContent = quality.id === 'source' ? 'Source' : parts[0];
                    details.textContent = parts.slice(1).join(' · ');
                    if (quality.id === 'source') label.classList.add('is-source');
                    text.append(name);
                    if (details.textContent) text.append(details);
                    label.append(radio, text);
                    options.append(label);
                }
                status.textContent = '';
                confirm.disabled = false;
            } catch {
                if (settled || requestId !== id) return;
                status.textContent = english ? 'Could not load the available qualities.' : 'Qualitäten konnten nicht geladen werden.';
                options.replaceChildren(status);
                retry.hidden = false;
            } finally {
                if (requestId === id) {
                    clearTimeout(loadingTimer);
                    status.classList.remove('is-loading');
                    options.setAttribute('aria-busy', 'false');
                }
            }
        };
        cancel.addEventListener('click', () => finish(null));
        confirm.addEventListener('click', () => { if (!confirm.disabled) finish(selectedQuality); });
        retry.addEventListener('click', () => { void load(); });
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
        dialog.addEventListener('close', () => finish(null));
        dialog.addEventListener('keydown', event => event.stopPropagation());
        dialog.showModal();
        void load();
    });
}

async function addToQueue(url: string, title: string, date: string, streamer: string, duration: string): Promise<void> {
    const selectedQuality = await chooseVodQuality(url, title);
    if (!selectedQuality) return;
    if ((config.prevent_duplicate_downloads as boolean) !== false && hasActiveQueueDuplicate(url, streamer, date, undefined, selectedQuality.id)) {
        alert(UI_TEXT.queue.duplicateSkipped);
        return;
    }

    try {
        const result = await window.api.addToQueueWithResult({ url, title, date, streamer, duration_str: duration, quality: selectedQuality.id, qualityLabel: selectedQuality.label });
        queue = result.queue;
        renderQueue();
        if (!result.accepted) {
            alert(result.reason === 'duplicate' ? UI_TEXT.queue.duplicateSkipped : currentLanguage === 'en' ? 'Could not add the download. Please try again.' : 'Einreihen fehlgeschlagen. Bitte erneut versuchen.');
        }
    } catch {
        alert(currentLanguage === 'en' ? 'Could not add the download. Please try again.' : 'Einreihen fehlgeschlagen. Bitte erneut versuchen.');
    }
}

async function removeFromQueue(id: string): Promise<void> {
    queue = await window.api.removeFromQueue(id);
    renderQueue();
}

async function clearCompleted(): Promise<void> {
    queue = await window.api.clearCompleted();
    renderQueue();
}

async function retryFailedDownloads(): Promise<void> {
    queue = await window.api.retryFailedDownloads();
    renderQueue();
}

async function retryQueueItem(id: string): Promise<void> {
    queue = await window.api.retryQueueItem(id);
    renderQueue();
}

let queueContextMenuInitialized = false;
let activeQueueContextMenu: HTMLElement | null = null;
let activeQueueContextMenuInvoker: HTMLElement | null = null;
let activeQueueContextMenuCleanup: ((restoreFocus?: boolean) => void) | null = null;

function closeQueueContextMenu(restoreFocus = false): void {
    const cleanup = activeQueueContextMenuCleanup;
    if (cleanup) {
        activeQueueContextMenuCleanup = null;
        cleanup(restoreFocus);
        return;
    }
    if (!activeQueueContextMenu) return;
    activeQueueContextMenu.remove();
    activeQueueContextMenu = null;
    const invoker = activeQueueContextMenuInvoker;
    activeQueueContextMenuInvoker = null;
    if (restoreFocus && invoker?.isConnected) invoker.focus();
}

function installQueueContextMenuDismissal(menu: HTMLElement, cleanupMenu: (restoreFocus: boolean) => void): (restoreFocus?: boolean) => void {
    let cleaned = false;
    let cleanup: (restoreFocus?: boolean) => void;
    const dismissOnClick = (event: MouseEvent) => {
        if (event.target instanceof Node && menu.contains(event.target)) return;
        cleanup();
    };
    const dismissOnScroll = () => cleanup();
    cleanup = (restoreFocus = false): void => {
        if (cleaned) return;
        cleaned = true;
        document.removeEventListener('mousedown', dismissOnClick, true);
        document.removeEventListener('scroll', dismissOnScroll, true);
        cleanupMenu(restoreFocus);
    };
    document.addEventListener('mousedown', dismissOnClick, true);
    document.addEventListener('scroll', dismissOnScroll, true);
    return cleanup;
}

function initQueueContextMenu(): void {
    if (queueContextMenuInitialized) return;
    queueContextMenuInitialized = true;

    const list = byId('queueList');
    list.addEventListener('contextmenu', (e: MouseEvent) => {
        const itemEl = (e.target as HTMLElement).closest('.queue-item') as HTMLElement | null;
        if (!itemEl) return;
        const id = itemEl.dataset.id;
        if (!id) return;
        const item = queue.find((i) => i.id === id);
        if (!item) return;
        e.preventDefault();
        showQueueContextMenu(e.clientX, e.clientY, item, e.target as HTMLElement);
    });
    list.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
        const target = e.target as HTMLElement;
        const itemEl = target.closest('.queue-item') as HTMLElement | null;
        const id = itemEl?.dataset.id;
        const item = id ? queue.find((candidate) => candidate.id === id) : null;
        if (!item || !itemEl) return;
        e.preventDefault();
        const rect = itemEl.getBoundingClientRect();
        showQueueContextMenu(rect.left + 12, rect.top + 12, item, target);
    });
}

function showQueueContextMenu(x: number, y: number, item: QueueItem, invoker: HTMLElement | null): void {
    closeQueueContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    const makeItem = (label: string, onClick: () => void | Promise<void>, disabled = false): HTMLElement => {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = label;
        el.className = 'context-menu-item' + (disabled ? ' disabled' : '');
        el.setAttribute('role', 'menuitem');
        if (disabled) {
            el.setAttribute('aria-disabled', 'true');
            el.disabled = true;
        }
        if (!disabled) {
            el.addEventListener('click', () => {
                closeQueueContextMenu();
                void invokeQueueActionSafely(onClick);
            });
        }
        return el;
    };

    const makeSeparator = (): HTMLElement => {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        sep.setAttribute('role', 'separator');
        return sep;
    };

    const isPending = item.status === 'pending' || item.status === 'paused';
    const isFailed = item.status === 'error' && !item.mergeRecoveryBlocked;
    const isCompleted = item.status === 'completed';
    const canSelectForMerge = item.status === 'pending' && !item.mergeGroup && !item.isLive && !item.customClip;

    if (canSelectForMerge) {
        const isSelectedForMerge = selectedQueueIds.includes(item.id);
        const mergeSelectionItem = makeItem(
            isSelectedForMerge ? UI_TEXT.queue.ctxRemoveFromMerge : UI_TEXT.queue.ctxSelectForMerge,
            () => toggleQueueSelection(item.id)
        );
        mergeSelectionItem.dataset.queueAction = 'merge-select';
        menu.appendChild(mergeSelectionItem);
        menu.appendChild(makeSeparator());
    }

    if (isPending) {
        menu.appendChild(makeItem(UI_TEXT.queue.ctxMoveTop, () => moveQueueItemTo(item.id, 'top')));
        menu.appendChild(makeItem(UI_TEXT.queue.ctxMoveBottom, () => moveQueueItemTo(item.id, 'bottom')));
        menu.appendChild(makeSeparator());
    }

    if (isFailed) {
        menu.appendChild(makeItem(UI_TEXT.queue.retryItem, () => retryQueueItem(item.id)));
        menu.appendChild(makeSeparator());
    }

    if (isCompleted && item.outputFiles && item.outputFiles.length > 0) {
        const first = item.outputFiles[0];
        if (item.outputFiles.length === 1) {
            menu.appendChild(makeItem(UI_TEXT.queue.openFile, () => invokeOpenFile(first)));
        }
        menu.appendChild(makeItem(UI_TEXT.queue.showInFolder, () => invokeShowInFolder(first)));
        menu.appendChild(makeSeparator());
    }

    menu.appendChild(makeItem(UI_TEXT.queue.ctxCopyUrl, () => copyQueueUrl(item.url)));
    menu.appendChild(makeItem(UI_TEXT.queue.ctxOpenOnTwitch, () => window.api.openExternal(item.url)));
    menu.appendChild(makeSeparator());
    menu.appendChild(makeItem(UI_TEXT.queue.ctxRemove, () => removeFromQueue(item.id)));

    document.body.appendChild(menu);
    activeQueueContextMenu = menu;
    activeQueueContextMenuInvoker = invoker;

    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4);
    if (top + rect.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - rect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    let cleanup: (restoreFocus?: boolean) => void;
    cleanup = installQueueContextMenuDismissal(menu, (restoreFocus) => {
        if (activeQueueContextMenuCleanup === cleanup) activeQueueContextMenuCleanup = null;
        if (activeQueueContextMenu === menu) {
            activeQueueContextMenu = null;
            const currentInvoker = activeQueueContextMenuInvoker;
            activeQueueContextMenuInvoker = null;
            menu.remove();
            if (restoreFocus && currentInvoker?.isConnected) currentInvoker.focus();
            return;
        }
        menu.remove();
    });
    activeQueueContextMenuCleanup = cleanup;
    RendererAccessibility.installMenuKeyboardNavigation(menu, () => closeQueueContextMenu(true));
    RendererAccessibility.focusFirstMenuItem(menu);
}

async function moveQueueItemTo(id: string, where: 'top' | 'bottom'): Promise<void> {
    const idx = queue.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const reordered = [...queue];
    const [moved] = reordered.splice(idx, 1);
    if (where === 'top') reordered.unshift(moved);
    else reordered.push(moved);
    queue = reordered;
    renderQueue();
    await window.api.reorderQueue(reordered.map((i) => i.id));
}

function renderQueueStatusIcon(status: QueueItem['status']): string {
    const paths: Record<QueueItem['status'], string> = {
        pending: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
        downloading: '<path d="M12 4v12m-5-5 5 5 5-5M5 20h14"/>',
        paused: '<path d="M9 5v14M15 5v14"/>',
        completed: '<path d="m5 12 4 4L19 6"/>',
        error: '<circle cx="12" cy="12" r="8"/><path d="M12 7v6m0 4h.01"/>'
    };
    return `<svg class="queue-status-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[status]}</svg>`;
}

function getQueueStatusLabel(item: QueueItem): string {
    if (item.status === 'completed') return UI_TEXT.queue.statusDone;
    if (item.status === 'error') return UI_TEXT.queue.statusFailed;
    if (item.status === 'paused') return UI_TEXT.queue.statusPaused;
    if (item.status === 'downloading') return UI_TEXT.queue.statusRunning;
    return UI_TEXT.queue.statusWaiting;
}

function getQueueProgressStatusText(item: QueueItem): string {
    if (item.status === 'error' && item.last_error) {
        return item.last_error;
    }

    if (item.status === 'pending') return UI_TEXT.queue.readyToDownload;
    if (item.status === 'paused') return UI_TEXT.queue.statusPaused;
    if (item.status === 'completed') return UI_TEXT.queue.done;
    if (item.status === 'error') return UI_TEXT.queue.failed;
    if (item.status === 'downloading' && item.progressStatus) {
        const downloadedSize = item.progressStatus.match(/^([\d.,]+\s(?:B|KB|MB|GB|TB)) (?:downloaded|heruntergeladen)$/);
        const text = downloadedSize ? downloadedSize[1] : item.progressStatus;
        return item.progressPhase && item.currentPart && item.totalParts && item.totalParts > 1
            ? `${UI_TEXT.queue.part} ${item.currentPart}/${item.totalParts} · ${text}` : text;
    }
    if (item.currentPart && item.totalParts) {
        return `${UI_TEXT.queue.part} ${item.currentPart}/${item.totalParts}`;
    }
    if (item.status === 'downloading') return UI_TEXT.queue.started;
    return UI_TEXT.queue.failed;
}

function getQueueProgressMetricsText(item: QueueItem): string {
    const parts: string[] = [];
    if (item.status === 'completed') parts.push('100%');
    if ((item.status === 'downloading' || item.status === 'paused') && item.progress > 0 && item.progressPhase !== 'finalizing') {
        parts.push(`${Math.max(0, Math.min(100, item.progress)).toFixed(1)}%`);
    }
    if (item.status === 'downloading' && item.speed) parts.push(item.speed);
    if (item.status === 'downloading' && item.eta) parts.push(item.eta);
    return parts.join(' | ');
}

interface QueueProgressDetail {
    key: string;
    label: string;
    value: string;
}

function formatQueueTransferValue(value: string): string {
    const match = value.trim().match(/^([\d.,]+)\s+(B|KB|MB|GB|TB)(\/s)?$/i);
    if (!match) return value.trim() || '–';
    const number = Number(match[1].replace(',', '.'));
    return Number.isFinite(number) ? number.toLocaleString(getIntlLocale(), { maximumFractionDigits: 2 }) + ' ' + match[2] + (match[3] || '') : value;
}

function formatQueueEta(value: string): string {
    const units: Array<[RegExp, string]> = [[/(\d+)h/, 'h'], [/(\d+)m/, 'min'], [/(\d+)s/, 's']];
    const parts = units.flatMap(([pattern, label]) => {
        const match = value.match(pattern);
        return match && Number(match[1]) > 0 ? [formatUiNumber(Number(match[1])) + ' ' + label] : [];
    });
    return parts.join(' ') || (/\d+[hms]/.test(value) ? '0 s' : value.trim() || '–');
}

function getQueueProgressDetails(item: QueueItem): QueueProgressDetail[] {
    if (item.status === 'pending' || item.status === 'completed') return [];
    const de = currentLanguage === 'de';
    if (item.status === 'error') return [{ key: 'message', label: de ? 'Fehler:' : 'Error:', value: getQueueProgressStatusText(item) }];
    const sizeMatch = item.progressStatus?.match(/[\d.,]+\s+(?:B|KB|MB|GB|TB)\b/i);
    const bytes = Number.isFinite(item.downloadedBytes) && item.downloadedBytes! >= 0 ? formatBytesRenderer(item.downloadedBytes!) : sizeMatch?.[0];
    const size = bytes ? formatQueueTransferValue(bytes) : '';
    if (item.progressPhase === 'finalizing') {
        return [{ key: 'message', label: 'Status:', value: getQueueProgressStatusText(item) }, ...(size ? [{ key: 'size', label: de ? 'Geladen:' : 'Downloaded:', value: size }] : [])];
    }
    const progress = item.progress >= 0 && Number.isFinite(item.progress) ? Math.min(100, item.progress).toLocaleString(getIntlLocale(), { maximumFractionDigits: 1 }) + ' %' : '';
    const time = item.progressStatus?.match(/\d{1,4}:\d{2}:\d{2}\s*\/\s*\d{1,4}:\d{2}:\d{2}/)?.[0];
    const rows = [
        { key: 'progress', label: de ? 'Fortschritt:' : 'Progress:', value: [progress, size].filter(Boolean).join(' · ') || '–' },
        { key: 'time', label: de ? 'Videozeit:' : 'Video time:', value: time || '–' }
    ];
    if (item.currentPart && item.totalParts && item.totalParts > 1) rows.push({ key: 'part', label: UI_TEXT.queue.part + ':', value: formatUiNumber(item.currentPart) + ' / ' + formatUiNumber(item.totalParts) });
    if (item.status === 'downloading') rows.push(
        { key: 'speed', label: de ? 'Tempo:' : 'Speed:', value: formatQueueTransferValue(item.speed || '') },
        { key: 'eta', label: de ? 'Restzeit:' : 'Remaining:', value: formatQueueEta(item.eta || '') }
    );
    return rows;
}

function renderQueueProgressDetails(item: QueueItem): string {
    return getQueueProgressDetails(item).map(({ key, label, value }) => `<div class="queue-progress-row"><span class="queue-progress-label">${escapeHtml(label)}</span><span class="queue-progress-value${key === 'message' ? ' queue-progress-message queue-progress-status' : key === 'time' ? ' queue-progress-status' : key === 'progress' ? ' queue-progress-metrics' : ''}" data-queue-progress-value="${key}">${escapeHtml(value)}</span></div>`).join('');
}

function syncQueueProgressDetails(element: HTMLElement, item: QueueItem): void {
    const container = element.querySelector<HTMLElement>('.queue-progress-info');
    if (!container) return;
    const rows = getQueueProgressDetails(item);
    const values = container.querySelectorAll<HTMLElement>('[data-queue-progress-value]');
    if (values.length !== rows.length || rows.some((row, index) => values[index].dataset.queueProgressValue !== row.key)) {
        container.innerHTML = renderQueueProgressDetails(item);
        return;
    }
    values.forEach((value, index) => {
        if (value.textContent !== rows[index].value) value.textContent = rows[index].value;
    });
}

function toggleQueueSelection(id: string): void {
    const index = selectedQueueIds.indexOf(id);
    if (index >= 0) {
        selectedQueueIds.splice(index, 1);
    } else {
        selectedQueueIds.push(id);
    }
    renderQueue();
    updateMergeGroupButton();
}

function updateMergeGroupButton(): void {
    const btn = byId<HTMLButtonElement>('btnMergeGroup');
    if (!btn) return;

    // Clean up selections: only keep IDs that are still pending in queue
    const validIds = new Set(
        queue.filter(item => item.status === 'pending' && !item.mergeGroup && !item.isLive && !item.customClip).map(item => item.id)
    );
    selectedQueueIds = selectedQueueIds.filter(id => validIds.has(id));

    if (selectedQueueIds.length >= 2) {
        btn.classList.remove('is-hidden');
        btn.textContent = `${UI_TEXT.mergeGroup.btn} (${selectedQueueIds.length})`;
        btn.disabled = false;
    } else {
        btn.classList.add('is-hidden');
    }
}

async function createMergeGroupFromSelection(): Promise<void> {
    if (selectedQueueIds.length < 2) return;

    const ids = [...selectedQueueIds];
    selectedQueueIds = [];
    queue = await window.api.createMergeGroup(ids);
    renderQueue();
    updateMergeGroupButton();
}

function syncQueueRecordingHealth(el: HTMLElement, item: QueueItem): void {
    const current = el.querySelector<HTMLElement>('.queue-health-dot');
    const health = item.isLive && item.status === 'downloading' ? item.recordingHealth : undefined;
    if (!health) {
        current?.remove();
        return;
    }

    const labels = UI_TEXT.queue.recordingHealth || { ok: 'Healthy', stale: 'Stalled', unknown: 'Pending data' };
    const className = health === 'ok' ? 'health-ok' : (health === 'stale' ? 'health-stale' : 'health-unknown');
    const label = labels[health] || '';
    let badge = current;
    if (!badge) {
        const title = el.querySelector<HTMLElement>('.title');
        if (!title) return;
        badge = document.createElement('span');
        const liveBadge = title.querySelector<HTMLElement>('.queue-live-badge');
        if (liveBadge) liveBadge.insertAdjacentElement('afterend', badge);
        else title.prepend(badge);
    }
    badge.className = `queue-health-dot ${className}`;
    badge.title = label;
    badge.setAttribute('aria-label', label);
}

function updateQueueItemProgress(progress: DownloadProgress): void {
    const progressId = String(progress.id ?? '');
    if (!progressId) return;
    const list = byId<HTMLElement>('queueList');
    const el = queueRowCache.get(progressId)?.element || Array.from(list.querySelectorAll<HTMLElement>('.queue-item'))
        .find((candidate) => candidate.dataset.id === progressId) || null;
    if (!el) return;

    const item = queue.find(i => String(i.id) === progressId);
    if (!item) return;

    if (item.status !== 'pending' && selectedQueueIds.includes(item.id)) {
        renderQueue();
        return;
    }

    const bar = el.querySelector('.queue-progress-bar') as HTMLElement | null;
    const wrap = el.querySelector('.queue-progress-wrap') as HTMLElement | null;

    if (bar) {
        const isDeterminate = item.progressPhase !== 'finalizing' && item.progress > 0 && item.progress <= 100;
        const pct = isDeterminate ? Math.min(100, item.progress) : 0;
        bar.style.width = `${pct}%`;
        bar.className = 'queue-progress-bar' + (item.progressPhase === 'finalizing' ? ' is-finalizing' : '');
        if (wrap) {
            if (isDeterminate) wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
            else wrap.removeAttribute('aria-valuenow');
            wrap.setAttribute('aria-valuetext', getQueueProgressStatusText(item));
        }
    }
    syncQueueProgressDetails(el, item);
    el.draggable = item.status === 'pending';
    const badge = el.querySelector<HTMLElement>('.queue-status-badge');
    const label = badge?.querySelector<HTMLElement>('.queue-status-label');
    const indicator = badge?.querySelector<HTMLElement>('.status');
    if (badge) badge.title = getQueueProgressStatusText(item);
    if (label) label.textContent = getQueueStatusLabel(item);
    if (indicator && indicator.className !== 'status ' + item.status) {
        indicator.className = 'status ' + item.status;
        indicator.innerHTML = renderQueueStatusIcon(item.status);
    }
    wrap?.setAttribute('aria-label', getQueueStatusLabel(item));
    wrap?.setAttribute('aria-description', getQueueProgressMetricsText(item));
    el.querySelector('.queue-progress-info')?.classList.toggle('is-hidden', item.status === 'pending' || item.status === 'completed');
    if (item.status !== 'error') el.querySelector('.queue-retry-btn')?.remove();
    syncQueueRecordingHealth(el, item);
}

function toggleQueueDetails(id: string): void {
    if (expandedQueueIds.has(id)) {
        expandedQueueIds.delete(id);
    } else {
        expandedQueueIds.add(id);
    }
    const item = Array.from(byId<HTMLElement>('queueList').querySelectorAll<HTMLElement>('.queue-item'))
        .find((candidate) => candidate.dataset.id === id);
    const details = item?.querySelector<HTMLElement>('.queue-details');
    if (details) {
        if (expandedQueueIds.has(id) && !details.firstElementChild) {
            const entry = queue.find(candidate => candidate.id === id);
            if (entry) details.innerHTML = renderQueueDetails(entry);
            details.getBoundingClientRect();
        }
        details.classList.toggle('expanded', expandedQueueIds.has(id));
        details.inert = !expandedQueueIds.has(id);
    }
    item?.querySelector('[data-queue-action="details"]')?.setAttribute('aria-expanded', String(expandedQueueIds.has(id)));
}

function initQueueDragDrop(): void {
    if (queueDragDropInitialized) return;
    queueDragDropInitialized = true;

    const list = byId('queueList');

    list.addEventListener('dragstart', (e: DragEvent) => {
        const el = (e.target as HTMLElement).closest('.queue-item') as HTMLElement;
        if (!el) return;
        // Prevent dragging items that are no longer pending (race window between status change and re-render)
        const itemId = el.dataset.id;
        if (itemId) {
            const item = queue.find(i => i.id === itemId);
            if (!item || item.status !== 'pending') {
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'none';
                    e.dataTransfer.clearData();
                }
                return;
            }
        }
        draggedQueueItemId = el.dataset.id || null;
        el.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    list.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    list.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        const target = (e.target as HTMLElement).closest('.queue-item') as HTMLElement;
        if (!target || !draggedQueueItemId) return;
        const targetId = target.dataset.id;
        if (!targetId || targetId === draggedQueueItemId) return;

        const fromIdx = queue.findIndex(i => i.id === draggedQueueItemId);
        const toIdx = queue.findIndex(i => i.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = queue.splice(fromIdx, 1);
        queue.splice(toIdx, 0, moved);
        window.api.reorderQueue(queue.map(i => i.id));
        renderQueue();
    });

    list.addEventListener('dragend', () => {
        draggedQueueItemId = null;
        document.querySelectorAll('.queue-item.dragging').forEach(el => el.classList.remove('dragging'));
    });
}

function renderQueue(): void {
    if (!Array.isArray(queue)) {
        queue = [];
    }

    const list = byId('queueList');
    initQueueActions();
    byId('queueCount').textContent = formatUiNumber(queue.length);
    const retryBtn = byId<HTMLButtonElement>('btnRetryFailed');
    const clearBtn = byId<HTMLButtonElement>('btnClear');
    const hasFailed = queue.some((item) => item.status === 'error' && !item.mergeRecoveryBlocked);
    const hasCompleted = queue.some((item) => item.status === 'completed');
    retryBtn.disabled = !hasFailed;
    clearBtn.disabled = !hasCompleted;
    updateDownloadButtonState();

    updateMergeGroupButton();
    const renderFingerprint = getQueueRenderFingerprint(queue);
    if (renderFingerprint === lastQueueRenderFingerprint) {
        return;
    }

    if (queue.length === 0) {
        lastQueueRenderFingerprint = renderFingerprint;
        // Build the empty state via createElement to keep the renderer
        // clean of inline-style HTML strings (which the lint hook
        // flags as a potential XSS surface). The CSS for .queue-empty
        // lives in styles.css.
        queueRowCache.clear();
        list.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'queue-empty';
        empty.textContent = UI_TEXT.queue.empty;
        list.appendChild(empty);
        return;
    }

    const ids = new Set(queue.map(item => item.id));
    for (const [id, cached] of queueRowCache) {
        if (!ids.has(id)) {
            cached.element.remove();
            queueRowCache.delete(id);
        }
    }
    list.querySelector('.queue-empty')?.remove();
    const template = document.createElement('template');
    queue.forEach((item, index) => {
        const fingerprint = getQueueItemFingerprint(item);
        let cached = queueRowCache.get(item.id);
        if (!cached || cached.fingerprint !== fingerprint) {
            template.innerHTML = renderQueueItem(item);
            const element = template.content.firstElementChild as HTMLElement;
            if (cached) {
                const active = cached.element.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
                const action = active?.dataset.queueAction;
                cached.element.replaceWith(element);
                if (action) element.querySelector<HTMLElement>('[data-queue-action="' + action + '"]')?.focus({ preventScroll: true });
            }
            cached = { element, fingerprint };
            queueRowCache.set(item.id, cached);
        }
        if (list.children[index] !== cached.element) list.insertBefore(cached.element, list.children[index] || null);
    });

    initQueueContextMenu();
    lastQueueRenderFingerprint = renderFingerprint;
}

function renderQueueItem(item: QueueItem): string {
    const safeTitle = escapeHtml(item.title || UI_TEXT.vods.untitled);
    const safeStatusLabel = escapeHtml(getQueueStatusLabel(item));
    const safeProgressStatus = escapeHtml(getQueueProgressStatusText(item));
    const safeProgressMetrics = escapeHtml(getQueueProgressMetricsText(item));
    const safeDate = escapeHtml(formatUiDate(item.date));
    const isClip = item.customClip ? '* ' : '';
    const hasDeterminateProgress = item.progressPhase !== 'finalizing' && item.progress > 0 && item.progress <= 100;
    const progressValue = item.status === 'completed'
        ? 100
        : (hasDeterminateProgress ? Math.max(0, Math.min(100, item.progress)) : 0);

    const isMergeGroup = !!item.mergeGroup;
    const selectionIndex = selectedQueueIds.indexOf(item.id);
    const isSelected = selectionIndex >= 0;
    const selectionPosition = selectionIndex + 1;
    const selectionTitle = escapeHtml(UI_TEXT.queue.mergeSelectionPosition.replace('{position}', String(selectionPosition)));
    const mergeIcon = isMergeGroup
        ? '<svg class="merge-group-icon" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg> '
        : '';
    const liveBadge = item.isLive
        ? `<span class="queue-live-badge" title="${escapeHtml(UI_TEXT.queue.liveRecordingTitle)}">REC</span> `
        : '';
    const healthBadge = (item.isLive && item.status === 'downloading')
        ? renderRecordingHealthBadge(item.recordingHealth)
        : '';
    const mergeMetaExtra = isMergeGroup
        ? escapeHtml(UI_TEXT.mergeGroup.metaLabel.replace('{count}', formatUiNumber(item.mergeGroup!.items.length)))
        : '';
    const detailsId = `queue-details-${encodeURIComponent(item.id)}`;

    return `
        <div class="queue-item${isMergeGroup ? ' merge-group' : ''}${isSelected ? ' merge-selected' : ''}" draggable="${item.status === 'pending' ? 'true' : 'false'}" data-id="${escapeHtml(item.id)}">
            ${isSelected ? `<span class="queue-selection-order" title="${selectionTitle}" aria-label="${selectionTitle}">${selectionPosition}</span>` : ''}
            <div class="queue-main">
                <div class="queue-title-row">
                    <div class="title" title="${safeTitle}">${liveBadge}${healthBadge}${mergeIcon}${isClip}${safeTitle}</div>
                    ${item.status === 'error' && !item.mergeRecoveryBlocked ? `<button class="queue-retry-btn" type="button" title="${escapeHtml(UI_TEXT.queue.retryItem)}" aria-label="${escapeHtml(UI_TEXT.queue.retryItem)}" data-queue-action="retry">&#x21bb;</button>` : ''}
                    <button class="remove" type="button" title="${escapeHtml(UI_TEXT.queue.removeItem)}" aria-label="${escapeHtml(UI_TEXT.queue.removeItem)}" data-queue-action="remove"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg></button>
                </div>
                ${mergeMetaExtra ? `<div class="queue-meta">${mergeMetaExtra}</div>` : ''}
                <div class="queue-progress-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${item.progressPhase === 'finalizing' ? '' : `aria-valuenow="${Math.round(progressValue)}"`} aria-valuetext="${safeProgressStatus}" aria-description="${safeProgressMetrics}" aria-label="${escapeHtml(safeStatusLabel)}">
                    <div class="queue-progress-bar${item.progressPhase === 'finalizing' ? ' is-finalizing' : ''}" style="width: ${progressValue}%;"></div>
                </div>
                <button class="queue-footer queue-details-toggle" type="button" aria-label="${escapeHtml(UI_TEXT.queue.toggleDetails)}" aria-describedby="${detailsId}-status ${detailsId}-date" aria-expanded="${expandedQueueIds.has(item.id) ? 'true' : 'false'}" aria-controls="${detailsId}" data-queue-action="details">
                    <span class="queue-status-badge" title="${safeProgressStatus}"><span class="status ${item.status}" aria-hidden="true">${renderQueueStatusIcon(item.status)}</span><span class="queue-status-label" id="${detailsId}-status">${safeStatusLabel}</span></span>
                    <time class="queue-date" id="${detailsId}-date" datetime="${escapeHtml(item.date)}">${safeDate}</time>
                    <svg class="queue-details-chevron" aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg>
                </button>
                <div class="queue-progress-info${item.status === 'pending' || item.status === 'completed' ? ' is-hidden' : ''}">
                    ${renderQueueProgressDetails(item)}
                </div>
                <div class="queue-details${expandedQueueIds.has(item.id) ? ' expanded' : ''}" id="${detailsId}"${expandedQueueIds.has(item.id) ? '' : ' inert'}>
                    ${expandedQueueIds.has(item.id) || queueRowCache.get(item.id)?.element.querySelector('.queue-details-content') ? renderQueueDetails(item) : ''}
                </div>
            </div>
        </div>
    `;

}

async function toggleDownload(): Promise<void> {
    if (downloading) {
        await window.api.pauseDownload();
        return;
    }

    const started = await window.api.startDownload();
    if (!started) {
        renderQueue();
        alert(UI_TEXT.queue.emptyAlert);
    }
}

function formatQueueQuality(source: Pick<QueueItem, 'quality' | 'qualityLabel'>): string {
    const id = source.quality || 'source';
    const isSource = id === 'source' || id === 'best';
    const label = source.qualityLabel || '';
    const resolution = (isSource ? label : id).match(/(\d{3,4})p/i) || label.match(/(\d{3,4})p/i);
    const suffix = resolution ? resolution.input!.slice(resolution.index! + resolution[0].length) : '';
    const fps = suffix.match(/^\d{1,3}/)?.[0] || label.match(/[\d.]+ ?fps/i)?.[0].replace(/ ?fps/i, '');
    const details = resolution ? resolution[1] + 'p' + (fps ? ' ' + fps + 'fps' : '') : '';
    if (isSource) return details ? 'Source / ' + details : 'Source';
    return details || label || id;
}

function formatQueueDuration(item: QueueItem): string {
    const clip = item.customClip;
    let duration = clip?.durationSec;
    if (clip?.omissions) {
        try {
            duration = window.VodPlayer.planEditedVod(clip.durationSec, clip.omissions.partDurationSec, clip.omissions.ranges, clip.startPart, clip.omissions.selection).duration;
        } catch {
            return '–';
        }
    }
    if (duration === undefined) {
        const sources = item.mergeGroup?.items || [item];
        duration = sources.reduce((total, source) => total + parseDurationToSeconds(source.duration_str || ''), 0);
    }
    return Number.isFinite(duration) && duration > 0 ? formatSecondsToTime(Math.round(duration)) : item.duration_str || '–';
}

function formatQueueDate(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '–';
    return formatUiDate(date) + ' | ' + date.toLocaleTimeString(getIntlLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function formatQueueUrl(value: string): string {
    try {
        const url = new URL(value);
        return /^(?:www\.)?twitch\.tv$/i.test(url.hostname) ? url.pathname : value;
    } catch {
        return value;
    }
}

function renderQueueDetails(item: QueueItem): string {
    const quality = [...new Set((item.mergeGroup?.items || [item]).map(source => formatQueueQuality(source)))].join(' · ');
    const row = (label: string, value: string, className = ''): string =>
        `<div class="queue-detail-row"><span class="queue-detail-label">${escapeHtml(label)}</span><span class="queue-detail-value ${className}" title="${escapeHtml(value)}">${escapeHtml(value)}</span></div>`;
    return `<div class="queue-details-clip"><div class="queue-details-content">
        ${row(UI_TEXT.queue.detailStreamer, getStreamerDisplayName(item.streamer), 'queue-streamer-name')}
        <div class="queue-detail-row queue-url-row"><span class="queue-detail-label">URL:</span><button class="queue-url-copy" type="button" data-queue-action="copy-url" aria-label="${escapeHtml(UI_TEXT.queue.ctxCopyUrl)}" title="${escapeHtml(UI_TEXT.queue.ctxCopyUrl)}: ${escapeHtml(item.url)}">${escapeHtml(formatQueueUrl(item.url))}</button></div>
        ${row(UI_TEXT.queue.detailDuration, formatQueueDuration(item))}
        ${row(UI_TEXT.queue.detailDate, formatQueueDate(item.date))}
        ${row(currentLanguage === 'en' ? 'Quality:' : 'Qualität:', quality)}
        ${renderQueueOmissions(item)}
        ${renderQueueItemFileActions(item)}
    </div></div>`;
}
