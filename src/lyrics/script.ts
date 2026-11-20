import type {
    LyricsCandidate,
    LyricsCandidateDisplay,
    LyricsResult,
    LyricsScriptMode,
    TrackMetadata,
} from '../types.js';

type TextConverter = (text: string) => string;
type OpenCcPreset = Parameters<typeof import('../vendor/core.js').ConverterBuilder>[0];

const identity: TextConverter = text => text;

async function buildConverter(preset: Promise<OpenCcPreset>, from: string, to: string): Promise<TextConverter> {
    const [{ConverterBuilder}, locale] = await Promise.all([import('../vendor/core.js'), preset]);
    return ConverterBuilder(locale)({from, to});
}

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
    private simplifiedPromise: Promise<TextConverter> | null = null;
    private traditionalPromise: Promise<TextConverter> | null = null;

    private getConverter(mode: LyricsScriptMode): Promise<TextConverter> {
        if (mode === 'original')
            return Promise.resolve(identity);
        if (mode === 'simplified')
            return this.simplifiedPromise ??= buildConverter(import('../vendor/preset/t2cn.js'), 't', 'cn');
        return this.traditionalPromise ??= buildConverter(import('../vendor/preset/cn2t.js'), 'cn', 't');
    }

    async convertText(text: string, mode: LyricsScriptMode): Promise<string> {
        return (await this.getConverter(mode))(text);
    }

    async convertTrack(
        track: TrackMetadata,
        mode: LyricsScriptMode,
    ): Promise<{title: string; artist: string; album: string}> {
        const convert = await this.getConverter(mode);
        return {
            title: convert(track.title),
            artist: convert(track.artist),
            album: convert(track.album),
        };
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
