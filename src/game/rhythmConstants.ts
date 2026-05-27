// Why: 0.5s quarter-note matches the smallest beat slot any bassteroid can occupy after two splits.
export const BEAT_GRID = 0.5;
// Why: ±80ms — wide enough to absorb the 50ms dt cap, narrow enough that timing still matters.
export const BEAT_WINDOW = 0.08;

// Why: dev-only logging gate to diagnose drift between the rhythm gate and what the player hears.
export const DEBUG_BEAT_TIMING = false;

