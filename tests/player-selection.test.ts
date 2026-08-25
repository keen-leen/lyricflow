import assert from 'node:assert/strict';
import test from 'node:test';

import {selectActivePlayer} from '../src/player/selection.js';
import type {PlaybackStatus, PlayerState} from '../src/types.js';

function player(busName: string, status: PlaybackStatus, sequence: number): PlayerState {
    return {
        busName,
        identity: busName,
        status,
        activeSequence: sequence,
        positionUs: 0,
        rate: 1,
        sampledAtUs: 0,
        track: {
            trackId: `/${busName}`,
            title: 'Song',
            artists: ['Artist'],
            artist: 'Artist',
            album: '',
            lengthUs: 0,
            artUrl: '',
        },
        capabilities: {
            canGoNext: true,
            canGoPrevious: true,
            canPlay: true,
            canPause: true,
            canSeek: true,
            canControl: true,
        },
    };
}

test('playing player wins over a more recently paused player', () => {
    assert.equal(selectActivePlayer([
        player('playing', 'Playing', 2),
        player('paused', 'Paused', 8),
    ])?.busName, 'playing');
});

test('most recently active player wins when statuses match', () => {
    assert.equal(selectActivePlayer([
        player('older', 'Paused', 2),
        player('newer', 'Paused', 3),
    ])?.busName, 'newer');
});

test('players without a title do not occupy the indicator', () => {
    const empty = player('empty', 'Playing', 10);
    empty.track.title = '';
    assert.equal(selectActivePlayer([empty]), null);
});
