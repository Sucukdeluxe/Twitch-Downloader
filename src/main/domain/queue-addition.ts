export type QueueAdditionRejectionReason = 'duplicate' | 'invalid' | 'shutting-down' | 'persistence-failed' | 'access-denied';

export interface QueueAdditionAccepted<T> {
    queue: T[];
    accepted: true;
    addedId: string;
}

export interface QueueAdditionRejected<T> {
    queue: T[];
    accepted: false;
    reason: QueueAdditionRejectionReason;
}

export type QueueAdditionResult<T> = QueueAdditionAccepted<T> | QueueAdditionRejected<T>;

export function commitQueueAddition<T extends { id: string }>(
    current: T[],
    item: T | null,
    isDuplicate: (item: T) => boolean,
    persist: (next: T[]) => void,
): QueueAdditionResult<T> {
    if (!item) return { queue: current, accepted: false, reason: 'invalid' };
    if (isDuplicate(item)) return { queue: current, accepted: false, reason: 'duplicate' };
    const queue = [...current, item];
    try {
        persist(queue);
    } catch {
        return { queue: current, accepted: false, reason: 'persistence-failed' };
    }
    return { queue, accepted: true, addedId: item.id };
}
