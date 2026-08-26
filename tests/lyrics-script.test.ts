import assert from 'node:assert/strict';
import test from 'node:test';

import {Converter as toTraditional} from 'opencc-js/cn2t';
import {Converter as toSimplified} from 'opencc-js/t2cn';

import {mapLyricsCandidate, mapLyricsResult} from '../src/lyrics/script.js';
import type {LyricsCandidate, LyricsResult} from '../src/types.js';

const simplified = toSimplified({from: 't', to: 'cn'});
const traditional = toTraditional({from: 'cn', to: 't'});

test('converts cached Traditional Chinese lyric examples to Simplified Chinese', () => {
    assert.equal(simplified('當你再次和我說起 青春時的故事'), '当你再次和我说起 青春时的故事');
    assert.equal(simplified('洋蔥 如果你能聽到心碎的聲音'), '洋葱 如果你能听到心碎的声音');
});

test('converts Simplified Chinese to standard Traditional Chinese', () => {
    assert.equal(traditional('当你再次和我说起'), '當你再次和我說起');
    assert.equal(traditional('洋葱'), '洋蔥');
});

test('leaves English, numbers, timestamps, and punctuation stable', () => {
    const source = '[00:12.34] LyricFlow 2026!';
    assert.equal(simplified(source), source);
    assert.equal(traditional(source), source);
});

test('creates a display result without mutating the cached source result', () => {
    const source: LyricsResult = {
        status: 'synced',
        candidate: null,
        timedLines: [{timeMs: 1_000, text: '當你說起'}],
        plainLines: ['洋蔥'],
    };
    const display = mapLyricsResult(source, simplified);
    assert.equal(display.timedLines[0]?.text, '当你说起');
    assert.equal(display.plainLines[0], '洋葱');
    assert.equal(source.timedLines[0]?.text, '當你說起');
    assert.equal(source.plainLines[0], '洋蔥');
});

test('candidate display keeps the original candidate for selection and caching', () => {
    const source: LyricsCandidate = {
        id: 1,
        trackName: '勇氣',
        artistName: '梁靜茹',
        albumName: '勇氣',
        duration: 240,
        instrumental: false,
        plainLyrics: null,
        syncedLyrics: null,
    };
    const display = mapLyricsCandidate(source, simplified);
    assert.equal(display.trackName, '勇气');
    assert.equal(display.artistName, '梁静茹');
    assert.strictEqual(display.candidate, source);
});
