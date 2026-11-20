import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'lyricflow@keen.local';
const CENTER_TOLERANCE_PX = 2;

export const METRICS = {};

let testPromise = null;

export function init() {
    console.log('LyricFlow shell scroll test initialized');
    testPromise = executeTest();
}

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function writeTestToolResult() {
    const outputPath = GLib.getenv('SHELL_PERF_OUTPUT');
    if (!outputPath)
        return;
    GLib.file_set_contents(outputPath, JSON.stringify({
        events: [],
        monitors: [],
        metrics: [],
        log: [],
    }));
}

function lineGeometry(indicator, index) {
    const line = indicator.lyricLabels[index];
    assert(line, `missing lyric line ${index}`);
    const box = line.get_allocation_box();
    let y = box.y1;
    let parent = line.get_parent();
    while (parent && parent !== indicator.lyricsBox) {
        y += parent.get_allocation_box().y1;
        parent = parent.get_parent();
    }
    assert(parent === indicator.lyricsBox, `lyric line ${index} is outside lyricsBox`);
    return {y, height: box.y2 - box.y1};
}

function assertCentered(indicator, index) {
    const adjustment = indicator.scrollView.vadjustment;
    const geometry = lineGeometry(indicator, index);
    const error = geometry.y + geometry.height / 2
        - adjustment.value - adjustment.pageSize / 2;
    assert(Math.abs(error) <= CENTER_TOLERANCE_PX,
        `line ${index} is ${error.toFixed(2)}px away from the viewport center`);
    return adjustment.value;
}

function descendants(actor) {
    return actor.get_children().flatMap(child => [child, ...descendants(child)]);
}

async function checkButtonStates(indicator) {
    const permanentButtons = descendants(indicator.root).filter(actor => actor instanceof St.Button);
    assert(permanentButtons.length >= 8, `expected popup controls, found ${permanentButtons.length} buttons`);
    assert(permanentButtons.every(button => button.get_track_hover()),
        'every permanent popup button must track pointer hover');

    const searchButton = indicator.searchButton;
    searchButton.set_hover(true);
    await Scripting.sleep(150);
    assert(searchButton.has_style_pseudo_class('hover'), 'search button did not enter hover state');
    searchButton.set_hover(false);
    assert(!searchButton.has_style_pseudo_class('hover'), 'search button kept hover state after pointer left');

    searchButton.add_style_pseudo_class('active');
    assert(searchButton.has_style_pseudo_class('active'), 'search button did not enter active state');
    searchButton.remove_style_pseudo_class('active');
    assert(!searchButton.has_style_pseudo_class('active'), 'search button kept active state after release');

    indicator.previousButton.reactive = false;
    assert(indicator.previousButton.has_style_pseudo_class('insensitive'),
        'disabled transport button did not enter insensitive state');
    indicator.previousButton.reactive = true;

    indicator.showCandidates([{
        candidate: {
            id: 1,
            trackName: 'Integration track',
            artistName: 'Integration artist',
            albumName: 'Integration album',
            duration: 120,
            instrumental: false,
            plainLyrics: 'Integration lyric',
            syncedLyrics: null,
        },
        trackName: 'Integration track',
        artistName: 'Integration artist',
        albumName: 'Integration album',
    }]);
    const candidate = descendants(indicator.lyricsBox)
        .find(actor => actor instanceof St.Button && actor.has_style_class_name('lyricflow-candidate'));
    assert(candidate?.get_track_hover(), 'lyrics candidate button must track pointer hover');
}

async function checkLyricLineSeeking(indicator) {
    const originalSeekToLyric = indicator.actions.seekToLyric;
    let requestedTimeMs = null;
    indicator.actions.seekToLyric = timeMs => {
        requestedTimeMs = timeMs;
    };
    indicator.lyricsSeekable = true;
    indicator.setLyrics({
        status: 'synced',
        candidate: null,
        timedLines: [{timeMs: 12_340, text: 'Clickable lyric'}],
        plainLines: [],
    });
    const timedRow = indicator.lyricLabels[0];
    assert(timedRow instanceof St.Button, 'synchronized lyric must use a button');
    assert(timedRow.reactive && timedRow.get_track_hover(), 'seekable lyric button must be interactive');
    timedRow.emit('clicked', 1);
    assert(requestedTimeMs === 12_340, `lyric click requested ${requestedTimeMs}`);

    indicator.setLyricButtonEnabled(timedRow, false);
    assert(!timedRow.reactive && !timedRow.get_track_hover(),
        'lyrics must be non-interactive when the player cannot seek');

    indicator.setLyrics({
        status: 'plain',
        candidate: null,
        timedLines: [],
        plainLines: ['Plain lyric'],
    });
    assert(!(indicator.lyricLabels[0] instanceof St.Button),
        'unsynchronized lyric must remain read-only');
    indicator.lyricsSeekable = false;
    indicator.actions.seekToLyric = originalSeekToLyric;
}

