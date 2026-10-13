// Profile-header renderer. Owns the streamerProfileHeader div above the
// VOD grid: hidden when no streamer is selected, skeleton while loading,
// full card once profile data is back. Smooth fade-in is in CSS.

let activeProfileRequestId = 0;
let activeProfileLogin = '';
let profileTimeTimer: number | undefined;
const streamerProfileCache = new Map<string, StreamerProfile>();
const streamerProfileLoads = new Map<string, Promise<StreamerProfile | null>>();
const liveProfileExpandedByLogin = new Map<string, boolean>();

function isLiveProfileExpanded(login = activeProfileLogin): boolean {
    const key = login.toLowerCase();
    const cached = liveProfileExpandedByLogin.get(key);
    if (cached !== undefined) return cached;
    let expanded = false;
    try { expanded = localStorage.getItem('twitch-vod-manager:profile-live-expanded:' + key) === '1'; } catch { }
    liveProfileExpandedByLogin.set(key, expanded);
    return expanded;
}

function toggleStreamerLiveDetails(): void {
    const expanded = !isLiveProfileExpanded();
    const key = activeProfileLogin.toLowerCase();
    liveProfileExpandedByLogin.set(key, expanded);
    try { localStorage.setItem('twitch-vod-manager:profile-live-expanded:' + key, expanded ? '1' : '0'); } catch { }
    const button = document.getElementById('streamerProfileLiveToggle');
    const panel = document.getElementById('streamerProfileLivePanel');
    if (!button || !panel) return;
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? UI_TEXT.profile.hideLive : UI_TEXT.profile.showLive);
    button.title = expanded ? UI_TEXT.profile.hideLive : UI_TEXT.profile.showLive;
    panel.classList.toggle('is-expanded', expanded);
    panel.setAttribute('aria-hidden', String(!expanded));
    panel.inert = !expanded;
}

function getLiveVodCover(login: string, vodId: string): string {
    const profile = streamerProfileCache.get(login.toLowerCase());
    return profile?.isLive && profile.currentVodId === vodId ? profile.currentStreamPreviewUrl : '';
}

function syncStreamerProfileLiveStatus(login: string, isLive: boolean): void {
    const key = login.toLowerCase();
    const profile = streamerProfileCache.get(key);
    if (profile && profile.isLive !== isLive) {
        const updated = { ...profile, isLive, currentStreamStartedAt: null };
        streamerProfileCache.set(key, updated);
        if (activeProfileLogin === key) renderStreamerProfileCard(updated);
    }
    void refreshStreamerProfilesInBackground([login]);
}

