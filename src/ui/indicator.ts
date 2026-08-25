import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import type {LyricsCandidate, LyricsResult, PlayerState} from '../types.js';

export interface IndicatorActions {
    previous(): void;
    playPause(): void;
    next(): void;
    seek(fraction: number): void;
    refreshLyrics(): void;
    chooseCandidate(candidate: LyricsCandidate): void;
    changeOffset(deltaMs: number): void;
    resetOffset(): void;
    openPreferences(): void;
}

export interface IndicatorAppearance {
    maxWidth: number;
    fontScale: number;
    marqueeSpeed: number;
}

function iconButton(iconName: string, label: string): St.Button {
    return new St.Button({
        style_class: 'lyricflow-icon-button',
        child: new St.Icon({icon_name: iconName, icon_size: 18}),
        accessible_name: label,
        can_focus: true,
        reactive: true,
        track_hover: true,
    });
}

export class LyricIndicator {
    readonly button: PanelMenu.Button;

    private readonly panelBin: St.Bin;
    private readonly panelLabel: St.Label;
    private readonly root: St.BoxLayout;
    private readonly artwork: St.Bin;
    private readonly titleLabel: St.Label;
    private readonly artistLabel: St.Label;
    private readonly playerLabel: St.Label;
    private readonly progress: Slider;
    private readonly previousButton: St.Button;
    private readonly playButton: St.Button;
    private readonly nextButton: St.Button;
    private readonly statusLabel: St.Label;
    private readonly lyricsBox: St.BoxLayout;
    private readonly scrollView: St.ScrollView;
    private readonly offsetLabel: St.Label;
    private readonly searchButton: St.Button;
    private lyricLabels: St.Label[] = [];
    private activeIndex = -1;
    private marqueeSource = 0;
    private suppressSeek = false;
    private disposed = false;
    private appearance: IndicatorAppearance = {maxWidth: 360, fontScale: 1, marqueeSpeed: 36};

