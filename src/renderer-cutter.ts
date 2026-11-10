interface CutterCut {
    id: string;
    start: number;
    end: number;
}

interface CutterEditorState {
    duration: number;
    fps: number;
    trimStart: number;
    trimEnd: number;
    cuts: CutterCut[];
}

type CutterDragKind = 'playhead' | 'trim-start' | 'trim-end' | 'cut-start' | 'cut-end' | 'cut-move';

interface CutterDragState {
    kind: CutterDragKind;
    cutId: string | null;
    before: CutterEditorState;
    anchor: number;
    pointerId: number;
    captureTarget: HTMLElement;
    activeCutId: string | null;
}

let cutterEditorState: CutterEditorState | null = null;
let cutterHistoryPast: CutterEditorState[] = [];
let cutterHistoryFuture: CutterEditorState[] = [];
let cutterActiveCutId: string | null = null;
let cutterPreviewMode = true;
let cutterDragState: CutterDragState | null = null;
let cutterDragPointerX: number | null = null;
let cutterDragAnimationFrame: number | null = null;
let cutterZoom = 1;
let cutterLoadGeneration = 0;
let cutterMediaJobId: number | null = null;
let cutterAssetsRequestGeneration = 0;
let cutterAssetsPixelWidth = 0;
let cutterAssetsPixelHeight = 0;
let cutterAssetsInFlightJobId: number | null = null;
let cutterAssetsInFlightPixelWidth = 0;
let cutterAssetsInFlightPixelHeight = 0;
let cutterAssetRefreshTimer: number | null = null;
let cutterThumbnailSpriteImage: HTMLImageElement | null = null;
let cutterThumbnailSpriteTiles: HTMLCanvasElement[] = [];
let cutterThumbnailSpriteCount = 0;
let cutterThumbnailRenderFrame: number | null = null;
let cutterThumbnailSpriteObjectUrl: string | null = null;
let cutterThumbnailImages: HTMLImageElement[] = [];
let cutterEditorInitialized = false;
let cutterPlaybackFrame: number | null = null;
let cutterPlaybackUsesVideoCallback = false;
let cutterPreviousPlaybackTime: number | null = null;
let cutterWheelZoomFrame: number | null = null;
let cutterWheelZoomDeltaPixels = 0;
let cutterWheelZoomAnchorX = 0;
let cutterScrubTargetTime: number | null = null;
let cutterScrubFrameRequest: number | null = null;
let cutterScrubSeekInFlight = false;
let cutterScrubResumePlayback = false;
let cutterScrubGeneration = 0;
let cutterDiscardResolver: ((discard: boolean) => void) | null = null;
let cutterExportProfile: 'quality' | 'balanced' | 'fast' | 'archive' = 'balanced';
let cutterExportEncoder: 'software' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox' = 'software';
let cutterAudioStreamIndex = 0;
let cutterPendingProject: CutterProject | null = null;
let cutterAutosaveTimer: number | null = null;
let cutterExportOptions: CutterExportOptions | null = null;
let cutterRecoveryDecisionPending = false;
const cutterMaximumCuts = 64;
const cutterFrameTolerance = 1e-8;

function cloneCutterState(state: CutterEditorState): CutterEditorState {
    return { ...state, cuts: state.cuts.map((cut) => ({ ...cut })) };
}

function cutterStatesEqual(left: CutterEditorState, right: CutterEditorState): boolean {
    return left.duration === right.duration
        && left.fps === right.fps
        && left.trimStart === right.trimStart
        && left.trimEnd === right.trimEnd
        && left.cuts.length === right.cuts.length
        && left.cuts.every((cut, index) => {
            const other = right.cuts[index];
            return cut.id === other.id && cut.start === other.start && cut.end === other.end;
        });
}

function clampCutterValue(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function snapCutterTime(value: number): number {
    if (!cutterEditorState) return 0;
    return Number((Math.round(value * cutterEditorState.fps) / cutterEditorState.fps).toFixed(9));
}

function cutterHasPlayableFrame(cuts: CutterCut[]): boolean {
    if (!cutterEditorState) return false;
    const removedDuration = cuts.reduce((total, cut) => total + cut.end - cut.start, 0);
    return cutterEditorState.trimEnd - cutterEditorState.trimStart - removedDuration >= 1 / cutterEditorState.fps - cutterFrameTolerance;
}

function getInitialCutterZoom(duration: number): number {
    return clampCutterValue(Math.round(duration / 75) / 4, 1, 4);
}

function formatCutterTimecode(time: number): string {
    const fps = cutterEditorState?.fps || cutterVideoInfo?.fps || 30;
    let seconds = Math.floor(Math.max(0, time));
    let frames = Math.round((Math.max(0, time) - seconds) * fps);
    const frameBase = Math.max(1, Math.round(fps));
    if (frames >= frameBase) {
        seconds += 1;
        frames = 0;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    const useHours = (cutterEditorState?.duration || cutterVideoInfo?.duration || time) >= 3600;
    const fields = useHours
        ? [hours, minutes, remainingSeconds, frames]
        : [minutes, remainingSeconds, frames];
    return fields.map((field) => String(field).padStart(2, '0')).join(':');
}

function parseCutterTimecode(value: string): number | null {
    if (!cutterEditorState) return null;
    const fields = value.trim().split(':').map((field) => Number(field));
    if ((fields.length !== 3 && fields.length !== 4) || fields.some((field) => !Number.isInteger(field) || field < 0)) return null;
    const [hours, minutes, seconds, frames] = fields.length === 4
        ? fields
        : [0, fields[0], fields[1], fields[2]];
    if (minutes >= 60 || seconds >= 60 || frames >= Math.max(1, Math.round(cutterEditorState.fps))) return null;
    return snapCutterTime(hours * 3600 + minutes * 60 + seconds + frames / cutterEditorState.fps);
}

function getCutterVideo(): HTMLVideoElement {
    return byId<HTMLVideoElement>('cutterVideo');
}

function getCutterPlayableDuration(): number {
    if (!cutterEditorState) return 0;
    const removed = cutterEditorState.cuts.reduce((total, cut) => total + cut.end - cut.start, 0);
    return Math.max(0, cutterEditorState.trimEnd - cutterEditorState.trimStart - removed);
}

function getCutterProjectPayload(): Omit<CutterProject, 'source' | 'duration' | 'fps'> | null {
    if (!cutterEditorState) return null;
    return {
        trimStart: cutterEditorState.trimStart,
        trimEnd: cutterEditorState.trimEnd,
        cuts: cutterEditorState.cuts.map((cut) => ({ ...cut })),
        profile: cutterExportProfile,
        encoder: cutterExportEncoder,
        audioStreamIndex: cutterAudioStreamIndex,
    };
}

async function persistCutterProject(showResult: boolean): Promise<boolean> {
    const file = cutterFile;
    const project = getCutterProjectPayload();
    if (!file || !project) return false;
    let saved = false;
    try {
        saved = await window.api.saveCutterProject(file.token, project);
    } catch { }
    if (showResult) showAppToast(saved ? 'Projekt gespeichert' : 'Projekt konnte nicht gespeichert werden', saved ? 'info' : 'warn');
    return saved;
}

function scheduleCutterAutosave(): void {
    if (cutterAutosaveTimer !== null) window.clearTimeout(cutterAutosaveTimer);
    const file = cutterFile;
    cutterAutosaveTimer = window.setTimeout(() => {
        cutterAutosaveTimer = null;
        if (!file || cutterFile !== file || cutterRecoveryDecisionPending) return;
        void persistCutterProject(false);
    }, 500);
}

function renderCutterProjectRecovery(project: CutterProject | null): void {
    cutterPendingProject = project;
    const panel = byId<HTMLElement>('cutterRecoveryPanel');
    panel.hidden = !project;
    if (project) byId('cutterRecoveryText').textContent = 'Gespeicherte Bearbeitung gefunden';
}

function updateCutterAudioStreams(): void {
    const select = byId<HTMLSelectElement>('cutterAudioStream');
    const streams = cutterVideoInfo?.audioStreams ?? [];
    select.replaceChildren();
    if (streams.length === 0) {
        const option = document.createElement('option');
        option.value = '0';
        option.textContent = 'Keine Audiospur';
        select.append(option);
        select.disabled = true;
        cutterAudioStreamIndex = 0;
        return;
    }
    streams.forEach((stream) => {
        const option = document.createElement('option');
        option.value = String(stream.index);
        const details = [stream.language, stream.codec, stream.channels > 0 ? `${stream.channels} Kanäle` : ''].filter(Boolean).join(' · ');
        option.textContent = `Audiospur ${stream.index + 1}${details ? ` (${details})` : ''}`;
        select.append(option);
    });
    if (!streams.some((stream) => stream.index === cutterAudioStreamIndex)) cutterAudioStreamIndex = streams[0].index;
    select.value = String(cutterAudioStreamIndex);
    select.disabled = false;
}

function updateCutterExportControls(options: CutterExportOptions | null): void {
    const profile = byId<HTMLSelectElement>('cutterExportProfile');
    const encoder = byId<HTMLSelectElement>('cutterExportEncoder');
    if (options) {
        profile.replaceChildren(...options.profiles.map((entry) => {
            const option = document.createElement('option');
            option.value = entry.id;
            option.textContent = entry.label;
            return option;
        }));
    }
    profile.value = cutterExportProfile;
    encoder.replaceChildren();
    const software = document.createElement('option');
    software.value = 'software';
    software.textContent = 'Software';
    encoder.append(software);
    if (cutterExportProfile !== 'archive') {
        (options?.hardwareEncoders ?? []).forEach((value) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value === 'h264_nvenc' ? 'NVIDIA NVENC' : value === 'h264_qsv' ? 'Intel Quick Sync' : value === 'h264_videotoolbox' ? 'Apple VideoToolbox' : 'AMD AMF';
            encoder.append(option);
        });
    }
    if (!Array.from(encoder.options).some((option) => option.value === cutterExportEncoder)) cutterExportEncoder = 'software';
    encoder.value = cutterExportEncoder;
    encoder.disabled = cutterExportProfile === 'archive';
}

async function loadCutterExportOptions(file: FileCapabilityReference, generation: number): Promise<void> {
    let options: CutterExportOptions | null = null;
    try {
        options = await window.api.getCutterExportOptions();
    } catch { }
    if (generation !== cutterLoadGeneration || cutterFile !== file) return;
    cutterExportOptions = options;
    updateCutterExportControls(options);
}

function applyCutterProject(project: CutterProject): boolean {
    if (!cutterEditorState || !cutterVideoInfo) return false;
    if (Math.abs(project.duration - cutterEditorState.duration) > 1 / cutterEditorState.fps || Math.abs(project.fps - cutterEditorState.fps) > 0.01) return false;
    cutterEditorState = {
        duration: cutterEditorState.duration,
        fps: cutterEditorState.fps,
        trimStart: project.trimStart,
        trimEnd: project.trimEnd,
        cuts: project.cuts.map((cut) => ({ ...cut })),
    };
    cutterExportProfile = project.profile;
    cutterExportEncoder = project.encoder;
    cutterAudioStreamIndex = project.audioStreamIndex;
    updateCutterAudioStreams();
    updateCutterExportControls(cutterExportOptions);
    cutterHistoryPast = [];
    cutterHistoryFuture = [];
    cutterActiveCutId = null;
    renderCutterEditor();
    seekCutterVideo(cutterEditorState.trimStart);
    return true;
}

async function recoverCutterProject(): Promise<void> {
    if (!cutterPendingProject || !applyCutterProject(cutterPendingProject)) {
        showAppToast('Projekt konnte nicht wiederhergestellt werden', 'warn');
        return;
    }
    cutterRecoveryDecisionPending = false;
    renderCutterProjectRecovery(null);
    showAppToast('Projekt wiederhergestellt', 'info');
}

async function discardCutterProject(): Promise<void> {
    if (!cutterFile) return;
    try { await window.api.discardCutterProject(cutterFile.token); } catch { }
    cutterRecoveryDecisionPending = false;
    renderCutterProjectRecovery(null);
}

async function saveCutterProject(): Promise<void> {
    cutterRecoveryDecisionPending = false;
    await persistCutterProject(true);
}

async function openCutterProject(): Promise<void> {
    if (!cutterFile) return;
    let project: CutterProject | null = null;
    try { project = await window.api.openCutterProject(cutterFile.token); } catch { }
    if (!project || !applyCutterProject(project)) {
        showAppToast('Kein passendes Projekt gefunden', 'warn');
        return;
    }
    cutterRecoveryDecisionPending = false;
    renderCutterProjectRecovery(null);
    showAppToast('Projekt geöffnet', 'info');
}

function setCutterExportProfile(value: string): void {
    if (value !== 'quality' && value !== 'balanced' && value !== 'fast' && value !== 'archive') return;
    cutterExportProfile = value;
    if (value === 'archive') cutterExportEncoder = 'software';
    updateCutterExportControls(cutterExportOptions);
    scheduleCutterAutosave();
}

function setCutterExportEncoder(value: string): void {
    if (value !== 'software' && value !== 'h264_nvenc' && value !== 'h264_qsv' && value !== 'h264_amf' && value !== 'h264_videotoolbox') return;
    cutterExportEncoder = value;
    scheduleCutterAutosave();
}

function setCutterAudioStream(value: string): void {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || !(cutterVideoInfo?.audioStreams ?? []).some((stream) => stream.index === index)) return;
    cutterAudioStreamIndex = index;
    scheduleCutterAutosave();
}

