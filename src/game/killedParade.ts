import type { Game } from "../Game";
import { KilledSnapshot } from "./killSnapshot";
import { BEAT_GRID } from "./rhythmConstants";

// Why: high enough scroll speed that sprites move visibly between beats — reads as marching past.
const PARADE_PX_PER_BEAT = 140;

// Why: tall enough to fit a boss-large (160 radius → 320px diameter) plus padding.
const PARADE_CANVAS_H = 360;
const PARADE_MIN_W = 320;

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

// Why: clamp at 0.25 so even 1-HP kills get a quarter-beat of breathing room (else they'd stack).
const layOutParade = (game: Game) => {
  const entries: ParadeEntry[] = [];
  let cursor = 0;
  for (const snap of game.killedSnapshots) {
    entries.push({ snap, beatOffset: cursor, played: false });
    cursor += Math.max(0.25, snap.maxHp / 4);
  }
  game.paradeEntries = entries;
  game.paradeTotalBeats = cursor;
};

// Why: DPR-aware backing store needed so the parade looks crisp at high-density display ratios.
const configureParadeCanvas = (game: Game) => {
  const canvas = game.killedRowEl;
  const cssW = Math.max(PARADE_MIN_W, window.innerWidth);
  const cssH = PARADE_CANVAS_H;
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
const startParadeLoop = (game: Game) => {
  const ctx = game.killedRowEl.getContext("2d");
  if (!ctx) return;
  game.paradeActive = true;
  game.paradeStartTime = performance.now();
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

// Why: subtract pre-roll so beatOffset=0 means "sprite at centre", not "sprite at right edge".
const currentParadeBeat = (game: Game, cssW: number): number => {
  const elapsedSec = (performance.now() - game.paradeStartTime) / 1000;
  const elapsedBeats = elapsedSec / BEAT_GRID;
  const preRollBeats = cssW / (2 * PARADE_PX_PER_BEAT);
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
