import type { Game } from "../Game";
import { TAU, toroidalDelta, cosmeticRand } from "../vec";
import { computeConeFrame, targetIsInsideCone } from "../ship/reticule/coneGeometry";

// Inky blackout unleashed by a shattered black-diamond prison. Spreads from
// the death site to a viewport-covering radius over ~10s and persists as long
// as any wraith is alive anywhere; once the last one dies, every patch
// "unrolls" — the radius eases back down to 0 rather than fading in place, so
// it reads as the ink physically receding, not a uniform dissolve.
//
// The dark fill is a single opaque circle per patch (cheap: one arc + one
// fill), but the player's own radar cone punches temporary holes in it,
// revealing what's underneath at low saturation with a short fading
// afterglow. That reveal state (which patches of ink are currently "open")
// lives in ONE shared sparse grid across all patches — not one grid per
// patch — so overlapping patches (multiple prisons popped) never
// double-darken at a seam and share a single reveal timeline.

const INK_GROW_SECONDS = 10;
const INK_DISSIPATE_SECONDS = 5.5;
const INK_CELL_SIZE = 28;
const INK_AFTERGLOW_SECONDS = 1.5;
const INK_REGROW_SECONDS = 0.5;
const INK_TARGET_RADIUS_MIN = 1800;
const INK_TARGET_RADIUS_MAX = 2200;
const INK_FILL_ALPHA = 0.995;

export type InkPatch = {
  cx: number;
  cy: number;
  radius: number;
  targetRadius: number;
  bornAt: number; // game.time (ms) at spawn
  dissipating: boolean;
  dissipateStartedAt: number | null; // game.time (ms)
};

type InkCell = {
  ink: number; // 0 (fully revealed) .. 1 (fully opaque)
  lastRevealedAt: number; // game.time (ms) this cell was last under the radar cone
};

// Shared across every patch — keyed by world-space cell coordinates so two
// overlapping patches read/write the same cell instead of stacking alpha.
const cells = new Map<string, InkCell>();
const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t: number): number => t * t * t;

export const spawnInkPatch = (game: Game, pos: { x: number; y: number }) => {
  game.inkPatches.push({
    cx: pos.x,
    cy: pos.y,
    radius: 0,
    targetRadius: cosmeticRand(INK_TARGET_RADIUS_MIN, INK_TARGET_RADIUS_MAX),
    bornAt: game.time,
    dissipating: false,
    dissipateStartedAt: null,
  });
};

export const updateInkClouds = (game: Game, dt: number) => {
  if (game.inkPatches.length === 0) return;

  const anyWraithAlive = game.asteroids.some((a) => a.kind === "wraith");
  const nowMs = game.time;

  for (const p of game.inkPatches) {
    if (!anyWraithAlive && !p.dissipating) {
      p.dissipating = true;
      p.dissipateStartedAt = nowMs;
    }
    if (p.dissipating && p.dissipateStartedAt !== null) {
      const t = Math.min(1, (nowMs - p.dissipateStartedAt) / (INK_DISSIPATE_SECONDS * 1000));
      p.radius = p.targetRadius * (1 - easeInCubic(t));
    } else {
      const t = Math.min(1, (nowMs - p.bornAt) / (INK_GROW_SECONDS * 1000));
      p.radius = p.targetRadius * easeOutCubic(t);
    }
  }
  game.inkPatches = game.inkPatches.filter((p) => !(p.dissipating && p.radius <= 1));

  // Cone-carve: mark every cell under the ship's current radar cone (within
  // any live patch's bounds) as freshly revealed.
  if (game.inkPatches.length > 0) {
    const frame = computeConeFrame(game.ship);
    for (const p of game.inkPatches) {
      const reach = p.radius + frame.length;
      const [pdx, pdy] = toroidalDelta(p.cx - game.ship.pos.x, p.cy - game.ship.pos.y, game.w, game.h);
      if (Math.hypot(pdx, pdy) > reach) continue;
      const half = INK_CELL_SIZE / 2;
      const minCx = Math.floor((p.cx - p.radius) / INK_CELL_SIZE);
      const maxCx = Math.floor((p.cx + p.radius) / INK_CELL_SIZE);
      const minCy = Math.floor((p.cy - p.radius) / INK_CELL_SIZE);
      const maxCy = Math.floor((p.cy + p.radius) / INK_CELL_SIZE);
      for (let gx = minCx; gx <= maxCx; gx++) {
        for (let gy = minCy; gy <= maxCy; gy++) {
          const wx = gx * INK_CELL_SIZE + half;
          const wy = gy * INK_CELL_SIZE + half;
          const [dx, dy] = toroidalDelta(wx - game.ship.pos.x, wy - game.ship.pos.y, game.w, game.h);
          if (!targetIsInsideCone(dx, dy, half, frame)) continue;
          const key = cellKey(gx, gy);
          const cell = cells.get(key) ?? { ink: 1, lastRevealedAt: -Infinity };
          cell.lastRevealedAt = nowMs;
          cells.set(key, cell);
        }
      }
    }
  }

  // Decay/regrow every touched cell once. Cells nobody has swept in a long
  // while are dropped so the map doesn't grow unbounded across a long run.
  for (const [key, cell] of cells) {
    const sinceRevealedSec = (nowMs - cell.lastRevealedAt) / 1000;
    if (sinceRevealedSec < INK_AFTERGLOW_SECONDS) {
      const openness = 1 - sinceRevealedSec / INK_AFTERGLOW_SECONDS; // 1 → 0
      cell.ink = Math.min(cell.ink, 1 - openness);
    } else if (cell.ink < 1) {
      cell.ink = Math.min(1, cell.ink + dt / INK_REGROW_SECONDS);
    } else {
      cells.delete(key);
    }
  }
};