function commitCutterChange(before: CutterEditorState): void {
    if (!cutterEditorState || cutterStatesEqual(before, cutterEditorState)) return;
    cutterHistoryPast.push(cloneCutterState(before));
    if (cutterHistoryPast.length > 100) cutterHistoryPast.shift();
    cutterHistoryFuture = [];
    updateCutterHistoryButtons();
    scheduleCutterAutosave();
}

function updateCutterHistoryButtons(): void {
    byId<HTMLButtonElement>('cutterUndoBtn').disabled = cutterHistoryPast.length === 0;
    byId<HTMLButtonElement>('cutterRedoBtn').disabled = cutterHistoryFuture.length === 0;
}

function setCutterTrim(start: number, end: number): boolean {
    if (!cutterEditorState) return false;
    const nextStart = clampCutterValue(snapCutterTime(start), 0, cutterEditorState.duration);
    const nextEnd = clampCutterValue(snapCutterTime(end), 0, cutterEditorState.duration);
    if (nextEnd - nextStart < 1 / cutterEditorState.fps - cutterFrameTolerance) return false;
    const cuts = cutterEditorState.cuts
        .map((cut) => ({ ...cut, start: Math.max(cut.start, nextStart), end: Math.min(cut.end, nextEnd) }))
        .filter((cut) => cut.end - cut.start >= 1 / cutterEditorState!.fps - cutterFrameTolerance);
    const nextState = {
        ...cutterEditorState,
        trimStart: nextStart,
        trimEnd: nextEnd,
        cuts,
    };
    const removedDuration = cuts.reduce((total, cut) => total + cut.end - cut.start, 0);
    if (nextEnd - nextStart - removedDuration < 1 / cutterEditorState.fps - cutterFrameTolerance) return false;
    cutterEditorState = nextState;
    if (cutterActiveCutId && !cutterEditorState.cuts.some((cut) => cut.id === cutterActiveCutId)) cutterActiveCutId = null;
    return true;
}

function setCutterCutRange(id: string, start: number, end: number): boolean {
    if (!cutterEditorState) return false;
    const cut = cutterEditorState.cuts.find((entry) => entry.id === id);
    if (!cut) return false;
    const nextStart = clampCutterValue(snapCutterTime(start), cutterEditorState.trimStart, cutterEditorState.trimEnd);
    const nextEnd = clampCutterValue(snapCutterTime(end), cutterEditorState.trimStart, cutterEditorState.trimEnd);
    if (nextEnd - nextStart < 1 / cutterEditorState.fps - cutterFrameTolerance) return false;
    const overlaps = cutterEditorState.cuts.some((entry) => entry.id !== id && nextStart < entry.end && nextEnd > entry.start);
    if (overlaps) return false;
    const cuts = cutterEditorState.cuts
        .map((entry) => entry.id === id ? { ...entry, start: nextStart, end: nextEnd } : entry)
        .sort((left, right) => left.start - right.start);
    if (!cutterHasPlayableFrame(cuts)) return false;
    cutterEditorState = {
        ...cutterEditorState,
        cuts,
    };
    return true;
}

function findCutterPreviewTime(time: number, previousTime: number | null = null): number {
    if (!cutterEditorState) return 0;
    let nextTime = clampCutterValue(time, cutterEditorState.trimStart, cutterEditorState.trimEnd);
    if (cutterPreviewMode) {
        for (const cut of cutterEditorState.cuts) {
            if (nextTime >= cut.start && nextTime < cut.end) {
                nextTime = cut.end;
            } else if (previousTime !== null && previousTime < cut.start && nextTime >= cut.end) {
                nextTime += cut.end - cut.start;
            }
        }
    }
    return clampCutterValue(nextTime, cutterEditorState.trimStart, cutterEditorState.trimEnd);
}

function finishCutterScrubPlayback(): void {
    if (cutterDragState || cutterScrubSeekInFlight || cutterScrubTargetTime !== null || !cutterScrubResumePlayback) return;
    cutterScrubResumePlayback = false;
    void getCutterVideo().play();
}

function presentNextCutterScrubFrame(): void {
    if (!cutterEditorState || cutterScrubSeekInFlight || cutterScrubTargetTime === null) return;
    const video = getCutterVideo() as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
    };
    const targetTime = cutterScrubTargetTime;
    cutterScrubTargetTime = null;
    const frameDuration = 1 / cutterEditorState.fps;
    if (Math.abs(video.currentTime - targetTime) < frameDuration / 2) {
        cutterPreviousPlaybackTime = targetTime;
        updateCutterPlayhead(targetTime);
        if (cutterScrubTargetTime !== null) presentNextCutterScrubFrame();
        else finishCutterScrubPlayback();
        return;
    }
    const generation = cutterScrubGeneration;
    cutterScrubSeekInFlight = true;
    const finish = (mediaTime: number): void => {
        if (generation !== cutterScrubGeneration || !cutterEditorState) return;
        cutterScrubFrameRequest = null;
        cutterScrubSeekInFlight = false;
        const presentedTime = clampCutterValue(snapCutterTime(mediaTime), 0, cutterEditorState.duration);
        cutterPreviousPlaybackTime = presentedTime;
        updateCutterPlayhead(presentedTime);
        if (cutterScrubTargetTime !== null) presentNextCutterScrubFrame();
        else finishCutterScrubPlayback();
    };
    if (video.requestVideoFrameCallback) {
        cutterScrubFrameRequest = video.requestVideoFrameCallback((_now, metadata) => finish(metadata.mediaTime));
    } else {
        video.addEventListener('seeked', () => finish(video.currentTime), { once: true });
    }
    video.currentTime = targetTime;
}

function queueCutterScrubFrame(time: number): void {
    if (!cutterEditorState) return;
    cutterScrubTargetTime = clampCutterValue(snapCutterTime(time), 0, cutterEditorState.duration);
    presentNextCutterScrubFrame();
}

function cancelCutterScrubFrames(): void {
    const video = getCutterVideo() as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void };
    cutterScrubGeneration += 1;
    if (cutterScrubFrameRequest !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(cutterScrubFrameRequest);
    cutterScrubTargetTime = null;
    cutterScrubFrameRequest = null;
    cutterScrubSeekInFlight = false;
    cutterScrubResumePlayback = false;
}

function seekCutterVideo(time: number, skipCuts = false): void {
    if (!cutterEditorState) return;
    const video = getCutterVideo();
    const nextTime = skipCuts ? findCutterPreviewTime(time) : clampCutterValue(snapCutterTime(time), 0, cutterEditorState.duration);
    if (Number.isFinite(video.duration)) video.currentTime = nextTime;
    cutterPreviousPlaybackTime = nextTime;
    updateCutterPlayhead(nextTime);
}

function updateCutterPlayhead(time: number): void {
    if (!cutterEditorState) return;
    if (cutterDragState?.kind !== 'playhead' && !cutterScrubSeekInFlight && cutterScrubTargetTime === null) {
        updateCutterInteractionPlayhead(time);
    }
    const timecode = formatCutterTimecode(time);
    const timelineTimecode = byId('cutterTimelineTimecode');
    const playerTimecode = byId('cutterCurrentTime');
    if (timelineTimecode.textContent !== timecode) timelineTimecode.textContent = timecode;
    if (playerTimecode.textContent !== timecode) playerTimecode.textContent = timecode;
}

function updateCutterInteractionPlayhead(time: number): void {
    if (!cutterEditorState) return;
    const percent = clampCutterValue(time / cutterEditorState.duration * 100, 0, 100);
    byId('timelineCurrent').style.left = `${percent}%`;
}

function renderCutterRuler(): void {
    if (!cutterEditorState) return;
    const ruler = byId('cutterRuler');
    const fragment = document.createDocumentFragment();
    const count = Math.max(8, Math.round(8 * cutterZoom));
    for (let index = 0; index <= count; index += 1) {
        const tick = document.createElement('span');
        tick.className = 'cutter-ruler-tick';
        tick.style.left = `${index / count * 100}%`;
        tick.textContent = formatCutterTimecode(cutterEditorState.duration * index / count).replace(/:\d{2}$/, '');
        fragment.appendChild(tick);
    }
    ruler.replaceChildren(fragment);
}

