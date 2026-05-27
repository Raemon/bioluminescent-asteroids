import type { Ship } from "../../Ship";
import { Vec, TAU } from "../../vec";
import { radarHalfAngle, radarLength } from "./coneGeometry";

// Why: shared HSL string keeps the whole reticule visually unified (single hue family).
export const RETICULE_DASH_HSL = "220, 100%, 100%";

const RADAR_FRACTIONS: number[] = [0.33, 0.66, 1.0];
const RADAR_ALPHA = 0;
const RADAR_PULSE_AMOUNT = 0.1;
const RADAR_LINE_WIDTH = 1;
const RADAR_SWEEP_PHASE_OFFSET_SEC = 0.6;
const RADAR_SWEEP_DEPTH = 0.7;
const RADAR_SWEEP_PERIOD_SEC = 2.4;

const RADAR_BG_INNER_ALPHA = 0.02;
const RADAR_BG_OUTER_ALPHA = 0.0;
const RADAR_PULSE_PERIOD_BEATS = 4;
const RADAR_PULSE_WIDTH = 0.03;
const RADAR_PULSE_BAND_ALPHA = 0.02;

// Why: the wedge fills the area in front of the ship so range arcs and trajectory previews overlay cleanly.
const carveWedgePath = (
  ctx: CanvasRenderingContext2D, ship: Ship, apex: Vec, halfAngle: number, length: number,
) => {
  const wedgeStart = ship.heading - halfAngle;
  const wedgeEnd = ship.heading + halfAngle;
  ctx.beginPath();
  ctx.moveTo(apex.x, apex.y);
  ctx.arc(apex.x, apex.y, length, wedgeStart, wedgeEnd);
  ctx.closePath();
};

// Why: subtle inner glow → outer fade gives the cone a "sensor field" feel without strong borders.
const paintWedgeBackground = (ctx: CanvasRenderingContext2D, apex: Vec, length: number) => {
  const bg = ctx.createRadialGradient(apex.x, apex.y, 0, apex.x, apex.y, length);
  bg.addColorStop(0, `hsla(${RETICULE_DASH_HSL}, ${RADAR_BG_INNER_ALPHA})`);
  bg.addColorStop(1, `hsla(${RETICULE_DASH_HSL}, ${RADAR_BG_OUTER_ALPHA})`);
  ctx.fillStyle = bg;
  ctx.fill();
};

// Why: travelling pulse band visualises the beat sweeping outward, locking the cone to musical time.
const paintWedgePulseBand = (
  ctx: CanvasRenderingContext2D, apex: Vec, beatTime: number, beatGrid: number, length: number,
) => {
  const periodSec = Math.max(1e-3, RADAR_PULSE_PERIOD_BEATS * beatGrid);
  const phase = ((beatTime % periodSec) + periodSec) % periodSec;
  const pulseR = (phase / periodSec) * length;
  const halfW = Math.max(1e-3, RADAR_PULSE_WIDTH) * length * 0.5;
  const r0 = Math.max(0, pulseR - halfW);
  const r1 = Math.min(length, pulseR + halfW);
  if (r1 <= r0 || RADAR_PULSE_BAND_ALPHA <= 0.001) return;
  const grad = ctx.createRadialGradient(apex.x, apex.y, r0, apex.x, apex.y, r1);
  const peakT = (pulseR - r0) / (r1 - r0);
  grad.addColorStop(0, `hsla(${RETICULE_DASH_HSL}, 0)`);
  grad.addColorStop(Math.min(0.999, Math.max(0.001, peakT)), `hsla(${RETICULE_DASH_HSL}, ${RADAR_PULSE_BAND_ALPHA})`);
  grad.addColorStop(1, `hsla(${RETICULE_DASH_HSL}, 0)`);
  ctx.fillStyle = grad;
  ctx.fill();
};

// Why: drawn before everything else so range arcs + trajectories overlay on top of the cone wash.
export const paintConeBackground = (
  ctx: CanvasRenderingContext2D, ship: Ship, apex: Vec, beatTime: number, beatGrid: number,
) => {
  const halfAngle = radarHalfAngle(ship);
  const length = radarLength(ship);
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.setLineDash([]);
  carveWedgePath(ctx, ship, apex, halfAngle, length);
  paintWedgeBackground(ctx, apex, length);
  paintWedgePulseBand(ctx, apex, beatTime, beatGrid, length);
  ctx.restore();
};

// Why: each arc's brightness is phase-shifted so the eye sees a sweep travelling apex→tip without motion.
const arcAlphaForIndex = (i: number, frac: number, beatTime: number, radarPulse: number): number => {
  const pulseMix = 1 - RADAR_PULSE_AMOUNT + RADAR_PULSE_AMOUNT * radarPulse;
  const distanceFade = 1 - frac;
  const sweep01 = 0.5 + 0.5 * Math.cos(((beatTime - i * RADAR_SWEEP_PHASE_OFFSET_SEC) / RADAR_SWEEP_PERIOD_SEC) * TAU);
  const sweepMul = 1 - RADAR_SWEEP_DEPTH + RADAR_SWEEP_DEPTH * sweep01;
  return Math.min(1, RADAR_ALPHA * pulseMix * distanceFade * sweepMul);
};

// Why: curved strokes read as "sensor HUD" and stay visually distinct from straight trajectory dashes.
export const paintRangeArcs = (
  ctx: CanvasRenderingContext2D, ship: Ship, apex: Vec, beatTime: number, radarPulse: number,
) => {
  const halfAngle = radarHalfAngle(ship);
  const length = radarLength(ship);
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.setLineDash([]);
  ctx.lineWidth = RADAR_LINE_WIDTH;
  const arcStart = ship.heading - halfAngle;
  const arcEnd = ship.heading + halfAngle;
  for (let i = 0; i < RADAR_FRACTIONS.length; i++) {
    const frac = RADAR_FRACTIONS[i];
    const a = arcAlphaForIndex(i, frac, beatTime, radarPulse);
    if (a <= 0.001) continue;
    ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${a})`;
    ctx.beginPath();
    ctx.arc(apex.x, apex.y, length * frac, arcStart, arcEnd);
    ctx.stroke();
  }
  ctx.restore();
};
