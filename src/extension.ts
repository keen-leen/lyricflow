import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import type {
    LyricsCandidate,
    LyricsCandidateDisplay,
    LyricsResult,
    LyricsScriptMode,
    PlayerState,
} from './types.js';
import {findActiveLyricIndex} from './lyrics/core.js';
import {LyricsScriptConverter, mapLyricsCandidate} from './lyrics/script.js';
import {LyricsService, type LyricsLoadUpdate} from './lyrics/service.js';
import {playbackIdentity} from './player/identity.js';
import {MprisManager} from './player/mpris.js';
import {clampPositionUs, displayedPositionUs, lyricSeekPositionUs} from './player/position.js';
import {LyricIndicator} from './ui/indicator.js';
import {nextPanelRefreshMs} from './ui/refresh-policy.js';
import {parseLiquidGlassStrength} from './ui/glass.js';

export default class LyricFlowExtension extends Extension {
    private settings: Gio.Settings | null = null;
    private running = false;
    private settingsSignalIds: number[] = [];
    private players: MprisManager | null = null;
    private lyricsService: LyricsService | null = null;
    private scriptConverter: LyricsScriptConverter | null = null;
    private indicator: LyricIndicator | null = null;
    private player: PlayerState | null = null;
    private lyrics: LyricsResult | null = null;
    private displayLyrics: LyricsResult | null = null;
    private searchCandidatesRaw: LyricsCandidate[] | null = null;
    private displayTitle = '';
    private displayArtist = '';
    private trackKey = '';
    private trackGeneration = 0;
    private displayGeneration = 0;
    private infoUntilUs = 0;
    private tickSource = 0;
    private progressTick = false;
    private displayedLyric = -2;
    private previewPositionUs: number | null = null;

    override enable(): void {
        this.running = true;
        const settings = this.getSettings();
        this.settings = settings;
        this.lyricsService = new LyricsService();
        this.scriptConverter = new LyricsScriptConverter();
        this.indicator = new LyricIndicator({
            menuChanged: () => this.updateUi(),
            previous: () => this.player && this.players?.previous(this.player),
            playPause: () => this.player && this.players?.playPause(this.player),
            next: () => this.player && this.players?.next(this.player),
            previewSeek: fraction => this.previewSeek(fraction),
            seek: fraction => this.seek(fraction),
            seekToLyric: timeMs => this.seekToLyric(timeMs),
            refreshLyrics: () => void this.searchCandidates(),
            chooseCandidate: candidate => this.chooseCandidate(candidate),
            changeOffset: deltaMs => this.changeOffset(deltaMs),
            resetOffset: () => this.settings?.set_int('lyrics-offset-ms', 0),
            openPreferences: () => this.openPreferences(),
        }, message => this.gettext(message));
        this.indicator.addToPanel(this.uuid, settings.get_string('panel-position'));
        this.applyAppearance();
        this.indicator.setOffset(settings.get_int('lyrics-offset-ms'));

        for (const key of [
            'max-width',
            'font-scale',
            'marquee-speed',
            'liquid-glass-enabled',
            'liquid-glass-strength',
        ]) {
            this.settingsSignalIds.push(settings.connect(`changed::${key}`, () => this.applyAppearance()));
        }
        this.settingsSignalIds.push(settings.connect('changed::panel-position', () => {
            if (this.settings)
                this.indicator?.move(this.settings.get_string('panel-position'));
        }));
        this.settingsSignalIds.push(settings.connect('changed::lyrics-offset-ms', () => {
            if (!this.settings)
                return;
            this.indicator?.setOffset(this.settings.get_int('lyrics-offset-ms'));
            this.displayedLyric = -2;
            this.updateUi();
        }));
        this.settingsSignalIds.push(settings.connect('changed::show-lyrics', () => this.updateUi()));
        this.settingsSignalIds.push(settings.connect('changed::lyrics-script', () => {
            void this.refreshDisplay();
        }));

        this.players = new MprisManager(player => this.onPlayerChanged(player));
        this.players.start();
        this.updateUi();
    }

