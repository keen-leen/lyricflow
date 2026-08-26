import type {LyricsCandidate, LyricsResult, TimedLyricLine, TrackMetadata} from '../types.js';

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const FEATURE_SUFFIX = /\s*[\[(](?:feat\.?|ft\.?|with|live|remaster(?:ed)?)[^\])]*[\])]/giu;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const SEARCH_BRACKET_SUFFIX = /\s*[\[(]\s*(?:(?:feat\.?|ft\.?|with)\b|(?:\d{4}\s+)?remaster(?:ed)?\b|official\s+(?:(?:music\s+)?video|audio)\b|lyrics?\s+video\b)[^\])]*[\])]\s*$/iu;
const SEARCH_TEXT_SUFFIX = /\s*(?:[-\u2013\u2014]\s*)?(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|official\s+(?:(?:music\s+)?video|audio)|lyrics?\s+video)\s*$/iu;
const SEARCH_FEATURE_SUFFIX = /\s+(?:feat\.?|ft\.?|with)\s+.+$/iu;

const SEARCH_CONFIDENCE_THRESHOLD = 0.70;
const MAX_SEARCH_CANDIDATES = 8;

export function normalizeTrackText(value: string): string {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(FEATURE_SUFFIX, ' ')
        .replace(NON_WORD, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function cleanSearchText(value: string): string {
    let cleaned = value.normalize('NFKC').trim();
    // Some players expose video-site presentation text as track metadata. Strip only
    // trailing decorations for the broad fallback so the exact lookup stays lossless.
    for (let pass = 0; pass < 4; pass++) {
        const next = cleaned
            .replace(SEARCH_BRACKET_SUFFIX, '')
            .replace(SEARCH_TEXT_SUFFIX, '')
            .replace(SEARCH_FEATURE_SUFFIX, '')
            .trim();
        if (next === cleaned)
            break;
        cleaned = next;
    }
    return normalizeTrackText(cleaned);
}

export function broadSearchQuery(track: TrackMetadata): string {
    const title = cleanSearchText(track.title);
    const primaryArtist = track.artists.find(artist => artist.trim()) ?? track.artist;
    const artist = cleanSearchText(primaryArtist);
    return [title, artist].filter(Boolean).join(' ');
}

function fractionToMs(value: string | undefined): number {
    if (!value)
        return 0;
    if (value.length === 1)
        return Number(value) * 100;
    if (value.length === 2)
        return Number(value) * 10;
    return Number(value.slice(0, 3));
}

export function parseLrc(source: string): TimedLyricLine[] {
    const lines: Array<TimedLyricLine & {order: number}> = [];
    let order = 0;

    for (const rawLine of source.replace(/\r/g, '').split('\n')) {
        TIMESTAMP.lastIndex = 0;
        const stamps = [...rawLine.matchAll(TIMESTAMP)];
        if (stamps.length === 0)
            continue;

        const text = rawLine.replace(TIMESTAMP, '').trim();
        if (!text)
            continue;

        for (const stamp of stamps) {
            const minutes = Number(stamp[1]);
            const seconds = Number(stamp[2]);
            if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60)
                continue;
            lines.push({
                timeMs: minutes * 60_000 + seconds * 1_000 + fractionToMs(stamp[3]),
                text,
                order: order++,
            });
        }
    }

    return lines
        .sort((a, b) => a.timeMs - b.timeMs || a.order - b.order)
        .map(({timeMs, text}) => ({timeMs, text}));
}

export function plainLyricsToLines(source: string | null): string[] {
    return (source ?? '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
}

export function resultFromCandidate(candidate: LyricsCandidate): LyricsResult {
    if (candidate.instrumental) {
        return {status: 'instrumental', candidate, timedLines: [], plainLines: []};
    }

    const timedLines = parseLrc(candidate.syncedLyrics ?? '');
    const plainLines = plainLyricsToLines(candidate.plainLyrics);
    if (timedLines.length > 0)
        return {status: 'synced', candidate, timedLines, plainLines};
    if (plainLines.length > 0)
        return {status: 'plain', candidate, timedLines: [], plainLines};
    return {status: 'not-found', candidate, timedLines: [], plainLines: []};
}

export function lyricsCandidateQuality(candidate: LyricsCandidate): number {
    if (candidate.instrumental)
        return 1;
    if (parseLrc(candidate.syncedLyrics ?? '').length > 0)
        return 3;
    if (plainLyricsToLines(candidate.plainLyrics).length > 0)
        return 2;
    return 0;
}

export function isUsableLyricsCandidate(candidate: LyricsCandidate): boolean {
    return lyricsCandidateQuality(candidate) > 0;
}

export function decodeLyricsCandidate(value: unknown): LyricsCandidate | null {
    if (!value || typeof value !== 'object')
        return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== 'number'
        || typeof raw.trackName !== 'string'
        || typeof raw.artistName !== 'string')
        return null;
    return {
        id: raw.id,
        trackName: raw.trackName,
        artistName: raw.artistName,
        albumName: typeof raw.albumName === 'string' ? raw.albumName : '',
        duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : 0,
        instrumental: raw.instrumental === true,
        plainLyrics: typeof raw.plainLyrics === 'string' ? raw.plainLyrics : null,
        syncedLyrics: typeof raw.syncedLyrics === 'string' ? raw.syncedLyrics : null,
    };
}

export function findActiveLyricIndex(
    lines: TimedLyricLine[],
    positionMs: number,
    offsetMs = 0,
): number {
    const target = positionMs + offsetMs;
    let low = 0;
    let high = lines.length - 1;
    let answer = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const line = lines[middle];
        if (line && line.timeMs <= target) {
            answer = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return answer;
}

function similarity(left: string, right: string): number {
    const a = normalizeTrackText(left);
    const b = normalizeTrackText(right);
    if (!a || !b)
        return 0;
    if (a === b)
        return 1;
    if (a.includes(b) || b.includes(a))
        return 0.82;

    const aWords = new Set(a.split(' '));
    const bWords = new Set(b.split(' '));
    const intersection = [...aWords].filter(word => bWords.has(word)).length;
    const union = new Set([...aWords, ...bWords]).size;
    return union === 0 ? 0 : intersection / union;
}

export function scoreCandidate(track: TrackMetadata, candidate: LyricsCandidate): number {
    const title = similarity(track.title, candidate.trackName);
    const artist = similarity(track.artist, candidate.artistName);
    const album = track.album && candidate.albumName
        ? similarity(track.album, candidate.albumName)
        : 0.5;
    const trackSeconds = track.lengthUs / 1_000_000;
    const durationDifference = trackSeconds > 0 && candidate.duration > 0
        ? Math.abs(trackSeconds - candidate.duration)
        : 15;
    const duration = Math.max(0, 1 - durationDifference / 30);
    return title * 0.45 + artist * 0.30 + album * 0.10 + duration * 0.15;
}

export function rankCandidates(track: TrackMetadata, candidates: LyricsCandidate[]): LyricsCandidate[] {
    return [...candidates].sort((a, b) => {
        // Availability is a small tie-breaker: metadata remains decisive unless two
        // records are close enough that synchronized lyrics are the more useful choice.
        const aScore = scoreCandidate(track, a) + lyricsCandidateQuality(a) * 0.01;
        const bScore = scoreCandidate(track, b) + lyricsCandidateQuality(b) * 0.01;
        return bScore - aScore;
    });
}

export function needsBroadSearch(track: TrackMetadata, candidates: LyricsCandidate[]): boolean {
    return !candidates.some(candidate =>
        isUsableLyricsCandidate(candidate)
        && scoreCandidate(track, candidate) >= SEARCH_CONFIDENCE_THRESHOLD);
}

export function mergeSearchCandidates(
    track: TrackMetadata,
    ...groups: LyricsCandidate[][]
): LyricsCandidate[] {
    const byId = new Map<number, LyricsCandidate>();
    for (const candidate of groups.flat()) {
        if (!byId.has(candidate.id) && isUsableLyricsCandidate(candidate))
            byId.set(candidate.id, candidate);
    }
    return rankCandidates(track, [...byId.values()]).slice(0, MAX_SEARCH_CANDIDATES);
}

function fnv1a(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function trackCacheKey(track: TrackMetadata): string {
    const identity = [
        normalizeTrackText(track.title),
        normalizeTrackText(track.artist),
        normalizeTrackText(track.album),
        Math.round(track.lengthUs / 5_000_000),
    ].join('|');
    return `${fnv1a(identity)}-${normalizeTrackText(track.title).slice(0, 32).replace(/ /g, '-') || 'unknown'}`;
}
