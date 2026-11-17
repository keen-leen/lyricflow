import GLib from 'gi://GLib';

import type {CacheEntry, CachedLyrics, LyricsResult, TrackMetadata} from '../types.js';
import {trackCacheKey} from '../lyrics/core.js';
import {isCacheFresh} from './policy.js';

function decode(contents: Uint8Array): string {
    return new TextDecoder().decode(contents);
}

export class LyricsCache {
    private readonly directory: string;

    constructor() {
        this.directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lyricflow', 'lyrics']);
        GLib.mkdir_with_parents(this.directory, 0o700);
    }

    private path(track: TrackMetadata): string {
        const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, trackCacheKey(track), -1);
        return GLib.build_filenamev([this.directory, `${digest}.json`]);
    }

    read(track: TrackMetadata): CachedLyrics | null {
        try {
            const [ok, contents] = GLib.file_get_contents(this.path(track));
            if (!ok)
                return null;
            const entry = JSON.parse(decode(contents)) as CacheEntry;
            if (entry.trackKey !== trackCacheKey(track))
                return null;
            return {result: entry.result, fresh: isCacheFresh(entry)};
        } catch {
            return null;
        }
    }

    write(track: TrackMetadata, result: LyricsResult): void {
        const entry: CacheEntry = {
            savedAtMs: Date.now(),
            trackKey: trackCacheKey(track),
            result: {...result, stale: false},
        };
        try {
            GLib.file_set_contents(this.path(track), JSON.stringify(entry));
        } catch (error) {
            console.warn(`LyricFlow: could not write lyrics cache: ${String(error)}`);
        }
    }
}
