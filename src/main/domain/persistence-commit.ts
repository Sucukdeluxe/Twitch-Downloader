export function persistStateChange<T>(current: T, createNext: (current: T) => T, persist: (next: T) => void): T {
    const next = createNext(current);
    persist(next);
    return next;
}

export function applyQueueSnapshotPreservingActiveItems<T extends { id: string }>(current: T[], next: T[], activeItemIds: ReadonlySet<string>): T[] {
    const currentById = new Map(current.map((item) => [item.id, item]));
    return next.map((candidate) => {
        const active = activeItemIds.has(candidate.id) ? currentById.get(candidate.id) : undefined;
        if (!active) return candidate;
        Object.assign(active, candidate);
        return active;
    });
}

export async function commitQueueMutation<T>(
    current: T,
    createNext: (current: T) => T,
    persist: (next: T) => void,
    apply: (next: T) => void,
    effects: () => Promise<void>,
): Promise<T> {
    const next = createNext(current);
    persist(next);
    apply(next);
    await effects();
    return next;
}
