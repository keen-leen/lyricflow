import type {LyricsCandidate} from '../types.js';
import {parseLrc} from './core.js';

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function decodeNeteaseSearch(value: unknown): LyricsCandidate[] {
    const root = record(value);
    const result = record(root?.result);
    if (root?.code !== 200 || !Array.isArray(result?.songs))
        return [];

    const candidates: LyricsCandidate[] = [];
    for (const valueSong of result.songs) {
        const song = record(valueSong);
        const album = record(song?.album);
        if (typeof song?.id !== 'number' || typeof song.name !== 'string')
            continue;
        const artistName = Array.isArray(song.artists)
            ? song.artists
                .map(valueArtist => record(valueArtist)?.name)
                .filter((name): name is string => typeof name === 'string' && name.length > 0)
                .join(', ')
            : '';
        candidates.push({
            id: song.id,
            source: 'netease',
            trackName: song.name,
            artistName,
            albumName: typeof album?.name === 'string' ? album.name : '',
            duration: typeof song.duration === 'number' && Number.isFinite(song.duration)
                ? song.duration / 1_000
                : 0,
            instrumental: false,
            plainLyrics: null,
            syncedLyrics: null,
        });
    }
    return candidates;
}

export function addNeteaseLyrics(candidate: LyricsCandidate, value: unknown): LyricsCandidate {
    const root = record(value);
    if (root?.nolyric === true)
        return {...candidate, instrumental: true, plainLyrics: null, syncedLyrics: null};

    const lyric = record(root?.lrc)?.lyric;
    if (typeof lyric !== 'string' || lyric.trim().length === 0)
        return candidate;
    const timedLines = parseLrc(lyric);
    if (timedLines.length > 0) {
        return {
            ...candidate,
            syncedLyrics: lyric,
            plainLyrics: timedLines.map(line => line.text).join('\n'),
        };
    }
    return {...candidate, plainLyrics: lyric};
}
