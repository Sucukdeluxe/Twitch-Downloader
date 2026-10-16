let updateCheckInProgress = false;
let updateDownloadInProgress = false;
let updateDownloadOperation: { failureHandled: boolean } | null = null;
let manualUpdateCheckPending = false;
let manualUpdateOutcomeHandled = false;
let latestUpdateVersion = '';
let latestUpdateInfo: UpdateInfo | null = null;
let latestDownloadProgress: UpdateDownloadProgress | null = null;
let updateBannerState: 'idle' | 'available' | 'downloading' | 'ready' = 'idle';
let updateChangelogExpanded = false;
let shouldOpenUpdateModalOnAvailable = false;
let workspaceUpdatePopoverPostponed = false;

const SKIPPED_UPDATE_VERSION_KEY = 'twitch-vod-manager:skipped-update-version';

function getSkippedUpdateVersion(): string {
    return safeLocalStorageGet(SKIPPED_UPDATE_VERSION_KEY);
}

function persistSkippedUpdateVersion(version: string): void {
    safeLocalStorageSet(SKIPPED_UPDATE_VERSION_KEY, version);
}

function clearSkippedUpdateVersion(): void {
    safeLocalStorageRemove(SKIPPED_UPDATE_VERSION_KEY);
}

function notifyUpdate(message: string, type: 'info' | 'warn' = 'info'): void {
    const toastFn = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (typeof toastFn === 'function') {
        toastFn(message, type);
    } else if (type === 'warn') {
        alert(message);
    }
}

function rememberUpdateInfo(info?: UpdateInfo | null): UpdateInfo | null {
    const version = (info?.version || latestUpdateVersion || latestUpdateInfo?.version || '').trim();
    if (!version) return null;
    latestUpdateVersion = version;
    latestUpdateInfo = {
        ...(latestUpdateInfo?.version === version ? latestUpdateInfo : { version }),
        ...(info || {}),
        version
    };
    return latestUpdateInfo;
}

function getActiveUpdateInfo(): UpdateInfo | null {
    return rememberUpdateInfo();
}

function formatUpdateTemplate(template: string, version: string): string {
    return template.replace(/\{version\}/g, version);
}

function formatReleaseDate(dateValue?: string): string {
    if (!dateValue) {
        return '';
    }

    const parsed = new Date(dateValue);
    if (Number.isNaN(parsed.getTime())) {
        return '';
    }

    const locale = getIntlLocale();
    const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(parsed);
    return `${date} · ${time}`;
}

function setCheckButtonCheckingState(enabled: boolean): void {
    const btn = byId<HTMLButtonElement>('checkUpdateBtn');
    btn.disabled = enabled;
    btn.textContent = enabled ? UI_TEXT.updates.checking : UI_TEXT.static.checkUpdates;

    const workspaceButton = byId<HTMLButtonElement>('workspaceUpdateButton');
    workspaceButton.disabled = enabled;
    if (enabled) {
        byId('updateBanner').dataset.updateState = 'checking';
        byId('workspaceUpdateLabel').textContent = UI_TEXT.updates.checking;
        workspaceButton.removeAttribute('title');
        workspaceButton.setAttribute('aria-label', UI_TEXT.updates.checking);
    } else {
        syncWorkspaceUpdateState(updateBannerState);
    }
}

function syncWorkspaceUpdateExpansion(): void {
    const button = byId<HTMLButtonElement>('workspaceUpdateButton');
    button.removeAttribute('aria-expanded');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'updateModal');
}

function syncWorkspaceUpdateState(state: 'idle' | 'available' | 'downloading' | 'ready'): void {
    const banner = byId('updateBanner');
    const button = byId<HTMLButtonElement>('workspaceUpdateButton');
    const label = byId('workspaceUpdateLabel');
    const description = byId('updateText').textContent?.trim() || UI_TEXT.static.checkUpdates;

    banner.dataset.updateState = state;
    banner.hidden = state === 'idle';
    button.dataset.updateState = state;
    button.disabled = false;
    button.removeAttribute('aria-disabled');
    label.textContent = state === 'ready' ? UI_TEXT.updates.installNow : 'Update';
    button.removeAttribute('title');
    button.setAttribute('aria-label', state === 'idle' ? UI_TEXT.static.checkUpdates : description);
    syncWorkspaceUpdateExpansion();
    byId<HTMLButtonElement>('workspaceUpdateLater').hidden = state === 'idle' || state === 'downloading';
    byId<HTMLButtonElement>('workspaceUpdateDismiss').hidden = state === 'idle';
}

