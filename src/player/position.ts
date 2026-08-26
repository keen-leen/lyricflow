export function clampPositionUs(positionUs: number, lengthUs: number): number {
    const finitePosition = Number.isFinite(positionUs) ? positionUs : 0;
    const lowerBounded = Math.max(0, finitePosition);
    return lengthUs > 0 ? Math.min(lowerBounded, lengthUs) : lowerBounded;
}

export function displayedPositionUs(actualPositionUs: number, previewPositionUs: number | null): number {
    return previewPositionUs ?? actualPositionUs;
}

export function lyricSeekPositionUs(timeMs: number, offsetMs: number, lengthUs: number): number {
    const safeTimeMs = Number.isFinite(timeMs) ? timeMs : 0;
    const safeOffsetMs = Number.isFinite(offsetMs) ? offsetMs : 0;
    return Math.round(clampPositionUs((safeTimeMs - safeOffsetMs) * 1_000, lengthUs));
}

export function formatPlaybackTime(positionUs: number): string {
    const totalSeconds = Math.floor(Math.max(0, Number.isFinite(positionUs) ? positionUs : 0) / 1_000_000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3_600);
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