function formatProfileFollowers(count: number | null): string {
    if (count == null) return '–';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K`;
    return String(count);
}

function formatLastStreamAgo(iso: string | null): string {
    if (!iso) return '–';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '–';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return UI_TEXT.profile.agoMinutes.replace('{n}', String(minutes));
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return UI_TEXT.profile.agoHours.replace('{n}', String(hours));
    const days = Math.floor(hours / 24);
    if (days === 1) return UI_TEXT.profile.agoDay;
    if (days < 30) return UI_TEXT.profile.agoDays.replace('{n}', String(days));
    const months = Math.floor(days / 30);
    if (months === 1) return UI_TEXT.profile.agoMonth;
    if (days < 365) return UI_TEXT.profile.agoMonths.replace('{n}', String(months));
    const years = Math.floor(days / 365);
    if (years === 1) return UI_TEXT.profile.agoYear;
    return UI_TEXT.profile.agoYears.replace('{n}', String(years));
}

function getProfileStreamTime(profile: StreamerProfile): { label: string; value: string; title: string } {
    if (!profile.isLive) return { label: UI_TEXT.profile.lastStream, value: formatLastStreamAgo(profile.lastStreamAt), title: profile.lastStreamAt ? new Date(profile.lastStreamAt).toLocaleString(getIntlLocale()) : '' };
    const startedAt = Date.parse(profile.currentStreamStartedAt || '');
    const elapsed = Date.now() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) return { label: UI_TEXT.profile.streamStatus, value: UI_TEXT.profile.liveNow, title: '' };
    const minutes = Math.floor(elapsed / 60000);
    const hours = Math.floor(minutes / 60);
    const value = hours > 0 ? `${formatUiNumber(hours)} h${minutes % 60 ? ` ${formatUiNumber(minutes % 60)} min` : ''}` : minutes > 0 ? `${formatUiNumber(minutes)} min` : '< 1 min';
    return { label: UI_TEXT.profile.liveSince, value, title: new Date(startedAt).toLocaleString(getIntlLocale()) };
}

function updateProfileStreamTime(profile: StreamerProfile): void {
    const stat = document.querySelector<HTMLElement>('.streamer-profile-time');
    if (!stat) return;
    const time = getProfileStreamTime(profile);
    stat.title = time.title;
    stat.querySelector('.streamer-profile-time-label')!.textContent = time.label + ':';
    stat.querySelector('strong')!.textContent = time.value;
}

function clearProfileTimeTimer(): void {
    if (profileTimeTimer !== undefined) window.clearInterval(profileTimeTimer);
    profileTimeTimer = undefined;
}

function streamerProfilesMatch(left: StreamerProfile, right: StreamerProfile): boolean {
    return left.login === right.login
        && left.displayName === right.displayName
        && left.avatarUrl === right.avatarUrl
        && left.bannerUrl === right.bannerUrl
        && left.description === right.description
        && left.broadcasterType === right.broadcasterType
        && left.followerCount === right.followerCount
        && left.vodCount === right.vodCount
        && left.lastStreamAt === right.lastStreamAt
        && left.isLive === right.isLive
        && left.currentTitle === right.currentTitle
        && left.currentGame === right.currentGame
        && left.currentVodId === right.currentVodId
        && left.currentStreamPreviewUrl === right.currentStreamPreviewUrl
        && left.currentStreamViewers === right.currentStreamViewers
        && left.currentStreamStartedAt === right.currentStreamStartedAt
        && left.twitchUrl === right.twitchUrl;
}

function hideStreamerProfileHeader(): void {
    clearProfileTimeTimer();
    activeProfileRequestId += 1;
    activeProfileLogin = '';
    const el = document.getElementById('streamerProfileHeader');
    if (!el) return;
    el.classList.add('is-hidden');
    applyHtml(el, '');
}

function renderStreamerProfileSkeleton(login: string): void {
    clearProfileTimeTimer();
    const el = document.getElementById('streamerProfileHeader');
    if (!el) return;
    el.classList.remove('is-live', 'is-hidden');
    el.classList.add('streamer-profile-skeleton');
    applyHtml(el, `
        <div class="streamer-profile-skel-block avatar"></div>
        <div class="streamer-profile-body">
            <div class="streamer-profile-name-row">
                <div class="streamer-profile-skel-block name"></div>
                <div class="streamer-profile-skel-block badge"></div>
            </div>
            <div class="streamer-profile-skel-block subtitle"></div>
            <div class="streamer-profile-stats streamer-profile-skel-stats">
                <div class="streamer-profile-skel-block" style="width:100px; height:14px;"></div>
                <div class="streamer-profile-skel-block" style="width:80px; height:14px;"></div>
                <div class="streamer-profile-skel-block" style="width:120px; height:14px;"></div>
            </div>
        </div>
    `);
}

function renderStreamerProfileCard(p: StreamerProfile): void {
    const statusReader = (window as unknown as { getStreamerLiveVodStatus?: (login: string) => { isLive: boolean } | undefined }).getStreamerLiveVodStatus;
    const status = statusReader?.(p.login);
    if (status && p.isLive !== status.isLive) p = { ...p, isLive: status.isLive, currentStreamStartedAt: null };
    const expanded = isLiveProfileExpanded(p.login);
    const focusedId = document.activeElement?.id;
    const el = document.getElementById('streamerProfileHeader');
    if (!el) return;
    el.classList.remove('streamer-profile-skeleton', 'is-hidden');
    if (p.isLive) el.classList.add('is-live'); else el.classList.remove('is-live');

    const safeLogin = p.login.replace(/'/g, "\\'");
    const safeUrl = p.twitchUrl.replace(/'/g, "\\'");

    const avatarBlock = p.avatarUrl
        ? `<img class="streamer-profile-avatar${p.isLive ? ' is-live' : ''}" src="${escapeHtml(p.avatarUrl)}" alt="${escapeHtml(p.displayName)}" referrerpolicy="no-referrer" onerror="onProfileAvatarError(this)">`
        : `<div class="streamer-profile-avatar-fallback">${escapeHtml((p.displayName || p.login || '?').slice(0, 1).toUpperCase())}</div>`;

    const badges: string[] = [];
    if (p.broadcasterType === 'partner') badges.push(`<span class="streamer-profile-badge partner">${escapeHtml(UI_TEXT.profile.partner)}</span>`);
    if (p.broadcasterType === 'affiliate') badges.push(`<span class="streamer-profile-badge affiliate">${escapeHtml(UI_TEXT.profile.affiliate)}</span>`);

    const bio = p.description
        ? `<div class="streamer-profile-bio" title="${escapeHtml(p.description)}">${escapeHtml(p.description)}</div>`
        : '';

    const followersStat = `
        <div class="streamer-profile-stat" title="${escapeHtml(UI_TEXT.profile.followers)}">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            <strong>${escapeHtml(formatProfileFollowers(p.followerCount))}</strong> ${escapeHtml(UI_TEXT.profile.followers)}
        </div>`;
    const vodsStat = `
        <div class="streamer-profile-stat" title="${escapeHtml(UI_TEXT.profile.vodsTooltip)}">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>
            <strong>${escapeHtml(formatUiNumber(p.vodCount))}</strong> ${escapeHtml(UI_TEXT.profile.vods)}
        </div>`;
    const streamTime = getProfileStreamTime(p);
    const lastStreamStat = `
        <div class="streamer-profile-stat streamer-profile-time" title="${escapeHtml(streamTime.title)}">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
            <span class="streamer-profile-time-label">${escapeHtml(streamTime.label)}:</span><strong>${escapeHtml(streamTime.value)}</strong>
        </div>`;

    // Banner-as-background — set inline so the URL stays per-streamer.
    // The darkening gradient is handled by the .streamer-profile-header::before
    // pseudo so the banner itself stays bright and unfiltered here.
    const bannerStyle = p.bannerUrl
        ? `background-image: url("${p.bannerUrl.replace(/"/g, '%22')}");`
        : '';

    // Live preview block — only when currently live. Big card with
    // current preview frame + viewer count + title + game + record CTA.
    const liveCard = p.isLive
        ? `
            <div class="streamer-profile-live-panel${expanded ? ' is-expanded' : ''}" id="streamerProfileLivePanel" aria-hidden="${!expanded}" ${expanded ? '' : 'inert'}>
            <div class="streamer-profile-live-panel-inner">
            <div class="streamer-profile-live-card">
                ${p.currentStreamPreviewUrl
                    ? `<img class="streamer-profile-live-thumb" src="${escapeHtml(p.currentStreamPreviewUrl)}" alt="${escapeHtml(UI_TEXT.profile.liveThumbAlt)}" onerror="onProfileLivePreviewError(this)">`
                    : `<div class="streamer-profile-live-thumb-fallback"></div>`}
                <div class="streamer-profile-live-body">
                    <div class="streamer-profile-live-badge-row">
                        <span class="streamer-profile-badge live">${escapeHtml(UI_TEXT.profile.liveBadge)}</span>
                        ${typeof p.currentStreamViewers === 'number' ? `<span class="streamer-profile-live-viewers"><svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg> ${escapeHtml(formatProfileFollowers(p.currentStreamViewers))}</span>` : ''}
                    </div>
                    ${p.currentTitle ? `<div class="streamer-profile-live-title">${escapeHtml(p.currentTitle)}</div>` : ''}
                    ${p.currentGame ? `<div class="streamer-profile-live-game">${escapeHtml(p.currentGame)}</div>` : ''}
                    <button type="button" id="streamerProfileLiveRecord" class="streamer-profile-btn primary streamer-profile-live-rec-btn" onclick="event.stopPropagation(); triggerLiveRecordingFromProfile('${safeLogin}')">${escapeHtml(UI_TEXT.profile.recordNow)}</button>
                </div>
            </div>
            </div>
            </div>
        ` : '';

    const liveToggle = p.isLive
        ? `<button type="button" id="streamerProfileLiveToggle" class="streamer-profile-live-toggle" aria-controls="streamerProfileLivePanel" aria-expanded="${expanded}" aria-label="${escapeHtml(expanded ? UI_TEXT.profile.hideLive : UI_TEXT.profile.showLive)}" title="${escapeHtml(expanded ? UI_TEXT.profile.hideLive : UI_TEXT.profile.showLive)}" onclick="toggleStreamerLiveDetails()"><span class="vod-live-badge">${escapeHtml(UI_TEXT.vods.liveBadge)}</span><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>`
        : '';

    applyHtml(el, `
        ${bannerStyle ? `<div class="streamer-profile-banner-bg" style="${bannerStyle}"></div>` : ''}
        <div class="streamer-profile-row">
            <div class="streamer-profile-avatar-wrap" role="button" tabindex="0" aria-label="${escapeHtml(UI_TEXT.profile.openTwitchTooltip)}" onclick="openTwitchChannel('${safeUrl}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTwitchChannel('${safeUrl}');}" title="${escapeHtml(UI_TEXT.profile.openTwitchTooltip)}">
                ${avatarBlock}
            </div>
            <div class="streamer-profile-body">
                <div class="streamer-profile-name-row">
                    <span class="streamer-profile-display-name">${escapeHtml(p.displayName)}</span>
                    <span class="streamer-profile-login">@${escapeHtml(p.login)}</span>
                    ${badges.join('')}
                </div>
                ${bio}
                <div class="streamer-profile-stats">
                    ${followersStat}
                    ${vodsStat}
                    ${lastStreamStat}
                </div>
            </div>
            <div class="streamer-profile-actions">
                <button type="button" class="streamer-profile-btn twitch-channel-button" onclick="openTwitchChannel('${safeUrl}')"><svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M4 2 2 6v15h5v3l3-3h4l8-8V2H4zm16 10-4 4h-5l-3 3v-3H5V4h15v8zM15 6h2v6h-2V6zm-5 0h2v6h-2V6z"/></svg><span>${escapeHtml(UI_TEXT.profile.openTwitch)}</span><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 18 18 6M6 6h12v12"/></svg></button>
                ${liveToggle}
                <button type="button" class="streamer-profile-btn profile-refresh-vods${vodRefreshInFlight ? ' is-loading' : ''}" id="toolbarRefreshVodsBtn" onclick="refreshVODs()" ${vodRefreshInFlight ? 'disabled' : ''}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 7M5.5 15A7 7 0 0 0 18 17"/></svg><span>${escapeHtml(UI_TEXT.static.refreshVods)}</span></button>
            </div>
        </div>
        ${liveCard}
    `);
    if (focusedId === 'streamerProfileLiveToggle' || focusedId === 'streamerProfileLiveRecord') document.getElementById(focusedId)?.focus({ preventScroll: true });
    clearProfileTimeTimer();
    profileTimeTimer = window.setInterval(() => updateProfileStreamTime(p), 60000);
}

