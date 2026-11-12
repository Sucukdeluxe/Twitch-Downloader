const RendererClipDiscovery = (() => {
    type Clip = import('./main/domain/clip-discovery').DiscoveredClip;
    type Request = import('./main/domain/clip-discovery').ClipDiscoveryRequest;
    type Result = import('./main/domain/clip-discovery').ClipDiscoveryResult;
    type Annotation = { url: string; state: string; previouslyDownloaded?: boolean };
    const bridge = () => window.api as typeof window.api & { discoverClips(request: Request): Promise<Result> };
    const downloaded = new Map<string, Promise<boolean>>();
    let dialog: HTMLDialogElement | null = null;
    let clips: Clip[] = [];
    const selected = new Set<string>();
    let cursor: string | null = null;
    const cursors = new Set<string>();
    let lastRequest: Request | null = null;
    let sequence = 0;
    let busy = false;
    let previewDialog: HTMLDialogElement | null = null;
    let previewId: string | null = null;
    let previewPlayer: { destroy(): void } | null = null;
    function stopPreview(): void {
        previewPlayer?.destroy(); previewPlayer = null;
        const id = previewId; previewId = null;
        if (id) void bridge().closeClipPlayback(id).catch(() => undefined);
    }
    function clipDuration(seconds: number): string {
        if (!Number.isFinite(seconds) || seconds <= 0) return '';
        const whole = Math.round(seconds);
        const hours = Math.floor(whole / 3600);
        return (hours ? hours + ':' : '') + String(Math.floor(whole / 60) % 60).padStart(2, '0') + ':' + String(whole % 60).padStart(2, '0');
    }
    async function showPreview(clip: Clip): Promise<void> {
        stopPreview();
        if (!previewDialog) {
            previewDialog = element('dialog', 'clip-preview-dialog'); previewDialog.id = 'clipPreviewDialog';
            previewDialog.setAttribute('aria-labelledby', 'clipPreviewTitle');
            previewDialog.addEventListener('close', stopPreview);
            document.body.append(previewDialog);
        }
        const header = element('header', 'clip-discovery-header');
        const title = element('h2', '', clip.title || clip.id); title.id = 'clipPreviewTitle';
        header.append(title, button(text('Schließen', 'Close'), () => previewDialog?.close()));
        const host = element('div', 'clip-preview-player');
        const status = element('p', 'clip-preview-status', text('Clip wird geöffnet …', 'Opening clip …')); status.setAttribute('role', 'status');
        const retry = button(text('Erneut laden', 'Retry'), () => { void showPreview(clip); }); retry.hidden = true;
        previewDialog.replaceChildren(header, element('p', 'clip-preview-meta', [clip.channel, clipDuration(clip.duration)].filter(Boolean).join(' · ')), host, status, retry);
        if (!previewDialog.open) previewDialog.showModal();
        const id = crypto.randomUUID(); previewId = id;
        const failed = () => { if (previewId !== id) return; status.hidden = false; status.textContent = text('Clip konnte nicht geladen werden.', 'Could not load the clip.'); retry.hidden = false; };
        try {
            const result = await bridge().openClipPlayback({ id, url: clip.url });
            if (previewId !== id || !previewDialog.open) { void bridge().closeClipPlayback(id).catch(() => undefined); return; }
            if (!result || !window.VodPlayer?.mountPreview) { failed(); return; }
            status.hidden = true;
            previewPlayer = window.VodPlayer.mountPreview(host, { id: 'clip-' + clip.id, sourceUrl: result.sourceUrl, duration: clip.duration, language: currentLanguage, onError: failed });
        } catch { failed(); }
    }
    const text = (de: string, en: string) => currentLanguage === 'de' ? de : en;
    const element = RendererElements.element;
    const input = (id: string) => document.getElementById(id) as HTMLInputElement;
    const notice = (message: string) => { const node = document.getElementById('clipDiscoveryStatus'); if (node) node.textContent = message; };
    const button = RendererElements.button;
    function ensureDialog(): HTMLDialogElement {
        if (dialog) return dialog;
        dialog = element('dialog', 'clip-discovery-dialog'); dialog.id = 'clipDiscoveryDialog';
        dialog.setAttribute('aria-labelledby', 'clipDiscoveryTitle');
        const header = element('header', 'clip-discovery-header');
        const title = element('h2', '', text('Clips suchen', 'Find clips')); title.id = 'clipDiscoveryTitle';
        const close = button(text('Schließen', 'Close'), () => dialog?.close()); close.id = 'clipDiscoveryClose'; header.append(title, close);
        const fields = element('form', 'clip-discovery-fields');
        const field = (id: string, label: string, node: HTMLElement) => { const wrapper = element('label', ''); wrapper.htmlFor = id; const caption = element('span', '', label); caption.id = id + 'Label'; node.id = id; wrapper.append(caption, node); fields.append(wrapper); };
        const channel = element('input', ''); channel.type = 'text'; channel.maxLength = 300; channel.autocomplete = 'off'; field('clipDiscoveryChannel', text('Streamer', 'Channel'), channel);
        const days = element('select', ''); for (const value of ['1', '7', '30', '90', 'custom']) days.add(new Option(value, value)); days.value = '7'; field('clipDiscoveryDays', text('Zeitraum', 'Date range'), days);
        const since = element('input', ''); since.type = 'date'; field('clipDiscoverySince', text('Von', 'From'), since);
        const until = element('input', ''); until.type = 'date'; field('clipDiscoveryUntil', text('Bis', 'Until'), until);
        days.addEventListener('change', () => { since.parentElement!.hidden = until.parentElement!.hidden = days.value !== 'custom'; }); since.parentElement!.hidden = until.parentElement!.hidden = true;
        const find = element('button', 'btn-primary', text('Suchen', 'Search')); find.id = 'clipDiscoverySearch'; find.type = 'submit'; fields.append(find);
        fields.addEventListener('input', resetResults);
        fields.addEventListener('change', resetResults);
        fields.addEventListener('submit', event => { event.preventDefault(); void search(false); });
        const status = element('div', 'clip-discovery-status'); status.id = 'clipDiscoveryStatus'; status.setAttribute('role', 'status');
        const list = element('div', 'clip-discovery-list'); list.id = 'clipDiscoveryList';
        const footer = element('footer', 'clip-discovery-footer');
        const all = button(text('Neue auswählen', 'Select new'), () => { for (const clip of clips) if (!clip.downloaded && selected.size < 200) selected.add(clip.id); render(); }); all.id = 'clipDiscoverySelect';
        const more = button(text('Mehr laden', 'Load more'), () => { void search(true); }); more.id = 'clipDiscoveryMore';
        const add = button(text('Auswahl übernehmen', 'Import selection'), () => { void importSelection(); }); add.id = 'clipDiscoveryImport';
        footer.append(all, more, add); dialog.append(header, fields, status, list, footer);
        dialog.addEventListener('close', () => { previewDialog?.close(); stopPreview(); sequence++; busy = false; notice(''); render(); });
        window.addEventListener('pagehide', stopPreview);
        document.body.append(dialog); return dialog;
    }
    function labels(): void {
        const values = { clipDiscoveryTitle: text('Clips suchen', 'Find clips'), clipDiscoveryClose: text('Schließen', 'Close'), clipDiscoveryChannelLabel: text('Streamer', 'Channel'), clipDiscoveryDaysLabel: text('Zeitraum', 'Date range'), clipDiscoverySinceLabel: text('Von', 'From'), clipDiscoveryUntilLabel: text('Bis', 'Until'), clipDiscoverySearch: text('Suchen', 'Search'), clipDiscoverySelect: text('Neue auswählen', 'Select new'), clipDiscoveryMore: text('Mehr laden', 'Load more') };
        for (const [id, value] of Object.entries(values)) { const node = document.getElementById(id); if (node) node.textContent = value; }
        const days = document.getElementById('clipDiscoveryDays') as HTMLSelectElement;
        for (const option of Array.from(days.options)) option.textContent = option.value === 'custom' ? text('Benutzerdefiniert', 'Custom') : option.value === '1' ? text('24 Stunden', '24 hours') : option.value + text(' Tage', ' days');
    }
    function render(): void {
        const list = document.getElementById('clipDiscoveryList'); if (!list) return;
        const scroll = list.scrollTop;
        const fragment = document.createDocumentFragment();
        for (const clip of clips) {
            const row = element('article', 'clip-discovery-row');
            const choice = element('label', 'clip-discovery-choice');
            const checkbox = element('input', ''); checkbox.type = 'checkbox'; checkbox.checked = selected.has(clip.id); checkbox.disabled = busy;
            checkbox.setAttribute('aria-label', clip.title || clip.id);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked && selected.size >= 200) { checkbox.checked = false; notice(text('Maximal 200 Clips auswählen.', 'Select up to 200 clips.')); return; }
                if (checkbox.checked) selected.add(clip.id); else selected.delete(clip.id); updateButtons();
            });
            const body = element('span', 'clip-discovery-copy'); body.append(element('strong', '', clip.title || clip.id));
            body.append(element('span', 'clip-discovery-meta', [clip.channel, clipDuration(clip.duration), clip.createdAt ? formatUiDate(new Date(clip.createdAt)) : '', formatUiNumber(clip.views) + text(' Aufrufe', ' views'), clip.downloaded ? text('Bereits heruntergeladen', 'Already downloaded') : ''].filter(Boolean).join(' · ')));
            choice.append(checkbox, body);
            const preview = button(text('Vorschau', 'Preview'), () => { void showPreview(clip); }); preview.classList.add('clip-discovery-preview'); preview.disabled = busy;
            row.append(choice, preview); fragment.append(row);
        }
        if (!clips.length) fragment.append(element('div', 'insights-empty', text('Keine Clips angezeigt.', 'No clips displayed.')));
        list.replaceChildren(fragment); list.scrollTop = scroll; list.setAttribute('aria-busy', String(busy)); updateButtons();
    }
    function updateButtons(): void {
        const set = (id: string, disabled: boolean) => { const node = document.getElementById(id) as HTMLButtonElement | null; if (node) node.disabled = disabled; };
        set('clipDiscoverySearch', busy); set('clipDiscoveryMore', busy || !cursor || clips.length >= 1000); set('clipDiscoverySelect', busy || !clips.length); set('clipDiscoveryImport', busy || !selected.size);
        const add = document.getElementById('clipDiscoveryImport'); if (add) add.textContent = text('Übernehmen', 'Import') + ' (' + formatUiNumber(selected.size) + ')';
    }
    function resetResults(): void {
        previewDialog?.close(); stopPreview();
        sequence++;
        busy = false;
        clips = [];
        selected.clear();
        cursor = null;
        cursors.clear();
        lastRequest = null;
        render();
        notice('');
    }
    async function search(more: boolean): Promise<void> {
        if (busy || (more && (!cursor || !lastRequest))) return;
        const request: Request = more ? { ...lastRequest!, cursor: cursor! } : { channel: input('clipDiscoveryChannel').value.trim() };
        if (!more) {
            resetResults();
            const days = input('clipDiscoveryDays').value;
            if (days === 'custom') { request.since = input('clipDiscoverySince').value; request.until = input('clipDiscoveryUntil').value; if (!request.since || !request.until || request.since > request.until) { notice(text('Zeitraum prüfen.', 'Check the date range.')); return; } }
            else request.days = Number(days) as 1 | 7 | 30 | 90;
        }
        if (!request.channel) { notice(text('Streamer eingeben.', 'Enter a channel.')); return; }
        const current = ++sequence; busy = true; render(); notice(text('Clips werden gesucht …', 'Finding clips …'));
        try {
            const result = await bridge().discoverClips(request);
            if (current !== sequence) return;
            if (result.status !== 'success') { notice(result.status === 'auth-required' ? text('Für die Clip-Suche bei Twitch anmelden.', 'Sign in to Twitch to find clips.') : text('Streamer nicht gefunden.', 'Channel not found.')); return; }
            if (!more) lastRequest = request;
            const known = new Set(clips.map(clip => clip.id));
            clips.push(...result.clips.filter(clip => !known.has(clip.id)).slice(0, 1000 - clips.length));
            cursor = result.cursor && !cursors.has(result.cursor) ? result.cursor : null;
            if (cursor) cursors.add(cursor);
            notice(formatUiNumber(clips.length) + text(' Clips', ' clips'));
        } catch { if (current === sequence) notice(text('Clips konnten nicht geladen werden. Erneut versuchen.', 'Could not load clips. Try again.')); }
        finally { if (current === sequence) { busy = false; render(); } }
    }
    async function importSelection(): Promise<void> {
        const chosen = clips.filter(clip => selected.has(clip.id)); if (!chosen.length || busy) return;
        try {
            const importer = (window as unknown as { importDiscoveredClips?: (clips: Clip[]) => void }).importDiscoveredClips;
            if (!importer) throw new Error('Import unavailable');
            importer(chosen); dialog?.close();
        } catch { notice(text('Auswahl passt nicht in die Liste oder ein Download läuft.', 'Selection exceeds the list limit or a download is running.')); }
    }
    async function annotate<T extends Annotation>(items: readonly T[], changed: (item: T) => void): Promise<void> {
        for (let offset = 0; offset < items.length; offset += 4) {
            await Promise.all(items.slice(offset, offset + 4).map(async item => {
                if (item.state === 'invalid') return;
                const id = item.url.match(/^https:\/\/clips\.twitch\.tv\/([A-Za-z0-9_-]+)$/)?.[1]; if (!id) return;
                try {
                    let request = downloaded.get(id);
                    if (!request) { request = bridge().hasDownloadedClip(id); downloaded.set(id, request); }
                    const value = await request; if (!value) downloaded.delete(id); if (item.previouslyDownloaded !== value) { item.previouslyDownloaded = value; changed(item); }
                } catch { downloaded.delete(id); }
            }));
        }
    }
    return {
        open() { ensureDialog(); labels(); render(); if (!dialog!.open) dialog!.showModal(); input('clipDiscoveryChannel').focus(); },
        annotate,
        remember(url: string) { const id = url.split('/').pop(); if (id) downloaded.set(id, Promise.resolve(true)); },
        status(item: Annotation) { return item.previouslyDownloaded && ['ready', 'stopped'].includes(item.state) ? text('Bereits heruntergeladen', 'Already downloaded') : null; },
    };
})();