function clearCutterThumbnailSprite(): void {
    if (cutterThumbnailRenderFrame !== null) {
        cancelAnimationFrame(cutterThumbnailRenderFrame);
        cutterThumbnailRenderFrame = null;
    }
    cutterThumbnailSpriteImage = null;
    cutterThumbnailSpriteTiles = [];
    cutterThumbnailSpriteCount = 0;
    if (cutterThumbnailSpriteObjectUrl) {
        URL.revokeObjectURL(cutterThumbnailSpriteObjectUrl);
        cutterThumbnailSpriteObjectUrl = null;
    }
}

function drawCutterThumbnailSprite(): void {
    cutterThumbnailRenderFrame = null;
    const image = cutterThumbnailSpriteImage;
    if (!image || !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1 || cutterThumbnailSpriteCount < 1) return;
    const strip = byId<HTMLElement>('cutterThumbnailStrip');
    const cssWidth = Math.max(1, strip.getBoundingClientRect().width);
    const cssHeight = Math.max(1, strip.getBoundingClientRect().height);
    const pixelRatio = clampCutterValue(window.devicePixelRatio || 1, 1, 3);
    const sourceColumns = Math.ceil(Math.sqrt(cutterThumbnailSpriteCount));
    const sourceRows = Math.ceil(cutterThumbnailSpriteCount / sourceColumns);
    const sourceFrameWidth = image.naturalWidth / sourceColumns;
    const sourceFrameHeight = image.naturalHeight / sourceRows;
    const targetWidth = Math.min(sourceFrameWidth * cutterThumbnailSpriteCount, Math.max(1, Math.ceil(cssWidth * pixelRatio)));
    const targetHeight = Math.min(sourceFrameHeight, Math.max(1, Math.ceil(cssHeight * pixelRatio)));
    const minimumReadableWidth = 112;
    const visibleFrameCount = Math.ceil(cssWidth / minimumReadableWidth);
    const densityFrameCount = Math.ceil(targetWidth / sourceFrameWidth);
    const renderedFrameCount = Math.min(cutterThumbnailSpriteCount, Math.max(1, visibleFrameCount, densityFrameCount));
    if (cutterThumbnailSpriteTiles.length !== renderedFrameCount) {
        cutterThumbnailSpriteTiles = Array.from({ length: renderedFrameCount }, () => {
            const tile = document.createElement('canvas');
            tile.className = 'cutter-thumbnail-tile';
            tile.setAttribute('aria-hidden', 'true');
            return tile;
        });
        strip.replaceChildren(image, ...cutterThumbnailSpriteTiles);
    }
    const sourceIndexes: number[] = [];
    for (let index = 0; index < renderedFrameCount; index += 1) {
        const tile = cutterThumbnailSpriteTiles[index];
        const sourceIndex = renderedFrameCount === 1
            ? Math.floor((cutterThumbnailSpriteCount - 1) / 2)
            : Math.round(index * (cutterThumbnailSpriteCount - 1) / (renderedFrameCount - 1));
        const destinationLeft = Math.round(index * targetWidth / renderedFrameCount);
        const destinationRight = Math.round((index + 1) * targetWidth / renderedFrameCount);
        const destinationWidth = Math.max(1, destinationRight - destinationLeft);
        const context = tile.getContext('2d', { alpha: false });
        if (!context) return;
        tile.width = destinationWidth;
        tile.height = targetHeight;
        tile.style.width = `${100 / renderedFrameCount}%`;
        tile.style.flex = `0 0 ${100 / renderedFrameCount}%`;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        const sourceColumn = sourceIndex % sourceColumns;
        const sourceRow = Math.floor(sourceIndex / sourceColumns);
        const destinationAspect = destinationWidth / targetHeight;
        let sourceX = sourceColumn * sourceFrameWidth;
        let sourceY = sourceRow * sourceFrameHeight;
        let sourceWidth = sourceFrameWidth;
        let sourceHeight = sourceFrameHeight;
        if (sourceWidth / sourceHeight > destinationAspect) {
            const croppedWidth = sourceHeight * destinationAspect;
            sourceX += (sourceWidth - croppedWidth) / 2;
            sourceWidth = croppedWidth;
        } else {
            const croppedHeight = sourceWidth / destinationAspect;
            sourceY += (sourceHeight - croppedHeight) / 2;
            sourceHeight = croppedHeight;
        }
        context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, destinationWidth, targetHeight);
        tile.dataset.pixelWidth = String(destinationWidth);
        sourceIndexes.push(sourceIndex);
    }
    strip.dataset.renderedFrameCount = String(renderedFrameCount);
    strip.dataset.framePixelWidth = String(Math.ceil(targetWidth / renderedFrameCount));
    strip.dataset.renderedFrameIndexes = sourceIndexes.join(',');
    strip.dataset.renderedPixelWidth = String(targetWidth);
}

function scheduleCutterThumbnailSpriteRender(): void {
    if (!cutterThumbnailSpriteImage || cutterThumbnailRenderFrame !== null) return;
    cutterThumbnailRenderFrame = requestAnimationFrame(drawCutterThumbnailSprite);
}

function drawCutterThumbnailImages(cssWidthOverride?: number): void {
    if (cutterThumbnailImages.length === 0) return;
    const strip = byId<HTMLElement>('cutterThumbnailStrip');
    const cssWidth = Math.max(1, cssWidthOverride || strip.getBoundingClientRect().width);
    const pixelRatio = clampCutterValue(window.devicePixelRatio || 1, 1, 3);
    const loadedImage = cutterThumbnailImages.find((image) => image.naturalWidth > 0 && image.naturalHeight > 0);
    const sourceFrameWidth = loadedImage?.naturalWidth || 320;
    const sourceFrameHeight = loadedImage?.naturalHeight || 180;
    const trackHeight = Math.max(1, strip.getBoundingClientRect().height);
    const tileWidth = Math.max(1, Math.ceil(trackHeight * sourceFrameWidth / sourceFrameHeight));
    const targetWidth = Math.min(sourceFrameWidth * cutterThumbnailImages.length, Math.max(1, Math.ceil(cssWidth * pixelRatio)));
    const renderedFrameCount = Math.min(cutterThumbnailImages.length, Math.max(1, Math.ceil(cssWidth / tileWidth), Math.ceil(targetWidth / sourceFrameWidth)));
    const sourceIndexes: number[] = [];
    const visibleImages: HTMLImageElement[] = [];
    for (let index = 0; index < renderedFrameCount; index += 1) {
        const sourceIndex = renderedFrameCount === 1
            ? Math.floor((cutterThumbnailImages.length - 1) / 2)
            : Math.round(index * (cutterThumbnailImages.length - 1) / (renderedFrameCount - 1));
        sourceIndexes.push(sourceIndex);
        const image = cutterThumbnailImages[sourceIndex];
        const visibleWidth = index === renderedFrameCount - 1
            ? Math.max(1, cssWidth - tileWidth * (renderedFrameCount - 1))
            : tileWidth;
        image.style.width = `${visibleWidth}px`;
        image.style.minWidth = `${visibleWidth}px`;
        image.style.flex = `0 0 ${visibleWidth}px`;
        visibleImages.push(image);
    }
    strip.replaceChildren(...visibleImages);
    strip.dataset.renderedFrameCount = String(renderedFrameCount);
    strip.dataset.framePixelWidth = String(Math.ceil(targetWidth / renderedFrameCount));
    strip.dataset.renderedFrameIndexes = sourceIndexes.join(',');
    strip.dataset.renderedPixelWidth = String(targetWidth);
}

function createCutterImageObjectUrl(source: string): string | null {
    const separator = source.indexOf(',');
    if (separator < 0) return null;
    const metadata = source.slice(0, separator);
    const contentType = /^data:([^;,]+)/.exec(metadata)?.[1] || 'application/octet-stream';
    const binary = atob(source.slice(separator + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: contentType }));
}

function renderCutterThumbnails(thumbnails: string[], thumbnailSprite: string | null = null, thumbnailCount = thumbnails.length): void {
    const strip = byId('cutterThumbnailStrip');
    clearCutterThumbnailSprite();
    cutterThumbnailImages = [];
    strip.replaceChildren();
    strip.dataset.thumbnailCount = String(thumbnailCount);
    delete strip.dataset.renderedFrameCount;
    delete strip.dataset.framePixelWidth;
    delete strip.dataset.renderedFrameIndexes;
    delete strip.dataset.renderedPixelWidth;
    if (thumbnailSprite) {
        const image = document.createElement('img');
        image.className = 'cutter-thumbnail-sprite';
        image.alt = '';
        image.draggable = false;
        cutterThumbnailSpriteImage = image;
        cutterThumbnailSpriteCount = thumbnailCount;
        image.addEventListener('load', scheduleCutterThumbnailSpriteRender, { once: true });
        cutterThumbnailSpriteObjectUrl = createCutterImageObjectUrl(thumbnailSprite);
        image.src = cutterThumbnailSpriteObjectUrl || thumbnailSprite;
        strip.append(image);
        void image.decode().then(scheduleCutterThumbnailSpriteRender).catch(() => undefined);
        return;
    }
    cutterThumbnailImages = thumbnails.map((source) => {
        const image = document.createElement('img');
        image.src = source;
        image.alt = '';
        image.draggable = false;
        return image;
    });
    drawCutterThumbnailImages();
}

function getCutterAssetProfile(): VideoEditorAssetProfile {
    const timelineWidth = Math.max(1, Math.ceil(byId<HTMLElement>('timeline').getBoundingClientRect().width));
    const trackHeight = Math.max(1, Math.ceil(byId<HTMLElement>('cutterVideoTrack').getBoundingClientRect().height));
    const pixelRatio = clampCutterValue(window.devicePixelRatio || 1, 1, 3);
    return { timelineWidth, trackHeight, pixelRatio };
}

function getCutterAssetPixelWidth(profile: VideoEditorAssetProfile = getCutterAssetProfile()): number {
    if (cutterVideoInfo && cutterVideoInfo.duration <= 120) return 32000;
    return Math.min(32000, Math.max(1800, Math.ceil(profile.timelineWidth * profile.pixelRatio)));
}

function getCutterAssetPixelHeight(profile: VideoEditorAssetProfile = getCutterAssetProfile()): number {
    if (cutterVideoInfo && cutterVideoInfo.duration <= 120) return 180;
    return Math.min(360, Math.max(80, Math.ceil(profile.trackHeight * profile.pixelRatio)));
}

function scheduleCutterAssetRefresh(): void {
    if (cutterAssetRefreshTimer !== null) window.clearTimeout(cutterAssetRefreshTimer);
    cutterAssetRefreshTimer = window.setTimeout(() => {
        cutterAssetRefreshTimer = null;
        void requestCutterAssets();
    }, 180);
}