function onProfileLivePreviewError(img: HTMLImageElement): void {
    const parent = img.parentElement;
    if (!parent) return;
    const fallback = document.createElement('div');
    fallback.className = 'streamer-profile-live-thumb-fallback';
    parent.replaceChild(fallback, img);
}

function triggerLiveRecordingFromProfile(login: string): void {
    const fn = (window as unknown as { triggerLiveRecording?: (login: string) => Promise<void> }).triggerLiveRecording;
    if (typeof fn === 'function') void fn(login);
}

async function loadStreamerProfile(login: string, forceRefresh = false): Promise<void> {
    if (!login) {
        hideStreamerProfileHeader();
        return;
    }
    const key = login.trim().toLowerCase();
    activeProfileLogin = key;
    const reqId = ++activeProfileRequestId;
    const cached = streamerProfileCache.get(key);
    if (cached) renderStreamerProfileCard(cached);
    else renderStreamerProfileSkeleton(login);
    try {
        const profile = await fetchStreamerProfile(login, forceRefresh);
        // Stale-request guard — user may have clicked another streamer
        // while we were waiting on the API.
        if (reqId !== activeProfileRequestId) return;
        if (!profile) {
            if (!cached) hideStreamerProfileHeader();
            return;
        }
        const rememberDisplayName = (window as unknown as { rememberStreamerDisplayName?: (login: string, displayName: string) => void }).rememberStreamerDisplayName;
        if (typeof rememberDisplayName === 'function') rememberDisplayName(profile.login, profile.displayName);
        if (!cached || !streamerProfilesMatch(cached, profile)) renderStreamerProfileCard(profile);
    } catch (_) {
        if (reqId === activeProfileRequestId && !cached) hideStreamerProfileHeader();
    }
}

