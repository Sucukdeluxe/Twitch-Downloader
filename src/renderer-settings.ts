let lastRuntimeMetricsOutput = '';
let lastDebugLogOutput: string | null = null;
let settingsAutoSaveBound = false;
let settingsAutoSaveInFlight = false;
let pendingSettingsAutoSave = false;
let settingsAutoSaveTimer: number | null = null;
let pendingCredentialsReconnect = false;
let lastPersistedSettingsFingerprint = '';
let settingsInputGeneration = 0;
let settingsSaveFailed = false;

function renderSettingsSaveStatus(): void {
    const notice = document.getElementById('settingsSaveNotice');
    if (!notice) return;
    notice.hidden = !settingsSaveFailed;
    byId('settingsSaveMessage').textContent = currentLanguage === 'de' ? 'Änderungen nicht gespeichert.' : 'Changes were not saved.';
    byId('settingsSaveRetry').textContent = currentLanguage === 'de' ? 'Erneut speichern' : 'Retry saving';
}

function setSettingsSaveFailed(failed: boolean): void {
    if (failed && !settingsSaveFailed) showAppToast(currentLanguage === 'de' ? 'Einstellungen konnten nicht gespeichert werden.' : 'Settings could not be saved.', 'warn');
    settingsSaveFailed = failed;
    renderSettingsSaveStatus();
}

async function reconnectSettings(): Promise<void> {
    try { await connect(); }
    catch { updateStatus(UI_TEXT.status.connectFailedPublic, false, 'public'); }
}
let lastPreflightResult: PreflightResult | null = null;
let preflightFailed = false;
let preflightGeneration = 0;
const SECRET_INPUT_MASK = '••••••••';
let secretStatus: SecretStatus = {
    encryptionAvailable: false,
    clientSecretConfigured: false,
    discordWebhookConfigured: false
};
type SecretInputId = 'clientSecret' | 'discordWebhookUrl';
const secretInputGenerations: Record<SecretInputId, number> = {
    clientSecret: 0,
    discordWebhookUrl: 0
};

function canRunSettingsAutoRefresh(targetId?: string): boolean {
    if (document.hidden || document.querySelector('.tab-content.active')?.id !== 'settingsTab') return false;
    if (!targetId) return true;
    const target = document.getElementById(targetId);
    if (!target || target.closest('[hidden]') || target.closest('details:not([open])')) return false;
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
}

let debugRefreshInFlight = false;
let metricsRefreshInFlight = false;
let automationRefreshInFlight = false;

function refreshVisibleSettingsDiagnostics(): void {
    if (byId<HTMLInputElement>('debugAutoRefresh')?.checked && canRunSettingsAutoRefresh('debugLogOutput')) void refreshDebugLog();
    if (byId<HTMLInputElement>('runtimeMetricsAutoRefresh')?.checked) {
        if (canRunSettingsAutoRefresh('runtimeMetricsOutput')) void refreshRuntimeMetrics(false);
        if (canRunSettingsAutoRefresh('autoVodStatusLine')) void refreshAutomationStatusLine();
    }
}

function markSettingsInputChanged(): void {
    settingsInputGeneration += 1;
}

async function connect(): Promise<void> {
    const hasCredentials = Boolean((config.client_id ?? '').toString().trim() && secretStatus.clientSecretConfigured);
    if (!hasCredentials) {
        isConnected = false;
        updateStatus(UI_TEXT.status.noLogin, false, 'public');
        return;
    }

    updateStatus(UI_TEXT.status.connecting, false, 'pending');
    const success = await window.api.login();
    isConnected = success;
    updateStatus(success ? UI_TEXT.status.connected : UI_TEXT.status.connectFailedPublic, success, success ? 'connected' : 'public');
}

function formatBytesForMetrics(bytes: number): string {
    return formatBytes(bytes);
}

function formatRuntimeMetricSummary(template: string, values: Record<string, string | number>): string {
    return Object.entries(values).reduce(
        (summary, [key, value]) => summary.replace(`{${key}}`, String(value)),
        template
    );
}

function getRuntimePerformanceModeLabel(mode: RuntimeMetricsSnapshot['config']['performanceMode']): string {
    const labels: Record<RuntimeMetricsSnapshot['config']['performanceMode'], string> = {
        stability: UI_TEXT.static.performanceModeStability,
        balanced: UI_TEXT.static.performanceModeBalanced,
        speed: UI_TEXT.static.performanceModeSpeed
    };
    return labels[mode];
}

function getRuntimeBooleanLabel(value: boolean): string {
    return value ? UI_TEXT.static.runtimeMetricEnabled : UI_TEXT.static.runtimeMetricDisabled;
}

function formatRuntimeMetricCount(count: number, singular: string, plural: string): string {
    return formatRuntimeMetricSummary(count === 1 ? singular : plural, { count });
}

function getRuntimeErrorClassLabel(errorClass: string | null): string {
    if (!errorClass) return '-';
    const labels: Record<string, string> = {
        network: UI_TEXT.static.runtimeMetricErrorNetwork,
        rate_limit: UI_TEXT.static.runtimeMetricErrorRateLimit,
        auth: UI_TEXT.static.runtimeMetricErrorAuth,
        tooling: UI_TEXT.static.runtimeMetricErrorTooling,
        integrity: UI_TEXT.static.runtimeMetricErrorIntegrity,
        io: UI_TEXT.static.runtimeMetricErrorIo,
        validation: UI_TEXT.static.runtimeMetricErrorValidation,
        unknown: UI_TEXT.static.runtimeMetricErrorUnknown
    };
    return labels[errorClass] ?? UI_TEXT.static.runtimeMetricErrorUnknown;
}

function validateFilenameTemplates(showAlert = false): boolean {
    const templates = [
        byId<HTMLInputElement>('vodFilenameTemplate').value.trim(),
        byId<HTMLInputElement>('partsFilenameTemplate').value.trim(),
        byId<HTMLInputElement>('defaultClipFilenameTemplate').value.trim()
    ];

    const unknown = templates.flatMap((template) => collectUnknownTemplatePlaceholders(template));
    const uniqueUnknown = Array.from(new Set(unknown));
    const lintNode = byId('filenameTemplateLint');

    if (!uniqueUnknown.length) {
        lintNode.className = 'template-lint ok';
        lintNode.textContent = '';
        return true;
    }

    lintNode.className = 'template-lint warn';
    lintNode.textContent = `${UI_TEXT.static.templateLintWarn}: ${uniqueUnknown.join(' ')}`;

    if (showAlert) {
        alert(`${UI_TEXT.static.templateLintWarn}: ${uniqueUnknown.join(' ')}`);
    }

    return false;
}

function applyTemplatePreset(preset: string): void {
    const presets: Record<string, { vod: string; parts: string; clip: string }> = {
        default: {
            vod: '{title}.mp4',
            parts: '{date}_Part{part_padded}.mp4',
            clip: '{date}_{part}.mp4'
        },
        archive: {
            vod: '{channel}_{date_custom="yyyy-MM-dd"}_{title}.mp4',
            parts: '{channel}_{date_custom="yyyy-MM-dd"}_Part{part_padded}.mp4',
            clip: '{channel}_{date_custom="yyyy-MM-dd"}_{trim_start}_{part}.mp4'
        },
        clipper: {
            vod: '{date_custom="yyyy-MM-dd"}_{title}.mp4',
            parts: '{date_custom="yyyy-MM-dd"}_{part_padded}_{trim_start}.mp4',
            clip: '{title}_{trim_start_custom="HH-mm-ss"}_{part}.mp4'
        }
    };

    const selected = presets[preset] || presets.default;
    byId<HTMLInputElement>('vodFilenameTemplate').value = selected.vod;
    byId<HTMLInputElement>('partsFilenameTemplate').value = selected.parts;
    byId<HTMLInputElement>('defaultClipFilenameTemplate').value = selected.clip;
    validateFilenameTemplates();
    markSettingsInputChanged();
    // Programmatic .value = ... does not trigger the 'input' event the
    // template inputs listen on for debounced save, so the preset click
    // would otherwise look applied but never persist until the user
    // types into one of the inputs. Schedule the save explicitly.
    scheduleSettingsAutoSave();
}