function renderCutterCutList(): void {
    const list = byId('cutterCutList');
    list.replaceChildren();
    if (!cutterEditorState || cutterEditorState.cuts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cutter-cut-empty';
        empty.id = 'cutterCutEmpty';
        empty.textContent = UI_TEXT.cutter.noCuts;
        list.appendChild(empty);
        byId('cutterCutCount').textContent = '0';
        return;
    }
    byId('cutterCutCount').textContent = String(cutterEditorState.cuts.length);
    cutterEditorState.cuts.forEach((cut, index) => {
        const row = document.createElement('div');
        row.className = `cutter-cut-row${cut.id === cutterActiveCutId ? ' active' : ''}`;
        row.dataset.cutId = cut.id;
        const heading = document.createElement('button');
        heading.type = 'button';
        heading.className = 'cutter-cut-row-heading';
        const color = document.createElement('span');
        color.className = 'cutter-cut-color';
        const label = document.createElement('strong');
        label.textContent = `${UI_TEXT.cutter.cutLabel} ${index + 1}`;
        const duration = document.createElement('span');
        duration.textContent = formatCutterTimecode(cut.end - cut.start);
        heading.append(color, label, duration);
        heading.addEventListener('click', () => {
            cutterActiveCutId = cut.id;
            seekCutterVideo(cut.start);
            renderCutterEditor();
        });
        const fields = document.createElement('div');
        fields.className = 'cutter-cut-fields';
        const startInput = document.createElement('input');
        startInput.value = formatCutterTimecode(cut.start);
        startInput.spellcheck = false;
        startInput.setAttribute('aria-label', UI_TEXT.cutter.startLabel);
        const endInput = document.createElement('input');
        endInput.value = formatCutterTimecode(cut.end);
        endInput.spellcheck = false;
        endInput.setAttribute('aria-label', UI_TEXT.cutter.endLabel);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'cutter-cut-remove';
        remove.setAttribute('aria-label', UI_TEXT.cutter.removeCut);
        remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"></path></svg>';
        const applyFields = (): void => {
            const start = parseCutterTimecode(startInput.value);
            const end = parseCutterTimecode(endInput.value);
            if (start === null || end === null) {
                renderCutterEditor();
                return;
            }
            const before = cloneCutterState(cutterEditorState!);
            if (!setCutterCutRange(cut.id, start, end)) {
                showAppToast(UI_TEXT.cutter.invalidRange, 'warn');
                renderCutterEditor();
                return;
            }
            commitCutterChange(before);
            cutterActiveCutId = cut.id;
            seekCutterVideo(start);
            renderCutterEditor();
        };
        startInput.addEventListener('change', applyFields);
        endInput.addEventListener('change', applyFields);
        startInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') applyFields(); });
        endInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') applyFields(); });
        remove.addEventListener('click', () => removeCutterCut(cut.id));
        fields.append(startInput, endInput, remove);
        row.append(heading, fields);
        list.appendChild(row);
    });
}

function renderCutterCutOverlays(): void {
    const container = byId('cutterCutOverlays');
    container.replaceChildren();
    if (!cutterEditorState) return;
    const editorState = cutterEditorState;
    editorState.cuts.forEach((cut, index) => {
        const overlay = document.createElement('div');
        overlay.className = `cutter-cut-overlay${cut.id === cutterActiveCutId ? ' active' : ''}`;
        overlay.dataset.cutId = cut.id;
        overlay.style.left = `${cut.start / editorState.duration * 100}%`;
        overlay.style.width = `${(cut.end - cut.start) / editorState.duration * 100}%`;
        overlay.setAttribute('role', 'group');
        overlay.setAttribute('tabindex', '0');
        overlay.setAttribute('aria-label', `${UI_TEXT.cutter.cutLabel} ${index + 1}, ${UI_TEXT.cutter.startLabel} ${formatCutterTimecode(cut.start)}, ${UI_TEXT.cutter.endLabel} ${formatCutterTimecode(cut.end)}`);
        const label = document.createElement('span');
        label.textContent = `${index + 1}`;
        const startHandle = document.createElement('button');
        startHandle.type = 'button';
        startHandle.className = 'cutter-cut-handle start';
        startHandle.setAttribute('role', 'slider');
        startHandle.setAttribute('aria-label', `${UI_TEXT.cutter.cutLabel} ${index + 1}: ${UI_TEXT.cutter.startLabel}`);
        startHandle.setAttribute('aria-valuemin', String(editorState.trimStart));
        startHandle.setAttribute('aria-valuemax', String(cut.end - 1 / editorState.fps));
        startHandle.setAttribute('aria-valuenow', String(cut.start));
        startHandle.setAttribute('aria-valuetext', formatCutterTimecode(cut.start));
        const endHandle = document.createElement('button');
        endHandle.type = 'button';
        endHandle.className = 'cutter-cut-handle end';
        endHandle.setAttribute('role', 'slider');
        endHandle.setAttribute('aria-label', `${UI_TEXT.cutter.cutLabel} ${index + 1}: ${UI_TEXT.cutter.endLabel}`);
        endHandle.setAttribute('aria-valuemin', String(cut.start + 1 / editorState.fps));
        endHandle.setAttribute('aria-valuemax', String(editorState.trimEnd));
        endHandle.setAttribute('aria-valuenow', String(cut.end));
        endHandle.setAttribute('aria-valuetext', formatCutterTimecode(cut.end));
        startHandle.addEventListener('pointerdown', (event) => beginCutterDrag('cut-start', event, cut.id));
        endHandle.addEventListener('pointerdown', (event) => beginCutterDrag('cut-end', event, cut.id));
        startHandle.addEventListener('keydown', (event) => handleCutterBoundaryKey(event, 'cut-start', cut.id));
        endHandle.addEventListener('keydown', (event) => handleCutterBoundaryKey(event, 'cut-end', cut.id));
        overlay.addEventListener('pointerdown', (event) => {
            const rect = overlay.getBoundingClientRect();
            if (rect.width >= 24) return;
            const center = rect.left + rect.width / 2;
            const moveHalfWidth = Math.min(3, Math.max(1, rect.width / 6));
            const kind = event.clientX < center - moveHalfWidth
                ? 'cut-start'
                : event.clientX > center + moveHalfWidth
                    ? 'cut-end'
                    : 'cut-move';
            beginCutterDrag(kind, event, cut.id);
        }, { capture: true });
        overlay.addEventListener('pointerdown', (event) => {
            if (event.target === startHandle || event.target === endHandle) return;
            cutterActiveCutId = cut.id;
            beginCutterDrag('cut-move', event, cut.id);
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                cutterActiveCutId = cut.id;
                seekCutterVideo(cut.start);
                renderCutterEditor();
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                handleCutterBoundaryKey(event, 'cut-move', cut.id);
            }
        });
        overlay.append(startHandle, label, endHandle);
        container.appendChild(overlay);
    });
}

function updateCutterEditorGeometry(): void {
    if (!cutterEditorState) return;
    const startPercent = cutterEditorState.trimStart / cutterEditorState.duration * 100;
    const endPercent = cutterEditorState.trimEnd / cutterEditorState.duration * 100;
    const selection = byId('timelineSelection');
    selection.style.left = `${startPercent}%`;
    selection.style.width = `${endPercent - startPercent}%`;
    byId('cutterOutsideLeft').style.width = `${startPercent}%`;
    byId('cutterOutsideRight').style.left = `${endPercent}%`;
    byId('cutterOutsideRight').style.width = `${100 - endPercent}%`;
    byId<HTMLInputElement>('startTime').value = formatCutterTimecode(cutterEditorState.trimStart);
    byId<HTMLInputElement>('endTime').value = formatCutterTimecode(cutterEditorState.trimEnd);
    const trimStartHandle = byId<HTMLElement>('cutterTrimStartHandle');
    trimStartHandle.setAttribute('role', 'slider');
    trimStartHandle.setAttribute('aria-valuemin', '0');
    trimStartHandle.setAttribute('aria-valuemax', String(cutterEditorState.trimEnd - 1 / cutterEditorState.fps));
    trimStartHandle.setAttribute('aria-valuenow', String(cutterEditorState.trimStart));
    trimStartHandle.setAttribute('aria-valuetext', formatCutterTimecode(cutterEditorState.trimStart));
    const trimEndHandle = byId<HTMLElement>('cutterTrimEndHandle');
    trimEndHandle.setAttribute('role', 'slider');
    trimEndHandle.setAttribute('aria-valuemin', String(cutterEditorState.trimStart + 1 / cutterEditorState.fps));
    trimEndHandle.setAttribute('aria-valuemax', String(cutterEditorState.duration));
    trimEndHandle.setAttribute('aria-valuenow', String(cutterEditorState.trimEnd));
    trimEndHandle.setAttribute('aria-valuetext', formatCutterTimecode(cutterEditorState.trimEnd));
    byId('infoSelection').textContent = formatCutterTimecode(getCutterPlayableDuration());
    document.querySelectorAll<HTMLElement>('.cutter-cut-overlay[data-cut-id]').forEach((overlay) => {
        const cut = cutterEditorState!.cuts.find((entry) => entry.id === overlay.dataset.cutId);
        if (!cut) return;
        overlay.style.left = `${cut.start / cutterEditorState!.duration * 100}%`;
        overlay.style.width = `${(cut.end - cut.start) / cutterEditorState!.duration * 100}%`;
        overlay.classList.toggle('active', cut.id === cutterActiveCutId);
        const startHandle = overlay.querySelector<HTMLElement>('.cutter-cut-handle.start');
        const endHandle = overlay.querySelector<HTMLElement>('.cutter-cut-handle.end');
        startHandle?.setAttribute('aria-valuemax', String(cut.end - 1 / cutterEditorState!.fps));
        startHandle?.setAttribute('aria-valuenow', String(cut.start));
        startHandle?.setAttribute('aria-valuetext', formatCutterTimecode(cut.start));
        endHandle?.setAttribute('aria-valuemin', String(cut.start + 1 / cutterEditorState!.fps));
        endHandle?.setAttribute('aria-valuenow', String(cut.end));
        endHandle?.setAttribute('aria-valuetext', formatCutterTimecode(cut.end));
    });
    document.querySelectorAll<HTMLElement>('.cutter-cut-row[data-cut-id]').forEach((row) => {
        const cut = cutterEditorState!.cuts.find((entry) => entry.id === row.dataset.cutId);
        if (!cut) return;
        const inputs = row.querySelectorAll<HTMLInputElement>('input');
        if (inputs[0] && document.activeElement !== inputs[0]) inputs[0].value = formatCutterTimecode(cut.start);
        if (inputs[1] && document.activeElement !== inputs[1]) inputs[1].value = formatCutterTimecode(cut.end);
        const duration = row.querySelector<HTMLElement>('.cutter-cut-row-heading > span:last-child');
        if (duration) duration.textContent = formatCutterTimecode(cut.end - cut.start);
        row.classList.toggle('active', cut.id === cutterActiveCutId);
    });
}

function renderCutterEditor(): void {
    if (!cutterEditorState) return;
    renderCutterCutList();
    renderCutterCutOverlays();
    updateCutterEditorGeometry();
    updateCutterHistoryButtons();
}

