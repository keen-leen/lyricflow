import type {CacheEntry} from '../types.js';

export const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MISS_TTL_MS = 24 * 60 * 60 * 1_000;
export const SEARCH_REVISION = 2;

export function cacheTtl(entry: CacheEntry): number {
    return entry.result.status === 'not-found' || entry.result.status === 'instrumental'
        ? MISS_TTL_MS
        : SUCCESS_TTL_MS;
}

export function isCacheFresh(entry: CacheEntry, nowMs = Date.now()): boolean {
    if (entry.version !== 1)
        return false;
    // Successful old entries remain valuable, but misses produced by the former
    // strict-only strategy must be retried once after upgrading the extension.
    if (entry.result.status === 'not-found'
        && (entry.searchRevision ?? 1) < SEARCH_REVISION)
        return false;
    return nowMs - entry.savedAtMs <= cacheTtl(entry);
}
