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

type CutterDragKind = 'playhead' | 'cut-move';

interface CutterDragState {
    kind: CutterDragKind;
    cutId: string | null;
    before: CutterEditorState;
    anchor: number;
    pointerId: number;
    captureTarget: HTMLElement;
    activeCutId: string | null;
    startY: number;
    fineAnchor: { x: number; time: number } | null;
}

let cutterEditorState: CutterEditorState | null = null;
let cutterHistoryPast: CutterEditorState[] = [];
let cutterHistoryFuture: CutterEditorState[] = [];
let cutterActiveCutId: string | null = null;
let cutterCutDraft: { before: CutterEditorState; id: string } | null = null;
let cutterMode: 'trim' | 'omit' = 'trim';
let cutterControlsEnabled = false;
let cutterViewActive = true;
let cutterPlayerView: ReturnType<Window['LocalCutterPlayer']['mount']> | null = null;
let cutterPreviewMode = true;
let cutterDragState: CutterDragState | null = null;
let cutterRangeDrag: { before: CutterEditorState; cutId: string | null; generation: number; playing: boolean } | null = null;
let cutterDragPointerX: number | null = null;
let cutterDragFineTime: number | null = null;
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
let cutterWaveformPeaks: Uint8Array[] = [];
let cutterWaveformCompletedBins = 0;
let cutterWaveformStatus: 'none' | 'loading' | 'complete' | 'failed' = 'none';
let cutterWaveformImage: HTMLImageElement | null = null;
let cutterWaveformRenderFrame: number | null = null;
let cutterEditorInitialized = false;
let cutterPlaybackFrame: number | null = null;
let cutterPlaybackUsesVideoCallback = false;
let cutterPreviousPlaybackTime: number | null = null;
let cutterPresentedTime: number | null = null;
let cutterPendingSeekTime: number | null = null;
let cutterPendingSeekRetries = 0;
let cutterWheelZoomFrame: number | null = null;
let cutterWheelZoomDeltaPixels = 0;
let cutterWheelZoomAnchorX = 0;
let cutterScrubTargetTime: number | null = null;
let cutterScrubFrameRequest: number | null = null;
let cutterScrubSeekInFlight = false;
let cutterScrubResumePlayback = false;
let cutterScrubGeneration = 0;
let cutterScrubCleanup: (() => void) | null = null;
let cutterDiscardResolver: ((discard: boolean) => void) | null = null;
let cutterExportProfile: 'quality' | 'balanced' | 'fast' | 'archive' = 'balanced';
let cutterExportEncoder: 'software' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' = 'software';
let cutterAudioStreamIndex = 0;
let cutterAllAudioStreams = true;
let cutterAudioProcessing = { fadeInSeconds: 0, fadeOutSeconds: 0, normalize: false };
let cutterColorMode: 'source' | 'sdr' = 'source';
let cutterPendingProject: CutterProject | null = null;
let cutterAutosaveTimer: number | null = null;
let cutterExportOptions: CutterExportOptions | null | undefined;
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

function getInitialCutterZoom(_duration: number): number {
    return 1;
}

function formatCutterTimecode(time: number): string {
    const fps = cutterEditorState?.fps || cutterVideoInfo?.fps || 30;
    const frameBase = Math.max(1, Math.round(fps));
    const totalFrames = Math.round(Math.max(0, time) * fps);
    const seconds = Math.floor(totalFrames / frameBase);
    const frames = totalFrames % frameBase;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return [hours, minutes, remainingSeconds, frames].map((field) => String(field).padStart(2, '0')).join(':');
}

function parseCutterTimecode(value: string): number | null {
    if (!cutterEditorState) return null;
    const raw = value.trim().split(':');
    if (raw.some(field => !/^\d+$/.test(field))) return null;
    const fields = raw.map(Number);
    if ((fields.length !== 3 && fields.length !== 4) || fields.some((field) => !Number.isInteger(field) || field < 0)) return null;
    const [hours, minutes, seconds, frames] = fields.length === 4
        ? fields
        : [fields[0], fields[1], fields[2], 0];
    if (minutes >= 60 || seconds >= 60 || frames >= Math.max(1, Math.round(cutterEditorState.fps))) return null;
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    return fields.length === 3 ? snapCutterTime(totalSeconds)
        : snapCutterTime((totalSeconds * Math.max(1, Math.round(cutterEditorState.fps)) + frames) / cutterEditorState.fps);
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
    if (!cutterEditorState || !validCutterAudioDuration()) return null;
    return {
        trimStart: cutterEditorState.trimStart,
        trimEnd: cutterEditorState.trimEnd,
        cuts: cutterEditorState.cuts.map((cut) => ({ ...cut })),
        profile: cutterExportProfile,
        encoder: cutterExportEncoder,
        audioStreamIndex: cutterAudioStreamIndex,
        allAudioStreams: cutterAllAudioStreams,
        colorMode: cutterColorMode,
        audioProcessing: { ...cutterAudioProcessing },
    };
}

async function persistCutterProject(showResult: boolean): Promise<boolean> {
    const file = cutterFile;
    const project = getCutterProjectPayload();
    if (!file || !project || cutterCutDraft) return false;
    let saved = false;
    try {
        saved = await window.api.saveCutterProject(file.token, project);
    } catch { }
    if (showResult) showAppToast(saved ? UI_TEXT.cutter.projectSaved : UI_TEXT.cutter.projectSaveFailed, saved ? 'info' : 'warn');
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
    if (project) byId('cutterRecoveryText').textContent = UI_TEXT.cutter.recoveryFound;
}

function updateCutterAudioStreams(): void {
    const select = byId<HTMLSelectElement>('cutterAudioStream');
    const streams = cutterVideoInfo?.audioStreams ?? [];
    select.replaceChildren();
    if (streams.length === 0) {
        const option = document.createElement('option');
        option.value = '0';
        option.textContent = UI_TEXT.cutter.noAudio;
        select.append(option);
        select.disabled = true;
        cutterAudioStreamIndex = 0;
        return;
    }
    if (streams.length > 1) {
        const option = document.createElement('option');
        option.value = 'all';
        option.textContent = UI_TEXT.cutter.allAudioStreams;
        select.append(option);
    }
    streams.forEach((stream) => {
        const option = document.createElement('option');
        option.value = String(stream.index);
        const channelLabel = stream.channels === 1 ? UI_TEXT.cutter.channelSingular : UI_TEXT.cutter.channelPlural;
        const language = getCutterAudioLanguage(stream.language);
        const details = [language, stream.codec, stream.channels > 0 ? `${stream.channels} ${channelLabel}` : ''].filter(Boolean).join(' · ');
        const label = UI_TEXT.cutter.audioStream.replace('{index}', String(stream.index + 1));
        option.textContent = `${label}${language ? ` · ${language}` : ''}`;
        option.title = details;
        select.append(option);
    });
    if (!streams.some((stream) => stream.index === cutterAudioStreamIndex)) cutterAudioStreamIndex = streams[0].index;
    select.value = cutterAllAudioStreams && streams.length > 1 ? 'all' : String(cutterAudioStreamIndex);
    select.disabled = false;
}

function updateCutterExportControls(options: CutterExportOptions | null | undefined): void {
    const profile = byId<HTMLSelectElement>('cutterExportProfile');
    const encoder = byId<HTMLSelectElement>('cutterExportEncoder');
    if (options) {
        profile.replaceChildren(...options.profiles.map((entry) => {
            const option = document.createElement('option');
            option.value = entry.id;
            option.textContent = {
                quality: UI_TEXT.cutter.profileQuality,
                balanced: UI_TEXT.cutter.profileBalanced,
                fast: UI_TEXT.cutter.profileFast,
                archive: UI_TEXT.cutter.profileArchive,
            }[entry.id];
            return option;
        }));
    }
    profile.value = cutterExportProfile;
    encoder.replaceChildren();
    const software = document.createElement('option');
    software.value = 'software';
    software.textContent = UI_TEXT.cutter.encoderSoftware;
    encoder.append(software);
    if (!cutterRequiresSoftware()) {
        const hardwareEncoders = options?.hardwareEncoders
            ?? (options === undefined && cutterExportEncoder !== 'software' ? [cutterExportEncoder] : []);
        hardwareEncoders.forEach((value) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value === 'h264_nvenc'
                ? UI_TEXT.cutter.encoderNvenc
                : value === 'h264_qsv'
                    ? UI_TEXT.cutter.encoderQsv
                    : UI_TEXT.cutter.encoderAmf;
            encoder.append(option);
        });
    }
    if (cutterRequiresSoftware() || (options !== undefined && !Array.from(encoder.options).some((option) => option.value === cutterExportEncoder))) cutterExportEncoder = 'software';
    encoder.value = cutterExportEncoder;
    encoder.disabled = !cutterControlsEnabled || !options || cutterRequiresSoftware();
    updateCutterExportPresentation();
}