async function fetchStreamerProfile(login: string, forceRefresh = false): Promise<StreamerProfile | null> {
    const key = login.trim().toLowerCase();
    const cached = streamerProfileCache.get(key);
    if (!forceRefresh && cached) return cached;
    const pending = streamerProfileLoads.get(key);
    if (pending) return pending;
    const task = window.api.getStreamerProfile(login, forceRefresh).then((profile) => {
        if (profile) {
            streamerProfileCache.set(key, profile);
            updateStreamerAvatars(login);
            const syncCovers = (window as unknown as { syncVodCardCovers?: () => void }).syncVodCardCovers;
            syncCovers?.();
        }
        return profile;
    });
    streamerProfileLoads.set(key, task);
    try {
        return await task;
    } finally {
        if (streamerProfileLoads.get(key) === task) streamerProfileLoads.delete(key);
    }
}

async function preloadStreamerProfiles(logins: string[]): Promise<void> {
    await Promise.allSettled(logins.map((login) => fetchStreamerProfile(login)));
}

async function refreshStreamerProfilesInBackground(logins: string[]): Promise<void> {
    await Promise.allSettled(logins.map(async (login) => {
        const previous = streamerProfileCache.get(login.trim().toLowerCase());
        const profile = await fetchStreamerProfile(login, true);
        if (profile && activeProfileLogin === login.trim().toLowerCase() && (!previous || !streamerProfilesMatch(previous, profile))) renderStreamerProfileCard(profile);
    }));
}

