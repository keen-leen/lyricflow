import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
let execution;
export function init() { execution = benchmark(); }
export async function run() { await execution; }

function cpuTicks() {
    const [, contents] = GLib.file_get_contents('/proc/self/stat');
    const fields = new TextDecoder().decode(contents).split(') ')[1].split(' ');
    return Number(fields[11]) + Number(fields[12]);
}

async function benchmark() {
    try {
        let extension;
        for (let i = 0; i < 150; i++) {
            extension = Main.extensionManager.lookup('lyricflow@keen.local')?.stateObj;
            if (extension?.indicator)
                break;
            await Scripting.sleep(100);
        }
        if (!extension?.indicator)
            throw new Error('Extension did not load');
        // The helper exits on inactivity before long sampling finishes. Let the
        // test compositor close it instead of asking an already exited helper.
        await Scripting.disableHelperAutoExit();
        const indicator = extension.indicator;
        // Test-only instrumentation around the actual extension and actors.
        let sample = null;
        const wrap = (object, method, around) => {
            const original = object[method];
            object[method] = function (...args) { return around.call(this, original.bind(this), args); };
        };
        wrap(extension, 'updateUi', (original, args) => {
            const start = GLib.get_monotonic_time();
            original(...args);
            if (sample) { sample.updates++; sample.updateUs += GLib.get_monotonic_time() - start; }
        });
        wrap(indicator, 'setProgress', (original, args) => {
            if (sample) sample.progressCalls++;
            return original(...args);
        });
        wrap(indicator.artwork, 'set_child', (original, args) => {
            if (sample) sample.artworkCreations++;
            return original(...args);
        });
        wrap(indicator.playButton, 'set_child', (original, args) => {
            if (sample) sample.iconCreations++;
            return original(...args);
        });
        if (GLib.getenv('LYRICFLOW_BENCH_MODE') === 'actors') {
            for (const [label, counter] of [[indicator.elapsedLabel, 'elapsedTextWrites'], [indicator.durationLabel, 'durationTextWrites']]) {
                Object.defineProperty(label, 'text', {
                    configurable: true,
                    get() { return this.get_text(); },
                    set(value) { if (sample) sample[counter] = (sample[counter] ?? 0) + 1; this.set_text(value); },
                });
            }
            for (const method of ['add_style_pseudo_class', 'remove_style_pseudo_class']) {
                wrap(indicator.button, method, (original, args) => {
                    if (sample && args[0] === 'paused') sample.pausedStyleCalls = (sample.pausedStyleCalls ?? 0) + 1;
                    return original(...args);
                });
            }
        }
        const progress = indicator.progress;
        progress.connect('notify::value', () => { if (sample) sample.progressChanges++; });
        wrap(indicator, 'setActiveLyric', (original, args) => {
            const previous = indicator.activeIndex;
            original(...args);
            if (sample && args[0] >= 0 && previous !== args[0]) {
                const expectedMs = extension.displayLyrics.timedLines[args[0]].timeMs;
                const positionMs = extension.players.getPositionUs(extension.player) / 1000;
                sample.lyricDelayMs.push(Math.max(0, positionMs - expectedMs));
            }
        });
        const rows = [];
        const savedService = extension.lyricsService;
        const savedConverter = extension.scriptConverter;
        extension.lyricsService = {cancel() {}, async load() { return null; }};
        extension.scriptConverter = {async convertTrack(track) { return track; }, async convertResult(result) { return result; }};
        const scenarios = (GLib.getenv('LYRICFLOW_BENCH_SCENARIOS') ?? 'idle,paused,playing-closed,playing-open,long-scroll').split(',');
        for (const scenario of GLib.getenv('LYRICFLOW_BENCH_MODE') === 'actors' ? [] : scenarios) {
            for (let trial = 0; trial < 3; trial++) {
                sample = null;
                indicator.menu.close();
                extension.onPlayerChanged(null);
                const player = {
                    busName: 'org.mpris.MediaPlayer2.Benchmark', identity: 'Benchmark',
                    status: scenario === 'paused' ? 'Paused' : 'Playing',
                    positionUs: 0, rate: 1, sampledAtUs: GLib.get_monotonic_time(), activeSequence: 1,
                    track: {trackId: '/track/benchmark', title: 'Benchmark', artist: 'Artist', artists: ['Artist'],
                        album: 'Album', artUrl: '', lengthUs: 180_000_000},
                    capabilities: {canControl: true, canPlay: true, canPause: true, canSeek: true, canGoNext: true, canGoPrevious: true},
                };
                if (scenario !== 'idle') {
                    extension.onPlayerChanged(player);
                    await Scripting.sleep(30);
                    const result = {status: 'synced', candidate: null, plainLines: [], timedLines:
                        Array.from({length: 181}, (_, i) => ({timeMs: i * 1000,
                            text: scenario === 'long-scroll' ? `${i} A long lyric line with repeated text for the scrolling benchmark and popup layout` : `Lyric ${i}`}))};
                    extension.lyrics = result;
                    extension.displayLyrics = result;
                    indicator.setLyrics(result);
                    extension.infoUntilUs = 0;
                    extension.updateUi();
                    if (scenario === 'playing-open' || scenario === 'long-scroll')
                        indicator.menu.open();
                }
                await Scripting.sleep(5000);
                sample = {scenario, trial, updates: 0, updateUs: 0, progressCalls: 0, progressChanges: 0,
                    artworkCreations: 0, iconCreations: 0, lyricDelayMs: []};
                const start = GLib.get_monotonic_time();
                const ticks = cpuTicks();
                await Scripting.sleep(20000);
                const result = sample;
                sample = null;
                result.elapsedMs = (GLib.get_monotonic_time() - start) / 1000;
                result.shellCpuTicks = cpuTicks() - ticks;
                rows.push(result);
                console.log(`BENCH ${scenario} ${trial}: ${JSON.stringify(result)}`);
            }
        }
        const actorRows = [];
        const repeatedPlayer = {
            busName: 'org.mpris.MediaPlayer2.Benchmark', identity: 'Benchmark', status: 'Paused',
            positionUs: 0, rate: 1, sampledAtUs: GLib.get_monotonic_time(), activeSequence: 1,
            track: {trackId: '/track/repeated', title: 'Benchmark', artist: 'Artist', artists: ['Artist'],
                album: 'Album', artUrl: '', lengthUs: 180_000_000},
            capabilities: {canControl: true, canPlay: true, canPause: true, canSeek: true, canGoNext: true, canGoPrevious: true},
        };
        indicator.setPlayer(repeatedPlayer);
        indicator.setPaused(true);
        indicator.setProgress(0, 0, repeatedPlayer.track.lengthUs);
        for (let trial = 0; trial < 3; trial++) {
            sample = {artworkCreations: 0, iconCreations: 0, elapsedTextWrites: 0, durationTextWrites: 0, pausedStyleCalls: 0, progressCalls: 0, progressChanges: 0};
            const start = GLib.get_monotonic_time();
            for (let i = 0; i < 100; i++) {
                indicator.setPlayer(repeatedPlayer);
                indicator.setPaused(true);
                indicator.setProgress(0, 0, repeatedPlayer.track.lengthUs);
            }
            actorRows.push({...sample, trial, calls: 100, elapsedUs: GLib.get_monotonic_time() - start});
            sample = null;
            await Scripting.sleep(100);
        }
        indicator.menu.close();
        extension.onPlayerChanged(null);
        extension.lyricsService = savedService;
        extension.scriptConverter = savedConverter;
        const output = GLib.getenv('LYRICFLOW_BENCH_OUTPUT');
        GLib.file_set_contents(output, JSON.stringify({recordedAt: new Date().toISOString(),
            warmupMs: 5000, sampleMs: 20000, repeats: 3, cpuClockTicksPerSecond: 100, rows, actorRows}, null, 2));
        const perf = GLib.getenv('SHELL_PERF_OUTPUT');
        if (perf) GLib.file_set_contents(perf, JSON.stringify({events: [], monitors: [], metrics: [], log: []}));
        console.log('LyricFlow UI benchmark passed');
        GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 250, () => global.context.terminate());

    } catch (error) {
        console.error(error.stack ?? String(error));
        Meta.exit(Meta.ExitCode.ERROR);
    }
}
