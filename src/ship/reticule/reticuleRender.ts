import type { Ship } from "../../Ship";
import type { Sound } from "../../Sound";
import { Vec, add, mul, fromAngle, wrap, TAU } from "../../vec";
import { computeConeFrame } from "./coneGeometry";
import { paintConeBackground, paintRangeArcs, RETICULE_DASH_HSL } from "./radarCone";
import { paintTrajectoryPreviews, ReticuleTarget, TrajectoryTrackMap, computeBeatPulseBoost } from "./trajectoryPreview";
import {
  reticuleOverlapsAnyTarget,
  computeBaseHitAlpha, paintAimDiscs,
} from "./aimDisc";
import { PRONG_SPREAD } from "../shipWeapons";

// hitbox alpha breathes slowly so the disc feels alive even when no target is in range.
const RETICULE_HITBOX_PULSE_MAX = 1.0;
const RETICULE_HITBOX_PULSE_MIN = 0.75;
const RETICULE_HITBOX_PULSE_PERIOD_SEC = 2.0;
const RETICULE_RADAR_PULSE_MAX = 1;
const RETICULE_RADAR_PULSE_MIN = 0.4;
const RETICULE_RADAR_PULSE_PERIOD_SEC = 3.0;

// doubletime (rapid powerup or combo ≥ 12) fires every half-beat, so the off-beat bullet
// only travels half as far before the next beat.
const HALF_BEAT_FRACTION = 0.5;

// bind ship state to per-target memo so trajectory previews can track entry-flash and fade across frames.
// hoverDotRing persists the hover-start timestamp so the ring fills one dot per 8th-note across frames.
type ReticuleState = {
  trajectoryTracks: TrajectoryTrackMap;
  hoverDotRing: { hoverStartBeatTime: number | null };
};

// one arc per 8th-note, full ring at 16 × eighthGrid (=4s at the default 0.5s quarter-grid).
const HOVER_DOT_COUNT = 16;
// each slot is TAU/16; arc fills half the slot so arc-length == gap-length around the ring.
const HOVER_ARC_SWEEP = (TAU / HOVER_DOT_COUNT) * 0.5;
const HOVER_ARC_LINE_WIDTH = 1.5;
// sits just past the crosshair tips so arcs don't crowd the aim disc.
const HOVER_DOT_RING_RADIUS = 26;
const HOVER_DOT_BUILDING_ALPHA = 0.45;
// long enough that the arc visibly sweeps out from 0 to full length before settling.
const HOVER_ARC_FADE_IN_SEC = 0.22;
// once complete, arcs breathe 1.0 → reticule's hovered base alpha so peak = "this shot lands".
const HOVER_DOT_PULSE_PEAK_ALPHA = 1.0;
const HOVER_DOT_PULSE_MIN_ALPHA = 0.28;
const HOVER_DOT_PULSE_PERIOD_SEC = 2.0;
const HOVER_DOT_HSL = RETICULE_DASH_HSL;

// the aim circle = locus of bullet endpoints at t=beatGrid over all headings. Single source
// of truth so the reticule painter and the gameRender red-tint check agree on geometry.
export const computeAimCircle = (ship: Ship, beatGrid: number) => ({
  center: add(ship.pos, mul(ship.vel, 0.4 * beatGrid)),
  radius: ship.radius + 4 + ship.bulletSpeed * beatGrid,
});

// position where a shot fired with the given heading offset lands after `beatFraction` of a beat.
const computeReticulePosition = (
  ship: Ship, beatGrid: number, w: number, h: number,
  headingOffset: number, beatFraction: number,
): Vec => {
  const dir = fromAngle(ship.heading + headingOffset, 1);
  const muzzle = add(ship.pos, mul(dir, ship.radius + 4));
  const bulletVel = add(mul(dir, ship.bulletSpeed), mul(ship.vel, 0.4));
  return wrap(add(muzzle, mul(bulletVel, beatGrid * beatFraction)), w, h);
};

// effective bullet lifetime mirrors shipWeapons.launchBullet so reticule range tracks
// what the actual shot does: pierce and longshot each double flight time.
const effectiveBulletLife = (ship: Ship): number => {
  let life = ship.bulletLife;
  if (ship.pierceActive) life *= 2;
  if (ship.longshotActive) life *= 2;
  return life;
};

