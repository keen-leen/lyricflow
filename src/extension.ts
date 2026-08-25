// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import type {LyricsCandidate, LyricsResult, PlayerState} from './types.js';
import {findActiveLyricIndex, trackCacheKey} from './lyrics/core.js';
import {LyricsService} from './lyrics/service.js';
import {MprisManager} from './player/mpris.js';
import {LyricIndicator} from './ui/indicator.js';

export default class LyricFlowExtension extends Extension {
    private settings: Gio.Settings | null = null;
    private settingsSignalIds: number[] = [];
    private players: MprisManager | null = null;
    private lyricsService: LyricsService | null = null;
    private indicator: LyricIndicator | null = null;
    private player: PlayerState | null = null;
    private lyrics: LyricsResult | null = null;
    private trackKey = '';
    private trackGeneration = 0;
    private infoUntilUs = 0;
    private tickSource = 0;
    private displayedLyric = -2;

    override enable(): void {
        const settings = this.getSettings();
        this.settings = settings;
        this.lyricsService = new LyricsService();
        this.indicator = new LyricIndicator({
            previous: () => this.player && this.players?.previous(this.player),
            playPause: () => this.player && this.players?.playPause(this.player),
            next: () => this.player && this.players?.next(this.player),
            seek: fraction => this.seek(fraction),
            refreshLyrics: () => void this.searchCandidates(),
            chooseCandidate: candidate => this.chooseCandidate(candidate),
            changeOffset: deltaMs => this.changeOffset(deltaMs),
            resetOffset: () => this.settings?.set_int('lyrics-offset-ms', 0),
            openPreferences: () => this.openPreferences(),
        }, message => this.gettext(message));
        this.indicator.addToPanel(this.uuid, settings.get_string('panel-position'));
        this.applyAppearance();
        this.indicator.setOffset(settings.get_int('lyrics-offset-ms'));

        for (const key of ['max-width', 'font-scale', 'marquee-speed']) {
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

        this.players = new MprisManager(player => this.onPlayerChanged(player));
        this.players.start();
        this.tickSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this.updateUi();
            return GLib.SOURCE_CONTINUE;
        });
    }

    private applyAppearance(): void {
        if (!this.settings)
            return;
        this.indicator?.setAppearance({
            maxWidth: this.settings.get_int('max-width'),
            fontScale: this.settings.get_double('font-scale'),
            marqueeSpeed: this.settings.get_int('marquee-speed'),
        });
    }

    private onPlayerChanged(player: PlayerState | null): void {
        this.player = player;
        if (!player) {
            this.trackGeneration++;
            this.trackKey = '';
            this.lyrics = null;
            this.lyricsService?.cancel();
            this.indicator?.setVisible(false);
            return;
        }

        this.indicator?.setVisible(true);
        this.indicator?.setPlayer(player);
        const nextKey = trackCacheKey(player.track);
        if (nextKey !== this.trackKey) {
            this.trackKey = nextKey;
            this.lyrics = null;
            this.displayedLyric = -2;
            this.infoUntilUs = GLib.get_monotonic_time()
                + (this.settings?.get_int('track-info-duration') ?? 3) * 1_000_000;
            this.indicator?.showLoading();
            const generation = ++this.trackGeneration;
            void this.loadLyrics(player, generation);
        }
        this.updateUi();
    }

    private async loadLyrics(player: PlayerState, generation: number, force = false): Promise<void> {
        try {
            const result = await this.lyricsService?.load(player.track, force);
            if (!result || generation !== this.trackGeneration || this.trackKey !== trackCacheKey(player.track))
                return;
            this.lyrics = result;
            this.displayedLyric = -2;
            this.indicator?.setLyrics(result);
            this.updateUi();
        } catch (error) {
            if (generation === this.trackGeneration)
                console.debug(`LyricFlow: lyrics request ended: ${String(error)}`);
        }
    }

    private updateUi(): void {
        const player = this.player;
        const indicator = this.indicator;
        if (!player || !indicator)
            return;
        const positionUs = this.players?.getPositionUs(player) ?? player.positionUs;
        const fraction = player.track.lengthUs > 0 ? positionUs / player.track.lengthUs : 0;
        indicator.setProgress(fraction);
        indicator.setPaused(player.status !== 'Playing');

        const title = player.track.title || this.gettext('Unknown title');
        const artist = player.track.artist || this.gettext('Unknown artist');
        const trackText = artist ? `${title} · ${artist}` : title;
        const showSynced = Boolean(
            this.settings?.get_boolean('show-lyrics')
            && this.lyrics?.status === 'synced'
            && GLib.get_monotonic_time() >= this.infoUntilUs,
        );
        const index = showSynced && this.lyrics
            ? findActiveLyricIndex(
                this.lyrics.timedLines,
                positionUs / 1_000,
                this.settings?.get_int('lyrics-offset-ms') ?? 0,
            )
            : -1;
        indicator.setActiveLyric(index);
        const text = index >= 0 && this.lyrics?.timedLines[index]
            ? this.lyrics.timedLines[index].text
            : trackText;
        indicator.setPanelText(text, index !== this.displayedLyric);
        this.displayedLyric = index;
    }

    private seek(fraction: number): void {
        if (!this.player || this.player.track.lengthUs <= 0)
            return;
        this.players?.seekTo(this.player, fraction * this.player.track.lengthUs);
    }

    private async searchCandidates(): Promise<void> {
        const player = this.player;
        if (!player || !this.lyricsService)
            return;
        const generation = ++this.trackGeneration;
        this.indicator?.showLoading();
        try {
            const candidates = await this.lyricsService.search(player.track);
            if (generation === this.trackGeneration && this.trackKey === trackCacheKey(player.track))
                this.indicator?.showCandidates(candidates);
        } catch (error) {
            if (generation !== this.trackGeneration)
                return;
            this.lyrics = {
                status: 'error',
                candidate: null,
                timedLines: [],
                plainLines: [],
                message: String(error),
            };
            this.indicator?.setLyrics(this.lyrics);
        }
    }

    private chooseCandidate(candidate: LyricsCandidate): void {
        if (!this.player || !this.lyricsService)
            return;
        this.lyrics = this.lyricsService.select(this.player.track, candidate);
        this.displayedLyric = -2;
        this.indicator?.setLyrics(this.lyrics);
        this.updateUi();
    }

    private changeOffset(deltaMs: number): void {
        if (!this.settings)
            return;
        const next = Math.max(-10_000, Math.min(10_000, this.settings.get_int('lyrics-offset-ms') + deltaMs));
        this.settings.set_int('lyrics-offset-ms', next);
    }

    override disable(): void {
        this.trackGeneration++;
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
        this.indicator?.destroy();
        this.indicator = null;
        this.settings = null;
        this.player = null;
        this.lyrics = null;
        this.trackKey = '';
    }
}