function showUpdateBanner(): void {
    byId('updateBanner').classList.toggle('show', !workspaceUpdatePopoverPostponed);
    syncWorkspaceUpdateState(updateBannerState);
}

function focusWorkspaceAfterUpdateHidden(): void {
    document.querySelector<HTMLElement>('.top-nav-item[aria-current="page"]')?.focus();
}

function hideUpdateBanner(): void {
    updateBannerState = 'idle';
    workspaceUpdatePopoverPostponed = false;
    const banner = byId('updateBanner');
    const progress = byId('updateProgress');
    const bar = byId('updateProgressBar');
    const action = byId<HTMLButtonElement>('updateButton');

    banner.classList.remove('show');
    banner.classList.remove('popover-dismissed');
    progress.classList.add('is-hidden');
    bar.classList.remove('downloading');
    bar.style.width = '0%';
    byId('updateProgressGauge').setAttribute('aria-valuenow', '0');
    byId('updateText').textContent = UI_TEXT.static.checkUpdates;
    action.textContent = UI_TEXT.updates.downloadNow;
    action.disabled = false;
    syncWorkspaceUpdateState('idle');
}

function postponeWorkspaceUpdatePopover(): void {
    workspaceUpdatePopoverPostponed = true;
    const banner = byId('updateBanner');
    banner.classList.remove('show');
    banner.classList.add('popover-dismissed');
    byId<HTMLButtonElement>('workspaceUpdateButton').setAttribute('aria-expanded', 'false');
    focusWorkspaceAfterUpdateHidden();
}

function dismissWorkspaceUpdatePopover(): void {
    if (updateBannerState === 'downloading') {
        postponeWorkspaceUpdatePopover();
        return;
    }

    hideUpdateBanner();
    focusWorkspaceAfterUpdateHidden();
}

for (const eventName of ['mouseenter', 'mouseleave', 'focusin', 'focusout']) {
    byId('updateBanner').addEventListener(eventName, () => {
        window.requestAnimationFrame(syncWorkspaceUpdateExpansion);
    });
}

function handleWorkspaceUpdateAction(): void {
    if (updateCheckInProgress) {
        return;
    }

    if (updateBannerState === 'available' || updateBannerState === 'ready' || updateBannerState === 'downloading') {
        const info = getActiveUpdateInfo();
        if (info) openUpdateModal(info);
        return;
    }

    void checkUpdate();
}

