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
// lock flare: brightens the dot-ring arcs briefly at lock acquisition. Marks "lock acquired"
// — the octave-up hum starts here too. Tutorial gate fires on elapsed >= TUTORIAL_HOVER_SEC
// independently; the flare visual can outrun it.
const HOVER_FLARE_SEC = 0.7;
const HOVER_FLARE_PEAK_BOOST = 4.0;
// soundwave rings: one new concentric ring emitted every WAVE_PERIOD_BEATS while the player
// holds hover. Each ring expands outward from the dot ring and fades — reads as a radar ping
// pulsing in time with the music. WAVE_LIFETIME_BEATS controls how long a single wave lives
// before fully fading; > PERIOD means consecutive waves overlap for a continuous feel.
const HOVER_WAVE_PERIOD_BEATS = 2;
const HOVER_WAVE_LIFETIME_BEATS = 3.0;
// fire the first soundwave one beat before the ring finishes filling — the pulse anticipates
// the lock instead of trailing it.
const HOVER_WAVE_LEAD_BEATS = 1;
const HOVER_WAVE_START_R = HOVER_DOT_RING_RADIUS + 2;
const HOVER_WAVE_END_R = HOVER_DOT_RING_RADIUS + 44;
const HOVER_WAVE_LINE_WIDTH = 2.0;
const HOVER_WAVE_PEAK_ALPHA = 0.7;
// lock-event wave: a single brighter wave fired the moment the ring completes filling, so
// lock acquisition still reads as a distinct beat even though the steady soundwave pulse
// is already running.
const HOVER_LOCK_WAVE_PEAK_ALPHA = 0.95;
const HOVER_LOCK_WAVE_LINE_WIDTH = 2.8;
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
// stretch in handleOnBeatFire) so reticule range tracks what the actual shot does: pierce
// doubles flight time; longshot and superBoosted (combo ≥ 12) each multiply by 1.5.
const effectiveBulletLife = (ship: Ship, superBoosted: boolean): number => {
  let life = ship.bulletLife;
  if (ship.pierceActive) life *= 2;
  if (ship.longshotActive) life *= 1.5;
  if (superBoosted) life *= 1.5;
  return life;
};

// prong fans the aim into two angles (no centred shot); doubletime adds a half-beat preview at
// half distance; integer-k reticules mark every beat-slot the bullet actually crosses
// (t = beatGrid*k < life), so the count adapts to longshot/pierce/superBoosted range and to
// the rhythm-gate tempo (eighth-grid at combo ≥ 12 or under rapid). slotPositionIndices[k-1]
// lists every position index that anchors the k-beat slot — one entry for the centred shot,
// two for prong. The slot's hover ring locks the moment the trajectory dot grazes ANY of them.
type ReticulePositions = { positions: Vec[]; primaryIndex: number; slotPositionIndices: number[][] };
const computeReticulePositions = (
  ship: Ship, beatGrid: number, w: number, h: number, doubletime: boolean, superBoosted: boolean,
): ReticulePositions => {
  const angleOffsets = ship.prongActive ? [-PRONG_SPREAD, PRONG_SPREAD] : [0];
  const primaryOffset = angleOffsets[0];
  const bulletLife = effectiveBulletLife(ship, superBoosted);
  const slotCount = Math.max(1, Math.floor(bulletLife / beatGrid));
  const integerFractions: number[] = [];
  for (let k = 1; k <= slotCount; k++) integerFractions.push(k);
  const beatFractions = doubletime ? [HALF_BEAT_FRACTION, ...integerFractions] : integerFractions;
  const positions: Vec[] = [];
  let primaryIndex = -1;
  const slotPositionIndices: number[][] = Array.from({ length: slotCount }, () => []);
  for (const frac of beatFractions) {
    for (const off of angleOffsets) {
      const idx = positions.length;
      positions.push(computeReticulePosition(ship, beatGrid, w, h, off, frac));
      if (off === primaryOffset && frac === 1) primaryIndex = idx;
      if (Number.isInteger(frac) && frac >= 1 && frac <= slotCount) {
        slotPositionIndices[frac - 1].push(idx);
      }
    }
  }
  return { positions, primaryIndex, slotPositionIndices };
};

