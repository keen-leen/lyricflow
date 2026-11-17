import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {observeCancellation} from './cancellation.js';
import {shouldRetryHttpStatus} from './http-policy.js';

const RETRY_DELAY_MS = 300;

export class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

function isCancelled(cancellable?: unknown): boolean {
    return cancellable instanceof Gio.Cancellable && cancellable.is_cancelled();
}

function waitBeforeRetry(cancellable?: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const token = cancellable instanceof Gio.Cancellable ? cancellable : null;
        let detach = () => {};
        let timer = 0;
        const finish = (cancelled: boolean) => {
            if (timer) { GLib.source_remove(timer); timer = 0; }
            detach();
            if (cancelled) reject(new Error('Lyrics request was cancelled'));
            else resolve();
        };
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_DELAY_MS, () => {
            timer = 0;
            finish(false);
            return GLib.SOURCE_REMOVE;
        });
        if (token) detach = observeCancellation(token, () => finish(true));
        if (token?.is_cancelled()) finish(true);
    });
}

function send(
    session: Soup.Session,
    url: string,
    cancellable?: unknown,
): Promise<{value: unknown; status: number}> {
    const message = Soup.Message.new('GET', url);
    return new Promise((resolve, reject) => {
        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable instanceof Gio.Cancellable ? cancellable : null,
            (source, result) => {
                try {
                    const bytes = source?.send_and_read_finish(result);
                    const status = message.status_code;
                    if (status < 200 || status >= 300)
                        throw new HttpError(status, `HTTP ${status}`);
                    const text = new TextDecoder().decode(bytes?.get_data() ?? new Uint8Array());
                    resolve({value: JSON.parse(text), status});
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

export async function requestJson(
    session: Soup.Session,
    url: string,
    stage: string,
    cancellable?: unknown,
): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await send(session, url, cancellable);
            console.debug(`LyricFlow: ${stage} HTTP ${response.status}${attempt ? ' after retry' : ''}`);
            return response.value;
        } catch (error) {
            if (isCancelled(cancellable))
                throw error;
            const retryable = error instanceof HttpError
                ? shouldRetryHttpStatus(error.status)
                : true;
            if (attempt > 0 || !retryable)
                throw error;
            console.debug(`LyricFlow: ${stage} failed, retrying once: ${String(error)}`);
            await waitBeforeRetry(cancellable);
            if (isCancelled(cancellable))
                throw error;
        }
    }
    throw new Error(`${stage} exhausted retries`);
}

export function queryParams(values: Record<string, string | number | undefined>): string {
    return Object.entries(values)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
}
