import type {CacheEntry} from '../types.js';

export const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MISS_TTL_MS = 24 * 60 * 60 * 1_000;

export function cacheTtl(entry: CacheEntry): number {
    return entry.result.status === 'not-found' || entry.result.status === 'instrumental'
        ? MISS_TTL_MS
        : SUCCESS_TTL_MS;
}

export function isCacheFresh(entry: CacheEntry, nowMs = Date.now()): boolean {
    return entry.version === 1 && nowMs - entry.savedAtMs <= cacheTtl(entry);
}
