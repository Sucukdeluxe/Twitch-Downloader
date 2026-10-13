type StreamerSearchHit = import('./main/twitch/channel-search').TwitchChannelSearchHit;

let streamerSearchGeneration = 0;
let streamerSearchTimer: number | undefined;
let streamerSearchCloseTimer: number | undefined;
let streamerSearchHits: StreamerSearchHit[] = [];
let streamerSearchLoading = false;
let streamerSearchAdding = false;
let streamerSearchOpener: HTMLElement | null = null;
let streamerSearchBound = false;

function streamerSearchDialog(): HTMLDialogElement {
    return document.getElementById('streamerSearchDialog') as HTMLDialogElement;
}

function setStreamerSearchStatus(text: string): void {
    document.getElementById('streamerSearchStatus')!.textContent = text;
}

function updateStreamerSearchTexts(): void {
    const text = UI_TEXT.streamerSearch;
    document.getElementById('streamerSearchTitle')!.textContent = text.title;
    document.getElementById('streamerSearchDescription')!.textContent = text.description;
    const input = document.getElementById('newStreamer') as HTMLInputElement;
    input.placeholder = text.placeholder;
    input.setAttribute('aria-label', text.label);
    document.querySelector('.streamer-search-close')?.setAttribute('aria-label', text.close);
    document.querySelector('.streamer-search-clear')?.setAttribute('aria-label', text.clear);
}

function openStreamerSearchDialog(): void {
    const dialog = streamerSearchDialog();
    if (!streamerSearchBound) {
        dialog.addEventListener('cancel', event => { event.preventDefault(); closeStreamerSearchDialog(); });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const rect = dialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeStreamerSearchDialog();
        });
        document.getElementById('streamerSearchResults')!.addEventListener('keydown', event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.streamer-search-add:not(:disabled)'));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            const next = index + (event.key === 'ArrowDown' ? 1 : -1);
            if (next < 0) document.getElementById('newStreamer')?.focus();
            else buttons[Math.min(next, buttons.length - 1)]?.focus();
        });
        streamerSearchBound = true;
    }
    window.clearTimeout(streamerSearchCloseTimer);
    dialog.classList.remove('is-closing');
    updateStreamerSearchTexts();
    if (!dialog.open) {
        streamerSearchOpener = document.getElementById('btnAddStreamer') ?? document.activeElement as HTMLElement;
        clearStreamerSearch();
        dialog.showModal();
    }
    document.getElementById('newStreamer')?.focus();
}

