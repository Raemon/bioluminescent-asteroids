import { Vec, TAU } from "../../vec";
import { ConeFrame, RADAR_LENGTH, clipRayToCone, targetIsInsideCone, toroidalDelta } from "./coneGeometry";
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
const paintFirstBeatDot = (ctx: CanvasRenderingContext2D, px: number, py: number) => {
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${TRAJECTORY_FIRST_BEAT_DOT_ALPHA})`;
  ctx.lineWidth = TRAJECTORY_FIRST_BEAT_DOT_LINE_WIDTH;
  ctx.setLineDash(TRAJECTORY_FIRST_BEAT_DOT_DASH);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_FIRST_BEAT_DOT_RADIUS, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
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

type DotWalkResult = { overlapsReticule: boolean };

// Why: dots mark target position at successive beats — direct preview of where the player needs to aim.
const drawBeatDotsAlongRay = (
  ctx: CanvasRenderingContext2D,
  rawStartX: number, rawStartY: number, ux: number, uy: number,
  retX: number, retY: number,
  sMin: number, sMax: number, dotStep: number, dotOffset: number,
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
      paintFirstBeatDot(ctx, px, py);
      if (firstDotOverlapsReticule(px, py, retX, retY)) overlapsReticule = true;
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

// Why: per-target trajectory + first-beat lock dot; reports whether the disc overlaps this target's path.
const previewOneTarget = (ctx: TrajectoryContext, t: ReticuleTarget): boolean => {
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
    clip.sMin, clip.sMax, dotStep, dotOffset,
  );
  ctx.ctx.restore();
  return result.overlapsReticule;
};

// Why: walks every visible target and accumulates whether any of their lock dots touched the aim disc.
export const paintTrajectoryPreviews = (
  ctx: TrajectoryContext, targets: ReadonlyArray<ReticuleTarget>,
): boolean => {
  if (targets.length === 0 || RADAR_LENGTH <= 0) return false;
  ctx.ctx.save();
  ctx.ctx.setLineDash([]);
  ctx.ctx.lineWidth = 1.5;
  ctx.ctx.shadowBlur = 0;
  let overlapsReticule = false;
  for (const t of targets) {
    if (previewOneTarget(ctx, t)) overlapsReticule = true;
  }
  ctx.ctx.restore();
  return overlapsReticule;
};