async function refreshRuntimeMetrics(showLoading = true): Promise<void> {
    if (metricsRefreshInFlight) return;
    metricsRefreshInFlight = true;
    const output = byId('runtimeMetricsOutput');
    if (showLoading) {
        output.textContent = UI_TEXT.static.runtimeMetricsLoading;
    }

    try {
        const metrics = await window.api.getRuntimeMetrics();
        const lines = [
            `${UI_TEXT.static.runtimeMetricQueue}: ${formatRuntimeMetricSummary(UI_TEXT.static.runtimeMetricQueueSummary, {
                total: metrics.queue.total,
                pending: metrics.queue.pending,
                downloading: metrics.queue.downloading,
                failed: metrics.queue.error
            })}`,
            `${UI_TEXT.static.runtimeMetricMode}: ${formatRuntimeMetricSummary(UI_TEXT.static.runtimeMetricModeSummary, {
                mode: getRuntimePerformanceModeLabel(metrics.config.performanceMode),
                smartScheduler: getRuntimeBooleanLabel(metrics.config.smartScheduler),
                duplicatePrevention: getRuntimeBooleanLabel(metrics.config.duplicatePrevention)
            })}`,
            `${UI_TEXT.static.runtimeMetricRetries}: ${formatRuntimeMetricSummary(UI_TEXT.static.runtimeMetricRetriesSummary, {
                scheduled: metrics.retriesScheduled,
                exhausted: metrics.retriesExhausted
            })}`,
            `${UI_TEXT.static.runtimeMetricIntegrity}: ${metrics.integrityFailures}`,
            `${UI_TEXT.static.runtimeMetricCache}: ${formatRuntimeMetricSummary(UI_TEXT.static.runtimeMetricCacheSummary, {
                hits: formatRuntimeMetricCount(metrics.cacheHits, UI_TEXT.static.runtimeMetricCacheHitOne, UI_TEXT.static.runtimeMetricCacheHitMany),
                misses: formatRuntimeMetricCount(metrics.cacheMisses, UI_TEXT.static.runtimeMetricCacheMissOne, UI_TEXT.static.runtimeMetricCacheMissMany),
                vods: formatRuntimeMetricCount(metrics.caches.vodList, UI_TEXT.static.runtimeMetricCacheVodOne, UI_TEXT.static.runtimeMetricCacheVodMany),
                users: formatRuntimeMetricCount(metrics.caches.loginToUserId, UI_TEXT.static.runtimeMetricCacheUserOne, UI_TEXT.static.runtimeMetricCacheUserMany),
                clips: formatRuntimeMetricCount(metrics.caches.clipInfo, UI_TEXT.static.runtimeMetricCacheClipOne, UI_TEXT.static.runtimeMetricCacheClipMany)
            })}`,
            `${UI_TEXT.static.runtimeMetricBandwidth}: ${formatRuntimeMetricSummary(UI_TEXT.static.runtimeMetricBandwidthSummary, {
                current: formatBytesForMetrics(metrics.lastSpeedBytesPerSec),
                average: formatBytesForMetrics(metrics.avgSpeedBytesPerSec)
            })}`,
            `${UI_TEXT.static.runtimeMetricDownloads}: ${formatRuntimeMetricSummary(UI_TEXT.static.runtimeMetricDownloadsSummary, {
                started: metrics.downloadsStarted,
                completed: metrics.downloadsCompleted,
                failed: metrics.downloadsFailed,
                bytes: formatBytesForMetrics(metrics.downloadedBytesTotal)
            })}`,
            `${UI_TEXT.static.runtimeMetricActive}: ${metrics.activeItemTitle || '-'} (${metrics.activeItemId || '-'})`,
            `${UI_TEXT.static.runtimeMetricLastError}: ${formatRuntimeMetricSummary(UI_TEXT.static.runtimeMetricLastErrorSummary, {
                errorClass: getRuntimeErrorClassLabel(metrics.lastErrorClass),
                retryDelay: metrics.lastRetryDelaySeconds
            })}`,
            `${UI_TEXT.static.runtimeMetricUpdated}: ${new Date(metrics.timestamp).toLocaleString(currentLanguage === 'en' ? 'en-US' : 'de-DE')}`
        ];

        const nextOutput = lines.join('\n');
        if (nextOutput !== lastRuntimeMetricsOutput) {
            output.textContent = nextOutput;
            lastRuntimeMetricsOutput = nextOutput;
        }
    } catch {
        output.textContent = UI_TEXT.static.runtimeMetricsError;
        lastRuntimeMetricsOutput = UI_TEXT.static.runtimeMetricsError;
    } finally { metricsRefreshInFlight = false; }
}

async function exportRuntimeMetrics(): Promise<void> {
    const result = await window.api.exportRuntimeMetrics();

    const toast = (window as unknown as { showAppToast?: (message: string, type?: 'info' | 'warn') => void }).showAppToast;
    const notify = (message: string, type: 'info' | 'warn' = 'info') => {
        if (typeof toast === 'function') {
            toast(message, type);
        } else if (type === 'warn') {
            alert(message);
        }
    };

    if (result.success) {
        notify(UI_TEXT.static.runtimeMetricsExportDone, 'info');
        return;
    }

    if (result.cancelled) {
        notify(UI_TEXT.static.runtimeMetricsExportCancelled, 'info');
        return;
    }

    notify(`${UI_TEXT.static.runtimeMetricsExportFailed}${result.error ? `\n${result.error}` : ''}`, 'warn');
}

function toggleRuntimeMetricsAutoRefresh(enabled: boolean): void {
    if (runtimeMetricsAutoRefreshTimer) {
        clearInterval(runtimeMetricsAutoRefreshTimer);
        runtimeMetricsAutoRefreshTimer = null;
    }

    if (enabled) {
        runtimeMetricsAutoRefreshTimer = window.setInterval(() => {
            if (canRunSettingsAutoRefresh('runtimeMetricsOutput')) void refreshRuntimeMetrics(false);
            if (canRunSettingsAutoRefresh('autoVodStatusLine')) void refreshAutomationStatusLine();
        }, 2000);
    }
}

type ConnectionStatusTone = 'connected' | 'public' | 'pending';

function updateStatus(text: string, connected: boolean, tone: ConnectionStatusTone = connected ? 'connected' : 'public'): void {
    const statusText = byId('statusText');
    statusText.textContent = text;
    statusText.title = tone === 'connected'
        ? UI_TEXT.status.connectedHint
        : tone === 'public'
            ? UI_TEXT.status.publicHint
            : '';
    const dot = byId('statusDot');
    dot.classList.remove('connected', 'error', 'public');
    if (tone === 'connected') dot.classList.add('connected');
    if (tone === 'public') dot.classList.add('public');
}

