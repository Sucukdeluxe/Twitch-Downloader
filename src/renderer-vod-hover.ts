// VOD hover preview. When the user mouses over a VOD card, we lazy-fetch
// the channel's seek-preview storyboard sprite for that VOD and cycle
// through 4 evenly-spaced cells to produce a scrub-preview animation —
// the same UX twitch.tv ships on its VOD browsing pages.
//
// The storyboard fetch goes through the main process (axios via Node's
// http client) so the renderer never has to make its own HTTPS request
// to the Twitch CDN, sidestepping the same set of Electron renderer
// image-loading quirks the avatar code hit.

interface ActiveHover {
    vodId: string;
    intervalId: number;
    overlay: HTMLElement;
    card: HTMLElement;  // .vod-card, fuer preview-active toggle (separat vom overlay-host)
}

const vodStoryboardClientCache = new Map<string, VodStoryboard | null>();
let activeHover: ActiveHover | null = null;
let pendingHoverVodId: string | null = null;
let hoverRequestGeneration = 0;

const HOVER_DEBOUNCE_MS = 220;
const FRAME_INTERVAL_MS = 600;
const FRAMES_TO_CYCLE = 4;
// Bounded cache — each storyboard data URL is ~50-200 KB, so an
// unbounded cache could balloon to hundreds of MB on a long browsing
// session through a streamer with thousands of VODs. FIFO eviction
// keeps the working set fresh without manual cleanup.
const MAX_CLIENT_STORYBOARD_CACHE = 12;

function rememberStoryboard(vodId: string, sb: VodStoryboard | null): void {
    vodStoryboardClientCache.set(vodId, sb);
    if (vodStoryboardClientCache.size > MAX_CLIENT_STORYBOARD_CACHE) {
        // Map iterator is insertion-ordered — first key is the oldest.
        const oldestKey = vodStoryboardClientCache.keys().next().value as string | undefined;
        if (oldestKey !== undefined) vodStoryboardClientCache.delete(oldestKey);
    }
}

function ensureVodHoverHandlersBound(): void {
    const grid = document.getElementById('vodGrid');
    if (!grid || grid.dataset.hoverBound === '1') return;
    grid.dataset.hoverBound = '1';

    // Delegated mouseover/mouseout on the grid — re-renders of the
    // grid replace the card DOM but the grid root persists, so the
    // listener stays bound across streamer switches.
    grid.addEventListener('mouseover', (e) => {
        const target = e.target as HTMLElement | null;
        const card = target?.closest('.vod-card') as HTMLElement | null;
        if (!card) return;
        const related = e.relatedTarget as HTMLElement | null;
        if (related && card.contains(related)) return;
        const vodId = card.dataset.vodId;
        if (!vodId) return;
        scheduleHoverPreview(card, vodId);
    });
    grid.addEventListener('mouseout', (e) => {
        const target = e.target as HTMLElement | null;
        const card = target?.closest('.vod-card') as HTMLElement | null;
        if (!card) return;
        // Only clear when leaving the card entirely (not just moving
        // within it between child elements).
        const related = e.relatedTarget as HTMLElement | null;
        if (related && card.contains(related)) return;
        clearHoverPreview();
    });
}

function scheduleHoverPreview(card: HTMLElement, vodId: string): void {
    if (card.dataset.liveVod === 'true') return;
    if (pendingHoverVodId === vodId) return;
    pendingHoverVodId = vodId;
    const generation = ++hoverRequestGeneration;
    // Debounce so rapid mouse passes (scrolling, dragging across cards)
    // don't trigger a download for every card brushed.
    window.setTimeout(() => {
        if (pendingHoverVodId !== vodId || generation !== hoverRequestGeneration) return;
        void activateHoverPreview(card, vodId, generation);
    }, HOVER_DEBOUNCE_MS);
}

function clearHoverPreview(): void {
    hoverRequestGeneration += 1;
    pendingHoverVodId = null;
    if (!activeHover) return;
    window.clearInterval(activeHover.intervalId);
    activeHover.card.classList.remove('preview-active');
    // Brief opacity fade-out, then remove from DOM.
    activeHover.overlay.style.opacity = '0';
    const overlayToRemove = activeHover.overlay;
    window.setTimeout(() => { try { overlayToRemove.remove(); } catch { /* gone */ } }, 220);
    activeHover = null;
}

