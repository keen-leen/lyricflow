import type {PlayerState} from '../types.js';

const STATUS_PRIORITY = {Playing: 3, Paused: 2, Stopped: 1} as const;

export function selectActivePlayer(players: Iterable<PlayerState>): PlayerState | null {
    const candidates = [...players].filter(player => Boolean(player.track.title));
    candidates.sort((a, b) => {
        const status = STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status];
        return status || b.activeSequence - a.activeSequence;
    });
    return candidates[0] ?? null;
}