function refreshCutterLocalizedUi(): void {
    byId('cutterPreviewHeading').textContent = UI_TEXT.cutter.previewAlt;
    byId('cutterTimelineHeading').textContent = UI_TEXT.cutter.timeline;
    byId('cutterZoomOverviewBtn').textContent = UI_TEXT.cutter.overview;
    byId('cutterZoomSelectionBtn').textContent = UI_TEXT.cutter.zoomSelection;
    renderCutterProjectRecovery(cutterPendingProject);
    updateCutterAudioStreams();
    updateCutterExportControls(cutterExportOptions);
    updateCutterWaveformStatus();
    updateCutterEditActions();
    syncCutterPlayer();
    if (cutterEditorState) renderCutterEditor();
}

async function loadCutterExportOptions(file: FileCapabilityReference, generation: number): Promise<void> {
    let options: CutterExportOptions | null = null;
    try {
        options = await window.api.getCutterExportOptions();
    } catch { }
    if (generation !== cutterLoadGeneration || cutterFile !== file) return;
    cutterExportOptions = options;
    updateCutterExportControls(options);
    setCutterControlsEnabled(cutterControlsEnabled);
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
    cutterAllAudioStreams = project.allAudioStreams === true;
    cutterColorMode = project.colorMode ?? 'source';
    cutterAudioProcessing = { fadeInSeconds: 0, fadeOutSeconds: 0, normalize: false, ...project.audioProcessing };
    syncCutterAudioProcessing();
    updateCutterAudioStreams();
    updateCutterExportControls(cutterExportOptions);
    cutterHistoryPast = [];
    cutterHistoryFuture = [];
    cutterActiveCutId = null;
    cutterCutDraft = null;
    renderCutterEditor();
    seekCutterVideo(cutterEditorState.trimStart);
    return true;
}

async function recoverCutterProject(): Promise<void> {
    if (!cutterPendingProject || !applyCutterProject(cutterPendingProject)) {
        showAppToast(UI_TEXT.cutter.projectRecoveryFailed, 'warn');
        return;
    }
    cutterRecoveryDecisionPending = false;
    renderCutterProjectRecovery(null);
    showAppToast(UI_TEXT.cutter.projectRecovered, 'info');
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
    if (!cutterFile || cutterCutDraft || isCutting) return;
    let project: CutterProject | null = null;
    try { project = await window.api.openCutterProject(cutterFile.token); } catch { }
    if (!project || !applyCutterProject(project)) {
        showAppToast(UI_TEXT.cutter.projectNotFound, 'warn');
        return;
    }
    cutterRecoveryDecisionPending = false;
    renderCutterProjectRecovery(null);
    showAppToast(UI_TEXT.cutter.projectOpened, 'info');
}

function setCutterExportProfile(value: string): void {
    if (value !== 'quality' && value !== 'balanced' && value !== 'fast' && value !== 'archive') return;
    cutterExportProfile = value;
    if (value === 'archive') cutterExportEncoder = 'software';
    updateCutterExportControls(cutterExportOptions);
    scheduleCutterAutosave();
}

function setCutterExportEncoder(value: string): void {
    if (value !== 'software' && value !== 'h264_nvenc' && value !== 'h264_qsv' && value !== 'h264_amf') return;
    cutterExportEncoder = value;
    updateCutterExportPresentation();
    scheduleCutterAutosave();
}

function setCutterColorMode(value: string): void {
    if (value !== 'source' && value !== 'sdr') return;
    cutterColorMode = value;
    updateCutterExportControls(cutterExportOptions);
    scheduleCutterAutosave();
}

function cutterRequiresSoftware(): boolean {
    const format = cutterVideoInfo?.sourceFormat;
    return cutterExportProfile === 'archive' || (cutterColorMode === 'source' && Boolean(format && (format.hdr || format.pixelFormat !== 'yuv420p')));
}

function setCutterAudioStream(value: string): void {
    if (value === 'all') {
        cutterAllAudioStreams = true;
        updateCutterExportPresentation();
        scheduleCutterAutosave();
        return;
    }
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || !(cutterVideoInfo?.audioStreams ?? []).some((stream) => stream.index === index)) return;
    cutterAllAudioStreams = false;
    cutterAudioStreamIndex = index;
    updateCutterExportPresentation();
    scheduleCutterAutosave();
}

function commitCutterChange(before: CutterEditorState): void {
    if (!cutterEditorState || cutterCutDraft || cutterStatesEqual(before, cutterEditorState)) return;
    cutterHistoryPast.push(cloneCutterState(before));
    if (cutterHistoryPast.length > 100) cutterHistoryPast.shift();
    cutterHistoryFuture = [];
    updateCutterHistoryButtons();
    scheduleCutterAutosave();
}

function updateCutterHistoryButtons(): void {
    byId<HTMLButtonElement>('cutterUndoBtn').disabled = !cutterControlsEnabled || Boolean(cutterCutDraft) || cutterHistoryPast.length === 0;
    byId<HTMLButtonElement>('cutterRedoBtn').disabled = !cutterControlsEnabled || Boolean(cutterCutDraft) || cutterHistoryFuture.length === 0;
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
    if (cutterPreviewMode && !cutterCutDraft) {
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
    void getCutterVideo().play().catch(() => undefined);
}

function cutterSeekTime(time: number): number {
    if (!cutterEditorState || time >= cutterEditorState.duration) return time;
    return Math.min(cutterEditorState.duration, time + Math.min(.001, 1 / cutterEditorState.fps / 16));
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
    let settled = false;
    const finish = (mediaTime: number): void => {
        if (settled || generation !== cutterScrubGeneration || !cutterEditorState) return;
        settled = true;
        cutterScrubCleanup?.();
        cutterScrubCleanup = null;
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
    }
    const seeked = (): void => { if (!video.requestVideoFrameCallback) finish(video.currentTime); };
    video.addEventListener('seeked', seeked, { once: true });
    const timeout = window.setTimeout(() => finish(video.currentTime), 1500);
    cutterScrubCleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('seeked', seeked);
        if (cutterScrubFrameRequest !== null) video.cancelVideoFrameCallback?.(cutterScrubFrameRequest);
    };
    video.currentTime = cutterSeekTime(targetTime);
}

function queueCutterScrubFrame(time: number): void {
    if (!cutterEditorState) return;
    cutterScrubTargetTime = clampCutterValue(snapCutterTime(time), 0, cutterEditorState.duration);
    presentNextCutterScrubFrame();
}

function cancelCutterScrubFrames(): void {
    const video = getCutterVideo() as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void };
    cutterScrubGeneration += 1;
    cutterPendingSeekTime = null;
    cutterScrubCleanup?.();
    cutterScrubCleanup = null;
    if (cutterScrubFrameRequest !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(cutterScrubFrameRequest);
    cutterScrubTargetTime = null;
    cutterScrubFrameRequest = null;
    cutterScrubSeekInFlight = false;
    cutterScrubResumePlayback = false;
}

function seekCutterVideo(time: number, skipCuts = false): void {
    if (!cutterEditorState) return;
    cancelCutterScrubFrames();
    const video = getCutterVideo();
    const nextTime = skipCuts ? findCutterPreviewTime(time) : clampCutterValue(snapCutterTime(time), 0, cutterEditorState.duration);
    cutterPendingSeekTime = nextTime;
    cutterPendingSeekRetries = 0;
    if (!video.seeking && Number.isFinite(video.duration)) video.currentTime = cutterSeekTime(nextTime);
    cutterPreviousPlaybackTime = nextTime;
    updateCutterPlayhead(nextTime);
}

function settleCutterSeek(): void {
    if (cutterPendingSeekTime === null || !cutterEditorState) return;
    const video = getCutterVideo();
    const target = Math.min(cutterPendingSeekTime, Number.isFinite(video.duration) ? video.duration : cutterEditorState.duration);
    if (Math.abs(video.currentTime - target) < 1 / cutterEditorState.fps / 2 || cutterPendingSeekRetries >= 3) {
        cutterPendingSeekTime = null;
        cutterPendingSeekRetries = 0;
        return;
    }
    cutterPendingSeekRetries += 1;
    video.currentTime = cutterSeekTime(target);
}

