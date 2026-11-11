const RendererVodLibrary = (() => {
    type Library = import('./main/domain/vod-library').VodLibrary;
    type Filter = import('./main/domain/vod-library').SavedVodFilter;
    type Excerpt = import('./main/domain/vod-library').SavedVodExcerpt;
    type Change = import('./main/domain/vod-library').VodLibraryChange;
    type Collection = import('./main/domain/vod-library').VodLibraryCollection;
    type Context = { vodId: string; duration: number; seconds: number; range: { start: number; end: number }; omissions: Array<{ start: number; end: number }> };
    type Hooks = { filter(): Omit<Filter, 'id' | 'name'>; applyFilter(value: Filter): void; context(): Context | null; applyExcerpt(value: Excerpt): void; seek(seconds: number): void; groupChanged(): void };
    const bridge = () => window.api as typeof window.api & { getVodLibrary(): Promise<Library>; changeVodLibrary(change: Change): Promise<Library> };
    let hooks: Hooks | null = null;
    let library: Library = { version: 1, filters: [], groups: [], markers: [], excerpts: [] };
    let groupId: string | null = null;
    let mode: 'views' | 'vod' = 'views';
    let dialog: HTMLDialogElement | null = null;
    let busy = false;
    const text = (de: string, en: string) => currentLanguage === 'de' ? de : en;
    const make = RendererElements.element;
    const status = (message: string) => { const node = document.getElementById('vodLibraryStatus'); if (node) node.textContent = message; };
    const action = RendererElements.button;
    function setup(): void {
        if (dialog) return;
        dialog = make('dialog', 'clip-discovery-dialog vod-library-dialog'); dialog.id = 'vodLibraryDialog'; dialog.setAttribute('aria-labelledby', 'vodLibraryTitle');
        const header = make('header', 'clip-discovery-header'); const heading = make('h2', ''); heading.id = 'vodLibraryTitle'; const close = action(text('Schließen', 'Close'), () => dialog?.close()); close.id = 'vodLibraryClose'; header.append(heading, close);
        const fields = make('div', 'vod-library-fields');
        const nameLabel = make('label', '', text('Name', 'Name')); const name = make('input', ''); name.type = 'text'; name.maxLength = 80; name.id = 'vodLibraryName'; nameLabel.append(name);
        const channelsLabel = make('label', 'vod-library-channels', text('Kanäle', 'Channels')); channelsLabel.id = 'vodLibraryChannelsLabel'; const channels = make('input', ''); channels.type = 'text'; channels.maxLength = 14000; channels.id = 'vodLibraryChannels'; channels.placeholder = 'kanal1, kanal2'; channelsLabel.append(channels);
        const first = action('', () => { void save(false); }); first.id = 'vodLibrarySaveFirst'; const second = action('', () => { void save(true); }); second.id = 'vodLibrarySaveSecond'; fields.append(nameLabel, channelsLabel, first, second);
        const message = make('div', 'clip-discovery-status'); message.id = 'vodLibraryStatus'; message.setAttribute('role', 'status');
        const list = make('div', 'clip-discovery-list'); list.id = 'vodLibraryList';
        const footer = make('footer', 'clip-discovery-footer'); const all = action(text('Alle Kanäle', 'All channels'), () => { groupId = null; hooks?.groupChanged(); render(); }); all.id = 'vodLibraryAllChannels'; footer.append(all);
        dialog.append(header, fields, message, list, footer); document.body.append(dialog);
    }
    function render(): void {
        if (!dialog) return;
        const isVod = mode === 'vod';
        document.getElementById('vodLibraryTitle')!.textContent = isVod ? text('Markierungen und Ausschnitte', 'Markers and excerpts') : text('Ansichten und Gruppen', 'Views and groups');
        document.getElementById('vodLibraryClose')!.textContent = text('Schließen', 'Close');
        document.getElementById('vodLibrarySaveFirst')!.textContent = isVod ? text('Markierung speichern', 'Save marker') : text('Ansicht speichern', 'Save view');
        document.getElementById('vodLibrarySaveSecond')!.textContent = isVod ? text('Ausschnitt speichern', 'Save excerpt') : text('Gruppe speichern', 'Save group');
        document.getElementById('vodLibraryChannelsLabel')!.hidden = isVod;
        document.getElementById('vodLibraryAllChannels')!.hidden = isVod;
        document.getElementById('vodLibraryAllChannels')!.textContent = text('Alle Kanäle', 'All channels');
        const list = document.getElementById('vodLibraryList')!; const scroll = list.scrollTop; const fragment = document.createDocumentFragment();
        const context = hooks?.context();
        const groups: Array<[Collection, string]> = isVod ? [['markers', text('Markierungen', 'Markers')], ['excerpts', text('Ausschnitte', 'Excerpts')]] : [['filters', text('Ansichten', 'Views')], ['groups', text('Kanalgruppen', 'Channel groups')]];
        for (const [collection, title] of groups) {
            const section = make('section', 'vod-library-section'); section.append(make('h3', '', title));
            const rows = library[collection].filter(row => !('vodId' in row) || row.vodId === context?.vodId);
            if (!rows.length) section.append(make('div', 'insights-empty', text('Keine Einträge.', 'No entries.')));
            for (const row of rows) {
                const item = make('div', 'vod-library-row'); const copy = make('div', 'vod-library-copy'); copy.append(make('strong', '', row.name));
                const detail = 'seconds' in row ? formatClipTime(row.seconds) : 'range' in row ? formatClipTime(row.range.start) + ' – ' + formatClipTime(row.range.end) : 'channels' in row ? row.channels.join(', ') : row.query;
                if (detail) copy.append(make('span', '', detail)); item.append(copy);
                const apply = action(collection === 'groups' && row.id === groupId ? text('Aktiv', 'Active') : text('Anwenden', 'Apply'), () => {
                    try {
                        if ('seconds' in row) { if (!context || row.seconds > context.duration) throw new Error(); hooks?.seek(row.seconds); }
                        else if ('range' in row) { if (!context || row.range.end > context.duration) throw new Error(); hooks?.applyExcerpt(row); }
                        else if ('channels' in row) { groupId = row.id; hooks?.groupChanged(); }
                        else hooks?.applyFilter(row);
                        dialog?.close();
                    } catch { status(text('Eintrag konnte nicht angewendet werden.', 'Could not apply entry.')); }
                });
                const remove = action(text('Löschen', 'Delete'), () => { void change({ collection, remove: row.id }); }); item.append(apply, remove); section.append(item);
            }
            fragment.append(section);
        }
        list.replaceChildren(fragment); list.scrollTop = scroll;
        dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { if (button.id !== 'vodLibraryClose') button.disabled = busy; });
    }
    async function change(value: Change): Promise<void> {
        if (busy) return; busy = true; render();
        try { library = await bridge().changeVodLibrary(value); if (groupId && !library.groups.some(group => group.id === groupId)) { groupId = null; hooks?.groupChanged(); } status(''); }
        catch { status(text('Änderung konnte nicht gespeichert werden.', 'Could not save the change.')); }
        finally { busy = false; render(); }
    }
    async function save(second: boolean): Promise<void> {
        const name = (document.getElementById('vodLibraryName') as HTMLInputElement).value.trim();
        if (!name) { status(text('Name eingeben.', 'Enter a name.')); return; }
        if (!hooks) return;
        if (mode === 'views') {
            if (second) { const channels = (document.getElementById('vodLibraryChannels') as HTMLInputElement).value.split(/[\s,;]+/).filter(Boolean); await change({ collection: 'groups', item: { name, channels } }); }
            else await change({ collection: 'filters', item: { ...hooks.filter(), name } });
        } else {
            const context = hooks.context(); if (!context) { status(text('Kein VOD geöffnet.', 'No VOD open.')); return; }
            if (second) await change({ collection: 'excerpts', item: { name, vodId: context.vodId, duration: context.duration, range: context.range, omissions: context.omissions } });
            else await change({ collection: 'markers', item: { name, vodId: context.vodId, duration: context.duration, seconds: context.seconds } });
        }
    }
    return {
        configure(value: Hooks) { hooks = value; },
        async open(value: 'views' | 'vod') {
            if (busy) return;
            setup(); mode = value; busy = true; status(''); render(); if (!dialog!.open) dialog!.showModal();
            document.getElementById('vodLibraryName')?.focus({ preventScroll: true });
            document.getElementById('vodLibraryList')!.scrollTop = 0;
            try { library = await bridge().getVodLibrary(); } catch { status(text('Einträge konnten nicht geladen werden.', 'Could not load entries.')); }
            finally { busy = false; render(); }
        },
        channels(all: string[]): string[] { const group = library.groups.find(entry => entry.id === groupId); return group ? all.filter(channel => group.channels.includes(channel.toLowerCase())) : all; },
        groupName(): string { return library.groups.find(entry => entry.id === groupId)?.name || ''; },
    };
})();

