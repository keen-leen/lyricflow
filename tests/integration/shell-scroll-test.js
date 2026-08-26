import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

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

async function focusAndMeasure(indicator, index) {
    indicator.setActiveLyric(index);
    await Scripting.sleep(350);
    return assertCentered(indicator, index);
}

async function waitForIndicator() {
    for (let attempt = 0; attempt < 50; attempt++) {
        const indicator = Main.extensionManager.lookup(UUID)?.stateObj?.indicator;
        if (indicator)
            return indicator;
        await Scripting.sleep(100);
    }
    throw new Error('LyricFlow extension did not become active');
}

async function checkScrolling() {
    console.log('LyricFlow shell scroll test running');
    const indicator = await waitForIndicator();

    const timedLines = Array.from({length: 24}, (_, index) => ({
        timeMs: index * 2_000,
        text: `Integration lyric line ${index + 1}`,
    }));
    indicator.setVisible(true);
    indicator.setPanelText('LyricFlow integration test');
    indicator.setLyrics({
        status: 'synced',
        candidate: null,
        timedLines,
        plainLines: [],
    });
    indicator.setActiveLyric(1);
    indicator.menu.open();
    await Scripting.sleep(500);

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
    indicator.menu.close();
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