function updateCutterPlayhead(time: number): void {
    if (!cutterEditorState) return;
    if (cutterDragState?.kind !== 'playhead' && !cutterScrubSeekInFlight && cutterScrubTargetTime === null) {
        updateCutterInteractionPlayhead(time);
    }
    cutterPresentedTime = time;
    cutterPlayerView?.updatePosition(time);
    const timecode = formatCutterTimecode(time);
    const timelineTimecode = byId('cutterTimelineTimecode');

    if (timelineTimecode.textContent !== timecode) timelineTimecode.textContent = timecode;

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
    const width = Math.max(1, byId('timeline').getBoundingClientRect().width);
    const fps = cutterEditorState.fps;
    const frameBase = Math.max(1, Math.round(fps));
    const totalFrames = Math.max(1, Math.round(cutterEditorState.duration * fps));
    const minimumStep = totalFrames * 112 / width;
    const intervals = [1, 2, 5, 10, 15].filter(value => value < frameBase)
        .concat([1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400].map(value => value * frameBase));
    const step = intervals.find(value => value >= minimumStep) || Math.ceil(minimumStep / frameBase) * frameBase;
    const detailed = step < frameBase;
    for (let frame = 0; frame <= totalFrames; frame += step) {
        const tick = document.createElement('span');
        tick.className = 'cutter-ruler-tick';
        tick.style.left = `${frame / totalFrames * 100}%`;
        const label = formatCutterTimecode(frame / fps);
        tick.textContent = detailed ? label : label.replace(/:\d{2}$/, '');
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
    const renderedFrameCount = Math.min(2048, Math.max(1, Math.ceil(cssWidth / tileWidth)));
    const sourceIndexes: number[] = [];
    const visibleImages: HTMLImageElement[] = [];
    for (let index = 0; index < renderedFrameCount; index += 1) {
        const sourceIndex = Math.min(cutterThumbnailImages.length - 1, Math.floor((index + .5) / renderedFrameCount * cutterThumbnailImages.length));
        sourceIndexes.push(sourceIndex);
        const image = cutterThumbnailImages[sourceIndex].cloneNode() as HTMLImageElement;
        const visibleWidth = cssWidth / renderedFrameCount;
        image.style.width = `${visibleWidth}px`;
        image.style.minWidth = '0';
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
    const currentImages = cutterThumbnailImages;
    if (currentImages[0]) void currentImages[0].decode().then(() => {
        if (cutterThumbnailImages === currentImages) drawCutterThumbnailImages();
    }).catch(() => undefined);
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
    const count = cutterEditorState?.cuts.length || 0;
    byId('cutterCutCount').textContent = `${UI_TEXT.cutter.cutsLabel}: ${formatUiNumber(count)}`;
    byId('cutterCutCount').hidden = count === 0;
    if (!cutterEditorState?.cuts.length) {
        const empty = document.createElement('div');
        empty.className = 'cutter-cut-empty';
        empty.textContent = UI_TEXT.cutter.noCuts;
        list.append(empty);
        return;
    }
    cutterEditorState.cuts.forEach((cut, index) => {
        const editing = cut.id === cutterCutDraft?.id;
        const row = document.createElement('div');
        row.className = 'cutter-cut-row' + (editing ? ' active' : '');
        row.dataset.cutId = cut.id;
        const heading = document.createElement('button');
        heading.type = 'button'; heading.className = 'cutter-cut-row-heading';
        heading.textContent = UI_TEXT.cutter.cutLabel + ' ' + formatUiNumber(index + 1);
        heading.addEventListener('click', () => seekCutterVideo(cut.start));
        const fields = document.createElement('div'); fields.className = 'cutter-cut-fields';
        const inputs = (['start', 'end'] as const).map(which => {
            const label = document.createElement('label');
            const marker = document.createElement('span'); marker.textContent = which === 'start' ? 'I' : 'O';
            const input = document.createElement('input'); input.type = 'text';
            input.value = formatCutterTimecode(cut[which]); input.spellcheck = false; input.readOnly = !editing;
            input.setAttribute('aria-label', which === 'start' ? UI_TEXT.cutter.startLabel : UI_TEXT.cutter.endLabel);
            label.append(marker, input); fields.append(label); return input;
        });
        const duration = document.createElement('span'); duration.className = 'cutter-cut-duration'; duration.textContent = formatCutterTimecode(cut.end - cut.start);
        const actions = document.createElement('div'); actions.className = 'cutter-cut-actions';
        const primary = document.createElement('button'); primary.type = 'button'; primary.className = 'btn-secondary';
        primary.textContent = editing ? UI_TEXT.cutter.confirmCut : UI_TEXT.cutter.editCut;
        primary.disabled = !cutterControlsEnabled || (!editing && Boolean(cutterCutDraft));
        primary.addEventListener('click', () => editing ? confirmCutterCut() : editCutterCut(cut.id));
        const secondary = document.createElement('button'); secondary.type = 'button'; secondary.className = 'cutter-icon-button';
        secondary.textContent = '×'; secondary.title = editing ? UI_TEXT.cutter.cancel : UI_TEXT.cutter.removeCut;
        secondary.setAttribute('aria-label', secondary.title);
        secondary.disabled = !cutterControlsEnabled || (!editing && Boolean(cutterCutDraft));
        secondary.addEventListener('click', () => editing ? cancelCutterCut() : removeCutterCut(cut.id));
        actions.append(primary, secondary);
        const error = document.createElement('span'); error.className = 'cutter-range-error'; error.setAttribute('role', 'status'); error.hidden = true;
        const apply = (): void => {
            const start = parseCutterTimecode(inputs[0].value), end = parseCutterTimecode(inputs[1].value);
            const valid = start !== null && end !== null && start >= cutterEditorState!.trimStart && end <= cutterEditorState!.trimEnd && setCutterCutRange(cut.id, start, end);
            inputs.forEach(input => input.setAttribute('aria-invalid', String(!valid)));
            primary.disabled = !valid; error.hidden = valid; error.textContent = valid ? '' : UI_TEXT.cutter.invalidRange;
            if (valid) updateCutterEditorGeometry();
        };
        if (editing) inputs.forEach(input => {
            input.addEventListener('input', apply);
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') { apply(); if (!primary.disabled) confirmCutterCut(); }
                if (event.key === 'Escape') { event.preventDefault(); cancelCutterCut(); }
            });
        });
        row.append(heading, fields, duration, actions, error); list.append(row);
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
        overlay.addEventListener('pointerdown', (event) => {
            if (cut.id !== cutterCutDraft?.id) return;
            cutterActiveCutId = cut.id;
            beginCutterDrag('cut-move', event, cut.id);
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                editCutterCut(cut.id);
            } else if (cut.id === cutterCutDraft?.id && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                handleCutterCutMoveKey(event, cut.id);
            }
        });
        if (cut.id === cutterCutDraft?.id) overlay.append(label);
        else {
            overlay.append(label);
            overlay.style.cursor = 'pointer';
            overlay.addEventListener('click', () => editCutterCut(cut.id));
        }
        container.appendChild(overlay);
    });
}

function updateCutterEditorGeometry(validatedCutId: string | null = null): void {
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
    byId('infoSelection').textContent = formatCutterTimecode(getCutterPlayableDuration());
    byId('cutterOutputLength').textContent = formatCutterTimecode(getCutterPlayableDuration());
    document.querySelectorAll<HTMLElement>('.cutter-cut-overlay[data-cut-id]').forEach((overlay) => {
        const cut = cutterEditorState!.cuts.find((entry) => entry.id === overlay.dataset.cutId);
        if (!cut) return;
        overlay.style.left = `${cut.start / cutterEditorState!.duration * 100}%`;
        overlay.style.width = `${(cut.end - cut.start) / cutterEditorState!.duration * 100}%`;
        overlay.classList.toggle('active', cut.id === cutterActiveCutId);
    });
    document.querySelectorAll<HTMLElement>('.cutter-cut-row[data-cut-id]').forEach((row) => {
        const cut = cutterEditorState!.cuts.find((entry) => entry.id === row.dataset.cutId);
        if (!cut) return;
        const inputs = row.querySelectorAll<HTMLInputElement>('input');
        const validated = validatedCutId === cut.id || cutterDragState?.cutId === cut.id || cutterRangeDrag?.cutId === cut.id;
        if (validated) {
            inputs.forEach(input => input.setAttribute('aria-invalid', 'false'));
            const apply = row.querySelector<HTMLButtonElement>('.btn-secondary');
            const error = row.querySelector<HTMLElement>('.cutter-range-error');
            if (apply) apply.disabled = !cutterControlsEnabled;
            if (error) error.hidden = true;
        }
        if (inputs[0] && (validated || document.activeElement !== inputs[0])) inputs[0].value = formatCutterTimecode(cut.start);
        if (inputs[1] && (validated || document.activeElement !== inputs[1])) inputs[1].value = formatCutterTimecode(cut.end);
        const duration = row.querySelector<HTMLElement>('.cutter-cut-duration');
        if (duration) duration.textContent = formatCutterTimecode(cut.end - cut.start);
        row.classList.toggle('active', cut.id === cutterActiveCutId);
    });
    syncCutterPlayer();
}

