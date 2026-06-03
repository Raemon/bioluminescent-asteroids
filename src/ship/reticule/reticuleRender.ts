import type { Ship } from "../../Ship";
import type { Sound } from "../../Sound";
import { Vec, add, mul, fromAngle, wrap, TAU } from "../../vec";
import { computeConeFrame } from "./coneGeometry";
import { paintConeBackground, paintRangeArcs, RETICULE_DASH_HSL } from "./radarCone";
import { paintTrajectoryPreviews, ReticuleTarget, TrajectoryTrackMap, computeBeatPulseBoost } from "./trajectoryPreview";
import {
  reticuleOverlapsAnyTarget,
  paintAimDiscs,
} from "./aimDisc";
import { PRONG_SPREAD } from "../shipWeapons";

// hitbox alpha for the not-hovering reticule — this IS the final alpha (no hidden downstream
// multipliers), so tweak these to brighten/dim the resting reticule directly.
const RETICULE_HITBOX_PULSE_MAX = 0.32;
const RETICULE_HITBOX_PULSE_MIN = 0.20;
const RETICULE_HITBOX_PULSE_PERIOD_SEC = 2.0;
// dim during fire cooldown so the player feels the rhythm window even with nothing in sight.
const RETICULE_COOLDOWN_DIM = 0.3;
const RETICULE_RADAR_PULSE_MAX = 1;
const RETICULE_RADAR_PULSE_MIN = 0.4;
const RETICULE_RADAR_PULSE_PERIOD_SEC = 3.0;

// doubletime (rapid powerup or combo ≥ 12) fires every half-beat, so the off-beat bullet
// only travels half as far before the next beat.
const HALF_BEAT_FRACTION = 0.5;

// bind ship state to per-target memo so trajectory previews can track entry-flash and fade across frames.
// hoverDotRings: one entry per reachable on-beat slot (index 0 = 1-beat, 1 = 2-beat, ...). Array is
// owned by Ship and grown lazily as bullet range extends; renderer pads it here if it needs more.
type HoverRingState = {
  hoverStartBeatTime: number | null;
  completionBeatTime: number | null;
};
type ReticuleState = {
  trajectoryTracks: TrajectoryTrackMap;
  hoverDotRings: HoverRingState[];
};

// 16 arcs filled evenly across HOVER_RING_FILL_SEC — completion lines up with the tutorial
// gate (fill + completion-flare animation = TUTORIAL_HOVER_SEC).
const HOVER_DOT_COUNT = 16;
// each slot is TAU/16; arc fills half the slot so arc-length == gap-length around the ring.
const HOVER_ARC_SWEEP = (TAU / HOVER_DOT_COUNT) * 0.5;
const HOVER_ARC_LINE_WIDTH = 1.5;
// sits just past the crosshair tips so arcs don't crowd the aim disc.
const HOVER_DOT_RING_RADIUS = 26;
const HOVER_DOT_BUILDING_ALPHA = 0.45;
// full ring fills in 1.0s; per-arc fade-in is just under one slot so the leading edge sweeps
// before the next arc starts. Completion flare runs for FLARE_SEC afterward.
const HOVER_RING_FILL_SEC = 1.0;
const HOVER_RING_SLOT_SEC = HOVER_RING_FILL_SEC / HOVER_DOT_COUNT;
const HOVER_ARC_FADE_IN_SEC = HOVER_RING_SLOT_SEC * 0.9;
// once complete, arcs breathe 1.0 → reticule's hovered base alpha so peak = "this shot lands".
const HOVER_DOT_PULSE_PEAK_ALPHA = 1.0;
const HOVER_DOT_PULSE_MIN_ALPHA = 0.28;
const HOVER_DOT_PULSE_PERIOD_SEC = 2.0;
const HOVER_DOT_HSL = RETICULE_DASH_HSL;
// completion flare: brightens the ring + paints additive halos + radial spokes for FLARE_SEC,
// rising sharply then settling. Marks "lock acquired" — the octave-up hum starts here too.
// Tutorial gate fires on elapsed >= TUTORIAL_HOVER_SEC independently; the flare visual can
// outrun it.
const HOVER_FLARE_SEC = 0.7;
const HOVER_FLARE_PEAK_BOOST = 4.0;
const HOVER_FLARE_RING_LINE_WIDTH = 3.0;
const HOVER_FLARE_RING_PEAK_ALPHA = 0.95;
// shockwave: a single bright ring expands outward from the dot ring.
const HOVER_FLARE_SHOCKWAVE_START_R = HOVER_DOT_RING_RADIUS + 2;
const HOVER_FLARE_SHOCKWAVE_END_R = HOVER_DOT_RING_RADIUS + 38;
const HOVER_FLARE_SHOCKWAVE_LINE_WIDTH = 2.4;
const HOVER_FLARE_SHOCKWAVE_PEAK_ALPHA = 0.9;
// inner pulse ring that contracts slightly then fades — adds a "snap" at the very centre.
const HOVER_FLARE_INNER_START_R = HOVER_DOT_RING_RADIUS - 2;
const HOVER_FLARE_INNER_END_R = HOVER_DOT_RING_RADIUS - 10;
// radial light spokes for a starburst pop.
const HOVER_FLARE_SPOKE_COUNT = 12;
const HOVER_FLARE_SPOKE_INNER_R = HOVER_DOT_RING_RADIUS + 3;
const HOVER_FLARE_SPOKE_OUTER_R = HOVER_DOT_RING_RADIUS + 28;
const HOVER_FLARE_SPOKE_LINE_WIDTH = 1.6;
const HOVER_FLARE_SPOKE_PEAK_ALPHA = 0.85;
// central bright flash dot.
const HOVER_FLARE_CORE_R = 8;
const HOVER_FLARE_CORE_PEAK_ALPHA = 0.7;
// gold hue at the peak — drift the dash colour toward warm/white so the lock reads as "reward".
const HOVER_FLARE_WARM_HSL = "48, 100%, 70%";

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

