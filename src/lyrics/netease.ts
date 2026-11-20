import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import type {LyricsCandidate, LyricsProviderOutcome, LyricsResult, TrackMetadata} from '../types.js';
import {
    broadSearchQuery,
    isQualifiedCandidate,
    lyricsCandidateQuality,
    mergeSearchCandidates,
    resultFromCandidate,
    scoreCandidate,
} from './core.js';
import {queryParams, requestJson} from './http.js';
import {addNeteaseLyrics, decodeNeteaseSearch} from './netease-core.js';

const BASE_URL = 'https://music.163.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) LyricFlow/0.1.0';
const MAX_LYRIC_REQUESTS = 5;

function isCancelled(cancellable?: unknown): boolean {
    return cancellable instanceof Gio.Cancellable && cancellable.is_cancelled();
}

export class NeteaseProvider {
    private readonly session = new Soup.Session({user_agent: USER_AGENT, timeout: 12});

    async collect(track: TrackMetadata, cancellable?: unknown, onUpdate?: (outcome: LyricsProviderOutcome) => void): Promise<LyricsProviderOutcome> {
        const errors: string[] = [];
        let successfulRequests = 0;
        const candidates: LyricsCandidate[] = [];
        const publish = () => {
            if (!isCancelled(cancellable)) onUpdate?.({
                candidates: mergeSearchCandidates(track, candidates), successfulRequests, errors: [...errors],
            });
        };
        const query = broadSearchQuery(track);
        if (!query)
            return {candidates: [], successfulRequests, errors};

        let metadataCandidates: LyricsCandidate[] = [];
        try {
            const value = await requestJson(
                this.session,
                `${BASE_URL}/api/search/get/web?${queryParams({
                    s: query,
                    type: 1,
                    offset: 0,
                    limit: 20,
                })}`,
                'NetEase song search',
                cancellable,
            );
            successfulRequests++;
            metadataCandidates = decodeNeteaseSearch(value)
                .filter(candidate => isQualifiedCandidate(track, candidate))
                .sort((a, b) => scoreCandidate(track, b) - scoreCandidate(track, a))
                .slice(0, MAX_LYRIC_REQUESTS);
        } catch (error) {
            if (isCancelled(cancellable))
                throw error;
            errors.push(`search: ${String(error)}`);
            console.debug(`LyricFlow: NetEase song search failed: ${String(error)}`);
            return {candidates: [], successfulRequests, errors};
        } finally {
            publish();
        }

        for (const metadata of metadataCandidates) {
            try {
                const value = await requestJson(
                    this.session,
                    `${BASE_URL}/api/song/lyric?${queryParams({id: metadata.id, lv: 1, kv: 1, tv: -1})}`,
                    'NetEase lyrics fetch',
                    cancellable,
                );
                successfulRequests++;
                const candidate = addNeteaseLyrics(metadata, value);
                const quality = lyricsCandidateQuality(candidate);
                if (quality > 0)
                    candidates.push(candidate);
                if (quality === 3)
                    break;
            } catch (error) {
                if (isCancelled(cancellable))
                    throw error;
                errors.push(`lyrics:${metadata.id}: ${String(error)}`);
                console.debug(`LyricFlow: NetEase lyrics fetch failed for candidate ${metadata.id}: ${String(error)}`);
            } finally {
                publish();
            }
        }

        return {
            candidates: mergeSearchCandidates(track, candidates),
            successfulRequests,
            errors,
        };
    }

    async find(track: TrackMetadata, cancellable?: unknown): Promise<LyricsResult> {
        const outcome = await this.collect(track, cancellable);
        const best = outcome.candidates[0];
        return best
            ? resultFromCandidate(best)
            : {status: 'not-found', candidate: null, timedLines: [], plainLines: []};
    }

    async search(track: TrackMetadata, cancellable?: unknown): Promise<LyricsCandidate[]> {
        return (await this.collect(track, cancellable)).candidates;
    }

    abort(): void {
        this.session.abort();
    }
}