// prong fans the aim into two angles (no centred shot); doubletime adds a half-beat preview at
// half distance; integer-k reticules mark every beat-slot the bullet actually crosses
// (t = beatGrid*k < life), so the count adapts to longshot/pierce range and to the rhythm-gate
// tempo (eighth-grid at combo ≥ 12 or under rapid). primaryIndex points at the centred 1-beat
// reticule (anchor for the trajectory's first-dot overlap check), or -1 when prong is active —
// there's no centred shot to anchor on, so the trajectory uses the standalone centred position
// for previews instead.
type ReticulePositions = { positions: Vec[]; primaryIndex: number };
const computeReticulePositions = (
  ship: Ship, beatGrid: number, w: number, h: number, doubletime: boolean,
): ReticulePositions => {
  const angleOffsets = ship.prongActive ? [-PRONG_SPREAD, PRONG_SPREAD] : [0];
  const bulletLife = effectiveBulletLife(ship);
  const slotCount = Math.max(1, Math.floor(bulletLife / beatGrid));
  const integerFractions: number[] = [];
  for (let k = 1; k <= slotCount; k++) integerFractions.push(k);
  const beatFractions = doubletime ? [HALF_BEAT_FRACTION, ...integerFractions] : integerFractions;
  const positions: Vec[] = [];
  let primaryIndex = -1;
  for (const frac of beatFractions) {
    for (const off of angleOffsets) {
      const idx = positions.length;
      positions.push(computeReticulePosition(ship, beatGrid, w, h, off, frac));
      if (off === 0 && frac === 1) primaryIndex = idx;
    }
  }
  return { positions, primaryIndex };
};

// arcs fill once per 8th-note, then pulse together; the build resets on hover-loss in the caller.
// Each arc fades in over HOVER_ARC_FADE_IN_SEC from elapsed = i * slotDuration, so newly-born
// arcs ease in smoothly instead of popping.
const paintHoverDotRing = (
  ctx: CanvasRenderingContext2D, center: Vec, elapsed: number, slotDuration: number,
  beatTime: number,
) => {
  const visibleCount = Math.min(HOVER_DOT_COUNT, Math.floor(elapsed / slotDuration) + 1);
  const fullyBuilt = visibleCount >= HOVER_DOT_COUNT
    && (elapsed - (HOVER_DOT_COUNT - 1) * slotDuration) >= HOVER_ARC_FADE_IN_SEC;
  const baseAlpha = fullyBuilt
    ? cosineEnvelope(beatTime, HOVER_DOT_PULSE_PERIOD_SEC, HOVER_DOT_PULSE_MIN_ALPHA, HOVER_DOT_PULSE_PEAK_ALPHA)
    : HOVER_DOT_BUILDING_ALPHA;
  ctx.lineWidth = HOVER_ARC_LINE_WIDTH;
  // round caps soften the leading edge as the arc sweeps outward.
  ctx.lineCap = "round";
  ctx.setLineDash([]);
  // first arc centred at 12 o'clock, then clockwise — reads as a natural "starting point".
  const slot = TAU / HOVER_DOT_COUNT;
  const start = -Math.PI / 2;
  for (let i = 0; i < visibleCount; i++) {
    const age = elapsed - i * slotDuration;
    const t = Math.min(1, Math.max(0, age / HOVER_ARC_FADE_IN_SEC));
    // easeOutCubic: arc shoots out fast then settles, feels springy + joyful.
    const sweepEase = 1 - Math.pow(1 - t, 3);
    // alpha rises slightly ahead of the sweep so the leading edge stays bright.
    const alphaEase = Math.sqrt(t);
    const alpha = baseAlpha * alphaEase;
    ctx.strokeStyle = `hsla(${HOVER_DOT_HSL}, ${alpha})`;
    const mid = start + i * slot;
    // grow from the counter-clockwise end (fixed) toward the clockwise end (advancing).
    const ccwEnd = mid - HOVER_ARC_SWEEP / 2;
    const cwEnd = ccwEnd + HOVER_ARC_SWEEP * sweepEase;
    ctx.beginPath();
    ctx.arc(center.x, center.y, HOVER_DOT_RING_RADIUS, ccwEnd, cwEnd);
    ctx.stroke();
  }
};

// cosine envelope between min/max produces a smooth, predictable visual pulse over time.
const cosineEnvelope = (beatTime: number, period: number, min: number, max: number): number => {
  const v = 0.5 + 0.5 * Math.cos((beatTime / period) * TAU);
  return min + (max - min) * v;
};

// hover hum: holds silent for DELAY (so a passing graze doesn't ping audio), then eases from
// 0 to 1 with a smoothstep so the entrance feels like a swell rising in rather than a switch
// flipping on. The two-stage release is handled inside Sound.stopFirstDotHum.
const HOVER_HUM_DELAY_SEC = 0.15;
const HOVER_HUM_RAMP_SEC = 2.5;