function setCutterControlsEnabled(enabled: boolean): void {
    byId<HTMLButtonElement>('cutterPlayBtn').disabled = !enabled;
    byId<HTMLButtonElement>('cutterMuteBtn').disabled = !enabled;
    byId<HTMLButtonElement>('cutterFullscreenBtn').disabled = !enabled;
    byId<HTMLButtonElement>('cutterSettingsBtn').disabled = !enabled;
    byId<HTMLInputElement>('cutterVolume').disabled = !enabled;
    byId<HTMLSelectElement>('cutterPlaybackRate').disabled = !enabled;
    byId<HTMLInputElement>('cutterZoom').disabled = !enabled;
    byId<HTMLButtonElement>('cutterZoomInBtn').disabled = !enabled;
    byId<HTMLButtonElement>('cutterZoomOutBtn').disabled = !enabled;
    byId<HTMLButtonElement>('cutterNewCutBtn').disabled = !enabled;
    byId<HTMLButtonElement>('cutterSaveProjectBtn').disabled = !enabled;
    byId<HTMLButtonElement>('cutterOpenProjectBtn').disabled = !enabled;
    byId<HTMLSelectElement>('cutterExportProfile').disabled = !enabled;
    byId<HTMLSelectElement>('cutterExportEncoder').disabled = !enabled || cutterExportProfile === 'archive';
    byId<HTMLSelectElement>('cutterAudioStream').disabled = !enabled || (cutterVideoInfo?.audioStreams.length ?? 0) === 0;
    const volumeControl = document.querySelector<HTMLElement>('.cutter-volume-control');
    volumeControl?.classList.toggle('disabled', !enabled);
    volumeControl?.setAttribute('aria-disabled', String(!enabled));
    document.querySelectorAll<HTMLButtonElement>('[data-cutter-media-control]').forEach((button) => { button.disabled = !enabled; });
}