    private applyAppearance(): void {
        if (!this.settings)
            return;
        this.indicator?.setAppearance({
            maxWidth: this.settings.get_int('max-width'),
            fontScale: this.settings.get_double('font-scale'),
            marqueeSpeed: this.settings.get_int('marquee-speed'),
            liquidGlassEnabled: this.settings.get_boolean('liquid-glass-enabled'),
            liquidGlassStrength: parseLiquidGlassStrength(this.settings.get_string('liquid-glass-strength')),
        });
    }

    private onPlayerChanged(player: PlayerState | null): void {
        this.player = player;
        if (!player) {
            this.previewPositionUs = null;
            this.trackGeneration++;
            this.displayGeneration++;
            this.trackKey = '';
            this.lyrics = null;
            this.displayLyrics = null;
            this.searchCandidatesRaw = null;
            this.lyricsService?.cancel();
            this.indicator?.setVisible(false);
            this.scheduleTick();
            return;
        }

        this.indicator?.setVisible(true);
        const nextKey = playbackIdentity(player);
        if (nextKey !== this.trackKey)
            this.previewPositionUs = null;
        const sameTrack = nextKey === this.trackKey;
        this.indicator?.setPlayer(player, sameTrack ? {
            title: this.displayTitle,
            artist: this.displayArtist,
            album: player.track.album,
        } : undefined);
        if (nextKey !== this.trackKey) {
            this.lyricsService?.cancel();
            this.trackKey = nextKey;
            this.lyrics = null;
            this.displayLyrics = null;
            this.searchCandidatesRaw = null;
            this.displayTitle = player.track.title;
            this.displayArtist = player.track.artist;
            this.displayedLyric = -2;
            this.infoUntilUs = GLib.get_monotonic_time()
                + (this.settings?.get_int('track-info-duration') ?? 3) * 1_000_000;
            this.indicator?.showLoading();
            const generation = ++this.trackGeneration;
            void this.refreshDisplay();
            void this.loadLyrics(player, generation);
        }
        this.updateUi();
    }

    private async applyLyricsUpdate(player: PlayerState, generation: number, update: LyricsLoadUpdate): Promise<void> {
        if (generation !== this.trackGeneration || this.trackKey !== playbackIdentity(player)) return;
        this.lyrics = update.result;
        this.searchCandidatesRaw = null;
        this.displayedLyric = -2;
        this.indicator?.setRequestState(update.refreshing ? this.gettext('Refreshing lyrics…') : null);
        await this.refreshDisplay();
    }

    private async loadLyrics(player: PlayerState, generation: number, force = false): Promise<void> {
        try {
            const result = await this.lyricsService?.load(player.track, force,
                update => void this.applyLyricsUpdate(player, generation, update));
            if (result) await this.applyLyricsUpdate(player, generation, {result, refreshing: false});
        } catch (error) {
            if (generation === this.trackGeneration)
                console.debug(`LyricFlow: lyrics request ended: ${String(error)}`);
        }
    }

    private updateUi(reschedule = true): void {
        const player = this.player;
        const indicator = this.indicator;
        if (!this.running || !player || !indicator)
            return;
        const actualPositionUs = this.players?.getPositionUs(player) ?? player.positionUs;
        const positionUs = displayedPositionUs(actualPositionUs, this.previewPositionUs);
        const fraction = player.track.lengthUs > 0 ? positionUs / player.track.lengthUs : 0;
        if (indicator.menuOpen)
            indicator.setProgress(fraction, positionUs, player.track.lengthUs);
        indicator.setPaused(player.status !== 'Playing');

        const title = player.track.title || this.gettext('Unknown title');
        const artist = player.track.artist || this.gettext('Unknown artist');
        const trackText = artist ? `${title} · ${artist}` : title;
        const showSynced = Boolean(
            this.settings?.get_boolean('show-lyrics')
            && this.displayLyrics?.status === 'synced'
            && GLib.get_monotonic_time() >= this.infoUntilUs,
        );
        const index = showSynced && this.displayLyrics
            ? findActiveLyricIndex(
                this.displayLyrics.timedLines,
                positionUs / 1_000,
                this.settings?.get_int('lyrics-offset-ms') ?? 0,
            )
            : -1;
        indicator.setActiveLyric(index);
        const text = index >= 0 && this.displayLyrics?.timedLines[index]
            ? this.displayLyrics.timedLines[index].text
            : (this.displayArtist ? `${this.displayTitle} · ${this.displayArtist}` : this.displayTitle) || trackText;
        indicator.setPanelText(text, index !== this.displayedLyric);
        this.displayedLyric = index;
        if (reschedule) this.scheduleTick();
    }

