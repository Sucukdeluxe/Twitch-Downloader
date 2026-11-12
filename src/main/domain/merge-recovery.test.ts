import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueItem } from '../../types';
import { isPreciseMergeArtifact, recoverInterruptedMergeArtifacts } from './merge-recovery';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(names: string[]): { root: string; files: string[]; item: QueueItem } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-merge-recovery-'));
    roots.push(root);
    const files = names.map(name => { const file = path.join(root, name); fs.writeFileSync(file, 'owned temporary media'); return file; });
    return { root, files, item: { id: 'fixture', title: 'fixture', url: '', date: '', streamer: '', duration_str: '',
        status: 'downloading', progress: 30, artifactRoot: root,
        mergeGroup: { items: [], mergePhase: 'merging', currentItemIndex: 0, downloadedFiles: Object.fromEntries(files.map((file, i) => [i, file])) } } };
}

describe('precise merge recovery after filename collisions', () => {
    it('retains the version marker when a unique filename suffix is appended', () => {
        for (const name of ['merge_tmp_1_1794450000000_1123.mp4', 'merge_tmp_1_1794450000000_1123_1.mp4', '.merge_output_1794450000000_123_1123_22.mp4']) {
            expect(isPreciseMergeArtifact(name)).toBe(true);
        }
        for (const name of ['merge_tmp_1_1794450000000.mp4', 'merge_tmp_1_2_1123_0.mp4', 'merge_tmp_1_2_1123_1_2.mp4', 'family_1123.mp4']) {
            expect(isPreciseMergeArtifact(name)).toBe(false);
        }
    });
    it('cleans actual collision artifacts and allows an interrupted job to restart', () => {
        const { root, files, item } = fixture(['merge_tmp_1_1794450000000_1123_1.mp4', '.merge_output_1794450000000_123_1123_1.mp4']);
        const result = recoverInterruptedMergeArtifacts([item], root, new Set([item.id]));
        expect(result.failedFiles).toEqual([]);
        expect(result.removedFiles).toEqual(files);
        expect(files.every(file => !fs.existsSync(file))).toBe(true);
        expect(result.queue[0].status).toBe('pending');
        expect(result.queue[0].mergeRecoveryBlocked).toBeUndefined();
        expect(result.queue[0].mergeGroup?.downloadedFiles).toEqual({});
    });
    it('still refuses unrelated and malformed filenames in the download folder', () => {
        const { root, files, item } = fixture(['family_1123.mp4', 'merge_tmp_1_2_1123_1_2.mp4']);
        const result = recoverInterruptedMergeArtifacts([item], root, new Set([item.id]));
        expect(result.failedFiles).toEqual(files);
        expect(files.every(file => fs.existsSync(file))).toBe(true);
        expect(result.queue[0].mergeRecoveryBlocked).toBe(true);
    });
});
