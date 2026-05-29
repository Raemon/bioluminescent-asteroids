import { Vec, TAU } from "../../vec";
import { ConeFrame, clipRayToCone, targetIsInsideCone, toroidalDelta } from "./coneGeometry";
import { RETICULE_DASH_HSL } from "./radarCone";

// Why: shared bullet-overlap radius constant so trajectory dots and aim discs use the same hit reach.
export const BULLET_HIT_RADIUS_ON_BEAT = 1.8 * 2.38 * 2.5;
export const BULLET_HIT_RADIUS_OFF_BEAT = 1.8 * 2.5;

// Why: top-level toggles for individual trajectory-preview overlays — flip to false to hide an
// element without ripping out its code. Useful while tuning the visual language.
const SHOW_AIM_INTERSECTION_X = false;
const SHOW_FIRST_BEAT_DOT = true;
const SHOW_ON_RHYTHM_RETICULE = true;

const TRAJECTORY_ALPHA = 1;
const TRAJECTORY_PULSE_PERIOD_BEATS = 4;
const TRAJECTORY_PULSE_MIN_ALPHA = 1;
const TRAJECTORY_BEAT_DOT_RADIUS = 1;
const TRAJECTORY_BEAT_DOT_ALPHA = 0.25;
// Why: the first beat-dot is the most important — slightly larger and brighter than the rest so
// the player's eye is drawn to "this is where to shoot next beat", but still reads as a member
// of the same dot series rather than a separate kind of cue.
const TRAJECTORY_FIRST_BEAT_DOT_RADIUS = 2;
const TRAJECTORY_FIRST_BEAT_DOT_ALPHA = 0.55;
// Why: peak alpha matches the disc's RETICULE_OVERLAP_BRIGHTNESS=3 boost (≈0.75) so
// the first dot "lights up" to the same intensity as the disc when proximity is reached.
const TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA = 0.95;
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
// Why: on-rhythm aim-spot reticule — dashed circle with crosshair, sized for visibility on the
// target. Its own constants (no longer tied to the first beat-dot's size).
const TRAJECTORY_ON_RHYTHM_SPOT_RADIUS = 8;
const TRAJECTORY_ON_RHYTHM_SPOT_LINE_WIDTH = 1;
const TRAJECTORY_ON_RHYTHM_SPOT_DASH: number[] = [2, 2];
const TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_REACHABLE = TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA;
const TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_UNREACHABLE = TRAJECTORY_FIRST_BEAT_DOT_ALPHA;
// Why: dashed crosshair tick that sticks out past the lock circle — reads as "this is a sight".
const TRAJECTORY_LOCK_CROSSHAIR_GAP = 3;
const TRAJECTORY_LOCK_CROSSHAIR_LENGTH = 7;
const TRAJECTORY_LOCK_CROSSHAIR_DASH: number[] = [2, 2];

// Why: every reticule element brightens on the beat and decays across it, so the player feels the
// rhythm gate visually. Multiplier is PEAK at beat onset and decays to 1 by the next beat.
const RETICULE_BEAT_PULSE_PEAK = 2.4;
export const computeBeatPulseBoost = (beatTime: number, beatGrid: number): number => {
  if (beatGrid <= 0) return 1;
  const phase = ((beatTime % beatGrid) + beatGrid) % beatGrid / beatGrid;
  const decay = (1 - phase) * (1 - phase);
  return 1 + (RETICULE_BEAT_PULSE_PEAK - 1) * decay;
};

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

// Why: dashed crosshair sticking out beyond the on-rhythm aim-spot circle in the 4 cardinal
// directions — reads as "targeting sight". Drawn under the caller's current strokeStyle/lineWidth.
const paintOnRhythmCrosshair = (ctx: CanvasRenderingContext2D, px: number, py: number) => {
  const prevDash = ctx.getLineDash();
  ctx.setLineDash(TRAJECTORY_LOCK_CROSSHAIR_DASH);
  const inner = TRAJECTORY_ON_RHYTHM_SPOT_RADIUS + TRAJECTORY_LOCK_CROSSHAIR_GAP;
  const outer = inner + TRAJECTORY_LOCK_CROSSHAIR_LENGTH;
  ctx.beginPath();
  ctx.moveTo(px - outer, py); ctx.lineTo(px - inner, py);
  ctx.moveTo(px + inner, py); ctx.lineTo(px + outer, py);
  ctx.moveTo(px, py - outer); ctx.lineTo(px, py - inner);
  ctx.moveTo(px, py + inner); ctx.lineTo(px, py + outer);
  ctx.stroke();
  ctx.setLineDash(prevDash);
};

