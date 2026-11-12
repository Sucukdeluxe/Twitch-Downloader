import * as fs from 'node:fs';

export type CleanupStep = readonly [name: string, run: () => unknown | Promise<unknown>];

export type ManagedToolExecutionKind = 'ffmpeg' | 'ffprobe' | 'streamlink';

export interface ManagedToolExecutionRecord {
    path: string | null;
    count: number;
}

export interface ManagedToolExecutionDiagnostics {
    ffmpeg: ManagedToolExecutionRecord;
    ffprobe: ManagedToolExecutionRecord;
    streamlink: ManagedToolExecutionRecord;
}

interface SecretReader<K extends string> {
    get(key: K): string | null;
}

interface CleanupConfig {
    auto_cleanup_enabled: boolean;
    auto_cleanup_target: 'live_only' | 'all';
    auto_cleanup_action: 'archive' | 'delete';
}

export function readSecretSafely<K extends string>(
    store: SecretReader<K>,
    key: K,
    onError: (error: unknown) => void,
): string {
    try {
        return store.get(key) ?? '';
    } catch (error) {
        onError(error);
        return '';
    }
}

export function secureImportedConfigTransition<T extends Record<string, unknown>>(
    current: CleanupConfig,
    imported: T,
): T {
    const effective = { ...current, ...imported } as CleanupConfig & T;
    const currentlyDestructive = current.auto_cleanup_enabled
        && current.auto_cleanup_target === 'all'
        && current.auto_cleanup_action === 'delete';
    const activatesDestructiveCleanup = effective.auto_cleanup_enabled
        && effective.auto_cleanup_target === 'all'
        && effective.auto_cleanup_action === 'delete';
    if (currentlyDestructive || !activatesDestructiveCleanup) return imported;
    return { ...imported, auto_cleanup_enabled: false };
}

export async function runResilientSteps(
    steps: ReadonlyArray<CleanupStep>,
    onError: (name: string, error: unknown) => void,
): Promise<void> {
    for (const [name, run] of steps) {
        try {
            await run();
        } catch (error) {
            try {
                onError(name, error);
            } catch { }
        }
    }
}

export function createManagedToolExecutionTracker(enabled: boolean): {
    record(kind: ManagedToolExecutionKind, command: string): void;
    snapshot(): ManagedToolExecutionDiagnostics | null;
} {
    const state: ManagedToolExecutionDiagnostics = {
        ffmpeg: { path: null, count: 0 },
        ffprobe: { path: null, count: 0 },
        streamlink: { path: null, count: 0 },
    };
    return {
        record(kind, command) {
            if (!enabled) return;
            try {
                state[kind] = {
                    path: fs.realpathSync.native(command),
                    count: state[kind].count + 1,
                };
            } catch { }
        },
        snapshot() {
            if (!enabled) return null;
            return {
                ffmpeg: { ...state.ffmpeg },
                ffprobe: { ...state.ffprobe },
                streamlink: { ...state.streamlink },
            };
        },
    };
}
