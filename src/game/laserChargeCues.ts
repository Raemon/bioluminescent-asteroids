import type { Game } from "../Game";
import type { Ship } from "../Ship";
import { BEAT_GRID, PULSE_LOOKAHEAD } from "./rhythmConstants";

// Audio-only lookahead scheduler for the per-dot laser-charge accents. Mirrors
// beatCues.ts but dispatches the two bespoke laser-charge methods (which aren't
// play()-routable SoundNames) at an absolute audio-clock start time, so each dot
// accent lands sample-accurately on its beat-grid slot instead of a frame late.
//
// Module-local (not a Game field): there's at most one active charge hold, and
// this touches no sim/checkpointed state, so it's replay/headless-safe and never
// serialized — the same invariant beatCues documents.

type LaserChargeCue = { at: number; dots: number };

let cues: LaserChargeCue[] = [];
// Highest dot index handed to the scheduler for the current hold. Advancing a
//   cursor (rather than re-deriving from beatTime) means a mid-hold cap bump that
//   exposes an earlier dot still schedules every dot exactly once, in order.
let scheduledThrough = 0;

// Grid-snapped absolute beatTime of the nth charge dot (n >= 1). Snapping the
// hold's start onto the beat grid keeps a slightly-off charge start from drifting
// the whole accent sequence off the music.
const dotSlot = (ship: Ship, n: number): number =>
  Math.round(ship.laserChargeStartBeatTime / BEAT_GRID) * BEAT_GRID + n * BEAT_GRID;

// Called each frame of an active hold. Enqueues any dot from the cursor up to the
// current (possibly just-grown) cap, so the poll's "next dot" and a combo-driven
// cap bump both schedule cleanly. Future slots fire on the beat via the tick
// below; an already-passed slot (only when a cap bump exposes it late) fires as
// soon as the tick sees it.
export const scheduleLaserDots = (ship: Ship, maxDots: number) => {
  while (scheduledThrough < maxDots) {
    scheduledThrough += 1;
    cues.push({ at: dotSlot(ship, scheduledThrough), dots: scheduledThrough });
  }
};

export const cancelLaserChargeCues = () => {
  cues = [];
  scheduledThrough = 0;
};

export const tickLaserChargeCues = (game: Game, playbackRate = 1) => {
  if (cues.length === 0) return;
  const horizon = game.beatTime + PULSE_LOOKAHEAD * playbackRate;
  const kept: LaserChargeCue[] = [];
  for (const cue of cues) {
    if (cue.at > horizon) { kept.push(cue); continue; }
    // Due now (or a passed slot a cap bump exposed late): dispatch. Scheduled
    //   ahead of its slot, audioTimeForBeatDelta lands it on the beat; already
    //   past, playAt clamps to now so a late-exposed dot still sounds once.
    const when = game.sound.audioTimeForBeatDelta(cue.at - game.beatTime, playbackRate);
    if (when !== null) {
      game.sound.playLaserChargeAt(cue.dots, when);
      game.sound.setLaserChargeTierAt(cue.dots, when);
    } else {
      // Audio clock not running (pre-unlock, headless): fire immediately.
      game.sound.playLaserCharge(cue.dots);
      game.sound.setLaserChargeTier(cue.dots);
    }
  }
  cues = kept;
};
