import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QueueItem } from '../../types';

export interface MergeRecoveryResult {
    queue: QueueItem[];
    removedFiles: string[];
    failedFiles: string[];
    changed: boolean;
}

type ArtifactKind = 'internal' | 'published-split';
type RemovalResult = 'removed' | 'missing' | 'failed';

export interface MergeArtifactRootResolution {
    artifactRoot: string | null;
    migrated: boolean;
}

function canonicalizeExistingPrefix(candidatePath: string): string {
    let existingPath = path.resolve(candidatePath);
    const missingSegments: string[] = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync.native(existingPath), ...missingSegments.reverse());
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return path.resolve(candidatePath);
            const parentPath = path.dirname(existingPath);
            if (parentPath === existingPath) return path.resolve(candidatePath);
            missingSegments.push(path.basename(existingPath));
            existingPath = parentPath;
        }
    }
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(canonicalizeExistingPrefix(root), canonicalizeExistingPrefix(candidate));
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function canonicalRoot(root: string): string | null {
    if (!path.isAbsolute(root)) return null;
    const resolved = path.resolve(root);
    try {
        return fs.statSync(resolved).isDirectory() ? fs.realpathSync.native(resolved) : null;
    } catch {
        return resolved;
    }
}

function collectMergeArtifacts(group: NonNullable<QueueItem['mergeGroup']>): Map<string, { filePath: string; kind: ArtifactKind }> {
    const artifacts = new Map<string, { filePath: string; kind: ArtifactKind }>();
    const addArtifact = (filePath: string, kind: ArtifactKind): void => {
        const resolved = path.resolve(filePath);
        const existing = artifacts.get(resolved);
        if (!existing || kind === 'internal') artifacts.set(resolved, { filePath, kind });
    };
    for (const filePath of Object.values(group.downloadedFiles)) addArtifact(filePath, 'internal');
    if (group.mergedFile) addArtifact(group.mergedFile, 'internal');
    for (const filePath of group.splitTempFiles ?? []) addArtifact(filePath, 'internal');
    for (const filePath of group.splitFiles ?? []) addArtifact(filePath, 'published-split');
    return artifacts;
}

function isPlausiblyInsideRoot(root: string, candidate: string): boolean {
    if (!isInside(root, candidate)) return false;
    if (!fs.existsSync(candidate)) return true;
    try {
        const resolvedRoot = canonicalRoot(root);
        if (!resolvedRoot) return false;
        return isInside(resolvedRoot, fs.realpathSync.native(candidate));
    } catch {
        return false;
    }
}

export function resolveMergeArtifactRoot(item: QueueItem, currentDownloadRoot: string): MergeArtifactRootResolution {
    if (typeof item.artifactRoot === 'string' && item.artifactRoot) {
        const resolved = canonicalRoot(item.artifactRoot);
        return { artifactRoot: resolved, migrated: resolved !== null && resolved !== item.artifactRoot };
    }
    const resolved = canonicalRoot(currentDownloadRoot);
    if (!resolved || !item.mergeGroup) return { artifactRoot: null, migrated: false };
    const plausible = [...collectMergeArtifacts(item.mergeGroup).values()]
        .every(({ filePath }) => isPlausiblyInsideRoot(resolved, filePath));
    return plausible
        ? { artifactRoot: resolved, migrated: true }
        : { artifactRoot: null, migrated: false };
}

function isInternalMergeArtifact(filePath: string): boolean {
    const name = path.basename(filePath).toLowerCase();
    if (/^\.merge_split_[a-z0-9_-]+\.mp4$/.test(name)) return true;
    if (!name.endsWith('.mp4')) return false;
    const prefix = ['merge_tmp_', 'merged_', '.merge_output_'].find(value => name.startsWith(value));
    if (!prefix) return false;
    const identifiers = name.slice(prefix.length, -4).split('_');
    const minimum = prefix === 'merged_' ? 1 : 2;
    return identifiers.length >= minimum && identifiers.length <= minimum + 1
        && identifiers.every(value => /^\d+$/.test(value));
}

function removeArtifact(filePath: string, downloadRoot: string, kind: ArtifactKind): RemovalResult {
    if (!isInside(downloadRoot, filePath)) return 'failed';
    if (kind === 'internal' && !isInternalMergeArtifact(filePath)) return 'failed';
    if (!fs.existsSync(filePath)) return 'missing';
    try {
        const resolvedRoot = canonicalRoot(downloadRoot);
        if (!resolvedRoot || !isInside(resolvedRoot, fs.realpathSync.native(filePath))) return 'failed';
        fs.unlinkSync(filePath);
        return fs.existsSync(filePath) ? 'failed' : 'removed';
    } catch {
        return 'failed';
    }
}

