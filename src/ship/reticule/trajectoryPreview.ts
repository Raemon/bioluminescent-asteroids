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
const TRAJECTORY_AIM_INTERSECTION_X_RADIUS = 5;
const TRAJECTORY_AIM_INTERSECTION_X_ALPHA = 0.55;
const TRAJECTORY_AIM_INTERSECTION_X_LINE_WIDTH = 1.5;

// Why: when a target first enters the cone, briefly boost alpha so the appearance reads as a flash.
const TRAJECTORY_ENTRY_FLASH_DURATION_SEC = 0.35;
const TRAJECTORY_ENTRY_FLASH_PEAK_BOOST = 2.5;
// Why: after a target leaves the cone, keep the last-seen trajectory visible for this long, fading out.
const TRAJECTORY_FADE_OUT_DURATION_SEC = 2;

// Why: target shape covers everything the reticule might lock onto (asteroids, comets, aliens, canisters).
export type ReticuleTarget = { pos: Vec; vel: Vec; radius?: number };

// Why: snapshot the last in-cone state so fade-out can keep rendering even if the target dies/leaves.
type TrajectorySnapshot = { posX: number; posY: number; velX: number; velY: number; radius: number };

// Why: per-target tracking for entry flash phase and post-exit fade lingering.
export type TrajectoryTrack = {
  firstSeen: number;
  lastInConeAt: number;
  snapshot: TrajectorySnapshot;
};

// Why: strong Map (not WeakMap) is required because we need to keep rendering a target's fade-out
//   snapshot even after the target itself is gone (e.g. asteroid destroyed mid-cone). Entries are
//   cleaned up by renderFadingTrajectories once the 2s fade completes, and the whole map is
//   discarded when the Ship instance is replaced on respawn/restart, so the leak is bounded.
export type TrajectoryTrackMap = Map<object, TrajectoryTrack>;

export type TrajectoryContext = {
  ctx: CanvasRenderingContext2D;
  apex: Vec;
  beatGrid: number;
  beatTime: number;
  w: number;
  h: number;
  frame: ConeFrame;
  reticulePos: Vec;
  aimCircleCenter: Vec;
  aimCircleRadius: number;
  trajectoryTracks: TrajectoryTrackMap;
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

// Why: alpha multiplier that spikes to PEAK_BOOST when target just entered the cone, decays to 1 over
// ENTRY_FLASH_DURATION_SEC — gives an unmistakable "new contact" flash on first appearance.
const computeEntryFlashBoost = (firstSeen: number, beatTime: number): number => {
  const age = beatTime - firstSeen;
  if (age < 0 || age >= TRAJECTORY_ENTRY_FLASH_DURATION_SEC) return 1;
  const t01 = 1 - age / TRAJECTORY_ENTRY_FLASH_DURATION_SEC;
  return 1 + (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1) * t01 * t01;
};

// Why: trajectory lingers for FADE_OUT_DURATION_SEC after leaving cone — returns 1→0 fade or 1 if in-cone.
const computeFadeAlpha = (lastInConeAt: number, beatTime: number): number => {
  const since = beatTime - lastInConeAt;
  if (since <= 0) return 1;
  if (since >= TRAJECTORY_FADE_OUT_DURATION_SEC) return 0;
  const t01 = 1 - since / TRAJECTORY_FADE_OUT_DURATION_SEC;
  return t01 * t01;
};

// Why: dashed dot at the first beat reads as "tracking lock"; subsequent solid dots show its future path.
// proximity01 ramps the alpha from baseline → peak as the reticule approaches; directFlash adds an
// overt flicker once the reticule directly overlaps so the player sees "this shot will land";
// entryFlashBoost multiplies the per-dot alpha for the brief window after a target enters the cone.
const paintFirstBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  proximity01: number, directFlash: number, entryFlashBoost: number,
) => {
  const proximityAlpha = TRAJECTORY_FIRST_BEAT_DOT_ALPHA
    + (TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA - TRAJECTORY_FIRST_BEAT_DOT_ALPHA) * proximity01;
  const alpha = Math.min(1, proximityAlpha * (1 + directFlash) * entryFlashBoost);
  const flash01 = directFlash > 0 ? directFlash / TRAJECTORY_DIRECT_FLASH_DEPTH : 0;
  // Why: entry-flash adds a soft glow halo too — borrowing the same shadow-blur trick as direct-flash.
  const entryGlow01 = Math.max(0, Math.min(1, (entryFlashBoost - 1) / (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1)));
  const glow01 = Math.max(flash01, entryGlow01);
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  if (glow01 > 0) {
    ctx.shadowBlur = TRAJECTORY_DIRECT_FLASH_GLOW_MAX_BLUR * glow01;
    ctx.shadowColor = `hsla(${RETICULE_DASH_HSL}, ${TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA * glow01})`;
  }
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.lineWidth = TRAJECTORY_FIRST_BEAT_DOT_LINE_WIDTH + directFlash + (entryFlashBoost - 1);
  ctx.setLineDash(TRAJECTORY_FIRST_BEAT_DOT_DASH);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_FIRST_BEAT_DOT_RADIUS, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = prevShadowBlur;
  ctx.shadowColor = prevShadowColor;
};

const paintBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number, entryFlashBoost: number,
) => {
  const alpha = Math.min(1, TRAJECTORY_BEAT_DOT_ALPHA * entryFlashBoost);
  ctx.fillStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
};

const paintAimIntersectionX = (
  ctx: CanvasRenderingContext2D, px: number, py: number, entryFlashBoost: number,
) => {
  const r = TRAJECTORY_AIM_INTERSECTION_X_RADIUS;
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${Math.min(1, TRAJECTORY_AIM_INTERSECTION_X_ALPHA * entryFlashBoost)})`;
  ctx.lineWidth = TRAJECTORY_AIM_INTERSECTION_X_LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(px - r, py - r);
  ctx.lineTo(px + r, py + r);
  ctx.moveTo(px + r, py - r);
  ctx.lineTo(px - r, py + r);
  ctx.stroke();
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
  flashPulse: number, entryFlashBoost: number,
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
      paintFirstBeatDot(ctx, px, py, proximity01, directFlash, entryFlashBoost);
      if (overlap) overlapsReticule = true;
    } else {
      paintBeatDot(ctx, px, py, entryFlashBoost);
    }
    drawnDots++;
  }
  return { overlapsReticule };
};

const drawAimIntersectionsAlongRay = (
  ctx: CanvasRenderingContext2D,
  rawStartX: number, rawStartY: number, ux: number, uy: number,
  centerX: number, centerY: number, radius: number,
  sMin: number, sMax: number, entryFlashBoost: number,
) => {
  const dx = rawStartX - centerX;
  const dy = rawStartY - centerY;
  const q = dx * ux + dy * uy;
  const c = dx * dx + dy * dy - radius * radius;
  const disc = q * q - c;
  if (disc < 0) return;
  const root = Math.sqrt(disc);
  const intersectionDistances = root <= 1e-6 ? [-q] : [-q - root, -q + root];
  for (const s of intersectionDistances) {
    if (s < sMin || s > sMax) continue;
    paintAimIntersectionX(ctx, rawStartX + ux * s, rawStartY + uy * s, entryFlashBoost);
  }
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

// Why: core trajectory renderer — operates on a position/velocity snapshot, with optional cone clipping.
// alphaMultiplier folds in entry-flash boost and exit-fade decay; clipToCone is false during fade so the
// lingering ghost remains visible even after the target has left the radar wedge.
const paintTrajectoryFromSnapshot = (
  ctx: TrajectoryContext, snap: TrajectorySnapshot, firstSeen: number,
  alphaMultiplier: number, flashPulse: number, clipToCone: boolean,
): boolean => {
  const speed = Math.hypot(snap.velX, snap.velY);
  if (speed < 1) return false;
  const [dx, dy] = toroidalDelta(snap.posX - ctx.apex.x, snap.posY - ctx.apex.y, ctx.w, ctx.h);
  const cx = ctx.apex.x + dx;
  const cy = ctx.apex.y + dy;
  const ux = snap.velX / speed;
  const uy = snap.velY / speed;
  const r = snap.radius;
  const edgePad = 6;
  const rawStartX = cx + ux * (r + edgePad);
  const rawStartY = cy + uy * (r + edgePad);
  let sMin: number;
  let sMax: number;
  if (clipToCone) {
    const clip = clipRayToCone(rawStartX - ctx.apex.x, rawStartY - ctx.apex.y, ux, uy, ctx.frame);
    if (clip.sMax <= clip.sMin) return false;
    sMin = clip.sMin;
    sMax = clip.sMax;
  } else {
    sMin = -(r + edgePad);
    sMax = ctx.frame.length;
  }

  const pulsePeriod = TRAJECTORY_PULSE_PERIOD_BEATS * ctx.beatGrid;
  const pulse = computeTargetPulse(firstSeen, ctx.beatTime, ctx.beatGrid, pulsePeriod);
  const entryFlashBoost = computeEntryFlashBoost(firstSeen, ctx.beatTime);
  // Why: during the entry-flash window, override the pulse ramp so brightness peaks immediately rather
  // than easing in — the flash is the visual cue that the contact JUST appeared.
  const effectivePulse = entryFlashBoost > 1 ? Math.max(pulse, 1) : pulse;
  ctx.ctx.globalAlpha = TRAJECTORY_ALPHA * effectivePulse * alphaMultiplier;

  const [retX, retY] = remapReticuleToTarget(ctx.apex, ctx.reticulePos, ctx.w, ctx.h);
  const [aimCenterX, aimCenterY] = remapReticuleToTarget(ctx.apex, ctx.aimCircleCenter, ctx.w, ctx.h);
  const dotStep = speed * ctx.beatGrid;
  const dotOffset = -(r + edgePad);
  ctx.ctx.save();
  ctx.ctx.setLineDash([]);
  drawAimIntersectionsAlongRay(
    ctx.ctx, rawStartX, rawStartY, ux, uy, aimCenterX, aimCenterY,
    ctx.aimCircleRadius, sMin, sMax, entryFlashBoost,
  );
  const result = drawBeatDotsAlongRay(
    ctx.ctx, rawStartX, rawStartY, ux, uy, retX, retY,
    sMin, sMax, dotStep, dotOffset, flashPulse, entryFlashBoost,
  );
  ctx.ctx.restore();
  return result.overlapsReticule;
};

// Why: refresh the track for an in-cone target — entry flash starts when no track existed, or when the
// target had fully faded out and re-enters; otherwise re-arming preserves the existing pulse phase.
const refreshTrack = (
  tracks: TrajectoryTrackMap, t: ReticuleTarget, beatTime: number,
): TrajectoryTrack => {
  const key = t as unknown as object;
  const existing = tracks.get(key);
  const radius = t.radius ?? 0;
  const snapshot: TrajectorySnapshot = {
    posX: t.pos.x, posY: t.pos.y, velX: t.vel.x, velY: t.vel.y, radius,
  };
  if (!existing) {
    const fresh: TrajectoryTrack = { firstSeen: beatTime, lastInConeAt: beatTime, snapshot };
    tracks.set(key, fresh);
    return fresh;
  }
  existing.snapshot = snapshot;
  existing.lastInConeAt = beatTime;
  return existing;
};

// Why: the trajectory ray itself overlaps the cone when its forward path (from just ahead of the
// target, in the velocity direction) clips to a non-empty segment inside the wedge — keeps the
// preview "live" even after the asteroid leaves the cone, so long as its path still crosses it.
const trajectoryRayOverlapsCone = (
  dx: number, dy: number, t: ReticuleTarget, frame: ConeFrame,
): boolean => {
  const speed = Math.hypot(t.vel.x, t.vel.y);
  if (speed < 1) return false;
  const ux = t.vel.x / speed;
  const uy = t.vel.y / speed;
  const r = t.radius ?? 0;
  const edgePad = 6;
  const rsx = dx + ux * (r + edgePad);
  const rsy = dy + uy * (r + edgePad);
  const clip = clipRayToCone(rsx, rsy, ux, uy, frame);
  return clip.sMax > clip.sMin;
};

// Why: per-target live render — checks cone membership, updates track, and draws with flash boost.
// Treat the trajectory as "in cone" if EITHER the target overlaps the cone OR its forward path
// crosses the cone; the player can still aim the radar at the trajectory line itself.
const previewLiveTarget = (
  ctx: TrajectoryContext, t: ReticuleTarget, flashPulse: number, rendered: Set<object>,
): boolean => {
  const [dx, dy] = toroidalDelta(t.pos.x - ctx.apex.x, t.pos.y - ctx.apex.y, ctx.w, ctx.h);
  const tr = t.radius ?? 0;
  const targetInCone = targetIsInsideCone(dx, dy, tr, ctx.frame);
  const rayInCone = !targetInCone && trajectoryRayOverlapsCone(dx, dy, t, ctx.frame);
  if (!targetInCone && !rayInCone) return false;
  const track = refreshTrack(ctx.trajectoryTracks, t, ctx.beatTime);
  rendered.add(t as unknown as object);
  // Why: when only the ray (not the target itself) is in the cone, disable cone clipping so the
  // visible dots span the full forward path — clipping would chop the line back inside the wedge
  // and could omit the section the radar is actually overlapping.
  return paintTrajectoryFromSnapshot(ctx, track.snapshot, track.firstSeen, 1, flashPulse, targetInCone);
};

// Why: drain expired fade entries and render fading-out trajectories for targets that left the cone or
// were destroyed while in it — keeps a 2s "ghost" of the last-seen path that decays to invisible.
const renderFadingTrajectories = (
  ctx: TrajectoryContext, rendered: Set<object>, flashPulse: number,
) => {
  for (const [key, track] of ctx.trajectoryTracks) {
    if (rendered.has(key)) continue;
    const fade = computeFadeAlpha(track.lastInConeAt, ctx.beatTime);
    if (fade <= 0) {
      ctx.trajectoryTracks.delete(key);
      continue;
    }
    paintTrajectoryFromSnapshot(ctx, track.snapshot, track.firstSeen, fade, flashPulse, false);
  }
};

// Why: walks every visible target and accumulates whether any of their lock dots touched the aim disc.
export const paintTrajectoryPreviews = (
  ctx: TrajectoryContext, targets: ReadonlyArray<ReticuleTarget>,
): boolean => {
  if (ctx.frame.length <= 0) return false;
  ctx.ctx.save();
  ctx.ctx.setLineDash([]);
  ctx.ctx.lineWidth = 1.5;
  ctx.ctx.shadowBlur = 0;
  const flashPulse = computeDirectFlashPulse(ctx.beatTime);
  const rendered = new Set<object>();
  let overlapsReticule = false;
  for (const t of targets) {
    if (previewLiveTarget(ctx, t, flashPulse, rendered)) overlapsReticule = true;
  }
  renderFadingTrajectories(ctx, rendered, flashPulse);
  ctx.ctx.restore();
  return overlapsReticule;
};
