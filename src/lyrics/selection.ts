import type {LyricsCandidate, LyricsProviderOutcome, LyricsResult, TrackMetadata} from '../types.js';
import {isTextLyricsCandidate, mergeSearchCandidates, resultFromCandidate} from './core.js';

export interface CombinedLyricsOutcome {
    candidates: LyricsCandidate[];
    successfulRequests: number;
    errors: string[];
}

export function combineProviderOutcomes(
    track: TrackMetadata,
    primary: LyricsProviderOutcome,
    fallback: LyricsProviderOutcome,
): CombinedLyricsOutcome {
    const errors = [
        ...primary.errors.map(error => `LRCLIB ${error}`),
        ...fallback.errors.map(error => `NetEase ${error}`),
    ];
    const successfulRequests = primary.successfulRequests + fallback.successfulRequests;
    const textCandidates = mergeSearchCandidates(track, primary.candidates, fallback.candidates)
        .filter(isTextLyricsCandidate);
    if (textCandidates.length > 0)
        return {candidates: textCandidates, successfulRequests, errors};

    const primaryInstrumental = primary.candidates.find(candidate => candidate.instrumental);
    const fallbackInstrumental = fallback.candidates.find(candidate => candidate.instrumental);
    return {
        candidates: primaryInstrumental && fallbackInstrumental
            ? [{...primaryInstrumental, instrumental: true}]
            : [],
        successfulRequests,
        errors,
    };
}

export function resultFromOutcome(outcome: CombinedLyricsOutcome): LyricsResult {
    const best = outcome.candidates[0];
    if (best)
        return resultFromCandidate(best);
    if (outcome.errors.length > 0 || outcome.successfulRequests === 0) {
        return {
            status: 'error', candidate: null, timedLines: [], plainLines: [],
            message: outcome.errors.join('; ') || 'No lyrics query completed',
        };
    }
    return {status: 'not-found', candidate: null, timedLines: [], plainLines: []};
}
