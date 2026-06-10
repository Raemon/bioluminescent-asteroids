import type { Game } from "../Game";
import type { Asteroid } from "../Asteroid";
import { Vec } from "../vec";
import { rng } from "./rng";
import { comboGrid } from "./rhythmGate";
import { BASS_MEASURE_LENGTH } from "../Asteroid";
import { resonanceValueOf } from "./resonanceBonus";
import { popupBassEcho } from "./popups";

// Bass-echo lightning: when an on-rhythm kill (at a healthy combo) lands on
// the same beat-slot a live bassteroid plays, an arc jumps from that
// bassteroid to the kill. The bolt borrows the SoundwaveRadiator vocabulary —
// an oscilloscope-wobbled core plus perpendicular spectrum bars riding the
// arc — so it reads as the bassteroid's own visualizer reaching out, not a
// generic electric zap. The arc anchors to the bassteroid's live position so
// it stays attached while the rock drifts; the kill end stays where the
// target died.

export type BassLightning = {
  source: { pos: Vec; radius: number };
  target: Vec;
  hue: number;
  life: number;
  maxLife: number;
  seed: number;
  // stable per-sample perpendicular jag (px); wobble animates on top.
  jags: number[];
};

const LIGHTNING_LIFE = 0.55;
const COMBO_REQUIRED = 4;
const MAX_ARCS_PER_KILL = 3;
const SAMPLE_SPACING = 14;
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 40;
const JAG_AMPLITUDE = 8;
const WOBBLE_AMPLITUDE = 4.5;

const TAU = Math.PI * 2;

// matches SoundwaveRadiator's oscilloscope terms so the arc and the puffs
// squiggle in the same dialect.
const OSC_FREQS = [4, 7, 11];
const OSC_RATES = [7.0, 9.8, 12.3];
const OSC_AMPS = [0.55, 0.3, 0.15];

const BAR_FREQS = [2, 4, 6, 9];
const BAR_RATES = [4.7, 5.9, 7.3, 8.6];
const BAR_AMPS = [0.45, 0.3, 0.2, 0.14];
const BAR_FLOOR = 0.2;
const BAR_MAX_LEN = 9;
const BAR_STEP = 2;

const measureSlot = (t: number): number => {
  const m = t % BASS_MEASURE_LENGTH;
  return m < 0 ? m + BASS_MEASURE_LENGTH : m;
};

const sameSlot = (a: number, b: number): boolean => {
  const d = Math.abs(a - b);
  return Math.min(d, BASS_MEASURE_LENGTH - d) < 0.01;
};

const newBolt = (source: Asteroid, target: Vec): BassLightning => {
  const d = Math.hypot(target.x - source.pos.x, target.y - source.pos.y);
  const n = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(d / SAMPLE_SPACING)));
  const jags: number[] = [];
  for (let i = 0; i < n; i++) jags.push((rng() * 2 - 1) * JAG_AMPLITUDE);
  return {
    source,
    target: { x: target.x, y: target.y },
    hue: source.hue,
    life: LIGHTNING_LIFE,
    maxLife: LIGHTNING_LIFE,
    seed: rng() * TAU,
    jags,
  };
};

// Fires the arcs (and the "+N" tag beside each source bassteroid) for one
// on-beat kill. `killed` excludes the dying rock from arcing to itself.
export const triggerBassLightning = (game: Game, targetPos: Vec, killed?: Asteroid) => {
  if (game.beatCombo < COMBO_REQUIRED) return;
  const grid = comboGrid(game);
  const beatCenter = Math.round(game.perceivedBeatTime / grid) * grid;
  const killSlot = measureSlot(beatCenter);
  const sources: Asteroid[] = [];
  for (const a of game.asteroids) {
    if (!a.isBass() || a === killed) continue;
    if (sameSlot(measureSlot(a.nextBeatAt), killSlot)) sources.push(a);
  }
  if (sources.length === 0) return;
  const dist2 = (a: Asteroid) => {
    const dx = a.pos.x - targetPos.x;
    const dy = a.pos.y - targetPos.y;
    return dx * dx + dy * dy;
  };
  sources.sort((a, b) => dist2(a) - dist2(b));
  for (const src of sources.slice(0, MAX_ARCS_PER_KILL)) {
    game.bassLightnings.push(newBolt(src, targetPos));
    const value = resonanceValueOf(src);
    if (value > 0) game.popups.push(popupBassEcho(src, value));
  }
};

export const updateBassLightnings = (bolts: BassLightning[], dt: number): BassLightning[] => {
  for (const l of bolts) l.life -= dt;
  return bolts.filter((l) => l.life > 0);
};

