import type {PlayerState} from '../types.js';
import {trackCacheKey} from '../lyrics/core.js';

export function playbackIdentity(player: PlayerState): string {
    const id = player.track.trackId;
    const trackId = id && id !== '/org/mpris/MediaPlayer2/TrackList/NoTrack' ? id : '';
    return JSON.stringify([player.busName, trackId, trackCacheKey(player.track)]);
}
