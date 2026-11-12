import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const handlerStart = mainSource.indexOf("ipcMain.handle('merge-videos'");
const handlerEnd = mainSource.indexOf("\nipcMain.handle('select-multiple-videos'", handlerStart);
if (handlerStart < 0 || handlerEnd < handlerStart) throw new Error('Production merge handler was not found');
const handlerScript = ts.transpileModule(mainSource.slice(handlerStart, handlerEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

type Sender = { send: ReturnType<typeof vi.fn>; isDestroyed(): boolean };
type MergeHandler = (event: { sender: Sender }, inputs: string[], output: string) => Promise<{ success: boolean; outputName: string | null }>;

function harness(platform: 'darwin' | 'win32') {
    let handler!: MergeHandler;
    let complete!: (success: boolean) => void;
    let originalDestroyed = false;
    const original: Sender = { send: vi.fn(), isDestroyed: () => originalDestroyed };
    const replacement: Sender = { send: vi.fn(), isDestroyed: () => false };
    const paths: Record<string, string> = { first: '/fixture/first.mp4', second: '/fixture/second.mp4', output: '/fixture/merged.mp4' };
    const mergeVideos = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
    const context = createContext({
        ipcMain: { handle: (_name: string, callback: MergeHandler) => { handler = callback; } },
        isTrustedRendererEvent: () => true, applicationBackupBusy: false, applicationWorkflowBusy: () => false,
        cutterExportActive: false, workspaceMergeActive: false, workspaceMergeProgress: 0, appShutdownStarted: false,
        resolveFileCapability: (_event: unknown, token: string) => paths[token],
        mergeWorkspaceFiles: new Map([
            ['first', { path: paths.first, durationSeconds: 2 }],
            ['second', { path: paths.second, durationSeconds: 2 }],
        ]),
        publishCapabilityOutput: async (_output: string, produce: (partial: string) => Promise<boolean>) => produce('/fixture/partial.mp4'),
        mergeVideos, mainWindow: { webContents: original }, workspaceSession: { mergeFiles: ['first', 'second'], save: vi.fn() },
        appendDebugLog: vi.fn(), process: { platform }, path,
    });
    runInContext(handlerScript, context);
    const pending = handler({ sender: original }, ['first', 'second'], 'output');
    expect(mergeVideos).toHaveBeenCalledTimes(1);
    return {
        context, original, replacement, pending, complete: (success: boolean) => complete(success),
        closeOriginal: () => { originalDestroyed = true; },
    };
}

describe('production workspace merge completion routing', () => {
    it.each([true, false])('delivers a pending Mac merge result (%s) to a window reopened during export', async success => {
        const state = harness('darwin');
        state.closeOriginal();
        state.context.mainWindow = { webContents: state.replacement };
        state.complete(success);

        const result = await state.pending;

        expect(result.success).toBe(success);
        expect(state.original.send).not.toHaveBeenCalled();
        expect(state.replacement.send).toHaveBeenCalledExactlyOnceWith('merge-finished', {
            success, outputName: success ? 'merged.mp4' : null,
        });
        expect(state.context.workspaceMergeActive).toBe(false);
    });

    it('finishes safely when the Mac window closes without reopening', async () => {
        const state = harness('darwin');
        state.closeOriginal();
        state.context.mainWindow = null;
        state.complete(true);
        await expect(state.pending).resolves.toMatchObject({ success: true });
        expect(state.original.send).not.toHaveBeenCalled();
    });

    it('preserves delivery to the original sender on Windows', async () => {
        const state = harness('win32');
        state.context.mainWindow = { webContents: state.replacement };
        state.complete(true);
        await state.pending;
        expect(state.original.send).toHaveBeenCalledExactlyOnceWith('merge-finished', { success: true, outputName: 'merged.mp4' });
        expect(state.replacement.send).not.toHaveBeenCalled();
    });
});
