import assert from 'node:assert/strict';
import test from 'node:test';
import {cacheEvictions, decodeCacheEntry, MAX_CACHE_BYTES, MAX_CACHE_FILES} from '../src/cache/policy.js';

const valid = {savedAtMs: 1, trackKey: 'identity',
    result: {status: 'synced', candidate: null, timedLines: [{timeMs: 0, text: 'Line'}], plainLines: []}};

test('cache entries validate identity, timestamps, states and sorted finite lyrics', () => {
    assert.ok(decodeCacheEntry(valid, 'identity'));
    assert.equal(decodeCacheEntry(valid, 'wrong'), null);
    for (const value of [null, {}, {...valid, savedAtMs: Number.NaN}, {...valid, savedAtMs: -1},
        {...valid, result: {...valid.result, status: 'error'}},
        {...valid, result: {...valid.result, candidate: {}}},
        {...valid, result: {...valid.result, timedLines: []}},
        {...valid, result: {...valid.result, plainLines: [1]}},
        {...valid, result: {...valid.result, timedLines: [{timeMs: Infinity, text: 'Bad'}]}},
        {...valid, result: {...valid.result, timedLines: [{timeMs: 2, text: 'A'}, {timeMs: 1, text: 'B'}]}}])
        assert.equal(decodeCacheEntry(value, 'identity'), null);
});

test('quota cleanup evicts expired negatives then oldest, preserving old text within quota', () => {
    const file = (name: string, savedAtMs: number, bytes = 1, expiredNegative = false) => ({name, savedAtMs, bytes, expiredNegative});
    assert.deepEqual(cacheEvictions([file('old-text', 0), file('miss', 2, 1, true)]).map(item => item.name), ['miss']);
    const files = Array.from({length: MAX_CACHE_FILES + 2}, (_, i) => file(String(i), i));
    assert.deepEqual(cacheEvictions(files).map(item => item.name), ['0', '1']);
    assert.deepEqual(cacheEvictions([file('old', 1, MAX_CACHE_BYTES), file('new', 2, 1)]).map(item => item.name), ['old']);
});
