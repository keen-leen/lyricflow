import assert from 'node:assert/strict';
import test from 'node:test';
import {playbackIdentity} from '../src/player/identity.js';
import type {PlayerState} from '../src/types.js';

const player = {
    busName: 'org.mpris.MediaPlayer2.One',
    track: {trackId: '/track/1', title: 'Song', artist: 'Artist', artists: ['Artist'], album: 'Album', lengthUs: 180_000_000, artUrl: ''},
} as PlayerState;

test('playback identity includes player, track id and strict metadata', () => {
    const first = playbackIdentity(player);
    assert.notEqual(playbackIdentity({...player, busName: 'org.mpris.MediaPlayer2.Two'}), first);
    assert.notEqual(playbackIdentity({...player, track: {...player.track, trackId: '/track/2'}}), first);
    assert.notEqual(playbackIdentity({...player, track: {...player.track, title: 'Song (Live)'}}), first);
    assert.equal(playbackIdentity({...player, track: {...player.track, artUrl: 'file:///cover'}}), first);
});

test('identity snapshots survive in-place updates and handle missing track ids', () => {
    const mutable = {...player, track: {...player.track, trackId: ''}};
    const before = playbackIdentity(mutable);
    assert.equal(playbackIdentity({...mutable, track: {...mutable.track, trackId: '/org/mpris/MediaPlayer2/TrackList/NoTrack'}}), before);
    mutable.track.title = 'New Song';
    assert.notEqual(playbackIdentity(mutable), before);
});
