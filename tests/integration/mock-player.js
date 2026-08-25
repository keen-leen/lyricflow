#!/usr/bin/gjs -m

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.mpris.MediaPlayer2.LyricFlowTest';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const TRACK_ID = '/org/mpris/MediaPlayer2/track/1';

const XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg direction="in" type="x" name="Offset"/></method>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
    <signal name="Seeked"><arg type="x" name="Position"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

let status = 'Playing';
let sampledPosition = 0;
let sampledAt = GLib.get_monotonic_time();
let exported = null;

function position() {
    return status === 'Playing'
        ? sampledPosition + GLib.get_monotonic_time() - sampledAt
        : sampledPosition;
}

function sample() {
    sampledPosition = position();
    sampledAt = GLib.get_monotonic_time();
}

function emitStatus() {
    exported?.emit_property_changed('PlaybackStatus', new GLib.Variant('s', status));
}

const implementation = {
    CanQuit: false,
    CanRaise: false,
    HasTrackList: false,
    Identity: 'LyricFlow Test Player',
    DesktopEntry: '',
    SupportedUriSchemes: [],
    SupportedMimeTypes: [],
    get PlaybackStatus() {
        return status;
    },
    Rate: 1,
    get Metadata() {
        return {
            'mpris:trackid': new GLib.Variant('o', TRACK_ID),
            'mpris:length': new GLib.Variant('x', 271_000_000),
            'xesam:title': new GLib.Variant('s', 'The Chain'),
            'xesam:artist': new GLib.Variant('as', ['Fleetwood Mac']),
            'xesam:album': new GLib.Variant('s', 'Rumours'),
        };
    },
    get Position() {
        return Math.round(position());
    },
    MinimumRate: 1,
    MaximumRate: 1,
    CanGoNext: true,
    CanGoPrevious: true,
    CanPlay: true,
    CanPause: true,
    CanSeek: true,
    CanControl: true,
    Next() {},
    Previous() {},
    Pause() {
        sample();
        status = 'Paused';
        emitStatus();
    },
    Play() {
        sampledAt = GLib.get_monotonic_time();
        status = 'Playing';
        emitStatus();
    },
    PlayPause() {
        if (status === 'Playing')
            this.Pause();
        else
            this.Play();
    },
    Stop() {
        sample();
        status = 'Stopped';
        emitStatus();
    },
    Seek(offset) {
        sample();
        sampledPosition = Math.max(0, sampledPosition + Number(offset));
        exported?.emit_signal('Seeked', new GLib.Variant('(x)', [Math.round(sampledPosition)]));
    },
    SetPosition(trackId, value) {
        if (trackId !== TRACK_ID)
            return;
        sampledPosition = Math.max(0, Number(value));
        sampledAt = GLib.get_monotonic_time();
        exported?.emit_signal('Seeked', new GLib.Variant('(x)', [Math.round(sampledPosition)]));
    },
};

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(
    Gio.BusType.SESSION,
    BUS_NAME,
    Gio.BusNameOwnerFlags.NONE,
    connection => {
        exported = Gio.DBusExportedObject.wrapJSObject(XML, implementation);
        exported.export(connection, OBJECT_PATH);
        console.log(`${BUS_NAME} ready`);
    },
    null,
    () => loop.quit(),
);
loop.run();
