import type { Game } from "../Game";
import { TAU, toroidalDelta, cosmeticRand } from "../vec";
import { computeConeFrame, targetIsInsideCone } from "../ship/reticule/coneGeometry";

// Inky blackout unleashed by a shattered black-diamond prison. Spreads from
// the death site to a viewport-covering radius over ~10s and persists as long
// as any wraith is alive anywhere; once the last one dies, every patch
// "unrolls" — the radius eases back down to 0 rather than fading in place, so
// it reads as the ink physically receding, not a uniform dissolve.
//
// The dark fill is rendered as a per-cell alpha field: one pixel per ink cell
// painted into a small offscreen canvas, then drawImage-upscaled with bilinear
// smoothing so the cloud reads as soft smoke, not a grid. Crucially the ink is
// plain source-over — it must NEVER punch (destination-out) the frame, because
// the scene under it (starfield, asteroids, wraiths) is already composited
// into the same canvas; a punch would erase all of it and leave blank glass.
// The player's radar cone instead *thins* the ink per cell, so the field
// underneath shows through clearly — at full brightness, just drained of
// colour. Only cells under the cone RIGHT NOW are open: the moment the cone
// moves off a cell it snaps back to opaque (a ~0.2s ramp, purely so the
// trailing edge doesn't pop cell-by-cell). That reveal state (which patches of
// ink are currently "open")
// lives in ONE shared sparse grid across all patches — not one grid per
// patch — so overlapping patches (multiple prisons popped) never
// double-darken at a seam and share a single reveal timeline.

const INK_GROW_SECONDS = 10;
const INK_DISSIPATE_SECONDS = 3;
const INK_CELL_SIZE = 28;
// No afterglow: only what the radar cone touches this frame is open. The
// regrow ramp is kept just long enough that the cone's trailing edge closes
// smoothly instead of flickering cell-by-cell.
const INK_REGROW_SECONDS = 0.2;
const INK_TARGET_RADIUS_MIN = 1800;
const INK_TARGET_RADIUS_MAX = 2200;
const INK_FILL_ALPHA = 0.995;
// How much colour a fully-revealed cell loses (1 = fully greyscale). The
// revealed area carries NO dark overlay at all — the scene shows through at
// its normal brightness, only desaturated.
const INK_DESAT_STRENGTH = 0.85;