// True if a world point currently sits under any live ink patch (used to dim
// the ship's own render when it's inside the blackout).
export const isPointInAnyInkPatch = (game: Game, pos: { x: number; y: number }): boolean => {
  for (const p of game.inkPatches) {
    const [dx, dy] = toroidalDelta(pos.x - p.cx, pos.y - p.cy, game.w, game.h);
    if (Math.hypot(dx, dy) <= p.radius) return true;
  }
  return false;
};

// Batches revealed cells within a patch into a small number of quantized-
// alpha groups so the destination-out punch is a handful of fill() calls,
// not one per cell.
const ALPHA_BUCKETS = 5;
const collectRevealedCellsInPatch = (
  game: Game, p: InkPatch,
): Array<{ alpha: number; rects: Array<{ x: number; y: number }> }> => {
  const buckets: Array<{ alpha: number; rects: Array<{ x: number; y: number }> }> = [];
  const minCx = Math.floor((p.cx - p.radius) / INK_CELL_SIZE);
  const maxCx = Math.floor((p.cx + p.radius) / INK_CELL_SIZE);
  const minCy = Math.floor((p.cy - p.radius) / INK_CELL_SIZE);
  const maxCy = Math.floor((p.cy + p.radius) / INK_CELL_SIZE);
  const rSq = p.radius * p.radius;
  for (let gx = minCx; gx <= maxCx; gx++) {
    for (let gy = minCy; gy <= maxCy; gy++) {
      const cell = cells.get(cellKey(gx, gy));
      if (!cell || cell.ink >= 1) continue;
      const wx = gx * INK_CELL_SIZE;
      const wy = gy * INK_CELL_SIZE;
      const [dx, dy] = toroidalDelta(wx - p.cx, wy - p.cy, game.w, game.h);
      if (dx * dx + dy * dy > rSq) continue;
      const openAlpha = 1 - cell.ink; // how much to punch out
      const bucketIdx = Math.min(ALPHA_BUCKETS - 1, Math.floor(openAlpha * ALPHA_BUCKETS));
      const bucketAlpha = (bucketIdx + 1) / ALPHA_BUCKETS;
      let bucket = buckets.find((b) => b.alpha === bucketAlpha);
      if (!bucket) { bucket = { alpha: bucketAlpha, rects: [] }; buckets.push(bucket); }
      bucket.rects.push({ x: wx, y: wy });
    }
  }
  return buckets;
};

export const paintInkClouds = (ctx: CanvasRenderingContext2D, game: Game) => {
  if (game.inkPatches.length === 0) return;
  ctx.save();
  for (const p of game.inkPatches) {
    if (p.radius < 1) continue;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgba(2, 3, 6, ${INK_FILL_ALPHA})`;
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, p.radius, 0, TAU);
    ctx.fill();

    const buckets = collectRevealedCellsInPatch(game, p);
    if (buckets.length === 0) continue;
    ctx.globalCompositeOperation = "destination-out";
    for (const bucket of buckets) {
      ctx.fillStyle = `rgba(0, 0, 0, ${bucket.alpha})`;
      ctx.beginPath();
      for (const r of bucket.rects) ctx.rect(r.x, r.y, INK_CELL_SIZE, INK_CELL_SIZE);
      ctx.fill();
    }
    // Desaturation wash over the same punched cells — a flat mid-gray at
    // partial opacity, plain source-over. Deliberately NOT a "saturation" or
    // "color" globalCompositeOperation: those are non-separable blend modes
    // that read every backdrop pixel's full luminosity/saturation, a heavier
    // per-pixel path in several engines — exactly the class of full-canvas
    // pixel cost this codebase avoids (see the ctx.filter=brightness note in
    // gameRender.ts). A flat wash is cheap, portable, and reads as a dim,
    // sonar-lit glimpse rather than true color.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "hsla(220, 8%, 42%, 0.6)";
    ctx.beginPath();
    for (const bucket of buckets) for (const r of bucket.rects) ctx.rect(r.x, r.y, INK_CELL_SIZE, INK_CELL_SIZE);
    ctx.fill();
  }
  ctx.restore();
};
