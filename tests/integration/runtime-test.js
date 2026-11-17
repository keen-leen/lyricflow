import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {LyricsCache} from '../../.test-dist/runtime/cache/store.js';
import {LyricsService} from '../../.test-dist/runtime/lyrics/service.js';
import {trackCacheKey, resultFromCandidate} from '../../.test-dist/runtime/lyrics/core.js';
import {MprisManager} from '../../.test-dist/runtime/player/mpris.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate())
            return;
        await sleep(10);
    }
    throw new Error(message);
}

async function rejects(promise, message) {
    let rejected = false;
    try {
        await promise;
    } catch {
        rejected = true;
    }
    assert(rejected, message);
}

const track = {trackId: '/track/1', title: 'Song', artist: 'Artist', artists: ['Artist'], album: 'Album', lengthUs: 180_000_000, artUrl: ''};
const candidate = {id: 1, source: 'lrclib', trackName: 'Song', artistName: 'Artist', albumName: 'Album', duration: 180, instrumental: false, plainLyrics: 'Text', syncedLyrics: '[00:01] Text'};
const outcome = (candidates = [], errors = [], successfulRequests = 1) => ({candidates, errors, successfulRequests});

async function testLyricsService() {
    const cache = new LyricsCache();
    const service = new LyricsService();
    const setOutcomes = (primary, fallback) => {
        service.lrclib.collect = async () => primary;
        service.netease.collect = async () => fallback;
    };
    try {
        assert(cache.read(track) === null, 'empty cache must miss');
        setOutcomes(outcome(), outcome([], ['lyrics fetch failed']));
        assert((await service.load(track)).status === 'error', 'partial failure must return error');
        assert(cache.read(track) === null, 'partial failure must not write a negative cache');
        await rejects(service.search(track), 'manual search must reject partial failure');

        setOutcomes(outcome(), outcome());
        assert((await service.load(track)).status === 'not-found', 'completed empty queries must return not-found');
        assert(cache.read(track)?.fresh, 'completed miss must be cached');
        assert((await service.search(track)).length === 0, 'completed manual search must return empty candidates');

        for (const syncedLyrics of [null, candidate.syncedLyrics]) {
            setOutcomes(outcome([{...candidate, syncedLyrics}]), outcome([], ['provider failed']));
            const result = await service.load(track, true);
            assert(result.status === (syncedLyrics ? 'synced' : 'plain'), 'partial failure must preserve usable text');
            assert(cache.read(track)?.result.status === result.status, 'usable text must be cached');
            assert((await service.search(track)).length === 1, 'manual search must preserve candidates despite partial failure');
        }
        let requests = 0;
        service.lrclib.collect = async () => { requests++; return outcome([candidate]); };
        const uncached = {...track, title: 'First load'};
        assert((await service.load(uncached)).status === 'synced' && requests === 1, 'first load must query provider');
        const restartedService = new LyricsService();
        restartedService.lrclib.collect = async () => { requests++; return outcome([candidate]); };
        try {
            assert((await restartedService.load(uncached)).status === 'synced' && requests === 1,
                'new service must reuse saved cache without querying or clearing it');
        } finally {
            restartedService.destroy();
        }
        const cachePath = cache.path(track);
        const [ok, bytes] = GLib.file_get_contents(cachePath);
        assert(ok && /\/lyricflow\/lyrics\/[a-f0-9]{64}\.json$/.test(cachePath), 'cache path must use fixed directory and SHA-256');
        const entry = JSON.parse(new TextDecoder().decode(bytes));
        assert(entry.trackKey === trackCacheKey(track), 'cache must store complete identity');
        assert(Object.keys(entry).sort().join(',') === 'result,savedAtMs,trackKey', 'cache must contain only identity, timestamp and result');
        entry.savedAtMs = 0;
        GLib.file_set_contents(cachePath, JSON.stringify(entry));
        setOutcomes(outcome(), outcome([], ['network failed']));
        const stale = await service.load(track);
        assert(stale.status === 'synced' && stale.stale, 'failure must fall back to stale text');
        assert(!cache.read(track)?.fresh, 'stale fallback must not renew cache');
        setOutcomes(outcome(), outcome());
        assert((await service.load(track)).stale, 'confirmed miss must preserve stale text');

        entry.savedAtMs = Date.now();
        entry.trackKey = 'wrong identity';
        GLib.file_set_contents(cachePath, JSON.stringify(entry));
        assert(cache.read(track) === null, 'cache identity must be checked');
        cache.write(track, resultFromCandidate(candidate));
        assert(cache.read({...track, trackId: '/track/other'})?.fresh, 'cache must be shared across track ids');
        const noQueries = {...track, title: 'No queries'};
        setOutcomes(outcome([], [], 0), outcome([], [], 0));
        assert((await service.load(noQueries)).status === 'error', 'no completed queries must be an error');
        assert(cache.read(noQueries) === null, 'no completed queries must not produce a negative cache');
        const pendingTrack = {...track, title: 'Pending'};
        let complete;
        let pendingCancellation;
        service.lrclib.collect = (_track, cancellable) => {
            pendingCancellation = cancellable;
            return new Promise(resolve => { complete = resolve; });
        };
        const pending = service.load(pendingTrack);
        const pendingRejected = rejects(pending, 'cancelled load must reject');
        await service.load(track);
        assert(pendingCancellation.is_cancelled(), 'fresh cache hit must cancel previous request');
        complete(outcome([candidate]));
        await pendingRejected;
        assert(cache.read(pendingTrack) === null, 'cancelled request must not write cache');

        const search = service.search(pendingTrack);
        const searchRejected = rejects(search, 'cancelled manual search must reject');
        service.cancel();
        complete(outcome([candidate]));
        await searchRejected;
        console.log('PASS lyrics service and cache');
    } finally {
        service.destroy();
    }
}

const PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES = Gio.DBusNodeInfo.new_for_xml(`<node>
<interface name="org.freedesktop.DBus.Properties">
<method name="GetAll"><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method>
<method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
</interface></node>`).interfaces[0];

// A separate connection supplies real D-Bus replies with controllable GetAll latency.
// No production hooks or changes to the desktop session are needed.
function mockPlayer(name, title, delayMs = 0) {
    const connection = Gio.DBusConnection.new_for_address_sync(GLib.getenv('DBUS_SESSION_BUS_ADDRESS'),
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);
    const state = {connection, requests: 0, closed: false, timers: new Set(), replies: 0};
    const playerProperties = {
        Metadata: new GLib.Variant('a{sv}', {
            'mpris:trackid': new GLib.Variant('o', '/track/1'),
            'mpris:length': new GLib.Variant('x', 180_000_000),
            'xesam:title': new GLib.Variant('s', title),
            'xesam:artist': new GLib.Variant('as', ['Artist']),
        }),
        PlaybackStatus: new GLib.Variant('s', 'Playing'),
        Rate: new GLib.Variant('d', 1), Position: new GLib.Variant('x', 0),
        ...Object.fromEntries(['CanPlay', 'CanPause', 'CanSeek', 'CanControl', 'CanGoNext', 'CanGoPrevious']
            .map(property => [property, new GLib.Variant('b', true)])),
    };
    const id = connection.register_object(PATH, PROPERTIES,
        (_connection, _sender, _path, _interface, method, parameters, invocation) => {
            const [iface, property] = parameters.deepUnpack();
            const values = iface === PLAYER ? playerProperties : {Identity: new GLib.Variant('s', title)};
            state.requests++;
            const reply = () => {
                if (!state.closed) {
                    invocation.return_value(method === 'GetAll'
                        ? new GLib.Variant('(a{sv})', [values]) : new GLib.Variant('(v)', [values[property]]));
                    state.replies++;
                }
            };
            if (delayMs) {
                const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                    state.timers.delete(timer);
                    reply();
                    return GLib.SOURCE_REMOVE;
                });
                state.timers.add(timer);
            } else {
                reply();
            }
        }, null, null);
    connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'RequestName', new GLib.Variant('(su)', [name, 3]), null, Gio.DBusCallFlags.NONE, -1, null);
    state.close = () => {
        if (state.closed)
            return;
        state.closed = true;
        for (const timer of state.timers)
            GLib.source_remove(timer);
        state.timers.clear();
        connection.unregister_object(id);
        connection.close_sync(null);
    };
    return state;
}

