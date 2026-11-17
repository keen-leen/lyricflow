import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import type {LyricsCandidate, LyricsCandidateDisplay, LyricsResult, PlayerState} from '../types.js';
import {formatPlaybackTime} from '../player/position.js';
import {centeredScrollValue, contentLineGeometry, edgeSpacerHeight} from './scroll-position.js';
import {liquidGlassPreset, type LiquidGlassStrength} from './glass.js';

const GLASS_EFFECT_NAME = 'lyricflow-background-blur';
const GLASS_STRENGTH_CLASSES = [
    'lyricflow-glass-subtle',
    'lyricflow-glass-balanced',
    'lyricflow-glass-strong',
];

export interface IndicatorActions {
    menuChanged(): void;
    previous(): void;
    playPause(): void;
    next(): void;
    previewSeek(fraction: number): void;
    seek(fraction: number): void;
    seekToLyric(timeMs: number): void;
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
    liquidGlassEnabled: boolean;
    liquidGlassStrength: LiquidGlassStrength;
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

    private readonly menu: PopupMenu.PopupMenu;
    private readonly panelBin: St.Bin;
    private readonly panelLabel: St.Label;
    private readonly root: St.BoxLayout;
    private readonly artwork: St.Bin;
    private readonly titleLabel: St.Label;
    private readonly artistLabel: St.Label;
    private readonly albumLabel: St.Label;
    private readonly playerLabel: St.Label;
    private readonly progress: Slider;
    private readonly elapsedLabel: St.Label;
    private readonly durationLabel: St.Label;
    private readonly previousButton: St.Button;
    private readonly playButton: St.Button;
    private readonly nextButton: St.Button;
    private readonly statusLabel: St.Label;
    private readonly lyricsBox: St.BoxLayout;
    private readonly scrollView: St.ScrollView;
    private readonly offsetLabel: St.Label;
    private readonly searchButton: St.Button;
    private lyricLabels: St.Widget[] = [];
    private lyricSeekButtons: St.Button[] = [];
    private topSpacer: St.Widget | null = null;
    private bottomSpacer: St.Widget | null = null;
    private activeIndex = -1;
    private requestMessage: string | null = null;
    private lyricsStatusMessage = '';
    private lyricsFingerprint = '';
    private marqueeSource = 0;
    private centerLaterId = 0;
    private centerPending = false;
    private suppressSeek = false;
    private draggingProgress = false;
    private lyricsSeekable = false;
    private disposed = false;
    private paused: boolean | null = null;
    private artworkUri: string | null = null;
    private playIconName = '';
    private progressPositionUs: number | null = null;
    private progressLengthUs: number | null = null;
    private glassEffect: Shell.BlurEffect | null = null;
    private glassBackground: {red: number; green: number; blue: number} | null = null;
    private appearance: IndicatorAppearance = {
        maxWidth: 360,
        fontScale: 1,
        marqueeSpeed: 36,
        liquidGlassEnabled: false,
        liquidGlassStrength: 'balanced',
    };

