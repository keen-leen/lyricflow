import assert from 'node:assert/strict';
import test from 'node:test';

import {clampPositionUs, displayedPositionUs} from '../src/player/position.js';

test('preview position takes precedence only while it exists', () => {
    assert.equal(displayedPositionUs(12_000_000, 90_000_000), 90_000_000);
    assert.equal(displayedPositionUs(12_000_000, null), 12_000_000);
    assert.equal(displayedPositionUs(12_000_000, 0), 0);
});

test('seek positions are clamped to the playable range', () => {
    assert.equal(clampPositionUs(-1, 240_000_000), 0);
    assert.equal(clampPositionUs(60_000_000, 240_000_000), 60_000_000);
    assert.equal(clampPositionUs(300_000_000, 240_000_000), 240_000_000);
    assert.equal(clampPositionUs(Number.NaN, 240_000_000), 0);
});