// single entry point — composes background, range arcs, trajectory previews, then aim discs in order.
export const renderShipReticules = (
  ship: Ship, state: ReticuleState,
  ctx: CanvasRenderingContext2D, beatGrid: number, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>, beatTime: number, doubletime: boolean,
  tutorialHighlight: boolean = false,
  sound: Sound | null = null,
  // beatTime here is the latency-shifted (perceived) clock that all the visuals ride.
  //   The hum's accent, by contrast, is *audio* and must land with the rest of the
  //   heard mix on the true grid, so the caller passes the raw clock separately.
  audioBeatTime: number = beatTime,
) => {
  if (!ship.alive) return;
  const { positions: reticulePositions, primaryIndex } = computeReticulePositions(ship, beatGrid, w, h, doubletime);
  // trajectory preview anchors on the centred "shoot now to hit next beat" spot. With prong
  // active there's no drawn reticule there, so compute the anchor directly from ship heading.
  const primaryReticule = primaryIndex >= 0
    ? reticulePositions[primaryIndex]
    : computeReticulePosition(ship, beatGrid, w, h, 0, 1);
  const apex = ship.pos;
  const { center: aimCircleCenter, radius: aimCircleRadius } = computeAimCircle(ship, beatGrid);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const hitboxPulse = cosineEnvelope(beatTime, RETICULE_HITBOX_PULSE_PERIOD_SEC, RETICULE_HITBOX_PULSE_MIN, RETICULE_HITBOX_PULSE_MAX);
  const radarPulse = cosineEnvelope(beatTime, RETICULE_RADAR_PULSE_PERIOD_SEC, RETICULE_RADAR_PULSE_MIN, RETICULE_RADAR_PULSE_MAX);
  const beatPulseBoost = computeBeatPulseBoost(beatTime, beatGrid);
  const baseHitAlpha = computeBaseHitAlpha(ship.fireCooldown > 0, hitboxPulse) * beatPulseBoost;
  paintConeBackground(ctx, ship, apex, beatTime, beatGrid);
  paintRangeArcs(ctx, ship, apex, beatTime, radarPulse);
  const frame = computeConeFrame(ship);
  const trajectoryResult = paintTrajectoryPreviews({
    ctx, apex, beatGrid, beatTime, w, h, frame, reticulePos: primaryReticule, aimCircleCenter, aimCircleRadius,
    trajectoryTracks: state.trajectoryTracks, doubletime, tutorialHighlight,
  }, targets);
  const fromTrajectory = trajectoryResult.overlapsReticule;
  for (let i = 0; i < reticulePositions.length; i++) {
    const pos = reticulePositions[i];
    const onFirstBeatDot = fromTrajectory && i === primaryIndex;
    const overlaps = onFirstBeatDot
      ? true
      : reticuleOverlapsAnyTarget(pos, targets, w, h);
    paintAimDiscs(ctx, pos, baseHitAlpha, overlaps, onFirstBeatDot, tutorialHighlight);
  }
  // ring uses the softer proximity halo (>0 anywhere in the first-dot glow ramp) so the player
  // gets feedback the moment the reticule grazes the visible first circle, not just on strict hit.
  const hoveringFirstDot = trajectoryResult.firstDotProximity > 0 && primaryIndex >= 0;
  if (hoveringFirstDot) {
    if (state.hoverDotRing.hoverStartBeatTime === null) {
      state.hoverDotRing.hoverStartBeatTime = beatTime;
    }
    const elapsed = beatTime - state.hoverDotRing.hoverStartBeatTime;
    // one arc per 16th-note (half an 8th) so the ring fills in ~2s instead of ~4s.
    const sixteenthGrid = beatGrid / 4;
    paintHoverDotRing(ctx, reticulePositions[primaryIndex], elapsed, sixteenthGrid, beatTime);
    if (sound) {
      const afterDelay = Math.max(0, elapsed - HOVER_HUM_DELAY_SEC);
      const swellLinear = Math.min(1, afterDelay / HOVER_HUM_RAMP_SEC);
      // smoothstep so the swell eases in instead of climbing linearly off the silence.
      const intensity = swellLinear * swellLinear * (3 - 2 * swellLinear);
      const beatPhase01 = ((audioBeatTime % beatGrid) + beatGrid) % beatGrid / beatGrid;
      sound.updateFirstDotHum(intensity, beatPhase01, beatGrid);
    }
  } else {
    state.hoverDotRing.hoverStartBeatTime = null;
    if (sound) sound.updateFirstDotHum(0);
  }
  ctx.restore();
};
