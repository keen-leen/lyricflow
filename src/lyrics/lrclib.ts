import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import type {LyricsCandidate, LyricsProviderOutcome, LyricsResult, TrackMetadata} from '../types.js';
import {
    broadSearchQuery,
    candidateMatch,
    decodeLyricsCandidate,
    mergeSearchCandidates,
    needsBroadSearch,
    resultFromCandidate,
} from './core.js';
import {HttpError, queryParams, requestJson} from './http.js';

const BASE_URL = 'https://lrclib.net';
const USER_AGENT = 'LyricFlow/0.1.1 (https://github.com/keen-leen/lyricflow)';

function decodeCandidateList(value: unknown): LyricsCandidate[] {
    return Array.isArray(value)
        ? value.map(decodeLyricsCandidate).filter((candidate): candidate is LyricsCandidate => candidate !== null)
        : [];
}

function isCancelled(cancellable?: unknown): boolean {
    return cancellable instanceof Gio.Cancellable && cancellable.is_cancelled();
}

function logCandidates(track: TrackMetadata, stage: string, candidates: LyricsCandidate[]): void {
    console.debug(`LyricFlow: ${stage} decoded ${candidates.length} candidates`);
    for (const candidate of candidates.slice(0, 8)) {
        const match = candidateMatch(track, candidate);
        console.debug(
            `LyricFlow: ${stage} candidate lrclib:${candidate.id}`
            + ` score=${match.score.toFixed(3)} title=${match.title.toFixed(3)}`
            + ` artist=${match.artist.toFixed(3)} album=${match.album.toFixed(3)}`
            + ` durationDelta=${match.durationDifference?.toFixed(1) ?? 'unknown'}`
            + ` qualified=${match.qualified}`,
        );
    }
}

export class LrclibProvider {
    private readonly session = new Soup.Session({user_agent: USER_AGENT, timeout: 12});

    async collect(track: TrackMetadata, cancellable?: unknown, onUpdate?: (outcome: LyricsProviderOutcome) => void): Promise<LyricsProviderOutcome> {
        const groups: LyricsCandidate[][] = [];
        const errors: string[] = [];
        let successfulRequests = 0;
        const publish = () => {
            if (!isCancelled(cancellable)) onUpdate?.({
                candidates: mergeSearchCandidates(track, ...groups), successfulRequests, errors: [...errors],
            });
        };

        const exactQuery = queryParams({
            track_name: track.title,
            artist_name: track.artist,
            album_name: track.album || undefined,
            duration: track.lengthUs > 0 ? Math.round(track.lengthUs / 1_000_000) : undefined,
        });
        try {
            const value = await requestJson(
                this.session,
                `${BASE_URL}/api/get?${exactQuery}`,
                'LRCLIB exact search',
                cancellable,
            );
            successfulRequests++;
            const candidate = decodeLyricsCandidate(value);
            const candidates = candidate ? [candidate] : [];
            groups.push(candidates);
            logCandidates(track, 'LRCLIB exact search', candidates);
            const merged = mergeSearchCandidates(track, ...groups);
            if (!needsBroadSearch(track, merged))
                return {candidates: merged, successfulRequests, errors};
        } catch (error) {
            if (isCancelled(cancellable))
                throw error;
            if (error instanceof HttpError && error.status === 404)
                successfulRequests++;
            else
                errors.push(`exact: ${String(error)}`);
            console.debug(`LyricFlow: LRCLIB exact search did not produce synchronized lyrics: ${String(error)}`);
        } finally {
            publish();
        }

        try {
            const structuredQuery = queryParams({track_name: track.title, artist_name: track.artist});
            const value = await requestJson(
                this.session,
                `${BASE_URL}/api/search?${structuredQuery}`,
                'LRCLIB structured search',
                cancellable,
            );
            successfulRequests++;
            const candidates = decodeCandidateList(value);
            groups.push(candidates);
            logCandidates(track, 'LRCLIB structured search', candidates);
            const merged = mergeSearchCandidates(track, ...groups);
            if (!needsBroadSearch(track, merged))
                return {candidates: merged, successfulRequests, errors};
        } catch (error) {
            if (isCancelled(cancellable))
                throw error;
            errors.push(`structured: ${String(error)}`);
            console.debug(`LyricFlow: LRCLIB structured search failed: ${String(error)}`);
        } finally {
            publish();
        }

        const broadQuery = broadSearchQuery(track);
        if (broadQuery) {
            try {
                const value = await requestJson(
                    this.session,
                    `${BASE_URL}/api/search?${queryParams({q: broadQuery})}`,
                    'LRCLIB broad search',
                    cancellable,
                );
                successfulRequests++;
                const candidates = decodeCandidateList(value);
                groups.push(candidates);
                logCandidates(track, 'LRCLIB broad search', candidates);
            } catch (error) {
                if (isCancelled(cancellable))
                    throw error;
                errors.push(`broad: ${String(error)}`);
                console.debug(`LyricFlow: LRCLIB broad search failed: ${String(error)}`);
            } finally {
                publish();
            }
        }

        return {candidates: mergeSearchCandidates(track, ...groups), successfulRequests, errors};
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