export function getInterruptedMergeItemIds(rawQueue: unknown[]): Set<string> {
    const result = new Set<string>();
    for (const raw of rawQueue) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        if (item.status !== 'downloading' || typeof item.id !== 'string' || !item.id) continue;
        if (!item.mergeGroup || typeof item.mergeGroup !== 'object' || Array.isArray(item.mergeGroup)) continue;
        result.add(item.id);
    }
    return result;
}

function retainFailedArtifacts(group: NonNullable<QueueItem['mergeGroup']>, failed: Set<string>): NonNullable<QueueItem['mergeGroup']> {
    const downloadedFiles = Object.fromEntries(
        Object.entries(group.downloadedFiles).filter(([, filePath]) => failed.has(path.resolve(filePath)))
    ) as Record<number, string>;
    const retained = { ...group, downloadedFiles };
    if (!group.mergedFile || !failed.has(path.resolve(group.mergedFile))) delete retained.mergedFile;
    const splitFiles = group.splitFiles?.filter((filePath) => failed.has(path.resolve(filePath)));
    const splitTempFiles = group.splitTempFiles?.filter((filePath) => failed.has(path.resolve(filePath)));
    if (splitFiles?.length) retained.splitFiles = splitFiles;
    else delete retained.splitFiles;
    if (splitTempFiles?.length) retained.splitTempFiles = splitTempFiles;
    else delete retained.splitTempFiles;
    return retained;
}

export function recoverInterruptedMergeArtifacts(
    queue: QueueItem[],
    downloadRoot: string,
    interruptedItemIds: ReadonlySet<string>
): MergeRecoveryResult {
    const removedFiles: string[] = [];
    const failedFiles: string[] = [];
    let changed = false;
    const recoveredQueue = queue.map((item) => {
        const group = item.mergeGroup;
        if (!group || group.mergePhase === 'done' || !interruptedItemIds.has(item.id)) return item;

        const artifacts = collectMergeArtifacts(group);
        const rootResolution = resolveMergeArtifactRoot(item, downloadRoot);
        if (!rootResolution.artifactRoot) {
            const failed = new Set(artifacts.keys());
            failedFiles.push(...[...artifacts.values()].map(({ filePath }) => filePath));
            changed = true;
            return {
                ...item,
                status: 'error' as const,
                mergeRecoveryBlocked: true,
                mergeGroup: retainFailedArtifacts(group, failed),
            };
        }
        const itemWithRoot = item.artifactRoot === rootResolution.artifactRoot
            ? item
            : { ...item, artifactRoot: rootResolution.artifactRoot };

        const failed = new Set<string>();
        for (const [resolved, artifact] of artifacts) {
            const result = removeArtifact(artifact.filePath, rootResolution.artifactRoot, artifact.kind);
            if (result === 'removed') removedFiles.push(artifact.filePath);
            if (result === 'failed') {
                failed.add(resolved);
                failedFiles.push(artifact.filePath);
            }
        }

        changed = true;
        if (failed.size > 0) {
            return {
                ...itemWithRoot,
                status: 'error' as const,
                mergeRecoveryBlocked: true,
                mergeGroup: retainFailedArtifacts(group, failed),
            };
        }

        const recoveredGroup = {
            ...group,
            mergePhase: 'downloading' as const,
            currentItemIndex: 0,
            downloadedFiles: {},
        };
        delete recoveredGroup.mergedFile;
        delete recoveredGroup.splitFiles;
        delete recoveredGroup.splitTempFiles;
        const recoveredItem: QueueItem = {
            ...itemWithRoot,
            status: 'pending',
            progress: 0,
            mergeGroup: recoveredGroup,
        };
        delete recoveredItem.currentPart;
        delete recoveredItem.totalParts;
        delete recoveredItem.speed;
        delete recoveredItem.eta;
        delete recoveredItem.downloadedBytes;
        delete recoveredItem.totalBytes;
        delete recoveredItem.progressStatus;
        delete recoveredItem.last_error;
        delete recoveredItem.mergeRecoveryBlocked;
        return recoveredItem;
    });

    return { queue: recoveredQueue, removedFiles, failedFiles, changed };
}
