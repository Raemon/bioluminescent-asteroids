import type { Ship } from "../../Ship";
import { Vec, add, mul, fromAngle, wrap, TAU } from "../../vec";
import { computeConeFrame } from "./coneGeometry";
import { paintConeBackground, paintRangeArcs } from "./radarCone";
import { paintTrajectoryPreviews, ReticuleTarget, TrajectoryTrackMap } from "./trajectoryPreview";
import {
  reticuleOverlapsAnyTarget, reticuleDirectlyOnTarget,
  computeBaseHitAlpha, paintAimDiscs, computeDirectFlashPulse,
} from "./aimDisc";

// Why: hitbox alpha breathes slowly so the disc feels alive even when no target is in range.
const RETICULE_HITBOX_PULSE_MAX = 1.0;
const RETICULE_HITBOX_PULSE_MIN = 0.75;
const RETICULE_HITBOX_PULSE_PERIOD_SEC = 2.0;
const RETICULE_RADAR_PULSE_MAX = 1;
const RETICULE_RADAR_PULSE_MIN = 0.4;
const RETICULE_RADAR_PULSE_PERIOD_SEC = 3.0;

// Why: matches TRIDENT_SPREAD in shipWeapons.ts — three bullets fan at ±this angle.
const TRIDENT_SPREAD = 0.21;
// Why: rapid fires every half-beat, so the off-beat bullet only travels half as far before the next beat.
const RAPID_HALF_BEAT_FRACTION = 0.5;

// Why: bind ship state to per-target memo so trajectory previews can track entry-flash and fade across frames.
type ReticuleState = { trajectoryTracks: TrajectoryTrackMap };

// Why: position where a shot fired with the given heading offset lands after `beatFraction` of a beat.
const computeReticulePosition = (
  ship: Ship, beatGrid: number, w: number, h: number,
  headingOffset: number, beatFraction: number,
): Vec => {
  const dir = fromAngle(ship.heading + headingOffset, 1);
  const muzzle = add(ship.pos, mul(dir, ship.radius + 4));
  const bulletVel = add(mul(dir, ship.bulletSpeed), mul(ship.vel, 0.4));
  return wrap(add(muzzle, mul(bulletVel, beatGrid * beatFraction)), w, h);
};

// Why: trident fans the aim into three angles; rapid adds a half-beat preview at half distance.
const computeReticulePositions = (
  ship: Ship, beatGrid: number, w: number, h: number,
): Vec[] => {
  const angleOffsets = ship.tridentActive ? [-TRIDENT_SPREAD, 0, TRIDENT_SPREAD] : [0];
  const beatFractions = ship.rapidActive ? [RAPID_HALF_BEAT_FRACTION, 1] : [1];
  const positions: Vec[] = [];
  for (const frac of beatFractions) {
    for (const off of angleOffsets) {
      positions.push(computeReticulePosition(ship, beatGrid, w, h, off, frac));
    }
  }
  return positions;
};

// Why: cosine envelope between min/max produces a smooth, predictable visual pulse over time.
const cosineEnvelope = (beatTime: number, period: number, min: number, max: number): number => {
  const v = 0.5 + 0.5 * Math.cos((beatTime / period) * TAU);
  return min + (max - min) * v;
};

// Why: single entry point — composes background, range arcs, trajectory previews, then aim discs in order.
export const renderShipReticules = (
  ship: Ship, state: ReticuleState,
  ctx: CanvasRenderingContext2D, beatGrid: number, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>, beatTime: number,
) => {
  if (!ship.alive) return;
  const reticulePositions = computeReticulePositions(ship, beatGrid, w, h);
  const primaryReticule = reticulePositions[reticulePositions.length - 1];
  const apex = ship.pos;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const hitboxPulse = cosineEnvelope(beatTime, RETICULE_HITBOX_PULSE_PERIOD_SEC, RETICULE_HITBOX_PULSE_MIN, RETICULE_HITBOX_PULSE_MAX);
  const radarPulse = cosineEnvelope(beatTime, RETICULE_RADAR_PULSE_PERIOD_SEC, RETICULE_RADAR_PULSE_MIN, RETICULE_RADAR_PULSE_MAX);
  const baseHitAlpha = computeBaseHitAlpha(ship.fireCooldown > 0, hitboxPulse);
  paintConeBackground(ctx, ship, apex, beatTime, beatGrid);
  paintRangeArcs(ctx, ship, apex, beatTime, radarPulse);
  const frame = computeConeFrame(ship);
  const fromTrajectory = paintTrajectoryPreviews({
    ctx, apex, beatGrid, beatTime, w, h, frame, reticulePos: primaryReticule,
    trajectoryTracks: state.trajectoryTracks,
  }, targets);
  const flashPulse = computeDirectFlashPulse(beatTime);
  for (const pos of reticulePositions) {
    const overlaps = fromTrajectory && pos === primaryReticule
      ? true
      : reticuleOverlapsAnyTarget(pos, targets, w, h);
    const directlyOn = reticuleDirectlyOnTarget(pos, targets, w, h);
    paintAimDiscs(ctx, pos, baseHitAlpha, overlaps, directlyOn ? flashPulse : 0);
  }
  ctx.restore();
};
