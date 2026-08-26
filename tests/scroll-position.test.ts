import assert from 'node:assert/strict';
import test from 'node:test';

import {
    centeredScrollValue,
    contentLineGeometry,
    edgeSpacerHeight,
} from '../src/ui/scroll-position.js';

test('edge spacer centers the first and last lyric lines', () => {
    const viewport = 330;
    const firstHeight = 34;
    const lastHeight = 46;
    const spacing = 5;
    assert.equal(edgeSpacerHeight(viewport, firstHeight, spacing), 143);
    assert.equal(edgeSpacerHeight(viewport, lastHeight, spacing), 137);

    const firstY = edgeSpacerHeight(viewport, firstHeight, spacing) + spacing;
    assert.equal(centeredScrollValue(firstY, firstHeight, viewport, 0, 1_000), 0);

    const contentHeight = 900;
    const lastY = contentHeight - edgeSpacerHeight(viewport, lastHeight, spacing) - spacing - lastHeight;
    assert.equal(
        centeredScrollValue(lastY, lastHeight, viewport, 0, contentHeight),
        contentHeight - viewport,
    );
});

test('middle lyric is positioned at the vertical center', () => {
    assert.equal(centeredScrollValue(480, 40, 330, 0, 1_200), 335);
});

test('scroll target is clamped to the adjustment range', () => {
    assert.equal(centeredScrollValue(-20, 20, 330, 0, 1_000), 0);
    assert.equal(centeredScrollValue(990, 20, 330, 0, 1_000), 670);
});

test('content geometry uses the allocation of a direct child', () => {
    assert.deepEqual(contentLineGeometry({y1: 240, y2: 282}), {y: 240, height: 42});
});

test('content geometry accumulates nested parent allocations', () => {
    assert.deepEqual(contentLineGeometry(
        {y1: 20, y2: 62},
        [{y1: 100, y2: 500}, {y1: 35, y2: 700}],
    ), {y: 155, height: 42});
});