async function testMpris() {
    const prefix = 'org.mpris.MediaPlayer2.LyricFlow';
    const servers = [];
    const managers = [];
    const server = (...args) => { const item = mockPlayer(...args); servers.push(item); return item; };
    const manager = callback => { const item = new MprisManager(callback); managers.push(item); return item; };
    try {
        const initial = server(`${prefix}Existing`, 'Existing');
        const notifications = [];
        const active = manager(player => notifications.push(player?.track.title ?? null));
        active.start();
        await waitFor(() => notifications.includes('Existing'), 'existing player not discovered');
        assert(initial.requests === 2 && active.players.size === 1, 'existing discovery must initialize exactly two proxies');
        const late = server(`${prefix}Late`, 'Late');
        await waitFor(() => notifications.at(-1) === 'Late', 'late player not discovered');
        assert(late.requests === 2 && active.players.size === 2, 'late discovery must not duplicate proxies');

        const slow = server(`${prefix}Slow`, 'Slow', 200);
        await waitFor(() => slow.requests === 2, 'slow initialization did not begin');
        let heartbeat = false;
        await sleep(20).then(() => { heartbeat = true; });
        assert(heartbeat && !notifications.includes('Slow'), 'initialization must not block main loop');
        slow.close();
        await waitFor(() => !active.pending.has(`${prefix}Slow`), 'disappeared player still initializing');
        await sleep(220);
        assert(!notifications.includes('Slow') && !active.players.has(`${prefix}Slow`), 'disappeared player must not reappear');

        const old = server(`${prefix}Replace`, 'Old owner', 200);
        await waitFor(() => old.requests === 2, 'old owner did not start initializing');
        const replacement = server(`${prefix}Replace`, 'New owner');
        await waitFor(() => notifications.at(-1) === 'New owner', 'replacement owner not discovered');
        await waitFor(() => old.replies === 2, 'old owner replies not delivered');
        assert(!notifications.includes('Old owner'), 'stale owner must not be published');
        assert(active.players.get(`${prefix}Replace`)?.owner === replacement.connection.get_unique_name(), 'proxies must bind to unique owner');
        old.close();
        await sleep(20);
        assert(active.players.has(`${prefix}Replace`), 'old owner exit must not remove replacement');

        const firstSlow = server(`${prefix}FirstSlow`, 'First slow', 200);
        await waitFor(() => firstSlow.requests === 2, 'first slow initialization did not start');
        server(`${prefix}SecondFast`, 'Second fast');
        await waitFor(() => notifications.at(-1) === 'Second fast', 'fast player not discovered');
        await waitFor(() => active.players.has(`${prefix}FirstSlow`), 'slow player never became ready');
        assert(notifications.at(-1) === 'Second fast', 'completion order must not determine activity priority');

        late.close();
        await waitFor(() => !active.players.has(`${prefix}Late`), 'ready player not removed');
        active.destroy();
        const count = notifications.length;
        const pendingServer = server(`${prefix}Disable`, 'Disabled', 200);
        const disabledNotifications = [];
        const disabled = manager(player => disabledNotifications.push(player));
        disabled.start();
        await waitFor(() => pendingServer.requests === 2, 'disable fixture not initializing');
        disabled.destroy();
        const disabledCount = disabledNotifications.length;
        await sleep(250);
        assert(disabledNotifications.length === disabledCount && disabled.players.size === 0 && disabled.pending.size === 0,
            'disabled manager must ignore late proxy completions');
        assert(notifications.length === count, 'destroyed manager must not emit changes');

        const immediateNotifications = [];
        const immediate = manager(player => immediateNotifications.push(player));
        immediate.start();
        immediate.destroy();
        const immediateCount = immediateNotifications.length;
        await sleep(30);
        assert(immediateNotifications.length === immediateCount && immediate.pending.size === 0,
            'destroy during enumeration must not initialize players');
        const failedEnumeration = manager(() => {});
        const busCall = failedEnumeration.busCall.bind(failedEnumeration);
        failedEnumeration.busCall = (method, parameters, cancellable) => method === 'ListNames'
            ? Promise.reject(new Error('expected enumeration failure')) : busCall(method, parameters, cancellable);
        failedEnumeration.start();
        await sleep(20);
        const afterFailure = server(`${prefix}AfterFailure`, 'After enumeration failure');
        await waitFor(() => failedEnumeration.players.has(`${prefix}AfterFailure`),
            'enumeration failure must not disable name subscription');
        assert(afterFailure.requests === 2, 'name discovery after enumeration failure must not duplicate proxies');
        console.log('PASS asynchronous MPRIS discovery and lifecycle');
    } finally {
        for (const item of managers)
            item.destroy();
        for (const item of servers)
            item.close();
    }
}

await testLyricsService();
await testMpris();
