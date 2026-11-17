import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {LyricsCandidate, LyricsProviderOutcome, LyricsResult, TrackMetadata} from '../types.js';
import {observeCancellation} from './cancellation.js';
import {LyricsCache} from '../cache/store.js';
import {lyricsCandidateQuality, resultFromCandidate} from './core.js';
import {LrclibProvider} from './lrclib.js';
import {NeteaseProvider} from './netease.js';
import {combineProviderOutcomes, resultFromOutcome, type CombinedLyricsOutcome} from './selection.js';

export interface LyricsLoadUpdate { result: LyricsResult; refreshing: boolean; }
const isText = (result: LyricsResult | null | undefined) => result?.status === 'synced' || result?.status === 'plain';

export class LyricsService {
    private readonly cache = new LyricsCache();
    private readonly lrclib = new LrclibProvider();
    private readonly netease = new NeteaseProvider();
    private cancellable: Gio.Cancellable | null = null;

    private newRequest(): Gio.Cancellable {
        this.cancel();
        this.cancellable = new Gio.Cancellable();
        return this.cancellable;
    }

    private collect(track: TrackMetadata, parent: Gio.Cancellable, manual: boolean,
        onUpdate?: (result: LyricsResult) => void): Promise<CombinedLyricsOutcome> {
        return new Promise((resolve, reject) => {
            const tokens = [new Gio.Cancellable(), new Gio.Cancellable()];
            const empty = (): LyricsProviderOutcome => ({candidates: [], successfulRequests: 0, errors: []});
            const outcomes = [empty(), empty()];
            const done = [false, false];
            let fallbackStarted = false;
            let ended = false;
            let fallbackTimer = 0;
            let deadlineTimer = 0;
            let detach = () => {};
            const combined = () => combineProviderOutcomes(track, outcomes[0]!, outcomes[1]!);
            const finish = (cancelled = false, timedOut = false) => {
                if (ended) return;
                ended = true;
                if (fallbackTimer) GLib.source_remove(fallbackTimer);
                if (deadlineTimer) GLib.source_remove(deadlineTimer);
                detach();
                const outcome = combined();
                if (timedOut) outcome.errors.push('Lyrics query timed out after 15 seconds');
                for (const token of tokens) token.cancel();
                if (cancelled) reject(new Error('Lyrics request was cancelled'));
                else resolve(outcome);
            };
            const update = (index: number, outcome: LyricsProviderOutcome) => {
                if (ended) return;
                outcomes[index] = {...outcome, candidates: [...outcome.candidates], errors: [...outcome.errors]};
                const current = combined();
                const result = resultFromOutcome(current);
                if (isText(result)) onUpdate?.(result);
                if (!manual && current.candidates.some(candidate => lyricsCandidateQuality(candidate) === 3))
                    finish();
            };
            const launch = (index: number) => {
                const provider = index === 0 ? this.lrclib : this.netease;
                void provider.collect(track, tokens[index], outcome => update(index, outcome))
                    .then(outcome => update(index, outcome))
                    .catch(error => {
                        if (!ended) update(index, {...outcomes[index]!, errors: [...outcomes[index]!.errors, String(error)]});
                    }).finally(() => {
                        if (ended) return;
                        done[index] = true;
                        if (index === 0 && !fallbackStarted
                            && !outcomes[0]!.candidates.some(candidate => lyricsCandidateQuality(candidate) === 3)) startFallback();
                        if (done[0] && done[1]) finish();
                    });
            };
            const startFallback = () => {
                if (ended || fallbackStarted) return;
                fallbackStarted = true;
                if (fallbackTimer) { GLib.source_remove(fallbackTimer); fallbackTimer = 0; }
                launch(1);
            };
            detach = observeCancellation(parent, () => finish(true));
            if (parent.is_cancelled()) { finish(true); return; }
            deadlineTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15_000, () => {
                deadlineTimer = 0;
                finish(false, true);
                return GLib.SOURCE_REMOVE;
            });
            fallbackTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2_000, () => {
                fallbackTimer = 0;
                startFallback();
                return GLib.SOURCE_REMOVE;
            });
            launch(0);
        });
    }

    async load(track: TrackMetadata, force = false, onUpdate?: (update: LyricsLoadUpdate) => void): Promise<LyricsResult> {
        const cancellable = this.newRequest();
        // Snapshot metadata before any asynchronous cache or provider operation.
        track = {...track, artists: [...track.artists]};
        const cached = await this.cache.read(track, cancellable);
        if (cancellable.is_cancelled()) throw new Error('Lyrics request was cancelled');
        if (!force && cached?.fresh) return cached.result;
        let available: LyricsResult | null = isText(cached?.result) ? {...cached!.result, stale: true} : null;
        if (available) onUpdate?.({result: available, refreshing: true});
        let lastPublished = available ? JSON.stringify(available) : '';
        const publish = (result: LyricsResult) => {
            if (cancellable.is_cancelled() || !isText(result)) return;
            if (available?.status === 'synced' && result.status === 'plain') return;
            available = result;
            const fingerprint = JSON.stringify(result);
            if (fingerprint !== lastPublished) {
                lastPublished = fingerprint;
                onUpdate?.({result, refreshing: true});
            }
        };
        try {
            const outcome = await this.collect(track, cancellable, false, publish);
            if (cancellable.is_cancelled()) throw new Error('Lyrics request was cancelled');
            let result = resultFromOutcome(outcome);
            if (available && (!isText(result) || available.status === 'synced' && result.status === 'plain'))
                result = available;
            if (result.status !== 'error' && !result.stale
                && (isText(result) || outcome.errors.length === 0))
                void this.cache.write(track, result, cancellable);
            return result;
        } catch (error) {
            if (cancellable.is_cancelled()) throw error;
            return available ?? {status: 'error', candidate: null, timedLines: [], plainLines: [], message: String(error)};
        }
    }

    async search(track: TrackMetadata): Promise<LyricsCandidate[]> {
        const cancellable = this.newRequest();
        const outcome = await this.collect({...track, artists: [...track.artists]}, cancellable, true);
        if (cancellable.is_cancelled()) throw new Error('Lyrics request was cancelled');
        const result = resultFromOutcome(outcome);
        if (result.status === 'error') throw new Error(result.message);
        return outcome.candidates;
    }

    select(track: TrackMetadata, candidate: LyricsCandidate): LyricsResult {
        this.cancel();
        const result = resultFromCandidate(candidate);
        void this.cache.write(track, result);
        return result;
    }

    cancel(): void { this.cancellable?.cancel(); this.cancellable = null; }
    destroy(): void { this.cancel(); this.cache.destroy(); this.lrclib.abort(); this.netease.abort(); }
}
