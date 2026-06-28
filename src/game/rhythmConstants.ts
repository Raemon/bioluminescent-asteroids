// 0.5s quarter-note matches the smallest beat slot any bassteroid can occupy after two splits.
export const BEAT_GRID = 0.5;
// ±80ms — wide enough to absorb the 50ms dt cap, narrow enough that timing still matters.
export const BEAT_WINDOW = 0.11

// dev-only logging gate to diagnose drift between the rhythm gate and what the player hears.
export const DEBUG_BEAT_TIMING = false;

// Extra rhythm a drift shot adds one beat after its on-beat hit. The hit itself already bumped
//   combo +1, so this lands the streak at +2 total over the pre-shot value. Tier scales damage,
//   not rhythm, so this is a flat +1 regardless of how long the lock was held.
export const DRIFT_RHYTHM_BONUS = 1;
