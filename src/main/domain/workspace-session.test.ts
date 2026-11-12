import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceSessionStore } from './workspace-session';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-workspace-shutdown-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

describe('required workspace persistence', () => {
    it('flushes pending clip and merge state before shutdown continues', async () => {
        const filename = path.join(directory, 'workspace-session.json');
        const store = new WorkspaceSessionStore(filename, vi.fn());
        store.clips = [{ url: 'https://clips.twitch.tv/example', label: 'Clip', streamer: 'channel', metadataState: 'ready', state: 'ready' }];
        store.mergeFiles = [{ id: 'source', path: path.join(directory, 'source.mp4'), size: 512, mtimeMs: 100 }];
        const pending = store.save();

        store.flushOrThrow();

        expect(await pending).toBe(true);
        const reopened = new WorkspaceSessionStore(filename, vi.fn());
        expect(reopened.clips).toMatchObject(store.clips);
        expect(reopened.mergeFiles).toMatchObject(store.mergeFiles);
    });

    it('throws on disk failure and retains dirty state for a successful retry', async () => {
        const parent = path.join(directory, 'blocked');
        fs.writeFileSync(parent, 'not a directory');
        const filename = path.join(parent, 'workspace-session.json');
        const onError = vi.fn();
        const store = new WorkspaceSessionStore(filename, onError);
        store.clips = [{ url: 'https://clips.twitch.tv/example', label: 'Unsaved clip', streamer: 'channel', metadataState: 'ready', state: 'ready' }];
        const pending = store.save();

        expect(() => store.flushOrThrow()).toThrow('Workspace session could not be saved');
        expect(await pending).toBe(false);
        expect(onError).toHaveBeenCalled();
        fs.rmSync(parent);

        expect(() => store.flushOrThrow()).not.toThrow();
        expect(new WorkspaceSessionStore(filename, vi.fn()).clips).toMatchObject(store.clips);
    });
});
