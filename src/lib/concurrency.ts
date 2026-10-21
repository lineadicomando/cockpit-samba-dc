// Bulk actions spawn one samba-tool (a Python process of tens of MB) per
// account, and every write takes the sam.ldb lock: running hundreds at once
// can exhaust a small DC's memory or time out on the lock.
export const BULK_CONCURRENCY = 4;

// Like Promise.all(items.map(fn)), but with at most `limit` calls in flight.
// Results keep the order of `items`.
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
    return results;
}