// effective bullet lifetime mirrors shipWeapons.launchBullet (and the post-fire superBoosted
// stretch in handleOnBeatFire) so reticule range tracks what the actual shot does: pierce,
// longshot, and superBoosted (combo ≥ 8) each double flight time.
const effectiveBulletLife = (ship: Ship, superBoosted: boolean): number => {
  let life = ship.bulletLife;
  if (ship.pierceActive) life *= 2;
  if (ship.longshotActive) life *= 2;
  if (superBoosted) life *= 2;
  return life;
};

// prong fans the aim into two angles (no centred shot); doubletime adds a half-beat preview at
// half distance; integer-k reticules mark every beat-slot the bullet actually crosses
// (t = beatGrid*k < life), so the count adapts to longshot/pierce/superBoosted range and to
// the rhythm-gate tempo (eighth-grid at combo ≥ 12 or under rapid). slotIndices[k-1] points at
// the centred k-beat reticule (anchor for that slot's hover-ring + drift-shot), or -1 when prong
// is active (no centred shot) or that slot is out of range.
type ReticulePositions = { positions: Vec[]; primaryIndex: number; slotIndices: number[] };
const computeReticulePositions = (
  ship: Ship, beatGrid: number, w: number, h: number, doubletime: boolean, superBoosted: boolean,
): ReticulePositions => {
  const angleOffsets = ship.prongActive ? [-PRONG_SPREAD, PRONG_SPREAD] : [0];
  const bulletLife = effectiveBulletLife(ship, superBoosted);
  const slotCount = Math.max(1, Math.floor(bulletLife / beatGrid));
  const integerFractions: number[] = [];
  for (let k = 1; k <= slotCount; k++) integerFractions.push(k);
  const beatFractions = doubletime ? [HALF_BEAT_FRACTION, ...integerFractions] : integerFractions;
  const positions: Vec[] = [];
  let primaryIndex = -1;
  const slotIndices: number[] = new Array(slotCount).fill(-1);
  for (const frac of beatFractions) {
    for (const off of angleOffsets) {
      const idx = positions.length;
      positions.push(computeReticulePosition(ship, beatGrid, w, h, off, frac));
      if (off === 0 && frac === 1) primaryIndex = idx;
      if (off === 0 && Number.isInteger(frac) && frac >= 1 && frac <= slotCount) {
        slotIndices[frac - 1] = idx;
      }
    }
  }
  return { positions, primaryIndex, slotIndices };
};

