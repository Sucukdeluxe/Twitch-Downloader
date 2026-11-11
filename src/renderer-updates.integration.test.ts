import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

class Element {
    hidden = false;
    disabled = false;
    textContent = '';
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    attributes = new Map<string, string>();
    classes = new Set<string>();
    classList = {
        add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
        contains: (name: string) => this.classes.has(name),
        toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
    };
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    addEventListener(): void { /* No browser events in the IPC harness. */ }
    querySelector(): null { return null; }
}

function runtime() {
    const elements = new Map<string, Element>();
    const element = (id: string): Element => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id)!;
    };
    const events: Record<string, (payload?: unknown) => void> = {};
    const warnings: string[] = [];
    const storage = new Map<string, string>();
    const api: Record<string, unknown> = {
        checkUpdate: async () => ({}),
        downloadUpdate: async () => ({ downloading: true }),
        installUpdate: async () => ({ installing: true }),
    };
    for (const name of ['Checking', 'Available', 'NotAvailable', 'DownloadProgress', 'Downloaded', 'Error', 'InstallError']) {
        api[`onUpdate${name}`] = (callback: (payload?: unknown) => void) => { events[name] = callback; };
    }
    const context = createContext({
        window: { api, setTimeout: () => 1, showAppToast: (text: string) => warnings.push(text) },
        document: { addEventListener: () => undefined, querySelector: () => null },
        byId: element,
        updateReady: false,
        appVersion: '1.1.20',
        UI_TEXT: { static: { checkUpdates: 'Check' }, updates: {
            checking: 'Checking', checkFailed: 'Check failed', downloadFailed: 'Download failed',
            downloading: 'Downloading', downloadLabel: 'Download', downloadNow: 'Download now',
            installFailed: 'Install failed', ready: 'Ready', installNow: 'Install now',
        } },
        safeLocalStorageGet: (key: string) => storage.get(key) || '',
        safeLocalStorageSet: (key: string, value: string) => storage.set(key, value),
        safeLocalStorageRemove: (key: string) => storage.delete(key),
        RendererAccessibility: {
            closeDialog: (id: string) => element(id).classList.remove('show'),
            openDialog: (id: string) => element(id).classList.add('show'),
        },
    });
    const source = readFileSync(join(__dirname, 'renderer-updates.ts'), 'utf8');
    runInContext(transpileModule(source, { compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 } }).outputText, context);
    return { element, events, warnings, api, run: (code: string) => runInContext(code, context) };
}

describe('production updater renderer', () => {
    it('keeps automatic check failures quiet while reporting a manual failure once', async () => {
        const view = runtime();
        view.events.Error({ kind: 'check' });
        expect(view.warnings).toEqual([]);
        view.api.checkUpdate = async () => { view.events.Error({ kind: 'check' }); return { error: true }; };
        await view.run('checkUpdate()');
        expect(view.warnings).toEqual(['Check failed']);
        expect(view.element('checkUpdateBtn').disabled).toBe(false);
    });

    it('keeps a dismissed download pending and recovers once from IPC plus result failure', async () => {
        const view = runtime();
        view.events.Available({ version: '1.1.21' });
        let finish!: (result: unknown) => void;
        view.api.downloadUpdate = () => new Promise(resolve => { finish = resolve; });
        view.run('downloadUpdate(); dismissWorkspaceUpdatePopover();');
        expect(view.element('updateBanner').dataset.updateState).toBe('downloading');
        expect(view.element('updateButton').disabled).toBe(true);
        expect(view.element('updateModalConfirmBtn').disabled).toBe(true);
        view.events.DownloadProgress({ percent: 50, transferred: 50, total: 100 });
        expect(view.element('updateBanner').classList.contains('show')).toBe(false);
        view.events.Error({ kind: 'download', version: '1.1.21' });
        finish({ error: true });
        await Promise.resolve();
        await Promise.resolve();
        expect(view.warnings).toEqual(['Download failed']);
        expect(view.element('updateButton').disabled).toBe(false);
        expect(view.element('updateModalConfirmBtn').disabled).toBe(false);
        expect(view.element('updateBanner').dataset.updateState).toBe('available');
    });

    it('suppresses a skipped version automatically but resurfaces it on manual check', async () => {
        const view = runtime();
        view.events.Available({ version: '1.1.21' });
        view.run('skipUpdateVersion()');
        view.events.Available({ version: '1.1.21' });
        expect(view.element('updateBanner').hidden).toBe(true);
        view.api.checkUpdate = async () => {
            // Test the banner without rendering release-note DOM.
            view.run('shouldOpenUpdateModalOnAvailable = false');
            view.events.Available({ version: '1.1.21' });
            return {};
        };
        await view.run('checkUpdate()');
        expect(view.element('updateBanner').hidden).toBe(false);
        expect(view.element('updateBanner').dataset.updateState).toBe('available');
    });

    it('serializes installation and keeps the downloaded update available after failure', async () => {
        const view = runtime();
        view.run("setDownloadReadyUi({version:'1.1.21'})");
        let finish!: (result: unknown) => void;
        let calls = 0;
        view.api.installUpdate = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
        const first = view.run('installReadyUpdate()');
        await view.run('installReadyUpdate()');
        expect(calls).toBe(1);
        finish({ error: true, message: 'Archive unavailable' });
        await first;
        expect(view.warnings).toEqual(['Install failed Archive unavailable']);
        expect(view.element('updateBanner').dataset.updateState).toBe('ready');
        view.api.installUpdate = async () => { calls++; return { installing: true }; };
        await view.run('installReadyUpdate()');
        expect(calls).toBe(2);
    });
});
