import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LyricFlowPreferences extends ExtensionPreferences {
    override async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        window.set_default_size(680, 720);

        const page = new Adw.PreferencesPage({
            title: this.gettext('LyricFlow'),
            icon_name: 'audio-x-generic-symbolic',
        });
        window.add(page);

        const display = new Adw.PreferencesGroup({
            title: this.gettext('Top bar'),
            description: this.gettext('Choose how synchronized lyrics appear in the GNOME top bar.'),
        });
        page.add(display);

        const showLyrics = new Adw.SwitchRow({
            title: this.gettext('Show synchronized lyrics'),
            subtitle: this.gettext('Fall back to the song title when timed lyrics are unavailable.'),
        });
        settings.bind('show-lyrics', showLyrics, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(showLyrics);

        const scripts = Gtk.StringList.new([
            this.gettext('Simplified Chinese'),
            this.gettext('Standard Traditional Chinese'),
            this.gettext('Keep source text'),
        ]);
        const script = new Adw.ComboRow({
            title: this.gettext('Lyrics text'),
            subtitle: this.gettext('Conversion only changes display text; cached LRCLIB lyrics remain unchanged.'),
            model: scripts,
        });
        const scriptValues = ['simplified', 'traditional', 'original'];
        script.selected = Math.max(0, scriptValues.indexOf(settings.get_string('lyrics-script')));
        script.connect('notify::selected', () => {
            settings.set_string('lyrics-script', scriptValues[script.selected] ?? 'simplified');
        });
        display.add(script);

        const positions = Gtk.StringList.new([
            this.gettext('Left'),
            this.gettext('Center'),
            this.gettext('Right'),
        ]);
        const position = new Adw.ComboRow({title: this.gettext('Position'), model: positions});
        const positionValues = ['left', 'center', 'right'];
        position.selected = Math.max(0, positionValues.indexOf(settings.get_string('panel-position')));
        position.connect('notify::selected', () => {
            settings.set_string('panel-position', positionValues[position.selected] ?? 'center');
        });
        display.add(position);

        display.add(this.spinRow(settings, 'max-width', this.gettext('Maximum width'), this.gettext('pixels'), 160, 720, 10));
        display.add(this.spinRow(settings, 'font-scale', this.gettext('Font scale'), '', 0.7, 1.8, 0.05));
        display.add(this.spinRow(settings, 'marquee-speed', this.gettext('Marquee speed'), this.gettext('pixels per second'), 12, 120, 1));
        display.add(this.spinRow(settings, 'track-info-duration', this.gettext('Track information duration'), this.gettext('seconds'), 1, 10, 1));

        const timing = new Adw.PreferencesGroup({
            title: this.gettext('Lyrics timing'),
            description: this.gettext('A positive offset shows lyrics earlier; a negative offset shows them later.'),
        });
        page.add(timing);
        timing.add(this.spinRow(settings, 'lyrics-offset-ms', this.gettext('Global offset'), this.gettext('milliseconds'), -10_000, 10_000, 250));

        const reset = new Adw.ActionRow({
            title: this.gettext('Reset timing offset'),
            subtitle: this.gettext('Restore the default value of 0 milliseconds.'),
        });
        const resetButton = new Gtk.Button({label: this.gettext('Reset'), valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => settings.reset('lyrics-offset-ms'));
        reset.add_suffix(resetButton);
        reset.activatable_widget = resetButton;
        timing.add(reset);

        const privacy = new Adw.PreferencesGroup({title: this.gettext('Lyrics service')});
        page.add(privacy);
        privacy.add(new Adw.ActionRow({
            title: 'LRCLIB',
            subtitle: this.gettext('Song title, artist, album, and duration are sent to LRCLIB when lyrics are requested. No account or credential is used.'),
        }));
        await Promise.resolve();
    }

    private spinRow(
        settings: Gio.Settings,
        key: string,
        title: string,
        subtitle: string,
        minimum: number,
        maximum: number,
        step: number,
    ): Adw.SpinRow {
        const row = Adw.SpinRow.new_with_range(minimum, maximum, step);
        row.title = title;
        row.subtitle = subtitle;
        row.digits = step < 1 ? 2 : 0;
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