function setUpdateBannerAvailableUi(info: UpdateInfo, reveal = true): void {
    const activeInfo = rememberUpdateInfo(info);
    if (!activeInfo) return;
    updateReady = false;
    updateDownloadInProgress = false;
    latestDownloadProgress = null;
    updateBannerState = 'available';
    if (reveal) {
        workspaceUpdatePopoverPostponed = false;
        byId('updateBanner').classList.remove('popover-dismissed');
    }

    showUpdateBanner();
    byId('updateProgress').classList.add('is-hidden');

    const bar = byId('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = '0%';

    byId('updateText').textContent = `Version ${activeInfo.version} ${UI_TEXT.updates.available}`;
    const button = byId<HTMLButtonElement>('updateButton');
    button.textContent = UI_TEXT.updates.downloadNow;
    button.disabled = false;
    syncWorkspaceUpdateState('available');
}

function setDownloadPendingUi(reveal = true): void {
    updateReady = false;
    updateBannerState = 'downloading';
    if (reveal) {
        workspaceUpdatePopoverPostponed = false;
        byId('updateBanner').classList.remove('popover-dismissed');
    }

    showUpdateBanner();
    const button = byId<HTMLButtonElement>('updateButton');
    button.textContent = UI_TEXT.updates.downloading;
    button.disabled = true;
    byId('updateProgress').classList.remove('is-hidden');

    const bar = byId('updateProgressBar');
    bar.classList.add('downloading');
    const pendingPct = latestDownloadProgress ? latestDownloadProgress.percent : 30;
    bar.style.width = `${pendingPct}%`;
    byId('updateProgressGauge').setAttribute('aria-valuenow', String(Math.round(pendingPct)));

    if (!latestDownloadProgress) {
        byId('updateText').textContent = latestUpdateVersion
            ? `Version ${latestUpdateVersion} ${UI_TEXT.updates.downloading}`
            : UI_TEXT.updates.downloading;
    }
    syncWorkspaceUpdateState('downloading');
    refreshUpdateModalDownloadState();
}

function setDownloadReadyUi(info?: UpdateInfo): void {
    const activeInfo = rememberUpdateInfo(info);
    if (!activeInfo) return;
    updateReady = true;
    updateDownloadInProgress = false;
    updateDownloadOperation = null;
    updateBannerState = 'ready';
    workspaceUpdatePopoverPostponed = false;
    byId('updateBanner').classList.remove('popover-dismissed');
    latestDownloadProgress = null;
    showUpdateBanner();

    const bar = byId('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = '100%';
    byId('updateProgressGauge').setAttribute('aria-valuenow', '100');

    byId('updateProgress').classList.remove('is-hidden');
    byId('updateText').textContent = `Version ${activeInfo.version} ${UI_TEXT.updates.ready}`;
    const button = byId<HTMLButtonElement>('updateButton');
    button.textContent = UI_TEXT.updates.installNow;
    button.disabled = false;
    syncWorkspaceUpdateState('ready');
    refreshUpdateModalDownloadState();
}

function appendInlineMarkdown(target: HTMLElement, text: string): void {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);

    for (const part of parts) {
        if (!part) {
            continue;
        }

        const strongMatch = part.match(/^\*\*(.+)\*\*$/);
        if (strongMatch) {
            const strong = document.createElement('strong');
            strong.textContent = strongMatch[1].trim();
            target.appendChild(strong);
            continue;
        }

        target.appendChild(document.createTextNode(part));
    }
}

function renderUpdateChangelog(notes?: string): void {
    const card = byId<HTMLElement>('updateChangelogCard');
    const panel = byId<HTMLElement>('updateChangelogPanel');
    const content = byId<HTMLElement>('updateChangelogContent');
    const empty = byId<HTMLElement>('updateChangelogEmpty');
    const normalized = (notes || '').replace(/\r/g, '').trim();

    content.innerHTML = '';
    empty.hidden = true;

    if (!normalized) {
        card.classList.add('is-hidden');
        panel.classList.remove('is-expanded');
        panel.setAttribute('aria-hidden', 'true');
        panel.inert = true;
        updateChangelogExpanded = false;
        return;
    }

    card.classList.remove('is-hidden');

    const fragment = document.createDocumentFragment();
    let currentList: HTMLUListElement | null = null;
    let lastBlockWasHeading = false;

    const flushList = (): void => {
        currentList = null;
    };

    const ensureList = (): HTMLUListElement => {
        if (currentList) {
            return currentList;
        }

        currentList = document.createElement('ul');
        currentList.className = 'update-changelog-list';
        fragment.appendChild(currentList);
        return currentList;
    };

    const appendListItem = (line: string): void => {
        const item = document.createElement('li');
        appendInlineMarkdown(item, line);
        ensureList().appendChild(item);
    };

    for (const rawLine of normalized.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            flushList();
            lastBlockWasHeading = false;
            continue;
        }

        const boldHeadingMatch = line.match(/^\*\*(.+?)\*\*:?$/);
        const markdownHeadingMatch = line.match(/^#{1,6}\s+(.+)$/);
        if (boldHeadingMatch || markdownHeadingMatch) {
            flushList();
            const heading = document.createElement('h4');
            heading.className = 'update-changelog-heading';
            heading.textContent = (boldHeadingMatch?.[1] || markdownHeadingMatch?.[1] || '').trim();
            fragment.appendChild(heading);
            lastBlockWasHeading = true;
            continue;
        }

        const listMatch = line.match(/^(?:[-*+]\s+|\d+\.\s+)(.+)$/);
        if (listMatch) {
            appendListItem(listMatch[1].trim());
            lastBlockWasHeading = false;
            continue;
        }

        if (lastBlockWasHeading) {
            appendListItem(line);
            lastBlockWasHeading = false;
            continue;
        }

        flushList();
        const paragraph = document.createElement('p');
        paragraph.className = 'update-changelog-paragraph';
        appendInlineMarkdown(paragraph, line);
        fragment.appendChild(paragraph);
        lastBlockWasHeading = false;
    }

    if (!fragment.childNodes.length) {
        empty.hidden = false;
    } else {
        content.appendChild(fragment);
    }

    panel.classList.toggle('is-expanded', updateChangelogExpanded);
    panel.setAttribute('aria-hidden', String(!updateChangelogExpanded));
    panel.inert = !updateChangelogExpanded;
}

function refreshUpdateChangelogToggleText(): void {
    const toggle = byId<HTMLButtonElement>('updateChangelogToggle');
    const card = byId<HTMLElement>('updateChangelogCard');
    if (card.classList.contains('is-hidden')) {
        return;
    }

    toggle.setAttribute('aria-label', updateChangelogExpanded ? UI_TEXT.updates.hideChangelog : UI_TEXT.updates.showChangelog);
    toggle.setAttribute('aria-expanded', String(updateChangelogExpanded));
}

function refreshUpdateModalTexts(): void {
    const info = getActiveUpdateInfo();
    if (!info) return;
    const isReady = updateReady;

    byId('updateModalTitle').textContent = isReady
        ? UI_TEXT.updates.modalReadyTitle
        : UI_TEXT.updates.modalAvailableTitle;
    byId('updateModalMessage').textContent = formatUpdateTemplate(
        isReady ? UI_TEXT.updates.modalReadyMessage : UI_TEXT.updates.modalAvailableMessage,
        info.version
    );
    byId('updateModalDismissBtn').textContent = UI_TEXT.updates.modalDismiss;
    byId('updateModalConfirmText').textContent = isReady
        ? UI_TEXT.updates.modalInstallConfirm
        : UI_TEXT.updates.modalDownloadConfirm;
    // Skip-version only makes sense before the download. Once the .exe is
    // already on disk and ready to install, hide the button.
    const skipBtn = byId<HTMLButtonElement>('updateModalSkipBtn');
    skipBtn.textContent = UI_TEXT.updates.modalSkipVersion;
    skipBtn.classList.toggle('is-hidden', isReady);
    byId('updateChangelogLabel').textContent = UI_TEXT.updates.changelogLabel;
    byId('updateChangelogEmpty').textContent = UI_TEXT.updates.noChangelog;

    byId('updateInstalledVersion').textContent = appVersion;
    byId('updateAvailableVersion').textContent = info.version;
    byId('updateReleaseVersion').textContent = `Version ${info.version}`;
    byId('updatePreserveText').textContent = UI_TEXT.updates.preserveData;
    const metaText = formatReleaseDate(info.releaseDate);
    const meta = byId<HTMLTimeElement>('updateModalMeta');
    meta.textContent = metaText;
    meta.classList.toggle('is-hidden', !metaText);
    if (metaText && info.releaseDate) meta.dateTime = new Date(info.releaseDate).toISOString();
    else meta.removeAttribute('datetime');

    renderUpdateChangelog(info.releaseNotes);
    refreshUpdateChangelogToggleText();
    refreshUpdateModalDownloadState();
}

function refreshUpdateModalDownloadState(): void {
    const downloading = updateBannerState === 'downloading';
    const confirm = byId<HTMLButtonElement>('updateModalConfirmBtn');
    confirm.disabled = downloading;
    byId('updateModalConfirmText').textContent = downloading
        ? UI_TEXT.updates.downloading
        : updateReady ? UI_TEXT.updates.modalInstallConfirm : UI_TEXT.updates.modalDownloadConfirm;
    byId('updateModalSkipBtn').classList.toggle('is-hidden', downloading || updateReady);
    byId('updateModalProgress').classList.toggle('is-hidden', !downloading);
    byId('updateModalProgressLabel').textContent = UI_TEXT.updates.downloadLabel;
    const percent = Math.max(0, Math.min(100, latestDownloadProgress?.percent || 0));
    byId('updateModalProgressPercent').textContent = latestDownloadProgress ? `${Math.round(percent)} %` : '…';
    byId('updateModalProgressFill').style.width = `${percent}%`;
    const gauge = byId('updateModalProgressGauge');
    gauge.setAttribute('aria-label', UI_TEXT.updates.downloadLabel);
    if (latestDownloadProgress) gauge.setAttribute('aria-valuenow', String(Math.round(percent)));
    else gauge.removeAttribute('aria-valuenow');
}

let updateModalAnchorTop = 24;
let updateModalCollapsedHeight = 0;
let updateModalResizeObserver: ResizeObserver | null = null;

function positionUpdateModal(): void {
    const overlay = byId<HTMLElement>('updateModal');
    const dialog = overlay.querySelector<HTMLElement>('.update-modal');
    if (!dialog || !overlay.classList.contains('show')) return;
    const panel = byId<HTMLElement>('updateChangelogPanel');
    const fixedHeight = dialog.offsetHeight - panel.offsetHeight;
    dialog.style.setProperty('--update-fixed-height', `${fixedHeight}px`);
    const top = Math.max(24, Math.min(updateModalAnchorTop, window.innerHeight - dialog.offsetHeight - 24));
    dialog.style.top = `${top}px`;
}

function anchorUpdateModal(): void {
    const dialog = byId<HTMLElement>('updateModal').querySelector<HTMLElement>('.update-modal');
    if (!dialog) return;
    const panel = byId<HTMLElement>('updateChangelogPanel');
    panel.style.transition = 'none';
    updateModalCollapsedHeight = dialog.offsetHeight;
    dialog.style.setProperty('--update-fixed-height', `${updateModalCollapsedHeight}px`);
    panel.style.removeProperty('transition');
    updateModalAnchorTop = Math.max(24, (window.innerHeight - updateModalCollapsedHeight) / 2);
    if (!updateModalResizeObserver) {
        updateModalResizeObserver = new ResizeObserver(positionUpdateModal);
        updateModalResizeObserver.observe(dialog);
        window.addEventListener('resize', () => {
            updateModalAnchorTop = Math.max(24, (window.innerHeight - updateModalCollapsedHeight) / 2);
            positionUpdateModal();
        });
    }
    positionUpdateModal();
}

function openUpdateModal(info?: UpdateInfo): void {
    if (!rememberUpdateInfo(info)) return;
    updateChangelogExpanded = false;
    RendererAccessibility.openDialog('updateModal', { onEscape: dismissUpdateModal });
    refreshUpdateModalTexts();
    anchorUpdateModal();
    resetUpdateChangelogScroll();
}

function dismissUpdateModal(): void {
    RendererAccessibility.closeDialog('updateModal');
}

function skipUpdateVersion(): void {
    const v = (latestUpdateInfo?.version || latestUpdateVersion || '').trim();
    if (v) {
        persistSkippedUpdateVersion(v);
    }
    dismissUpdateModal();
    hideUpdateBanner();
    updateBannerState = 'idle';
    // Note: latestUpdateInfo is intentionally kept so a manual "Check for
    // updates" can still re-surface the same version if the user changes
    // their mind (manual checks bypass the skip-version filter).
}

function confirmUpdateModal(): void {
    if (updateReady) {
        dismissUpdateModal();
        void window.api.installUpdate();
        return;
    }

    downloadUpdate();
}

function resetUpdateChangelogScroll(): void {
    const content = byId<HTMLElement>('updateChangelogPanel').querySelector<HTMLElement>('.update-changelog-panel-inner');
    if (content) content.scrollTop = 0;
}

function toggleUpdateChangelog(): void {
    const card = byId<HTMLElement>('updateChangelogCard');
    if (card.classList.contains('is-hidden')) {
        return;
    }

    updateChangelogExpanded = !updateChangelogExpanded;
    if (!updateChangelogExpanded) resetUpdateChangelogScroll();
    const panel = byId<HTMLElement>('updateChangelogPanel');
    panel.classList.toggle('is-expanded', updateChangelogExpanded);
    panel.setAttribute('aria-hidden', String(!updateChangelogExpanded));
    panel.inert = !updateChangelogExpanded;
    refreshUpdateChangelogToggleText();
}

function handleUpdateModalOverlayClick(event: MouseEvent): void {
    if (event.target === byId('updateModal')) {
        dismissUpdateModal();
    }
}

function refreshUpdateUiTexts(): void {
    const button = byId<HTMLButtonElement>('updateButton');
    const progress = byId('updateProgress');
    const bar = byId('updateProgressBar');

    if (updateBannerState === 'available' && latestUpdateInfo) {
        setUpdateBannerAvailableUi(latestUpdateInfo, false);
    } else if (updateBannerState === 'downloading') {
        button.textContent = UI_TEXT.updates.downloading;
        button.disabled = true;
        progress.classList.remove('is-hidden');
        if (latestDownloadProgress) {
            bar.classList.remove('downloading');
            bar.style.width = `${latestDownloadProgress.percent}%`;
            const mb = (latestDownloadProgress.transferred / 1024 / 1024).toFixed(1);
            const totalMb = (latestDownloadProgress.total / 1024 / 1024).toFixed(1);
            byId('updateText').textContent = `${UI_TEXT.updates.downloadLabel}: ${mb} / ${totalMb} MB (${latestDownloadProgress.percent.toFixed(0)}%)`;
        } else {
            setDownloadPendingUi(false);
        }
    } else if (updateBannerState === 'ready' && latestUpdateInfo) {
        setDownloadReadyUi(latestUpdateInfo);
    } else {
        hideUpdateBanner();
        progress.classList.add('is-hidden');
        bar.classList.remove('downloading');
        bar.style.width = '0%';
        byId('updateText').textContent = UI_TEXT.static.checkUpdates;
        button.textContent = UI_TEXT.updates.downloadNow;
        button.disabled = false;
    }

    refreshUpdateModalTexts();
}

async function checkUpdateSilent(): Promise<void> {
    try {
        shouldOpenUpdateModalOnAvailable = true;
        await window.api.checkUpdate();
    } catch {
        shouldOpenUpdateModalOnAvailable = false;
        // ignore silent updater errors
    }
}

async function checkUpdate(): Promise<void> {
    manualUpdateCheckPending = true;
    manualUpdateOutcomeHandled = false;
    shouldOpenUpdateModalOnAvailable = true;
    setCheckButtonCheckingState(true);

    try {
        const result = await window.api.checkUpdate();

        if (result?.error) {
            const alreadyHandled = manualUpdateOutcomeHandled;
            shouldOpenUpdateModalOnAvailable = false;
            manualUpdateOutcomeHandled = true;
            manualUpdateCheckPending = false;
            updateCheckInProgress = false;
            setCheckButtonCheckingState(false);
            if (!alreadyHandled) notifyUpdate(UI_TEXT.updates.checkFailed, 'warn');
            return;
        }

        const skippedReason = result?.skipped;
        if (skippedReason === 'ready-to-install') {
            shouldOpenUpdateModalOnAvailable = false;
            manualUpdateOutcomeHandled = true;
            manualUpdateCheckPending = false;
            updateCheckInProgress = false;
            setCheckButtonCheckingState(false);
            if (latestUpdateInfo || updateReady) {
                const info = getActiveUpdateInfo();
                if (info) openUpdateModal(info);
            } else {
                notifyUpdate(UI_TEXT.updates.readyToInstall, 'info');
            }
            return;
        }

        if (skippedReason === 'downloading') {
            shouldOpenUpdateModalOnAvailable = false;
            manualUpdateOutcomeHandled = true;
            manualUpdateCheckPending = false;
            updateCheckInProgress = false;
            setCheckButtonCheckingState(false);
            notifyUpdate(UI_TEXT.updates.downloadInProgress, 'info');
            return;
        }

        if (skippedReason === 'in-progress' || skippedReason === 'throttled' || skippedReason === 'timed-out') {
            shouldOpenUpdateModalOnAvailable = false;
            manualUpdateOutcomeHandled = true;
            manualUpdateCheckPending = false;
            updateCheckInProgress = false;
            setCheckButtonCheckingState(false);
            notifyUpdate(UI_TEXT.updates.checkInProgress, 'info');
            return;
        }

        manualUpdateCheckPending = false;
        updateCheckInProgress = false;
        setCheckButtonCheckingState(false);

        window.setTimeout(() => {
            if (!manualUpdateOutcomeHandled && !updateReady && !byId('updateBanner').classList.contains('show')) {
                shouldOpenUpdateModalOnAvailable = false;
                notifyUpdate(UI_TEXT.updates.latest, 'info');
            }
        }, 2500);
    } catch {
        shouldOpenUpdateModalOnAvailable = false;
        manualUpdateOutcomeHandled = true;
        manualUpdateCheckPending = false;
        updateCheckInProgress = false;
        setCheckButtonCheckingState(false);
        notifyUpdate(UI_TEXT.updates.checkFailed, 'warn');
    }
}

function handleUpdateDownloadFailure(operation: { failureHandled: boolean }): void {
    if (operation.failureHandled) {
        return;
    }

    operation.failureHandled = true;
    if (operation !== updateDownloadOperation) {
        return;
    }

    updateDownloadOperation = null;
    updateDownloadInProgress = false;
    latestDownloadProgress = null;
    if (latestUpdateInfo) {
        setUpdateBannerAvailableUi(latestUpdateInfo, false);
    } else {
        hideUpdateBanner();
    }
    refreshUpdateModalDownloadState();
    notifyUpdate(UI_TEXT.updates.downloadFailed, 'warn');
}

function downloadUpdate(): void {
    if (updateReady) {
        dismissUpdateModal();
        void window.api.installUpdate();
        return;
    }

    if (updateDownloadInProgress) {
        notifyUpdate(UI_TEXT.updates.downloadInProgress, 'info');
        return;
    }

    updateDownloadInProgress = true;
    const operation = { failureHandled: false };
    updateDownloadOperation = operation;
    latestDownloadProgress = null;
    setDownloadPendingUi();

    void window.api.downloadUpdate().then((result) => {
        if (result?.error) {
            handleUpdateDownloadFailure(operation);
            return;
        }

        if (result?.skipped === 'ready-to-install') {
            const info = getActiveUpdateInfo();
            if (info) {
                setDownloadReadyUi(info);
                openUpdateModal(info);
            }
            return;
        }

        if (result?.skipped === 'in-progress') {
            notifyUpdate(UI_TEXT.updates.downloadInProgress, 'info');
        }
    }).catch(() => {
        handleUpdateDownloadFailure(operation);
    });
}

window.api.onUpdateChecking(() => {
    if (updateDownloadInProgress || updateBannerState === 'downloading' || updateReady || updateBannerState === 'ready') return;
    updateCheckInProgress = true;
    if (manualUpdateCheckPending) {
        setCheckButtonCheckingState(true);
    }
});

window.api.onUpdateAvailable((info: UpdateInfo) => {
    if (updateDownloadInProgress || updateBannerState === 'downloading' || updateReady || updateBannerState === 'ready') return;
    const activeInfo = rememberUpdateInfo(info);
    updateCheckInProgress = false;
    updateReady = false;
    updateDownloadInProgress = false;
    const wasManual = manualUpdateCheckPending;
    manualUpdateCheckPending = false;
    manualUpdateOutcomeHandled = true;
    latestDownloadProgress = null;
    setCheckButtonCheckingState(false);

    if (!activeInfo) {
        shouldOpenUpdateModalOnAvailable = false;
        return;
    }

    // If the user explicitly skipped this exact version, suppress the auto
    // notification entirely — banner stays hidden, no modal popup. A manual
    // "Check for updates" click overrides the skip so the user can change
    // their mind.
    const isSkipped = getSkippedUpdateVersion() === activeInfo.version;
    if (isSkipped && !wasManual) {
        shouldOpenUpdateModalOnAvailable = false;
        return;
    }

    setUpdateBannerAvailableUi(activeInfo);

    if (shouldOpenUpdateModalOnAvailable) {
        openUpdateModal(activeInfo);
    }

    shouldOpenUpdateModalOnAvailable = false;
});


window.api.onUpdateNotAvailable(() => {
    if (updateDownloadInProgress || updateBannerState === 'downloading' || updateReady || updateBannerState === 'ready') return;
    updateCheckInProgress = false;
    setCheckButtonCheckingState(false);
    manualUpdateOutcomeHandled = true;

    if (manualUpdateCheckPending) {
        notifyUpdate(UI_TEXT.updates.latest, 'info');
    }

    shouldOpenUpdateModalOnAvailable = false;
    manualUpdateCheckPending = false;
    if (!updateReady) {
        hideUpdateBanner();
    }
});

window.api.onUpdateDownloadProgress((progress: UpdateDownloadProgress) => {
    updateDownloadInProgress = true;
    updateBannerState = 'downloading';
    latestDownloadProgress = progress;

    const bar = byId('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = progress.percent + '%';
    byId('updateProgressGauge').setAttribute('aria-valuenow', String(Math.round(progress.percent)));

    showUpdateBanner();
    byId('updateProgress').classList.remove('is-hidden');

    const mb = (progress.transferred / 1024 / 1024).toFixed(1);
    const totalMb = (progress.total / 1024 / 1024).toFixed(1);
    byId('updateText').textContent = `${UI_TEXT.updates.downloadLabel}: ${mb} / ${totalMb} MB (${progress.percent.toFixed(0)}%)`;
    syncWorkspaceUpdateState('downloading');
    refreshUpdateModalDownloadState();
});

window.api.onUpdateDownloaded((info: UpdateInfo) => {
    // Once a version is actually downloaded the user clearly stopped
    // skipping it — clear the skip flag so future updates aren't masked
    // by a stale entry.
    clearSkippedUpdateVersion();
    const activeInfo = rememberUpdateInfo(info);
    if (!activeInfo) return;
    setDownloadReadyUi(activeInfo);
    openUpdateModal(activeInfo);
});

window.api.onUpdateError((payload) => {
    if (payload.kind === 'check') {
        if (updateDownloadInProgress || updateBannerState === 'downloading' || updateReady || updateBannerState === 'ready') return;
        updateCheckInProgress = false;
        manualUpdateCheckPending = false;
        manualUpdateOutcomeHandled = true;
        shouldOpenUpdateModalOnAvailable = false;
        setCheckButtonCheckingState(false);
        notifyUpdate(UI_TEXT.updates.checkFailed, 'warn');
        return;
    }

    const operation = updateDownloadOperation;
    if (!updateDownloadInProgress || operation === null) return;
    const activeVersion = (latestUpdateInfo?.version || latestUpdateVersion || '').trim();
    if (payload.version && activeVersion && payload.version !== activeVersion) return;
    updateCheckInProgress = false;
    manualUpdateCheckPending = false;
    manualUpdateOutcomeHandled = true;
    shouldOpenUpdateModalOnAvailable = false;
    setCheckButtonCheckingState(false);

    handleUpdateDownloadFailure(operation);
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && byId('updateModal').classList.contains('show')) {
        dismissUpdateModal();
    }
});
