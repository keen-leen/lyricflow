import assert from 'node:assert/strict';
import test from 'node:test';
import {nextPanelRefreshMs} from '../src/ui/refresh-policy.js';

const lines = [{timeMs: 1000, text: 'A'}, {timeMs: 2000, text: 'B'}, {timeMs: 2000, text: 'Translation'}, {timeMs: 3000, text: 'C'}];
test('closed popup follows lyric boundaries with offset, rate, seeks and duplicate timestamps', () => {
    assert.equal(nextPanelRefreshMs(lines, 500_000, 10_000_000, 1, 0, 0, true), 500);
    assert.equal(nextPanelRefreshMs(lines, 500_000, 10_000_000, 2, 100, 0, true), 200);
    assert.equal(nextPanelRefreshMs(lines, 2_000_000, 10_000_000, 1, 0, 0, true), 1000);
    assert.equal(nextPanelRefreshMs(lines, 3_000_000, 10_000_000, 1, 0, 0, true), null);
    assert.equal(nextPanelRefreshMs(lines, 0, 500_000, 1, 0, 0, true), null);
});
test('paused playback keeps only the information deadline and stationary playback does not poll', () => {
    assert.equal(nextPanelRefreshMs(lines, 0, 0, 1, 0, 250, false), 250);
    assert.equal(nextPanelRefreshMs(lines, 0, 0, 1, 0, 0, false), null);
    assert.equal(nextPanelRefreshMs(lines, 0, 0, 0, 0, 0, true), null);
});