function refreshStreamerProfile(login: string): void {
    void loadStreamerProfile(login, true);
}

function openTwitchChannel(url: string): void {
    void window.api.openExternal(url);
}

function onProfileAvatarError(img: HTMLImageElement): void {
    // Avatar URL hit a 404 or CORS oddity. Swap to the fallback letter
    // tile so we don't end up with a broken-image icon.
    const parent = img.parentElement;
    if (!parent) return;
    const fallback = document.createElement('div');
    fallback.className = 'streamer-profile-avatar-fallback';
    const alt = img.getAttribute('alt') || '';
    fallback.textContent = (alt || '?').slice(0, 1).toUpperCase();
    parent.replaceChild(fallback, img);
}

(window as unknown as {
    loadStreamerProfile: typeof loadStreamerProfile;
    refreshStreamerProfile: typeof refreshStreamerProfile;
    hideStreamerProfileHeader: typeof hideStreamerProfileHeader;
    openTwitchChannel: typeof openTwitchChannel;
    onProfileAvatarError: typeof onProfileAvatarError;
}).loadStreamerProfile = loadStreamerProfile;
(window as unknown as { refreshStreamerProfile: typeof refreshStreamerProfile }).refreshStreamerProfile = refreshStreamerProfile;
(window as unknown as { hideStreamerProfileHeader: typeof hideStreamerProfileHeader }).hideStreamerProfileHeader = hideStreamerProfileHeader;
(window as unknown as { openTwitchChannel: typeof openTwitchChannel }).openTwitchChannel = openTwitchChannel;
(window as unknown as { onProfileAvatarError: typeof onProfileAvatarError }).onProfileAvatarError = onProfileAvatarError;
(window as unknown as { onProfileLivePreviewError: typeof onProfileLivePreviewError }).onProfileLivePreviewError = onProfileLivePreviewError;
(window as unknown as { triggerLiveRecordingFromProfile: typeof triggerLiveRecordingFromProfile }).triggerLiveRecordingFromProfile = triggerLiveRecordingFromProfile;
(window as unknown as { preloadStreamerProfiles: typeof preloadStreamerProfiles }).preloadStreamerProfiles = preloadStreamerProfiles;
(window as unknown as { refreshStreamerProfilesInBackground: typeof refreshStreamerProfilesInBackground }).refreshStreamerProfilesInBackground = refreshStreamerProfilesInBackground;

(window as unknown as { toggleStreamerLiveDetails: typeof toggleStreamerLiveDetails }).toggleStreamerLiveDetails = toggleStreamerLiveDetails;
(window as unknown as { getLiveVodCover: typeof getLiveVodCover }).getLiveVodCover = getLiveVodCover;
(window as unknown as { syncStreamerProfileLiveStatus: typeof syncStreamerProfileLiveStatus }).syncStreamerProfileLiveStatus = syncStreamerProfileLiveStatus;
