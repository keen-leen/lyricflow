export type PlaybackStatus = 'Playing' | 'Paused' | 'Stopped';
export type LyricsScriptMode = 'simplified' | 'traditional' | 'original';

export interface TrackMetadata {
    trackId: string;
    title: string;
    artists: string[];
    artist: string;
    album: string;
    lengthUs: number;
    artUrl: string;
}

export interface PlayerCapabilities {
    canGoNext: boolean;
    canGoPrevious: boolean;
    canPlay: boolean;
    canPause: boolean;
    canSeek: boolean;
    canControl: boolean;
}

export interface PlayerState {
    busName: string;
    identity: string;
    status: PlaybackStatus;
    track: TrackMetadata;
    positionUs: number;
    rate: number;
    sampledAtUs: number;
    activeSequence: number;
    capabilities: PlayerCapabilities;
}

export interface TimedLyricLine {
    timeMs: number;
    text: string;
}

export interface LyricsCandidate {
    id: number;
    source?: 'lrclib' | 'netease';
    trackName: string;
    artistName: string;
    albumName: string;
    duration: number;
    instrumental: boolean;
    plainLyrics: string | null;
    syncedLyrics: string | null;
}

export interface LyricsCandidateDisplay {
    candidate: LyricsCandidate;
    trackName: string;
    artistName: string;
    albumName: string;
}

export type LyricsStatus = 'synced' | 'plain' | 'instrumental' | 'not-found' | 'error';

export interface LyricsResult {
    status: LyricsStatus;
    candidate: LyricsCandidate | null;
    timedLines: TimedLyricLine[];
    plainLines: string[];
    message?: string;
    stale?: boolean;
}

export interface LyricsProvider {
    find(track: TrackMetadata, cancellable?: unknown): Promise<LyricsResult>;
    search(track: TrackMetadata, cancellable?: unknown): Promise<LyricsCandidate[]>;
}

export interface LyricsProviderOutcome {
    candidates: LyricsCandidate[];
    successfulRequests: number;
    errors: string[];
}

export interface CacheEntry {
    version: 1;
    searchRevision?: number;
    savedAtMs: number;
    trackKey: string;
    result: LyricsResult;
}

export interface CachedLyrics {
    result: LyricsResult;
    fresh: boolean;
}
