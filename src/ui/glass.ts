export type LiquidGlassStrength = 'subtle' | 'balanced' | 'strong';

export interface LiquidGlassPreset {
    radius: number;
    opacity: number;
}

const PRESETS: Record<LiquidGlassStrength, LiquidGlassPreset> = {
    subtle: {radius: 12, opacity: 0.84},
    balanced: {radius: 24, opacity: 0.72},
    strong: {radius: 36, opacity: 0.60},
};

export function liquidGlassPreset(strength: LiquidGlassStrength): LiquidGlassPreset {
    return PRESETS[strength];
}

export function parseLiquidGlassStrength(value: string): LiquidGlassStrength {
    return value === 'subtle' || value === 'strong' ? value : 'balanced';
}
