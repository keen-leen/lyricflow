import assert from 'node:assert/strict';
import test from 'node:test';

import {isCacheFresh, MISS_TTL_MS, PLAIN_TTL_MS, SUCCESS_TTL_MS} from '../src/cache/policy.js';
import type {CacheEntry, LyricsResult} from '../src/types.js';

function entry(status: LyricsResult['status'], savedAtMs: number): CacheEntry {
    return {
        savedAtMs,
        trackKey: 'track',
        result: {status, candidate: null, timedLines: [], plainLines: []},
    };
}

test('successful lyrics remain fresh for 30 days', () => {
    const now = 1_000_000_000;
    assert.equal(isCacheFresh(entry('synced', now - SUCCESS_TTL_MS), now), true);
    assert.equal(isCacheFresh(entry('synced', now - SUCCESS_TTL_MS - 1), now), false);
});

test('plain lyrics are retried after 24 hours to look for synchronized lyrics', () => {
    const now = 1_000_000_000;
    assert.equal(isCacheFresh(entry('plain', now - PLAIN_TTL_MS), now), true);
    assert.equal(isCacheFresh(entry('plain', now - PLAIN_TTL_MS - 1), now), false);
});

test('negative results expire after 24 hours', () => {
    const now = 1_000_000_000;
    assert.equal(isCacheFresh(entry('not-found', now - MISS_TTL_MS), now), true);
    assert.equal(isCacheFresh(entry('instrumental', now - MISS_TTL_MS - 1), now), false);
});
