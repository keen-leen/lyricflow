import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {requestJson} from '../../.test-dist/runtime/lyrics/http.js';
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
    const service = new LyricsService();
    const cache = service.cache;
    const setOutcomes = (primary, fallback) => {
        service.lrclib.collect = async () => primary;
        service.netease.collect = async () => fallback;
    };
    try {
        assert((await cache.read(track)) === null, 'empty cache must miss');
        setOutcomes(outcome(), outcome([], ['lyrics fetch failed']));
        assert((await service.load(track)).status === 'error', 'partial failure must return error');
        assert((await cache.read(track)) === null, 'partial failure must not write a negative cache');
        await rejects(service.search(track), 'manual search must reject partial failure');

        setOutcomes(outcome(), outcome());
        assert((await service.load(track)).status === 'not-found', 'completed empty queries must return not-found');
        assert((await cache.read(track))?.fresh, 'completed miss must be cached');
        assert((await service.search(track)).length === 0, 'completed manual search must return empty candidates');

        for (const syncedLyrics of [null, candidate.syncedLyrics]) {
            setOutcomes(outcome([{...candidate, syncedLyrics}]), outcome([], ['provider failed']));
            const result = await service.load(track, true);
            assert(result.status === (syncedLyrics ? 'synced' : 'plain'), 'partial failure must preserve usable text');
            assert((await cache.read(track))?.result.status === result.status, 'usable text must be cached');
            assert((await service.search(track)).length === 1, 'manual search must preserve candidates despite partial failure');
        }
        let requests = 0;
        service.lrclib.collect = async current => { requests++; return outcome([{...candidate, trackName: current.title}]); };
        const uncached = {...track, title: 'First load'};
        assert((await service.load(uncached)).status === 'synced' && requests === 1, 'first load must query provider');
        await cache.read(uncached);
        const restartedService = new LyricsService();
        restartedService.lrclib.collect = async current => { requests++; return outcome([{...candidate, trackName: current.title}]); };
        try {
            assert((await restartedService.load(uncached)).status === 'synced' && requests === 1,
                'new service must reuse saved cache without querying or clearing it');
        } finally {
            restartedService.destroy();
        }
        await cache.mutations;
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
        assert(!(await cache.read(track))?.fresh, 'stale fallback must not renew cache');
        setOutcomes(outcome(), outcome());
        assert((await service.load(track)).stale, 'confirmed miss must preserve stale text');

        entry.savedAtMs = Date.now();
        entry.trackKey = 'wrong identity';
        GLib.file_set_contents(cachePath, JSON.stringify(entry));
        assert((await cache.read(track)) === null, 'cache identity must be checked');
        await cache.write(track, resultFromCandidate(candidate));
        assert((await cache.read({...track, trackId: '/track/other'}))?.fresh, 'cache must be shared across track ids');
        const noQueries = {...track, title: 'No queries'};
        setOutcomes(outcome([], [], 0), outcome([], [], 0));
        assert((await service.load(noQueries)).status === 'error', 'no completed queries must be an error');
        assert((await cache.read(noQueries)) === null, 'no completed queries must not produce a negative cache');
        const pendingTrack = {...track, title: 'Pending'};
        let complete;
        let pendingCancellation;
        service.lrclib.collect = (_track, cancellable) => {
            pendingCancellation = cancellable;
            return new Promise(resolve => { complete = resolve; });
        };
        const pending = service.load(pendingTrack);
        const pendingRejected = rejects(pending, 'cancelled load must reject');
        await waitFor(() => Boolean(complete), 'pending load did not start');
        await service.load(track);
        assert(pendingCancellation.is_cancelled(), 'fresh cache hit must cancel previous request');
        complete(outcome([candidate]));
        await pendingRejected;
        assert((await cache.read(pendingTrack)) === null, 'cancelled request must not write cache');

        const search = service.search(pendingTrack);
        const searchRejected = rejects(search, 'cancelled manual search must reject');
        service.cancel();
        complete(outcome([candidate]));
        await searchRejected;

        const disableTrack = {...track, title: 'Disable during query'};
        complete = null;
        const whileDisabling = service.load(disableTrack);
        const disabledRequest = rejects(whileDisabling, 'destroyed service must reject an active load');
        await waitFor(() => Boolean(complete), 'disable fixture did not start a query');
        service.destroy();
        assert(pendingCancellation.is_cancelled(), 'destroy must cancel the active provider');
        complete(outcome([{...candidate, trackName: disableTrack.title}]));
        await disabledRequest;
        await cache.mutations;
        assert(!GLib.file_test(cache.path(disableTrack), GLib.FileTest.EXISTS),
            'late provider result after destroy must not create a cache entry');
        console.log('PASS lyrics service and cache');
    } finally {
        service.destroy();
    }
}

