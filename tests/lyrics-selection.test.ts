import assert from 'node:assert/strict';
import test from 'node:test';

import {combineProviderOutcomes, resultFromOutcome} from '../src/lyrics/selection.js';
import type {LyricsCandidate, LyricsProviderOutcome, TrackMetadata} from '../src/types.js';

const track: TrackMetadata = {
    trackId: '/track/unique',
    title: '唯一',
    artists: ['王力宏'],
    artist: '王力宏',
    album: '唯一',
    lengthUs: 262_000_000,
    artUrl: '',
};

function candidate(source: 'lrclib' | 'netease', overrides: Partial<LyricsCandidate> = {}): LyricsCandidate {
    return {
        id: source === 'lrclib' ? 1 : 2,
        source,
        trackName: '唯一',
        artistName: '王力宏',
        albumName: '唯一',
        duration: 262,
        instrumental: false,
        plainLyrics: 'Plain lyrics',
        syncedLyrics: null,
        ...overrides,
    };
}

function outcome(candidates: LyricsCandidate[]): LyricsProviderOutcome {
    return {candidates, successfulRequests: 1, errors: []};
}

test('NetEase synchronized lyrics replace LRCLIB plain lyrics', () => {
    const combined = combineProviderOutcomes(
        track,
        outcome([candidate('lrclib')]),
        outcome([candidate('netease', {syncedLyrics: '[00:01] Synced'})]),
    );
    assert.equal(combined.candidates[0]?.source, 'netease');
    assert.equal(combined.candidates[0]?.syncedLyrics, '[00:01] Synced');
});

test('plain lyrics remain available when no synchronized candidate exists', () => {
    const combined = combineProviderOutcomes(track, outcome([candidate('lrclib')]), outcome([]));
    assert.equal(combined.candidates[0]?.source, 'lrclib');
});

test('a single provider cannot declare a track instrumental', () => {
    const instrumental = candidate('lrclib', {
        instrumental: true,
        plainLyrics: null,
        syncedLyrics: null,
    });
    assert.deepEqual(combineProviderOutcomes(track, outcome([instrumental]), outcome([])).candidates, []);
});

test('matching instrumental responses from both providers are accepted', () => {
    const primary = candidate('lrclib', {instrumental: true, plainLyrics: null});
    const fallback = candidate('netease', {instrumental: true, plainLyrics: null});
    assert.equal(
        combineProviderOutcomes(track, outcome([primary]), outcome([fallback])).candidates[0]?.instrumental,
        true,
    );
});

test('incomplete queries are errors even after successful requests', () => {
    for (const successfulRequests of [0, 1, 4]) {
        const result = resultFromOutcome({candidates: [], successfulRequests, errors: ['lyrics fetch failed']});
        assert.equal(result.status, 'error');
        assert.match(result.message ?? '', /lyrics fetch failed/);
    }
    assert.equal(resultFromOutcome({candidates: [], successfulRequests: 0, errors: []}).status, 'error');
    assert.equal(resultFromOutcome({candidates: [], successfulRequests: 1, errors: []}).status, 'not-found');
});

test('usable candidates survive partial provider failures', () => {
    for (const syncedLyrics of [null, '[00:01] Synced']) {
        const combined = combineProviderOutcomes(track,
            outcome([candidate('lrclib', {syncedLyrics})]),
            {candidates: [], successfulRequests: 0, errors: ['network failure']});
        assert.equal(resultFromOutcome(combined).status, syncedLyrics ? 'synced' : 'plain');
    }
});
