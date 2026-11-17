import type {LyricsCandidate, LyricsProviderOutcome, TrackMetadata} from '../types.js';
import {isTextLyricsCandidate, mergeSearchCandidates} from './core.js';

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
