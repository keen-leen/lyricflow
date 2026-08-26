export function edgeSpacerHeight(
    viewportHeight: number,
    lineHeight: number,
    adjacentSpacing = 0,
): number {
    return Math.max(0, (viewportHeight - lineHeight) / 2 - adjacentSpacing);
}

export function centeredScrollValue(
    lineY: number,
    lineHeight: number,
    pageSize: number,
    lower: number,
    upper: number,
): number {
    const target = lineY + lineHeight / 2 - pageSize / 2;
    const maximum = Math.max(lower, upper - pageSize);
    return Math.max(lower, Math.min(target, maximum));
}

export interface VerticalAllocation {
    y1: number;
    y2: number;
}

export interface ContentLineGeometry {
    y: number;
    height: number;
}

export function contentLineGeometry(
    line: VerticalAllocation,
    ancestors: readonly VerticalAllocation[] = [],
): ContentLineGeometry {
    return {
        y: line.y1 + ancestors.reduce((offset, allocation) => offset + allocation.y1, 0),
        height: Math.max(0, line.y2 - line.y1),
    };
}