    private scheduleTick(): void {
        const player = this.player;
        const indicator = this.indicator;
        const progressTick = Boolean(this.running && player?.status === 'Playing' && indicator?.menuOpen);
        if (progressTick && this.progressTick && this.tickSource) return;
        const lines = this.settings?.get_boolean('show-lyrics') && this.displayLyrics?.status === 'synced'
            ? this.displayLyrics.timedLines : [];
        const delay = !this.running || !player || !indicator ? null : progressTick ? 100 : nextPanelRefreshMs(
            lines, this.players?.getPositionUs(player) ?? player.positionUs,
            player.track.lengthUs, player.rate, this.settings?.get_int('lyrics-offset-ms') ?? 0,
            (this.infoUntilUs - GLib.get_monotonic_time()) / 1000, player.status === 'Playing',
        );
        if (this.tickSource) GLib.source_remove(this.tickSource);
        this.tickSource = 0;
        this.progressTick = progressTick;
        if (delay === null) return;
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            if (!progressTick) this.tickSource = 0;
            this.updateUi(!progressTick);
            return progressTick && this.tickSource === source ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        this.tickSource = source;
    }

    private seek(fraction: number): void {
        if (!this.player || this.player.track.lengthUs <= 0)
            return;
        const positionUs = clampPositionUs(fraction * this.player.track.lengthUs, this.player.track.lengthUs);
        this.previewPositionUs = null;
        this.players?.seekTo(this.player, positionUs);
        this.updateUi();
    }

    private previewSeek(fraction: number): void {
        if (!this.player || this.player.track.lengthUs <= 0)
            return;
        this.previewPositionUs = clampPositionUs(
            fraction * this.player.track.lengthUs,
            this.player.track.lengthUs,
        );
        this.updateUi();
    }

    private seekToLyric(timeMs: number): void {
        const player = this.player;
        if (!player || !this.players
            || !player.capabilities.canControl || !player.capabilities.canSeek)
            return;
        const targetUs = lyricSeekPositionUs(
            timeMs,
            this.settings?.get_int('lyrics-offset-ms') ?? 0,
            player.track.lengthUs,
        );
        this.previewPositionUs = null;
        this.players.seekTo(player, targetUs);
        if (player.status !== 'Playing' && player.capabilities.canPlay)
            this.players.play(player);
        this.updateUi();
    }

    private async searchCandidates(): Promise<void> {
        const player = this.player;
        if (!player || !this.lyricsService)
            return;
        const generation = ++this.trackGeneration;
        this.indicator?.setRequestState(this.gettext('Searching for lyrics…'));
        try {
            const candidates = await this.lyricsService.search(player.track);
            if (generation === this.trackGeneration && this.trackKey === playbackIdentity(player)) {
                this.searchCandidatesRaw = candidates;
                this.indicator?.setRequestState(null);
                await this.refreshDisplay();
            }
        } catch (error) {
            if (generation !== this.trackGeneration)
                return;
            if (this.lyrics && (this.lyrics.status === 'synced' || this.lyrics.status === 'plain')) {
                this.searchCandidatesRaw = null;
                this.indicator?.setRequestState(this.gettext('Search failed; keeping current lyrics'));
                await this.refreshDisplay();
            } else {
                this.lyrics = {status: 'error', candidate: null, timedLines: [], plainLines: [], message: String(error)};
                this.searchCandidatesRaw = null;
                this.indicator?.setRequestState(null);
                await this.refreshDisplay();
            }
        }
    }