function renderCutterEditor(): void {
    if (!cutterEditorState) return;
    renderCutterCutList();
    renderCutterCutOverlays();
    updateCutterEditorGeometry();
    updateCutterHistoryButtons();
    updateCutterEditActions();
}

function setCutterControlsEnabled(enabled: boolean): void {
    cutterControlsEnabled = enabled;
    for (const id of ['cutterZoom', 'cutterZoomInBtn', 'cutterZoomOutBtn', 'cutterZoomOverviewBtn', 'cutterZoomSelectionBtn', 'cutterNewCutBtn', 'cutterSaveProjectBtn', 'cutterExportProfile', 'cutterColorMode', 'cutterAudioFadeIn', 'cutterAudioFadeOut', 'cutterAudioNormalize', 'cutterFullRange', 'cutterMarkStart', 'cutterMarkEnd', 'startTime', 'endTime']) {
        const element = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | null;
        if (element) element.disabled = !enabled;
    }
    byId<HTMLSelectElement>('cutterExportEncoder').disabled = !enabled || !cutterExportOptions || cutterRequiresSoftware();
    byId<HTMLSelectElement>('cutterAudioStream').disabled = !enabled || (cutterVideoInfo?.audioStreams.length ?? 0) === 0;
    updateCutterEditActions();
    syncCutterPlayer();
}

function animateCutterWorkspaceReveal(_previousPreviewRect: DOMRect): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    byId('cutterEditPanel').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
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

function clearCutterWaveform(): void {
    cutterWaveformImage = null;
    cutterWaveformPeaks = [];
    cutterWaveformCompletedBins = 0;
    cutterWaveformStatus = 'none';
    updateCutterWaveformStatus();
    if (cutterWaveformRenderFrame !== null) cancelAnimationFrame(cutterWaveformRenderFrame);
    cutterWaveformRenderFrame = null;
    const canvas = byId<HTMLCanvasElement>('cutterWaveform');
    canvas.hidden = true;
    canvas.width = 1;
}

function drawCutterWaveform(): void {
    cutterWaveformRenderFrame = null;
    if (!cutterWaveformPeaks.length) return;
    const scroll = byId('cutterTimelineScroll');
    const track = byId('cutterAudioTrack');
    const canvas = byId<HTMLCanvasElement>('cutterWaveform');
    const totalWidth = Math.max(1, track.getBoundingClientRect().width);
    const left = Math.max(0, scroll.scrollLeft);
    const cssWidth = Math.max(1, Math.min(scroll.clientWidth, totalWidth - left));
    const cssHeight = Math.max(1, track.clientHeight);
    const ratio = clampCutterValue(window.devicePixelRatio || 1, 1, 3);
    canvas.width = Math.ceil(cssWidth * ratio);
    canvas.height = Math.ceil(cssHeight * ratio);
    canvas.style.left = `${left}px`;
    canvas.style.width = `${cssWidth}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.imageSmoothingEnabled = false;
    const laneHeight = canvas.height / cutterWaveformPeaks.length;
    cutterWaveformPeaks.forEach((peaks, channel) => {
        const center = (channel + .5) * laneHeight;
        context.fillStyle = '#64717c';
        const readyWidth = Math.max(0, Math.min(canvas.width, (cutterWaveformCompletedBins / peaks.length * totalWidth - left) * ratio));
        context.fillRect(0, Math.round(center), readyWidth, 1);
        context.fillStyle = '#9ac8bb';
        for (let x = 0; x < canvas.width; x += 1) {
            const start = Math.min(peaks.length - 1, Math.floor((left + x / ratio) / totalWidth * peaks.length));
            if (start >= cutterWaveformCompletedBins) continue;
            const end = Math.min(cutterWaveformCompletedBins, Math.max(start + 1, Math.ceil((left + (x + 1) / ratio) / totalWidth * peaks.length)));
            let peak = 0;
            for (let index = start; index < end; index += 1) peak = Math.max(peak, peaks[index]);
            const height = Math.round(peak / 255 * Math.max(1, laneHeight / 2 - 2));
            if (height > 0) context.fillRect(x, Math.round(center) - height, 1, height * 2);
        }
    });
    canvas.hidden = false;
}

function scheduleCutterWaveformRender(): void {
    if (!cutterWaveformPeaks.length || cutterWaveformRenderFrame !== null) return;
    cutterWaveformRenderFrame = requestAnimationFrame(drawCutterWaveform);
}

function updateCutterWaveformStatus(): void {
    const element = byId('cutterWaveformStatus');
    element.hidden = cutterWaveformStatus === 'none' || cutterWaveformStatus === 'complete';
    const percent = cutterWaveformPeaks[0]?.length
        ? Math.min(99, Math.floor(cutterWaveformCompletedBins / cutterWaveformPeaks[0].length * 100))
        : 0;
    element.textContent = cutterWaveformStatus === 'failed'
        ? UI_TEXT.cutter.waveformFailed
        : UI_TEXT.cutter.waveformLoading.replace('{percent}', String(percent));
}

function receiveCutterWaveformProgress(progress: import('./main/domain/cutter-waveform').VideoEditorWaveformProgress): void {
    if (progress.jobId !== cutterMediaJobId || cutterWaveformStatus !== 'loading' || !cutterVideoInfo?.hasAudio) return;
    if (!cutterWaveformPeaks.length) cutterWaveformPeaks = progress.peaks.map(() => new Uint8Array(progress.totalBins));
    progress.peaks.forEach((peaks, channel) => cutterWaveformPeaks[channel]?.set(peaks, progress.startIndex));
    cutterWaveformCompletedBins = Math.max(cutterWaveformCompletedBins, progress.completedBins);
    updateCutterWaveformStatus();
    scheduleCutterWaveformRender();
}

async function requestCutterWaveform(file: FileCapabilityReference, jobId: number, loadGeneration: number): Promise<void> {
    cutterWaveformStatus = cutterVideoInfo?.hasAudio ? 'loading' : 'none';
    updateCutterWaveformStatus();
    let result: VideoEditorWaveform | null = null;
    try {
        result = await window.api.prepareVideoEditorWaveform(file.token, jobId);
    } catch { }
    if (loadGeneration !== cutterLoadGeneration || cutterFile !== file || cutterMediaJobId !== jobId) return;
    if (!result || result.jobId !== jobId) {
        cutterWaveformStatus = cutterVideoInfo?.hasAudio ? 'failed' : 'none';
        updateCutterWaveformStatus();
        return;
    }
    if (result.peaks?.length) {
        cutterWaveformPeaks = result.peaks.map(peaks => Uint8Array.from(peaks));
        cutterWaveformCompletedBins = cutterWaveformPeaks[0].length;
        cutterWaveformStatus = 'complete';
        updateCutterWaveformStatus();
        byId('cutterAudioEmpty').hidden = true;
        scheduleCutterWaveformRender();
        return;
    }
    if (!result.waveform) {
        clearCutterWaveform();
        byId('cutterAudioEmpty').hidden = Boolean(cutterVideoInfo?.hasAudio);
        cutterWaveformStatus = cutterVideoInfo?.hasAudio ? 'failed' : 'none';
        updateCutterWaveformStatus();
        return;
    }
    const image = new Image();
    cutterWaveformImage = image;
    image.src = result.waveform;
    try { await image.decode(); } catch {
        if (loadGeneration === cutterLoadGeneration) {
            cutterWaveformStatus = 'failed';
            updateCutterWaveformStatus();
        }
        return;
    }
    if (cutterWaveformImage !== image || loadGeneration !== cutterLoadGeneration) return;
    const channels = Math.max(1, Math.min(8, result.channels || 1));
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const laneHeight = canvas.height / channels;
    cutterWaveformPeaks = Array.from({ length: channels }, (_, channel) => {
        const peaks = new Uint8Array(canvas.width);
        const start = Math.floor(channel * laneHeight), end = Math.floor((channel + 1) * laneHeight);
        const center = (start + end - 1) / 2;
        for (let y = start; y < end; y += 1) {
            const amplitude = Math.min(255, Math.round(Math.abs(y - center) / (laneHeight / 2) * 255));
            for (let x = 0; x < canvas.width; x += 1) {
                const offset = (y * canvas.width + x) * 4;
                if (pixels[offset] > 32 && pixels[offset + 3] > 32) peaks[x] = Math.max(peaks[x], amplitude);
            }
        }
        return peaks;
    });
    canvas.width = 1;
    cutterWaveformCompletedBins = cutterWaveformPeaks[0].length;
    cutterWaveformStatus = 'complete';
    updateCutterWaveformStatus();
    cutterWaveformImage = null;
    byId('cutterAudioEmpty').hidden = true;
    scheduleCutterWaveformRender();
}

async function loadCutterFromPath(file: FileCapabilityReference): Promise<void> {
    if (!file || isCutting) return;
    const generation = ++cutterLoadGeneration;
    cutterPresentedTime = null;
    cutterPendingSeekTime = null;
    finishCutterPlayerRange(false);
    const video = getCutterVideo();
    const hadEditor = Boolean(cutterEditorState && cutterFile);
    video.pause();
    stopCutterPlaybackFrameSync();
    cancelCutterScrubFrames();
    byId('cutterPreview').classList.remove('playing', 'buffering');
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
    cutterCutDraft = null;
    cutterMode = 'trim';
    byId('cutterEditPanel').hidden = false;
    cutterExportProfile = 'balanced';
    cutterExportEncoder = 'software';
    cutterExportOptions = undefined;
    cutterAudioStreamIndex = media.info.audioStreams[0]?.index ?? 0;
    cutterAudioProcessing = { fadeInSeconds: 0, fadeOutSeconds: 0, normalize: false };
    syncCutterAudioProcessing();
    cutterAllAudioStreams = true;
    cutterColorMode = 'source';
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
    byId('infoDuration').textContent = formatCutterTimecode(media.info.duration);
    byId('infoResolution').textContent = `${media.info.width}×${media.info.height}`;
    byId('infoFps').textContent = media.info.fps.toFixed(media.info.fps % 1 === 0 ? 0 : 2);

    renderCutterThumbnails(media.thumbnails);
    clearCutterWaveform();
    byId('cutterAudioEmpty').hidden = media.info.hasAudio;
    video.src = media.sourceUrl;

    video.load();
    byId('cutterPreview').classList.remove('playing', 'buffering');
    updateCutterZoom(cutterZoom);
    renderCutterEditor();
    updateCutterPlayhead(0);
    if (previousPreviewRect) animateCutterWorkspaceReveal(previousPreviewRect);
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
    if (cutterCutDraft) cancelCutterCut();
    if (cutterEditorState && !cutterRecoveryDecisionPending && !await persistCutterProject(false)) {
        showAppToast(UI_TEXT.cutter.projectSaveFailed, 'warn');
        return;
    }
    await loadCutterFromPath(file);
}

async function selectCutterVideo(): Promise<void> {
    let file: FileCapabilityReference | null;
    try {
        file = await window.api.selectVideoFile();
    } catch {
        showAppToast(UI_TEXT.cutter.unsupportedFile, 'warn');
        return;
    }
    if (!file) return;
    if (!isSupportedCutterVideoFile(file)) {
        showAppToast(UI_TEXT.cutter.unsupportedFile, 'warn');
        return;
    }
    await requestCutterVideoReplacement(file);
}

function updateTimeFromInput(): void {
    if (!cutterEditorState || cutterCutDraft || !cutterControlsEnabled) return;
    const start = parseCutterTimecode(byId<HTMLInputElement>('startTime').value);
    const end = parseCutterTimecode(byId<HTMLInputElement>('endTime').value);
    const before = cloneCutterState(cutterEditorState);
    if (start === null || end === null || start < 0 || end > cutterEditorState.duration || !setCutterTrim(start, end)) {
        showAppToast(UI_TEXT.cutter.invalidRange, 'warn');
        renderCutterEditor();
        return;
    }
    commitCutterChange(before);
    renderCutterEditor();
}

function addCutterCut(): void {
    if (!cutterEditorState || !cutterControlsEnabled || cutterCutDraft || isCutting) return;
    setCutterMode('omit');
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
    const fps = cutterEditorState.fps;
    const removableFrames = Math.floor((getCutterPlayableDuration() - 1 / fps + cutterFrameTolerance) * fps);
    if (removableFrames < 1) return;
    const frameGaps = gaps.map((entry) => ({
        start: Math.ceil((entry.start - cutterFrameTolerance) * fps),
        end: Math.floor((entry.end + cutterFrameTolerance) * fps),
    })).filter((entry) => entry.end > entry.start);
    const playheadFrame = Math.round(playhead * fps);
    const gap = frameGaps.find((entry) => playheadFrame >= entry.start && playheadFrame < entry.end) || frameGaps[0];
    if (!gap) return;
    const startFrame = clampCutterValue(playheadFrame, gap.start, gap.end - 1);
    const length = Math.min(Math.max(1, Math.round(5 * fps)), gap.end - startFrame, removableFrames);
    const start = snapCutterTime(startFrame / fps);
    const end = snapCutterTime((startFrame + length) / fps);
    const before = cloneCutterState(cutterEditorState);
    const id = `cut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cuts = [...cutterEditorState.cuts, { id, start, end }].sort((left, right) => left.start - right.start);
    if (!cutterHasPlayableFrame(cuts)) {
        showAppToast(UI_TEXT.cutter.invalidRange, 'warn');
        return;
    }
    cutterEditorState = { ...cutterEditorState, cuts };
    cutterActiveCutId = id;
    cutterCutDraft = { before, id };
    commitCutterChange(before);
    seekCutterVideo(start);
    renderCutterEditor();
}