function filterSettings(query: string): void {
    const normalizedQuery = query.trim().toLocaleLowerCase(getIntlLocale());
    if (!normalizedQuery) return;
    const match = Array.from(document.querySelectorAll<HTMLElement>('#settingsTab .settings-card[data-settings-pane]')).find((card) => {
        const searchableText = (card.textContent || '').toLocaleLowerCase(getIntlLocale());
        return searchableText.includes(normalizedQuery);
    });
    const pane = match?.dataset.settingsPane;
    if (pane) {
        setSettingsPane(pane);
        match?.querySelectorAll<HTMLDetailsElement>('details.settings-advanced').forEach(details => {
            if ((details.textContent || '').toLocaleLowerCase(getIntlLocale()).includes(normalizedQuery)) setSettingsSectionExpanded(details, true);
        });
        const section = Array.from(match?.querySelectorAll<HTMLElement>('.settings-section') || []).find(element => (element.textContent || '').toLocaleLowerCase(getIntlLocale()).includes(normalizedQuery));
        requestAnimationFrame(() => (section || match)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
}

const SETTINGS_GROUPS: Record<string, { de: string; en: string }> = {
    general: { de: 'Allgemein', en: 'General' },
    api: { de: 'Twitch-Verbindung', en: 'Twitch connection' },
    downloads: { de: 'Downloads', en: 'Downloads' },
    automation: { de: 'Automatisierung', en: 'Automation' },
    storage: { de: 'Speicher & Sicherung', en: 'Storage & backup' },
    system: { de: 'System & Diagnose', en: 'System & diagnostics' }
};

function refreshSettingsGroupLabels(): void {
    renderSettingsSaveStatus();
    const language = currentLanguage === 'en' ? 'en' : 'de';
    const pane = byId<HTMLElement>('settingsTab').dataset.settingsPane || 'general';
    const labels = SETTINGS_GROUPS[pane] || SETTINGS_GROUPS.general;
    byId('settingsGroupTitle').textContent = labels[language];
    for (const [id, group] of Object.entries({ settingsGeneralNav: 'general', settingsAutomationNav: 'automation', settingsStorageNav: 'storage', settingsSystemNav: 'system' })) {
        byId(id).textContent = SETTINGS_GROUPS[group][language];
    }
}

function setSettingsPane(pane: string, source?: HTMLElement): void {
    const tab = byId<HTMLElement>('settingsTab');
    const cards = Array.from(tab.querySelectorAll<HTMLElement>('.settings-card[data-settings-pane]'));
    const group = SETTINGS_GROUPS[pane] ? pane : cards.find((card) => card.dataset.settingsPane === pane)?.dataset.settingsGroup;
    if (!group) return;
    const changed = tab.dataset.settingsPane !== group;
    tab.dataset.settingsPane = group;
    cards.forEach((card) => {
        card.hidden = card.dataset.settingsGroup !== group;
    });
    const panel = document.querySelector<HTMLElement>('[data-context-for="settings"]');
    const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>('.context-link[data-settings-pane]') || []);
    buttons.forEach((button) => {
        const active = button.dataset.settingsPane === group;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
    if (source) byId<HTMLInputElement>('settingsSearchInput').value = '';
    if (changed) tab.scrollTop = 0;
    if (changed) requestAnimationFrame(refreshVisibleSettingsDiagnostics);
    if (group === 'storage' && !byId('storageSummary').textContent?.trim()) void refreshStorageStats();
    refreshSettingsGroupLabels();
    scheduleSegmentedIndicatorsSync();
}

function changeLanguage(lang: string): void {
    applyRendererLanguage(lang);
    markSettingsInputChanged();
    void flushSettingsAutoSave();
}

function applyRendererLanguage(lang: string): LanguageCode {
    const normalized = setLanguage(lang);
    byId<HTMLSelectElement>('languageSelect').value = normalized;
    updateLanguagePicker(normalized);
    config.language = normalized;

    const currentStatus = byId('statusText').textContent?.trim() || '';
    const statusTone: ConnectionStatusTone = isConnected
        ? 'connected'
        : byId('statusDot').classList.contains('public')
            ? 'public'
            : 'pending';
    updateStatus(localizeCurrentStatusText(currentStatus), isConnected, statusTone);

    renderQueue();
    renderStreamers();
    // Re-render the VOD grid so the dynamically built button labels
    // (trim / queue) and the filter empty-state pick up the new locale.
    renderVodGridFromCurrentState();
    refreshVodSortSelectLabels();

    const activeTabId = document.querySelector('.tab-content.active')?.id || 'vodsTab';
    const activeTab = activeTabId.replace('Tab', '');
    const titleText = (activeTab === 'vods' && currentStreamer)
        ? currentStreamer
        : ((UI_TEXT.tabs as Record<string, string>)[activeTab] || UI_TEXT.appName);
    const setTitle = (window as unknown as { setPageTitle?: (text: string) => void }).setPageTitle;
    if (typeof setTitle === 'function') setTitle(titleText);
    else byId('pageTitle').textContent = titleText;

    void refreshRuntimeMetrics();
    void refreshAutomationStatusLine();
    refreshLocalizedPreflightUi();
    validateFilenameTemplates();
    refreshSettingsGroupLabels();
    filterSettings(byId<HTMLInputElement>('settingsSearchInput').value);
    return normalized;
}

function updateLanguagePicker(lang: string): void {
    const de = byId<HTMLButtonElement>('langOptionDe');
    const en = byId<HTMLButtonElement>('langOptionEn');

    const isDe = lang === 'de';
    de.classList.toggle('active', isDe);
    en.classList.toggle('active', !isDe);
    de.setAttribute('aria-pressed', String(isDe));
    en.setAttribute('aria-pressed', String(!isDe));
    scheduleSegmentedIndicatorSync(byId<HTMLElement>('languagePicker'));
}

function selectLanguageOption(lang: string): void {
    changeLanguage(lang);
}

function renderPreflightButtonLabels(): void {
    const runButton = byId<HTMLButtonElement>('btnPreflightRun');
    const fixButton = byId<HTMLButtonElement>('btnPreflightFix');
    runButton.textContent = runButton.disabled ? UI_TEXT.static.preflightChecking : UI_TEXT.static.preflightRun;
    fixButton.textContent = fixButton.disabled ? UI_TEXT.static.preflightFixing : UI_TEXT.static.preflightFix;
}

function refreshLocalizedPreflightUi(): void {
    renderPreflightButtonLabels();
    if (lastPreflightResult) renderPreflightResult(lastPreflightResult);
    else if (preflightFailed) renderPreflightError();
}

function invalidatePreflightResult(): void {
    preflightGeneration += 1;
    lastPreflightResult = null;
    preflightFailed = false;
    renderUnknownPreflightState(UI_TEXT.static.preflightEmpty);
}

function renderUnknownPreflightState(message: string): void {
    byId('preflightResult').textContent = message;
    const badge = byId('healthBadge');
    badge.classList.remove('good', 'warn', 'bad', 'unknown');
    badge.classList.add('unknown');
    badge.textContent = UI_TEXT.static.healthUnknown;
}

function renderPreflightError(): void {
    lastPreflightResult = null;
    preflightFailed = true;
    renderUnknownPreflightState(UI_TEXT.static.preflightError);
}

function renderPreflightResult(result: PreflightResult): void {
    lastPreflightResult = result;
    preflightFailed = false;
    const entries: Array<[string, boolean, string]> = [
        [UI_TEXT.static.preflightInternet, result.checks.internet, UI_TEXT.static.preflightNoInternet],
        [UI_TEXT.static.preflightStreamlink, result.checks.streamlink, UI_TEXT.static.preflightStreamlinkMissing],
        [UI_TEXT.static.preflightFfmpeg, result.checks.ffmpeg, UI_TEXT.static.preflightFfmpegMissing],
        [UI_TEXT.static.preflightFfprobe, result.checks.ffprobe, UI_TEXT.static.preflightFfprobeMissing],
        [UI_TEXT.static.preflightPath, result.checks.downloadPathWritable, UI_TEXT.static.preflightDownloadPathNotWritable]
    ];
    const localizedIssues = entries.filter(([, ok]) => !ok).map(([, , message]) => message);
    const lines = entries.map(([name, ok]) => `${ok ? 'OK' : 'FAIL'} ${name}`).join('\n');
    const extra = localizedIssues.length ? `\n\n${localizedIssues.join('\n')}` : `\n\n${UI_TEXT.static.preflightReady}`;

    byId('preflightResult').textContent = `${lines}${extra}`;

    const badge = byId('healthBadge');
    badge.classList.remove('good', 'warn', 'bad', 'unknown');

    const failCount = localizedIssues.length;
    if (failCount === 0) {
        badge.classList.add('good');
        badge.textContent = UI_TEXT.static.healthGood;
        return;
    }

    if (failCount <= 2) {
        badge.classList.add('warn');
        badge.textContent = UI_TEXT.static.healthWarn;
    } else {
        badge.classList.add('bad');
        badge.textContent = UI_TEXT.static.healthBad;
    }
}

async function runPreflight(autoFix = false): Promise<void> {
    const btn = byId<HTMLButtonElement>(autoFix ? 'btnPreflightFix' : 'btnPreflightRun');
    const generation = ++preflightGeneration;
    btn.disabled = true;
    renderPreflightButtonLabels();

    try {
        const result = await window.api.runPreflight(autoFix);
        if (generation === preflightGeneration) renderPreflightResult(result);
    } catch {
        if (generation === preflightGeneration) renderPreflightError();
    } finally {
        btn.disabled = false;
        renderPreflightButtonLabels();
    }
}

function getManagedToolStateLabel(state: ManagedToolStatus['state']): string {
    const labels: Record<ManagedToolStatus['state'], string> = {
        missing: UI_TEXT.static.managedToolsMissing,
        installing: UI_TEXT.static.managedToolsInstalling,
        verified: UI_TEXT.static.managedToolsVerified,
        unverified: UI_TEXT.static.managedToolsUnverified,
        corrupt: UI_TEXT.static.managedToolsCorrupt
    };
    return labels[state];
}

function renderManagedToolStatus(statuses: ManagedToolStatuses): void {
    const lines = [statuses.streamlink, statuses.ffmpeg].map((status) => {
        const verification = status.verified ? UI_TEXT.static.managedToolsVerified : UI_TEXT.static.managedToolsUnverified;
        const parts = [`${status.id} ${status.version}: ${getManagedToolStateLabel(status.state)} · ${verification}`];
        if (!status.verified && status.fallbackRunnable) {
            parts.push(UI_TEXT.static.managedToolsFallbackActive);
        }
        return parts.join(' · ');
    });
    byId('managedToolStatus').textContent = lines.join('\n');
}

async function refreshManagedToolStatus(): Promise<void> {
    const statuses = await window.api.getManagedToolStatus();
    if (statuses) renderManagedToolStatus(statuses);
}

async function repairManagedTools(): Promise<void> {
    const buttons = [
        byId<HTMLButtonElement>('btnRefreshManagedTools'),
        byId<HTMLButtonElement>('btnRepairManagedTools'),
        byId<HTMLButtonElement>('btnResetManagedTools')
    ];
    for (const button of buttons) button.disabled = true;
    byId('managedToolStatus').textContent = UI_TEXT.static.managedToolsRepairing;
    try {
        const result = await window.api.repairManagedTools();
        if (result) {
            renderManagedToolStatus(result.statuses);
            invalidatePreflightResult();
        }
    } finally {
        for (const button of buttons) button.disabled = false;
    }
}

async function resetManagedTools(): Promise<void> {
    if (!confirm(UI_TEXT.static.managedToolsResetConfirm)) return;
    const result = await window.api.resetManagedTools();
    if (result) {
        renderManagedToolStatus(result.statuses);
        invalidatePreflightResult();
    }
}

let cleanupPreviewToken: string | null = null;
let cleanupPreviewItems: CleanupReport['items'] = [];
let cleanupPreviewPage = 0;
let cleanupRequestBusy = false;
let cleanupSettingsRevision = 0;
function initializeCleanupPreview(): void {
    const host = byId('cleanupReport');
    const preview = document.createElement('div');
    preview.id = 'cleanupPreview'; preview.className = 'cleanup-preview'; preview.hidden = true;
    host.after(preview);
    for (const id of ['autoCleanupDays', 'autoCleanupTarget', 'autoCleanupAction', 'autoCleanupEnabledToggle', 'downloadPath']) {
        byId(id).addEventListener('input', () => {
            cleanupSettingsRevision++; cleanupPreviewToken = null; cleanupPreviewItems = [];
            preview.hidden = true; byId<HTMLButtonElement>('btnCleanupRunNow').disabled = true;
        });
    }
    byId<HTMLButtonElement>('btnCleanupRunNow').disabled = true;
}
function renderCleanupPreview(report: CleanupReport): void {
    const host = byId('cleanupPreview'); host.replaceChildren();
    host.hidden = !cleanupPreviewItems.length && !report.recoveryPaths.length;
    if (report.recoveryPaths.length) {
        const recovery = document.createElement('button'); recovery.type = 'button'; recovery.className = 'btn-secondary';
        recovery.textContent = currentLanguage === 'de' ? 'Unterbrochene Bereinigung wiederherstellen' : 'Restore interrupted cleanup';
        recovery.addEventListener('click', async () => {
            recovery.disabled = true;
            try { await window.api.recoverStorageCleanup(); await runCleanupOnce(true); }
            catch { showAppToast(currentLanguage === 'de' ? 'Wiederherstellung fehlgeschlagen.' : 'Restore failed.', 'warn'); recovery.disabled = false; }
        }); host.append(recovery);
    }
    const list = document.createElement('ul'); list.className = 'cleanup-preview-list';
    for (const item of cleanupPreviewItems.slice(cleanupPreviewPage * 100, (cleanupPreviewPage + 1) * 100)) {
        const row = document.createElement('li');
        const name = document.createElement('strong'); name.textContent = item.videoPath.split(/[\\/]/).pop() || item.videoPath; name.title = item.videoPath;
        const metadata = document.createElement('span'); metadata.textContent = [formatUiNumber(item.ageDays) + (currentLanguage === 'de' ? ' Tage' : ' days'), formatBytesForMetrics(item.bytes), item.sidecarPaths.length ? formatUiNumber(item.sidecarPaths.length) + (currentLanguage === 'de' ? ' Begleitdateien' : ' sidecars') : ''].filter(Boolean).join(' · ');
        row.append(name, metadata); list.append(row);
    }
    host.append(list);
    if (cleanupPreviewItems.length > 100) {
        const navigation = document.createElement('div'); navigation.className = 'cleanup-preview-navigation';
        for (const direction of [-1, 1]) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn-secondary';
            button.textContent = direction < 0 ? (currentLanguage === 'de' ? 'Zurück' : 'Previous') : (currentLanguage === 'de' ? 'Weiter' : 'Next');
            button.disabled = direction < 0 ? cleanupPreviewPage === 0 : (cleanupPreviewPage + 1) * 100 >= cleanupPreviewItems.length;
            button.addEventListener('click', () => { cleanupPreviewPage += direction; renderCleanupPreview(report); }); navigation.append(button);
        }
        const count = document.createElement('span'); count.textContent = formatUiNumber(cleanupPreviewPage + 1) + ' / ' + formatUiNumber(Math.ceil(cleanupPreviewItems.length / 100)); navigation.append(count); host.append(navigation);
    }
}
async function runCleanupDryRun(): Promise<void> { await runCleanupOnce(true); }
async function runCleanupNow(): Promise<void> { await runCleanupOnce(false); }
async function runCleanupOnce(dryRun: boolean): Promise<void> {
    if (cleanupRequestBusy || !dryRun && !cleanupPreviewToken) return;
    const revision = cleanupSettingsRevision;
    const token = cleanupPreviewToken;
    cleanupPreviewToken = null; cleanupRequestBusy = true;
    const reportEl = byId('cleanupReport');
    const dryBtn = byId<HTMLButtonElement>('btnCleanupDryRun'), runBtn = byId<HTMLButtonElement>('btnCleanupRunNow');
    dryBtn.disabled = runBtn.disabled = true; reportEl.textContent = UI_TEXT.static.storageScanning;
    try {
        const report = await window.api.runStorageCleanup({ dryRun, token: token || undefined });
        if (revision !== cleanupSettingsRevision) return;
        cleanupPreviewItems = report.items; cleanupPreviewPage = 0;
        if (report.dryRun) {
            cleanupPreviewToken = report.recoveryPaths.length ? null : report.token;
            reportEl.textContent = formatUiNumber(report.candidates) + (currentLanguage === 'de' ? ' Videos · ' : ' videos · ') + formatBytesForMetrics(report.bytesAffected);
        } else {
            const action = report.action === 'delete' ? (currentLanguage === 'de' ? ' Videos im Papierkorb' : ' videos in Recycle Bin') : (currentLanguage === 'de' ? ' Videos archiviert' : ' videos archived');
            reportEl.textContent = formatUiNumber(report.processed) + action + ' · ' + formatBytesForMetrics(report.bytesAffected);
            if (report.skipped) reportEl.textContent += ' · ' + formatUiNumber(report.skipped) + (currentLanguage === 'de' ? ' geändert oder in Verwendung' : ' changed or in use');
            if (report.failed) reportEl.textContent += ' · ' + formatUiNumber(report.failed) + (currentLanguage === 'de' ? ' fehlgeschlagen' : ' failed');
            cleanupPreviewItems = []; void refreshStorageStats();
        }
        renderCleanupPreview(report);
        if (report.failures.length) {
            const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = currentLanguage === 'de' ? 'Details' : 'Details';
            const text = document.createElement('pre'); text.textContent = report.failures.map(item => item.path + ': ' + item.error).join('\n'); details.append(summary, text); byId('cleanupPreview').append(details); byId('cleanupPreview').hidden = false;
        }
    } catch (error) {
        reportEl.textContent = String(error).includes('preview-') ? (currentLanguage === 'de' ? 'Vorschau erneuern.' : 'Refresh preview.') : (currentLanguage === 'de' ? 'Bereinigung fehlgeschlagen.' : 'Cleanup failed.');
    } finally { cleanupRequestBusy = false; dryBtn.disabled = false; runBtn.disabled = !cleanupPreviewToken || !cleanupPreviewItems.length; }
}

async function refreshStorageStats(): Promise<void> {
    const summary = byId('storageSummary');
    const list = byId('storageList');
    const btn = byId<HTMLButtonElement>('btnRefreshStorage');
    const old = btn.textContent || '';
    btn.disabled = true;
    btn.textContent = UI_TEXT.static.storageScanning;
    summary.textContent = UI_TEXT.static.storageScanning;
    list.replaceChildren();

    try {
        const stats = await window.api.getStorageStats();
        renderStorageStats(stats);
    } catch {
        summary.textContent = UI_TEXT.static.storageEmpty;
    } finally {
        btn.disabled = false;
        btn.textContent = old || UI_TEXT.static.storageRefresh;
    }
}

function renderStorageStats(stats: StorageStatsResult): void {
    const summary = byId('storageSummary');
    const list = byId('storageList');

    if (!stats.rootExists) {
        summary.textContent = UI_TEXT.static.storageEmpty;
        list.replaceChildren();
        return;
    }

    summary.textContent = UI_TEXT.static.storageSummary
        .replace('{files}', formatUiNumber(stats.totalFiles))
        .replace('{size}', formatBytesForMetrics(stats.totalBytes))
        .replace('{free}', stats.freeBytes !== null ? formatBytesForMetrics(stats.freeBytes) : '-');

    list.replaceChildren();
    if (stats.streamers.length === 0 && stats.extras.length === 0) return;

    const buildTable = (rows: StreamerStorageEntry[]): HTMLElement => {
        const table = document.createElement('table');
        table.className = 'storage-stats-table';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const headers = [
            UI_TEXT.static.storageColumnFolder,
            UI_TEXT.static.storageColumnFiles,
            UI_TEXT.static.storageColumnTotal,
            UI_TEXT.static.storageColumnLive,
            UI_TEXT.static.storageColumnChat,
            ''
        ];
        for (const h of headers) {
            const th = document.createElement('th');
            th.scope = 'col';
            if (h) {
                th.textContent = h;
            } else {
                th.setAttribute('aria-label', UI_TEXT.static.storageColumnActionsAria);
            }
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of rows) {
            const tr = document.createElement('tr');
            const cells: Array<string | HTMLElement> = [
                row.name,
                formatUiNumber(row.fileCount),
                formatBytesForMetrics(row.totalBytes),
                row.liveBytes > 0 ? formatBytesForMetrics(row.liveBytes) : '-',
                row.chatBytes > 0 ? formatBytesForMetrics(row.chatBytes) : '-'
            ];
            for (const c of cells) {
                const td = document.createElement('td');
                if (typeof c === 'string') td.textContent = c;
                else td.appendChild(c);
                tr.appendChild(td);
            }
            const openCell = document.createElement('td');
            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.textContent = UI_TEXT.static.storageOpen;
            openBtn.className = 'btn-pill';
            openBtn.addEventListener('click', () => {
                void window.api.openFolder(row.folderPath);
            });
            openCell.appendChild(openBtn);
            tr.appendChild(openCell);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        const wrapper = document.createElement('div');
        wrapper.className = 'storage-table-scroll';
        wrapper.tabIndex = 0;
        wrapper.setAttribute('role', 'region');
        wrapper.setAttribute('aria-label', UI_TEXT.static.storageCardTitle);
        wrapper.appendChild(table);
        return wrapper;
    };

    if (stats.streamers.length > 0) {
        list.appendChild(buildTable(stats.streamers));
    }
    if (stats.extras.length > 0) {
        const heading = document.createElement('div');
        heading.textContent = UI_TEXT.static.storageOtherFolders;
        heading.className = 'storage-stats-section';
        list.appendChild(heading);
        list.appendChild(buildTable(stats.extras));
    }
}

async function exportConfigToFile(): Promise<void> {
    const result = await window.api.exportConfig();
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (result.success) {
        if (toast) toast(UI_TEXT.static.configExported, 'info');
    } else if (result.cancelled) {
        // User cancelled the dialog — no toast needed.
    } else if (toast) {
        toast(UI_TEXT.static.configExportFailed + (result.error ? `\n${result.error}` : ''), 'warn');
    }
}

async function importConfigFromFile(): Promise<void> {
    const result = await window.api.importConfig();
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (result.success) {
        invalidatePreflightResult();
        // Reload local config copy + refresh forms / streamer list / VOD grid
        try {
            const currentConfig = config;
            const importedConfig = await window.api.getConfig();
            const language = typeof importedConfig.language === 'string'
                ? importedConfig.language
                : typeof currentConfig.language === 'string'
                    ? currentConfig.language
                    : currentLanguage;
            const theme = typeof importedConfig.theme === 'string'
                ? importedConfig.theme
                : typeof currentConfig.theme === 'string'
                    ? currentConfig.theme
                    : byId<HTMLSelectElement>('themeSelect').value || 'twitch';
            config = { ...currentConfig, ...importedConfig, language, theme };
            if (typeof syncSettingsFormFromConfig === 'function') syncSettingsFormFromConfig();
            applyRendererTheme(theme);
            applyRendererLanguage(language);
        } catch { /* ignore — next refresh will catch up */ }
        if (toast) toast(UI_TEXT.static.configImported, 'info');
    } else if (result.cancelled) {
        // User cancelled the dialog — no toast needed.
    } else if (toast) {
        toast(UI_TEXT.static.configImportFailed + (result.error ? `\n${result.error}` : ''), 'warn');
    }
}

async function resetDownloadedIds(): Promise<void> {
    if (!confirm(UI_TEXT.static.resetDownloadedConfirm)) return;
    const result = await window.api.resetDownloadedVodIds();
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (result.success) {
        // Refresh local config so the badges disappear immediately
        try {
            config = await window.api.getConfig();
            if (typeof renderVodGridFromCurrentState === 'function' && lastLoadedStreamer) {
                renderVodGridFromCurrentState();
            }
        } catch { /* ignore */ }
        if (toast) {
            toast(UI_TEXT.static.resetDownloadedDone.replace('{count}', String(result.removedCount)), 'info');
        }
    }
}

async function openDebugLogFile(): Promise<void> {
    const ok = await window.api.openDebugLogFile();
    if (!ok) {
        const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
        if (toast) toast('Debug log file not yet present.', 'warn');
    }
}

async function refreshDebugLog(): Promise<void> {
    if (debugRefreshInFlight) return;
    debugRefreshInFlight = true;
    const panel = byId('debugLogOutput');
    try {
        const text = await window.api.getDebugLog(250);
        const keepAtBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 20;
        if (text !== lastDebugLogOutput) { panel.textContent = text; lastDebugLogOutput = text; }
        if (keepAtBottom) panel.scrollTop = panel.scrollHeight;
    } catch {
        lastDebugLogOutput = null;
        panel.textContent = currentLanguage === 'de' ? 'Protokoll konnte nicht geladen werden.' : 'Could not load the log.';
    } finally { debugRefreshInFlight = false; }
}

function toggleDebugAutoRefresh(enabled: boolean): void {
    if (debugLogAutoRefreshTimer) {
        clearInterval(debugLogAutoRefreshTimer);
        debugLogAutoRefreshTimer = null;
    }

    if (enabled) {
        debugLogAutoRefreshTimer = window.setInterval(() => {
            if (canRunSettingsAutoRefresh('debugLogOutput')) void refreshDebugLog();
        }, 2000);
    }
}

function collectCredentialsPayload(): Partial<AppConfig> {
    return {
        client_id: byId<HTMLInputElement>('clientId').value.trim()
    };
}

function secretConfigured(inputId: SecretInputId): boolean {
    return inputId === 'clientSecret' ? secretStatus.clientSecretConfigured : secretStatus.discordWebhookConfigured;
}

function syncSecretField(inputId: SecretInputId): void {
    byId<HTMLInputElement>(inputId).value = secretConfigured(inputId) ? SECRET_INPUT_MASK : '';
}

function syncSecretFields(): void {
    syncSecretField('clientSecret');
    syncSecretField('discordWebhookUrl');
}

async function persistSecretInput(inputId: SecretInputId): Promise<void> {
    const requestGeneration = secretInputGenerations[inputId];
    const value = byId<HTMLInputElement>(inputId).value;
    if (value === SECRET_INPUT_MASK) return;

    const configured = secretConfigured(inputId);
    let nextStatus = secretStatus;
    if (value.trim()) {
        nextStatus = inputId === 'clientSecret'
            ? await window.api.setClientSecret(value.trim())
            : await window.api.setDiscordWebhook(value.trim());
    } else if (configured) {
        nextStatus = inputId === 'clientSecret'
            ? await window.api.clearClientSecret()
            : await window.api.clearDiscordWebhook();
    }

    if (secretInputGenerations[inputId] !== requestGeneration) return;
    secretStatus = nextStatus;
    syncSecretField(inputId);
}

async function persistSecretInputs(): Promise<void> {
    await persistSecretInput('clientSecret');
    await persistSecretInput('discordWebhookUrl');
}

function syncPartMinutesFieldState(): void {
    const downloadMode = byId<HTMLSelectElement>('downloadMode').value;
    const partMinutes = byId<HTMLInputElement>('partMinutes');
    const label = byId<HTMLElement>('partMinutesLabel');
    const isSplitMode = downloadMode === 'parts';

    partMinutes.disabled = !isSplitMode;
    partMinutes.setAttribute('aria-disabled', String(!isSplitMode));
    label.classList.toggle('input-disabled', !isSplitMode);
}

let downloadWindowRowSequence = 0;

function refreshDownloadWindowTexts(): void {
    const container = document.getElementById('downloadWindowRows');
    if (!container) return;
    const rows = container.querySelectorAll<HTMLElement>('.download-window-row');
    rows.forEach(row => {
        row.querySelector<HTMLElement>('[data-window-start-label]')!.textContent = UI_TEXT.static.downloadWindowStart;
        row.querySelector<HTMLElement>('[data-window-end-label]')!.textContent = UI_TEXT.static.downloadWindowEnd;
        const remove = row.querySelector<HTMLButtonElement>('button')!;
        remove.setAttribute('aria-label', UI_TEXT.static.downloadWindowRemove);
        remove.title = UI_TEXT.static.downloadWindowRemove;
        const start = row.querySelector<HTMLInputElement>('[data-window-time="start"]')!;
        const end = row.querySelector<HTMLInputElement>('[data-window-time="end"]')!;
        const nextDay = row.querySelector<HTMLElement>('.download-window-next-day')!;
        nextDay.textContent = UI_TEXT.static.downloadWindowNextDay;
        nextDay.hidden = !start.value || !end.value || end.value >= start.value;
        for (const input of [start, end]) input.lang = currentLanguage === 'de' ? 'de-DE' : 'en-GB';
    });
    byId<HTMLElement>('downloadWindowsEmpty').hidden = rows.length > 0;
}

function updateDownloadWindowValue(): void {
    const container = byId<HTMLElement>('downloadWindowRows');
    const windows = Array.from(container.querySelectorAll<HTMLElement>('.download-window-row'), row => {
        const start = row.querySelector<HTMLInputElement>('[data-window-time="start"]')!.value;
        const end = row.querySelector<HTMLInputElement>('[data-window-time="end"]')!.value;
        const invalid = !start || !end || start === end;
        row.querySelectorAll<HTMLInputElement>('input').forEach(input => input.setAttribute('aria-invalid', String(invalid)));
        return start + '-' + end;
    });
    const input = byId<HTMLTextAreaElement>('downloadWindows');
    input.value = windows.join('\n');
    refreshDownloadWindowTexts();
    updateDownloadPolicyValidation(parseDownloadPolicyFormValue(byId<HTMLInputElement>('downloadThrottleMiBps').value, input.value).error);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function createDownloadWindowRow(start = '', end = ''): HTMLElement {
    const row = document.createElement('div');
    row.className = 'download-window-row';
    const id = ++downloadWindowRowSequence;
    for (const [kind, value] of [['start', start], ['end', end]] as const) {
        const field = document.createElement('div');
        field.className = 'download-window-field';
        const label = document.createElement('label');
        const caption = document.createElement('span');
        caption.setAttribute('data-window-' + kind + '-label', '');
        label.append(caption);
        if (kind === 'end') {
            const nextDay = document.createElement('span');
            nextDay.className = 'download-window-next-day';
            nextDay.hidden = true;
            label.append(nextDay);
        }
        const input = document.createElement('input');
        input.id = 'download-window-' + id + '-' + kind;
        input.type = 'time';
        input.step = '60';
        input.required = true;
        input.value = value;
        input.dataset.windowTime = kind;
        input.setAttribute('aria-describedby', 'downloadWindowsHint downloadPolicyValidation');
        label.htmlFor = input.id;
        input.addEventListener('input', updateDownloadWindowValue);
        input.addEventListener('blur', () => { void flushSettingsAutoSave(false); });
        field.append(label, input);
        row.append(field);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-secondary download-window-remove';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.8');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    lines.setAttribute('d', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5');
    icon.append(lines);
    remove.append(icon);
    remove.addEventListener('click', () => {
        const focusTarget = row.nextElementSibling?.querySelector<HTMLInputElement>('input')
            || row.previousElementSibling?.querySelector<HTMLInputElement>('input')
            || byId<HTMLButtonElement>('downloadWindowAddBtn');
        row.remove();
        updateDownloadWindowValue();
        focusTarget.focus();
        void flushSettingsAutoSave(false);
    });
    row.append(remove);
    return row;
}

function addDownloadWindow(): void {
    const row = createDownloadWindowRow();
    byId<HTMLElement>('downloadWindowRows').append(row);
    updateDownloadWindowValue();
    row.querySelector<HTMLInputElement>('input')!.focus();
}

function syncDownloadWindowRows(): void {
    const container = document.getElementById('downloadWindowRows');
    if (!container) return;
    const windows = config.download_policy?.windows ?? [];
    container.replaceChildren(...windows.map(window => createDownloadWindowRow(window.start, window.end)));
    refreshDownloadWindowTexts();
}

function parseDownloadPolicyFormValue(rateValue: string, windowsValue: string): { value: DownloadPolicy | null; error: string | null } {
    const rate = rateValue.trim();
    let throttle: DownloadPolicy['throttle'] = null;
    if (rate) {
        const numberParts = rate.replace(',', '.').split('.');
        if (numberParts.length > 2 || numberParts.some((part) => !part || [...part].some((character) => character < '0' || character > '9'))) {
            return { value: null, error: 'rate' };
        }
        const maxBytesPerSecond = Math.round(Number(numberParts.join('.')) * 1024 * 1024);
        if (!Number.isSafeInteger(maxBytesPerSecond) || maxBytesPerSecond <= 0) return { value: null, error: 'rate' };
        throttle = { maxBytesPerSecond };
    }
    const windows: DownloadPolicy['windows'] = [];
    const seen = new Set<string>();
    for (const value of windowsValue.split(/[;,\n]+/).map((entry) => entry.trim()).filter(Boolean)) {
        const match = /^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/.exec(value);
        if (!match) return { value: null, error: 'window' };
        const [startHour, startMinute] = match[1].split(':').map(Number);
        const [endHour, endMinute] = match[2].split(':').map(Number);
        if (startHour > 23 || startMinute > 59 || endHour > 23 || endMinute > 59 || match[1] === match[2]) {
            return { value: null, error: 'window' };
        }
        const key = `${match[1]}-${match[2]}`;
        if (!seen.has(key)) {
            seen.add(key);
            windows.push({ start: match[1], end: match[2] });
        }
    }
    return { value: { throttle, windows }, error: null };
}

function updateDownloadPolicyValidation(error: string | null): void {
    const status = byId<HTMLElement>('downloadPolicyValidation');
    status.textContent = error === 'rate'
        ? UI_TEXT.static.downloadThrottleInvalid
        : error === 'window'
            ? UI_TEXT.static.downloadWindowsInvalid
            : '';
}

function formatDownloadThrottle(maxBytesPerSecond: number | null | undefined): string {
    if (!maxBytesPerSecond) return '';
    return (maxBytesPerSecond / (1024 * 1024)).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function renderDownloadPolicyStatus(status: DownloadPolicyStatus): void {
    const node = byId<HTMLElement>('downloadPolicyStatus');
    node.closest('.download-policy-state')?.classList.toggle('is-waiting', status.waiting);
    if (status.waiting && status.nextStart) {
        node.textContent = UI_TEXT.static.downloadPolicyWaiting.replace('{time}', formatUiDateTime(status.nextStart));
        return;
    }
    node.textContent = UI_TEXT.static.downloadPolicyReady;
}

async function refreshDownloadPolicyStatus(): Promise<void> {
    renderDownloadPolicyStatus(await window.api.getDownloadPolicyStatus());
}

async function startDownloadPolicyOverride(): Promise<void> {
    await window.api.startDownload(true);
    await refreshDownloadPolicyStatus();
}

function syncPlayerSeekPreference(value = config.player_seek_seconds): void {
    const seconds = typeof value === 'number' && [10, 30, 60].includes(value) ? value : 10;
    byId<HTMLInputElement>('playerSeekSeconds').value = String(seconds);
    document.querySelectorAll<HTMLButtonElement>('[data-player-seek]').forEach(button => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.playerSeek) === seconds));
    });
    window.VodPlayer?.setSeekSeconds(seconds);
}

function selectPlayerSeekSeconds(seconds: number): void {
    if (![10, 30, 60].includes(seconds)) return;
    syncPlayerSeekPreference(seconds);
    markSettingsInputChanged();
    void flushSettingsAutoSave(false);
}

function collectDownloadSettingsPayload(): Partial<AppConfig> {
    const parsedPolicy = parseDownloadPolicyFormValue(
        byId<HTMLInputElement>('downloadThrottleMiBps').value,
        byId<HTMLTextAreaElement>('downloadWindows').value,
    );
    updateDownloadPolicyValidation(parsedPolicy.error);
    return {
        language: byId<HTMLSelectElement>('languageSelect').value as LanguageCode,
        theme: byId<HTMLSelectElement>('themeSelect').value,
        player_seek_seconds: Number(byId<HTMLInputElement>('playerSeekSeconds').value),
        sidebar_split_view: byId<HTMLInputElement>('sidebarSplitViewToggle').checked,
        download_mode: byId<HTMLSelectElement>('downloadMode').value as 'parts' | 'full',
        part_minutes: parseInt(byId<HTMLInputElement>('partMinutes').value, 10) || 120,
        parallel_downloads: parseInt(byId<HTMLSelectElement>('parallelDownloads').value, 10) || 1,
        performance_mode: byId<HTMLSelectElement>('performanceMode').value as 'stability' | 'balanced' | 'speed',
        prevent_duplicate_downloads: byId<HTMLInputElement>('duplicatePreventionToggle').checked,
        persist_queue_on_restart: byId<HTMLInputElement>('persistQueueToggle').checked,
        auto_resume_queue_on_startup: byId<HTMLInputElement>('autoResumeQueueToggle').checked,
        notify_on_each_completion: byId<HTMLInputElement>('notifyEachCompletionToggle').checked,
        streamlink_disable_ads: byId<HTMLInputElement>('streamlinkDisableAdsToggle').checked,
        download_chat_replay: byId<HTMLInputElement>('downloadChatReplayToggle').checked,
        capture_live_chat: byId<HTMLInputElement>('captureLiveChatToggle').checked,
        log_stream_events: byId<HTMLInputElement>('logStreamEventsToggle').checked,
        auto_resume_live_recording: byId<HTMLInputElement>('autoResumeLiveRecordingToggle').checked,
        auto_merge_resumed_parts: byId<HTMLInputElement>('autoMergeResumedPartsToggle').checked,
        delete_parts_after_merge: byId<HTMLInputElement>('deletePartsAfterMergeToggle').checked,
        discord_notify_live_start: byId<HTMLInputElement>('discordNotifyLiveStartToggle').checked,
        discord_notify_live_end: byId<HTMLInputElement>('discordNotifyLiveEndToggle').checked,
        discord_notify_vod_complete: byId<HTMLInputElement>('discordNotifyVodCompleteToggle').checked,
        discord_notify_vod_auto_queued: byId<HTMLInputElement>('discordNotifyVodAutoQueuedToggle').checked,
        auto_vod_download_poll_minutes: parseInt(byId<HTMLInputElement>('autoVodPollMinutes').value, 10) || 15,
        auto_vod_max_age_hours: parseInt(byId<HTMLInputElement>('autoVodMaxAgeHours').value, 10) || 24,
        auto_cleanup_enabled: byId<HTMLInputElement>('autoCleanupEnabledToggle').checked,
        auto_cleanup_days: parseInt(byId<HTMLInputElement>('autoCleanupDays').value, 10) || 30,
        auto_cleanup_target: byId<HTMLSelectElement>('autoCleanupTarget').value === 'all' ? 'all' : 'live_only',
        auto_cleanup_action: byId<HTMLSelectElement>('autoCleanupAction').value === 'delete' ? 'delete' : 'archive',
        streamlink_quality: 'source',
        metadata_cache_minutes: parseInt(byId<HTMLInputElement>('metadataCacheMinutes').value, 10) || 10,
        download_policy: parsedPolicy.value ?? config.download_policy ?? { throttle: null, windows: [] }
    };
}

function collectFilenameTemplatePayload(showAlert = false): Partial<AppConfig> | null {
    if (!validateFilenameTemplates(showAlert)) {
        return null;
    }

    return {
        filename_template_vod: byId<HTMLInputElement>('vodFilenameTemplate').value.trim() || '{title}.mp4',
        filename_template_parts: byId<HTMLInputElement>('partsFilenameTemplate').value.trim() || '{date}_Part{part_padded}.mp4',
        filename_template_clip: byId<HTMLInputElement>('defaultClipFilenameTemplate').value.trim() || '{date}_{part}.mp4'
    };
}

function collectAutoSavePayload(): Partial<AppConfig> {
    const payload: Partial<AppConfig> = {
        ...collectCredentialsPayload(),
        ...collectDownloadSettingsPayload(),
        sidebar_split_view: byId<HTMLInputElement>('sidebarSplitViewToggle').checked
    };

    const templatePayload = collectFilenameTemplatePayload(false);
    if (templatePayload) {
        Object.assign(payload, templatePayload);
    }

    return payload;
}

function getSettingsFingerprint(payload: Partial<AppConfig>): string {
    const effective = { ...config, ...payload };
    return JSON.stringify([
        effective.language ?? currentLanguage,
        effective.theme ?? 'twitch',
        effective.player_seek_seconds ?? 10,
        effective.client_id ?? '',
        byId<HTMLInputElement>('clientSecret').value,
        effective.sidebar_split_view !== false,
        effective.download_mode ?? 'full',
        effective.part_minutes ?? 120,
        effective.parallel_downloads ?? 1,
        effective.performance_mode ?? 'balanced',
        effective.prevent_duplicate_downloads !== false,
        effective.persist_queue_on_restart !== false,
        effective.auto_resume_queue_on_startup === true,
        effective.notify_on_each_completion === true,
        effective.streamlink_disable_ads !== false,
        effective.download_chat_replay === true,
        effective.capture_live_chat === true,
        effective.log_stream_events !== false,
        effective.auto_resume_live_recording !== false,
        effective.auto_merge_resumed_parts === true,
        effective.delete_parts_after_merge === true,
        byId<HTMLInputElement>('discordWebhookUrl').value,
        effective.discord_notify_live_start === true,
        effective.discord_notify_live_end === true,
        effective.discord_notify_vod_complete === true,
        effective.discord_notify_vod_auto_queued === true,
        effective.auto_vod_download_poll_minutes ?? 15,
        effective.auto_vod_max_age_hours ?? 24,
        effective.auto_cleanup_enabled === true,
        effective.auto_cleanup_days ?? 30,
        effective.auto_cleanup_target ?? 'live_only',
        effective.auto_cleanup_action ?? 'archive',
        'source',
        effective.metadata_cache_minutes ?? 10,
        effective.download_policy?.throttle?.maxBytesPerSecond ?? null,
        effective.download_policy?.windows ?? [],
        effective.filename_template_vod ?? '{title}.mp4',
        effective.filename_template_parts ?? '{date}_Part{part_padded}.mp4',
        effective.filename_template_clip ?? '{date}_{part}.mp4'
    ]);
}

function syncSettingsFormFromConfig(syncSecrets = true): void {
    syncPlayerSeekPreference();
    byId<HTMLInputElement>('clientId').value = config.client_id ?? '';
    if (syncSecrets) syncSecretFields();
    byId<HTMLInputElement>('sidebarSplitViewToggle').checked = config.sidebar_split_view !== false;
    applySidebarLayoutPreference(config.sidebar_split_view !== false);
    byId<HTMLSelectElement>('downloadMode').value = (config.download_mode as 'parts' | 'full') ?? 'full';
    byId<HTMLInputElement>('partMinutes').value = String((config.part_minutes as number) || 120);
    byId<HTMLSelectElement>('parallelDownloads').value = String((config.parallel_downloads as number) || 1);
    byId<HTMLSelectElement>('performanceMode').value = (config.performance_mode as string) || 'balanced';
    byId<HTMLInputElement>('duplicatePreventionToggle').checked = (config.prevent_duplicate_downloads as boolean) !== false;
    byId<HTMLInputElement>('persistQueueToggle').checked = (config.persist_queue_on_restart as boolean) !== false;
    byId<HTMLInputElement>('autoResumeQueueToggle').checked = (config.auto_resume_queue_on_startup as boolean) === true;
    byId<HTMLInputElement>('notifyEachCompletionToggle').checked = (config.notify_on_each_completion as boolean) === true;
    byId<HTMLInputElement>('streamlinkDisableAdsToggle').checked = (config.streamlink_disable_ads as boolean) !== false;
    byId<HTMLInputElement>('downloadThrottleMiBps').value = formatDownloadThrottle(config.download_policy?.throttle?.maxBytesPerSecond);
    byId<HTMLTextAreaElement>('downloadWindows').value = (config.download_policy?.windows ?? []).map((window) => `${window.start}-${window.end}`).join('\n');
    syncDownloadWindowRows();
    updateDownloadPolicyValidation(null);
    byId<HTMLInputElement>('downloadChatReplayToggle').checked = (config.download_chat_replay as boolean) === true;
    byId<HTMLInputElement>('captureLiveChatToggle').checked = (config.capture_live_chat as boolean) === true;
    byId<HTMLInputElement>('logStreamEventsToggle').checked = (config.log_stream_events as boolean) !== false;
    byId<HTMLInputElement>('autoResumeLiveRecordingToggle').checked = (config.auto_resume_live_recording as boolean) !== false;
    byId<HTMLInputElement>('autoMergeResumedPartsToggle').checked = (config.auto_merge_resumed_parts as boolean) === true;
    byId<HTMLInputElement>('deletePartsAfterMergeToggle').checked = (config.delete_parts_after_merge as boolean) === true;
    byId<HTMLInputElement>('discordNotifyLiveStartToggle').checked = (config.discord_notify_live_start as boolean) === true;
    byId<HTMLInputElement>('discordNotifyLiveEndToggle').checked = (config.discord_notify_live_end as boolean) === true;
    byId<HTMLInputElement>('discordNotifyVodCompleteToggle').checked = (config.discord_notify_vod_complete as boolean) === true;
    byId<HTMLInputElement>('discordNotifyVodAutoQueuedToggle').checked = (config.discord_notify_vod_auto_queued as boolean) === true;
    byId<HTMLInputElement>('autoVodPollMinutes').value = String((config.auto_vod_download_poll_minutes as number) || 15);
    byId<HTMLInputElement>('autoVodMaxAgeHours').value = String((config.auto_vod_max_age_hours as number) || 24);
    byId<HTMLInputElement>('autoCleanupEnabledToggle').checked = (config.auto_cleanup_enabled as boolean) === true;
    byId<HTMLInputElement>('autoCleanupDays').value = String((config.auto_cleanup_days as number) || 30);
    byId<HTMLSelectElement>('autoCleanupTarget').value = (config.auto_cleanup_target as string) === 'all' ? 'all' : 'live_only';
    byId<HTMLSelectElement>('autoCleanupAction').value = (config.auto_cleanup_action as string) === 'delete' ? 'delete' : 'archive';
    byId<HTMLInputElement>('metadataCacheMinutes').value = String((config.metadata_cache_minutes as number) || 10);
    byId<HTMLInputElement>('vodFilenameTemplate').value = (config.filename_template_vod as string) || '{title}.mp4';
    byId<HTMLInputElement>('partsFilenameTemplate').value = (config.filename_template_parts as string) || '{date}_Part{part_padded}.mp4';
    byId<HTMLInputElement>('defaultClipFilenameTemplate').value = (config.filename_template_clip as string) || '{date}_{part}.mp4';
    syncPartMinutesFieldState();
    void refreshDownloadPolicyStatus();
    validateFilenameTemplates();
    lastPersistedSettingsFingerprint = getSettingsFingerprint({});
}

async function persistSettings(options: {
    includeCredentials?: boolean;
    includeTemplates?: boolean;
    reconnectAfterSave?: boolean;
    showTemplateAlert?: boolean;
} = {}): Promise<boolean> {
    const payload: Partial<AppConfig> = {
        ...collectDownloadSettingsPayload()
    };

    if (options.includeCredentials) {
        Object.assign(payload, collectCredentialsPayload());
    }

    if (options.includeTemplates !== false) {
        const templatePayload = collectFilenameTemplatePayload(options.showTemplateAlert);
        if (!templatePayload) {
            return false;
        }
        Object.assign(payload, templatePayload);
    }

    const inputGeneration = settingsInputGeneration;
    try {
        await persistSecretInputs();
        config = await window.api.saveConfig(payload);
        setSettingsSaveFailed(false);
    } catch {
        setSettingsSaveFailed(true);
        return false;
    }
    if (settingsInputGeneration === inputGeneration) syncSettingsFormFromConfig(false);
    else scheduleSettingsAutoSave(0);
    pendingCredentialsReconnect = false;

    if (options.reconnectAfterSave) {
        await reconnectSettings();
    }

    if (canRunSettingsAutoRefresh()) {
        await refreshRuntimeMetrics(false);
    }

    return true;
}

async function flushSettingsAutoSave(reconnectAfterSave = false): Promise<void> {
    if (settingsAutoSaveTimer) {
        clearTimeout(settingsAutoSaveTimer);
        settingsAutoSaveTimer = null;
    }

    const payload = collectAutoSavePayload();
    const fingerprint = getSettingsFingerprint(payload);
    const inputGeneration = settingsInputGeneration;

    if (fingerprint === lastPersistedSettingsFingerprint) {
        if (reconnectAfterSave && pendingCredentialsReconnect) {
            pendingCredentialsReconnect = false;
            await reconnectSettings();
        }
        setSettingsSaveFailed(false);
        return;
    }

    if (settingsAutoSaveInFlight) {
        pendingSettingsAutoSave = true;
        return;
    }

    settingsAutoSaveInFlight = true;
    let saved = false;
    try {
        await persistSecretInputs();
        config = await window.api.saveConfig(payload);
        saved = true;
        setSettingsSaveFailed(false);
        if (settingsInputGeneration === inputGeneration) {
            lastPersistedSettingsFingerprint = getSettingsFingerprint({});
        } else {
            lastPersistedSettingsFingerprint = '';
            pendingSettingsAutoSave = true;
        }
        if (reconnectAfterSave && pendingCredentialsReconnect) {
            pendingCredentialsReconnect = false;
            await reconnectSettings();
        }
    } catch {
        setSettingsSaveFailed(true);
    } finally {
        settingsAutoSaveInFlight = false;
        const retry = pendingSettingsAutoSave && (saved || settingsInputGeneration !== inputGeneration);
        pendingSettingsAutoSave = false;
        if (retry) {
            void flushSettingsAutoSave(pendingCredentialsReconnect);
        }
    }
}

function scheduleSettingsAutoSave(delayMs = 450): void {
    if (settingsAutoSaveTimer) {
        clearTimeout(settingsAutoSaveTimer);
    }

    settingsAutoSaveTimer = window.setTimeout(() => {
        settingsAutoSaveTimer = null;
        void flushSettingsAutoSave(false);
    }, delayMs);
}


const settingsSectionAnimations = new WeakMap<HTMLDetailsElement, { expanded: boolean; animation: Animation | null }>();

function setSettingsSectionExpanded(details: HTMLDetailsElement, expanded: boolean, animate = true): void {
    const state = settingsSectionAnimations.get(details);
    const summary = details.querySelector<HTMLElement>(':scope > summary');
    const body = details.querySelector<HTMLElement>(':scope > .settings-section-body');
    if (!state || !summary || !body) {
        details.open = expanded;
        return;
    }
    const from = details.getBoundingClientRect().height;
    state.animation?.cancel();
    state.animation = null;
    state.expanded = expanded;
    summary.setAttribute('aria-expanded', String(expanded));
    const finish = (): void => {
        state.animation?.cancel();
        state.animation = null;
        details.open = state.expanded;
        details.style.removeProperty('overflow');
        body.inert = false;
    };
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches || from === 0) {
        finish();
        return;
    }
    details.open = true;
    body.inert = !expanded;
    const style = getComputedStyle(details);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const to = expanded ? details.getBoundingClientRect().height : summary.getBoundingClientRect().height + border;
    if (from === to) {
        finish();
        return;
    }
    details.style.overflow = 'hidden';
    const animation = details.animate([{ height: from + 'px' }, { height: to + 'px' }], {
        duration: 240,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        fill: 'both'
    });
    state.animation = animation;
    animation.onfinish = () => {
        if (state.animation === animation) finish();
    };
}

function initSettingsSectionAnimations(): void {
    const sections = document.querySelectorAll<HTMLDetailsElement>('#settingsTab [data-settings-pane="downloads"] details.settings-section');
    sections.forEach(details => {
        if (settingsSectionAnimations.has(details)) return;
        const state = { expanded: details.open, animation: null as Animation | null };
        settingsSectionAnimations.set(details, state);
        const summary = details.querySelector<HTMLElement>(':scope > summary');
        summary?.setAttribute('aria-expanded', String(details.open));
        summary?.addEventListener('click', event => {
            event.preventDefault();
            setSettingsSectionExpanded(details, !state.expanded);
        });
        details.addEventListener('toggle', () => {
            if (!state.animation || !details.open) setSettingsSectionExpanded(details, details.open, false);
        });
    });
    window.addEventListener('resize', () => {
        sections.forEach(details => {
            const state = settingsSectionAnimations.get(details);
            if (state?.animation) setSettingsSectionExpanded(details, state.expanded, false);
        });
    });
}

function initSettingsAutoSave(): void {
    if (settingsAutoSaveBound) {
        return;
    }

    settingsAutoSaveBound = true;
    initSettingsSectionAnimations();
    document.querySelectorAll<HTMLDetailsElement>('.settings-diagnostics').forEach(details => details.addEventListener('toggle', refreshVisibleSettingsDiagnostics));
    syncSettingsFormFromConfig();
    window.api.onDownloadPolicyStatus(renderDownloadPolicyStatus);

    const immediateSaveIds = [
        'downloadMode',
        'sidebarSplitViewToggle',
        'parallelDownloads',
        'performanceMode',
        'duplicatePreventionToggle',
        'persistQueueToggle',
        'autoResumeQueueToggle',
        'notifyEachCompletionToggle',
        'streamlinkDisableAdsToggle',
        'downloadChatReplayToggle',
        'captureLiveChatToggle',
        'logStreamEventsToggle',
        'autoResumeLiveRecordingToggle',
        'autoMergeResumedPartsToggle',
        'deletePartsAfterMergeToggle',
        'discordNotifyLiveStartToggle',
        'discordNotifyLiveEndToggle',
        'discordNotifyVodCompleteToggle',
        'discordNotifyVodAutoQueuedToggle',
        'autoCleanupEnabledToggle',
        'autoCleanupTarget',
        'autoCleanupAction'
    ] as const;

    const debouncedSaveIds = [
        'partMinutes',
        'metadataCacheMinutes',
        'vodFilenameTemplate',
        'partsFilenameTemplate',
        'defaultClipFilenameTemplate',
        'discordWebhookUrl',
        'autoVodPollMinutes',
        'autoVodMaxAgeHours',
        'autoCleanupDays',
        'downloadThrottleMiBps',
        'downloadWindows'
    ] as const;

    const credentialIds = [
        'clientId',
        'clientSecret'
    ] as const;

    const triggerImmediateSave = () => {
        void flushSettingsAutoSave(false);
    };

    byId<HTMLSelectElement>('downloadMode').addEventListener('change', syncPartMinutesFieldState);

    for (const id of immediateSaveIds) {
        const element = byId<HTMLInputElement | HTMLSelectElement>(id);
        element.addEventListener('change', () => {
            markSettingsInputChanged();
            triggerImmediateSave();
        });
        element.addEventListener('blur', triggerImmediateSave);
    }

    for (const id of debouncedSaveIds) {
        const element = byId<HTMLInputElement>(id);
        element.addEventListener('input', () => {
            markSettingsInputChanged();
            scheduleSettingsAutoSave();
        });
        element.addEventListener('blur', () => {
            void flushSettingsAutoSave(false);
        });
    }

    for (const id of credentialIds) {
        const element = byId<HTMLInputElement>(id);
        element.addEventListener('input', () => {
            markSettingsInputChanged();
            pendingCredentialsReconnect = true;
            scheduleSettingsAutoSave();
        });
        element.addEventListener('blur', () => {
            pendingCredentialsReconnect = true;
            void flushSettingsAutoSave(true);
        });
    }

    for (const id of ['clientSecret', 'discordWebhookUrl'] as const) {
        byId<HTMLInputElement>(id).addEventListener('input', () => {
            secretInputGenerations[id] += 1;
        });
    }

    for (const id of ['clientSecret', 'discordWebhookUrl'] as const) {
        byId<HTMLInputElement>(id).addEventListener('focus', (event) => {
            const input = event.currentTarget as HTMLInputElement;
            if (input.value === SECRET_INPUT_MASK) input.select();
        });
    }

    window.addEventListener('blur', () => {
        if (settingsAutoSaveTimer || pendingCredentialsReconnect) {
            void flushSettingsAutoSave(pendingCredentialsReconnect);
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && (settingsAutoSaveTimer || pendingCredentialsReconnect)) {
            void flushSettingsAutoSave(pendingCredentialsReconnect);
        }
    });
}

async function saveSettings(): Promise<void> {
    const saved = await persistSettings({
        includeCredentials: true,
        includeTemplates: true,
        reconnectAfterSave: true,
        showTemplateAlert: true
    });

    if (!saved) {
        return;
    }
}

async function selectFolder(): Promise<void> {
    let folder: (FileCapabilityReference & { displayPath: string }) | null;
    try {
        folder = await window.api.selectFolder();
        if (!folder) return;
        config = await window.api.saveConfig({ download_path: folder.displayPath }, folder.token);
        byId<HTMLInputElement>('downloadPath').value = folder.displayPath;
        syncClipStorage();
        await refreshClipLibraryDirectory();
    } catch {
        showAppToast(currentLanguage === 'de' ? 'Download-Ordner konnte nicht gespeichert werden.' : 'Download folder could not be saved.', 'warn');
        return;
    }
    invalidatePreflightResult();

    // Warn-only validation — the user explicitly chose this folder, so don't
    // refuse to save (they might be picking a path on a USB stick that's
    // currently disconnected). Just surface the writability problem early
    // instead of letting the next download fail with a cryptic error.
    try {
        const writable = await window.api.checkFolderWritable(folder.token);
        if (!writable) {
            const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
            if (toast) toast(UI_TEXT.static.downloadPathNotWritable, 'warn');
        }
    } catch { /* ignore — preflight will catch it later */ }
}

function openFolder(): void {
    const folder = config.download_path;
    if (!folder || typeof folder !== 'string') {
        return;
    }

    void window.api.openFolder(folder);
}

function syncWorkspaceThemePicker(theme: string): void {
    const selectedTheme = theme === 'light' || theme === 'system' ? theme : 'twitch';
    document.querySelectorAll<HTMLButtonElement>('#workspaceThemePicker [data-theme]').forEach((button) => {
        const active = button.dataset.theme === selectedTheme;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    scheduleSegmentedIndicatorSync(byId<HTMLElement>('workspaceThemePicker'));
}

function applyRendererTheme(theme: string): void {
    byId<HTMLSelectElement>('themeSelect').value = theme;
    for (const name of Array.from(document.body.classList)) {
        if (name.startsWith('theme-')) document.body.classList.remove(name);
    }
    document.body.classList.add(`theme-${theme}`);
    config.theme = theme;
    syncWorkspaceThemePicker(theme);
}

function selectWorkspaceTheme(theme: string): void {
    changeTheme(theme);
}

function changeTheme(theme: string): void {
    applyRendererTheme(theme);
    markSettingsInputChanged();
    void flushSettingsAutoSave();
}

function formatRelativeTime(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

async function refreshAutomationStatusLine(): Promise<void> {
    const lineEl = document.getElementById('autoVodStatusLine');
    if (!lineEl || automationRefreshInFlight) return;
    automationRefreshInFlight = true;
    try {
        const status = await window.api.getAutomationStatus();
        const now = Date.now();
        const de = currentLanguage === 'de';
        const parts: string[] = [];
        for (const [label, scan] of [['VODs', status.autoVod], [de ? 'Aufnahmen' : 'Recordings', status.autoRecord]] as const) {
            if (scan.watching <= 0) continue;
            const count = formatUiNumber(scan.watching);
            const channels = de ? (scan.watching === 1 ? 'Kanal' : 'Kanäle') : (scan.watching === 1 ? 'channel' : 'channels');
            const next = scan.inFlight ? (de ? 'Prüfung läuft' : 'Checking')
                : scan.nextRunAt > now ? (de ? 'nächste Prüfung in ' : 'next check in ') + formatRelativeTime(scan.nextRunAt - now)
                    : (de ? 'Prüfung ausstehend' : 'Check pending');
            parts.push(`${label}: ${count} ${channels} · ${next}`);
        }
        lineEl.textContent = parts.join(' · ') || (de ? 'Keine Kanäle ausgewählt.' : 'No channels selected.');
    } catch {
        lineEl.textContent = currentLanguage === 'de' ? 'Status nicht verfügbar.' : 'Status unavailable.';
    } finally { automationRefreshInFlight = false; }
}

function showAutomationScanResult(result: import('./types').AutomationScanResult, addedText: string, emptyText: string): void {
    const de = currentLanguage === 'de';
    if (result.skipped) {
        showAppToast(result.skipped === 'busy'
            ? (de ? 'Prüfung läuft bereits.' : 'A check is already running.')
            : (de ? 'Prüfung nicht verfügbar.' : 'Check unavailable.'), 'warn');
    } else if (result.failedCount > 0) {
        const partial = result.checkedCount > 0 || result.addedCount > 0;
        const failure = partial ? (de ? 'Prüfung unvollständig.' : 'Check incomplete.')
            : (de ? 'Prüfung fehlgeschlagen.' : 'Check failed.');
        showAppToast(result.addedCount > 0 ? addedText + ' ' + failure : failure, 'warn');
    } else if (result.checkedCount === 0) {
        showAppToast(de ? 'Keine Kanäle ausgewählt.' : 'No channels selected.', 'info');
    } else {
        showAppToast(result.addedCount > 0 ? addedText : emptyText, 'info');
    }
}

async function triggerManualAutoVodScan(): Promise<void> {
    const btn = document.getElementById('btnAutoVodScanNow') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
        const result = await window.api.triggerAutoVodScan();
        showAutomationScanResult(result, UI_TEXT.streamers.autoVodScanQueued.replace('{count}', formatUiNumber(result.queuedCount)), UI_TEXT.streamers.autoVodScanEmpty);
    } catch {
        showAppToast(currentLanguage === 'de' ? 'Prüfung fehlgeschlagen.' : 'Check failed.', 'warn');
    } finally {
        if (btn) btn.disabled = false;
        void refreshAutomationStatusLine();
    }
}

async function triggerManualAutoRecordScan(): Promise<void> {
    const btn = document.getElementById('btnAutoRecordScanNow') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
        const result = await window.api.triggerAutoRecordScan();
        showAutomationScanResult(result, UI_TEXT.streamers.autoRecordScanTriggered.replace('{count}', formatUiNumber(result.triggered)), UI_TEXT.streamers.autoRecordScanEmpty);
    } catch {
        showAppToast(currentLanguage === 'de' ? 'Prüfung fehlgeschlagen.' : 'Check failed.', 'warn');
    } finally {
        if (btn) btn.disabled = false;
        void refreshAutomationStatusLine();
    }
}

(window as unknown as { triggerManualAutoVodScan: typeof triggerManualAutoVodScan }).triggerManualAutoVodScan = triggerManualAutoVodScan;
(window as unknown as { triggerManualAutoRecordScan: typeof triggerManualAutoRecordScan }).triggerManualAutoRecordScan = triggerManualAutoRecordScan;

async function runApplicationBackup(restore: boolean): Promise<void> {
    const buttons = ['btnCreateBackup', 'btnRestoreBackup'].map(id => byId<HTMLButtonElement>(id));
    buttons.forEach(button => button.disabled = true);
    try {
        const result = await (restore ? window.api.restoreApplicationBackup() : window.api.exportApplicationBackup());
        if (result.cancelled || (restore && result.success)) return;
        showAppToast(result.success ? UI_TEXT.static.backupSaved : result.error === 'busy' ? UI_TEXT.static.backupBusy : UI_TEXT.static.backupFailed, result.success ? 'info' : 'warn');
    } catch { showAppToast(UI_TEXT.static.backupFailed, 'warn'); }
    finally { buttons.forEach(button => button.disabled = false); }
}