function checkLiquidGlass(indicator) {
    const original = indicator.appearance;
    const effectTarget = indicator.menu.actor.bin;

    indicator.setAppearance({...original, liquidGlassEnabled: true, liquidGlassStrength: 'subtle'});
    const subtleEffect = effectTarget.get_effect('lyricflow-background-blur');
    assert(subtleEffect?.radius === 12, 'subtle liquid glass did not apply a 12px blur');
    assert(indicator.menu.actor.has_style_class_name('lyricflow-glass-menu'),
        'liquid glass popup style class is missing');
    assert(indicator.menu.actor.has_style_class_name('lyricflow-glass-subtle'),
        'subtle liquid glass style class is missing');

    indicator.setAppearance({...original, liquidGlassEnabled: true, liquidGlassStrength: 'strong'});
    const strongEffect = effectTarget.get_effect('lyricflow-background-blur');
    assert(strongEffect === subtleEffect, 'changing glass strength duplicated the blur effect');
    assert(strongEffect?.radius === 36, 'strong liquid glass did not apply a 36px blur');
    assert(indicator.menu.actor.has_style_class_name('lyricflow-glass-strong'),
        'strong liquid glass style class is missing');

    indicator.setAppearance({...original, liquidGlassEnabled: false});
    assert(!effectTarget.get_effect('lyricflow-background-blur'),
        'disabling liquid glass left the blur effect attached');
    assert(!indicator.menu.actor.has_style_class_name('lyricflow-glass-menu'),
        'disabling liquid glass left the popup style class attached');
    indicator.setAppearance(original);
}

async function focusAndMeasure(indicator, index) {
    indicator.setActiveLyric(index);
    await Scripting.sleep(350);
    return assertCentered(indicator, index);
}

async function waitForIndicator() {
    for (let attempt = 0; attempt < 150; attempt++) {
        const indicator = Main.extensionManager.lookup(UUID)?.stateObj?.indicator;
        if (indicator)
            return indicator;
        await Scripting.sleep(100);
    }
    const extension = Main.extensionManager.lookup(UUID);
    throw new Error(`LyricFlow extension did not become active: state=${extension?.state}, `
        + `error=${extension?.error}, enabled=${global.settings.get_strv('enabled-extensions')}, `
        + `disabled=${global.settings.get_boolean('disable-user-extensions')}`);
}

async function checkPlaybackIdentity() {
    const extension = Main.extensionManager.lookup(UUID).stateObj;
    const originalService = extension.lyricsService;
    const originalConverter = extension.scriptConverter;
    const originalPlayer = extension.player;
    const loads = [];
    let cancellations = 0;
    extension.lyricsService = {
        cancel() { cancellations++; },
        load() { return new Promise(resolve => loads.push(resolve)); },
    };
    extension.scriptConverter = {
        async convertTrack(track) { return track; },
        async convertResult(result) { return result; },
        async convertCandidates(candidates) { return candidates; },
    };
    const player = {
        busName: 'org.mpris.MediaPlayer2.IdentityTest', identity: 'Identity Test',
        status: 'Paused', positionUs: 0, rate: 1, sampledAtUs: GLib.get_monotonic_time(),
        capabilities: {canControl: true, canPlay: true, canPause: true,
            canSeek: true, canGoNext: true, canGoPrevious: true},
        track: {trackId: '/track/1', title: 'Song', artist: 'Artist', artists: ['Artist'],
            album: 'Album', lengthUs: 180_000_000, artUrl: ''},
    };
    const result = text => ({status: 'synced', candidate: null,
        timedLines: [{timeMs: 1_000, text}], plainLines: []});
    try {
        extension.onPlayerChanged(player);
        // Mutate the same object: a prior PlayerState reference cannot detect this.
        player.track.trackId = '/track/2';
        extension.onPlayerChanged(player);
        assert(loads.length === 2, 'new track id with identical metadata must reload lyrics');
        loads[1](result('Current'));
        await Scripting.sleep(20);
        loads[0](result('Late'));
        await Scripting.sleep(20);
        assert(extension.lyrics?.timedLines[0]?.text === 'Current', 'late load overwrote current lyrics');
        player.positionUs = 2_000_000;
        extension.infoUntilUs = GLib.get_monotonic_time() + 50_000;
        extension.updateUi();
        await Scripting.sleep(100);
        assert(extension.displayedLyric === 0 && extension.tickSource === 0,
            'paused track must finish its information deadline without periodic polling');
        player.status = 'Playing';
        player.sampledAtUs = GLib.get_monotonic_time();
        extension.onPlayerChanged(player);
        extension.indicator.menu.open();
        assert(extension.progressTick && extension.tickSource !== 0,
            'visible playing popup must keep its progress timer');
        await Scripting.sleep(120);
        assert(extension.indicator.progress.value > 2_000_000 / player.track.lengthUs,
            'visible popup progress must continue updating');
        extension.indicator.menu.close();
        player.status = 'Paused';
        extension.onPlayerChanged(player);
        const currentLyrics = extension.lyrics;
        extension.lyricsService.search = async () => { throw new Error('controlled search failure'); };
        await extension.searchCandidates();
        assert(extension.lyrics === currentLyrics && extension.indicator.lyricLabels.length === 1,
            'failed manual search must preserve current lyrics');
        assert(extension.indicator.statusLabel.visible, 'failed search must show a status message');
        const artwork = extension.indicator.artwork.get_child();
        const icon = extension.indicator.playButton.get_child();
        extension.indicator.setPlayer(player);
        assert(extension.indicator.artwork.get_child() === artwork && extension.indicator.playButton.get_child() === icon,
            'unchanged player must reuse artwork and play icon');

        player.track.artUrl = 'file:///nonexistent-lyricflow-test-cover';
        extension.onPlayerChanged(player);
        assert(loads.length === 2, 'artwork change must not reload lyrics');
        player.track.artUrl = '';
        player.busName = 'org.mpris.MediaPlayer2.OtherIdentityTest';
        extension.onPlayerChanged(player);
        assert(loads.length === 3, 'switching players must create a new playback instance');
        loads[2](result('Other player'));
        await Scripting.sleep(20);
        player.track.trackId = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
        extension.onPlayerChanged(player);
        player.track.title = 'Song (Live)';
        extension.onPlayerChanged(player);
        assert(loads.length === 5, 'NoTrack must use strict metadata for track changes');
        loads[4](result('Live'));
        loads[3](result('Old metadata'));
        await Scripting.sleep(20);
        assert(extension.lyrics?.timedLines[0]?.text === 'Live', 'metadata change accepted stale lyrics');
        player.track.lengthUs += 1_000_000;
        extension.onPlayerChanged(player);
        assert(loads.length === 6, 'precise duration change must reload lyrics');
        extension.onPlayerChanged(null);
        loads[5](result('After disappearance'));
        await Scripting.sleep(20);
        assert(extension.lyrics === null, 'disappeared player accepted a late result');
        assert(cancellations >= 7, 'each playback change must cancel old requests');
    } finally {
        extension.onPlayerChanged(null);
        extension.lyricsService = originalService;
        extension.scriptConverter = originalConverter;
        extension.onPlayerChanged(originalPlayer);
    }
    console.log('LyricFlow playback identity test passed');
}

