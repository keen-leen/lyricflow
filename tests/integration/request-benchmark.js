import GLib from 'gi://GLib';
const {LyricsService} = await import(GLib.getenv('LYRICFLOW_SERVICE_MODULE'));
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const now = () => GLib.get_monotonic_time() / 1000;
const base = {trackId: '/track/bench', title: 'Request benchmark', artist: 'Artist', artists: ['Artist'], album: 'Album', lengthUs: 180_000_000, artUrl: ''};
const candidate = current => ({id: 1, source: 'lrclib', trackName: current.title, artistName: 'Artist', albumName: 'Album', duration: 180, instrumental: false, plainLyrics: 'Text', syncedLyrics: '[00:01] Text'});
const outcome = candidates => ({candidates, successfulRequests: 1, errors: []});
const rows = [];
for (let trial = 0; trial < 3; trial++) {
    const service = new LyricsService();
    const track = {...base, title: `Stale ${trial}`};
    try {
        await service.cache.write(track, {status: 'synced', candidate: candidate(track), timedLines: [{timeMs: 1000, text: 'Text'}], plainLines: ['Text']});
        if (service.cache.mutations) await service.cache.mutations;
        const path = service.cache.path(track);
        const [, bytes] = GLib.file_get_contents(path);
        const entry = JSON.parse(new TextDecoder().decode(bytes));
        entry.savedAtMs = 0;
        GLib.file_set_contents(path, JSON.stringify(entry));
        service.lrclib.collect = async () => { await sleep(1000); return outcome([]); };
        service.netease.collect = async () => outcome([]);
        const start = now();
        let firstVisibleMs = null;
        const result = await service.load(track, false, () => { firstVisibleMs ??= now() - start; });
        firstVisibleMs ??= now() - start;
        rows.push({scenario: 'stale-cache', trial, firstVisibleMs, completedMs: now() - start, status: result.status});
    } finally { service.destroy(); }
    const fallback = new LyricsService();
    try {
        fallback.lrclib.collect = async () => { await sleep(4000); return outcome([]); };
        fallback.netease.collect = async current => { await sleep(100); return outcome([candidate(current)]); };
        const start = now();
        const result = await fallback.load({...base, title: `Fallback ${trial}`});
        rows.push({scenario: 'slow-primary', trial, firstVisibleMs: now() - start, status: result.status});
    } finally { fallback.destroy(); }
}
GLib.file_set_contents(GLib.getenv('LYRICFLOW_REQUEST_OUTPUT'), JSON.stringify({recordedAt: new Date().toISOString(), rows}, null, 2));
console.log('Controlled request benchmark passed');
