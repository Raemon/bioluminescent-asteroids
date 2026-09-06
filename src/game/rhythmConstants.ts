// 0.5s quarter-note matches the smallest beat slot any bassteroid can occupy after two splits.
export const BEAT_GRID = 0.5;
// How far ahead of the audio clock beat-locked one-shots are scheduled. A frame
// stall up to this long is absorbed silently: the hit was already handed to the
// audio hardware with an absolute start time, so it sounds on the sample
// regardless of when the next rAF frame lands. Too short and stalls leak
// through as lag; too long and hits feel detached from on-screen gameplay.
export const PULSE_LOOKAHEAD = 0.12;
// ±80ms — wide enough to absorb the 50ms dt cap, narrow enough that timing still matters.
export const BEAT_WINDOW = 0.11

// dev-only logging gate to diagnose drift between the rhythm gate and what the player hears.
export const DEBUG_BEAT_TIMING = false;

// Extra rhythm a drift shot adds one beat after its on-beat hit. The hit itself already bumped
//   combo +1, so this lands the streak at +2 total over the pre-shot value. Tier scales damage,
//   not rhythm, so this is a flat +1 regardless of how long the lock was held.
export const DRIFT_RHYTHM_BONUS = 1;

// Far Shot: a combo hit that lands FAR_SHOT_MIN_BEATS or more quarter-note beats after the shot
//   was fired (the 2-beat reticule or deeper) pays one rhythm per beat of lead, capped at
//   FAR_SHOT_MAX_RHYTHM. From FAR_SHOT_BIG_BEATS it also gets the two-line popup, burst and boom.
export const FAR_SHOT_MIN_BEATS = 2;
export const FAR_SHOT_BIG_BEATS = 3;
export const FAR_SHOT_MAX_RHYTHM = 6;
