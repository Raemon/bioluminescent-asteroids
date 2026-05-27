import { Vec, TAU } from "../../vec";
import { ConeFrame, clipRayToCone, targetIsInsideCone, toroidalDelta } from "./coneGeometry";
import { RETICULE_DASH_HSL } from "./radarCone";

// Why: shared bullet-overlap radius constant so trajectory dots and aim discs use the same hit reach.
export const BULLET_HIT_RADIUS_ON_BEAT = 1.8 * 2.38 * 2.5;
export const BULLET_HIT_RADIUS_OFF_BEAT = 1.8 * 2.5;

const TRAJECTORY_ALPHA = 1;
const TRAJECTORY_PULSE_PERIOD_BEATS = 4;
const TRAJECTORY_PULSE_MIN_ALPHA = 1;
const TRAJECTORY_BEAT_DOT_RADIUS = 1;
const TRAJECTORY_BEAT_DOT_ALPHA = 0.25;
const TRAJECTORY_FIRST_BEAT_DOT_RADIUS = 8;
const TRAJECTORY_FIRST_BEAT_DOT_ALPHA = 0.25;
const TRAJECTORY_FIRST_BEAT_DOT_LINE_WIDTH = 1;
const TRAJECTORY_FIRST_BEAT_DOT_DASH: number[] = [2, 2];
// Why: peak alpha matches the disc's RETICULE_OVERLAP_BRIGHTNESS=3 boost (0.25 * 3 ≈ 0.75) so
// the first-dot "lights up" to the same intensity as the disc when proximity is reached.
const TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA = 0.75;
// Why: how far outside the on-beat hit radius the proximity glow starts ramping up — this is
// the "near" band where the first-dot already reads as bright before a direct overlap.
const TRAJECTORY_FIRST_BEAT_DOT_PROXIMITY_PAD = 24;
// Why: 6Hz flicker when directly on a target reads as an unmistakeable "shot will land" cue.
const TRAJECTORY_DIRECT_FLASH_HZ = 6;
const TRAJECTORY_DIRECT_FLASH_DEPTH = 0.55;
// Why: shadow blur halo so the flash reads as a soft glow rather than just a brightness bump.
const TRAJECTORY_DIRECT_FLASH_GLOW_MAX_BLUR = 18;
const TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA = 0.85;

// Why: target shape covers everything the reticule might lock onto (asteroids, comets, aliens, canisters).
export type ReticuleTarget = { pos: Vec; vel: Vec; radius?: number };

export type TrajectoryContext = {
  ctx: CanvasRenderingContext2D;
  apex: Vec;
  beatGrid: number;
  beatTime: number;
  w: number;
  h: number;
  frame: ConeFrame;
  reticulePos: Vec;
  trajectoryFirstSeen: WeakMap<object, number>;
};

// Why: dots pulse from 0→1 the first beat, then sinusoidally — gives a "lock-on" feel as targets enter.
const computeTargetPulse = (firstSeenBeat: number, beatTime: number, beatGrid: number, pulsePeriod: number): number => {
  const firstPeakBeat = Math.ceil((firstSeenBeat + 1e-6) / beatGrid) * beatGrid;
  let pulse01: number;
  if (beatTime < firstPeakBeat) {
    const rampSpan = firstPeakBeat - firstSeenBeat;
    pulse01 = rampSpan > 0 ? (beatTime - firstSeenBeat) / rampSpan : 1;
  } else {
    pulse01 = 0.5 + 0.5 * Math.cos(((beatTime - firstPeakBeat) / pulsePeriod) * TAU);
  }
  const floor = beatTime < firstPeakBeat ? 0 : TRAJECTORY_PULSE_MIN_ALPHA;
  return floor + (1 - floor) * pulse01;
};

// Why: track per-target first-seen-beat so the pulse phase is consistent across frames.
const beatAtFirstSight = (t: ReticuleTarget, seen: WeakMap<object, number>, beatTime: number): number => {
  let firstSeen = seen.get(t as unknown as object);
  if (firstSeen === undefined) {
    firstSeen = beatTime;
    seen.set(t as unknown as object, beatTime);
  }
  return firstSeen;
};