// Why: dashed lock-circle + crosshair for the on-rhythm aim spot — the "where to aim NOW to hit
// on the next beat" reticule. Caller passes alpha/lineWidth/glow so reachable vs. unreachable and
// entry-flash state can modulate brightness without changing the geometry.
const paintOnRhythmReticule = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  alpha: number, lineWidth: number, glow01: number,
) => {
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  if (glow01 > 0) {
    ctx.shadowBlur = TRAJECTORY_DIRECT_FLASH_GLOW_MAX_BLUR * glow01;
    ctx.shadowColor = `hsla(${RETICULE_DASH_HSL}, ${TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA * glow01})`;
  }
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(TRAJECTORY_ON_RHYTHM_SPOT_DASH);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_ON_RHYTHM_SPOT_RADIUS, 0, TAU);
  ctx.stroke();
  paintOnRhythmCrosshair(ctx, px, py);
  ctx.setLineDash([]);
  ctx.shadowBlur = prevShadowBlur;
  ctx.shadowColor = prevShadowColor;
};

// Why: first beat-dot is a filled dot like the others — just bigger and brighter so it stands out
// as "shoot here next beat". It still picks up proximity glow, direct-flash flicker, entry-flash,
// and the per-beat pulse so it reads as part of the same lock-on language.
const paintFirstBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  proximity01: number, directFlash: number, entryFlashBoost: number, beatPulseBoost: number,
) => {
  const proximityAlpha = TRAJECTORY_FIRST_BEAT_DOT_ALPHA
    + (TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA - TRAJECTORY_FIRST_BEAT_DOT_ALPHA) * proximity01;
  const alpha = Math.min(1, proximityAlpha * (1 + directFlash) * entryFlashBoost * beatPulseBoost);
  const flash01 = directFlash > 0 ? directFlash / TRAJECTORY_DIRECT_FLASH_DEPTH : 0;
  const entryGlow01 = Math.max(0, Math.min(1, (entryFlashBoost - 1) / (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1)));
  const glow01 = Math.max(flash01, entryGlow01);
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  if (glow01 > 0) {
    ctx.shadowBlur = TRAJECTORY_DIRECT_FLASH_GLOW_MAX_BLUR * glow01;
    ctx.shadowColor = `hsla(${RETICULE_DASH_HSL}, ${TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA * glow01})`;
  }
  ctx.fillStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_FIRST_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
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
  flashPulse: number, entryFlashBoost: number, beatPulseBoost: number,
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
      const overlap = firstDotOverlapsReticule(px, py, retX, retY);
      if (SHOW_FIRST_BEAT_DOT) {
        const proximity01 = firstDotProximity01(px, py, retX, retY);
        const directFlash = overlap ? flashPulse : 0;
        paintFirstBeatDot(ctx, px, py, proximity01, directFlash, entryFlashBoost, beatPulseBoost);
      }
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

// Why: on-rhythm aim spot uses the same lock-circle + crosshair visual as the first-beat dot so the
// player reads them as the same kind of cue ("targeting reticule"). Brighter when an on-beat hit
// is geometrically reachable right now, dimmed when it isn't.
const paintOnRhythmSpot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  reachable: boolean, entryFlashBoost: number, beatPulseBoost: number,
) => {
  const baseAlpha = reachable ? TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_REACHABLE : TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_UNREACHABLE;
  const alpha = Math.min(1, baseAlpha * entryFlashBoost * beatPulseBoost);
  const entryGlow01 = Math.max(0, Math.min(1, (entryFlashBoost - 1) / (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1)));
  paintOnRhythmReticule(ctx, px, py, alpha, TRAJECTORY_ON_RHYTHM_SPOT_LINE_WIDTH + (entryFlashBoost - 1), entryGlow01);
};

// Why: the aim circle is the locus of bullet positions on the next beat — any point inside it is
// reachable by some firing direction right now. The best on-beat aim point for a moving target is
// the closest point on/in the aim circle to the target's predicted on-beat position; project that
// back into the target's current frame by subtracting one beat of target travel.
type OnRhythmSpot = { x: number; y: number; reachable: boolean };
const computeOnRhythmSpot = (
  cx: number, cy: number, velX: number, velY: number, radius: number,
  aimCenterX: number, aimCenterY: number, aimRadius: number, beatGrid: number,
): OnRhythmSpot => {
  const futureX = cx + velX * beatGrid;
  const futureY = cy + velY * beatGrid;
  const dx = futureX - aimCenterX;
  const dy = futureY - aimCenterY;
  const dist = Math.hypot(dx, dy);
  let bestX: number;
  let bestY: number;
  if (dist <= aimRadius || dist < 1e-6) {
    bestX = futureX;
    bestY = futureY;
  } else {
    bestX = aimCenterX + (dx / dist) * aimRadius;
    bestY = aimCenterY + (dy / dist) * aimRadius;
  }
  const missDist = Math.max(0, dist - aimRadius);
  const reachable = missDist <= radius + BULLET_HIT_RADIUS_ON_BEAT;
  return { x: bestX - velX * beatGrid, y: bestY - velY * beatGrid, reachable };
};

