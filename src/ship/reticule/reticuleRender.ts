import type { Ship } from "../../Ship";
import { Vec, add, mul, fromAngle, wrap, TAU } from "../../vec";
import { computeConeFrame } from "./coneGeometry";
import { paintConeBackground, paintRangeArcs } from "./radarCone";
import { paintTrajectoryPreviews, ReticuleTarget, TrajectoryTrackMap, computeBeatPulseBoost } from "./trajectoryPreview";
import {
  reticuleOverlapsAnyTarget, reticuleDirectlyOnTarget,
  computeBaseHitAlpha, paintAimDiscs, computeDirectFlashPulse,
} from "./aimDisc";

// hitbox alpha breathes slowly so the disc feels alive even when no target is in range.
const RETICULE_HITBOX_PULSE_MAX = 1.0;
const RETICULE_HITBOX_PULSE_MIN = 0.75;
const RETICULE_HITBOX_PULSE_PERIOD_SEC = 2.0;
const RETICULE_RADAR_PULSE_MAX = 1;
const RETICULE_RADAR_PULSE_MIN = 0.4;
const RETICULE_RADAR_PULSE_PERIOD_SEC = 3.0;

// matches TRIDENT_SPREAD in shipWeapons.ts — three bullets fan at ±this angle.
const TRIDENT_SPREAD = 0.21;
// rapid fires every half-beat, so the off-beat bullet only travels half as far before the next beat.
const RAPID_HALF_BEAT_FRACTION = 0.5;

// bind ship state to per-target memo so trajectory previews can track entry-flash and fade across frames.
type ReticuleState = { trajectoryTracks: TrajectoryTrackMap };

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

// trident fans the aim into three angles; rapid adds a half-beat preview at half distance;
// integer-k reticules mark every beat-slot the bullet actually crosses (t = beatGrid*k < life),
// so the count adapts to longshot/pierce range and to the rhythm-gate tempo (eighth-grid at
// combo ≥ 12 or under rapid). Returns { positions, primaryIndex } so the caller can identify
// the centred 1-beat reticule (the anchor for the trajectory's first-dot overlap check).
type ReticulePositions = { positions: Vec[]; primaryIndex: number };
const computeReticulePositions = (
  ship: Ship, beatGrid: number, w: number, h: number,
): ReticulePositions => {
  const angleOffsets = ship.tridentActive ? [-TRIDENT_SPREAD, 0, TRIDENT_SPREAD] : [0];
  const bulletLife = effectiveBulletLife(ship);
  const slotCount = Math.max(1, Math.floor(bulletLife / beatGrid));
  const integerFractions: number[] = [];
  for (let k = 1; k <= slotCount; k++) integerFractions.push(k);
  const beatFractions = ship.rapidActive ? [RAPID_HALF_BEAT_FRACTION, ...integerFractions] : integerFractions;
  const positions: Vec[] = [];
  let primaryIndex = 0;
  for (const frac of beatFractions) {
    for (const off of angleOffsets) {
      const idx = positions.length;
      positions.push(computeReticulePosition(ship, beatGrid, w, h, off, frac));
      // primary = centred (off==0) shot landing at exactly 1 beat — the "shoot now to hit next beat"
      // reticule. With longshot active that's not the last entry, so explicitly capture the index.
      if (off === 0 && frac === 1) primaryIndex = idx;
    }
  }
  return { positions, primaryIndex };
};

// cosine envelope between min/max produces a smooth, predictable visual pulse over time.
const cosineEnvelope = (beatTime: number, period: number, min: number, max: number): number => {
  const v = 0.5 + 0.5 * Math.cos((beatTime / period) * TAU);
  return min + (max - min) * v;
};

// single entry point — composes background, range arcs, trajectory previews, then aim discs in order.
export const renderShipReticules = (
  ship: Ship, state: ReticuleState,
  ctx: CanvasRenderingContext2D, beatGrid: number, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>, beatTime: number,
) => {
  if (!ship.alive) return;
  const { positions: reticulePositions, primaryIndex } = computeReticulePositions(ship, beatGrid, w, h);
  const primaryReticule = reticulePositions[primaryIndex];
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
  const fromTrajectory = paintTrajectoryPreviews({
    ctx, apex, beatGrid, beatTime, w, h, frame, reticulePos: primaryReticule, aimCircleCenter, aimCircleRadius,
    trajectoryTracks: state.trajectoryTracks,
  }, targets);
  const flashPulse = computeDirectFlashPulse(beatTime);
  for (let i = 0; i < reticulePositions.length; i++) {
    const pos = reticulePositions[i];
    const overlaps = fromTrajectory && i === primaryIndex
      ? true
      : reticuleOverlapsAnyTarget(pos, targets, w, h);
    const directlyOn = reticuleDirectlyOnTarget(pos, targets, w, h);
    paintAimDiscs(ctx, pos, baseHitAlpha, overlaps, directlyOn ? flashPulse : 0);
  }
  ctx.restore();
};
