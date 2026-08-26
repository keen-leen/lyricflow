export function clampPositionUs(positionUs: number, lengthUs: number): number {
    const finitePosition = Number.isFinite(positionUs) ? positionUs : 0;
    const lowerBounded = Math.max(0, finitePosition);
    return lengthUs > 0 ? Math.min(lowerBounded, lengthUs) : lowerBounded;
}

export function displayedPositionUs(actualPositionUs: number, previewPositionUs: number | null): number {
    return previewPositionUs ?? actualPositionUs;
}
