import type { Game } from "../Game";
import { KilledSnapshot } from "./killSnapshot";
import { BEAT_GRID } from "./rhythmConstants";

// Why: high enough scroll speed that sprites move visibly between beats — reads as marching past.
const PARADE_PX_PER_BEAT = 140;

// Why: canvas height grows to fit the tallest snap (+padding) so a boss-large with its
//   additive glow halo isn't clipped at the top/bottom of the row.
const PARADE_MIN_H = 220;
const PARADE_VPAD = 24;
const PARADE_MIN_W = 320;
// Why: bgBeat fires on every whole BEAT_GRID tick (alternating downbeat/offbeat pitch), so
//   snapping offsets to integer beats guarantees the kill-sound trigger lands on a bg beat.
const PARADE_BEAT_SUBDIV = 1.0;

// Why: `played` latches true so each kill sound replays once when its sprite crosses centre.
export type ParadeEntry = {
  snap: KilledSnapshot;
  beatOffset: number;
  played: boolean;
};

// Why: maxHp/4 spacing = on-rhythm shots needed — paces the parade by kill difficulty.
export const renderKilledRow = (game: Game) => {
  stopParade(game);
  if (game.killedSnapshots.length === 0) {
    game.killedRowEl.classList.add("hidden");
    return;
  }
  layOutParade(game);
  configureParadeCanvas(game);
  startParadeLoop(game);
};

// Why: clamp at 0.5 (one eighth-note grid step) so spacing always lands on the bg beat lattice.
//   maxHp/4 is then rounded up to the same grid so big kills still feel slower without drifting.
const layOutParade = (game: Game) => {
  const entries: ParadeEntry[] = [];
  let cursor = 0;
  for (const snap of game.killedSnapshots) {
    entries.push({ snap, beatOffset: cursor, played: false });
    const raw = Math.max(PARADE_BEAT_SUBDIV, snap.maxHp / 4);
    const snapped = Math.ceil(raw / PARADE_BEAT_SUBDIV) * PARADE_BEAT_SUBDIV;
    cursor += snapped;
  }
  game.paradeEntries = entries;
  game.paradeTotalBeats = cursor;
};

// Why: DPR-aware backing store needed so the parade looks crisp at high-density display ratios.
// Why: height is sized to the tallest captured snap (which already includes its glow margin)
//   plus a small vpad — fixed-360 used to crop the boss-large halo.
const configureParadeCanvas = (game: Game) => {
  const canvas = game.killedRowEl;
  const cssW = Math.max(PARADE_MIN_W, window.innerWidth);
  let tallest = 0;
  for (const e of game.paradeEntries) tallest = Math.max(tallest, e.snap.full.height);
  const cssH = Math.max(PARADE_MIN_H, tallest + PARADE_VPAD * 2);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  game.paradeCanvasW = cssW;
  game.paradeCanvasH = cssH;
  canvas.classList.remove("hidden");
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

// Why: rAF id held so stopParade can cancel cleanly on restart / abort.
// Why: anchor parade time to game.beatTime (snapped to BEAT_GRID) so the eighth-note kill-sound
//   triggers land exactly on the bg bass beat that keeps ticking during gameover.
const startParadeLoop = (game: Game) => {
  const ctx = game.killedRowEl.getContext("2d");
  if (!ctx) return;
  game.paradeActive = true;
  game.paradeStartBeatTime = Math.ceil(game.beatTime / BEAT_GRID) * BEAT_GRID;
  const step = () => {
    if (!game.paradeActive) return;
    tickParade(game, ctx);
    game.paradeRafId = requestAnimationFrame(step);
  };
  game.paradeRafId = requestAnimationFrame(step);
};

// Why: hard reset on every state transition — never want two parades running together.
export const stopParade = (game: Game) => {
  if (game.paradeRafId !== null) {
    cancelAnimationFrame(game.paradeRafId);
    game.paradeRafId = null;
  }
  game.paradeActive = false;
  game.paradeEntries = [];
  game.paradeTotalBeats = 0;
};

// Why: per-frame composition splits cleanly into "where are we", "draw", "should we stop?".
const tickParade = (game: Game, ctx: CanvasRenderingContext2D) => {
  const cssW = game.paradeCanvasW;
  const cssH = game.paradeCanvasH;
  ctx.clearRect(0, 0, cssW, cssH);
  const t = currentParadeBeat(game, cssW);
  drawParadeSprites(game, ctx, t, cssW, cssH);
  maybeEndParade(game, t, cssW);
};

// Why: pre-roll itself is snapped to BEAT_GRID so the first sprite still reaches centre on a beat
//   even though the canvas-width-derived pre-roll would otherwise land on a fractional beat.
const currentParadeBeat = (game: Game, cssW: number): number => {
  const elapsedBeats = (game.beatTime - game.paradeStartBeatTime) / BEAT_GRID;
  const rawPreRoll = cssW / (2 * PARADE_PX_PER_BEAT);
  const preRollBeats = Math.ceil(rawPreRoll / PARADE_BEAT_SUBDIV) * PARADE_BEAT_SUBDIV;
  return elapsedBeats - preRollBeats;
};

// Why: cull offscreen sprites before drawImage; trigger kill sound when sprite crosses centre.
const drawParadeSprites = (game: Game, ctx: CanvasRenderingContext2D, t: number, cssW: number, cssH: number) => {
  const centreX = cssW / 2;
  const centreY = cssH / 2;
  for (const e of game.paradeEntries) {
    const x = centreX + (e.beatOffset - t) * PARADE_PX_PER_BEAT;
    const halfW = e.snap.full.width / 2;
    if (!e.played && x <= centreX) {
      e.played = true;
      game.sound.play(e.snap.killSound);
    }
    if (x - halfW > cssW || x + halfW < 0) continue;
    ctx.drawImage(e.snap.full, x - halfW, centreY - e.snap.full.height / 2);
  }
};

// Why: stop the rAF once the last sprite is offscreen — no point burning frames on blank.
const maybeEndParade = (game: Game, t: number, cssW: number) => {
  const last = game.paradeEntries[game.paradeEntries.length - 1];
  if (!last) return;
  const lastX = cssW / 2 + (last.beatOffset - t) * PARADE_PX_PER_BEAT;
  if (lastX + last.snap.full.width / 2 < 0) game.paradeActive = false;
};