function removeCutterCut(id: string): void {
    if (!cutterEditorState || !cutterControlsEnabled || cutterCutDraft || !cutterEditorState.cuts.some((cut) => cut.id === id)) return;
    const before = cloneCutterState(cutterEditorState);
    cutterEditorState = { ...cutterEditorState, cuts: cutterEditorState.cuts.filter((cut) => cut.id !== id) };
    if (cutterActiveCutId === id) cutterActiveCutId = null;
    commitCutterChange(before);
    renderCutterEditor();
}

function undoCutterEdit(): void {
    if (!cutterEditorState || cutterCutDraft || !cutterControlsEnabled) return;
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
    if (!cutterEditorState || cutterCutDraft || !cutterControlsEnabled) return;
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
    const current = video.currentTime;
    const bounded = current < cutterEditorState.trimStart || current >= cutterEditorState.trimEnd ? cutterEditorState.trimStart : current;
    const target = findCutterPreviewTime(bounded);
    if (Math.abs(target - current) > 0.000001) video.currentTime = target;
    try { await video.play(); } catch { }
}

function stepCutterFrame(direction: number): void {
    if (!cutterEditorState) return;
    const video = getCutterVideo();
    const time = cutterPendingSeekTime ?? (video.paused ? video.currentTime : cutterPresentedTime ?? video.currentTime);
    video.pause();
    const target = clampCutterValue((Math.round(time * cutterEditorState.fps) + direction) / cutterEditorState.fps, 0, cutterEditorState.duration);
    seekCutterVideo(target);
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
}

async function toggleCutterFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
    }
    await byId('cutterPlayer').requestFullscreen();
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
    updateCutterEditorGeometry();
    scheduleCutterThumbnailSpriteRender();
    drawCutterThumbnailImages(scroll.clientWidth * cutterZoom);
    const target = clampCutterValue(anchorRatio * timeline.scrollWidth - localAnchorX, 0, Math.max(0, timeline.scrollWidth - scroll.clientWidth));
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        scroll.scrollTo({ left: target, behavior: 'smooth' });
    } else {
        scroll.scrollLeft = target;
    }
    scheduleCutterWaveformRender();
    if ((cutterVideoInfo?.duration || 0) > 120 && (cutterAssetsPixelWidth > 0 || cutterAssetsInFlightJobId !== null)) scheduleCutterAssetRefresh();
}