async function testCacheIO() {
    const cache = new LyricsCache();
    cache.directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'cache-io-test']);
    const first = resultFromCandidate(candidate);
    const second = {...first, timedLines: [{timeMs: 1000, text: 'Latest selection'}]};
    try {
        const write1 = cache.write(track, first);
        const write2 = cache.write(track, second);
        assert((await cache.read(track))?.result.timedLines[0].text === 'Latest selection', 'read must wait for latest queued write');
        await Promise.all([write1, write2]);
        const token = new Gio.Cancellable();
        const cancelled = cache.write(track, first, token);
        token.cancel();
        await cancelled;
        assert((await cache.read(track))?.result.timedLines[0].text === 'Latest selection', 'cancelled write must not replace latest result');
        const oversized = {...track, title: 'Oversized'};
        await cache.write(oversized, {...first, plainLines: ['x'.repeat(1024 * 1024)]});
        assert(await cache.read(oversized) === null, 'oversized cache write must be skipped');
        const path = cache.path(track);
        GLib.file_set_contents(path, '{invalid json');
        assert(await cache.read(track) === null, 'corrupt JSON must be a cache miss');
        GLib.file_set_contents(path, 'x'.repeat(1024 * 1024 + 1));
        assert(await cache.read(track) === null, 'oversized file must be a cache miss');
    } finally { cache.destroy(); }

    const quota = new LyricsCache();
    quota.directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'quota-test']);
    GLib.mkdir_with_parents(quota.directory, 0o700);
    for (let i = 0; i < 1001; i++) {
        const name = `${i.toString(16).padStart(64, '0')}.json`;
        GLib.file_set_contents(GLib.build_filenamev([quota.directory, name]), JSON.stringify({
            savedAtMs: i + 1, trackKey: 'quota', result: i === 1000
                ? {status: 'not-found', candidate: null, timedLines: [], plainLines: []} : first,
        }));
    }
    try {
        await quota.write(track, first);
        assert(!GLib.file_test(GLib.build_filenamev([quota.directory, `${'0'.repeat(64)}.json`]), GLib.FileTest.EXISTS),
            'quota must remove oldest text after expired negative');
        assert(!GLib.file_test(GLib.build_filenamev([quota.directory, `${(1000).toString(16).padStart(64, '0')}.json`]), GLib.FileTest.EXISTS),
            'quota must remove expired negative first');
        assert(GLib.file_test(GLib.build_filenamev([quota.directory, `${'1'.padStart(64, '0')}.json`]), GLib.FileTest.EXISTS),
            'old text within quota must remain for offline playback');
        assert((await quota.read(track))?.result.status === 'synced', 'cleanup must preserve newly written entry');
    } finally { quota.destroy(); }
    console.log('PASS asynchronous cache IO, validation, cancellation and quota cleanup');
}

