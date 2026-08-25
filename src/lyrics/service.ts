import Gio from 'gi://Gio';

import type {LyricsCandidate, LyricsResult, TrackMetadata} from '../types.js';
import {LyricsCache} from '../cache/store.js';
import {resultFromCandidate} from './core.js';
import {LrclibProvider} from './lrclib.js';

export class LyricsService {
    private readonly cache = new LyricsCache();
    private readonly provider = new LrclibProvider();
    private cancellable: Gio.Cancellable | null = null;

    private newRequest(): Gio.Cancellable {
        this.cancellable?.cancel();
        this.cancellable = new Gio.Cancellable();
        return this.cancellable;
    }

    async load(track: TrackMetadata, force = false): Promise<LyricsResult> {
        const cached = this.cache.read(track);
        if (!force && cached?.fresh)
            return cached.result;

        const cancellable = this.newRequest();
        try {
            const result = await this.provider.find(track, cancellable);
            if (!cancellable.is_cancelled())
                this.cache.write(track, result);
            return result;
        } catch (error) {
            if (cancellable.is_cancelled())
                throw error;
            if (cached && cached.result.status !== 'not-found')
                return {...cached.result, stale: true};
            return {
                status: 'error',
                candidate: null,
                timedLines: [],
                plainLines: [],
                message: String(error),
            };
        }
    }

    search(track: TrackMetadata): Promise<LyricsCandidate[]> {
        return this.provider.search(track, this.newRequest());
    }

    select(track: TrackMetadata, candidate: LyricsCandidate): LyricsResult {
        const result = resultFromCandidate(candidate);
        this.cache.write(track, result);
        return result;
    }

    cancel(): void {
        this.cancellable?.cancel();
        this.cancellable = null;
    }

    destroy(): void {
        this.cancel();
        this.provider.abort();
    }
}