function setCutterTimelineView(view: 'overview' | 'selection'): void {
    if (!cutterEditorState || !cutterControlsEnabled) return;
    if (view === 'overview') {
        updateCutterZoom(1);
        return;
    }
    const range = cutterEditorState.cuts.find(cut => cut.id === cutterCutDraft?.id) || { start: cutterEditorState.trimStart, end: cutterEditorState.trimEnd };
    const span = Math.max(1 / cutterEditorState.fps, range.end - range.start);
    updateCutterZoom(cutterEditorState.duration / (span * 1.15));
    const scroll = byId<HTMLElement>('cutterTimelineScroll');
    const timeline = byId<HTMLElement>('timeline');
    const center = (range.start + range.end) / 2 / cutterEditorState.duration;
    scroll.scrollLeft = clampCutterValue(center * timeline.scrollWidth - scroll.clientWidth / 2, 0, Math.max(0, timeline.scrollWidth - scroll.clientWidth));
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

function handleCutterCutMoveKey(event: KeyboardEvent, cutId: string): void {
    if (!cutterEditorState || !cutterControlsEnabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const cut = cutterEditorState.cuts.find(entry => entry.id === cutId);
    if (!cut || cutId !== cutterCutDraft?.id) return;
    event.preventDefault(); event.stopPropagation();
    const before = cloneCutterState(cutterEditorState);
    const others = cutterEditorState.cuts.filter(entry => entry.id !== cutId);
    const minimum = Math.max(cutterEditorState.trimStart, ...others.filter(entry => entry.end <= cut.start).map(entry => entry.end));
    const maximum = Math.min(cutterEditorState.trimEnd, ...others.filter(entry => entry.start >= cut.end).map(entry => entry.start));
    const duration = cut.end - cut.start;
    const delta = (event.shiftKey ? 10 : 1) / cutterEditorState.fps * (event.key === 'ArrowLeft' ? -1 : 1);
    const start = event.key === 'Home' ? minimum : event.key === 'End' ? maximum - duration : clampCutterValue(cut.start + delta, minimum, maximum - duration);
    if (!setCutterCutRange(cutId, start, start + duration)) return;
    commitCutterChange(before); renderCutterEditor(); seekCutterVideo(start);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.cutter-cut-overlay[data-cut-id="' + CSS.escape(cutId) + '"]')?.focus());
}

function beginCutterDrag(kind: CutterDragKind, event: PointerEvent, cutId: string | null = null): void {
    if (!cutterEditorState || !cutterControlsEnabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const cut = cutId ? cutterEditorState.cuts.find((entry) => entry.id === cutId) : null;
    const pointerTime = kind === 'playhead' ? cutterPointerTimeAt(event.clientX) : cutterPointerRawTimeAt(event.clientX);
    const anchorTarget = kind === 'cut-move' ? cut?.start : null;
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
        startY: event.clientY,
        fineAnchor: null,
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
    const autoScrolled = cutterDragFineTime === null && autoScrollCutterDrag(cutterDragPointerX);
    const drag = cutterDragState;
    const time = cutterDragFineTime ?? (drag.kind === 'playhead' ? cutterPointerTimeAt(cutterDragPointerX) : cutterPointerRawTimeAt(cutterDragPointerX));
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
    if (drag.cutId) {
        const cut = cutterEditorState.cuts.find((entry) => entry.id === drag.cutId);
        if (!cut) return;
        const orderedCuts = [...drag.before.cuts].sort((left, right) => left.start - right.start);
        const originalIndex = orderedCuts.findIndex((entry) => entry.id === drag.cutId);
        const previousEnd = originalIndex > 0 ? orderedCuts[originalIndex - 1].end : cutterEditorState.trimStart;
        const nextStart = originalIndex >= 0 && originalIndex < orderedCuts.length - 1 ? orderedCuts[originalIndex + 1].start : cutterEditorState.trimEnd;
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
    const drag = cutterDragState;
    if (!drag.fineAnchor && (event.altKey || drag.startY - event.clientY >= 28)) {
        drag.fineAnchor = { x: event.clientX, time: cutterPointerRawTimeAt(event.clientX) };
    }
    if (drag.fineAnchor) {
        const width = Math.max(1, byId('timeline').getBoundingClientRect().width);
        cutterDragFineTime = drag.fineAnchor.time + (event.clientX - drag.fineAnchor.x) / width * Math.min(60, cutterEditorState.duration / 10);
        byId('cutterPlayer').classList.add('fine-seeking');
    }
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
    cutterDragFineTime = null;
    byId('cutterPlayer').classList.remove('fine-seeking');
    document.body.classList.remove('cutter-dragging');
    try {
        if (drag.captureTarget.hasPointerCapture(drag.pointerId)) drag.captureTarget.releasePointerCapture(drag.pointerId);
    } catch { }
    if (drag.kind !== 'playhead') commitCutterChange(drag.before);
    renderCutterEditor();
    finishCutterScrubPlayback();
}

async function startCutting(): Promise<void> {
    if (!cutterFile || !cutterEditorState || isCutting || cutterCutDraft || !cutterControlsEnabled) return;
    isCutting = true;
    setCutterControlsEnabled(false);
    const button = byId<HTMLButtonElement>('btnCut');
    const cancel = byId<HTMLButtonElement>('cutterCancelExportBtn');
    button.disabled = true;
    button.textContent = UI_TEXT.cutter.cutting;
    cancel.hidden = false;
    byId('cutProgressBar').style.width = '0%';
    byId('cutProgressText').textContent = '0%';
    byId('cutProgressGauge').setAttribute('aria-valuenow', '0');
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
        allAudioStreams: cutterAllAudioStreams,
        colorMode: cutterColorMode,
        audioProcessing: { ...cutterAudioProcessing },
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
        setCutterControlsEnabled(true);
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

function synchronizeCutterPlaybackFrame(_now?: number, metadata?: VideoFrameCallbackMetadata): void {
    cutterPlaybackFrame = null;
    if (!cutterEditorState) return;
    if (cutterDragState) {
        if (!getCutterVideo().paused || (typeof getCutterVideo().requestVideoFrameCallback === 'function' && cutterViewActive)) scheduleCutterPlaybackFrameSync();
        return;
    }
    const video = getCutterVideo();
    const time = metadata?.mediaTime ?? video.currentTime;
    if (!video.paused && cutterPreviewMode) {
        const skipped = findCutterPreviewTime(time, cutterPreviousPlaybackTime);
        if (skipped > time + 1 / cutterEditorState.fps / 2) {
            video.currentTime = cutterSeekTime(skipped);
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
    if (!video.paused || video.seeking || (typeof video.requestVideoFrameCallback === 'function' && cutterViewActive)) scheduleCutterPlaybackFrameSync();
}

function deactivateCutterEditor(): void {
    finishCutterPlayerRange(false);
    cutterViewActive = false;
    syncCutterPlayer();
    const video = getCutterVideo();
    if (!video.paused) video.pause();
    stopCutterPlaybackFrameSync();
    cancelCutterScrubFrames();
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
    cutterViewActive = true;
    syncCutterPlayer();
    void requestCutterAssets();
}

function scheduleCutterPlaybackFrameSync(): void {
    if (cutterPlaybackFrame !== null) return;
    const video = getCutterVideo() as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
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
    cutterPlayerView = window.LocalCutterPlayer.mount(byId('cutterPlayerControls'), {
        video, state: getCutterPlayerState(),
        changeRange: changeCutterPlayerRange, beginRange: beginCutterPlayerRange, finishRange: finishCutterPlayerRange,
        play: () => { void toggleCutterPlayback(); }, seek: time => seekCutterVideo(time),
        frame: stepCutterFrame, format: formatCutterTimecode,
        parse: (value, total) => { const time = parseCutterTimecode(value); return time !== null && time <= total ? time : null; },
    });
    setCutterControlsEnabled(Boolean(cutterEditorState));
    document.querySelectorAll<HTMLButtonElement>('.cutter-speed-options button').forEach((button) => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.rate) === 1));
    });
    video.addEventListener('click', () => { void toggleCutterPlayback(); });
    video.addEventListener('play', () => {
        byId('cutterPreview').classList.add('playing');
        cutterPreviousPlaybackTime = video.currentTime;
        scheduleCutterPlaybackFrameSync();
    });
    video.addEventListener('seeking', scheduleCutterPlaybackFrameSync);
    video.addEventListener('seeked', settleCutterSeek);
    video.addEventListener('pause', () => {
        byId('cutterPreview').classList.remove('playing');
        if (typeof video.requestVideoFrameCallback === 'function' && cutterViewActive) scheduleCutterPlaybackFrameSync();
        else stopCutterPlaybackFrameSync();
        if (cutterEditorState && !cutterDragState && !cutterScrubSeekInFlight && cutterScrubTargetTime === null) updateCutterPlayhead(cutterPresentedTime ?? video.currentTime);
    });
    video.addEventListener('waiting', () => byId('cutterPreview').classList.add('buffering'));
    video.addEventListener('playing', () => byId('cutterPreview').classList.remove('buffering'));
    video.addEventListener('timeupdate', () => {
        if (!video.requestVideoFrameCallback && video.paused && cutterEditorState && !cutterDragState && !cutterScrubSeekInFlight && cutterScrubTargetTime === null) updateCutterPlayhead(video.currentTime);
    });
    window.addEventListener('resize', () => {
        if (!cutterEditorState || !byId('cutterTab').classList.contains('active')) return;
        updateCutterZoom(cutterZoom);
    });
    byId<HTMLInputElement>('cutterZoom').addEventListener('input', (event) => updateCutterZoom(Number((event.currentTarget as HTMLInputElement).value)));
    byId('cutterTimelineScroll').addEventListener('scroll', scheduleCutterWaveformRender, { passive: true });
    byId('cutterTimelineScroll').addEventListener('wheel', zoomCutterTimelineWithWheel, { passive: false });
    byId<HTMLInputElement>('startTime').addEventListener('keydown', (event) => { if (event.key === 'Enter') updateTimeFromInput(); });
    byId<HTMLInputElement>('endTime').addEventListener('keydown', (event) => { if (event.key === 'Enter') updateTimeFromInput(); });
    byId('timeline').addEventListener('pointerdown', (event: PointerEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest('.vod-range-markers, .cutter-cut-overlay')) return;
        beginCutterDrag('playhead', event);
    });
    document.addEventListener('keydown', handleCutterPageKey, true);
    document.addEventListener('keyup', handleCutterPageKeyUp, true);
    window.addEventListener('blur', () => { cutterPageSpaceHeld = false; });
    document.addEventListener('pointermove', moveCutterDrag);
    document.addEventListener('pointerup', endCutterDrag);
    document.addEventListener('pointercancel', cancelCutterDrag);
    window.addEventListener('blur', cancelCutterDrag);
    document.addEventListener('keydown', (event) => {
        if (RendererAccessibility.hasNativeDialog()) return;
        if (event.defaultPrevented || !byId('cutterTab').classList.contains('active') || !cutterEditorState || !cutterControlsEnabled) return;
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
        if (event.key === 'Escape' && cutterCutDraft) { event.preventDefault(); cancelCutterCut(); return; }
        if (event.key === 'Escape' && byId('cutterPlayer').classList.contains('cinema')) { byId('cutterPlayer').classList.remove('cinema'); return; }
        if (shortcutModifier) return;
        if (event.key.toLowerCase() === 'i' || event.key.toLowerCase() === 'o') {
            event.preventDefault(); markCutterBoundary(event.key.toLowerCase() === 'i' ? 'start' : 'end'); return;
        }
        if (target.closest('button, a, input, textarea, select, [role="button"], [role="group"], [role="slider"], [contenteditable="true"]')) return;
        if (event.key === ' ') {
            event.preventDefault();
            void toggleCutterPlayback();
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            stepCutterFrame(direction);
        }
    });
}

function getCutterPlayerState(): LocalCutterViewState {
    const state = cutterEditorState;
    const cut = state?.cuts.find(entry => entry.id === cutterCutDraft?.id) || null;
    const others = state?.cuts.filter(entry => entry.id !== cut?.id) || [];
    return {
        language: currentLanguage, active: Boolean(state) && cutterViewActive, enabled: cutterControlsEnabled,
        duration: state?.duration || 0, fps: state?.fps || 30, name: cutterFile?.name || '', generation: cutterLoadGeneration,
        labels: { start: UI_TEXT.cutter.startLabel, end: UI_TEXT.cutter.endLabel },
        range: state ? { start: state.trimStart, end: state.trimEnd } : null,
        cut: cut ? { ...cut } : null,
        cutLimits: state && cut ? {
            start: Math.max(state.trimStart, ...others.filter(entry => entry.end <= cut.start).map(entry => entry.end)),
            end: Math.min(state.trimEnd, ...others.filter(entry => entry.start >= cut.end).map(entry => entry.start)),
        } : null,
    };
}

function beginCutterPlayerRange(cutId: string | null): void {
    if (!cutterEditorState || !cutterControlsEnabled) return;
    cancelCutterScrubFrames();
    const video = getCutterVideo();
    cutterRangeDrag = { before: cloneCutterState(cutterEditorState), cutId, generation: cutterLoadGeneration, playing: !video.paused };
    video.pause();
}

function changeCutterPlayerRange(start: number, end: number, cutId: string | null, interaction: { source: string; boundary: string }): void {
    if (!cutterEditorState || !cutterControlsEnabled || (cutId ? cutId !== cutterCutDraft?.id : Boolean(cutterCutDraft))) return;
    const before = cloneCutterState(cutterEditorState);
    const changed = cutId ? setCutterCutRange(cutId, start, end) : setCutterTrim(start, end);
    if (!changed) return;
    if (!cutterRangeDrag) commitCutterChange(before);
    updateCutterEditorGeometry(cutId);
    updateCutterEditActions();
    if (interaction.source === 'pointer' && interaction.boundary === 'start') {
        const position = cutId ? cutterEditorState.cuts.find(entry => entry.id === cutId)?.start : cutterEditorState.trimStart;
        if (position !== undefined) queueCutterScrubFrame(position);
    }
}

function finishCutterPlayerRange(commit: boolean): void {
    const drag = cutterRangeDrag;
    cutterRangeDrag = null;
    if (!drag || drag.generation !== cutterLoadGeneration) return;
    if (commit) commitCutterChange(drag.before);
    else { cutterEditorState = cloneCutterState(drag.before); cancelCutterScrubFrames(); }
    renderCutterEditor();
    cutterScrubResumePlayback = drag.playing;
    finishCutterScrubPlayback();
}

function syncCutterPlayer(): void {
    cutterPlayerView?.update(getCutterPlayerState());
}

function updateCutterEditActions(): void {
    const draft = Boolean(cutterCutDraft), disabled = !cutterControlsEnabled;
    byId('cutterEditPanel').dataset.mode = cutterMode;
    byId('cutterPlayer').dataset.mode = cutterMode;
    byId('cutterTrimMode').setAttribute('aria-pressed', String(cutterMode === 'trim'));
    byId('cutterOmitMode').setAttribute('aria-pressed', String(cutterMode === 'omit'));
    byId<HTMLButtonElement>('cutterNewCutBtn').disabled = disabled || draft || (cutterEditorState?.cuts.length || 0) >= cutterMaximumCuts || getCutterPlayableDuration() < 2 / (cutterEditorState?.fps || 30) - cutterFrameTolerance;
    byId<HTMLButtonElement>('btnCut').disabled = disabled || draft || isCutting || !validCutterAudioDuration();
    const audioError = document.getElementById('cutterAudioError');
    if (audioError) audioError.hidden = validCutterAudioDuration();
    byId<HTMLButtonElement>('cutterSaveProjectBtn').disabled = disabled || draft;
    byId<HTMLButtonElement>('cutterOpenProjectBtn').disabled = isCutting || draft;
    byId<HTMLButtonElement>('cutterFullRange').disabled = disabled || draft;
    for (const id of ['startTime', 'endTime', 'cutterMarkStart', 'cutterMarkEnd']) (byId(id) as HTMLInputElement).disabled = disabled || draft;
    byId('cutterTrimMode').setAttribute('aria-label', UI_TEXT.cutter.excerpt);
    byId('cutterOmitMode').setAttribute('aria-label', UI_TEXT.cutter.omit);
    byId('cutterCutCount').setAttribute('aria-label', UI_TEXT.cutter.cutsLabel);
    (byId('cutterTrimMode').querySelector('.cutter-mode-label') as HTMLElement).textContent = UI_TEXT.cutter.excerpt;
    (byId('cutterOmitMode').querySelector('.cutter-mode-label') as HTMLElement).textContent = UI_TEXT.cutter.omit;
    byId('cutterFullRange').textContent = UI_TEXT.cutter.fullVideo;
    byId('cutterMarkStart').textContent = UI_TEXT.cutter.setHere;
    byId('cutterMarkEnd').textContent = UI_TEXT.cutter.setHere;
    byId('cutterOutputLengthLabel').textContent = UI_TEXT.cutter.videoLength;
    byId('cutterFormatSummary').textContent = UI_TEXT.cutter.formatDetails;
    byId('cutterNewCutBtn').querySelector('span')!.textContent = UI_TEXT.cutter.newCut;
    byId('cutterTimeHint').textContent = draft ? UI_TEXT.cutter.confirmHint : UI_TEXT.cutter.timeHint;
    updateCutterExportPresentation();
    updateCutterHistoryButtons();
    syncCutterPlayer();
}

function setCutterMode(mode: 'trim' | 'omit'): void {
    cutterMode = mode;
    updateCutterEditActions();
}

function resetCutterRange(): void {
    if (!cutterEditorState || !cutterControlsEnabled || cutterCutDraft) return;
    const before = cloneCutterState(cutterEditorState);
    if (setCutterTrim(0, cutterEditorState.duration)) { commitCutterChange(before); renderCutterEditor(); }
}

function markCutterBoundary(which: 'start' | 'end'): void {
    if (!cutterEditorState || !cutterControlsEnabled) return;
    if (cutterCutDraft) {
        const cut = cutterEditorState.cuts.find(entry => entry.id === cutterCutDraft!.id);
        if (cut && setCutterCutRange(cut.id, which === 'start' ? getCutterVideo().currentTime : cut.start, which === 'end' ? getCutterVideo().currentTime : cut.end)) renderCutterEditor();
        return;
    }
    const before = cloneCutterState(cutterEditorState), time = getCutterVideo().currentTime;
    if (setCutterTrim(which === 'start' ? time : cutterEditorState.trimStart, which === 'end' ? time : cutterEditorState.trimEnd)) {
        commitCutterChange(before); renderCutterEditor();
    }
}

function editCutterCut(id: string): void {
    if (!cutterEditorState || !cutterControlsEnabled || cutterCutDraft) return;
    cutterCutDraft = { before: cloneCutterState(cutterEditorState), id };
    cutterActiveCutId = id;
    setCutterMode('omit');
    renderCutterEditor();
}

function confirmCutterCut(): void {
    if (!cutterCutDraft || !cutterControlsEnabled) return;
    const invalid = byId('cutterCutList').querySelector('[aria-invalid="true"]');
    if (invalid) { (invalid as HTMLElement).focus(); return; }
    const before = cutterCutDraft.before;
    cutterCutDraft = null;
    cutterActiveCutId = null;
    const unchanged = cutterEditorState && cutterStatesEqual(before, cutterEditorState);
    commitCutterChange(before);
    if (unchanged) scheduleCutterAutosave();
    renderCutterEditor();
}

function cancelCutterCut(): void {
    if (!cutterCutDraft) return;
    cutterEditorState = cloneCutterState(cutterCutDraft.before);
    cutterCutDraft = null;
    cutterActiveCutId = null;
    renderCutterEditor();
    scheduleCutterAutosave();
}

function cancelCutterDrag(): void {
    if (!cutterDragState) return;
    cutterEditorState = cloneCutterState(cutterDragState.before);
    cutterDragFineTime = null;
    cutterDragPointerX = null;
    if (cutterDragAnimationFrame !== null) cancelAnimationFrame(cutterDragAnimationFrame);
    cutterDragAnimationFrame = null;
    cancelCutterScrubFrames();
    endCutterDrag();
}

function getCutterAudioLanguage(language: string | null | undefined): string {
    const code = language?.trim().toLowerCase();
    if (!code || code === 'und' || code === 'zxx') return '';
    try { return new Intl.DisplayNames([currentLanguage], { type: 'language' }).of(code) || code; }
    catch { return code; }
}

function updateCutterExportPresentation(): void {
    const t = UI_TEXT.cutter;
    const archive = cutterExportProfile === 'archive';
    const format = cutterVideoInfo?.sourceFormat;
    const hdr = cutterColorMode === 'source' && format?.hdr;
    const bitDepth = cutterColorMode === 'source' ? format?.bitDepth ?? 8 : 8;
    const colorSelect = document.getElementById('cutterColorMode') as HTMLSelectElement | null;
    if (colorSelect) colorSelect.value = cutterColorMode;
    const multiple = cutterAllAudioStreams && (cutterVideoInfo?.audioStreams.length ?? 0) > 1;
    const stream = cutterVideoInfo?.audioStreams.find(entry => entry.index === cutterAudioStreamIndex);
    const channelText = !stream || stream.channels <= 0 ? '' : stream.channels === 1 ? t.mono : stream.channels === 2 ? t.stereo : formatUiNumber(stream.channels) + ' ' + t.channelPlural;
    const texts: Record<string, string> = {
        cutterAudioProcessingTitle: currentLanguage === 'de' ? 'Audio' : 'Audio',
        cutterAudioFadeInLabel: currentLanguage === 'de' ? 'Einblenden (s)' : 'Fade in (s)',
        cutterAudioFadeOutLabel: currentLanguage === 'de' ? 'Ausblenden (s)' : 'Fade out (s)',
        cutterAudioNormalizeLabel: currentLanguage === 'de' ? 'Lautheit anpassen · −16 LUFS' : 'Normalize loudness · −16 LUFS',
        cutterAudioProcessingHelp: currentLanguage === 'de' ? 'Für den Export · Normalisierung mit 48 kHz' : 'Export only · Normalization at 48 kHz',
        cutterAudioError: currentLanguage === 'de' ? 'Überblendungen kürzen: Ausschnitt ist zu kurz.' : 'Shorten fades: excerpt is too short.',
        cutterProfileQualityLabel: t.profileQuality, cutterProfileBalancedLabel: t.profileBalanced,
        cutterProfileFastLabel: t.profileFast, cutterProfileArchiveLabel: t.profileArchive,
        cutterFormatBadge: archive ? 'MKV' : 'MP4',
        cutterExportCodecs: [archive ? 'FFV1' : hdr || bitDepth > 10 ? 'H.265' : 'H.264', bitDepth + '-Bit', hdr ? 'HDR' : '', stream ? archive ? 'PCM 64-Bit' : 'AAC' : t.noAudio].filter(Boolean).join(' · '),
        cutterColorLabel: t.colorMode, cutterColorSource: t.colorSource, cutterColorSdr: t.colorSdr,
        cutterAudioHelp: multiple ? t.audioStreamCount.replace('{count}', formatUiNumber(cutterVideoInfo!.audioStreams.length)) : stream ? [stream.codec.toUpperCase(), channelText].filter(Boolean).join(' · ') : '',
        cutterExportState: t.exportDraft,
    };
    for (const [id, text] of Object.entries(texts)) {
        const element = document.getElementById(id);
        if (element) element.textContent = text;
    }
    const status = document.getElementById('cutterExportState');
    if (status) status.hidden = !cutterCutDraft;
    document.querySelectorAll<HTMLInputElement>('input[name="cutterProfile"]').forEach(input => {
        input.checked = input.value === cutterExportProfile;
        input.disabled = !cutterControlsEnabled || Boolean(cutterExportOptions && !cutterExportOptions.profiles.some(profile => profile.id === input.value));
    });
}

let cutterPageSpaceHeld = false;

function handleCutterPageKey(event: KeyboardEvent): void {
    if (RendererAccessibility.hasNativeDialog()) return;
    if (!byId('cutterTab').classList.contains('active') || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('.modal-overlay, [aria-modal="true"]')) return;
    const field = target.closest('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]');
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (field && !target.matches('select, input[readonly]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || cutterPageSpaceHeld) return;
    cutterPageSpaceHeld = true;
    if (cutterEditorState && cutterControlsEnabled) void toggleCutterPlayback();
}

function handleCutterPageKeyUp(event: KeyboardEvent): void {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (RendererAccessibility.hasNativeDialog()) { cutterPageSpaceHeld = false; return; }
    if (cutterPageSpaceHeld) {
        event.preventDefault();
        event.stopPropagation();
        cutterPageSpaceHeld = false;
    }
}

function setCutterAudioProcessing(): void {
    const fadeIn = byId<HTMLInputElement>('cutterAudioFadeIn'), fadeOut = byId<HTMLInputElement>('cutterAudioFadeOut');
    const duration = getCutterPlayableDuration();
    const start = fadeIn.valueAsNumber, end = fadeOut.valueAsNumber;
    const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= 0 && start + end <= duration;
    fadeIn.setCustomValidity(valid ? '' : (currentLanguage === 'de' ? 'Überblendung ist länger als der Ausschnitt.' : 'Fades exceed the excerpt duration.'));
    if (!valid) { fadeIn.reportValidity(); syncCutterAudioProcessing(); return; }
    cutterAudioProcessing = { fadeInSeconds: start, fadeOutSeconds: end, normalize: byId<HTMLInputElement>('cutterAudioNormalize').checked };
    updateCutterEditActions();
    scheduleCutterAutosave();
}
function syncCutterAudioProcessing(): void {
    const start = document.getElementById('cutterAudioFadeIn') as HTMLInputElement | null, end = document.getElementById('cutterAudioFadeOut') as HTMLInputElement | null;
    if (start) { start.value = String(cutterAudioProcessing.fadeInSeconds); start.setCustomValidity(''); }
    if (end) end.value = String(cutterAudioProcessing.fadeOutSeconds);
    const normalize = document.getElementById('cutterAudioNormalize') as HTMLInputElement | null;
    if (normalize) normalize.checked = cutterAudioProcessing.normalize;
}

function validCutterAudioDuration(): boolean {
    return cutterAudioProcessing.fadeInSeconds + cutterAudioProcessing.fadeOutSeconds <= getCutterPlayableDuration() + 0.000001;
}