// Why: dashed dot at the first beat reads as "tracking lock"; subsequent solid dots show its future path.
// proximity01 ramps the alpha from baseline → peak as the reticule approaches; directFlash adds an
// overt flicker once the reticule directly overlaps so the player sees "this shot will land".
const paintFirstBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  proximity01: number, directFlash: number,
) => {
  const proximityAlpha = TRAJECTORY_FIRST_BEAT_DOT_ALPHA
    + (TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA - TRAJECTORY_FIRST_BEAT_DOT_ALPHA) * proximity01;
  const alpha = Math.min(1, proximityAlpha * (1 + directFlash));
  const flash01 = directFlash > 0 ? directFlash / TRAJECTORY_DIRECT_FLASH_DEPTH : 0;
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  if (flash01 > 0) {
    ctx.shadowBlur = TRAJECTORY_DIRECT_FLASH_GLOW_MAX_BLUR * flash01;
    ctx.shadowColor = `hsla(${RETICULE_DASH_HSL}, ${TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA * flash01})`;
  }
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.lineWidth = TRAJECTORY_FIRST_BEAT_DOT_LINE_WIDTH + directFlash;
  ctx.setLineDash(TRAJECTORY_FIRST_BEAT_DOT_DASH);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_FIRST_BEAT_DOT_RADIUS, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = prevShadowBlur;
  ctx.shadowColor = prevShadowColor;
};