async function activateHoverPreview(card: HTMLElement, vodId: string, generation: number): Promise<void> {
    // Stale-guard: user might have moved off the card in the debounce window.
    if (pendingHoverVodId !== vodId || generation !== hoverRequestGeneration) return;

    let storyboard: VodStoryboard | null | undefined = vodStoryboardClientCache.get(vodId);
    if (storyboard === undefined) {
        try {
            storyboard = await window.api.getVodStoryboard(vodId);
        } catch (_) {
            storyboard = null;
        }
        rememberStoryboard(vodId, storyboard);
    }

    // Cursor may have moved on while we awaited; re-check guard.
    if (pendingHoverVodId !== vodId || generation !== hoverRequestGeneration) return;
    if (!storyboard) return;

    clearHoverPreview();

    // Pick FRAMES_TO_CYCLE evenly-spaced cells from the first sprite —
    // distributes the chosen preview frames across the early/mid portion
    // of the VOD. For very short VODs the first sprite is the only one,
    // so this still gives a representative spread.
    const totalCells = Math.min(storyboard.framesInSprite, storyboard.cols * storyboard.rows);
    const stride = Math.max(1, Math.floor(totalCells / FRAMES_TO_CYCLE));
    const cellsToShow: Array<{ col: number; row: number }> = [];
    for (let i = 0; i < FRAMES_TO_CYCLE; i++) {
        const idx = Math.min(totalCells - 1, i * stride);
        const col = idx % storyboard.cols;
        const row = Math.floor(idx / storyboard.cols);
        cellsToShow.push({ col, row });
    }

    const overlay = document.createElement('div');
    overlay.className = 'vod-storyboard-preview';

    // Anchor an .vod-thumb-wrap. Wrap-Element hat exakt Thumbnail-Bounds.
    const anchor = card.querySelector('.vod-thumb-wrap') as HTMLElement | null;
    const host = anchor ?? card;
    const hostRect = host.getBoundingClientRect();
    const width = hostRect.width;
    const height = hostRect.height;

    if (width <= 0 || height <= 0) return;
    const frameDataUrls = Array.isArray(storyboard.frameDataUrls) ? storyboard.frameDataUrls.filter((url) => typeof url === 'string' && url.length > 0) : [];
    if (frameDataUrls.length === 0 && (storyboard.cellWidth <= 0 || storyboard.cellHeight <= 0)) return;

    // Position + Size voll inline gesetzt — kein CSS aspect-ratio mehr, das
    // sich mit JS-Dimensionen streiten koennte (siehe styles.css, die Klasse
    // gibt nur noch Visual + Stacking, keine Geometrie).
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;

    // Skaliere X und Y unabhaengig, damit eine Cell die Overlay-Box exakt
    // fuellt — Twitch-Cell-Aspect kann von 16:9 minimal abweichen.
    overlay.style.backgroundRepeat = 'no-repeat';
    let advanceFrame: (index: number) => void;
    if (frameDataUrls.length > 0) {
        overlay.style.backgroundSize = 'cover';
        overlay.style.backgroundPosition = 'center';
        advanceFrame = (index) => {
            const frameUrl = frameDataUrls[index % frameDataUrls.length];
            overlay.style.backgroundImage = `url("${frameUrl.replace(/"/g, '%22')}")`;
        };
    } else {
        const scaleX = width / storyboard.cellWidth;
        const scaleY = height / storyboard.cellHeight;
        overlay.style.backgroundImage = `url("${storyboard.spriteDataUrl.replace(/"/g, '%22')}")`;
        overlay.style.backgroundSize = `${storyboard.cols * storyboard.cellWidth * scaleX}px ${storyboard.rows * storyboard.cellHeight * scaleY}px`;
        advanceFrame = (index) => {
            const cell = cellsToShow[index % cellsToShow.length];
            overlay.style.backgroundPosition = `-${cell.col * storyboard.cellWidth * scaleX}px -${cell.row * storyboard.cellHeight * scaleY}px`;
        };
    }
    advanceFrame(0);

    host.appendChild(overlay);
    let frameIdx = 1;
    const intervalId = window.setInterval(() => {
        advanceFrame(frameIdx);
        frameIdx++;
    }, FRAME_INTERVAL_MS);

    activeHover = { vodId, intervalId, overlay, card };
    requestAnimationFrame(() => {
        if (activeHover?.overlay === overlay) card.classList.add('preview-active');
    });
}

(window as unknown as { ensureVodHoverHandlersBound: typeof ensureVodHoverHandlersBound }).ensureVodHoverHandlersBound = ensureVodHoverHandlersBound;
(window as unknown as { clearVodHoverPreview: typeof clearHoverPreview }).clearVodHoverPreview = clearHoverPreview;

// Bind once the grid exists. Tab switches don't re-create the grid, so
// one-time binding via DOMContentLoaded is enough.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { ensureVodHoverHandlersBound(); });
} else {
    ensureVodHoverHandlersBound();
}
