import assert from 'node:assert/strict';
import test from 'node:test';

import {clampPositionUs, displayedPositionUs, formatPlaybackTime, lyricSeekPositionUs} from '../src/player/position.js';

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

test('playback time uses compact minute and hour formats', () => {
    assert.equal(formatPlaybackTime(0), '0:00');
    assert.equal(formatPlaybackTime(65_900_000), '1:05');
    assert.equal(formatPlaybackTime(3_661_000_000), '1:01:01');
    assert.equal(formatPlaybackTime(Number.NaN), '0:00');
});

test('lyric seek position applies offset and clamps to the track range', () => {
    assert.equal(lyricSeekPositionUs(60_000, 1_000, 240_000_000), 59_000_000);
    assert.equal(lyricSeekPositionUs(60_000, -1_000, 240_000_000), 61_000_000);
    assert.equal(lyricSeekPositionUs(500, 1_000, 240_000_000), 0);
    assert.equal(lyricSeekPositionUs(250_000, 0, 240_000_000), 240_000_000);
    assert.equal(lyricSeekPositionUs(250_000, 0, 0), 250_000_000);
});