// arcs fill across HOVER_RING_FILL_SEC, then a HOVER_FLARE_SEC completion flare brightens them
// and adds an expanding shockwave + radial starburst + bright core before settling into the
// steady on-beat pulse. The build resets on hover-loss in the caller. Returns whether the ring
// just crossed into "filled" this frame (rising-edge signal for the audio companion).
const paintHoverDotRing = (
  ctx: CanvasRenderingContext2D, center: Vec, elapsed: number, beatTime: number,
): { fillJustCompleted: boolean } => {
  const slotDuration = HOVER_RING_SLOT_SEC;
  const visibleCount = Math.min(HOVER_DOT_COUNT, Math.floor(elapsed / slotDuration) + 1);
  const fullyBuilt = visibleCount >= HOVER_DOT_COUNT
    && (elapsed - (HOVER_DOT_COUNT - 1) * slotDuration) >= HOVER_ARC_FADE_IN_SEC;
  const fillCompleteSec = HOVER_RING_FILL_SEC;
  const flareAge = fullyBuilt ? Math.max(0, elapsed - fillCompleteSec) : -1;
  const flareT = flareAge >= 0 ? Math.min(1, flareAge / HOVER_FLARE_SEC) : 0;
  // burst envelope: very fast rise (peaks at t≈0.25), long fall — reads as a "snap, glow, fade".
  const burstEnvelope = flareT > 0 && flareT < 1
    ? Math.pow(Math.sin(flareT * Math.PI), 0.6) * Math.pow(1 - flareT, 0.5)
    : 0;
  // shockwave envelope: linear rise to peak alpha then long radial expansion to outer radius.
  const shockwaveEnvelope = flareT > 0 && flareT < 1 ? Math.sin(flareT * Math.PI) : 0;
  const baseAlpha = fullyBuilt
    ? cosineEnvelope(beatTime, HOVER_DOT_PULSE_PERIOD_SEC, HOVER_DOT_PULSE_MIN_ALPHA, HOVER_DOT_PULSE_PEAK_ALPHA)
    : HOVER_DOT_BUILDING_ALPHA;
  const arcAlphaBoost = 1 + (HOVER_FLARE_PEAK_BOOST - 1) * burstEnvelope;
  // arcs drift from cool dash colour toward warm gold at the peak of the burst.
  const arcHsl = burstEnvelope > 0
    ? lerpHsl(HOVER_DOT_HSL, HOVER_FLARE_WARM_HSL, burstEnvelope)
    : HOVER_DOT_HSL;
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
    const alpha = Math.min(1, baseAlpha * alphaEase * arcAlphaBoost);
    ctx.strokeStyle = `hsla(${arcHsl}, ${alpha})`;
    const mid = start + i * slot;
    // grow from the counter-clockwise end (fixed) toward the clockwise end (advancing).
    const ccwEnd = mid - HOVER_ARC_SWEEP / 2;
    const cwEnd = ccwEnd + HOVER_ARC_SWEEP * sweepEase;
    ctx.beginPath();
    ctx.arc(center.x, center.y, HOVER_DOT_RING_RADIUS, ccwEnd, cwEnd);
    ctx.stroke();
  }
  if (flareT > 0 && flareT < 1) {
    paintFlareBurst(ctx, center, flareT, burstEnvelope, shockwaveEnvelope);
  }
  return { fillJustCompleted: fullyBuilt };
};