    private chooseCandidate(candidate: LyricsCandidate): void {
        if (!this.player || !this.lyricsService)
            return;
        this.trackGeneration++;
        this.indicator?.setRequestState(null);
        this.lyrics = this.lyricsService.select(this.player.track, candidate);
        this.searchCandidatesRaw = null;
        this.displayedLyric = -2;
        void this.refreshDisplay();
    }

    private scriptMode(): LyricsScriptMode {
        const value = this.settings?.get_string('lyrics-script');
        return value === 'traditional' || value === 'original' ? value : 'simplified';
    }

    private async refreshDisplay(): Promise<void> {
        const player = this.player;
        const converter = this.scriptConverter;
        if (!player || !converter)
            return;
        const generation = ++this.displayGeneration;
        const expectedTrackKey = this.trackKey;
        const mode = this.scriptMode();
        const rawLyrics = this.lyrics;
        const rawCandidates = this.searchCandidatesRaw;
        try {
            const [track, lyrics, candidates] = await Promise.all([
                converter.convertTrack(player.track, mode),
                rawLyrics ? converter.convertResult(rawLyrics, mode) : Promise.resolve(null),
                rawCandidates ? converter.convertCandidates(rawCandidates, mode) : Promise.resolve(null),
            ]);
            if (generation !== this.displayGeneration
                || expectedTrackKey !== this.trackKey
                || player.busName !== this.player?.busName)
                return;
            this.applyDisplay(track, lyrics, candidates);
        } catch (error) {
            if (generation !== this.displayGeneration || expectedTrackKey !== this.trackKey)
                return;
            console.warn(`LyricFlow: Chinese script conversion failed, using original text: ${String(error)}`);
            this.applyDisplay(
                {title: player.track.title, artist: player.track.artist, album: player.track.album},
                rawLyrics,
                rawCandidates?.map(candidate => mapLyricsCandidate(candidate, text => text)) ?? null,
            );
        }
    }

    private applyDisplay(
        track: {title: string; artist: string; album: string},
        lyrics: LyricsResult | null,
        candidates: LyricsCandidateDisplay[] | null,
    ): void {
        this.displayTitle = track.title;
        this.displayArtist = track.artist;
        this.displayLyrics = lyrics;
        if (this.player)
            this.indicator?.setPlayer(this.player, track);
        if (candidates)
            this.indicator?.showCandidates(candidates);
        else if (lyrics)
            this.indicator?.setLyrics(lyrics);
        this.displayedLyric = -2;
        this.updateUi();
    }

    private changeOffset(deltaMs: number): void {
        if (!this.settings)
            return;
        const next = Math.max(-10_000, Math.min(10_000, this.settings.get_int('lyrics-offset-ms') + deltaMs));
        this.settings.set_int('lyrics-offset-ms', next);
    }

    override disable(): void {
        this.running = false;
        this.trackGeneration++;
        this.displayGeneration++;
        if (this.tickSource) {
            GLib.source_remove(this.tickSource);
            this.tickSource = 0;
        }
        if (this.settings) {
            for (const id of this.settingsSignalIds)
                this.settings.disconnect(id);
        }
        this.settingsSignalIds = [];
        this.players?.destroy();
        this.players = null;
        this.lyricsService?.destroy();
        this.lyricsService = null;
        this.scriptConverter = null;
        this.indicator?.destroy();
        this.indicator = null;
        this.settings = null;
        this.player = null;
        this.previewPositionUs = null;
        this.lyrics = null;
        this.displayLyrics = null;
        this.searchCandidatesRaw = null;
        this.displayTitle = '';
        this.displayArtist = '';
        this.trackKey = '';
    }
}
