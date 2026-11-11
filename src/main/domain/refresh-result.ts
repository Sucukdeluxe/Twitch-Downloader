export type RefreshOutcome<T> =
    | { status: 'success'; value: T }
    | { status: 'not-found' }
    | { status: 'unavailable' };

export interface ResolvedRefresh<T> {
    value: T | null;
    shouldCache: boolean;
    stale: boolean;
}

export function resolveRefreshOutcome<T>(previous: T | undefined, outcome: RefreshOutcome<T>): ResolvedRefresh<T> {
    if (outcome.status === 'success') return { value: outcome.value, shouldCache: true, stale: false };
    if (outcome.status === 'not-found') return { value: null, shouldCache: true, stale: false };
    if (previous !== undefined) return { value: previous, shouldCache: false, stale: true };
    return { value: null, shouldCache: false, stale: false };
}