const paintBeatDot = (ctx: CanvasRenderingContext2D, px: number, py: number) => {
  ctx.fillStyle = `hsla(${RETICULE_DASH_HSL}, ${TRAJECTORY_BEAT_DOT_ALPHA})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
};

// Why: detect whether the first-beat lock dot overlaps the aim disc, so the disc can brighten.
const firstDotOverlapsReticule = (px: number, py: number, retX: number, retY: number): boolean => {
  const R = BULLET_HIT_RADIUS_ON_BEAT;
  const ddx = px - retX;
  const ddy = py - retY;
  return ddx * ddx + ddy * ddy <= (R + TRAJECTORY_FIRST_BEAT_DOT_RADIUS) * (R + TRAJECTORY_FIRST_BEAT_DOT_RADIUS);
};

// Why: 0 = far away (no glow), 1 = touching the disc (full lit). Smooth ramp through the proximity pad.
const firstDotProximity01 = (px: number, py: number, retX: number, retY: number): number => {
  const ddx = px - retX;
  const ddy = py - retY;
  const dist = Math.hypot(ddx, ddy);
  const overlapDist = BULLET_HIT_RADIUS_ON_BEAT + TRAJECTORY_FIRST_BEAT_DOT_RADIUS;
  if (dist <= overlapDist) return 1;
  const outerDist = overlapDist + TRAJECTORY_FIRST_BEAT_DOT_PROXIMITY_PAD;
  if (dist >= outerDist) return 0;
  const t = 1 - (dist - overlapDist) / TRAJECTORY_FIRST_BEAT_DOT_PROXIMITY_PAD;
  return t * t * (3 - 2 * t);
};

type DotWalkResult = { overlapsReticule: boolean };

// Why: dots mark target position at successive beats — direct preview of where the player needs to aim.
const drawBeatDotsAlongRay = (
  ctx: CanvasRenderingContext2D,
  rawStartX: number, rawStartY: number, ux: number, uy: number,
  retX: number, retY: number,
  sMin: number, sMax: number, dotStep: number, dotOffset: number,
  flashPulse: number,
): DotWalkResult => {
  let overlapsReticule = false;
  let drawnDots = 0;
  for (let k = 1; ; k++) {
    const sK = dotOffset + dotStep * k;
    if (sK > sMax) break;
    if (sK < sMin) continue;
    const px = rawStartX + ux * sK;
    const py = rawStartY + uy * sK;
    if (drawnDots === 0) {
      const proximity01 = firstDotProximity01(px, py, retX, retY);
      const overlap = firstDotOverlapsReticule(px, py, retX, retY);
      const directFlash = overlap ? flashPulse : 0;
      paintFirstBeatDot(ctx, px, py, proximity01, directFlash);
      if (overlap) overlapsReticule = true;
    } else {
      paintBeatDot(ctx, px, py);
    }
    drawnDots++;
  }
  return { overlapsReticule };
};

// Why: reticule pos may live on a different toroidal image of the world; remap before overlap checks.
const remapReticuleToTarget = (apex: Vec, reticulePos: Vec, w: number, h: number): [number, number] => {
  const [retDx, retDy] = toroidalDelta(reticulePos.x - apex.x, reticulePos.y - apex.y, w, h);
  return [apex.x + retDx, apex.y + retDy];
};

// Why: square-wave-ish flicker in [0, DEPTH] driven by beatTime — clearly reads as a flash, not a pulse.
const computeDirectFlashPulse = (beatTime: number): number => {
  const phase = (beatTime * TRAJECTORY_DIRECT_FLASH_HZ) % 1;
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return TRAJECTORY_DIRECT_FLASH_DEPTH * tri;
};

// Why: per-target trajectory + first-beat lock dot; reports whether the disc overlaps this target's path.
const previewOneTarget = (ctx: TrajectoryContext, t: ReticuleTarget, flashPulse: number): boolean => {
  let [dx, dy] = toroidalDelta(t.pos.x - ctx.apex.x, t.pos.y - ctx.apex.y, ctx.w, ctx.h);
  const tr = t.radius ?? 0;
  if (!targetIsInsideCone(dx, dy, tr, ctx.frame)) {
    ctx.trajectoryFirstSeen.delete(t as unknown as object);
    return false;
  }
  const firstSeen = beatAtFirstSight(t, ctx.trajectoryFirstSeen, ctx.beatTime);
  const pulsePeriod = TRAJECTORY_PULSE_PERIOD_BEATS * ctx.beatGrid;
  const pulse = computeTargetPulse(firstSeen, ctx.beatTime, ctx.beatGrid, pulsePeriod);
  ctx.ctx.globalAlpha = TRAJECTORY_ALPHA * pulse;

  const cx = ctx.apex.x + dx;
  const cy = ctx.apex.y + dy;
  const speed = Math.hypot(t.vel.x, t.vel.y);
  if (speed < 1) return false;
  const ux = t.vel.x / speed;
  const uy = t.vel.y / speed;
  const r = t.radius ?? 0;
  const edgePad = 6;
  const rawStartX = cx + ux * (r + edgePad);
  const rawStartY = cy + uy * (r + edgePad);
  const clip = clipRayToCone(rawStartX - ctx.apex.x, rawStartY - ctx.apex.y, ux, uy, ctx.frame);
  if (clip.sMax <= clip.sMin) return false;

  const [retX, retY] = remapReticuleToTarget(ctx.apex, ctx.reticulePos, ctx.w, ctx.h);
  const dotStep = speed * ctx.beatGrid;
  const dotOffset = -(r + edgePad);
  ctx.ctx.save();
  ctx.ctx.setLineDash([]);
  const result = drawBeatDotsAlongRay(
    ctx.ctx, rawStartX, rawStartY, ux, uy, retX, retY,
    clip.sMin, clip.sMax, dotStep, dotOffset, flashPulse,
  );
  ctx.ctx.restore();
  return result.overlapsReticule;
};

// Why: walks every visible target and accumulates whether any of their lock dots touched the aim disc.
export const paintTrajectoryPreviews = (
  ctx: TrajectoryContext, targets: ReadonlyArray<ReticuleTarget>,
): boolean => {
  if (targets.length === 0 || ctx.frame.length <= 0) return false;
  ctx.ctx.save();
  ctx.ctx.setLineDash([]);
  ctx.ctx.lineWidth = 1.5;
  ctx.ctx.shadowBlur = 0;
  const flashPulse = computeDirectFlashPulse(ctx.beatTime);
  let overlapsReticule = false;
  for (const t of targets) {
    if (previewOneTarget(ctx, t, flashPulse)) overlapsReticule = true;
  }
  ctx.ctx.restore();
  return overlapsReticule;
};
