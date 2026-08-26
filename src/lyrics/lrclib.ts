import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import type {LyricsCandidate, LyricsProvider, LyricsResult, TrackMetadata} from '../types.js';
import {
    broadSearchQuery,
    decodeLyricsCandidate,
    isUsableLyricsCandidate,
    mergeSearchCandidates,
    needsBroadSearch,
    resultFromCandidate,
} from './core.js';

const BASE_URL = 'https://lrclib.net';
const USER_AGENT = 'LyricFlow/0.1.0 (https://github.com/keen/lyricflow)';

class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

function params(values: Record<string, string | number | undefined>): string {
    return Object.entries(values)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
}

export class LrclibProvider implements LyricsProvider {
    private readonly session = new Soup.Session({user_agent: USER_AGENT, timeout: 12});

    private request(url: string, cancellable?: unknown): Promise<unknown> {
        const message = Soup.Message.new('GET', url);
        return new Promise((resolve, reject) => {
            this.session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable instanceof Gio.Cancellable ? cancellable : null,
                (session, result) => {
                    try {
                        const bytes = session?.send_and_read_finish(result);
                        const status = message.status_code;
                        if (status < 200 || status >= 300)
                            throw new HttpError(status, `LRCLIB returned HTTP ${status}`);
                        const text = new TextDecoder().decode(bytes?.get_data() ?? new Uint8Array());
                        resolve(JSON.parse(text));
                    } catch (error) {
                        reject(error);
                    }
                },
            );
        });
    }

    async find(track: TrackMetadata, cancellable?: unknown): Promise<LyricsResult> {
        const query = params({
            track_name: track.title,
            artist_name: track.artist,
            album_name: track.album || undefined,
            duration: track.lengthUs > 0 ? Math.round(track.lengthUs / 1_000_000) : undefined,
        });
        try {
            const value = await this.request(`${BASE_URL}/api/get?${query}`, cancellable);
            const candidate = decodeLyricsCandidate(value);
            if (candidate && isUsableLyricsCandidate(candidate))
                return resultFromCandidate(candidate);
        } catch (error) {
            if (!(error instanceof HttpError) || error.status !== 404)
                throw error;
        }

        const candidates = await this.search(track, cancellable);
        const best = candidates[0];
        return best
            ? resultFromCandidate(best)
            : {status: 'not-found', candidate: null, timedLines: [], plainLines: []};
    }

    async search(track: TrackMetadata, cancellable?: unknown): Promise<LyricsCandidate[]> {
        const structuredQuery = params({track_name: track.title, artist_name: track.artist});
        const structuredValue = await this.request(`${BASE_URL}/api/search?${structuredQuery}`, cancellable);
        const structuredCandidates = Array.isArray(structuredValue)
            ? structuredValue.map(decodeLyricsCandidate).filter((candidate): candidate is LyricsCandidate => candidate !== null)
            : [];
        if (!needsBroadSearch(track, structuredCandidates))
            return mergeSearchCandidates(track, structuredCandidates);

        const keywordQuery = broadSearchQuery(track);
        if (!keywordQuery)
            return mergeSearchCandidates(track, structuredCandidates);

        try {
            const broadValue = await this.request(
                `${BASE_URL}/api/search?${params({q: keywordQuery})}`,
                cancellable,
            );
            const broadCandidates = Array.isArray(broadValue)
                ? broadValue.map(decodeLyricsCandidate).filter((candidate): candidate is LyricsCandidate => candidate !== null)
                : [];
            return mergeSearchCandidates(track, structuredCandidates, broadCandidates);
        } catch (error) {
            if (cancellable instanceof Gio.Cancellable && cancellable.is_cancelled())
                throw error;
            const candidates = mergeSearchCandidates(track, structuredCandidates);
            if (candidates.length > 0)
                return candidates;
            throw error;
        }
    }

    abort(): void {
        this.session.abort();
    }
}