// Why: core trajectory renderer — operates on a position/velocity snapshot, with optional cone clipping.
// alphaMultiplier folds in entry-flash boost and exit-fade decay; clipToCone is false during fade so the
// lingering ghost remains visible even after the target has left the radar wedge.
const paintTrajectoryFromSnapshot = (
  ctx: TrajectoryContext, snap: TrajectorySnapshot, firstSeen: number,
  alphaMultiplier: number, flashPulse: number, clipToCone: boolean,
  showOnRhythmSpot: boolean,
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
  const beatPulseBoost = computeBeatPulseBoost(ctx.beatTime, ctx.beatGrid);
  // Why: during the entry-flash window, override the pulse ramp so brightness peaks immediately rather
  // than easing in — the flash is the visual cue that the contact JUST appeared.
  const effectivePulse = entryFlashBoost > 1 ? Math.max(pulse, 1) : pulse;
  ctx.ctx.globalAlpha = Math.min(1, TRAJECTORY_ALPHA * effectivePulse * alphaMultiplier);

  const [retX, retY] = remapReticuleToTarget(ctx.apex, ctx.reticulePos, ctx.w, ctx.h);
  const [aimCenterX, aimCenterY] = remapReticuleToTarget(ctx.apex, ctx.aimCircleCenter, ctx.w, ctx.h);
  const dotStep = speed * ctx.beatGrid;
  const dotOffset = -(r + edgePad);
  ctx.ctx.save();
  ctx.ctx.setLineDash([]);
  if (SHOW_AIM_INTERSECTION_X) {
    drawAimIntersectionsAlongRay(
      ctx.ctx, rawStartX, rawStartY, ux, uy, aimCenterX, aimCenterY,
      ctx.aimCircleRadius, sMin, sMax, entryFlashBoost,
    );
  }
  const result = drawBeatDotsAlongRay(
    ctx.ctx, rawStartX, rawStartY, ux, uy, retX, retY,
    sMin, sMax, dotStep, dotOffset, flashPulse, entryFlashBoost, beatPulseBoost,
  );
  if (SHOW_ON_RHYTHM_RETICULE && showOnRhythmSpot) {
    const spot = computeOnRhythmSpot(
      cx, cy, snap.velX, snap.velY, r,
      aimCenterX, aimCenterY, ctx.aimCircleRadius, ctx.beatGrid,
    );
    paintOnRhythmSpot(ctx.ctx, spot.x, spot.y, spot.reachable, entryFlashBoost, beatPulseBoost);
  }
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
  showSpot: boolean,
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
  return paintTrajectoryFromSnapshot(ctx, track.snapshot, track.firstSeen, 1, flashPulse, targetInCone, showSpot);
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
    paintTrajectoryFromSnapshot(ctx, track.snapshot, track.firstSeen, fade, flashPulse, false, false);
  }
};

// Why: of all visible targets, pick the one whose center sits nearest the radar axis line — that's
// the single target the on-rhythm aim spot will be drawn for. Returns null if no eligible target.
const pickCenterMostTarget = (
  ctx: TrajectoryContext, targets: ReadonlyArray<ReticuleTarget>,
): ReticuleTarget | null => {
  let best: ReticuleTarget | null = null;
  let bestPerp = Infinity;
  for (const t of targets) {
    const [dx, dy] = toroidalDelta(t.pos.x - ctx.apex.x, t.pos.y - ctx.apex.y, ctx.w, ctx.h);
    const tr = t.radius ?? 0;
    const targetInCone = targetIsInsideCone(dx, dy, tr, ctx.frame);
    const rayInCone = !targetInCone && trajectoryRayOverlapsCone(dx, dy, t, ctx.frame);
    if (!targetInCone && !rayInCone) continue;
    const forward = dx * ctx.frame.axisX + dy * ctx.frame.axisY;
    if (forward <= 0) continue;
    const perp = Math.abs(dx * ctx.frame.axisY - dy * ctx.frame.axisX);
    if (perp < bestPerp) { bestPerp = perp; best = t; }
  }
  return best;
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
  const spotTarget = pickCenterMostTarget(ctx, targets);
  let overlapsReticule = false;
  for (const t of targets) {
    if (previewLiveTarget(ctx, t, flashPulse, rendered, t === spotTarget)) overlapsReticule = true;
  }
  renderFadingTrajectories(ctx, rendered, flashPulse);
  ctx.ctx.restore();
  return overlapsReticule;
};
