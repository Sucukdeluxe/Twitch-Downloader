let archiveStatsRefreshInFlight = false;
let archiveStatsRefreshPending = false;
let lastArchiveStats: ArchiveStats | null = null;
let downloadHistoryOffset = 0;
let downloadHistorySequence = 0;
let downloadHistoryTimer: number | null = null;
let statsSelectedChannel = '';
const statsMotionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const statsActiveAnimations = new Set<Animation>();

statsMotionPreference.addEventListener('change', () => {
    if (statsMotionPreference.matches) for (const animation of statsActiveAnimations) animation.cancel();
});

function animateStatsElement(element: HTMLElement, frames: Keyframe[], duration: number): void {
    if (statsMotionPreference.matches || !element.isConnected || !element.getClientRects().length || typeof element.animate !== 'function') return;
    for (const animation of element.getAnimations()) animation.cancel();
    const animation = element.animate(frames, { duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    statsActiveAnimations.add(animation);
    void animation.finished.then(() => statsActiveAnimations.delete(animation), () => statsActiveAnimations.delete(animation));
}

function captureStatsMotion(): Map<string, { text: string; transform: string }> {
    const state = new Map<string, { text: string; transform: string }>();
    if (statsMotionPreference.matches) return state;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('#statsTab [data-stats-motion]'))) {
        state.set(element.dataset.statsMotion!, { text: element.textContent || '', transform: getComputedStyle(element).transform });
    }
    return state;
}

function playStatsMotion(previous: Map<string, { text: string; transform: string }>): void {
    if (!previous.size || statsMotionPreference.matches) return;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('#statsTab [data-stats-motion]'))) {
        const old = previous.get(element.dataset.statsMotion!);
        if (element.dataset.statsScale) {
            const from = old?.transform || (element.dataset.statsScale === 'y' ? 'scaleY(0)' : 'scaleX(0)');
            const to = getComputedStyle(element).transform;
            if (from !== to) animateStatsElement(element, [{ transform: from }, { transform: to }], 240);
        } else if (old && old.text !== element.textContent) {
            animateStatsElement(element, [{ opacity: 0.45 }, { opacity: 1 }], 160);
        }
    }
}

function getDownloadHistoryPageSize(): number {
    const height = document.getElementById('downloadHistory')?.clientHeight || 396;
    return Math.max(1, Math.min(50, Math.floor(height / 66)));
}

function createStatsChannelIdentity(login: string): HTMLElement {
    const identity = document.createElement('span');
    identity.className = 'stats-channel-identity';
    if (!login) { identity.textContent = currentLanguage === 'de' ? 'Unbekannt' : 'Unknown'; return identity; }
    const avatar = document.createElement('span');
    avatar.className = 'stats-channel-avatar';
    avatar.dataset.statsAvatar = login;
    avatar.textContent = login.slice(0, 1).toUpperCase();
    const cached = streamerProfileCache.get(login.toLowerCase());
    if (cached?.avatarUrl) {
        const image = document.createElement('img'); image.alt = ''; image.src = cached.avatarUrl; image.decoding = 'async';
        image.addEventListener('error', () => { avatar.textContent = login.slice(0, 1).toUpperCase(); }, { once: true });
        avatar.replaceChildren(image);
    }
    const name = document.createElement('span');
    name.dataset.statsName = login;
    name.textContent = getStreamerDisplayName(login);
    identity.append(avatar, name);
    return identity;
}