// the celebratory burst layered on top of the ring once lock completes: an expanding shockwave
// ring, an inward-snapping inner ring, a starburst of radial spokes, and a bright central core.
// All in warm gold so the lock reads as a reward against the cool cyan reticule colour.
const paintFlareBurst = (
  ctx: CanvasRenderingContext2D, center: Vec, flareT: number, burstEnvelope: number, shockwaveEnvelope: number,
) => {
  ctx.lineCap = "round";
  // expanding outer shockwave — radius interpolates start→end across the full flare.
  if (shockwaveEnvelope > 0) {
    const r = HOVER_FLARE_SHOCKWAVE_START_R + (HOVER_FLARE_SHOCKWAVE_END_R - HOVER_FLARE_SHOCKWAVE_START_R) * flareT;
    ctx.lineWidth = HOVER_FLARE_SHOCKWAVE_LINE_WIDTH;
    ctx.strokeStyle = `hsla(${HOVER_FLARE_WARM_HSL}, ${HOVER_FLARE_SHOCKWAVE_PEAK_ALPHA * shockwaveEnvelope})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, TAU);
    ctx.stroke();
  }
  // ring at the dot ring itself — a brief, very bright overlay that peaks early with the burst.
  if (burstEnvelope > 0) {
    ctx.lineWidth = HOVER_FLARE_RING_LINE_WIDTH;
    ctx.strokeStyle = `hsla(${HOVER_FLARE_WARM_HSL}, ${HOVER_FLARE_RING_PEAK_ALPHA * burstEnvelope})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, HOVER_DOT_RING_RADIUS, 0, TAU);
    ctx.stroke();
  }
  // inner pulse: contracts inward as it fades — gives the burst a sucking-in counterpart.
  if (burstEnvelope > 0) {
    const r = HOVER_FLARE_INNER_START_R + (HOVER_FLARE_INNER_END_R - HOVER_FLARE_INNER_START_R) * flareT;
    ctx.lineWidth = HOVER_FLARE_RING_LINE_WIDTH * 0.7;
    ctx.strokeStyle = `hsla(${HOVER_FLARE_WARM_HSL}, ${HOVER_FLARE_RING_PEAK_ALPHA * 0.6 * burstEnvelope})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, Math.max(2, r), 0, TAU);
    ctx.stroke();
  }
  // radial spokes shooting outward — the "starburst" pop.
  if (burstEnvelope > 0) {
    ctx.lineWidth = HOVER_FLARE_SPOKE_LINE_WIDTH;
    const spokeAlpha = HOVER_FLARE_SPOKE_PEAK_ALPHA * burstEnvelope;
    // spokes extend with flareT so they read as light streaking outward.
    const outerR = HOVER_FLARE_SPOKE_INNER_R + (HOVER_FLARE_SPOKE_OUTER_R - HOVER_FLARE_SPOKE_INNER_R) * flareT;
    ctx.strokeStyle = `hsla(${HOVER_FLARE_WARM_HSL}, ${spokeAlpha})`;
    for (let i = 0; i < HOVER_FLARE_SPOKE_COUNT; i++) {
      const angle = (i / HOVER_FLARE_SPOKE_COUNT) * TAU;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(center.x + cos * HOVER_FLARE_SPOKE_INNER_R, center.y + sin * HOVER_FLARE_SPOKE_INNER_R);
      ctx.lineTo(center.x + cos * outerR, center.y + sin * outerR);
      ctx.stroke();
    }
  }
  // bright central core — a small filled disc that pops at the peak and fades.
  if (burstEnvelope > 0) {
    ctx.fillStyle = `hsla(${HOVER_FLARE_WARM_HSL}, ${HOVER_FLARE_CORE_PEAK_ALPHA * burstEnvelope})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, HOVER_FLARE_CORE_R * (1 + 0.4 * burstEnvelope), 0, TAU);
    ctx.fill();
  }
};

