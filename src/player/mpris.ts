import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {PlaybackStatus, PlayerCapabilities, PlayerState, TrackMetadata} from '../types.js';
import {selectActivePlayer} from './selection.js';
import {clampPositionUs} from './position.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const ROOT_INTERFACE = 'org.mpris.MediaPlayer2';

interface ManagedPlayer {
    state: PlayerState;
    playerProxy: Gio.DBusProxy;
    rootProxy: Gio.DBusProxy;
    signalIds: number[];
    seekGeneration: number;
}

function unpack(value: unknown): unknown {
    if (value && typeof value === 'object' && 'deepUnpack' in value)
        return (value as GLib.Variant).deepUnpack();
    return value ?? null;
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
    const value = unpack(metadata[key] ?? null);
    return typeof value === 'string' ? value : '';
}

function metadataArtists(metadata: Record<string, unknown>): string[] {
    const value = unpack(metadata['xesam:artist'] ?? null);
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function readMetadata(proxy: Gio.DBusProxy): TrackMetadata {
    const raw = unpack(proxy.get_cached_property('Metadata'));
    const metadata = raw && typeof raw === 'object'
        ? raw as Record<string, unknown>
        : {};
    const artists = metadataArtists(metadata);
    const length = Number(unpack(metadata['mpris:length'] ?? null) ?? 0);
    return {
        trackId: metadataString(metadata, 'mpris:trackid') || '/org/mpris/MediaPlayer2/TrackList/NoTrack',
        title: metadataString(metadata, 'xesam:title'),
        artists,
        artist: artists.join(', '),
        album: metadataString(metadata, 'xesam:album'),
        lengthUs: Number.isFinite(length) ? length : 0,
        artUrl: metadataString(metadata, 'mpris:artUrl'),
    };
}

function booleanProperty(proxy: Gio.DBusProxy, name: string): boolean {
    return Boolean(unpack(proxy.get_cached_property(name)));
}

function readCapabilities(proxy: Gio.DBusProxy): PlayerCapabilities {
    return {
        canGoNext: booleanProperty(proxy, 'CanGoNext'),
        canGoPrevious: booleanProperty(proxy, 'CanGoPrevious'),
        canPlay: booleanProperty(proxy, 'CanPlay'),
        canPause: booleanProperty(proxy, 'CanPause'),
        canSeek: booleanProperty(proxy, 'CanSeek'),
        canControl: booleanProperty(proxy, 'CanControl'),
    };
}

function playbackStatus(proxy: Gio.DBusProxy): PlaybackStatus {
    const value = String(unpack(proxy.get_cached_property('PlaybackStatus')) ?? 'Stopped');
    return value === 'Playing' || value === 'Paused' ? value : 'Stopped';
}

function numberProperty(proxy: Gio.DBusProxy, name: string, fallback: number): number {
    const value = Number(unpack(proxy.get_cached_property(name)) ?? fallback);
    return Number.isFinite(value) ? value : fallback;
}

export class MprisManager {
    private readonly players = new Map<string, ManagedPlayer>();
    private readonly connection = Gio.DBus.session;
    private nameSignalId = 0;
    private sequence = 0;
    private destroyed = false;

    constructor(private readonly onChanged: (player: PlayerState | null) => void) {}

    start(): void {
        const reply = this.connection.call_sync(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
        );
        const [names] = reply.deepUnpack() as [string[]];
        for (const name of names.filter(candidate => candidate.startsWith(MPRIS_PREFIX)))
            this.addPlayer(name);

        this.nameSignalId = this.connection.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, parameters) => {
                const [name, oldOwner, newOwner] = parameters.deepUnpack() as [string, string, string];
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this.removePlayer(name);
                if (newOwner)
                    this.addPlayer(name);
            },
        );
        this.emitChanged();
    }

    private addPlayer(busName: string): void {
        if (this.destroyed || this.players.has(busName))
            return;
        try {
            const playerProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
                null,
                busName,
                OBJECT_PATH,
                PLAYER_INTERFACE,
                null,
            );
            const rootProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                OBJECT_PATH,
                ROOT_INTERFACE,
                null,
            );
            const status = playbackStatus(playerProxy);
            const state: PlayerState = {
                busName,
                identity: String(unpack(rootProxy.get_cached_property('Identity')) ?? busName.slice(MPRIS_PREFIX.length)),
                status,
                track: readMetadata(playerProxy),
                positionUs: numberProperty(playerProxy, 'Position', 0),
                rate: numberProperty(playerProxy, 'Rate', 1),
                sampledAtUs: GLib.get_monotonic_time(),
                activeSequence: ++this.sequence,
                capabilities: readCapabilities(playerProxy),
            };
            const managed: ManagedPlayer = {state, playerProxy, rootProxy, signalIds: [], seekGeneration: 0};
            managed.signalIds.push(playerProxy.connect(
                'g-properties-changed',
                (_proxy, changedProperties) => this.refreshPlayer(managed, changedProperties),
            ));
            managed.signalIds.push(playerProxy.connect('g-signal', (_proxy, _sender, signalName, parameters) => {
                if (signalName !== 'Seeked')
                    return;
                const [positionUs] = parameters.deepUnpack() as [number];
                managed.state.positionUs = Number(positionUs);
                managed.state.sampledAtUs = GLib.get_monotonic_time();
                this.emitChanged();
            }));
            this.players.set(busName, managed);
        } catch (error) {
            console.warn(`LyricFlow: failed to connect to ${busName}: ${String(error)}`);
        }
        this.emitChanged();
    }

    private removePlayer(busName: string): void {
        const managed = this.players.get(busName);
        if (!managed)
            return;
        for (const id of managed.signalIds)
            managed.playerProxy.disconnect(id);
        this.players.delete(busName);
        this.emitChanged();
    }

    private refreshPlayer(managed: ManagedPlayer, changedProperties: GLib.Variant): void {
        const previousStatus = managed.state.status;
        const previousTrack = managed.state.track.trackId;
        const estimatedPositionUs = this.getPositionUs(managed.state);
        const changed = changedProperties.deepUnpack() as Record<string, unknown>;
        const status = playbackStatus(managed.playerProxy);
        const track = readMetadata(managed.playerProxy);
        const trackChanged = previousTrack !== track.trackId;
        const changedPosition = Object.hasOwn(changed, 'Position')
            ? Number(unpack(changed.Position))
            : null;
        managed.state = {
            ...managed.state,
            status,
            track,
            positionUs: Number.isFinite(changedPosition)
                ? changedPosition as number
                : trackChanged ? 0 : estimatedPositionUs,
            rate: numberProperty(managed.playerProxy, 'Rate', 1),
            sampledAtUs: GLib.get_monotonic_time(),
            capabilities: readCapabilities(managed.playerProxy),
        };
        if ((status === 'Playing' && previousStatus !== 'Playing') || trackChanged)
            managed.state.activeSequence = ++this.sequence;
        this.emitChanged();
    }

    private emitChanged(): void {
        if (!this.destroyed)
            this.onChanged(selectActivePlayer([...this.players.values()].map(player => player.state)));
    }

    getPositionUs(state: PlayerState): number {
        if (state.status !== 'Playing')
            return Math.max(0, state.positionUs);
        const elapsed = GLib.get_monotonic_time() - state.sampledAtUs;
        const position = state.positionUs + elapsed * state.rate;
        return Math.max(0, state.track.lengthUs > 0 ? Math.min(position, state.track.lengthUs) : position);
    }

    playPause(state: PlayerState): void {
        this.call(state, 'PlayPause');
    }

    next(state: PlayerState): void {
        this.call(state, 'Next');
    }

    previous(state: PlayerState): void {
        this.call(state, 'Previous');
    }

    seekTo(state: PlayerState, positionUs: number): void {
        if (!state.capabilities.canSeek || !state.track.trackId)
            return;
        const managed = this.players.get(state.busName);
        if (!managed || !state.capabilities.canControl
            || managed.state.track.trackId !== state.track.trackId)
            return;
        const trackId = state.track.trackId;
        const targetUs = Math.round(clampPositionUs(positionUs, managed.state.track.lengthUs));
        const seekGeneration = ++managed.seekGeneration;
        managed.state.positionUs = targetUs;
        managed.state.sampledAtUs = GLib.get_monotonic_time();
        this.emitChanged();
        this.call(
            managed.state,
            'SetPosition',
            new GLib.Variant('(ox)', [trackId, targetUs]),
            () => this.resyncPosition(managed, trackId, seekGeneration),
        );
    }

    private call(
        state: PlayerState,
        method: string,
        parameters: GLib.Variant | null = null,
        onError?: () => void,
    ): void {
        const managed = this.players.get(state.busName);
        if (!managed || !state.capabilities.canControl)
            return;
        managed.playerProxy.call(method, parameters, Gio.DBusCallFlags.NONE, -1, null, (_proxy, result) => {
            try {
                if (result)
                    managed.playerProxy.call_finish(result);
            } catch (error) {
                console.warn(`LyricFlow: MPRIS ${method} failed: ${String(error)}`);
                onError?.();
            }
        });
    }

    private resyncPosition(managed: ManagedPlayer, trackId: string, seekGeneration: number): void {
        managed.playerProxy.call(
            'org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [PLAYER_INTERFACE, 'Position']),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (_proxy, result) => {
                try {
                    if (!result)
                        return;
                    const reply = managed.playerProxy.call_finish(result);
                    const [rawPosition] = reply.deepUnpack() as [unknown];
                    if (this.destroyed
                        || this.players.get(managed.state.busName) !== managed
                        || managed.seekGeneration !== seekGeneration
                        || managed.state.track.trackId !== trackId)
                        return;
                    managed.state.positionUs = Number(unpack(rawPosition));
                    managed.state.sampledAtUs = GLib.get_monotonic_time();
                    this.emitChanged();
                } catch (error) {
                    console.warn(`LyricFlow: failed to resync MPRIS position: ${String(error)}`);
                }
            },
        );
    }

    destroy(): void {
        this.destroyed = true;
        if (this.nameSignalId)
            this.connection.signal_unsubscribe(this.nameSignalId);
        for (const managed of this.players.values()) {
            for (const id of managed.signalIds)
                managed.playerProxy.disconnect(id);
        }
        this.players.clear();
    }
}