function hydrateStatsChannelProfiles(container: HTMLElement): void {
    const logins = new Set(Array.from(container.querySelectorAll<HTMLElement>('[data-stats-name]')).map(node => node.dataset.statsName!));
    for (const login of logins) {
        void fetchStreamerProfile(login).then(profile => {
            if (!profile || !container.isConnected) return;
            rememberStreamerDisplayName(profile.login, profile.displayName);
            for (const node of Array.from(container.querySelectorAll<HTMLElement>('[data-stats-name]'))) {
                if (node.dataset.statsName?.toLowerCase() === login.toLowerCase()) node.textContent = profile.displayName;
            }
            if (!profile.avatarUrl) return;
            for (const node of Array.from(container.querySelectorAll<HTMLElement>('[data-stats-avatar]'))) {
                if (node.dataset.statsAvatar?.toLowerCase() !== login.toLowerCase() || node.querySelector('img')?.getAttribute('src') === profile.avatarUrl) continue;
                const image = document.createElement('img'); image.alt = ''; image.src = profile.avatarUrl; image.decoding = 'async';
                image.addEventListener('error', () => { node.textContent = profile.displayName.slice(0, 1).toUpperCase(); }, { once: true });
                node.replaceChildren(image);
            }
        }).catch(() => {});
    }
}

function renderStatsChannelNav(channels: ArchiveStatsTopStreamer[]): void {
    const host = document.getElementById('statsChannelNav');
    if (!host) return;
    const available = channels.filter(channel => channel.bytes > 0 && channel.fileCount > 0);
    if (statsSelectedChannel && !available.some(channel => channel.streamer.toLowerCase() === statsSelectedChannel)) {
        statsSelectedChannel = ''; archiveStatsRefreshPending = true;
    }
    const existing = new Map(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).map(button => [button.dataset.channel || '', button]));
    const retained = new Set<HTMLButtonElement>();
    for (const login of ['', ...available.map(channel => channel.streamer)]) {
        const key = login.toLowerCase();
        let button = existing.get(key);
        if (!button) {
            button = document.createElement('button'); button.type = 'button'; button.className = 'stats-channel-button'; button.dataset.channel = key;
            if (login) button.append(createStatsChannelIdentity(login));
            button.addEventListener('click', () => {
                if (statsSelectedChannel === key) return;
                statsSelectedChannel = key; downloadHistoryOffset = 0;
                for (const item of Array.from(host.querySelectorAll<HTMLButtonElement>('button'))) item.setAttribute('aria-pressed', String(item.dataset.channel === key));
                void refreshArchiveStats();
            });
        }
        if (!login) button.textContent = currentLanguage === 'de' ? 'Alle Streamer' : 'All channels';
        button.setAttribute('aria-pressed', String(statsSelectedChannel === key));
        retained.add(button);
        const position = host.children[retained.size - 1];
        if (position !== button) host.insertBefore(button, position || null);
    }
    for (const button of existing.values()) if (!retained.has(button)) button.remove();
}

async function refreshArchiveStats(): Promise<void> {
    if (archiveStatsRefreshInFlight) { archiveStatsRefreshPending = true; return; }
    archiveStatsRefreshInFlight = true;
    for (const id of ['btnStatsRefresh', 'toolbarStatsRefreshBtn']) {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        if (button) button.disabled = true;
    }
    const status = document.getElementById('statsStatus');
    if (status) {
        status.textContent = UI_TEXT.static.statsScanning;
        status.classList.remove('is-error');
    }
    document.getElementById('statsTab')?.setAttribute('aria-busy', 'true');
    if (!lastArchiveStats) renderStatsSummary(null);
    try {
        const range = getStatsRange();
        const result = await window.api.getArchiveStats(range);
        if (archiveStatsRefreshPending || JSON.stringify(range) !== JSON.stringify(getStatsRange())) return;
        lastArchiveStats = result;
        renderArchiveStats(lastArchiveStats);
        if (status) status.textContent = '';
        await refreshDownloadHistory();
    } catch (error) {
        if (status) {
            status.textContent = UI_TEXT.static.errorPrefix + ': ' + (error instanceof Error ? error.message : String(error));
            status.classList.add('is-error');
        }
    } finally {
        archiveStatsRefreshInFlight = false;
        document.getElementById('statsTab')?.setAttribute('aria-busy', 'false');
        for (const id of ['btnStatsRefresh', 'toolbarStatsRefreshBtn']) {
            const button = document.getElementById(id) as HTMLButtonElement | null;
            if (button) button.disabled = false;
        }
        if (archiveStatsRefreshPending) { archiveStatsRefreshPending = false; void refreshArchiveStats(); }
    }
}

