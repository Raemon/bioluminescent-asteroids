import type { Game } from "../Game";
import { syncHud } from "./hud";
import { checkBonusLife } from "./bonusLife";
import type { SummarySchedule } from "./waveSummary";

// The sim-clock half of the end-of-wave summary. The summary panel's visuals
//   and audio stay cosmetic (DOM timers + beat cues), but the score drain, its
//   bonus-life checks, and the deferred next-wave spawn live here so they
//   advance on game.beatTime — a deterministic sum of recorded musicDt (beat
//   resnaps included), so they reproduce frame-for-frame in a replay.
//
// Both halves consume the same SummarySchedule built in advanceWave, so the
//   payout can't drift from the panel numbers or the drain melody.

export type WaveTransition = {
  chunks: number[];      // per-tick score payouts (schedule.chunks)
  chunkBeats: number[];  // absolute beatTime of each payout
  chunksPaid: number;    // how many drain ticks have landed
  spawnAtBeat: number;   // when the next wave spawns
  spawned: boolean;      // spawn fired (guards the one-shot)
  spawn: () => void;     // advances game.wave + spawnWave (see advanceWave)
};

export const beginWaveTransition = (game: Game, schedule: SummarySchedule, spawn: () => void): void => {
  game.waveTransition = {
    chunks: schedule.chunks,
    chunkBeats: schedule.drainTickBeats,
    chunksPaid: 0,
    spawnAtBeat: schedule.spawnBeat,
    spawned: false,
    spawn,
  };
};

// Advance the in-flight transition against the just-ticked beat clock. Pays
//   every chunk whose slot has passed (a long frame, or a replay stepping
//   several recorded frames in a burst, can clear more than one at once —
//   same total payout, same end state) and fires the spawn once its slot
//   arrives. A backward beatTime hard-snap merely stalls the payout until the
//   clock recovers — chunksPaid is monotonic, so nothing pays twice.
export const tickWaveTransition = (game: Game): void => {
  const t = game.waveTransition;
  if (!t) return;

  while (t.chunksPaid < t.chunks.length) {
    if (game.beatTime < t.chunkBeats[t.chunksPaid]) break;
    game.score += t.chunks[t.chunksPaid];
    t.chunksPaid += 1;
    syncHud(game);
    checkBonusLife(game);
  }

  if (!t.spawned && game.beatTime >= t.spawnAtBeat) {
    t.spawned = true;
    t.spawn();
    game.waveTransition = null;
  }
};