async function checkScrolling() {
    console.log('LyricFlow shell scroll test running');
    const indicator = await waitForIndicator();
    await checkPlaybackIdentity();
    await checkButtonStates(indicator);
    await checkLyricLineSeeking(indicator);
    checkLiquidGlass(indicator);

    const timedLines = Array.from({length: 24}, (_, index) => ({
        timeMs: index * 2_000,
        text: `Integration lyric line ${index + 1}`,
    }));
    indicator.setVisible(true);
    indicator.setPanelText('LyricFlow integration test');
    indicator.lyricsSeekable = true;
    indicator.setLyrics({
        status: 'synced',
        candidate: null,
        timedLines,
        plainLines: [],
    });
    indicator.setActiveLyric(1);
    indicator.menu.open();
    await Scripting.sleep(500);
    indicator.lyricLabels[1].emit('clicked', 1);
    assert(indicator.menu.isOpen, 'lyric click unexpectedly closed the popup');

    const early = assertCentered(indicator, 1);
    const middle = await focusAndMeasure(indicator, 11);
    const late = await focusAndMeasure(indicator, 22);
    assert(early < middle && middle < late,
        `scroll position did not advance: ${early}, ${middle}, ${late}`);

    indicator.menu.close();
    indicator.setActiveLyric(15);
    await Scripting.sleep(100);
    indicator.menu.open();
    await Scripting.sleep(500);
    assertCentered(indicator, 15);

    indicator.setPanelText('Disable during a pending marquee');
    indicator.setActiveLyric(16);
    assert(indicator.marqueeSource && indicator.centerLaterId, 'disable fixture must have pending UI work');
    assert(Main.extensionManager.disableExtension(UUID), 'extension manager did not disable LyricFlow');
    await Scripting.sleep(100);
    assert(indicator.disposed && !indicator.marqueeSource && !indicator.centerLaterId,
        'disable must destroy the indicator and clear pending UI work');
    assert(!Main.panel.statusArea[UUID], 'disable must remove the indicator from the top bar');
}

async function executeTest() {
    try {
        await checkScrolling();
        console.log('LyricFlow shell scroll test passed');
        writeTestToolResult();
        GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 250, () => global.context.terminate());
    } catch (error) {
        console.error(`LyricFlow shell scroll test failed: ${error.stack ?? error}`);
        Meta.exit(Meta.ExitCode.ERROR);
        throw error;
    }
}

export async function run() {
    await testPromise;
}
