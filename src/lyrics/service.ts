import Gio from 'gi://Gio';

import type {LyricsCandidate, LyricsProviderOutcome, LyricsResult, TrackMetadata} from '../types.js';
import {LyricsCache} from '../cache/store.js';
import {
    isTextLyricsCandidate,
    lyricsCandidateQuality,
    resultFromCandidate,
} from './core.js';
import {LrclibProvider} from './lrclib.js';
import {NeteaseProvider} from './netease.js';
import {combineProviderOutcomes, resultFromOutcome, type CombinedLyricsOutcome} from './selection.js';

function hasSynchronizedLyrics(outcome: LyricsProviderOutcome): boolean {
    return outcome.candidates.some(candidate => lyricsCandidateQuality(candidate) === 3);
}

export class LyricsService {
    private readonly cache = new LyricsCache();
    private readonly lrclib = new LrclibProvider();
    private readonly netease = new NeteaseProvider();
    private cancellable: Gio.Cancellable | null = null;

    private newRequest(): Gio.Cancellable {
        this.cancellable?.cancel();
        this.cancellable = new Gio.Cancellable();
        return this.cancellable;
    }

    private async collect(track: TrackMetadata, cancellable: Gio.Cancellable): Promise<CombinedLyricsOutcome> {
        const primary = await this.lrclib.collect(track, cancellable);
        if (hasSynchronizedLyrics(primary)) {
            return {
                candidates: primary.candidates.filter(isTextLyricsCandidate),
                successfulRequests: primary.successfulRequests,
                errors: primary.errors,
            };
        }

        const fallback = await this.netease.collect(track, cancellable);
        return combineProviderOutcomes(track, primary, fallback);
    }

    async load(track: TrackMetadata, force = false): Promise<LyricsResult> {
        const cancellable = this.newRequest();
        const cached = this.cache.read(track);
        if (!force && cached?.fresh)
            return cached.result;

        try {
            const outcome = await this.collect(track, cancellable);
            const result = resultFromOutcome(outcome);
            if (result.candidate) {
                const best = result.candidate;
                console.debug(
                    `LyricFlow: selected ${best.source ?? 'lrclib'}:${best.id}`
                    + ` quality=${lyricsCandidateQuality(best)}`,
                );
            }

            if (cancellable.is_cancelled())
                throw new Error('Lyrics request was cancelled');
            if ((result.status === 'not-found' || result.status === 'error')
                && cached
                && (cached.result.status === 'synced' || cached.result.status === 'plain'))
                return {...cached.result, stale: true};
            if (result.status !== 'error')
                this.cache.write(track, result);
            return result;
        } catch (error) {
            if (cancellable.is_cancelled())
                throw error;
            if (cached && (cached.result.status === 'synced' || cached.result.status === 'plain'))
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

    async search(track: TrackMetadata): Promise<LyricsCandidate[]> {
        const cancellable = this.newRequest();
        const outcome = await this.collect(track, cancellable);
        if (cancellable.is_cancelled())
            throw new Error('Lyrics request was cancelled');
        const result = resultFromOutcome(outcome);
        if (result.status === 'error')
            throw new Error(result.message);
        return outcome.candidates;
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
        this.lrclib.abort();
        this.netease.abort();
    }
}