function animateCutterWorkspaceReveal(previousPreviewRect: DOMRect): void {
    const preview = byId('cutterPreview');
    const previewPanel = document.querySelector<HTMLElement>('.cutter-preview-panel');
    const sidebar = document.querySelector<HTMLElement>('.cutter-sidebar');
    const timeline = byId('timelineContainer');
    const info = byId('cutterInfo');
    if (!previewPanel || !sidebar) return;
    const nextPreviewRect = preview.getBoundingClientRect();
    const scaleX = previousPreviewRect.width / Math.max(1, nextPreviewRect.width);
    const scaleY = previousPreviewRect.height / Math.max(1, nextPreviewRect.height);
    const translateX = previousPreviewRect.left - nextPreviewRect.left;
    const translateY = previousPreviewRect.top - nextPreviewRect.top;
    [previewPanel, sidebar, timeline, info].forEach((element) => element.getAnimations().forEach((animation: Animation) => animation.cancel()));
    previewPanel.animate([
        { transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`, transformOrigin: 'top left' },
        { transform: 'translate(0, 0) scale(1, 1)', transformOrigin: 'top left' },
    ], { duration: 360, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    sidebar.animate([
        { opacity: 0, transform: 'translateX(-18px)' },
        { opacity: 1, transform: 'translateX(0)' },
    ], { duration: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    timeline.animate([
        { opacity: 0, transform: 'translateY(12px)' },
        { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    info.animate([
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
}

async function requestCutterAssets(): Promise<void> {
    if (!cutterFile || cutterMediaJobId === null || !byId('cutterTab').classList.contains('active')) return;
    const file = cutterFile;
    const jobId = cutterMediaJobId;
    const profile = getCutterAssetProfile();
    const requestedPixelWidth = getCutterAssetPixelWidth(profile);
    const requestedPixelHeight = getCutterAssetPixelHeight(profile);
    if (cutterAssetsPixelWidth >= requestedPixelWidth * 0.95 && cutterAssetsPixelHeight >= requestedPixelHeight) return;
    if (cutterAssetsInFlightJobId === jobId) {
        if (cutterAssetsInFlightPixelWidth >= requestedPixelWidth * 0.95 && cutterAssetsInFlightPixelHeight >= requestedPixelHeight) return;
        cutterAssetsRequestGeneration += 1;
        cutterAssetsInFlightJobId = null;
        cutterAssetsInFlightPixelWidth = 0;
        cutterAssetsInFlightPixelHeight = 0;
        await window.api.cancelVideoEditorAssets(jobId);
        if (cutterFile !== file || cutterMediaJobId !== jobId || !byId('cutterTab').classList.contains('active')) return;
    }
    const requestGeneration = ++cutterAssetsRequestGeneration;
    cutterAssetsInFlightJobId = jobId;
    cutterAssetsInFlightPixelWidth = requestedPixelWidth;
    cutterAssetsInFlightPixelHeight = requestedPixelHeight;
    let assets: VideoEditorAssets | null = null;
    try {
        assets = await window.api.prepareVideoEditorAssets(file.token, jobId, profile);
    } catch { }
    if (requestGeneration === cutterAssetsRequestGeneration && cutterAssetsInFlightJobId === jobId) {
        cutterAssetsInFlightJobId = null;
        cutterAssetsInFlightPixelWidth = 0;
        cutterAssetsInFlightPixelHeight = 0;
    }
    if (!assets || requestGeneration !== cutterAssetsRequestGeneration || assets.jobId !== jobId || cutterFile !== file || cutterMediaJobId !== jobId) return;
    const currentPixelWidth = getCutterAssetPixelWidth();
    const currentPixelHeight = getCutterAssetPixelHeight();
    if (assets.pixelWidth < currentPixelWidth * 0.95 || assets.pixelHeight < currentPixelHeight) {
        scheduleCutterAssetRefresh();
        return;
    }
    renderCutterThumbnails(assets.thumbnails, assets.thumbnailSprite, assets.thumbnailCount);
    cutterAssetsPixelWidth = assets.pixelWidth;
    cutterAssetsPixelHeight = assets.pixelHeight;
    if (getCutterAssetPixelWidth() > cutterAssetsPixelWidth * 1.05 || getCutterAssetPixelHeight() > cutterAssetsPixelHeight) scheduleCutterAssetRefresh();
}

async function requestCutterWaveform(file: FileCapabilityReference, jobId: number, loadGeneration: number): Promise<void> {
    let result: VideoEditorWaveform | null = null;
    try {
        result = await window.api.prepareVideoEditorWaveform(file.token, jobId);
    } catch { }
    if (loadGeneration !== cutterLoadGeneration || cutterFile !== file || cutterMediaJobId !== jobId || !result || result.jobId !== jobId) return;
    const waveform = byId<HTMLImageElement>('cutterWaveform');
    waveform.hidden = !result.waveform;
    if (result.waveform) {
        if (waveform.src !== result.waveform) waveform.src = result.waveform;
    } else {
        waveform.removeAttribute('src');
    }
    byId('cutterAudioEmpty').hidden = Boolean(result.waveform);
}

async function loadCutterFromPath(file: FileCapabilityReference): Promise<void> {
    if (!file || isCutting) return;
    const generation = ++cutterLoadGeneration;
    const video = getCutterVideo();
    const hadEditor = Boolean(cutterEditorState && cutterFile);
    video.pause();
    stopCutterPlaybackFrameSync();
    cancelCutterScrubFrames();
    byId('cutterPreview').classList.remove('playing', 'buffering');
    updateCutterPlayUi();
    byId('cutterPlayerLoading').hidden = false;
    if (!hadEditor) byId('cutterPreviewEmpty').hidden = true;
    byId('cutterWorkspace').classList.add('loading');
    setCutterControlsEnabled(false);
    byId<HTMLButtonElement>('btnCut').disabled = true;
    let media: VideoEditorMedia | null = null;
    try {
        media = await window.api.prepareVideoEditorMedia(file.token);
    } catch { }
    if (generation !== cutterLoadGeneration) return;
    byId('cutterPlayerLoading').hidden = true;
    byId('cutterWorkspace').classList.remove('loading');
    if (!media) {
        if (hadEditor) {
            setCutterControlsEnabled(true);
            byId<HTMLButtonElement>('btnCut').disabled = false;
            if (cutterFile && cutterMediaJobId !== null) void requestCutterWaveform(cutterFile, cutterMediaJobId, generation);
            void requestCutterAssets();
        } else {
            byId('cutterPreviewEmpty').hidden = false;
        }
        showAppToast(UI_TEXT.cutter.unsupportedFile, 'warn');
        return;
    }
    video.removeAttribute('src');
    video.load();
    cutterFile = file;
    cutterMediaJobId = media.jobId;
    cutterAssetsPixelWidth = 0;
    cutterAssetsPixelHeight = 0;
    cutterAssetsInFlightJobId = null;
    cutterAssetsInFlightPixelWidth = 0;
    cutterAssetsInFlightPixelHeight = 0;
    if (cutterAssetRefreshTimer !== null) {
        window.clearTimeout(cutterAssetRefreshTimer);
        cutterAssetRefreshTimer = null;
    }
    cutterVideoInfo = media.info;
    cutterEditorState = {
        duration: media.info.duration,
        fps: media.info.fps,
        trimStart: 0,
        trimEnd: media.info.duration,
        cuts: [],
    };
    cutterHistoryPast = [];
    cutterHistoryFuture = [];
    cutterActiveCutId = null;
    cutterExportProfile = 'balanced';
    cutterExportEncoder = 'software';
    cutterAudioStreamIndex = media.info.audioStreams[0]?.index ?? 0;
    cutterRecoveryDecisionPending = true;
    renderCutterProjectRecovery(null);
    updateCutterAudioStreams();
    cutterZoom = getInitialCutterZoom(media.info.duration);
    byId<HTMLInputElement>('cutterZoom').value = String(cutterZoom);
    byId<HTMLInputElement>('cutterFilePath').value = file.name;
    const previousPreviewRect = hadEditor ? null : byId('cutterPreview').getBoundingClientRect();
    byId('cutterWorkspace').classList.add('shown');
    byId('cutterInfo').classList.add('shown');
    byId('timelineContainer').classList.add('shown');
    if (previousPreviewRect) animateCutterWorkspaceReveal(previousPreviewRect);
    byId('infoDuration').textContent = formatCutterTimecode(media.info.duration);
    byId('infoResolution').textContent = `${media.info.width}×${media.info.height}`;
    byId('infoFps').textContent = media.info.fps.toFixed(media.info.fps % 1 === 0 ? 0 : 2);
    byId('cutterTotalTime').textContent = formatCutterTimecode(media.info.duration);
    renderCutterThumbnails(media.thumbnails);
    const waveform = byId<HTMLImageElement>('cutterWaveform');
    waveform.hidden = true;
    waveform.removeAttribute('src');
    byId('cutterAudioEmpty').hidden = media.info.hasAudio;
    video.src = media.sourceUrl;
    video.playbackRate = Number(byId<HTMLSelectElement>('cutterPlaybackRate').value);
    video.load();
    byId('cutterPreview').classList.remove('playing', 'buffering');
    updateCutterPlayUi();
    updateCutterZoom(cutterZoom);
    renderCutterEditor();
    updateCutterPlayhead(0);
    void (async () => {
        let project: CutterProject | null = null;
        try { project = await window.api.getCutterProjectRecovery(file.token); } catch { }
        if (generation !== cutterLoadGeneration || cutterFile !== file) return;
        cutterRecoveryDecisionPending = Boolean(project);
        renderCutterProjectRecovery(project);
        setCutterControlsEnabled(true);
        byId<HTMLButtonElement>('btnCut').disabled = false;
        void loadCutterExportOptions(file, generation);
    })();
    void requestCutterWaveform(file, media.jobId, generation);
    void requestCutterAssets();
}

function resolveCutterDiscard(discard: boolean): void {
    RendererAccessibility.closeDialog('cutterDiscardModal');
    const resolver = cutterDiscardResolver;
    cutterDiscardResolver = null;
    resolver?.(discard);
}

function handleCutterDiscardOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) resolveCutterDiscard(false);
}

function trapCutterDiscardFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const buttons = [byId<HTMLButtonElement>('cutterDiscardCancelBtn'), byId<HTMLButtonElement>('cutterDiscardConfirmBtn')];
    const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        buttons[buttons.length - 1].focus();
    } else if (!event.shiftKey && activeIndex === buttons.length - 1) {
        event.preventDefault();
        buttons[0].focus();
    }
}

function confirmCutterReplacement(file: FileCapabilityReference): Promise<boolean> {
    if (!cutterFile || !cutterEditorState || cutterFile.token === file.token) return Promise.resolve(true);
    if (cutterDiscardResolver) resolveCutterDiscard(false);
    RendererAccessibility.openDialog('cutterDiscardModal', {
        initialFocus: byId<HTMLButtonElement>('cutterDiscardCancelBtn'),
        onEscape: () => resolveCutterDiscard(false)
    });
    return new Promise((resolve) => { cutterDiscardResolver = resolve; });
}

async function requestCutterVideoReplacement(file: FileCapabilityReference): Promise<void> {
    if (!file || isCutting) return;
    if (!await confirmCutterReplacement(file)) return;
    if (cutterEditorState && !cutterRecoveryDecisionPending && !await persistCutterProject(false)) {
        showAppToast('Projekt konnte nicht gespeichert werden', 'warn');
        return;
    }
    await loadCutterFromPath(file);
}

async function selectCutterVideo(): Promise<void> {
    const file = await window.api.selectVideoFile();
    if (file) await requestCutterVideoReplacement(file);
}

function updateTimeFromInput(): void {
    if (!cutterEditorState) return;
    const start = parseCutterTimecode(byId<HTMLInputElement>('startTime').value);
    const end = parseCutterTimecode(byId<HTMLInputElement>('endTime').value);
    const before = cloneCutterState(cutterEditorState);
    if (start === null || end === null || !setCutterTrim(start, end)) {
        showAppToast(UI_TEXT.cutter.invalidRange, 'warn');
        renderCutterEditor();
        return;
    }
    commitCutterChange(before);
    seekCutterVideo(cutterEditorState.trimStart);
    renderCutterEditor();
}

function addCutterCut(): void {
    if (!cutterEditorState) return;
    if (cutterEditorState.cuts.length >= cutterMaximumCuts) {
        showAppToast(UI_TEXT.cutter.invalidRange, 'warn');
        return;
    }
    const video = getCutterVideo();
    const playhead = clampCutterValue(video.currentTime || cutterEditorState.trimStart, cutterEditorState.trimStart, cutterEditorState.trimEnd);
    const occupied = [...cutterEditorState.cuts].sort((left, right) => left.start - right.start);
    const gaps: Array<{ start: number; end: number }> = [];
    let cursor = cutterEditorState.trimStart;
    for (const cut of occupied) {
        if (cut.start > cursor) gaps.push({ start: cursor, end: cut.start });
        cursor = Math.max(cursor, cut.end);
    }
    if (cursor < cutterEditorState.trimEnd) gaps.push({ start: cursor, end: cutterEditorState.trimEnd });
    const frame = 1 / cutterEditorState.fps;
    const gap = gaps.find((entry) => playhead >= entry.start && playhead < entry.end)
        || gaps.find((entry) => entry.end - entry.start >= frame);
    if (!gap) return;
    let start = clampCutterValue(playhead, gap.start, gap.end - frame);
    let end = Math.min(gap.end, start + 5);
    if (end - start < frame) {
        end = gap.end;
        start = Math.max(gap.start, end - Math.min(5, gap.end - gap.start));
    }
    start = snapCutterTime(start);
    end = snapCutterTime(end);
    const before = cloneCutterState(cutterEditorState);
    const id = `cut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cuts = [...cutterEditorState.cuts, { id, start, end }].sort((left, right) => left.start - right.start);
    if (!cutterHasPlayableFrame(cuts)) {
        showAppToast(UI_TEXT.cutter.invalidRange, 'warn');
        return;
    }
    cutterEditorState = { ...cutterEditorState, cuts };
    cutterActiveCutId = id;
    commitCutterChange(before);
    seekCutterVideo(start);
    renderCutterEditor();
}

function removeCutterCut(id: string): void {
    if (!cutterEditorState || !cutterEditorState.cuts.some((cut) => cut.id === id)) return;
    const before = cloneCutterState(cutterEditorState);
    cutterEditorState = { ...cutterEditorState, cuts: cutterEditorState.cuts.filter((cut) => cut.id !== id) };
    if (cutterActiveCutId === id) cutterActiveCutId = null;
    commitCutterChange(before);
    renderCutterEditor();
}

function undoCutterEdit(): void {
    if (!cutterEditorState) return;
    const previous = cutterHistoryPast.pop();
    if (!previous) return;
    cutterHistoryFuture.unshift(cloneCutterState(cutterEditorState));
    cutterEditorState = cloneCutterState(previous);
    cutterActiveCutId = null;
    seekCutterVideo(cutterEditorState.trimStart);
    renderCutterEditor();
    scheduleCutterAutosave();
}

function redoCutterEdit(): void {
    if (!cutterEditorState) return;
    const next = cutterHistoryFuture.shift();
    if (!next) return;
    cutterHistoryPast.push(cloneCutterState(cutterEditorState));
    cutterEditorState = cloneCutterState(next);
    cutterActiveCutId = null;
    seekCutterVideo(cutterEditorState.trimStart);
    renderCutterEditor();
    scheduleCutterAutosave();
}

function setCutterPreviewMode(enabled: boolean): void {
    cutterPreviewMode = enabled;
    const video = getCutterVideo();
    if (enabled && cutterEditorState) seekCutterVideo(video.currentTime, true);
}

async function toggleCutterPlayback(): Promise<void> {
    if (!cutterEditorState) return;
    const video = getCutterVideo();
    if (!video.paused) {
        video.pause();
        return;
    }
    if (video.currentTime < cutterEditorState.trimStart || video.currentTime >= cutterEditorState.trimEnd) {
        video.currentTime = cutterEditorState.trimStart;
    }
    video.currentTime = findCutterPreviewTime(video.currentTime);
    try { await video.play(); } catch { }
}

function stopCutterPlayback(): void {
    if (!cutterEditorState) return;
    const video = getCutterVideo();
    video.pause();
    seekCutterVideo(cutterEditorState.trimStart);
}

function skipCutterPlayback(seconds: number): void {
    if (!cutterEditorState) return;
    seekCutterVideo(getCutterVideo().currentTime + seconds, true);
}

function toggleCutterMute(): void {
    const video = getCutterVideo();
    video.muted = !video.muted;
    updateCutterMuteUi();
}

function toggleCutterSettingsMenu(): void {
    const menu = byId<HTMLElement>('cutterSettingsMenu');
    const button = byId<HTMLButtonElement>('cutterSettingsBtn');
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>('button.active')?.focus());
}

function closeCutterSettingsMenu(returnFocus = false): void {
    const menu = byId<HTMLElement>('cutterSettingsMenu');
    if (menu.hidden) return;
    menu.hidden = true;
    const button = byId<HTMLButtonElement>('cutterSettingsBtn');
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
}

function updateCutterMuteUi(): void {
    const video = getCutterVideo();
    const button = byId<HTMLButtonElement>('cutterMuteBtn');
    button.classList.toggle('muted', video.muted);
    button.setAttribute('aria-label', video.muted ? UI_TEXT.cutter.unmute : UI_TEXT.cutter.mute);
    button.setAttribute('aria-pressed', String(video.muted));
}

function updateCutterVolumeTrack(): void {
    const input = byId<HTMLInputElement>('cutterVolume');
    input.style.setProperty('--cutter-volume-progress', `${Number(input.value) * 100}%`);
}

function updateCutterPlayUi(): void {
    const playing = !getCutterVideo().paused;
    byId<HTMLButtonElement>('cutterPlayBtn').setAttribute('aria-label', playing ? UI_TEXT.cutter.pause : UI_TEXT.cutter.play);
}

function setCutterPlaybackRate(rate: number): void {
    const safeRate = [0.5, 0.75, 1, 1.25, 1.5, 2].includes(rate) ? rate : 1;
    const select = byId<HTMLSelectElement>('cutterPlaybackRate');
    select.value = String(safeRate);
    getCutterVideo().playbackRate = safeRate;
    document.querySelectorAll<HTMLButtonElement>('.cutter-speed-options button').forEach((button) => {
        const active = Number(button.dataset.rate) === safeRate;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    closeCutterSettingsMenu(true);
}

async function toggleCutterFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
    }
    await byId('cutterPreview').requestFullscreen();
}

function getCutterMaximumZoom(): number {
    const scroll = byId<HTMLElement>('cutterTimelineScroll');
    const pixelRatio = clampCutterValue(window.devicePixelRatio || 1, 1, 3);
    const viewportWidth = Math.max(1, scroll.clientWidth);
    const maximum = clampCutterValue(32000 / (viewportWidth * pixelRatio), 4, 16);
    return Number((Math.floor(maximum * 20) / 20).toFixed(2));
}

function updateCutterZoom(value: number, animate = false, anchorClientX: number | null = null): void {
    if (!cutterEditorState) return;
    const scroll = byId<HTMLElement>('cutterTimelineScroll');
    const timeline = byId<HTMLElement>('timeline');
    const playheadPercent = clampCutterValue(getCutterVideo().currentTime / cutterEditorState.duration, 0, 1);
    const scrollRect = scroll.getBoundingClientRect();
    const localAnchorX = anchorClientX === null
        ? scroll.clientWidth / 2
        : clampCutterValue(anchorClientX - scrollRect.left, 0, scroll.clientWidth);
    const currentWidth = Math.max(1, timeline.scrollWidth);
    const anchorRatio = anchorClientX === null
        ? playheadPercent
        : clampCutterValue((scroll.scrollLeft + localAnchorX) / currentWidth, 0, 1);
    const maximumZoom = getCutterMaximumZoom();
    cutterZoom = Number(clampCutterValue(value, 1, maximumZoom).toFixed(3));
    const zoomInput = byId<HTMLInputElement>('cutterZoom');
    zoomInput.max = String(maximumZoom);
    zoomInput.value = String(cutterZoom);
    timeline.style.width = `${cutterZoom * 100}%`;
    renderCutterRuler();
    scheduleCutterThumbnailSpriteRender();
    drawCutterThumbnailImages(scroll.clientWidth * cutterZoom);
    const target = clampCutterValue(anchorRatio * timeline.scrollWidth - localAnchorX, 0, Math.max(0, timeline.scrollWidth - scroll.clientWidth));
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        scroll.scrollTo({ left: target, behavior: 'smooth' });
    } else {
        scroll.scrollLeft = target;
    }
    if ((cutterVideoInfo?.duration || 0) > 120 && (cutterAssetsPixelWidth > 0 || cutterAssetsInFlightJobId !== null)) scheduleCutterAssetRefresh();
}

function changeCutterZoom(delta: number): void {
    updateCutterZoom(cutterZoom + delta, true);
}

function applyCutterWheelZoom(): void {
    cutterWheelZoomFrame = null;
    if (!cutterEditorState || cutterWheelZoomDeltaPixels === 0) return;
    const boundedDelta = clampCutterValue(cutterWheelZoomDeltaPixels, -240, 240);
    cutterWheelZoomDeltaPixels = 0;
    const factor = Math.exp(-boundedDelta * 0.0018);
    const direction = boundedDelta < 0 ? 1 : -1;
    const nextZoom = Math.abs(cutterZoom * factor - cutterZoom) < 0.05
        ? cutterZoom + direction * 0.05
        : cutterZoom * factor;
    updateCutterZoom(nextZoom, false, cutterWheelZoomAnchorX);
}

function zoomCutterTimelineWithWheel(event: WheelEvent): void {
    if (!cutterEditorState || event.deltaY === 0) return;
    event.preventDefault();
    const deltaPixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * byId<HTMLElement>('cutterTimelineScroll').clientHeight
            : event.deltaY;
    cutterWheelZoomDeltaPixels += deltaPixels;
    cutterWheelZoomAnchorX = event.clientX;
    if (cutterWheelZoomFrame === null) cutterWheelZoomFrame = requestAnimationFrame(applyCutterWheelZoom);
}

function cutterPointerRawTimeAt(clientX: number): number {
    if (!cutterEditorState) return 0;
    const rect = byId<HTMLElement>('timeline').getBoundingClientRect();
    const percent = clampCutterValue((clientX - rect.left) / rect.width, 0, 1);
    return percent * cutterEditorState.duration;
}

function cutterPointerTimeAt(clientX: number): number {
    return snapCutterTime(cutterPointerRawTimeAt(clientX));
}

function autoScrollCutterDrag(clientX: number): boolean {
    if (cutterZoom <= 1) return false;
    const scroll = byId<HTMLElement>('cutterTimelineScroll');
    const rect = scroll.getBoundingClientRect();
    const threshold = Math.min(64, rect.width * 0.12);
    const maximum = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    const before = scroll.scrollLeft;
    if (clientX < rect.left + threshold) {
        const strength = clampCutterValue((rect.left + threshold - clientX) / threshold, 0, 1);
        scroll.scrollLeft = Math.max(0, before - Math.max(4, 24 * strength));
    } else if (clientX > rect.right - threshold) {
        const strength = clampCutterValue((clientX - (rect.right - threshold)) / threshold, 0, 1);
        scroll.scrollLeft = Math.min(maximum, before + Math.max(4, 24 * strength));
    }
    return scroll.scrollLeft !== before;
}

function handleCutterBoundaryKey(event: KeyboardEvent, kind: Exclude<CutterDragKind, 'playhead'>, cutId: string | null = null): void {
    if (!cutterEditorState || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    event.stopPropagation();
    const before = cloneCutterState(cutterEditorState);
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const step = (event.shiftKey ? 10 : 1) / cutterEditorState.fps * direction;
    let changed = false;
    if (kind === 'trim-start') changed = setCutterTrim(cutterEditorState.trimStart + step, cutterEditorState.trimEnd);
    if (kind === 'trim-end') changed = setCutterTrim(cutterEditorState.trimStart, cutterEditorState.trimEnd + step);
    const cut = cutId ? cutterEditorState.cuts.find((entry) => entry.id === cutId) : null;
    if (cut && kind === 'cut-start') changed = setCutterCutRange(cut.id, cut.start + step, cut.end);
    if (cut && kind === 'cut-end') changed = setCutterCutRange(cut.id, cut.start, cut.end + step);
    if (cut && kind === 'cut-move') {
        const duration = cut.end - cut.start;
        const start = clampCutterValue(cut.start + step, cutterEditorState.trimStart, cutterEditorState.trimEnd - duration);
        changed = setCutterCutRange(cut.id, start, start + duration);
    }
    if (!changed) return;
    commitCutterChange(before);
    const nextCut = cutId ? cutterEditorState.cuts.find((entry) => entry.id === cutId) : null;
    const seekTime = kind === 'trim-start'
        ? cutterEditorState.trimStart
        : kind === 'trim-end'
            ? cutterEditorState.trimEnd
            : nextCut?.start ?? cutterEditorState.trimStart;
    seekCutterVideo(seekTime);
    renderCutterEditor();
    requestAnimationFrame(() => {
        if (!cutId) {
            byId<HTMLElement>(kind === 'trim-start' ? 'cutterTrimStartHandle' : 'cutterTrimEndHandle').focus();
            return;
        }
        const overlay = document.querySelector<HTMLElement>(`.cutter-cut-overlay[data-cut-id="${CSS.escape(cutId)}"]`);
        if (kind === 'cut-start') overlay?.querySelector<HTMLElement>('.cutter-cut-handle.start')?.focus();
        else if (kind === 'cut-end') overlay?.querySelector<HTMLElement>('.cutter-cut-handle.end')?.focus();
        else overlay?.focus();
    });
}

function beginCutterDrag(kind: CutterDragKind, event: PointerEvent, cutId: string | null = null): void {
    if (!cutterEditorState || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const cut = cutId ? cutterEditorState.cuts.find((entry) => entry.id === cutId) : null;
    const pointerTime = kind === 'playhead' ? cutterPointerTimeAt(event.clientX) : cutterPointerRawTimeAt(event.clientX);
    const anchorTarget = kind === 'trim-start'
        ? cutterEditorState.trimStart
        : kind === 'trim-end'
            ? cutterEditorState.trimEnd
            : kind === 'cut-start' || kind === 'cut-move'
                ? cut?.start
                : kind === 'cut-end'
                    ? cut?.end
                    : null;
    const captureTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : byId<HTMLElement>('timeline');
    try { captureTarget.setPointerCapture(event.pointerId); } catch { }
    cutterDragState = {
        kind,
        cutId,
        before: cloneCutterState(cutterEditorState),
        anchor: anchorTarget === null || anchorTarget === undefined ? 0 : pointerTime - anchorTarget,
        pointerId: event.pointerId,
        captureTarget,
        activeCutId: cutterActiveCutId,
    };
    document.body.classList.add('cutter-dragging');
    if (cutId) cutterActiveCutId = cutId;
    const video = getCutterVideo();
    cancelCutterScrubFrames();
    cutterScrubResumePlayback = !video.paused;
    if (!video.paused) video.pause();
    else stopCutterPlaybackFrameSync();
    if (kind === 'playhead') {
        updateCutterInteractionPlayhead(pointerTime);
        queueCutterScrubFrame(pointerTime);
    }
}

function applyCutterDragFrame(): void {
    cutterDragAnimationFrame = null;
    if (!cutterDragState || !cutterEditorState || cutterDragPointerX === null) return;
    const autoScrolled = autoScrollCutterDrag(cutterDragPointerX);
    const drag = cutterDragState;
    const time = drag.kind === 'playhead' ? cutterPointerTimeAt(cutterDragPointerX) : cutterPointerRawTimeAt(cutterDragPointerX);
    if (drag.kind === 'playhead') {
        updateCutterInteractionPlayhead(time);
        queueCutterScrubFrame(time);
        return;
    }
    cutterEditorState = cloneCutterState(drag.before);
    cutterActiveCutId = drag.activeCutId;
    if (drag.cutId) cutterActiveCutId = drag.cutId;
    const anchoredTime = time - drag.anchor;
    let previewTime: number | null = null;
    if (drag.kind === 'trim-start') {
        if (setCutterTrim(anchoredTime, cutterEditorState.trimEnd)) previewTime = cutterEditorState.trimStart;
    } else if (drag.kind === 'trim-end') {
        if (setCutterTrim(cutterEditorState.trimStart, anchoredTime)) previewTime = cutterEditorState.trimEnd;
    } else if (drag.cutId) {
        const cut = cutterEditorState.cuts.find((entry) => entry.id === drag.cutId);
        if (!cut) return;
        const orderedCuts = [...drag.before.cuts].sort((left, right) => left.start - right.start);
        const originalIndex = orderedCuts.findIndex((entry) => entry.id === drag.cutId);
        const previousEnd = originalIndex > 0 ? orderedCuts[originalIndex - 1].end : cutterEditorState.trimStart;
        const nextStart = originalIndex >= 0 && originalIndex < orderedCuts.length - 1 ? orderedCuts[originalIndex + 1].start : cutterEditorState.trimEnd;
        if (drag.kind === 'cut-start') {
            const start = clampCutterValue(anchoredTime, previousEnd, cut.end - 1 / cutterEditorState.fps);
            if (setCutterCutRange(cut.id, start, cut.end)) previewTime = start;
        }
        if (drag.kind === 'cut-end') {
            const end = clampCutterValue(anchoredTime, cut.start + 1 / cutterEditorState.fps, nextStart);
            if (setCutterCutRange(cut.id, cut.start, end)) previewTime = end;
        }
        if (drag.kind === 'cut-move') {
            const original = drag.before.cuts.find((entry) => entry.id === drag.cutId);
            if (original) {
                const duration = original.end - original.start;
                const start = clampCutterValue(anchoredTime, previousEnd, nextStart - duration);
                if (setCutterCutRange(cut.id, start, start + duration)) previewTime = start;
            }
        }
    }
    updateCutterEditorGeometry();
    if (previewTime !== null) queueCutterScrubFrame(previewTime);
    if (autoScrolled && cutterDragState && cutterDragAnimationFrame === null) cutterDragAnimationFrame = requestAnimationFrame(applyCutterDragFrame);
}

function moveCutterDrag(event: PointerEvent): void {
    if (!cutterDragState || !cutterEditorState || event.pointerId !== cutterDragState.pointerId) return;
    event.preventDefault();
    cutterDragPointerX = event.clientX;
    if (cutterDragState.kind === 'playhead') updateCutterInteractionPlayhead(cutterPointerTimeAt(event.clientX));
    if (cutterDragAnimationFrame === null) cutterDragAnimationFrame = requestAnimationFrame(applyCutterDragFrame);
}

function endCutterDrag(event?: PointerEvent): void {
    if (!cutterDragState || !cutterEditorState || (event && event.pointerId !== cutterDragState.pointerId)) return;
    if (cutterDragAnimationFrame !== null) {
        cancelAnimationFrame(cutterDragAnimationFrame);
        cutterDragAnimationFrame = null;
        applyCutterDragFrame();
    }
    const drag = cutterDragState;
    cutterDragState = null;
    cutterDragPointerX = null;
    document.body.classList.remove('cutter-dragging');
    try {
        if (drag.captureTarget.hasPointerCapture(drag.pointerId)) drag.captureTarget.releasePointerCapture(drag.pointerId);
    } catch { }
    if (drag.kind !== 'playhead') commitCutterChange(drag.before);
    renderCutterEditor();
    finishCutterScrubPlayback();
}

async function startCutting(): Promise<void> {
    if (!cutterFile || !cutterEditorState || isCutting) return;
    isCutting = true;
    const button = byId<HTMLButtonElement>('btnCut');
    const cancel = byId<HTMLButtonElement>('cutterCancelExportBtn');
    button.disabled = true;
    button.textContent = UI_TEXT.cutter.cutting;
    cancel.hidden = false;
    byId('cutProgress').classList.add('show');
    try {
        const result = await window.api.exportVideoEdit({
            inputCapability: cutterFile.token,
            trimStart: cutterEditorState.trimStart,
            trimEnd: cutterEditorState.trimEnd,
            cuts: cutterEditorState.cuts.map((cut) => ({ ...cut })),
            profile: cutterExportProfile,
            encoder: cutterExportEncoder,
            audioStreamIndex: cutterAudioStreamIndex,
        });
        if (result.success) {
            showAppToast(UI_TEXT.cutter.exportSuccess, 'info');
            if (result.outputCapability) await window.api.showInFolder(result.outputCapability);
        } else if (!result.cancelled) {
            showAppToast(UI_TEXT.cutter.exportFailed, 'warn');
        }
    } catch {
        showAppToast(UI_TEXT.cutter.exportFailed, 'warn');
    } finally {
        isCutting = false;
        button.disabled = false;
        button.textContent = UI_TEXT.cutter.export;
        cancel.hidden = true;
        byId('cutProgress').classList.remove('show');
    }
}

async function cancelCutterExport(): Promise<void> {
    await window.api.cancelVideoEdit();
}

function stopCutterPlaybackFrameSync(): void {
    if (cutterPlaybackFrame === null) return;
    const video = getCutterVideo() as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void };
    if (cutterPlaybackUsesVideoCallback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(cutterPlaybackFrame);
    else cancelAnimationFrame(cutterPlaybackFrame);
    cutterPlaybackFrame = null;
}

function synchronizeCutterPlaybackFrame(): void {
    cutterPlaybackFrame = null;
    if (!cutterEditorState) return;
    if (cutterDragState) {
        if (!getCutterVideo().paused) scheduleCutterPlaybackFrameSync();
        return;
    }
    const video = getCutterVideo();
    const time = video.currentTime;
    if (!video.paused && cutterPreviewMode) {
        const skipped = findCutterPreviewTime(time, cutterPreviousPlaybackTime);
        if (skipped > time + 1 / cutterEditorState.fps / 2) {
            video.currentTime = skipped;
            cutterPreviousPlaybackTime = skipped;
            updateCutterPlayhead(skipped);
            scheduleCutterPlaybackFrameSync();
            return;
        }
    }
    cutterPreviousPlaybackTime = time;
    if (!video.paused && time >= cutterEditorState.trimEnd) {
        video.pause();
        video.currentTime = cutterEditorState.trimEnd;
        updateCutterPlayhead(cutterEditorState.trimEnd);
        return;
    }
    updateCutterPlayhead(time);
    if (!video.paused) scheduleCutterPlaybackFrameSync();
}

function deactivateCutterEditor(): void {
    const video = getCutterVideo();
    if (!video.paused) video.pause();
    stopCutterPlaybackFrameSync();
    cancelCutterScrubFrames();
    closeCutterSettingsMenu();
    cutterAssetsRequestGeneration += 1;
    if (cutterAssetRefreshTimer !== null) {
        window.clearTimeout(cutterAssetRefreshTimer);
        cutterAssetRefreshTimer = null;
    }
    if (cutterWheelZoomFrame !== null) {
        cancelAnimationFrame(cutterWheelZoomFrame);
        cutterWheelZoomFrame = null;
    }
    cutterWheelZoomDeltaPixels = 0;
    cutterAssetsInFlightJobId = null;
    cutterAssetsInFlightPixelWidth = 0;
    cutterAssetsInFlightPixelHeight = 0;
    if (cutterMediaJobId !== null) void window.api.cancelVideoEditorAssets(cutterMediaJobId);
}

function activateCutterEditor(): void {
    void requestCutterAssets();
}

function scheduleCutterPlaybackFrameSync(): void {
    if (cutterPlaybackFrame !== null) return;
    const video = getCutterVideo() as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (video.requestVideoFrameCallback) {
        cutterPlaybackUsesVideoCallback = true;
        cutterPlaybackFrame = video.requestVideoFrameCallback(synchronizeCutterPlaybackFrame);
    } else {
        cutterPlaybackUsesVideoCallback = false;
        cutterPlaybackFrame = requestAnimationFrame(synchronizeCutterPlaybackFrame);
    }
}

function initCutterEditor(): void {
    if (cutterEditorInitialized) return;
    cutterEditorInitialized = true;
    const video = getCutterVideo();
    setCutterControlsEnabled(Boolean(cutterEditorState));
    updateCutterPlayUi();
    updateCutterMuteUi();
    updateCutterVolumeTrack();
    document.querySelectorAll<HTMLButtonElement>('.cutter-speed-options button').forEach((button) => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.rate) === 1));
    });
    video.addEventListener('click', () => { void toggleCutterPlayback(); });
    video.addEventListener('play', () => {
        byId('cutterPreview').classList.add('playing');
        cutterPreviousPlaybackTime = video.currentTime;
        updateCutterPlayUi();
        scheduleCutterPlaybackFrameSync();
    });
    video.addEventListener('pause', () => {
        byId('cutterPreview').classList.remove('playing');
        stopCutterPlaybackFrameSync();
        updateCutterPlayUi();
        if (cutterEditorState && !cutterDragState && !cutterScrubSeekInFlight && cutterScrubTargetTime === null) updateCutterPlayhead(video.currentTime);
    });
    video.addEventListener('waiting', () => byId('cutterPreview').classList.add('buffering'));
    video.addEventListener('playing', () => byId('cutterPreview').classList.remove('buffering'));
    video.addEventListener('timeupdate', () => {
        if (video.paused && cutterEditorState && !cutterDragState && !cutterScrubSeekInFlight && cutterScrubTargetTime === null) updateCutterPlayhead(video.currentTime);
    });
    byId<HTMLInputElement>('cutterVolume').addEventListener('input', (event) => {
        const input = event.currentTarget as HTMLInputElement;
        video.volume = Number(input.value);
        video.muted = video.volume === 0;
        updateCutterMuteUi();
        updateCutterVolumeTrack();
    });
    document.querySelector<HTMLElement>('.cutter-volume-control')?.addEventListener('pointerleave', () => {
        const volume = byId<HTMLInputElement>('cutterVolume');
        if (document.activeElement === volume) volume.blur();
    });
    window.addEventListener('resize', () => {
        if (!cutterEditorState || !byId('cutterTab').classList.contains('active')) return;
        updateCutterZoom(cutterZoom);
    });
    byId<HTMLSelectElement>('cutterPlaybackRate').addEventListener('change', (event) => {
        video.playbackRate = Number((event.currentTarget as HTMLSelectElement).value);
    });
    document.addEventListener('pointerdown', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.cutter-player-settings')) return;
        const menu = byId<HTMLElement>('cutterSettingsMenu');
        if (!menu.hidden) {
            closeCutterSettingsMenu();
        }
    });
    byId<HTMLInputElement>('cutterZoom').addEventListener('input', (event) => updateCutterZoom(Number((event.currentTarget as HTMLInputElement).value)));
    byId('cutterTimelineScroll').addEventListener('wheel', zoomCutterTimelineWithWheel, { passive: false });
    byId<HTMLInputElement>('startTime').addEventListener('keydown', (event) => { if (event.key === 'Enter') updateTimeFromInput(); });
    byId<HTMLInputElement>('endTime').addEventListener('keydown', (event) => { if (event.key === 'Enter') updateTimeFromInput(); });
    byId('timeline').addEventListener('pointerdown', (event: PointerEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest('.timeline-handle, .cutter-cut-overlay')) return;
        beginCutterDrag('playhead', event);
    });
    byId('cutterTrimStartHandle').addEventListener('pointerdown', (event: PointerEvent) => beginCutterDrag('trim-start', event));
    byId('cutterTrimEndHandle').addEventListener('pointerdown', (event: PointerEvent) => beginCutterDrag('trim-end', event));
    byId('cutterTrimStartHandle').addEventListener('keydown', (event: KeyboardEvent) => handleCutterBoundaryKey(event, 'trim-start'));
    byId('cutterTrimEndHandle').addEventListener('keydown', (event: KeyboardEvent) => handleCutterBoundaryKey(event, 'trim-end'));
    document.addEventListener('pointermove', moveCutterDrag);
    document.addEventListener('pointerup', endCutterDrag);
    document.addEventListener('pointercancel', endCutterDrag);
    document.addEventListener('keydown', (event) => {
        if (!byId('cutterTab').classList.contains('active') || !cutterEditorState) return;
        const target = event.target as HTMLElement;
        if (target.matches('input:not([type="range"]):not([type="checkbox"]), textarea, [contenteditable="true"]')) return;
        const shortcutModifier = event.ctrlKey || event.metaKey;
        if (shortcutModifier && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey) redoCutterEdit();
            else undoCutterEdit();
            return;
        }
        if (shortcutModifier && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            redoCutterEdit();
            return;
        }
        if (event.key === 'Escape' && !byId<HTMLElement>('cutterSettingsMenu').hidden) {
            event.preventDefault();
            closeCutterSettingsMenu(true);
            return;
        }
        if (target.closest('button, a, input, textarea, select, [role="button"], [role="group"], [role="slider"], [contenteditable="true"]')) return;
        if (event.key === ' ') {
            event.preventDefault();
            void toggleCutterPlayback();
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            seekCutterVideo(getCutterVideo().currentTime + direction / cutterEditorState.fps);
        }
    });
}
