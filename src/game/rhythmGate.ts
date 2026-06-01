import type { Game } from "../Game";
import { Vec } from "../vec";
import { BEAT_GRID, BEAT_WINDOW, DEBUG_BEAT_TIMING } from "./rhythmConstants";
import { syncComboHud } from "./hud";
import { popupBeatDebug, popupComboLost } from "./popups";

// Two grid tiers, measured as the period between on-beat slots:
//   combo 0–11       → quarter-notes (BEAT_GRID): the default groove.
//   combo ≥ 12, or   → eighth-notes (BEAT_GRID/2): rapid-fire pulls each land on a beat;
//   rapid powerup     at the sparkle tier the in-between bg-beat is audible (see
//                     bassClock.ts), so the player can hear and play the eighths too.
export const comboGrid = (game: Game): number => {
  if (game.ship.rapidActive || game.beatCombo >= 12) return BEAT_GRID / 2;
  return BEAT_GRID;
};

// pure predicate — classifies fire / hit as on-beat without side effects on combo state.
export const isInBeatWindow = (game: Game, time: number): boolean => {
  const grid = comboGrid(game);
  const beatIndex = Math.round(time / grid);
  const beatCenter = beatIndex * grid;
  return Math.abs(time - beatCenter) <= BEAT_WINDOW;
};

// debug logging needs the signed offset even when the event sits outside the on-beat window.
export const beatOffsetFor = (game: Game, time: number): number => {
  const grid = comboGrid(game);
  const beatIndex = Math.round(time / grid);
  return time - beatIndex * grid;
};

// 0 → snap to 1 at the beat → squared release. No ramp-up — the onset is the visual hit.
const beatPulseEnvelope = (normalized: number): number => {
  if (normalized < 0 || normalized > 1) return 0;
  return (1 - normalized) * (1 - normalized);
};

// ship's visual pulse is a literal preview of the rhythm window so the player can time shots.
//   Reads perceivedBeatTime so the pulse peaks on the beat the player *hears* (latency-shifted),
//   matching the judged window rather than the raw audio grid.
export const currentBeatPulse = (game: Game): number => {
  if (game.state !== "playing" && game.state !== "dying") return 0;
  const grid = comboGrid(game);
  const beatPhase = game.perceivedBeatTime / grid;
  const signedBeatsFromNearestBeat = beatPhase - Math.round(beatPhase);
  const windowFractionOfGrid = BEAT_WINDOW / grid;
  return beatPulseEnvelope(signedBeatsFromNearestBeat / windowFractionOfGrid);
};

// dev-only timing log, gated on DEBUG_BEAT_TIMING so it costs nothing in production.
export const logBeatEvent = (game: Game, kind: string, time: number, extra?: string) => {
  if (!DEBUG_BEAT_TIMING) return;
  const offset = beatOffsetFor(game, time);
  const offsetMs = (offset * 1000).toFixed(1);
  const within = isInBeatWindow(game, time) ? "ON" : "OFF";
  const beatTimeStr = time.toFixed(4);
  console.log(kind.toLowerCase(), within);
  console.log(beatTimeStr, offsetMs, extra ?? "");
};

// wraps the DEBUG_BEAT_TIMING gate so callers don't thread it through every fire/hit site.
export const spawnBeatDebugPopup = (game: Game, pos: Vec, time: number, prefix: string) => {
  if (!DEBUG_BEAT_TIMING) return;
  const onBeat = isInBeatWindow(game, time);
  const offsetMs = (beatOffsetFor(game, time) * 1000).toFixed(0);
  game.popups.push(popupBeatDebug(pos, prefix, onBeat, offsetMs));
};

// only meaningful losses (combo ≥2 → 0) fire wrrr + red halo; primed-only loss is too noisy.
//   sourcePos anchors the popup at whatever caused the break (ship fire / target hit).
export const loseCombo = (game: Game, sourcePos?: Vec) => {
  if (game.beatCombo === 0) return;
  const prev = game.beatCombo;
  const wasMeaningful = prev >= 2;
  const haloActive = game.ship.comboHaloTier >= 2;
  game.beatCombo = 0;
  if (wasMeaningful) {
    game.sound.play("comboLost");
    game.ship.comboLossFlash = 1;
    if (sourcePos && (!game.hasLostComboEver || haloActive)) {
      game.popups.push(popupComboLost(sourcePos));
    }
    game.hasLostComboEver = true;
  }
  // grid may have just widened (eighths→quarters from sparkle dropping); resync
  // nextBeatToEvaluate against the wider grid so the next closure lands cleanly.
  if (!game.ship.rapidActive) rebaseBeatEval(game);
  syncComboHud(game);
  // build-to-4x diamond row mirrors live rhythm; an off-beat fire wipes both.
  //   Dispatched inline (no lifecycle.ts import) to avoid the cycle between
  //   rhythmGate.ts and lifecycle.ts.
  if (game.firstWaveHintStage === 5) {
    window.dispatchEvent(new CustomEvent("first-wave-hint:rhythmProgress", { detail: { count: 0 } }));
  }
};

// silence holds combo; only an off-beat fire latched during the closing beat drops it to 0.
//   ship pos is the source for off-beat fires — that's the shot the player got wrong.
export const evaluateClosedBeats = (game: Game) => {
  const grid = comboGrid(game);
  while (game.nextBeatToEvaluate * grid + BEAT_WINDOW <= game.perceivedBeatTime) {
    if (game.firedOffBeatSinceLastBeat && game.beatCombo !== 0) loseCombo(game, game.ship.pos);
    game.firedOffBeatSinceLastBeat = false;
    game.nextBeatToEvaluate += 1;
  }
};

// call after any state change that flips comboGrid (rapid powerup, combo crossing 12, combo
// loss) so the evaluator index keeps marching forward against the new grid instead of either
// stalling (grid grew) or firing a burst of phantom closures (grid shrank).
export const rebaseBeatEval = (game: Game) => {
  game.nextBeatToEvaluate = Math.max(0, Math.floor((game.perceivedBeatTime - BEAT_WINDOW) / comboGrid(game)) + 1);
};
