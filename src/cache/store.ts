import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {CacheEntry, CachedLyrics, LyricsResult, TrackMetadata} from '../types.js';
import {observeCancellation} from '../lyrics/cancellation.js';
import {trackCacheKey} from '../lyrics/core.js';
import {cacheEvictions, decodeCacheEntry, isCacheFresh, MAX_CACHE_FILE_BYTES, type CacheFileRecord} from './policy.js';

type Completion = (source: unknown, result: Gio.AsyncResult) => void;
function io<T>(start: (done: Completion) => void, finish: (result: Gio.AsyncResult) => T): Promise<T> {
    return new Promise((resolve, reject) => start((_source, result) => {
        try { resolve(finish(result)); } catch (error) { reject(error); }
    }));
}

export class LyricsCache {
    private readonly directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lyricflow', 'lyrics']);
    private readonly lifetime = new Gio.Cancellable();
    private readonly pending = new Map<string, Promise<void>>();
    private mutations: Promise<void> = Promise.resolve();
    private lastCleanupUs: number | null = null;

    private path(track: TrackMetadata): string {
        const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, trackCacheKey(track), -1);
        return GLib.build_filenamev([this.directory, `${digest}.json`]);
    }

    private async ensureDirectory(file: Gio.File, cancellable: Gio.Cancellable): Promise<void> {
        try {
            await io(done => file.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable, done),
                result => file.make_directory_finish(result));
            const attributes = new Gio.FileInfo();
            attributes.set_attribute_uint32('unix::mode', 0o700);
            await io(done => file.set_attributes_async(attributes, Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellable, done), result => file.set_attributes_finish(result));
        } catch (error) {
            if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                return;
            if (!(error instanceof GLib.Error) || !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
            const parent = file.get_parent();
            if (!parent) throw error;
            await this.ensureDirectory(parent, cancellable);
            await this.ensureDirectory(file, cancellable);
        }
    }

    private async readEntry(file: Gio.File, key: string | null, cancellable: Gio.Cancellable): Promise<CacheEntry | null> {
        const info = await io(done => file.query_info_async('standard::size,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable, done),
        result => file.query_info_finish(result));
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_CACHE_FILE_BYTES)
            return null;
        const [, contents] = await io(done => file.load_contents_async(cancellable, done), result => file.load_contents_finish(result));
        if (contents.length > MAX_CACHE_FILE_BYTES)
            return null;
        const value: unknown = JSON.parse(new TextDecoder().decode(contents));
        const expected = key ?? (value && typeof value === 'object' && 'trackKey' in value ? String(value.trackKey) : '');
        return decodeCacheEntry(value, expected);
    }

    async read(track: TrackMetadata, cancellable = this.lifetime): Promise<CachedLyrics | null> {
        const path = this.path(track);
        await this.pending.get(path);
        try {
            if (this.lifetime.is_cancelled() || cancellable.is_cancelled()) return null;
            const entry = await this.readEntry(Gio.File.new_for_path(path), trackCacheKey(track), cancellable);
            return entry ? {result: entry.result, fresh: isCacheFresh(entry)} : null;
        } catch {
            return null;
        }
    }

    write(track: TrackMetadata, result: LyricsResult, cancellable = this.lifetime): Promise<void> {
        const path = this.path(track);
        const entry: CacheEntry = {savedAtMs: Date.now(), trackKey: trackCacheKey(track), result: {...result, stale: false}};
        const bytes = new TextEncoder().encode(JSON.stringify(entry));
        if (bytes.length > MAX_CACHE_FILE_BYTES || !decodeCacheEntry(entry, entry.trackKey))
            return Promise.resolve();
        const task = this.mutations.then(async () => {
            if (this.lifetime.is_cancelled() || cancellable.is_cancelled()) return;
            const token = new Gio.Cancellable();
            const detachLifetime = observeCancellation(this.lifetime, () => token.cancel());
            const detachRequest = observeCancellation(cancellable, () => token.cancel());
            try {
                await this.ensureDirectory(Gio.File.new_for_path(this.directory), token);
                if (token.is_cancelled()) return;
                const file = Gio.File.new_for_path(path);
                await io(done => file.replace_contents_async(bytes, null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, token, done),
                result => file.replace_contents_finish(result));
            } finally {
                detachLifetime();
                detachRequest();
            }
            const now = GLib.get_monotonic_time();
            if (this.lastCleanupUs === null || now - this.lastCleanupUs >= 3_600_000_000) {
                this.lastCleanupUs = now;
                try { await this.prune(); } catch (error) {
                    if (!this.lifetime.is_cancelled()) console.debug(`LyricFlow: cache cleanup skipped: ${String(error)}`);
                }
            }
        }).catch(error => {
            if (!this.lifetime.is_cancelled() && !cancellable.is_cancelled())
                console.warn(`LyricFlow: could not write lyrics cache: ${String(error)}`);
        });
        this.pending.set(path, task);
        this.mutations = task;
        void task.then(() => { if (this.pending.get(path) === task) this.pending.delete(path); });
        return task;
    }

    private async prune(): Promise<void> {
        const directory = Gio.File.new_for_path(this.directory);
        const enumerator = await io(done => directory.enumerate_children_async('standard::name,standard::size,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT_IDLE, this.lifetime, done),
        result => directory.enumerate_children_finish(result));
        const files: CacheFileRecord[] = [];
        try {
            while (!this.lifetime.is_cancelled()) {
                const batch = await io(done => enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT_IDLE, this.lifetime, done),
                    result => enumerator.next_files_finish(result));
                if (batch.length === 0) break;
                for (const info of batch) {
                    const name = info.get_name();
                    if (!/^[a-f0-9]{64}\.json$/.test(name) || info.get_file_type() !== Gio.FileType.REGULAR) continue;
                    let entry: CacheEntry | null = null;
                    try { entry = await this.readEntry(directory.get_child(name), null, this.lifetime); } catch { /* Evict invalid files first. */ }
                    files.push({name, bytes: info.get_size(), savedAtMs: entry?.savedAtMs ?? 0,
                        expiredNegative: !entry || !isCacheFresh(entry)
                            && (entry.result.status === 'not-found' || entry.result.status === 'instrumental')});
                }
            }
        } finally {
            await io(done => enumerator.close_async(GLib.PRIORITY_DEFAULT_IDLE, null, done), result => enumerator.close_finish(result));
        }
        for (const file of cacheEvictions(files)) {
            const child = directory.get_child(file.name);
            await io(done => child.delete_async(GLib.PRIORITY_DEFAULT_IDLE, this.lifetime, done), result => child.delete_finish(result));
        }
    }

    destroy(): void { this.lifetime.cancel(); }
}