export type InkPatch = {
  cx: number;
  cy: number;
  radius: number;
  targetRadius: number;
  bornAt: number; // game.time (ms) at spawn
  dissipating: boolean;
  dissipateStartedAt: number | null; // game.time (ms)
  // Radius captured when dissipation begins — the unroll shrinks from HERE,
  // not targetRadius, so a patch killed mid-growth doesn't jump outward first.
  dissipateFromRadius: number;
  // Cosine harmonics perturbing the rim radius per angle (the house harmonic-
  // noise silhouette) — the cloud edge billows instead of being a hard circle.
  edge: Array<{ freq: number; amp: number; phase: number; drift: number }>;
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

export const spawnInkPatch = (game: Game, pos: { x: number; y: number }) => {
  game.inkPatches.push({
    cx: pos.x,
    cy: pos.y,
    radius: 0,
    targetRadius: cosmeticRand(INK_TARGET_RADIUS_MIN, INK_TARGET_RADIUS_MAX),
    bornAt: game.time,
    dissipating: false,
    dissipateStartedAt: null,
    dissipateFromRadius: 0,
    edge: Array.from({ length: 3 }, (_, i) => ({
      freq: 2 + i + Math.round(cosmeticRand(0, 2)),
      amp: cosmeticRand(0.025, 0.06),
      phase: cosmeticRand(0, TAU),
      drift: cosmeticRand(0.08, 0.22) * (cosmeticRand(0, 1) < 0.5 ? -1 : 1),
    })),
  });
};

export const updateInkClouds = (game: Game, dt: number) => {
  if (game.inkPatches.length === 0) {
    // No live patch is painting, so any leftover reveal state is invisible —
    // drop it rather than let it leak into the next prison's blackout.
    if (cells.size > 0) cells.clear();
    return;
  }

  const anyWraithAlive = game.asteroids.some((a) => a.kind === "wraith");
  const nowMs = game.time;

  for (const p of game.inkPatches) {
    if (!anyWraithAlive && !p.dissipating) {
      p.dissipating = true;
      p.dissipateStartedAt = nowMs;
      p.dissipateFromRadius = p.radius;
    }
    if (p.dissipating && p.dissipateStartedAt !== null) {
      // Ease-OUT, not ease-in: the payoff for killing the last wraith is the
      // smoke visibly receding the moment it dies, then settling smoothly.
      const t = Math.min(1, (nowMs - p.dissipateStartedAt) / (INK_DISSIPATE_SECONDS * 1000));
      p.radius = p.dissipateFromRadius * (1 - easeOutCubic(t));
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
          cell.ink = 0;
          cell.lastRevealedAt = nowMs;
          cells.set(key, cell);
        }
      }
    }
  }

  // Any cell the cone did NOT touch this frame regrows immediately; once
  // fully opaque it's dropped so the map doesn't grow unbounded.
  for (const [key, cell] of cells) {
    if (cell.lastRevealedAt === nowMs) continue;
    cell.ink = Math.min(1, cell.ink + dt / INK_REGROW_SECONDS);
    if (cell.ink >= 1) cells.delete(key);
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

// Offscreen alpha-field buffer: ONE pixel per ink cell, upscaled to world
// scale by drawImage with image smoothing on, so per-cell reveal alphas blend
// bilinearly instead of showing as hard 28px squares. One buffer per patch,
// grow-only (a patch inflates over 10s — don't realloc every frame), and the
// pixel field is built ONCE per frame: the scroll camera paints the world
// layer at up to 4 wrap offsets, so later copies in the same frame must reuse
// the field and pay only a drawImage.
// Two planes per patch: the smoke itself (source-over) and a desaturation
// mask (drawn under the "saturation" blend mode) covering the revealed cells.
type FieldBuffer = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: ImageData;
  desatCanvas: HTMLCanvasElement;
  desatCtx: CanvasRenderingContext2D;
  desatImg: ImageData;
  builtAt: number; // game.time (ms) of the last pixel-field build
  gridW: number;
  gridH: number;
  minGx: number;
  minGy: number;
};
const fieldBuffers = new WeakMap<InkPatch, FieldBuffer>();
const ensureFieldBuffer = (p: InkPatch, gridW: number, gridH: number): FieldBuffer => {
  let buf = fieldBuffers.get(p);
  if (!buf) {
    const canvas = document.createElement("canvas");
    canvas.width = gridW;
    canvas.height = gridH;
    const bctx = canvas.getContext("2d")!;
    const desatCanvas = document.createElement("canvas");
    desatCanvas.width = gridW;
    desatCanvas.height = gridH;
    const dctx = desatCanvas.getContext("2d")!;
    buf = {
      canvas, ctx: bctx, img: bctx.createImageData(gridW, gridH),
      desatCanvas, desatCtx: dctx, desatImg: dctx.createImageData(gridW, gridH),
      builtAt: -1, gridW, gridH, minGx: 0, minGy: 0,
    };
    fieldBuffers.set(p, buf);
  } else if (buf.canvas.width < gridW || buf.canvas.height < gridH) {
    const w = Math.max(buf.canvas.width, gridW);
    const h = Math.max(buf.canvas.height, gridH);
    buf.canvas.width = w;
    buf.canvas.height = h;
    buf.img = buf.ctx.createImageData(w, h);
    buf.desatCanvas.width = w;
    buf.desatCanvas.height = h;
    buf.desatImg = buf.desatCtx.createImageData(w, h);
    buf.builtAt = -1;
  }
  buf.gridW = gridW;
  buf.gridH = gridH;
  return buf;
};

// Ink body colour and its wispy mottle lift — near-black with faint cold-blue
// smoke structure so the opaque zone reads as roiling vapour, not a flat disc.
const INK_R = 2, INK_G = 3, INK_B = 6;
const MOTTLE_R = 20, MOTTLE_G = 24, MOTTLE_B = 38;

