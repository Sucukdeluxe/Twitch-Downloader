import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRecentCutterProjectsStore, openPortableCutterProject, savePortableCutterProject, validatePortableCutterEdit, type PortableCutterEdit } from './portable-cutter-project';

let directory: string;
let project: PortableCutterEdit;

beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-portable-mac-'));
    const sourcePath = path.join(directory, 'source.mp4');
    await fs.writeFile(sourcePath, 'portable source fixture');
    const stat = await fs.stat(sourcePath);
    project = {
        source: { path: sourcePath, size: stat.size, mtimeMs: stat.mtimeMs },
        duration: 120, fps: 30, trimStart: 5, trimEnd: 100,
        cuts: [{ id: 'excluded', start: 40, end: 50 }],
        profile: 'quality', encoder: 'h264_videotoolbox', audioStreamIndex: 1,
        allAudioStreams: true, colorMode: 'source',
    };
});

afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('portable Mac cutter projects', () => {
    it('saves and reopens a VideoToolbox project with its editing settings intact', async () => {
        const projectPath = path.join(directory, 'project.tvmproject');
        const saved = await savePortableCutterProject(projectPath, 'Mac edit', project);
        const reopened = await openPortableCutterProject(projectPath);

        expect(saved.edit.encoder).toBe('h264_videotoolbox');
        expect(reopened.sourceStatus).toBe('ready');
        expect(reopened.project).toEqual(project);
        expect(reopened.document.id).toBe(saved.id);
    });

    it('continues rejecting unsupported encoder values', () => {
        expect(() => validatePortableCutterEdit({ ...project, encoder: 'untrusted-encoder' })).toThrow('Invalid cutter edit');
    });

    it.runIf(process.platform !== 'win32')('keeps distinct case-sensitive project paths when remembering and removing recents', async () => {
        const upper = path.join(directory, 'Project.tvmcut');
        const lower = path.join(directory, 'project.tvmcut');
        const document = await savePortableCutterProject(upper, 'Mac edit', project);
        const store = createRecentCutterProjectsStore(path.join(directory, 'recent.json'));

        await store.remember(upper, document);
        await store.remember(lower, { ...document, id: 'second-project', name: 'Another edit' });
        expect((await store.list()).map(entry => entry.filePath)).toEqual([lower, upper]);

        await store.remove(lower);
        expect((await store.list()).map(entry => entry.filePath)).toEqual([upper]);
    });
});
