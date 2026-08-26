import assert from 'node:assert/strict';
import test from 'node:test';

import {liquidGlassPreset, parseLiquidGlassStrength} from '../src/ui/glass.js';

test('liquid glass presets have the specified blur and opacity values', () => {
    assert.deepEqual(liquidGlassPreset('subtle'), {radius: 12, opacity: 0.84});
    assert.deepEqual(liquidGlassPreset('balanced'), {radius: 24, opacity: 0.72});
    assert.deepEqual(liquidGlassPreset('strong'), {radius: 36, opacity: 0.60});
});

test('unknown liquid glass strengths fall back to balanced', () => {
    assert.equal(parseLiquidGlassStrength('subtle'), 'subtle');
    assert.equal(parseLiquidGlassStrength('strong'), 'strong');
    assert.equal(parseLiquidGlassStrength('unknown'), 'balanced');
});
