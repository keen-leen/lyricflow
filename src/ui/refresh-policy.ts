import type {TimedLyricLine} from '../types.js';
import {findActiveLyricIndex} from '../lyrics/core.js';

// Closed popups need only lyric boundaries and the track-information deadline.
export function nextPanelRefreshMs(lines: TimedLyricLine[], positionUs: number,
    lengthUs: number, rate: number, offsetMs: number, infoRemainingMs: number,
    playing: boolean): number | null {
    if (infoRemainingMs > 0)
        return Math.max(1, Math.ceil(infoRemainingMs));
    if (!playing || !Number.isFinite(rate) || rate <= 0)
        return null;
    const next = lines[findActiveLyricIndex(lines, positionUs / 1000, offsetMs) + 1];
    if (!next || lengthUs > 0 && (next.timeMs - offsetMs) * 1000 > lengthUs)
        return null;
    return Math.max(1, Math.min(2_147_483_647, Math.ceil((next.timeMs - offsetMs - positionUs / 1000) / rate)));
}
