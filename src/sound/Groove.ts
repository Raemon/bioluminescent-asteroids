// Groove shaping for the bassteroid percussion section.
//
// Right now Game.tickBassBeats fires each bassteroid's voice at face value on
// every quarter note: rigid, all-equal volume, no microtiming. Real drummers
// do three things that we should imitate:
//
//   1. Accent. Beats 1 and 3 ("downbeats") hit harder than 2 and 4
//      ("backbeats"). This is the difference between a metronome and a beat.
//
//   2. Swing. Offbeats land slightly late (~58% of the way through the beat
//      rather than 50%) for a relaxed feel. Too much = lurching; we use a
//      light 53% — felt, not heard as obviously triplet-y.
//
//   3. Ghost notes. Quiet 16th-note hits *between* the main beats give the
//      groove forward momentum without competing for attention. We only
//      schedule ghosts when the field is sparse (≤3 bassteroids) — when many
//      bassteroids are firing, the field already provides momentum.
//
// The Groove.shapeHit function takes (beatPositionInMeasure, fieldDensity)
// and returns { velocityMul, delaySec, addGhost } that the caller applies.
// All math is in BEAT_GRID units (0.5s), so this module is engine-agnostic.

export interface ShapedHit {
  velocityMul: number;   // 0..1 scalar to multiply into the base velocity
  delaySec: number;      // microtiming offset to add to the schedule time
  addGhost: boolean;     // whether to schedule a quiet 16th ghost note after
  ghostDelaySec: number; // when to play the ghost (relative to the main hit)
  ghostVelocityMul: number; // ghost note loudness
}

const BEAT_GRID = 0.5; // seconds — duplicate of Game.BEAT_GRID; kept local to
                       // make this module standalone, but must stay in sync.

// Swing amount: 0.5 = straight 8ths, 0.58 = noticeable swing.
// 0.53 is a light "shuffle" feel that musicians describe as "in the pocket".
const SWING = 0.53;

// Accent ramp by beat-in-measure (0 = downbeat). With BASS_MEASURE_LENGTH = 2s
// and BEAT_GRID = 0.5s, a measure = 4 beats: beats 0, 1, 2, 3.
const ACCENT_BY_BEAT = [1.0, 0.78, 0.92, 0.72];
//                       1    2     3     4
// Beat 1 = full; beat 2 = soft backbeat; beat 3 = medium accent (re-anchor);
// beat 4 = softest, leaves room for the bar to "exhale" before the next 1.

// Per-quarter ghost-note schedule: which beats should be followed by a quiet
// 16th between them and the next beat. Picked to sound like a brushed-snare
// shuffle: ghosts after beats 1 and 3 (lead in to beats 2 and 4).
const GHOST_AFTER_BEAT = [true, false, true, false];

// Cap on how dense the field can be before we suppress ghost notes — past 3
// active bassteroids, the rhythm is already busy and ghosts become clutter.
const GHOST_DENSITY_THRESHOLD = 3;

// Public shaping API. `beatPositionInMeasure` is the integer beat slot
// (0..3 in a 4-beat measure). `fieldDensity` = how many bassteroid pieces
// are currently active in the field — used to gate ghost notes.
export function shapeHit(beatPositionInMeasure: number, fieldDensity: number): ShapedHit {
  const beat = ((beatPositionInMeasure % 4) + 4) % 4;
  const isOffbeat = beat === 1 || beat === 3;

  // Apply swing: only offbeats get pushed. Push amount = how far past the
  // straight 50% line they land. Multiplied by BEAT_GRID/2 because the
  // "beat slot" we're inside spans half a BEAT_GRID before the next downbeat.
  const swingDelay = isOffbeat ? (SWING - 0.5) * BEAT_GRID : 0;

  const accent = ACCENT_BY_BEAT[beat] ?? 1;
  const addGhost = GHOST_AFTER_BEAT[beat] && fieldDensity <= GHOST_DENSITY_THRESHOLD;

  return {
    velocityMul: accent,
    delaySec: swingDelay,
    // Ghost lands a 16th-note (= BEAT_GRID/2) after the parent hit.
    ghostDelaySec: BEAT_GRID / 2,
    addGhost,
    ghostVelocityMul: 0.22, // quiet — "ghost" in the literal sense
  };
}

// Per-wave intensity shaper. The Game scales bgBeatIntensity 0..1 across the
// 30-wave run; we can layer additional groove shifts on top. Returns a
// scale factor to apply to the ghost density threshold so the groove
// *thickens* into late waves (more ghosts allowed when the rhythm is
// supposed to feel relentless).
export function ghostThresholdForIntensity(intensity: number): number {
  // 0 → threshold 3 (default), 1.0 → threshold 6 (allow lots of ghosts).
  return GHOST_DENSITY_THRESHOLD + Math.round(intensity * 3);
}