function closeStreamerSearchDialog(): void {
    const dialog = streamerSearchDialog();
    if (!dialog.open) return;
    streamerSearchGeneration++;
    window.clearTimeout(streamerSearchTimer);
    dialog.classList.add('is-closing');
    window.clearTimeout(streamerSearchCloseTimer);
    streamerSearchCloseTimer = window.setTimeout(() => {
        dialog.close();
        dialog.classList.remove('is-closing');
        if (streamerSearchOpener?.isConnected) streamerSearchOpener.focus({ preventScroll: true });
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 130);
}

function clearStreamerSearch(): void {
    (document.getElementById('newStreamer') as HTMLInputElement).value = '';
    streamerSearchGeneration++;
    window.clearTimeout(streamerSearchTimer);
    streamerSearchHits = [];
    streamerSearchLoading = false;
    document.getElementById('streamerSearchResults')!.replaceChildren();
    document.getElementById('streamerSearchResults')!.setAttribute('aria-busy', 'false');
    setStreamerSearchStatus(UI_TEXT.streamerSearch.idle);
    document.getElementById('newStreamer')?.focus();
}

function scheduleStreamerSearch(): void {
    const generation = ++streamerSearchGeneration;
    window.clearTimeout(streamerSearchTimer);
    const query = (document.getElementById('newStreamer') as HTMLInputElement).value.trim();
    if (!query) { clearStreamerSearch(); return; }
    streamerSearchHits = [];
    streamerSearchLoading = true;
    const list = document.getElementById('streamerSearchResults')!;
    list.setAttribute('aria-busy', 'true');
    list.replaceChildren(...Array.from({ length: 4 }, () => {
        const row = document.createElement('div');
        row.className = 'streamer-search-skeleton';
        row.setAttribute('aria-hidden', 'true');
        return row;
    }));
    setStreamerSearchStatus(UI_TEXT.streamerSearch.loading);
    streamerSearchTimer = window.setTimeout(() => { void runStreamerSearch(query, generation); }, 220);
}

async function runStreamerSearch(query: string, generation: number): Promise<void> {
    try {
        const result = await window.api.searchTwitchChannels(query);
        if (generation !== streamerSearchGeneration || !streamerSearchDialog().open) return;
        streamerSearchLoading = false;
        streamerSearchHits = result.channels || [];
        setStreamerSearchStatus(result.error === 'invalid' ? UI_TEXT.streamerSearch.invalid : result.error ? UI_TEXT.streamerSearch.unavailable : streamerSearchHits.length ? UI_TEXT.streamerSearch.results : UI_TEXT.streamerSearch.empty);
        renderStreamerSearchResults();
    } catch {
        if (generation !== streamerSearchGeneration) return;
        streamerSearchLoading = false;
        setStreamerSearchStatus(UI_TEXT.streamerSearch.unavailable);
        renderStreamerSearchResults();
    }
}

function renderStreamerSearchResults(): void {
    const list = document.getElementById('streamerSearchResults')!;
    const scroll = list.scrollTop;
    const focused = (document.activeElement as HTMLElement)?.dataset.streamerLogin;
    const rows = streamerSearchHits.map(channel => {
        const row = document.createElement('div');
        row.className = 'streamer-search-result';
        const fallback = document.createElement('span');
        fallback.className = 'streamer-search-avatar-fallback';
        fallback.textContent = channel.displayName.slice(0, 1).toUpperCase();
        fallback.setAttribute('aria-hidden', 'true');
        if (channel.avatarUrl) {
            const image = document.createElement('img');
            image.className = 'streamer-search-avatar';
            image.alt = '';
            image.src = channel.avatarUrl;
            image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
            row.append(image);
        } else row.append(fallback);
        const copy = document.createElement('div');
        copy.className = 'streamer-search-copy';
        const name = document.createElement('strong');
        name.textContent = channel.displayName;
        const login = document.createElement('span');
        login.textContent = '@' + channel.login;
        copy.append(name, login);
        const button = document.createElement('button');
        const added = (config.streamers ?? []).some(login => login.toLowerCase() === channel.login);
        button.type = 'button';
        button.className = 'streamer-search-add';
        button.dataset.streamerLogin = channel.login;
        button.disabled = added || streamerSearchAdding;
        if (!added) {
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('class', 'streamer-search-add-icon');
            icon.setAttribute('viewBox', '0 0 24 24');
            icon.setAttribute('fill', 'none');
            icon.setAttribute('stroke', 'currentColor');
            icon.setAttribute('stroke-width', '2');
            icon.setAttribute('aria-hidden', 'true');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M12 5v14M5 12h14');
            icon.append(path);
            button.append(icon);
        }
        const label = document.createElement('span');
        label.textContent = added ? UI_TEXT.streamerSearch.added : UI_TEXT.streamerSearch.add;
        button.append(label);
        button.setAttribute('aria-label', label.textContent + ': ' + channel.displayName);
        button.addEventListener('click', () => { void addStreamerSearchResult(channel); });
        row.append(copy, button);
        return row;
    });
    list.replaceChildren(...rows);
    list.setAttribute('aria-busy', String(streamerSearchLoading));
    list.scrollTop = scroll;
    if (focused) Array.from(list.querySelectorAll<HTMLButtonElement>('button')).find(button => button.dataset.streamerLogin === focused && !button.disabled)?.focus({ preventScroll: true });
}

async function addStreamerSearchResult(channel: StreamerSearchHit): Promise<void> {
    if (streamerSearchAdding) return;
    streamerSearchAdding = true;
    const generation = streamerSearchGeneration;
    setStreamerSearchStatus(UI_TEXT.streamerSearch.adding);
    renderStreamerSearchResults();
    try {
        const added = await addStreamer(channel.login);
        if (added) rememberStreamerDisplayName(channel.login, channel.displayName);
        if (generation === streamerSearchGeneration) setStreamerSearchStatus(added ? UI_TEXT.streamerSearch.results : UI_TEXT.streamerSearch.failed);
    } catch { if (generation === streamerSearchGeneration) setStreamerSearchStatus(UI_TEXT.streamerSearch.failed); }
    finally {
        streamerSearchAdding = false;
        if (!streamerSearchLoading) renderStreamerSearchResults();
        if (generation === streamerSearchGeneration && streamerSearchDialog().open) document.getElementById('newStreamer')?.focus({ preventScroll: true });
    }
}

function handleStreamerSearchKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeStreamerSearchDialog();
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>('.streamer-search-add:not(:disabled)')?.focus();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (!streamerSearchLoading) {
            const hit = streamerSearchHits.find(channel => !(config.streamers ?? []).includes(channel.login));
            if (hit) void addStreamerSearchResult(hit);
        }
    }
}
