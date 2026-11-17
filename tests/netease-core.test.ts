import assert from 'node:assert/strict';
import test from 'node:test';

import {addNeteaseLyrics, decodeNeteaseSearch} from '../src/lyrics/netease-core.js';

const searchResponse = {
    code: 200,
    result: {
        songs: [{
            id: 27483167,
            name: '唯一',
            duration: 262_400,
            artists: [{name: '王力宏'}],
            album: {name: '唯一'},
        }],
    },
};

test('decodes NetEase song metadata and millisecond duration', () => {
    assert.deepEqual(decodeNeteaseSearch(searchResponse), [{
        id: 27483167,
        source: 'netease',
        trackName: '唯一',
        artistName: '王力宏',
        albumName: '唯一',
        duration: 262.4,
        instrumental: false,
        plainLyrics: null,
        syncedLyrics: null,
    }]);
});

test('decodes synchronized, plain, and explicit instrumental NetEase responses', () => {
    const candidate = decodeNeteaseSearch(searchResponse)[0]!;
    const synced = addNeteaseLyrics(candidate, {lrc: {lyric: '[00:01.00] First\n[00:02.00] Second'}});
    assert.equal(synced.syncedLyrics, '[00:01.00] First\n[00:02.00] Second');
    assert.equal(synced.plainLyrics, 'First\nSecond');

    const plain = addNeteaseLyrics(candidate, {lrc: {lyric: 'First\nSecond'}});
    assert.equal(plain.syncedLyrics, null);
    assert.equal(plain.plainLyrics, 'First\nSecond');

    const instrumental = addNeteaseLyrics(candidate, {nolyric: true});
    assert.equal(instrumental.instrumental, true);
});

test('rejects malformed NetEase search responses', () => {
    assert.deepEqual(decodeNeteaseSearch({code: 500}), []);
    assert.deepEqual(decodeNeteaseSearch({code: 200, result: {songs: [{name: 'Missing id'}]}}), []);
});