function refreshArchiveStatsTexts(): void {
    refreshStatsFilterTexts();
    if (lastArchiveStats) renderArchiveStats(lastArchiveStats);
    void refreshDownloadHistory();
    if (archiveStatsRefreshInFlight) setText('statsStatus', UI_TEXT.static.statsScanning);
}

function renderArchiveStats(stats: ArchiveStats): void {
    const motion = captureStatsMotion();
    refreshStatsFilterTexts();
    setText('statsLastScannedLabel', UI_TEXT.static.statsScannedAt + ': ' + formatUiDateTime(new Date(stats.scannedAt)));
    const lifetime = stats.lifetime;
    setText('statsTrackingSince', lifetime?.available && lifetime.trackedSince
        ? UI_TEXT.static.statsTrackedSince.replace('{date}', formatUiDate(new Date(lifetime.trackedSince))) : '');
    setText('statsHistoryNote', lifetime?.available ? '' : UI_TEXT.static.statsHistoryUnavailable);
    setText('statsInventoryStatus', stats.rootExists ? '' : UI_TEXT.static.statsNoRoot);
    renderStatsChannelNav(stats.channels ?? stats.topStreamers);
    renderStatsSummary(stats);
    renderStatsInventory(stats);
    renderStatsTopStreamers(stats.topStreamers, stats.totalBytes);
    renderStatsActivity(lifetime?.available ? lifetime.dailyActivity : [], lifetime?.unknownDateDownloads || 0);
    renderStatsSizeBuckets(stats.sizeBuckets);
    hydrateStatsChannelProfiles(document.getElementById('statsTab')!);
    playStatsMotion(motion);
}

function renderStatsSummary(stats: ArchiveStats | null): void {
    const grid = document.getElementById('statsSummaryGrid');
    if (!grid) return;
    const lifetime = stats?.lifetime;
    const available = !!lifetime?.available;
    const number = (value: number | undefined) => available ? formatUiNumber(value || 0) : '—';
    const cards = [
        { label: UI_TEXT.static.statsVodRecordings, value: number(lifetime?.vodDownloads), kind: 'vod' },
        { label: UI_TEXT.static.statsLiveRecordings, value: number(lifetime?.liveRecordings), kind: 'live' },
        { label: UI_TEXT.static.statsClipDownloads, value: number(lifetime?.clipDownloads), kind: 'clips' },
        { label: UI_TEXT.static.statsDownloadedBytes, value: available ? formatBytes(lifetime?.totalBytes || 0) : '—', kind: 'bytes' }
    ];
    const fragments = cards.map(card => {
        const item = document.createElement('article');
        item.className = 'stats-kpi-card stats-kpi-' + card.kind;
        const label = document.createElement('div');
        label.className = 'stats-kpi-label';
        label.textContent = card.label;
        const value = document.createElement('div');
        value.className = 'stats-kpi-value';
        value.dataset.statsMotion = 'summary-' + card.kind;
        value.textContent = card.value;
        item.append(label, value);
        return item;
    });
    grid.replaceChildren(...fragments);
}

function renderStatsInventory(stats: ArchiveStats): void {
    const grid = document.getElementById('statsInventoryGrid');
    if (!grid) return;
    const cards = [
        { label: UI_TEXT.static.statsTotalRecordings, value: formatUiNumber(stats.liveCount + stats.vodCount + (stats.clipCount || 0)) },
        { label: UI_TEXT.static.statsArchiveSize, value: formatBytes(stats.totalBytes) },
        { label: UI_TEXT.static.statsStreamers, value: formatUiNumber(stats.streamerCount) },
        { label: UI_TEXT.static.statsChatFiles, value: formatUiNumber(stats.chatCount) },
        { label: UI_TEXT.static.statsAvgSize, value: stats.avgRecordingSizeBytes > 0 ? formatBytes(stats.avgRecordingSizeBytes) : '—' }
    ];
    applyHtml(grid, cards.map((card, index) => '<div class="stats-inventory-item"><strong data-stats-motion="inventory-' + index + '">' + escapeHtml(stats.rootExists ? card.value : '—') + '</strong><span>' + escapeHtml(card.label) + '</span></div>').join(''));
}