// Polyline samples for one bolt at one instant: straight chord from the
// bassteroid's rim to the kill point, displaced perpendicular by the stable
// jag plus the animated oscilloscope wobble. Ends pin to their anchors.
const buildBoltPoints = (l: BassLightning, tSec: number): number[] => {
  const n = l.jags.length;
  const sx = l.source.pos.x;
  const sy = l.source.pos.y;
  let ax = l.target.x - sx;
  let ay = l.target.y - sy;
  const d = Math.hypot(ax, ay) || 1;
  ax /= d;
  ay /= d;
  const px = -ay;
  const py = ax;
  const startD = Math.min(l.source.radius * 0.9, d * 0.4);
  const seed = l.seed;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const ti = i / (n - 1);
    const pin = Math.sin(Math.PI * ti);
    const w =
      OSC_AMPS[0] * Math.sin(OSC_FREQS[0] * ti * TAU + tSec * OSC_RATES[0] + seed) +
      OSC_AMPS[1] * Math.sin(OSC_FREQS[1] * ti * TAU + tSec * OSC_RATES[1] + seed * 1.618) +
      OSC_AMPS[2] * Math.sin(OSC_FREQS[2] * ti * TAU + tSec * OSC_RATES[2] + seed * 2.414);
    const off = (l.jags[i] + w * WOBBLE_AMPLITUDE) * pin;
    const along = startD + (d - startD) * ti;
    pts.push(sx + ax * along + px * off, sy + ay * along + py * off);
  }
  return pts;
};

const strokePolyline = (
  ctx: CanvasRenderingContext2D, pts: number[], width: number, style: string,
) => {
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
};

// Short spectrum bars perpendicular to the arc — the radiator's polar EQ
// unrolled along the bolt, so the visualizer reads "up and down" the arc.
const drawSpectrumBars = (
  ctx: CanvasRenderingContext2D, l: BassLightning, pts: number[],
  tSec: number, env: number, lightness: number,
) => {
  const n = pts.length / 2;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = `hsla(${l.hue}, 100%, ${Math.min(95, lightness + 18)}%, ${0.4 * env})`;
  ctx.beginPath();
  for (let i = 1; i < n - 1; i += BAR_STEP) {
    const ti = i / (n - 1);
    const pin = Math.sin(Math.PI * ti);
    const raw =
      BAR_AMPS[0] * Math.sin(BAR_FREQS[0] * ti * TAU + tSec * BAR_RATES[0] + l.seed) +
      BAR_AMPS[1] * Math.sin(BAR_FREQS[1] * ti * TAU + tSec * BAR_RATES[1] + l.seed * 1.618) +
      BAR_AMPS[2] * Math.sin(BAR_FREQS[2] * ti * TAU + tSec * BAR_RATES[2] + l.seed * 2.414) +
      BAR_AMPS[3] * Math.sin(BAR_FREQS[3] * ti * TAU + tSec * BAR_RATES[3] + l.seed * 3.302);
    const energy = BAR_FLOOR + (1 - BAR_FLOOR) * Math.min(1, Math.abs(raw));
    const h = energy * BAR_MAX_LEN * pin;
    if (h < 0.6) continue;
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    // local tangent from neighbours; bars sit perpendicular to it.
    const txv = pts[(i + 1) * 2] - pts[(i - 1) * 2];
    const tyv = pts[(i + 1) * 2 + 1] - pts[(i - 1) * 2 + 1];
    const tl = Math.hypot(txv, tyv) || 1;
    const bx = -tyv / tl;
    const by = txv / tl;
    ctx.moveTo(x - bx * h, y - by * h);
    ctx.lineTo(x + bx * h, y + by * h);
  }
  ctx.stroke();
};

// Caller does NOT need to set composite mode — handled here.
export const renderBassLightnings = (
  ctx: CanvasRenderingContext2D, bolts: BassLightning[], tSec: number,
) => {
  if (bolts.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const l of bolts) {
    const k = l.life / l.maxLife;
    // sharp attack, squared release — flash, not a sustained beam. The slow
    // shimmer keeps the tail alive without reading as a second pulse.
    const env = k * k * (0.85 + 0.15 * Math.sin(tSec * 23 + l.seed));
    if (env < 0.02) continue;
    const pts = buildBoltPoints(l, tSec);
    const lightness = 70;
    strokePolyline(ctx, pts, 6.5, `hsla(${l.hue}, 100%, ${lightness}%, ${0.1 * env})`);
    strokePolyline(ctx, pts, 2.6, `hsla(${l.hue}, 100%, ${lightness + 8}%, ${0.3 * env})`);
    strokePolyline(ctx, pts, 1.2, `hsla(${l.hue}, 100%, 92%, ${0.75 * env})`);
    drawSpectrumBars(ctx, l, pts, tSec, env, lightness);
  }
  ctx.restore();
};
