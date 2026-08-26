import type {
    LyricsCandidate,
    LyricsCandidateDisplay,
    LyricsResult,
    LyricsScriptMode,
    TrackMetadata,
} from '../types.js';

type TextConverter = (text: string) => string;
type OpenCcModule = {
    Converter(options: {from: string; to: string}): TextConverter;
};

const identity: TextConverter = text => text;

export function mapLyricsResult(result: LyricsResult, convert: TextConverter): LyricsResult {
    return {
        ...result,
        timedLines: result.timedLines.map(line => ({...line, text: convert(line.text)})),
        plainLines: result.plainLines.map(convert),
    };
}

export function mapLyricsCandidate(
    candidate: LyricsCandidate,
    convert: TextConverter,
): LyricsCandidateDisplay {
    return {
        candidate,
        trackName: convert(candidate.trackName),
        artistName: convert(candidate.artistName),
        albumName: convert(candidate.albumName),
    };
}

export class LyricsScriptConverter {
    private simplified: TextConverter | null = null;
    private traditional: TextConverter | null = null;
    private simplifiedPromise: Promise<TextConverter> | null = null;
    private traditionalPromise: Promise<TextConverter> | null = null;

    private getConverter(mode: LyricsScriptMode): Promise<TextConverter> {
        if (mode === 'original')
            return Promise.resolve(identity);
        if (mode === 'simplified') {
            if (this.simplified)
                return Promise.resolve(this.simplified);
            this.simplifiedPromise ??= import('../vendor/t2cn.js').then(module => {
                this.simplified = (module as OpenCcModule).Converter({from: 't', to: 'cn'});
                return this.simplified;
            });
            return this.simplifiedPromise;
        }
        if (this.traditional)
            return Promise.resolve(this.traditional);
        this.traditionalPromise ??= import('../vendor/cn2t.js').then(module => {
            this.traditional = (module as OpenCcModule).Converter({from: 'cn', to: 't'});
            return this.traditional;
        });
        return this.traditionalPromise;
    }

    async convertText(text: string, mode: LyricsScriptMode): Promise<string> {
        return (await this.getConverter(mode))(text);
    }

    async convertTrack(
        track: TrackMetadata,
        mode: LyricsScriptMode,
    ): Promise<{title: string; artist: string}> {
        const convert = await this.getConverter(mode);
        return {title: convert(track.title), artist: convert(track.artist)};
    }

    async convertResult(result: LyricsResult, mode: LyricsScriptMode): Promise<LyricsResult> {
        return mapLyricsResult(result, await this.getConverter(mode));
    }

    async convertCandidates(
        candidates: LyricsCandidate[],
        mode: LyricsScriptMode,
    ): Promise<LyricsCandidateDisplay[]> {
        const convert = await this.getConverter(mode);
        return candidates.map(candidate => mapLyricsCandidate(candidate, convert));
    }
}