    constructor(
        private readonly actions: IndicatorActions,
        private readonly gettext: (message: string) => string,
    ) {
        this.button = new PanelMenu.Button(0, 'LyricFlow', false);
        this.button.connect('destroy', () => {
            this.disposed = true;
            if (this.marqueeSource) {
                GLib.source_remove(this.marqueeSource);
                this.marqueeSource = 0;
            }
        });
        this.button.visible = false;
        this.button.add_style_class_name('lyricflow-indicator');

        this.panelLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'lyricflow-panel-label',
        });
        this.panelLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this.panelLabel.clutter_text.set_single_line_mode(true);
        this.panelBin = new St.Bin({
            child: this.panelLabel,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            clip_to_allocation: true,
        });
        this.button.add_child(this.panelBin);

        const menuItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        menuItem.add_style_class_name('lyricflow-menu-item');
        this.root = new St.BoxLayout({vertical: true, style_class: 'lyricflow-card'});
        menuItem.add_child(this.root);
        (this.button.menu as PopupMenu.PopupMenu).addMenuItem(menuItem);

        const header = new St.BoxLayout({vertical: false, style_class: 'lyricflow-header'});
        this.artwork = new St.Bin({style_class: 'lyricflow-artwork'});
        this.setArtwork('');
        header.add_child(this.artwork);
        const metadata = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'lyricflow-metadata'});
        this.titleLabel = new St.Label({style_class: 'lyricflow-title'});
        this.titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this.artistLabel = new St.Label({style_class: 'lyricflow-artist'});
        this.artistLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this.playerLabel = new St.Label({style_class: 'lyricflow-player'});
        metadata.add_child(this.titleLabel);
        metadata.add_child(this.artistLabel);
        metadata.add_child(this.playerLabel);
        header.add_child(metadata);
        this.root.add_child(header);

        this.progress = new Slider(0);
        this.progress.add_style_class_name('lyricflow-progress');
        this.progress.connect('drag-end', () => {
            if (!this.suppressSeek)
                this.actions.seek(this.progress.value);
        });
        this.root.add_child(this.progress);

        const controls = new St.BoxLayout({style_class: 'lyricflow-controls', x_align: Clutter.ActorAlign.CENTER});
        this.previousButton = iconButton('media-skip-backward-symbolic', this.gettext('Previous'));
        this.playButton = iconButton('media-playback-start-symbolic', this.gettext('Play or pause'));
        this.playButton.add_style_class_name('lyricflow-play-button');
        this.nextButton = iconButton('media-skip-forward-symbolic', this.gettext('Next'));
        this.previousButton.connect('clicked', () => this.actions.previous());
        this.playButton.connect('clicked', () => this.actions.playPause());
        this.nextButton.connect('clicked', () => this.actions.next());
        controls.add_child(this.previousButton);
        controls.add_child(this.playButton);
        controls.add_child(this.nextButton);
        this.root.add_child(controls);

        const lyricActions = new St.BoxLayout({style_class: 'lyricflow-lyric-actions'});
        this.searchButton = new St.Button({
            label: this.gettext('Search again'),
            style_class: 'button lyricflow-text-button',
            can_focus: true,
        });
        this.searchButton.connect('clicked', () => this.actions.refreshLyrics());
        lyricActions.add_child(this.searchButton);
        lyricActions.add_child(this.offsetButton('−250 ms', -250));
        this.offsetLabel = new St.Label({text: '0 ms', y_align: Clutter.ActorAlign.CENTER, style_class: 'lyricflow-offset'});
        lyricActions.add_child(this.offsetLabel);
        lyricActions.add_child(this.offsetButton('+250 ms', 250));
        const reset = iconButton('edit-undo-symbolic', this.gettext('Reset lyrics offset'));
        reset.connect('clicked', () => this.actions.resetOffset());
        lyricActions.add_child(reset);
        this.root.add_child(lyricActions);

        this.statusLabel = new St.Label({style_class: 'lyricflow-status'});
        this.root.add_child(this.statusLabel);
        this.scrollView = new St.ScrollView({
            style_class: 'lyricflow-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this.lyricsBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'lyricflow-lyrics'});
        this.scrollView.set_child(this.lyricsBox);
        this.root.add_child(this.scrollView);

        const settingsButton = new St.Button({
            label: this.gettext('Preferences'),
            style_class: 'button lyricflow-preferences-button',
            can_focus: true,
        });
        settingsButton.connect('clicked', () => this.actions.openPreferences());
        this.root.add_child(settingsButton);
    }

    private offsetButton(label: string, delta: number): St.Button {
        const button = new St.Button({label, style_class: 'button lyricflow-text-button', can_focus: true});
        button.connect('clicked', () => this.actions.changeOffset(delta));
        return button;
    }

    addToPanel(uuid: string, position: string): void {
        const panelPosition = position === 'left' || position === 'right' ? position : 'center';
        Main.panel.addToStatusArea(uuid, this.button, 0, panelPosition);
    }

    move(position: string): void {
        if (this.disposed)
            return;
        const panel = Main.panel as unknown as {
            _leftBox: St.BoxLayout;
            _centerBox: St.BoxLayout;
            _rightBox: St.BoxLayout;
        };
        const target = position === 'left'
            ? panel._leftBox
            : position === 'right' ? panel._rightBox : panel._centerBox;
        const parent = this.button.get_parent();
        if (parent === target)
            return;
        parent?.remove_child(this.button);
        target.insert_child_at_index(this.button, 0);
    }

    setAppearance(appearance: IndicatorAppearance): void {
        if (this.disposed)
            return;
        this.appearance = appearance;
        this.panelBin.set_style(`width: ${appearance.maxWidth}px; font-size: ${Math.round(appearance.fontScale * 100)}%;`);
        this.root.set_style(`font-size: ${Math.round(appearance.fontScale * 100)}%;`);
    }

    setVisible(visible: boolean): void {
        if (this.disposed)
            return;
        this.button.visible = visible;
    }

    setPaused(paused: boolean): void {
        if (this.disposed)
            return;
        if (paused)
            this.button.add_style_pseudo_class('paused');
        else
            this.button.remove_style_pseudo_class('paused');
    }

    setPanelText(text: string, animate = false): void {
        if (this.disposed)
            return;
        if (this.panelLabel.text === text)
            return;
        this.stopMarquee();
        this.panelLabel.text = text;
        this.panelLabel.translation_x = 0;
        if (animate) {
            this.panelLabel.opacity = 0;
            this.panelLabel.translation_y = 5;
            this.panelLabel.ease({
                opacity: 255,
                translationY: 0,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this.marqueeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this.marqueeSource = 0;
            this.startMarquee();
            return GLib.SOURCE_REMOVE;
        });
    }

    private startMarquee(): void {
        if (this.disposed)
            return;
        const [, naturalWidth] = this.panelLabel.get_preferred_width(-1);
        const overflow = naturalWidth - this.appearance.maxWidth;
        if (overflow <= 4)
            return;
        this.panelLabel.ease({
            translationX: -overflow,
            duration: Math.max(1_000, Math.round(overflow / this.appearance.marqueeSpeed * 1_000)),
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => {
                this.panelLabel.translation_x = 0;
                this.marqueeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                    this.marqueeSource = 0;
                    this.startMarquee();
                    return GLib.SOURCE_REMOVE;
                });
            },
        });
    }

    private stopMarquee(): void {
        if (!this.disposed)
            this.panelLabel.remove_all_transitions();
        if (this.marqueeSource) {
            GLib.source_remove(this.marqueeSource);
            this.marqueeSource = 0;
        }
    }

    setPlayer(player: PlayerState): void {
        if (this.disposed)
            return;
        this.titleLabel.text = player.track.title || this.gettext('Unknown title');
        this.artistLabel.text = player.track.artist || this.gettext('Unknown artist');
        this.playerLabel.text = player.identity;
        this.setArtwork(player.track.artUrl);
        this.previousButton.reactive = player.capabilities.canGoPrevious;
        this.previousButton.opacity = player.capabilities.canGoPrevious ? 255 : 90;
        this.nextButton.reactive = player.capabilities.canGoNext;
        this.nextButton.opacity = player.capabilities.canGoNext ? 255 : 90;
        this.playButton.reactive = player.capabilities.canPlay || player.capabilities.canPause;
        this.playButton.set_child(new St.Icon({
            icon_name: player.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
            icon_size: 20,
        }));
        this.progress.reactive = player.capabilities.canSeek && player.track.lengthUs > 0;
    }

    private setArtwork(uri: string): void {
        let child: Clutter.Actor = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 34,
            style_class: 'lyricflow-artwork-fallback',
        });
        if (uri) {
            try {
                child = St.TextureCache.get_default().load_file_async(
                    Gio.File.new_for_uri(uri),
                    72,
                    72,
                    1,
                    1,
                );
            } catch {
                // Keep the symbolic fallback for malformed or unsupported artwork URIs.
            }
        }
        this.artwork.set_child(child);
    }

    setProgress(fraction: number): void {
        if (this.disposed)
            return;
        this.suppressSeek = true;
        this.progress.value = Math.max(0, Math.min(1, fraction));
        this.suppressSeek = false;
    }

    setOffset(offsetMs: number): void {
        if (this.disposed)
            return;
        this.offsetLabel.text = `${offsetMs > 0 ? '+' : ''}${offsetMs} ms`;
    }

    showLoading(): void {
        if (this.disposed)
            return;
        this.statusLabel.text = this.gettext('Searching for lyrics…');
        this.statusLabel.visible = true;
        this.lyricsBox.destroy_all_children();
        this.lyricLabels = [];
    }

    setLyrics(result: LyricsResult): void {
        if (this.disposed)
            return;
        this.lyricsBox.destroy_all_children();
        this.lyricLabels = [];
        this.activeIndex = -1;
        const statusMessages: Partial<Record<LyricsResult['status'], string>> = {
            instrumental: this.gettext('Instrumental track'),
            'not-found': this.gettext('No lyrics found'),
            error: this.gettext('Could not load lyrics'),
            plain: this.gettext('Unsynchronized lyrics'),
        };
        const message = statusMessages[result.status] ?? (result.stale ? this.gettext('Offline lyrics cache') : '');
        this.statusLabel.text = message;
        this.statusLabel.visible = Boolean(message);

        const lines = result.status === 'synced'
            ? result.timedLines.map(line => line.text)
            : result.plainLines;
        for (const text of lines) {
            const label = new St.Label({text, x_expand: true, style_class: 'lyricflow-line'});
            label.clutter_text.set_line_wrap(true);
            label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            this.lyricsBox.add_child(label);
            this.lyricLabels.push(label);
        }
    }

    setActiveLyric(index: number): void {
        if (this.disposed)
            return;
        if (index === this.activeIndex)
            return;
        const previous = this.lyricLabels[this.activeIndex];
        previous?.remove_style_class_name('active');
        const current = this.lyricLabels[index];
        current?.add_style_class_name('active');
        this.activeIndex = index;
        if (!current)
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const adjustment = this.scrollView.vadjustment;
            const target = current.y + current.height / 2 - adjustment.page_size / 2;
            adjustment.ease(Math.max(0, Math.min(target, adjustment.upper - adjustment.page_size)), {
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    showCandidates(candidates: LyricsCandidate[]): void {
        if (this.disposed)
            return;
        this.lyricsBox.destroy_all_children();
        this.lyricLabels = [];
        this.statusLabel.text = candidates.length
            ? this.gettext('Choose the correct lyrics')
            : this.gettext('No lyrics found');
        this.statusLabel.visible = true;
        for (const candidate of candidates) {
            const button = new St.Button({
                style_class: 'lyricflow-candidate',
                can_focus: true,
                x_expand: true,
                child: new St.Label({
                    text: `${candidate.trackName} — ${candidate.artistName}${candidate.albumName ? `\n${candidate.albumName}` : ''}`,
                    x_align: Clutter.ActorAlign.START,
                }),
            });
            button.connect('clicked', () => this.actions.chooseCandidate(candidate));
            this.lyricsBox.add_child(button);
        }
    }

    destroy(): void {
        this.stopMarquee();
        if (!this.disposed)
            this.button.destroy();
    }
}