// linear interp between two HSL strings of the form "H, S%, L%". Used to drift the ring colour
// from cyan to warm gold at the peak of the lock-in flare.
const lerpHsl = (a: string, b: string, t: number): string => {
  const pa = a.split(",").map((s) => parseFloat(s));
  const pb = b.split(",").map((s) => parseFloat(s));
  const h = pa[0] + (pb[0] - pa[0]) * t;
  const s = pa[1] + (pb[1] - pa[1]) * t;
  const l = pa[2] + (pb[2] - pa[2]) * t;
  return `${h}, ${s}%, ${l}%`;
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
  superBoosted: boolean = false,
) => {
  if (!ship.alive) return;
  const { positions: reticulePositions, primaryIndex, slotIndices } = computeReticulePositions(ship, beatGrid, w, h, doubletime, superBoosted);
  // trajectory preview anchors on the centred "shoot now to hit next beat" spot. With prong
  // active there's no drawn reticule there, so compute the anchor directly from ship heading.
  const primaryReticule = primaryIndex >= 0
    ? reticulePositions[primaryIndex]
    : computeReticulePosition(ship, beatGrid, w, h, 0, 1);
  // one entry per reachable on-beat slot; null where no centred reticule exists for that slot
  // (e.g. prong fans the shot, so no slot has a centred point to hover).
  const reticulePosBySlot: Array<Vec | null> = slotIndices.map(i => i >= 0 ? reticulePositions[i] : null);
  // grow the Ship's hover-ring array to match if range extended this frame; never shrink (so a
  // brief range loss doesn't wipe a partially-locked ring).
  while (state.hoverDotRings.length < slotIndices.length) {
    state.hoverDotRings.push({ hoverStartBeatTime: null, completionBeatTime: null });
  }
  const apex = ship.pos;
  const { center: aimCircleCenter, radius: aimCircleRadius } = computeAimCircle(ship, beatGrid);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const hitboxPulse = cosineEnvelope(beatTime, RETICULE_HITBOX_PULSE_PERIOD_SEC, RETICULE_HITBOX_PULSE_MIN, RETICULE_HITBOX_PULSE_MAX);
  const radarPulse = cosineEnvelope(beatTime, RETICULE_RADAR_PULSE_PERIOD_SEC, RETICULE_RADAR_PULSE_MIN, RETICULE_RADAR_PULSE_MAX);
  const beatPulseBoost = computeBeatPulseBoost(beatTime, beatGrid);
  const cooldownDim = ship.fireCooldown > 0 ? RETICULE_COOLDOWN_DIM : 1;
  const baseHitAlpha = hitboxPulse * cooldownDim * beatPulseBoost;
  paintConeBackground(ctx, ship, apex, beatTime, beatGrid);
  paintRangeArcs(ctx, ship, apex, beatTime, radarPulse);
  const frame = computeConeFrame(ship);
  const trajectoryResult = paintTrajectoryPreviews({
    ctx, apex, beatGrid, beatTime, w, h, frame, reticulePos: primaryReticule,
    reticulePosBySlot, aimCircleCenter, aimCircleRadius,
    trajectoryTracks: state.trajectoryTracks, doubletime, tutorialHighlight,
  }, targets);
  const fromTrajectory = trajectoryResult.overlapsReticule;
  // reverse map: position-index → slot number (1-indexed). For prong, slotIndices entries are
  // -1 so this stays -1 and the reticule uses the default tick length.
  const slotByPosIndex = new Array<number>(reticulePositions.length).fill(-1);
  for (let s = 0; s < slotIndices.length; s++) {
    if (slotIndices[s] >= 0) slotByPosIndex[slotIndices[s]] = s + 1;
  }
  for (let i = 0; i < reticulePositions.length; i++) {
    const pos = reticulePositions[i];
    const onFirstBeatDot = fromTrajectory && i === primaryIndex;
    const overlaps = onFirstBeatDot
      ? true
      : reticuleOverlapsAnyTarget(pos, targets, w, h);
    const slot = slotByPosIndex[i];
    paintAimDiscs(ctx, pos, baseHitAlpha, overlaps, onFirstBeatDot, tutorialHighlight, slot);
  }
  // each slot's ring uses the softer proximity halo (>0 anywhere in the dot glow ramp) so the
  // player gets feedback the moment the reticule grazes the visible circle, not just on strict
  // hit. Per-slot rings are independent; audio is collapsed into one voice that follows the
  // strongest hover and stays locked as long as ANY ring is locked.
  let maxIntensity = 0;
  let anyHover = false;
  let anyLocked = false;
  for (let slot = 0; slot < slotIndices.length; slot++) {
    const idx = slotIndices[slot];
    const proximity = trajectoryResult.slotProximities[slot] ?? 0;
    const hovering = proximity > 0 && idx >= 0;
    const center = hovering ? reticulePositions[idx] : null;
    const intensity = updateHoverRing(state.hoverDotRings[slot], hovering, center, ctx, beatTime, sound);
    if (hovering) anyHover = true;
    if (intensity > maxIntensity) maxIntensity = intensity;
    if (state.hoverDotRings[slot].completionBeatTime !== null) anyLocked = true;
  }
  if (sound) {
    if (anyHover) {
      const beatPhase01 = ((audioBeatTime % beatGrid) + beatGrid) % beatGrid / beatGrid;
      sound.updateFirstDotHum(maxIntensity, beatPhase01, beatGrid);
      if (anyLocked) sound.updateFirstDotLockHum(beatPhase01, beatGrid);
    } else {
      sound.updateFirstDotHum(0);
      sound.stopFirstDotLockHum();
    }
  }
  ctx.restore();
};

// per-ring state machine + visual paint. Returns the hum intensity contributed by this ring
// (0 when not hovering). Audio mixing is left to the caller so a single voice covers both rings.
const updateHoverRing = (
  ring: { hoverStartBeatTime: number | null; completionBeatTime: number | null },
  hovering: boolean, ringCenter: Vec | null,
  ctx: CanvasRenderingContext2D, beatTime: number, sound: Sound | null,
): number => {
  if (!hovering || ringCenter === null) {
    ring.hoverStartBeatTime = null;
    ring.completionBeatTime = null;
    return 0;
  }
  if (ring.hoverStartBeatTime === null) {
    ring.hoverStartBeatTime = beatTime;
    ring.completionBeatTime = null;
  }
  const elapsed = beatTime - ring.hoverStartBeatTime;
  const { fillJustCompleted } = paintHoverDotRing(ctx, ringCenter, elapsed, beatTime);
  if (fillJustCompleted && ring.completionBeatTime === null) {
    ring.completionBeatTime = beatTime;
    if (sound) sound.startFirstDotLockHum();
  }
  const afterDelay = Math.max(0, elapsed - HOVER_HUM_DELAY_SEC);
  const swellLinear = Math.min(1, afterDelay / HOVER_HUM_RAMP_SEC);
  return swellLinear * swellLinear * (3 - 2 * swellLinear);
};