function initializeVodLibrary(): void {
    RendererVodLibrary.configure({
        filter: () => ({ query: vodFilterQuery, sort: vodSortKey, hideDownloaded: vodHideDownloaded }),
        applyFilter(value) {
            vodFilterQuery = value.query; vodSortKey = value.sort; vodHideDownloaded = value.hideDownloaded;
            byId<HTMLInputElement>('vodFilterInput').value = value.query;
            persistVodFilter(value.query); persistVodSort(value.sort); persistHideDownloaded(value.hideDownloaded);
            syncVodSortSelect(); syncVodHideDownloadedToggle(); syncVodFilterClearButton();
            if (lastLoadedStreamer) renderVodGridFromCurrentState();
        },
        context() {
            const snapshot = clipPlayer?.snapshot();
            const vodId = clipDialogData?.url.match(/videos\/(\d+)/)?.[1];
            return snapshot && vodId ? { ...snapshot, vodId } : null;
        },
        applyExcerpt: value => clipPlayer?.applyExcerpt(value),
        seek: seconds => clipPlayer?.seek(seconds),
        groupChanged() {
            renderStreamers();
            const node = document.getElementById('vodLibraryButton');
            if (node) node.textContent = RendererVodLibrary.groupName() || (currentLanguage === 'de' ? 'Ansichten' : 'Views');
        },
    });
}