// arcs fill across HOVER_RING_FILL_SEC, then a brief HOVER_FLARE_SEC arc-brightening marks
// lock acquisition. While the ring is fully built, concentric soundwave rings radiate
// outward in time with the beat for as long as the player holds hover. Returns whether the
// ring just crossed into "filled" this frame (rising-edge signal for the audio companion).
const paintHoverDotRing = (
  ctx: CanvasRenderingContext2D, center: Vec, elapsed: number, beatTime: number, beatGrid: number,
): { fillJustCompleted: boolean } => {
  const slotDuration = HOVER_RING_SLOT_SEC;
  const visibleCount = Math.min(HOVER_DOT_COUNT, Math.floor(elapsed / slotDuration) + 1);
  const fullyBuilt = visibleCount >= HOVER_DOT_COUNT
    && (elapsed - (HOVER_DOT_COUNT - 1) * slotDuration) >= HOVER_ARC_FADE_IN_SEC;
  const fillCompleteSec = HOVER_RING_FILL_SEC;
  const flareAge = fullyBuilt ? Math.max(0, elapsed - fillCompleteSec) : -1;
  const flareT = flareAge >= 0 ? Math.min(1, flareAge / HOVER_FLARE_SEC) : 0;
  // burst envelope: very fast rise, long fall — drives the brief arc brightening at lock.
  const burstEnvelope = flareT > 0 && flareT < 1
    ? Math.pow(Math.sin(flareT * Math.PI), 0.6) * Math.pow(1 - flareT, 0.5)
    : 0;
  const baseAlpha = fullyBuilt
    ? cosineEnvelope(beatTime, HOVER_DOT_PULSE_PERIOD_SEC, HOVER_DOT_PULSE_MIN_ALPHA, HOVER_DOT_PULSE_PEAK_ALPHA)
    : HOVER_DOT_BUILDING_ALPHA;
  const arcAlphaBoost = 1 + (HOVER_FLARE_PEAK_BOOST - 1) * burstEnvelope;
  const arcHsl = burstEnvelope > 0
    ? lerpHsl(HOVER_DOT_HSL, HOVER_FLARE_WARM_HSL, burstEnvelope)
    : HOVER_DOT_HSL;
  // soundwaves emit BEFORE arcs so the arcs and the dot/aim disc paint on top of them.
  // The first wave fires one beat before fill completes (HOVER_WAVE_LEAD_BEATS), so the
  // pulse is already underway by the time the arcs finish locking in.
  const wavesStartSec = fillCompleteSec - HOVER_WAVE_LEAD_BEATS * beatGrid;
  if (elapsed >= wavesStartSec) {
    paintSoundwaves(ctx, center, elapsed - wavesStartSec, beatTime, beatGrid);
  }
  ctx.lineWidth = HOVER_ARC_LINE_WIDTH;
  ctx.lineCap = "round";
  ctx.setLineDash([]);
  const slot = TAU / HOVER_DOT_COUNT;
  const start = -Math.PI / 2;
  for (let i = 0; i < visibleCount; i++) {
    const age = elapsed - i * slotDuration;
    const t = Math.min(1, Math.max(0, age / HOVER_ARC_FADE_IN_SEC));
    const sweepEase = 1 - Math.pow(1 - t, 3);
    const alphaEase = Math.sqrt(t);
    const alpha = Math.min(1, baseAlpha * alphaEase * arcAlphaBoost);
    ctx.strokeStyle = `hsla(${arcHsl}, ${alpha})`;
    const mid = start + i * slot;
    const ccwEnd = mid - HOVER_ARC_SWEEP / 2;
    const cwEnd = ccwEnd + HOVER_ARC_SWEEP * sweepEase;
    ctx.beginPath();
    ctx.arc(center.x, center.y, HOVER_DOT_RING_RADIUS, ccwEnd, cwEnd);
    ctx.stroke();
  }
  return { fillJustCompleted: fullyBuilt };
};