    constructor(
        private readonly actions: IndicatorActions,
        private readonly gettext: (message: string) => string,
    ) {
        this.button = new PanelMenu.Button(0, 'LyricFlow', false);
        this.menu = this.button.menu as PopupMenu.PopupMenu;
        this.button.connect('destroy', () => {
            this.disposed = true;
            this.glassEffect = null;
            this.glassBackground = null;
            this.cancelCentering(false);
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
        this.menu.addMenuItem(menuItem);
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this.requestActiveLyricCenter();
            else
                this.cancelCentering();
            this.actions.menuChanged();
        });

        const header = new St.BoxLayout({vertical: false, style_class: 'lyricflow-header'});
        this.artwork = new St.Bin({style_class: 'lyricflow-artwork'});
        this.setArtwork('');
        header.add_child(this.artwork);
        const metadata = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'lyricflow-metadata'});
        this.titleLabel = new St.Label({style_class: 'lyricflow-title'});
        this.titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this.artistLabel = new St.Label({style_class: 'lyricflow-artist'});
        this.artistLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this.albumLabel = new St.Label({style_class: 'lyricflow-album'});
        this.albumLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this.playerLabel = new St.Label({
            style_class: 'lyricflow-player',
            x_align: Clutter.ActorAlign.START,
        });
        metadata.add_child(this.titleLabel);
        metadata.add_child(this.artistLabel);
        metadata.add_child(this.albumLabel);
        metadata.add_child(this.playerLabel);
        header.add_child(metadata);
        this.root.add_child(header);

        const progressArea = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'lyricflow-progress-area',
        });
        this.progress = new Slider(0);
        this.progress.x_expand = true;
        this.progress.add_style_class_name('lyricflow-progress');
        this.progress.connect('drag-begin', () => {
            if (!this.progress.reactive)
                return;
            this.draggingProgress = true;
            this.actions.previewSeek(this.progress.value);
        });
        this.progress.connect('notify::value', () => {
            if (this.draggingProgress && !this.suppressSeek)
                this.actions.previewSeek(this.progress.value);
        });
        this.progress.connect('drag-end', () => {
            if (!this.draggingProgress)
                return;
            const fraction = this.progress.value;
            this.draggingProgress = false;
            this.actions.seek(fraction);
        });
        progressArea.add_child(this.progress);
        const timeRow = new St.BoxLayout({x_expand: true, style_class: 'lyricflow-time-row'});
        this.elapsedLabel = new St.Label({text: '0:00', style_class: 'lyricflow-time'});
        this.durationLabel = new St.Label({
            text: '--:--',
            style_class: 'lyricflow-time',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        timeRow.add_child(this.elapsedLabel);
        timeRow.add_child(this.durationLabel);
        progressArea.add_child(timeRow);
        this.root.add_child(progressArea);

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
            reactive: true,
            track_hover: true,
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
        this.scrollView.connect('notify::allocation', () => this.requestActiveLyricCenter());
        this.lyricsBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'lyricflow-lyrics'});
        this.lyricsBox.connect('notify::allocation', () => this.requestActiveLyricCenter());
        this.scrollView.set_child(this.lyricsBox);
        this.root.add_child(this.scrollView);
        const adjustment = this.scrollView.vadjustment;
        adjustment.connect('changed', () => this.requestActiveLyricCenter());
        adjustment.connect('notify::upper', () => this.requestActiveLyricCenter());
        adjustment.connect('notify::page-size', () => this.requestActiveLyricCenter());

        const settingsButton = new St.Button({
            label: this.gettext('Preferences'),
            style_class: 'button lyricflow-preferences-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        settingsButton.connect('clicked', () => this.actions.openPreferences());
        this.root.add_child(settingsButton);
    }

    private offsetButton(label: string, delta: number): St.Button {
        const button = new St.Button({
            label,
            style_class: 'button lyricflow-text-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
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
        this.applyLiquidGlass();
        this.requestActiveLyricCenter();
    }

    private applyLiquidGlass(): void {
        const effectTarget = this.menu.actor.bin;
        this.menu.actor.remove_style_class_name('lyricflow-glass-menu');
        for (const styleClass of GLASS_STRENGTH_CLASSES)
            this.menu.actor.remove_style_class_name(styleClass);

        if (!this.appearance.liquidGlassEnabled) {
            effectTarget.remove_effect_by_name(GLASS_EFFECT_NAME);
            this.glassEffect = null;
            this.glassBackground = null;
            this.menu.box.set_style(null);
            return;
        }

        const preset = liquidGlassPreset(this.appearance.liquidGlassStrength);
        if (!this.glassBackground) {
            const color = this.menu.box.get_theme_node().get_background_color();
            this.glassBackground = {
                red: Math.round(color.get_red() * 255),
                green: Math.round(color.get_green() * 255),
                blue: Math.round(color.get_blue() * 255),
            };
        }
        const {red, green, blue} = this.glassBackground;
        this.menu.box.set_style(`background-color: rgba(${red}, ${green}, ${blue}, ${preset.opacity});`);
        this.menu.actor.add_style_class_name('lyricflow-glass-menu');
        this.menu.actor.add_style_class_name(`lyricflow-glass-${this.appearance.liquidGlassStrength}`);

        try {
            if (!this.glassEffect) {
                this.glassEffect = new Shell.BlurEffect({
                    mode: Shell.BlurMode.BACKGROUND,
                    radius: preset.radius,
                    brightness: 1,
                });
                effectTarget.add_effect_with_name(GLASS_EFFECT_NAME, this.glassEffect);
            } else {
                this.glassEffect.radius = preset.radius;
            }
        } catch (error) {
            effectTarget.remove_effect_by_name(GLASS_EFFECT_NAME);
            this.glassEffect = null;
            console.warn(`LyricFlow: background blur unavailable, using translucent fallback: ${String(error)}`);
        }
    }

    setVisible(visible: boolean): void {
        if (this.disposed)
            return;
        this.button.visible = visible;
    }

    get menuOpen(): boolean { return this.menu.isOpen; }

    setPaused(paused: boolean): void {
        if (this.disposed || this.paused === paused)
            return;
        this.paused = paused;
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

    setPlayer(player: PlayerState, display?: {title: string; artist: string; album: string}): void {
        if (this.disposed)
            return;
        this.titleLabel.text = display?.title || player.track.title || this.gettext('Unknown title');
        this.artistLabel.text = display?.artist || player.track.artist || this.gettext('Unknown artist');
        this.albumLabel.text = display?.album || player.track.album;
        this.albumLabel.visible = Boolean(this.albumLabel.text);
        this.playerLabel.text = player.identity;
        this.setArtwork(player.track.artUrl);
        this.previousButton.reactive = player.capabilities.canGoPrevious;
        this.previousButton.opacity = player.capabilities.canGoPrevious ? 255 : 90;
        this.nextButton.reactive = player.capabilities.canGoNext;
        this.nextButton.opacity = player.capabilities.canGoNext ? 255 : 90;
        this.playButton.reactive = player.capabilities.canPlay || player.capabilities.canPause;
        const iconName = player.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        if (iconName !== this.playIconName) {
            this.playIconName = iconName;
            this.playButton.set_child(new St.Icon({icon_name: iconName, icon_size: 20}));
        }
        this.progress.reactive = player.capabilities.canSeek && player.track.lengthUs > 0;
        this.lyricsSeekable = player.capabilities.canControl && player.capabilities.canSeek;
        for (const button of this.lyricSeekButtons)
            this.setLyricButtonEnabled(button, this.lyricsSeekable);
    }

    private setArtwork(uri: string): void {
        if (uri === this.artworkUri) return;
        this.artworkUri = uri;
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

    setProgress(fraction: number, positionUs: number, lengthUs: number): void {
        if (this.disposed)
            return;
        if (!this.draggingProgress && this.progressPositionUs === positionUs && this.progressLengthUs === lengthUs)
            return;
        this.progressPositionUs = positionUs;
        this.progressLengthUs = lengthUs;
        if (!this.draggingProgress) {
            this.suppressSeek = true;
            this.progress.value = Math.max(0, Math.min(1, fraction));
            this.suppressSeek = false;
        }
        this.elapsedLabel.text = formatPlaybackTime(positionUs);
        this.durationLabel.text = lengthUs > 0 ? formatPlaybackTime(lengthUs) : '--:--';
    }

    setOffset(offsetMs: number): void {
        if (this.disposed)
            return;
        this.offsetLabel.text = `${offsetMs > 0 ? '+' : ''}${offsetMs} ms`;
    }

    setRequestState(message: string | null): void {
        if (this.disposed) return;
        this.requestMessage = message;
        this.statusLabel.text = message ?? this.lyricsStatusMessage;
        this.statusLabel.visible = Boolean(this.statusLabel.text);
    }

    showLoading(): void {
        if (this.disposed)
            return;
        this.requestMessage = null;
        this.lyricsFingerprint = '';
        this.lyricsStatusMessage = this.gettext('Searching for lyrics…');
        this.statusLabel.text = this.lyricsStatusMessage;
        this.statusLabel.visible = true;
        this.clearLyricsBox();
    }

    setLyrics(result: LyricsResult): void {
        if (this.disposed)
            return;
        const fingerprint = JSON.stringify(result);
        if (fingerprint === this.lyricsFingerprint) return;
        this.lyricsFingerprint = fingerprint;
        this.clearLyricsBox();
        this.activeIndex = -1;
        const statusMessages: Partial<Record<LyricsResult['status'], string>> = {
            instrumental: this.gettext('Instrumental track'),
            'not-found': this.gettext('No lyrics found'),
            error: this.gettext('Could not load lyrics'),
            plain: this.gettext('Unsynchronized lyrics'),
        };
        const message = statusMessages[result.status] ?? (result.stale ? this.gettext('Cached lyrics') : '');
        this.lyricsStatusMessage = message;
        this.setRequestState(this.requestMessage);

        const lines = result.status === 'synced'
            ? result.timedLines.map(line => ({text: line.text, timeMs: line.timeMs}))
            : result.plainLines.map(text => ({text, timeMs: null}));
        if (result.status === 'synced') {
            this.topSpacer = new St.Widget({height: 0, x_expand: true});
            this.lyricsBox.add_child(this.topSpacer);
        }
        for (const line of lines) {
            const label = new St.Label({text: line.text, x_expand: true});
            label.clutter_text.set_line_wrap(true);
            label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            const row: St.Widget = line.timeMs === null
                ? label
                : new St.Button({
                    child: label,
                    x_expand: true,
                    accessible_name: `${formatPlaybackTime(line.timeMs * 1_000)} · ${line.text}`,
                    style_class: 'lyricflow-line',
                });
            if (line.timeMs === null) {
                row.add_style_class_name('lyricflow-line');
            } else {
                const button = row as St.Button;
                this.setLyricButtonEnabled(button, this.lyricsSeekable);
                button.connect('clicked', () => this.actions.seekToLyric(line.timeMs as number));
                this.lyricSeekButtons.push(button);
            }
            row.connect('notify::allocation', () => {
                if (this.lyricLabels[this.activeIndex] === row)
                    this.requestActiveLyricCenter();
            });
            this.lyricsBox.add_child(row);
            this.lyricLabels.push(row);
        }
        if (result.status === 'synced') {
            this.bottomSpacer = new St.Widget({height: 0, x_expand: true});
            this.lyricsBox.add_child(this.bottomSpacer);
        }
        this.requestActiveLyricCenter();
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
        this.requestActiveLyricCenter();
    }

    private clearLyricsBox(): void {
        this.cancelCentering();
        this.topSpacer = null;
        this.bottomSpacer = null;
        this.lyricLabels = [];
        this.lyricSeekButtons = [];
        this.activeIndex = -1;
        this.lyricsBox.destroy_all_children();
    }

    private setLyricButtonEnabled(button: St.Button, enabled: boolean): void {
        button.reactive = enabled;
        button.can_focus = enabled;
        button.track_hover = enabled;
    }

    private cancelCentering(removeTransition = true): void {
        this.centerPending = false;
        if (removeTransition)
            this.scrollView.vadjustment.remove_transition('value');
        if (this.centerLaterId) {
            global.compositor?.get_laters().remove(this.centerLaterId);
            this.centerLaterId = 0;
        }
    }

    private requestActiveLyricCenter(): void {
        if (this.disposed || !this.menu.isOpen || this.activeIndex < 0)
            return;
        this.centerPending = true;
        this.scrollView.vadjustment.remove_transition('value');
        if (this.centerLaterId)
            return;
        this.centerLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.centerLaterId = 0;
            if (this.disposed || !this.menu.isOpen || !this.centerPending)
                return GLib.SOURCE_REMOVE;
            const current = this.lyricLabels[this.activeIndex];
            const first = this.lyricLabels[0];
            const last = this.lyricLabels[this.lyricLabels.length - 1];
            const adjustment = this.scrollView.vadjustment;
            const pageSize = adjustment.pageSize;
            const currentGeometry = current ? this.lineGeometryInLyricsBox(current) : null;
            const firstGeometry = first ? this.lineGeometryInLyricsBox(first) : null;
            const lastGeometry = last ? this.lineGeometryInLyricsBox(last) : null;
            if (!currentGeometry || !firstGeometry || !lastGeometry || pageSize <= 0
                || currentGeometry.height <= 0
                || firstGeometry.height <= 0 || lastGeometry.height <= 0)
                return GLib.SOURCE_REMOVE;

            const spacing = this.lyricsBox.get_theme_node().get_length('spacing');
            const topHeight = edgeSpacerHeight(pageSize, firstGeometry.height, spacing);
            const bottomHeight = edgeSpacerHeight(pageSize, lastGeometry.height, spacing);
            const spacersChanged = Boolean(
                this.topSpacer && Math.abs(this.topSpacer.height - topHeight) > 0.5
                || this.bottomSpacer && Math.abs(this.bottomSpacer.height - bottomHeight) > 0.5,
            );
            this.topSpacer?.set_height(topHeight);
            this.bottomSpacer?.set_height(bottomHeight);
            if (spacersChanged) {
                this.lyricsBox.queue_relayout();
                return GLib.SOURCE_REMOVE;
            }

            this.centerPending = false;
            adjustment.ease(centeredScrollValue(
                currentGeometry.y,
                currentGeometry.height,
                pageSize,
                adjustment.lower,
                adjustment.upper,
            ), {
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    private lineGeometryInLyricsBox(line: St.Widget): {y: number; height: number} | null {
        const lineAllocation = line.get_allocation_box();
        const ancestors: Clutter.ActorBox[] = [];
        let parent = line.get_parent();
        while (parent && parent !== this.lyricsBox) {
            ancestors.push(parent.get_allocation_box());
            parent = parent.get_parent();
        }
        if (parent !== this.lyricsBox)
            return null;
        return contentLineGeometry(lineAllocation, ancestors);
    }

    showCandidates(candidates: LyricsCandidateDisplay[]): void {
        if (this.disposed)
            return;
        this.clearLyricsBox();
        this.lyricsFingerprint = '';
        this.requestMessage = null;
        this.statusLabel.text = candidates.length
            ? this.gettext('Choose the correct lyrics')
            : this.gettext('No lyrics found');
        this.statusLabel.visible = true;
        for (const candidate of candidates) {
            const button = new St.Button({
                style_class: 'lyricflow-candidate',
                can_focus: true,
                reactive: true,
                track_hover: true,
                x_expand: true,
                child: new St.Label({
                    text: `${candidate.trackName} — ${candidate.artistName}${candidate.albumName ? `\n${candidate.albumName}` : ''}`,
                    x_align: Clutter.ActorAlign.START,
                }),
            });
            button.connect('clicked', () => this.actions.chooseCandidate(candidate.candidate));
            this.lyricsBox.add_child(button);
        }
    }

    destroy(): void {
        this.cancelCentering();
        this.stopMarquee();
        if (!this.disposed)
            this.button.destroy();
    }
}
