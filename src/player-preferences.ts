export const PLAYER_SEEK_SECONDS = [10, 30, 60] as const;

export function normalizePlayerSeekSeconds(value: unknown): number {
    return typeof value === 'number' && PLAYER_SEEK_SECONDS.some(seconds => seconds === value) ? value : 10;
}
