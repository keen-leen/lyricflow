import assert from 'node:assert/strict';
import test from 'node:test';

import {decodeLyricsCandidate, findActiveLyricIndex, normalizeTrackText, parseLrc, rankCandidates, resultFromCandidate, scoreCandidate, trackCacheKey} from '../src/lyrics/core.js';
import type {LyricsCandidate, TrackMetadata} from '../src/types.js';

const track: TrackMetadata = {
    trackId: '/track/1',
    title: 'The Chain (Remastered)',
    artists: ['Fleetwood Mac'],
    artist: 'Fleetwood Mac',
    album: 'Rumours',
    lengthUs: 271_000_000,
    artUrl: '',
};

function candidate(overrides: Partial<LyricsCandidate> = {}): LyricsCandidate {
    return {
        id: 1,
        trackName: 'The Chain',
        artistName: 'Fleetwood Mac',
        albumName: 'Rumours',
        duration: 271,
        instrumental: false,
        plainLyrics: 'Listen to the wind blow',
        syncedLyrics: '[00:27.93] Listen to the wind blow',
        ...overrides,
    };
}

test('parseLrc supports multiple timestamps and fractional precision', () => {
    const result = parseLrc([
        '[ar:Artist]',
        '[00:01.2][00:02.34] First',
        '[00:03.456] Second',
        '[00:99.00] invalid',
        '[00:04.00]',
    ].join('\n'));
    assert.deepEqual(result, [
        {timeMs: 1_200, text: 'First'},
        {timeMs: 2_340, text: 'First'},
        {timeMs: 3_456, text: 'Second'},
    ]);
});

test('parseLrc sorts out-of-order lines and preserves equal-time order', () => {
    assert.deepEqual(parseLrc('[00:02] Later\n[00:01] First\n[00:01] Translation'), [
        {timeMs: 1_000, text: 'First'},
        {timeMs: 1_000, text: 'Translation'},
        {timeMs: 2_000, text: 'Later'},
    ]);
});

test('findActiveLyricIndex applies positive and negative offsets', () => {
    const lines = parseLrc('[00:01] One\n[00:02] Two\n[00:03] Three');
    assert.equal(findActiveLyricIndex(lines, 1_900), 0);
    assert.equal(findActiveLyricIndex(lines, 1_900, 200), 1);
    assert.equal(findActiveLyricIndex(lines, 2_100, -200), 0);
    assert.equal(findActiveLyricIndex(lines, 500), -1);
});

test('normalization removes presentation punctuation and common edition suffixes', () => {
    assert.equal(normalizeTrackText('Ｔｈｅ Chain (Remastered 2004)!'), 'the chain');
    assert.equal(normalizeTrackText('Song [feat. Guest]'), 'song');
});

test('candidate scoring prefers matching metadata and duration', () => {
    const exact = candidate();
    const wrong = candidate({id: 2, trackName: 'Another Song', artistName: 'Someone Else', duration: 120});
    assert.ok(scoreCandidate(track, exact) > scoreCandidate(track, wrong));
    assert.deepEqual(rankCandidates(track, [wrong, exact]).map(item => item.id), [1, 2]);
});

test('fixed LRCLIB responses decode synchronized, plain, and instrumental results', () => {
    const synced = decodeLyricsCandidate(candidate());
    const plain = decodeLyricsCandidate(candidate({syncedLyrics: null, plainLyrics: 'Line one\nLine two'}));
    const instrumental = decodeLyricsCandidate(candidate({instrumental: true, syncedLyrics: null, plainLyrics: null}));
    assert.equal(synced && resultFromCandidate(synced).status, 'synced');
    assert.deepEqual(plain && resultFromCandidate(plain).plainLines, ['Line one', 'Line two']);
    assert.equal(instrumental && resultFromCandidate(instrumental).status, 'instrumental');
});

test('malformed LRCLIB candidates are rejected and optional fields are normalized', () => {
    assert.equal(decodeLyricsCandidate({trackName: 'Missing id'}), null);
    assert.deepEqual(decodeLyricsCandidate({id: 7, trackName: 'Song', artistName: 'Artist'}), {
        id: 7,
        trackName: 'Song',
        artistName: 'Artist',
        albumName: '',
        duration: 0,
        instrumental: false,
        plainLyrics: null,
        syncedLyrics: null,
    });
});

test('cache key is stable across cosmetic title changes', () => {
    const first = trackCacheKey(track);
    const second = trackCacheKey({...track, title: 'The Chain'});
    assert.equal(first, second);
});
