import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, test } from 'vitest';

function sourceFragment(start: string, end: string): string {
    const source = readFileSync(join(__dirname, 'renderer-cutter.ts'), 'utf8');
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error('Missing renderer cutter production fragment');
    return source.slice(from, to);
}

function evaluate(source: string, context: Record<string, unknown>, expose: string): Record<string, (...args: unknown[]) => unknown> {
    context.globalThis = context;
    context.window = context;
    const compiled = transpileModule(`${source}\nObject.assign(globalThis, { __cutterProductionPath: { ${expose} } });`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, context);
    return (context as { __cutterProductionPath: Record<string, (...args: unknown[]) => unknown> }).__cutterProductionPath;
}

describe('cutter production paths', () => {
    test('opens a saved project without first overwriting its autosave', async () => {
        let saves = 0;
        let opens = 0;
        const api = evaluate(sourceFragment('async function openCutterProject', 'function setCutterExportProfile'), {
            cutterFile: { token: 'source-capability' },
            persistCutterProject: async () => { saves += 1; return true; },
            applyCutterProject: () => true,
            renderCutterProjectRecovery: () => undefined,
            showAppToast: () => undefined,
            api: {
                openCutterProject: async () => {
                    opens += 1;
                    return { trimStart: 42 };
                },
            },
        }, 'openCutterProject');

        await api.openCutterProject();

        expect(opens).toBe(1);
        expect(saves).toBe(0);
    });

    test('does not autosave while recovery still requires a user decision', async () => {
        const scheduled: Array<() => void> = [];
        let saves = 0;
        const file = { token: 'source-capability' };
        const api = evaluate(sourceFragment('function scheduleCutterAutosave', 'function renderCutterProjectRecovery'), {
            cutterAutosaveTimer: null,
            cutterSaveRevision: 0,
            cutterRecoveryDecisionPending: true,
            cutterFile: file,
            persistCutterProject: async () => { saves += 1; return true; },
            setTimeout: (callback: () => void) => {
                scheduled.push(callback);
                return scheduled.length;
            },
            clearTimeout: () => undefined,
        }, 'scheduleCutterAutosave');

        api.scheduleCutterAutosave();
        scheduled[0]();
        await Promise.resolve();

        expect(saves).toBe(0);
    });

    test('offers recovery before enabling edits or starting the encoder probe', async () => {
        const events: string[] = [];
        const elements = new Map<string, Record<string, unknown>>();
        const element = (): Record<string, unknown> => ({
            hidden: false,
            disabled: false,
            textContent: '',
            value: '1',
            classList: { add: () => undefined, remove: () => undefined },
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
            removeAttribute: () => undefined,
        });
        [
            'cutterPreview', 'cutterPlayerLoading', 'cutterPreviewEmpty', 'cutterWorkspace', 'btnCut', 'cutterZoom', 'cutterFilePath',
            'cutterInfo', 'timelineContainer', 'infoDuration', 'infoResolution', 'infoFps', 'cutterTotalTime', 'cutterWaveform',
            'cutterAudioEmpty', 'cutterPlaybackRate',
        ].forEach((id) => elements.set(id, element()));
        const video = { pause: () => undefined, removeAttribute: () => undefined, load: () => undefined, src: '', playbackRate: 1 };
        const file = { token: 'source-capability', name: 'source.mp4' };
        const api = evaluate(sourceFragment('async function loadCutterFromPath', 'function resolveCutterDiscard'), {
            isCutting: false,
            cutterLoadGeneration: 0,
            cutterEditorState: null,
            cutterFile: null,
            cutterMediaJobId: null,
            cutterAssetsPixelWidth: 0,
            cutterAssetsPixelHeight: 0,
            cutterAssetsInFlightJobId: null,
            cutterAssetsInFlightPixelWidth: 0,
            cutterAssetsInFlightPixelHeight: 0,
            cutterAssetRefreshTimer: null,
            cutterVideoInfo: null,
            cutterHistoryPast: [],
            cutterHistoryFuture: [],
            cutterSaveRevision: 0,
            cutterSavedRevision: 0,
            cutterActiveCutId: null,
            cutterExportProfile: 'balanced',
            cutterExportEncoder: 'software',
            cutterAudioStreamIndex: 0,
            cutterZoom: 1,
            byId: (id: string) => elements.get(id),
            getCutterVideo: () => video,
            stopCutterPlaybackFrameSync: () => undefined,
            cancelCutterScrubFrames: () => undefined,
            updateCutterPlayUi: () => undefined,
            setCutterControlsEnabled: (enabled: boolean) => events.push(enabled ? 'enable' : 'disable'),
            renderCutterProjectRecovery: (project: unknown) => { if (project) events.push('offer'); },
            updateCutterAudioStreams: () => undefined,
            getInitialCutterZoom: () => 1,
            animateCutterWorkspaceReveal: () => undefined,
            renderCutterThumbnails: () => undefined,
            updateCutterZoom: () => undefined,
            renderCutterEditor: () => undefined,
            updateCutterPlayhead: () => undefined,
            formatCutterTimecode: () => '00:00:00',
            loadCutterExportOptions: async () => { events.push('probe'); },
            requestCutterWaveform: () => undefined,
            requestCutterAssets: () => undefined,
            showAppToast: () => undefined,
            UI_TEXT: { cutter: { unsupportedFile: 'unsupported' } },
            clearTimeout: () => undefined,
            api: {
                prepareVideoEditorMedia: async () => ({
                    jobId: 7,
                    sourceUrl: 'file:///source.mp4',
                    thumbnails: [],
                    info: { duration: 90, fps: 30, width: 1920, height: 1080, hasAudio: true, audioStreams: [{ index: 0 }] },
                }),
                getCutterProjectRecovery: async () => {
                    events.push('recovery');
                    return { trimStart: 12 };
                },
            },
        }, 'loadCutterFromPath');

        await api.loadCutterFromPath(file);
        await Promise.resolve();
        await Promise.resolve();

        expect(events.indexOf('recovery')).toBeLessThan(events.indexOf('enable'));
        expect(events.indexOf('offer')).toBeLessThan(events.indexOf('probe'));
    });
});
