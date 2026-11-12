export class LastGoodCache<T> {
    private readonly values = new Map<string, T>();

    constructor(private readonly maxEntries: number) {
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
    }

    get(key: string): T | undefined {
        return this.values.get(key);
    }

    set(key: string, value: T): void {
        this.values.delete(key);
        this.values.set(key, value);
        while (this.values.size > this.maxEntries) {
            const oldest = this.values.keys().next().value as string | undefined;
            if (!oldest) break;
            this.values.delete(oldest);
        }
    }

    delete(key: string): boolean {
        return this.values.delete(key);
    }
}
