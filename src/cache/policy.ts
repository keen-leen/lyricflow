import type {CacheEntry} from '../types.js';

export const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MISS_TTL_MS = 24 * 60 * 60 * 1_000;
export const PLAIN_TTL_MS = 24 * 60 * 60 * 1_000;
export const SEARCH_REVISION = 3;

export function cacheTtl(entry: CacheEntry): number {
    if (entry.result.status === 'plain')
        return PLAIN_TTL_MS;
    return entry.result.status === 'not-found' || entry.result.status === 'instrumental'
        ? MISS_TTL_MS
        : SUCCESS_TTL_MS;
}

export function isCacheFresh(entry: CacheEntry, nowMs = Date.now()): boolean {
    if (entry.version !== 1)
        return false;
    // Keep successful text, but retry negative results produced before multi-provider
    // validation so a bad LRCLIB instrumental marker cannot remain authoritative.
    if ((entry.result.status === 'not-found' || entry.result.status === 'instrumental')
        && (entry.searchRevision ?? 1) < SEARCH_REVISION)
        return false;
    return nowMs - entry.savedAtMs <= cacheTtl(entry);
}
