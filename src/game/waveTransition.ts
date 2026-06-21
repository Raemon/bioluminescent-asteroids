import type { Game } from "../Game";
import { syncHud } from "./hud";
import { checkBonusLife } from "./bonusLife";
import {
  WAVE_SUMMARY_BEAT_MS,
  WAVE_SUMMARY_TICK_MS,
  WAVE_SUMMARY_FIRST_ROW_DELAY_MS,
  WAVE_SUMMARY_PAUSE_BEFORE_DRAIN_MS,
  WAVE_SUMMARY_HOLD_BEFORE_FADE_MS,
  WAVE_SUMMARY_FADE_OUT_MS,
  WAVE_SUMMARY_ROW_COUNT,
  planDrainChunks,
} from "./waveSummary";

// The sim-clock half of the end-of-wave summary. The summary panel's visuals and
//   audio stay on setTimeout (cosmetic), but the score drain, its bonus-life
//   checks, and the deferred next-wave spawn live here so they advance on the
//   recorded dt — making them reproduce frame-for-frame in a replay instead of
//   firing at wall-clock moments the re-sim never lands on.
//
// The schedule mirrors showWaveSummary's setTimeout timeline exactly, just
//   measured in sim seconds instead of wall-clock ms: rows reveal over
//   FIRST_ROW + ROW_COUNT beats, a pause, then the drain pays one chunk per
//   TICK, then a hold + fade before the spawn fires.

export type WaveTransition = {
  elapsed: number;            // sim seconds since the transition began
  chunks: number[];           // per-tick score payouts (planDrainChunks)
  chunksPaid: number;         // how many drain ticks have landed
  drainStartSec: number;      // when the first chunk pays
  spawnAtSec: number;         // when the next wave spawns
  spawned: boolean;           // spawn fired (guards the one-shot)
  spawn: () => void;          // advances game.wave + spawnWave (see advanceWave)
};

const MS = 1 / 1000;

// Build the sim-clock schedule for one transition. `bonus` is the total to drain
//   into the score; `spawn` is the deferred next-wave action. Mirrors the ms
//   offsets showWaveSummary derives, converted to seconds.
export const beginWaveTransition = (game: Game, bonus: number, spawn: () => void): void => {
  const chunks = bonus > 0 ? planDrainChunks(bonus) : [];
  const drainStartMs =
    WAVE_SUMMARY_FIRST_ROW_DELAY_MS +
    WAVE_SUMMARY_ROW_COUNT * WAVE_SUMMARY_BEAT_MS +
    WAVE_SUMMARY_PAUSE_BEFORE_DRAIN_MS;
  // Drain runs chunks.length ticks; the fade-out (and spawn) schedule begins once
  //   the last chunk lands, then holds + fades exactly as scheduleFadeOut does.
  const drainEndMs = drainStartMs + chunks.length * WAVE_SUMMARY_TICK_MS;
  const spawnAtMs = drainEndMs + WAVE_SUMMARY_HOLD_BEFORE_FADE_MS + WAVE_SUMMARY_FADE_OUT_MS;
  game.waveTransition = {
    elapsed: 0,
    chunks,
    chunksPaid: 0,
    drainStartSec: drainStartMs * MS,
    spawnAtSec: spawnAtMs * MS,
    spawned: false,
    spawn,
  };
};

// Advance the in-flight transition by one sim frame. Pays any drain chunks whose
//   scheduled time has passed (each crediting score + checking for a bonus life)
//   and fires the spawn once its time arrives. Clears game.waveTransition when
//   the spawn has fired — the transition is done.
export const tickWaveTransition = (game: Game, dt: number): void => {
  const t = game.waveTransition;
  if (!t) return;
  t.elapsed += dt;

  // Pay every chunk whose tick boundary the clock has crossed this frame (a long
  //   frame, or a replay stepping several recorded frames in a burst, can clear
  //   more than one at once — same total payout, same end state).
  while (t.chunksPaid < t.chunks.length) {
    const chunkTime = t.drainStartSec + t.chunksPaid * (WAVE_SUMMARY_TICK_MS * MS);
    if (t.elapsed < chunkTime) break;
    game.score += t.chunks[t.chunksPaid];
    t.chunksPaid += 1;
    syncHud(game);
    checkBonusLife(game);
  }

  if (!t.spawned && t.elapsed >= t.spawnAtSec) {
    t.spawned = true;
    t.spawn();
    game.waveTransition = null;
  }
};
