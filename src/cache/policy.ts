import type {CacheEntry} from '../types.js';

export const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MISS_TTL_MS = 24 * 60 * 60 * 1_000;
export const PLAIN_TTL_MS = 24 * 60 * 60 * 1_000;

export function cacheTtl(entry: CacheEntry): number {
    if (entry.result.status === 'plain')
        return PLAIN_TTL_MS;
    return entry.result.status === 'not-found' || entry.result.status === 'instrumental'
        ? MISS_TTL_MS
        : SUCCESS_TTL_MS;
}

export function isCacheFresh(entry: CacheEntry, nowMs = Date.now()): boolean {
    return nowMs >= entry.savedAtMs && nowMs - entry.savedAtMs <= cacheTtl(entry);
}

export const MAX_CACHE_FILE_BYTES = 1024 * 1024;
export const MAX_CACHE_FILES = 1000;
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonnegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function decodeCacheEntry(value: unknown, key: string): CacheEntry | null {
    if (!record(value) || value.trackKey !== key || !finiteNonnegative(value.savedAtMs)
        || !record(value.result))
        return null;
    const result = value.result;
    if (!['synced', 'plain', 'instrumental', 'not-found'].includes(String(result.status))
        || result.stale !== undefined && typeof result.stale !== 'boolean'
        || result.message !== undefined && typeof result.message !== 'string'
        || !Array.isArray(result.timedLines) || !Array.isArray(result.plainLines)
        || !result.plainLines.every(line => typeof line === 'string'))
        return null;
    let previous = -1;
    for (const line of result.timedLines) {
        if (!record(line) || !finiteNonnegative(line.timeMs)
            || line.timeMs < previous || typeof line.text !== 'string')
            return null;
        previous = line.timeMs;
    }
    if (result.status === 'synced' && result.timedLines.length === 0
        || result.status === 'plain' && (result.plainLines.length === 0 || result.timedLines.length > 0)
        || (result.status === 'not-found' || result.status === 'instrumental')
            && (result.timedLines.length > 0 || result.plainLines.length > 0))
        return null;
    const candidate = result.candidate;
    if (candidate !== null) {
        if (!record(candidate) || !finiteNonnegative(candidate.id)
            || !finiteNonnegative(candidate.duration) || typeof candidate.instrumental !== 'boolean'
            || !['trackName', 'artistName', 'albumName'].every(key => typeof candidate[key] === 'string')
            || !['plainLyrics', 'syncedLyrics'].every(key => candidate[key] === null || typeof candidate[key] === 'string')
            || candidate.source !== undefined && candidate.source !== 'lrclib' && candidate.source !== 'netease')
            return null;
    }
    return value as unknown as CacheEntry;
}

export interface CacheFileRecord {
    name: string;
    bytes: number;
    savedAtMs: number;
    expiredNegative: boolean;
}

export function cacheEvictions(files: CacheFileRecord[]): CacheFileRecord[] {
    let count = files.length;
    let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const ordered = [...files].sort((a, b) => Number(b.expiredNegative) - Number(a.expiredNegative)
        || a.savedAtMs - b.savedAtMs || a.name.localeCompare(b.name));
    const removed: CacheFileRecord[] = [];
    for (const file of ordered) {
        if (!file.expiredNegative && count <= MAX_CACHE_FILES && bytes <= MAX_CACHE_BYTES)
            break;
        removed.push(file);
        count--;
        bytes -= file.bytes;
    }
    return removed;
}
