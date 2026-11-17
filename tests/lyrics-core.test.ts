import assert from 'node:assert/strict';
import test from 'node:test';

import {broadSearchQuery, decodeLyricsCandidate, findActiveLyricIndex, isQualifiedCandidate, isUsableLyricsCandidate, mergeSearchCandidates, needsBroadSearch, normalizeTrackText, parseLrc, rankCandidates, resultFromCandidate, scoreCandidate, trackCacheKey, trackTextSimilarity} from '../src/lyrics/core.js';
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

test('candidate qualification requires title plus artist or album and duration identity', () => {
    assert.equal(isQualifiedCandidate(track, candidate()), true);
    assert.equal(isQualifiedCandidate(track, candidate({artistName: 'Someone Else'})), true);
    assert.equal(isQualifiedCandidate(track, candidate({
        artistName: 'Someone Else',
        albumName: '',
        duration: 0,
    })), false);
    assert.equal(isQualifiedCandidate(track, candidate({trackName: 'Another Song'})), false);
});

test('latin artist word order does not reduce similarity', () => {
    assert.equal(trackTextSimilarity('Leehom Wang', 'Wang Leehom'), 1);
});

test('broad search query removes presentation suffixes and uses the first artist', () => {
    assert.equal(broadSearchQuery({...track, title: 'Song (Remastered 2011)'}), 'song fleetwood mac');
    assert.equal(broadSearchQuery({...track, title: 'Song [feat. Guest]'}), 'song fleetwood mac');
    assert.equal(broadSearchQuery({...track, title: 'Song (Official Video)'}), 'song fleetwood mac');
    assert.equal(broadSearchQuery({
        ...track,
        title: 'Collaboration',
        artists: ['First Artist', 'Guest Artist'],
        artist: 'First Artist, Guest Artist',
    }), 'collaboration first artist');
});

test('low-confidence or unusable candidates trigger broad search', () => {
    assert.equal(needsBroadSearch(track, [candidate()]), false);
    assert.equal(needsBroadSearch(track, [candidate({syncedLyrics: null, plainLyrics: 'Plain lyrics'})]), true);
    assert.equal(needsBroadSearch(track, [candidate({instrumental: true, syncedLyrics: null, plainLyrics: null})]), true);
    assert.equal(needsBroadSearch(track, [candidate({syncedLyrics: null, plainLyrics: null})]), true);
    assert.equal(needsBroadSearch(track, [candidate({trackName: 'Another Song', artistName: 'Someone Else'})]), true);
});

test('merged search results deduplicate, skip empty lyrics, and prefer synced close matches', () => {
    const empty = candidate({id: 2, syncedLyrics: null, plainLyrics: null});
    const plain = candidate({id: 3, syncedLyrics: null, plainLyrics: 'Plain lyrics'});
    const synced = candidate({id: 4, syncedLyrics: '[00:01] Synced'});
    const merged = mergeSearchCandidates(track, [empty, plain], [plain, synced]);
    assert.deepEqual(merged.map(item => item.id), [4, 3]);
    assert.equal(isUsableLyricsCandidate(empty), false);
});

test('qualified synchronized lyrics always rank before qualified plain lyrics', () => {
    const exactPlain = candidate({id: 2, syncedLyrics: null, plainLyrics: 'Plain lyrics'});
    const slightlyLowerSynced = candidate({id: 3, albumName: 'Rumours Deluxe'});
    assert.deepEqual(
        mergeSearchCandidates(track, [exactPlain, slightlyLowerSynced]).map(item => item.id),
        [3, 2],
    );
});

test('low-confidence synchronized lyrics cannot displace qualified plain lyrics', () => {
    const plain = candidate({id: 2, syncedLyrics: null, plainLyrics: 'Plain lyrics'});
    const wrongSynced = candidate({id: 3, trackName: 'Another Song', artistName: 'Someone Else'});
    assert.deepEqual(mergeSearchCandidates(track, [wrongSynced, plain]).map(item => item.id), [2]);
});

test('candidate ids are deduplicated within a provider but remain distinct across providers', () => {
    const lrclib = candidate({id: 9, source: 'lrclib'});
    const netease = candidate({id: 9, source: 'netease'});
    assert.equal(mergeSearchCandidates(track, [lrclib, lrclib], [netease]).length, 2);
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
        source: 'lrclib',
        trackName: 'Song',
        artistName: 'Artist',
        albumName: '',
        duration: 0,
        instrumental: false,
        plainLyrics: null,
        syncedLyrics: null,
    });
});

test('cache identity preserves editions, punctuation, case and precise duration', () => {
    const key = trackCacheKey(track);
    for (const change of [
        {title: 'The Chain'}, {title: 'The Chain (Live)'},
        {title: 'the Chain (Remastered)'}, {title: 'The Chain (Remastered)!'},
        {title: 'The Chain (feat. Guest)'}, {lengthUs: track.lengthUs + 1_000_000},
        {lengthUs: track.lengthUs + 1_000},
    ])
        assert.notEqual(trackCacheKey({...track, ...change}), key);
    assert.equal(trackCacheKey({...track, trackId: '/other', artUrl: 'file:///cover'}), key);
});

test('cache identity normalizes whitespace and NFC, and invalid durations', () => {
    assert.equal(trackCacheKey({...track, title: '  Cafe\u0301  Song  '}),
        trackCacheKey({...track, title: 'Café Song'}));
    for (const lengthUs of [-1, Number.NaN, Number.POSITIVE_INFINITY])
        assert.equal(trackCacheKey({...track, lengthUs}), trackCacheKey({...track, lengthUs: 0}));
});