export const paintInkClouds = (ctx: CanvasRenderingContext2D, game: Game) => {
  if (game.inkPatches.length === 0) return;
  const tSec = game.time * 0.001;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;
  for (const p of game.inkPatches) {
    if (p.radius < 1) continue;
    // Pad the grid one cell past the largest billow + feather so the smoothed
    // edge fades to nothing inside the buffer, never clipped by it.
    const maxEdge = p.radius * 1.12;
    const feather = Math.max(50, p.radius * 0.16);
    const minGx = Math.floor((p.cx - maxEdge - feather) / INK_CELL_SIZE) - 1;
    const maxGx = Math.floor((p.cx + maxEdge + feather) / INK_CELL_SIZE) + 1;
    const minGy = Math.floor((p.cy - maxEdge - feather) / INK_CELL_SIZE) - 1;
    const maxGy = Math.floor((p.cy + maxEdge + feather) / INK_CELL_SIZE) + 1;
    const gridW = maxGx - minGx + 1;
    const gridH = maxGy - minGy + 1;
    const buf = ensureFieldBuffer(p, gridW, gridH);
    if (buf.builtAt === game.time) {
      drawFieldBuffers(ctx, buf);
      continue;
    }
    const img = buf.img;
    const stride = buf.canvas.width;
    const data = img.data;
    const desat = buf.desatImg.data;
    const half = INK_CELL_SIZE / 2;
    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        const idx = ((gy - minGy) * stride + (gx - minGx)) * 4;
        const wx = gx * INK_CELL_SIZE + half;
        const wy = gy * INK_CELL_SIZE + half;
        const dx = wx - p.cx;
        const dy = wy - p.cy;
        const d = Math.hypot(dx, dy);
        // Billowed rim: harmonic noise on the angle, phases drifting slowly so
        // the smoke boils in place instead of sitting frozen.
        const ang = Math.atan2(dy, dx);
        let rim = p.radius;
        for (const h of p.edge) rim += p.radius * h.amp * Math.cos(ang * h.freq + h.phase + tSec * h.drift);
        let cover = (rim - d) / feather;
        if (cover <= 0) { data[idx + 3] = 0; desat[idx + 3] = 0; continue; }
        if (cover > 1) cover = 1;
        cover = cover * cover * (3 - 2 * cover);
        const cell = cells.get(cellKey(gx, gy));
        const ink = cell ? cell.ink : 1;
        // Interior mottle — two drifting cosine fields multiplied give cheap
        // wispy structure; lifts the near-black toward cold blue in streaks.
        const m1 = Math.cos(wx * 0.0113 + tSec * 0.31 + Math.cos(wy * 0.0071 - tSec * 0.17) * 1.9);
        const m2 = Math.cos(wy * 0.0089 - tSec * 0.23 + Math.cos(wx * 0.0067 + tSec * 0.13) * 1.7);
        const mottle = (0.5 + 0.5 * m1) * (0.5 + 0.5 * m2);
        // Smoke plane: rides ONLY the unswept fraction — a fully revealed cell
        // carries no overlay at all, so the field shows through at its normal
        // brightness.
        const aInk = cover * INK_FILL_ALPHA * ink;
        data[idx] = INK_R + (MOTTLE_R - INK_R) * mottle;
        data[idx + 1] = INK_G + (MOTTLE_G - INK_G) * mottle;
        data[idx + 2] = INK_B + (MOTTLE_B - INK_B) * mottle;
        data[idx + 3] = aInk * 255;
        // Desat plane: grey pixels whose alpha is the revealed fraction. Drawn
        // under the "saturation" blend mode, so only the colourfulness of the
        // backdrop is pulled toward zero — hue and luminosity pass through.
        desat[idx] = 128;
        desat[idx + 1] = 128;
        desat[idx + 2] = 128;
        desat[idx + 3] = cover * (1 - ink) * INK_DESAT_STRENGTH * 255;
      }
    }
    buf.ctx.putImageData(img, 0, 0, 0, 0, gridW, gridH);
    buf.desatCtx.putImageData(buf.desatImg, 0, 0, 0, 0, gridW, gridH);
    buf.builtAt = game.time;
    buf.minGx = minGx;
    buf.minGy = minGy;
    drawFieldBuffers(ctx, buf);
  }
  ctx.restore();
};

// Desat mask first (so it grades the scene beneath), smoke on top. The
// "saturation" blend is a non-separable per-pixel op — heavier than source-
// over (see the ctx.filter=brightness note in gameRender.ts) — but it is the
// only way the reveal can read as "the normal scene, drained of colour"
// rather than grey paint over it, and it only runs while an ink patch is
// alive, confined to the patch's bounding box.
const drawFieldBuffers = (ctx: CanvasRenderingContext2D, buf: FieldBuffer) => {
  const dx = buf.minGx * INK_CELL_SIZE;
  const dy = buf.minGy * INK_CELL_SIZE;
  const dw = buf.gridW * INK_CELL_SIZE;
  const dh = buf.gridH * INK_CELL_SIZE;
  ctx.globalCompositeOperation = "saturation";
  ctx.drawImage(buf.desatCanvas, 0, 0, buf.gridW, buf.gridH, dx, dy, dw, dh);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(buf.canvas, 0, 0, buf.gridW, buf.gridH, dx, dy, dw, dh);
};