async function testRequestScheduling() {
    const services = [];
    const create = () => { const service = new LyricsService(); services.push(service); return service; };
    const matching = current => ({...candidate, trackName: current.title});
    try {
        const quick = create();
        let fallbacks = 0;
        quick.lrclib.collect = async current => outcome([matching(current)]);
        quick.netease.collect = async () => { fallbacks++; return outcome(); };
        assert((await quick.load({...track, title: 'Quick'})).status === 'synced' && fallbacks === 0,
            'fast synchronized primary must avoid fallback');
        const delayed = create();
        let primaryToken;
        const started = GLib.get_monotonic_time();
        delayed.lrclib.collect = (_current, token) => { primaryToken = token; return new Promise(() => {}); };
        delayed.netease.collect = async current => { fallbacks++; return outcome([matching(current)]); };
        assert((await delayed.load({...track, title: 'Delayed fallback'})).status === 'synced', 'fallback must win over a stalled primary');
        const elapsedMs = (GLib.get_monotonic_time() - started) / 1000;
        assert(elapsedMs >= 1950 && elapsedMs < 3000 && primaryToken.is_cancelled(), 'fallback must start after two seconds and cancel primary');

        const expired = create();
        const expiredTrack = {...track, title: 'Expired visible'};
        await expired.cache.write(expiredTrack, resultFromCandidate(matching(expiredTrack)));
        await expired.cache.mutations;
        const cachePath = expired.cache.path(expiredTrack);
        const [, contents] = GLib.file_get_contents(cachePath);
        const entry = JSON.parse(new TextDecoder().decode(contents));
        entry.savedAtMs = 0;
        GLib.file_set_contents(cachePath, JSON.stringify(entry));
        let complete;
        expired.lrclib.collect = () => new Promise(resolve => { complete = resolve; });
        expired.netease.collect = async () => outcome();
        const updates = [];
        const refresh = expired.load(expiredTrack, false, update => updates.push(update));
        await waitFor(() => Boolean(complete), 'refresh did not start');
        assert(updates[0]?.result.status === 'synced' && updates[0].refreshing, 'stale text must be published before network completion');
        complete(outcome([{...matching(expiredTrack), syncedLyrics: null}]));
        assert((await refresh).status === 'synced', 'plain result must not replace synchronized cache');

        const timeouts = [create(), create(), create(), create()];
        const timeoutStart = GLib.get_monotonic_time();
        const jobs = timeouts.map((service, index) => {
            service.lrclib.collect = (current, _token, update) => {
                update(outcome(index === 1 ? [] : [{...matching(current), syncedLyrics: null, instrumental: index === 3, plainLyrics: index === 3 ? null : 'Text'}]));
                return new Promise(() => {});
            };
            service.netease.collect = (current, _token, update) => {
                if (index === 3) update(outcome([{...matching(current), source: 'netease', syncedLyrics: null, plainLyrics: null, instrumental: true}]));
                return new Promise(() => {});
            };
            const current = {...track, title: `Timeout ${index}`};
            if (index === 2) return service.search(current).then(candidates => {
                assert(candidates.length === 1, 'manual deadline must retain partial candidates');
            });
            return service.load(current).then(async result => {
                assert(result.status === (index === 0 ? 'plain' : index === 3 ? 'instrumental' : 'error'), 'timeout must preserve partial text or return error');
                if (index === 1 || index === 3) assert(await service.cache.read(current) === null, 'timeout must not write a negative cache');
            });
        });
        await Promise.all(jobs);
        const timeoutMs = (GLib.get_monotonic_time() - timeoutStart) / 1000;
        assert(timeoutMs >= 14900 && timeoutMs < 16500, 'queries must share a fifteen-second deadline');
        const measurements = {fallbackMs: elapsedMs, deadlineMs: timeoutMs, staleShownBeforeNetwork: true};
        console.log(`REQUEST_MEASUREMENTS ${JSON.stringify(measurements)}`);
        const output = GLib.getenv('LYRICFLOW_REQUEST_MEASUREMENTS');
        if (output) GLib.file_set_contents(output, JSON.stringify(measurements, null, 2));
        console.log('PASS progressive cache, two-second fallback and fifteen-second deadline');
    } finally {
        for (const service of services) service.destroy();
    }
}

async function testRetryCancellation() {
    const server = new Soup.Server();
    const session = new Soup.Session();
    let requests = 0;
    server.add_handler(null, (_server, message) => { requests++; message.set_status(503, null); });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const url = server.get_uris()[0].to_string();
    try {
        const token = new Gio.Cancellable();
        const promise = requestJson(session, url, 'Retry cancellation test', token);
        const rejection = rejects(promise, 'cancelled retry must reject');
        await waitFor(() => requests === 1, 'local HTTP request not received');
        await sleep(30);
        const started = GLib.get_monotonic_time();
        token.cancel();
        await rejection;
        assert((GLib.get_monotonic_time() - started) / 1000 < 100, 'retry wait must cancel promptly');
        await sleep(320);
        assert(requests === 1, 'cancelled retry must not send another request');
        console.log('PASS cancellable HTTP retry');
    } finally { session.abort(); server.disconnect(); }
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
await testCacheIO();
await testRequestScheduling();
await testRetryCancellation();
