import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

function fragment(file: string, start: string, end: string): string {
    const source = readFileSync(join(__dirname, file), 'utf8');
    return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function execute(source: string, bindings: Record<string, unknown>) {
    const context = createContext(bindings);
    runInContext(transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText, context);
    return (code: string) => runInContext(code, context);
}

describe('renderer close persistence', () => {
    it('flushes frame-delayed metadata and waits for both workspace saves', async () => {
        let finishClip!: (saved: boolean) => void;
        let finishMerge!: (saved: boolean) => void;
        let clipSaves = 0;
        const run = execute(fragment('renderer.ts', 'const workspaceSaves =', 'function receiveClipProgress'), {
            workspaceLoading: false, clipMetadataDirty: true, clipBatchItems: [{ url: 'clip', label: 'Fresh title' }],
            currentLanguage: 'en', showClipNotice: () => undefined, showAppToast: () => undefined,
            window: { api: { saveClipWorkspace: () => { clipSaves++; return new Promise(resolve => { finishClip = resolve; }); } } },
            mergeSave: () => new Promise(resolve => { finishMerge = resolve; }),
        });
        run("void trackWorkspaceSave('merge', mergeSave)");
        let closed = false;
        const closing = (run('flushWorkspaceBeforeClose()') as Promise<boolean>).then(result => { closed = true; return result; });
        expect(clipSaves).toBe(1);
        expect(closed).toBe(false);
        finishClip(true);
        await Promise.resolve();
        expect(closed).toBe(false);
        finishMerge(true);
        expect(await closing).toBe(true);
        expect(run('clipMetadataDirty')).toBe(false);
    });

    it('refuses close after failed workspace persistence', async () => {
        const run = execute(fragment('renderer.ts', 'const workspaceSaves =', 'function receiveClipProgress'), {
            workspaceLoading: false, clipMetadataDirty: true, clipBatchItems: [], currentLanguage: 'en',
            showClipNotice: () => undefined, showAppToast: () => undefined,
            window: { api: { saveClipWorkspace: async () => false } },
        });
        expect(await run('flushWorkspaceBeforeClose()')).toBe(false);
    });

    it('waits for an in-flight settings save and its newer pending value', async () => {
        const saves: Array<(value: unknown) => void> = [];
        let fingerprint = 'first';
        const run = execute(`
            let settingsAutoSaveTimer = null, lastPersistedSettingsFingerprint = '', settingsInputGeneration = 0;
            let settingsAutoSaveInFlight = false, pendingSettingsAutoSave = false, pendingCredentialsReconnect = false;
            let settingsSaveFailed = false, config = {};
            const settingsSaveWaiters = new Set();
            ${fragment('renderer-settings.ts', 'async function flushSettingsAutoSave(', 'function scheduleSettingsAutoSave')}
        `, {
            collectAutoSavePayload: () => ({}), getSettingsFingerprint: () => fingerprint,
            persistSecretInputs: async () => undefined,
            setSettingsSaveFailed: (failed: boolean) => run(`settingsSaveFailed = ${failed}`),
            window: { api: { saveConfig: () => new Promise(resolve => saves.push(resolve)) } },
        });
        const first = run('flushSettingsAutoSave()') as Promise<void>;
        await new Promise(resolve => setImmediate(resolve));
        fingerprint = 'second';
        run('settingsInputGeneration++');
        let closed = false;
        const closing = (run('flushSettingsBeforeClose()') as Promise<boolean>).then(result => { closed = true; return result; });
        saves[0]({});
        await first;
        await new Promise(resolve => setImmediate(resolve));
        expect(closed).toBe(false);
        expect(saves.length).toBe(2);
        saves[1]({});
        expect(await closing).toBe(true);
    });
});
