import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

// Use the GObject signal API: Gio.Cancellable.connect/disconnect are separate
// native methods, and native disconnect cannot be called from its own callback.
export function observeCancellation(token: Gio.Cancellable, callback: () => void): () => void {
    const id = GObject.Object.prototype.connect.call(token, 'cancelled', callback);
    return () => GObject.Object.prototype.disconnect.call(token, id);
}