// concentric soundwave rings that radiate outward from the dot ring in time with the beat.
// A new wave is emitted every HOVER_WAVE_PERIOD_BEATS and lives for HOVER_WAVE_LIFETIME_BEATS,
// so consecutive waves overlap for a continuous radar-ping feel. The wave that fires at
// lock acquisition is brighter so lock still reads as a distinct moment.
// `lockAge` is seconds since the ring filled (≥0 when fully built).
const paintSoundwaves = (
  ctx: CanvasRenderingContext2D, center: Vec, lockAge: number, beatTime: number, beatGrid: number,
) => {
  if (beatGrid <= 0) return;
  ctx.lineCap = "round";
  // waves emit on every PERIOD-th integer beat downbeat. Walk back from the most recent such
  // beat and draw any wave still within its lifetime window.
  const beatsSinceLock = lockAge / beatGrid;
  const currentBeat = Math.floor(beatTime / beatGrid);
  const mostRecentEmitBeat = currentBeat - ((currentBeat % HOVER_WAVE_PERIOD_BEATS) + HOVER_WAVE_PERIOD_BEATS) % HOVER_WAVE_PERIOD_BEATS;
  const maxOverlap = Math.ceil(HOVER_WAVE_LIFETIME_BEATS / HOVER_WAVE_PERIOD_BEATS) + 1;
  for (let back = 0; back < maxOverlap; back++) {
    const beatIndex = mostRecentEmitBeat - back * HOVER_WAVE_PERIOD_BEATS;
    const emitTime = beatIndex * beatGrid;
    const ageSec = beatTime - emitTime;
    if (ageSec < 0) continue;
    const ageBeats = ageSec / beatGrid;
    if (ageBeats > HOVER_WAVE_LIFETIME_BEATS) continue;
    // skip waves that would have been emitted before the lock — keeps the radiation tied
    // to the moment the player actually achieved hover.
    if (ageBeats > beatsSinceLock + 0.01) continue;
    const t = ageBeats / HOVER_WAVE_LIFETIME_BEATS;
    const r = HOVER_WAVE_START_R + (HOVER_WAVE_END_R - HOVER_WAVE_START_R) * t;
    // fade-in over the first ~10% so a newly-emitted wave doesn't pop in too hard, then
    // fade out the rest of its life. Quadratic falloff feels like a soundwave dissipating.
    const fadeIn = Math.min(1, t / 0.1);
    const fadeOut = Math.pow(1 - t, 1.8);
    const envelope = fadeIn * fadeOut;
    // the first wave fired after lock is brighter so lock acquisition still reads as a
    // distinct beat. After one full emit period every wave settles to the steady look.
    const beatsBetweenWaveAndLock = beatsSinceLock - ageBeats;
    const isLockWave = beatsBetweenWaveAndLock >= 0 && beatsBetweenWaveAndLock < HOVER_WAVE_PERIOD_BEATS;
    const peakAlpha = isLockWave ? HOVER_LOCK_WAVE_PEAK_ALPHA : HOVER_WAVE_PEAK_ALPHA;
    const lineWidth = isLockWave ? HOVER_LOCK_WAVE_LINE_WIDTH : HOVER_WAVE_LINE_WIDTH;
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = `hsla(${HOVER_FLARE_WARM_HSL}, ${peakAlpha * envelope})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, TAU);
    ctx.stroke();
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
  const { positions: reticulePositions, primaryIndex, slotPositionIndices } = computeReticulePositions(ship, beatGrid, w, h, doubletime, superBoosted);
  // trajectory preview anchors on the "shoot now to hit next beat" spot. primaryIndex always
  // exists now (anchors on the first prong offset under prong), but keep the fallback for safety.
  const primaryReticule = primaryIndex >= 0
    ? reticulePositions[primaryIndex]
    : computeReticulePosition(ship, beatGrid, w, h, 0, 1);
  // each reachable slot may have multiple reticules (prong = 2 angles, centred = 1). The slot's
  // hover ring locks if the trajectory dot grazes ANY of them, so the player can drift-lock off
  // either prong.
  const reticulesBySlot: Vec[][] = slotPositionIndices.map(idxs => idxs.map(i => reticulePositions[i]));
  // grow the Ship's hover-ring array to match if range extended this frame; never shrink (so a
  // brief range loss doesn't wipe a partially-locked ring).
  while (state.hoverDotRings.length < slotPositionIndices.length) {
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
    reticulesBySlot, aimCircleCenter, aimCircleRadius,
    trajectoryTracks: state.trajectoryTracks, doubletime, tutorialHighlight,
  }, targets);
  const fromTrajectory = trajectoryResult.overlapsReticule;
  // reverse map: position-index → slot number (1-indexed). Every reticule that belongs to a slot
  // tags as that slot so the aim disc renders the right tick length on each prong.
  const slotByPosIndex = new Array<number>(reticulePositions.length).fill(-1);
  for (let s = 0; s < slotPositionIndices.length; s++) {
    for (const idx of slotPositionIndices[s]) slotByPosIndex[idx] = s + 1;
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
  // strongest hover and stays locked as long as ANY ring is locked. Under prong, the ring
  // renders at whichever prong reticule the trajectory dot is closest to (the winner).
  let maxIntensity = 0;
  let anyHover = false;
  let anyLocked = false;
  for (let slot = 0; slot < slotPositionIndices.length; slot++) {
    const proximity = trajectoryResult.slotProximities[slot] ?? 0;
    const winnerIdx = trajectoryResult.slotWinnerReticuleIdx[slot] ?? -1;
    const positionIdxs = slotPositionIndices[slot];
    const ringPosIdx = winnerIdx >= 0 && winnerIdx < positionIdxs.length ? positionIdxs[winnerIdx] : -1;
    const hovering = proximity > 0 && ringPosIdx >= 0;
    const center = hovering ? reticulePositions[ringPosIdx] : null;
    const intensity = updateHoverRing(state.hoverDotRings[slot], hovering, center, ctx, beatTime, beatGrid, sound);
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
  ctx: CanvasRenderingContext2D, beatTime: number, beatGrid: number, sound: Sound | null,
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
  const { fillJustCompleted } = paintHoverDotRing(ctx, ringCenter, elapsed, beatTime, beatGrid);
  if (fillJustCompleted && ring.completionBeatTime === null) {
    ring.completionBeatTime = beatTime;
    if (sound) sound.startFirstDotLockHum();
  }
  const afterDelay = Math.max(0, elapsed - HOVER_HUM_DELAY_SEC);
  const swellLinear = Math.min(1, afterDelay / HOVER_HUM_RAMP_SEC);
  return swellLinear * swellLinear * (3 - 2 * swellLinear);
};
