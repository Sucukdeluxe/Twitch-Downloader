import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

function startup(fail?: 'config' | 'cutter') {
    const events: string[] = [];
    const elements = new Map<string, Record<string, unknown>>();
    const noops = [
        'markQueueActivity', 'restoreDevelopmentUpdatePreview', 'setPageTitle', 'updateLanguagePicker', 'setSettingsPane',
        'initSettingsAutoSave', 'initializeCleanupPreview', 'applyRendererTheme', 'renderStreamers', 'hydrateStreamerDisplayNames',
        'renderQueue', 'initQueueDragDrop', 'updateDownloadButtonState', 'updateStatusBarQueueSummary', 'loadPersistedVodFilter',
        'syncVodFilterClearButton', 'loadPersistedVodSort', 'refreshVodSortSelectLabels', 'syncVodSortSelect',
        'loadPersistedHideDownloaded', 'syncVodHideDownloadedToggle', 'loadVodScrollPositions', 'initVodScrollTracking',
        'initCutterDragDrop', 'initializeEditingWorkflows', 'initializeVodLibrary', 'initSegmentedIndicators',
        'loadPersistedActiveTab', 'showTab', 'receiveCutterWaveformProgress', 'updateStatsBar', 'startStatsBarPolling', 'scheduleQueueSync',
    ];
    const api: Record<string, unknown> = {
        getConfig: async () => { if (fail === 'config') throw new Error('Config unavailable'); return {}; },
        getSecretStatus: async () => ({}), getQueue: async () => [], isDownloading: async () => false,
        getVersion: async () => '1.1.20', notifyRendererReady: () => events.push('ready'),
    };
    for (const name of ['QueueUpdated', 'QueueDuplicateSkipped', 'DownloadProgress', 'AutoVodScanCompleted', 'DownloadStarted', 'DownloadPaused', 'DownloadFinished', 'VideoEditorWaveformProgress', 'CutProgress', 'MergeProgress']) {
        api[`on${name}`] = () => events.push(`on${name}`);
    }
    const context: Record<string, unknown> = {
        ...Object.fromEntries(noops.map(name => [name, () => events.push(name)])),
        window: { api },
        performance: { mark: (name: string) => events.push(name) },
        document: { getElementById: () => null, addEventListener: () => events.push('listener') },
        byId: (id: string) => {
            if (!elements.has(id)) elements.set(id, { dataset: {} });
            return elements.get(id);
        },
        setLanguage: () => 'en',
        initCutterEditor: () => { if (fail === 'cutter') throw new Error('Player failed'); events.push('cutter'); },
        restoreWorkspace: () => new Promise(() => undefined),
        setTimeout: () => events.push('deferred-services'),
        UI_TEXT: { appName: 'Twitch VOD Manager' },
        SECRET_INPUT_MASK: '••••', DEFAULT_VOD_TEMPLATE: '', DEFAULT_PARTS_TEMPLATE: '', DEFAULT_CLIP_TEMPLATE: '',
        QUEUE_SYNC_DEFAULT_MS: 1800,
    };
    const source = readFileSync(join(__dirname, 'renderer.ts'), 'utf8');
    const init = source.slice(source.indexOf('async function init()'), source.indexOf('async function startRendererServices('));
    const code = transpileModule(init, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText;
    const result = runInNewContext(`${code}\ninit()`, context) as Promise<void>;
    return { result, events, elements };
}

describe('renderer health acknowledgement', () => {
    it('signals readiness after essential UI initialization without waiting for network services', async () => {
        const app = startup();
        await app.result;
        expect(app.events.indexOf('ready')).toBeGreaterThan(app.events.indexOf('cutter'));
        expect(app.events.indexOf('ready')).toBeGreaterThan(app.events.indexOf('initializeEditingWorkflows'));
        expect(app.events.indexOf('ready')).toBeGreaterThan(app.events.indexOf('tvm:ui-ready'));
        expect(app.events.indexOf('deferred-services')).toBeGreaterThan(app.events.indexOf('ready'));
        expect(app.elements.get('versionInfo')?.textContent).toBe('Version: v1.1.20');
    });

    it.each(['config', 'cutter'] as const)('does not acknowledge a failed %s initialization', async fail => {
        const app = startup(fail);
        await expect(app.result).rejects.toThrow();
        expect(app.events).not.toContain('ready');
    });
});

describe('clip directory platform fallback', () => {
    it.each([
        ['darwin', '/Users/test/Videos/', undefined, '/Users/test/Videos/Clips'],
        ['linux', '/home/test/Videos///', undefined, '/home/test/Videos/Clips'],
        ['win32', 'C:\\Videos\\', undefined, 'C:\\Videos\\Clips'],
        ['darwin', '/Users/test/Videos/', '/Volumes/Clips/Custom', '/Volumes/Clips/Custom'],
    ])('uses the configured directory on %s', (platform, downloadPath, clipPath, expected) => {
        const source = readFileSync(join(__dirname, 'renderer.ts'), 'utf8');
        const from = source.indexOf('function getClipDownloadDirectory()');
        const code = source.slice(from, source.indexOf('function syncClipStorage()', from));
        const compiled = transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText;
        expect(runInNewContext(`${compiled}\ngetClipDownloadDirectory()`, {
            window: { api: { platform } }, config: { download_path: downloadPath, clip_download_path: clipPath },
        })).toBe(expected);
    });
});