function renderStatsTopStreamers(top: ArchiveStatsTopStreamer[], totalBytes: number): void {
    const container = document.getElementById('statsTopStreamers');
    if (!container) return;
    top = top.filter(item => Number.isFinite(item.bytes) && item.bytes > 0 && item.fileCount > 0);
    if (top.length === 0) {
        applyHtml(container, '<div class="insights-empty">' + escapeHtml(UI_TEXT.static.statsEmpty) + '</div>');
        return;
    }
    const maxBytes = Math.max(1, ...top.map(item => item.bytes));
    container.classList.add('stats-top-list');
    applyHtml(container, top.map(item => {
        const percent = Math.min(100, Math.max(0, item.bytes / maxBytes * 100));
        const share = new Intl.NumberFormat(getIntlLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(totalBytes > 0 ? item.bytes / totalBytes : 0);
        return '<div class="stats-top-row"><span class="stats-channel-avatar" data-stats-avatar="' + escapeHtml(item.streamer) + '">' + escapeHtml(item.streamer.slice(0, 1).toUpperCase()) + '</span><div class="stats-top-meta"><strong data-stats-name="' + escapeHtml(item.streamer) + '">' + escapeHtml(getStreamerDisplayName(item.streamer)) + '</strong><span data-stats-motion="streamer-value-' + escapeHtml(item.streamer.toLowerCase()) + '">' + escapeHtml(formatBytes(item.bytes)) + '</span></div><div class="stats-top-bar-track"><div class="stats-top-bar-fill" data-stats-motion="streamer-bar-' + escapeHtml(item.streamer.toLowerCase()) + '" data-stats-scale="x" style="transform:scaleX(' + percent / 100 + ')"></div></div><div class="stats-top-caption"><span>' + escapeHtml(formatUiNumber(item.fileCount) + ' ' + UI_TEXT.static.statsFiles) + '</span><span>' + escapeHtml(share) + '</span></div></div>';
    }).join(''));
}

function renderStatsActivity(days: ArchiveStatsDay[], unknownDates = 0): void {
    const originalDays = days;
    let buckets = days.map(day => ({ ...day, endDate: day.date }));
    if (days.length > 90) {
        const width = Math.ceil(days.length / 90);
        buckets = [];
        for (let i = 0; i < originalDays.length; i += width) {
            const group = originalDays.slice(i, i + width);
            buckets.push({ date: group[0].date, endDate: group[group.length - 1].date, count: group.reduce((sum, day) => sum + day.count, 0), bytes: group.reduce((sum, day) => sum + day.bytes, 0) });
        }
    }
    setText('statsActivityTitle', (currentLanguage === 'de' ? 'Download-Aktivität · ' : 'Download activity · ') + formatUiNumber(originalDays.length) + (currentLanguage === 'de' ? ' Tage' : ' days'));
    const container = document.getElementById('statsActivity');
    if (!container) return;
    const totalCount = buckets.reduce((sum, day) => sum + day.count, 0);
    const totalBytes = buckets.reduce((sum, day) => sum + day.bytes, 0);
    const maxCount = Math.max(1, ...buckets.map(day => day.count));
    const fullDate = new Intl.DateTimeFormat(getIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
    const bars = buckets.map((day, index) => {
        const date = new Date(day.date + 'T12:00:00');
        const dateLabel = new Intl.DateTimeFormat(getIntlLocale(), { day: 'numeric', month: 'short' }).format(date);
        const dateRange = fullDate.format(date) + (day.endDate !== day.date ? ' – ' + fullDate.format(new Date(day.endDate + 'T12:00:00')) : '');
        const tooltip = dateRange + ': ' + formatUiNumber(day.count) + ' ' + UI_TEXT.static.statsDownloads + ' · ' + formatBytes(day.bytes);
        const showLabel = index === 0 || index === buckets.length - 1 || (index % Math.max(7, Math.ceil(buckets.length / 5)) === 0 && buckets.length - 1 - index >= 4);
        const height = day.count > 0 ? Math.max(3, day.count / maxCount * 100) : 0;
        return '<div class="stats-day-col" title="' + escapeHtml(tooltip) + '"><div class="stats-day-bar-track"><div class="stats-day-bar-fill" data-stats-motion="day-' + day.date + '" data-stats-scale="y" style="transform:scaleY(' + height / 100 + ')"></div></div><span class="stats-day-label">' + (showLabel ? escapeHtml(dateLabel) : '') + '</span></div>';
    }).join('');
    const summary = UI_TEXT.static.statsActivitySummary.replace('{count}', formatUiNumber(totalCount)).replace('{size}', formatBytes(totalBytes));
    const note = unknownDates > 0 ? '<p class="insights-note">' + escapeHtml(UI_TEXT.static.statsUnknownDates.replace('{count}', formatUiNumber(unknownDates))) + '</p>' : '';
    applyHtml(container, '<div class="stats-activity-total" data-stats-motion="activity-total">' + escapeHtml(summary) + '</div><div class="stats-activity-chart"><div class="stats-activity-row">' + bars + '</div>' + (totalCount === 0 ? '<div class="stats-chart-empty">' + escapeHtml(UI_TEXT.static.statsActivityEmpty) + '</div>' : '') + '</div>' + note);
}

function renderStatsSizeBuckets(buckets: ArchiveStatsBucket[]): void {
    const container = document.getElementById('statsSizeBuckets');
    if (!container) return;
    const maxCount = Math.max(1, ...buckets.map(bucket => bucket.count));
    if (!buckets.some(bucket => bucket.count > 0)) {
        applyHtml(container, '<div class="insights-empty">' + escapeHtml(UI_TEXT.static.statsEmpty) + '</div>');
        return;
    }
    applyHtml(container, buckets.map(bucket => {
        const percent = Math.min(100, bucket.count / maxCount * 100);
        return '<div class="stats-bucket-row"><div class="stats-bucket-meta"><span>' + escapeHtml(bucket.label) + '</span><strong data-stats-motion="bucket-value-' + escapeHtml(bucket.label) + '">' + escapeHtml(formatUiNumber(bucket.count)) + '</strong></div><div class="stats-bucket-bar-track"><div class="stats-bucket-bar-fill" data-stats-motion="bucket-bar-' + escapeHtml(bucket.label) + '" data-stats-scale="x" style="transform:scaleX(' + percent / 100 + ')"></div></div></div>';
    }).join(''));
}

(window as unknown as { refreshArchiveStats: typeof refreshArchiveStats }).refreshArchiveStats = refreshArchiveStats;


function getStatsRange(): import('./main/domain/download-history-store').DownloadHistoryRange | undefined {
    const range = (document.getElementById('statsRange') as HTMLSelectElement | null)?.value || 'all';
    const channel = statsSelectedChannel || undefined;
    if (range === 'all') return channel ? { channel } : undefined;
    if (range !== 'custom') return { days: Number(range) as 7 | 30 | 90, channel };
    const since = (document.getElementById('statsSince') as HTMLInputElement | null)?.value || '';
    const until = (document.getElementById('statsUntil') as HTMLInputElement | null)?.value || '';
    if (!since || !until || since > until) throw new Error(currentLanguage === 'de' ? 'Zeitraum prüfen.' : 'Check the date range.');
    return { since, until, channel };
}

function changeStatsRange(): void {
    const custom = (document.getElementById('statsRange') as HTMLSelectElement | null)?.value === 'custom';
    const fields = document.getElementById('statsCustomRange');
    if (fields) fields.hidden = !custom;
    if (custom) {
        const format = (date: Date) => String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        const until = document.getElementById('statsUntil') as HTMLInputElement;
        const since = document.getElementById('statsSince') as HTMLInputElement;
        if (!until.value) until.value = format(new Date());
        if (!since.value) { const start = new Date(); start.setDate(start.getDate() - 29); since.value = format(start); }
    }
    downloadHistoryOffset = 0;
    void refreshArchiveStats();
}

function refreshStatsFilterTexts(): void {
    const de = currentLanguage === 'de';
    document.getElementById('statsChannelNav')?.setAttribute('aria-label', de ? 'Streamer auswählen' : 'Select channel');
    const query = document.getElementById('historyQuery') as HTMLInputElement | null;
    if (query) query.placeholder = de ? 'Titel oder Streamer suchen' : 'Search title or channel';
    for (const [id, text] of Object.entries({ statsRangeLabel: de ? 'Zeitraum' : 'Date range', statsSinceLabel: de ? 'Von' : 'From', statsUntilLabel: de ? 'Bis' : 'Until', statsHistoryTitle: de ? 'Downloadverlauf' : 'Download history', statsExportCsv: de ? 'Statistik als CSV' : 'Export statistics', historyQueryLabel: de ? 'Titel oder Streamer' : 'Title or channel', historyKindLabel: de ? 'Typ' : 'Type', historyPrevious: de ? 'Zurück' : 'Previous', historyNext: de ? 'Weiter' : 'Next' })) setText(id, text);
    const kind = document.getElementById('historyKind') as HTMLSelectElement | null;
    if (kind?.options[0]) kind.options[0].textContent = de ? 'Alle' : 'All';
    const range = document.getElementById('statsRange') as HTMLSelectElement | null;
    if (range) for (const option of Array.from(range.options)) option.textContent = option.value === 'all' ? de ? 'Gesamt' : 'All time' : option.value === 'custom' ? de ? 'Benutzerdefiniert' : 'Custom' : option.value + (de ? ' Tage' : ' days');
}

function getDownloadHistoryFilter() {
    return { ...getStatsRange(), query: (document.getElementById('historyQuery') as HTMLInputElement | null)?.value.trim() || '', kind: ((document.getElementById('historyKind') as HTMLSelectElement | null)?.value || 'all') as 'all' | 'vod' | 'clip' | 'live', offset: downloadHistoryOffset, limit: getDownloadHistoryPageSize() };
}

function onDownloadHistoryInput(): void {
    downloadHistoryOffset = 0;
    if (downloadHistoryTimer !== null) window.clearTimeout(downloadHistoryTimer);
    downloadHistoryTimer = window.setTimeout(() => { downloadHistoryTimer = null; void refreshDownloadHistory(); }, 250);
}

async function refreshDownloadHistory(): Promise<void> {
    const host = document.getElementById('downloadHistory');
    if (!host) return;
    const sequence = ++downloadHistorySequence;
    host.setAttribute('aria-busy', 'true');
    try {
        const result = await window.api.searchDownloadHistory(getDownloadHistoryFilter());
        if (sequence !== downloadHistorySequence) return;
        downloadHistoryOffset = result.offset;
        const fragment = document.createDocumentFragment();
        resetArchiveThumbnails(host);
        for (const entry of result.entries) {
            const row = document.createElement('article'); row.className = 'download-history-row';
            const content = document.createElement('div'); content.className = 'download-history-body';
            const title = document.createElement('strong'); title.textContent = entry.title || (entry.kind.toUpperCase() + ' · ' + entry.sourceIds.join(', '));
            const meta = document.createElement('div'); meta.className = 'download-history-meta';
            const presence = { present: currentLanguage === 'de' ? 'Datei vorhanden' : 'File available', partial: currentLanguage === 'de' ? 'Teilweise vorhanden' : 'Some files missing', missing: currentLanguage === 'de' ? 'Datei fehlt' : 'File missing', unknown: currentLanguage === 'de' ? 'Dateipfad unbekannt' : 'File path unknown' };
            meta.textContent = [entry.completedAt ? formatUiDateTime(new Date(entry.completedAt)) : (currentLanguage === 'de' ? 'Datum unbekannt' : 'Date unknown'), entry.kind === 'live' ? 'Live' : entry.kind.toUpperCase(), presence[entry.filePresence]].filter(Boolean).join(' · ');
            content.append(title, meta);
            const filename = entry.availablePaths[0];
            const thumbnail = filename ? createArchiveThumbnail({ fullPath: filename, fileName: title.textContent || '', streamer: entry.channel || '', type: entry.kind, size: entry.totalBytes, mtimeMs: entry.completedAt ? Date.parse(entry.completedAt) : 0, chatPath: null, eventsPath: null }) : document.createElement('div');
            thumbnail.className = 'archive-result-thumbnail';
            if (!filename) thumbnail.textContent = entry.kind.toUpperCase();
            const identity = createStatsChannelIdentity(entry.channel || ''); identity.classList.add('download-history-channel');
            const bytes = document.createElement('span'); bytes.className = 'download-history-bytes'; bytes.textContent = formatBytes(entry.totalBytes);
            row.append(thumbnail, content, identity, bytes);
            if (entry.sourceUrl) { const source = document.createElement('button'); source.type = 'button'; source.className = 'btn-secondary'; source.textContent = currentLanguage === 'de' ? 'Quelle' : 'Source'; source.addEventListener('click', () => { void window.api.openExternal(entry.sourceUrl!); }); row.append(source); }
            if (entry.availablePaths[0]) {
                const open = document.createElement('button'); open.type = 'button'; open.className = 'btn-secondary'; open.textContent = currentLanguage === 'de' ? 'Ordner' : 'Folder';
                open.addEventListener('click', () => showFileInFolder(entry.availablePaths[0])); row.append(open);
            }
            fragment.append(row);
        }
        if (!result.entries.length) { const empty = document.createElement('div'); empty.className = 'insights-empty'; empty.textContent = currentLanguage === 'de' ? 'Keine Downloads gefunden.' : 'No downloads found.'; fragment.append(empty); }
        const previousContent = host.textContent;
        host.replaceChildren(fragment);
        if (previousContent && previousContent !== host.textContent) animateStatsElement(host, [{ opacity: 0.6 }, { opacity: 1 }], 160);
        hydrateStatsChannelProfiles(host);
        setText('historyPageLabel', formatUiNumber(result.total ? result.offset + 1 : 0) + '–' + formatUiNumber(result.offset + result.entries.length) + (currentLanguage === 'de' ? ' von ' : ' of ') + formatUiNumber(result.total));
        setText('downloadHistoryStatus', formatUiNumber(result.total) + (currentLanguage === 'de' ? ' Downloads' : ' downloads'));
        const previous = document.getElementById('historyPrevious') as HTMLButtonElement | null;
        const next = document.getElementById('historyNext') as HTMLButtonElement | null;
        if (previous) previous.disabled = result.offset === 0;
        if (next) next.disabled = result.offset + result.entries.length >= result.total;
    } catch (error) {
        if (sequence === downloadHistorySequence) setText('downloadHistoryStatus', error instanceof Error ? error.message : String(error));
    } finally { if (sequence === downloadHistorySequence) host.setAttribute('aria-busy', 'false'); }
}

function changeDownloadHistoryPage(direction: number): void {
    if (Math.abs(direction) !== 1) return;
    downloadHistoryOffset = Math.max(0, downloadHistoryOffset + direction * getDownloadHistoryPageSize());
    void refreshDownloadHistory();
}

async function exportStatsCsv(): Promise<void> {
    try { await window.api.exportStatistics(getStatsRange()); }
    catch (error) { setText('statsStatus', error instanceof Error ? error.message : String(error)); }
}

Object.assign(window, { changeStatsRange, onDownloadHistoryInput, changeDownloadHistoryPage, exportStatsCsv });
