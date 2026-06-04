import { Vec, TAU } from "../../vec";
import { ConeFrame, clipRayToCone, targetIsInsideCone, toroidalDelta } from "./coneGeometry";
import { RETICULE_DASH_HSL } from "./radarCone";

// shared bullet-overlap radius constant so trajectory dots and aim discs use the same hit reach.
export const BULLET_HIT_RADIUS_ON_BEAT = 1.8 * 2.38 * 2.5;
export const BULLET_HIT_RADIUS_OFF_BEAT = 1.8 * 2.5;

// top-level toggles for individual trajectory-preview overlays — flip to false to hide an
// element without ripping out its code. Useful while tuning the visual language.
const SHOW_AIM_INTERSECTION_X = false;
const SHOW_FIRST_BEAT_DOT = true;
const SHOW_ON_RHYTHM_RETICULE = false;
export const SHOW_SHIP_TRAJECTORY = true;

// the on-rhythm reticule overlay for the focused target paints brighter by this factor —
// the focused-sprite glow itself is drawn additively in gameRender (no ctx.filter), but the
// reticule dots still use this multiplier to scale alpha when the on-rhythm spot is shown.
const FOCUSED_TARGET_BRIGHTNESS = 1.65;

const TRAJECTORY_ALPHA = 1;
const TRAJECTORY_PULSE_PERIOD_BEATS = 4;
const TRAJECTORY_PULSE_MIN_ALPHA = 1;
const TRAJECTORY_BEAT_DOT_RADIUS = 1;
const TRAJECTORY_BEAT_DOT_ALPHA = 0.25;
// in doubletime, half-beat dots interleave with the beat dots — visibly fainter and a touch
// smaller so the on-beat dots still read as the dominant rhythm anchor.
const TRAJECTORY_HALF_BEAT_DOT_ALPHA_FACTOR = 0.45;
const TRAJECTORY_HALF_BEAT_DOT_RADIUS = 0.8;
// the half-beat first dot glows like the on-beat first dot but at a reduced alpha so the
// on-beat anchor still dominates as the primary "shoot here" cue.
const TRAJECTORY_HALF_BEAT_FIRST_DOT_ALPHA_FACTOR = 0.5;
// the first beat-dot is the most important — slightly larger and brighter than the rest so
// the player's eye is drawn to "this is where to shoot next beat", but still reads as a member
// of the same dot series rather than a separate kind of cue.
const TRAJECTORY_FIRST_BEAT_DOT_RADIUS = 2;
const TRAJECTORY_FIRST_BEAT_DOT_ALPHA = 0.55;
// peak alpha matches the disc's RETICULE_OVERLAP_BRIGHTNESS=3 boost (≈0.75) so
// the first dot "lights up" to the same intensity as the disc when proximity is reached.
const TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA = 0.95;
// when the reticule sits ON the dot, alpha pulses between this floor (between beats) and 1
// (on the beat) so the rhythm is visible even at the brightest state. Floor stays high so the
// "this shot lands" cue never reads as dim.
const TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA = 0.6;
// how far outside the on-beat hit radius the proximity glow starts ramping up — this is
// the "near" band where the first-dot already reads as bright before a direct overlap.
const TRAJECTORY_FIRST_BEAT_DOT_PROXIMITY_PAD = 24;
// faint dashed halo around the first-beat dot — subtle "this is the next-beat lock" cue.
// Picks up the same beat-pulse boost as the dot itself so it brightens on the beat in sync.
const TRAJECTORY_FIRST_BEAT_HALO_RADIUS = 6;
const TRAJECTORY_FIRST_BEAT_HALO_ALPHA = 0.18;
const TRAJECTORY_FIRST_BEAT_HALO_LINE_WIDTH = 0.75;
const TRAJECTORY_FIRST_BEAT_HALO_DASH: number[] = [2, 2];
// tutorial highlight repaints the first-beat dot in solid white so it reads as the focal
// point of the wave-1 "use your targeting tools" cue.
const TUTORIAL_FIRST_DOT_HSL = "0, 0%, 100%";
// entry-flash glow halo so a new contact reads as a soft glow rather than just a brightness bump.
const TRAJECTORY_DIRECT_FLASH_GLOW_MAX_BLUR = 18;
const TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA = 0.85;
const TRAJECTORY_AIM_INTERSECTION_X_RADIUS = 5;
const TRAJECTORY_AIM_INTERSECTION_X_ALPHA = 0.55;
const TRAJECTORY_AIM_INTERSECTION_X_LINE_WIDTH = 1.5;
// on-rhythm aim-spot reticule — dashed circle with crosshair, sized for visibility on the
// target. Its own constants (no longer tied to the first beat-dot's size).
const TRAJECTORY_ON_RHYTHM_SPOT_RADIUS = 8;
const TRAJECTORY_ON_RHYTHM_SPOT_LINE_WIDTH = 1;
const TRAJECTORY_ON_RHYTHM_SPOT_DASH: number[] = [2, 2];
const TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_REACHABLE = TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA;
// dim state needs to read as "you're not aimed at the on-beat hit yet" — significantly
// fainter than the bright state so the brightness jump is unmistakeable when you line it up.
const TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_UNREACHABLE = 0.22;
// dashed crosshair tick that sticks out past the lock circle — reads as "this is a sight".
const TRAJECTORY_LOCK_CROSSHAIR_GAP = 3;
const TRAJECTORY_LOCK_CROSSHAIR_LENGTH = 7;
const TRAJECTORY_LOCK_CROSSHAIR_DASH: number[] = [2, 2];
// first-beat dot crosshair — same sight visual as the lock crosshair, sized to clear the halo
// ring so the ticks read as separate marks rather than overlapping the dashed halo. Tick length
// grows per slot so the 1-beat dot pairs visually with the 1-beat reticule, 2-beat with 2-beat,
// etc. — the player can scan "small ticks pair with small ticks" to know which to drift-lock.
const TRAJECTORY_FIRST_BEAT_CROSSHAIR_INNER = TRAJECTORY_FIRST_BEAT_HALO_RADIUS + 2;
const TRAJECTORY_FIRST_BEAT_CROSSHAIR_DASH: number[] = [2, 2];
const TRAJECTORY_FIRST_BEAT_CROSSHAIR_LINE_WIDTH = 0.75;
// shared with aimDisc.ts via SLOT_CROSSHAIR_LENGTHS_TRAJECTORY; one entry per slot starting at 1-beat.
export const SLOT_CROSSHAIR_LENGTHS_TRAJECTORY = [5, 9, 13, 17] as const;
export const slotCrosshairLengthTrajectory = (slot: number): number =>
  SLOT_CROSSHAIR_LENGTHS_TRAJECTORY[Math.min(SLOT_CROSSHAIR_LENGTHS_TRAJECTORY.length - 1, Math.max(0, slot - 1))];
// the centermost-target's first-beat dot upgrades its halo + crosshair to bright white at full
// alpha so the player can instantly see which target their on-beat shot is locked to.
// Geometry matches the ship's aim disc (outer ring + crosshair from aimDisc.ts) so the focused
// lock and the player's reticule read as the same kind of mark — kept in sync by inlining the
// same numeric constants here rather than cross-importing.
const FOCUSED_FIRST_DOT_HSL = "0, 0%, 100%";
const FOCUSED_FIRST_DOT_RING_RADIUS = BULLET_HIT_RADIUS_ON_BEAT;
const FOCUSED_FIRST_DOT_RING_LINE_WIDTH = 1;
const FOCUSED_FIRST_DOT_RING_DASH: number[] = [4, 4];
const FOCUSED_FIRST_DOT_CROSSHAIR_GAP = 3;
const FOCUSED_FIRST_DOT_CROSSHAIR_LENGTH = 6;
const FOCUSED_FIRST_DOT_CROSSHAIR_DASH: number[] = [2, 2];

// every reticule element brightens on the beat and decays across it, so the player feels the
// rhythm gate visually. Multiplier is PEAK at beat onset and decays to 1 by the next beat.
const RETICULE_BEAT_PULSE_PEAK = 2.4;
export const computeBeatPulseBoost = (beatTime: number, beatGrid: number): number => {
  if (beatGrid <= 0) return 1;
  const phase = ((beatTime % beatGrid) + beatGrid) % beatGrid / beatGrid;
  const decay = (1 - phase) * (1 - phase);
  return 1 + (RETICULE_BEAT_PULSE_PEAK - 1) * decay;
};

// when a target first enters the cone, briefly boost alpha so the appearance reads as a flash.
const TRAJECTORY_ENTRY_FLASH_DURATION_SEC = 0.35;
const TRAJECTORY_ENTRY_FLASH_PEAK_BOOST = 2.5;
// after a target leaves the cone, keep the last-seen trajectory visible for this long, fading out.
const TRAJECTORY_FADE_OUT_DURATION_SEC = 2;

// target shape covers everything the reticule might lock onto (asteroids, comets, aliens, canisters).
export type ReticuleTarget = { pos: Vec; vel: Vec; radius?: number };

// snapshot the last in-cone state so fade-out can keep rendering even if the target dies/leaves.
type TrajectorySnapshot = { posX: number; posY: number; velX: number; velY: number; radius: number };

// per-target tracking for entry flash phase and post-exit fade lingering.
export type TrajectoryTrack = {
  firstSeen: number;
  lastInConeAt: number;
  snapshot: TrajectorySnapshot;
};

// strong Map (not WeakMap) is required because we need to keep rendering a target's fade-out
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
  // one entry per reachable on-beat slot — index 0 = 1-beat slot, 1 = 2-beat, ...
  //   each entry lists every reticule for that slot (1 centred, or 2 prongs). Empty array
  //   means no reticule reaches that slot.
  reticulesBySlot: Array<Vec[]>;
  aimCircleCenter: Vec;
  aimCircleRadius: number;
  trajectoryTracks: TrajectoryTrackMap;
  doubletime: boolean;
  tutorialHighlight: boolean;
};

// dots pulse from 0→1 the first beat, then sinusoidally — gives a "lock-on" feel as targets enter.
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

// alpha multiplier that spikes to PEAK_BOOST when target just entered the cone, decays to 1 over
// ENTRY_FLASH_DURATION_SEC — gives an unmistakable "new contact" flash on first appearance.
const computeEntryFlashBoost = (firstSeen: number, beatTime: number): number => {
  const age = beatTime - firstSeen;
  if (age < 0 || age >= TRAJECTORY_ENTRY_FLASH_DURATION_SEC) return 1;
  const t01 = 1 - age / TRAJECTORY_ENTRY_FLASH_DURATION_SEC;
  return 1 + (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1) * t01 * t01;
};

// trajectory lingers for FADE_OUT_DURATION_SEC after leaving cone — returns 1→0 fade or 1 if in-cone.
const computeFadeAlpha = (lastInConeAt: number, beatTime: number): number => {
  const since = beatTime - lastInConeAt;
  if (since <= 0) return 1;
  if (since >= TRAJECTORY_FADE_OUT_DURATION_SEC) return 0;
  const t01 = 1 - since / TRAJECTORY_FADE_OUT_DURATION_SEC;
  return t01 * t01;
};

// when the on-beat hit is unreachable (target running away too fast, or too close for any
// shot to land on the beat) we recolor the on-rhythm reticule red so the player gets the cue
// directly on the lock element they're already watching, instead of tinting the whole sprite.
const ON_RHYTHM_UNREACHABLE_HSL = "0, 90%, 60%";

// dashed crosshair sticking out beyond the on-rhythm aim-spot circle in the 4 cardinal
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

// dashed lock-circle + crosshair for the on-rhythm aim spot — the "where to aim NOW to hit
// on the next beat" reticule. Caller passes alpha/lineWidth/glow so reachable vs. unreachable and
// entry-flash state can modulate brightness without changing the geometry.
const paintOnRhythmReticule = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  alpha: number, lineWidth: number, glow01: number, unreachable: boolean,
) => {
  const hsl = unreachable ? ON_RHYTHM_UNREACHABLE_HSL : RETICULE_DASH_HSL;
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  if (glow01 > 0) {
    ctx.shadowBlur = TRAJECTORY_DIRECT_FLASH_GLOW_MAX_BLUR * glow01;
    ctx.shadowColor = `hsla(${hsl}, ${TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA * glow01})`;
  }
  ctx.strokeStyle = `hsla(${hsl}, ${alpha})`;
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

// first beat-dot is a filled dot like the others — just bigger and brighter so it stands out
// as "shoot here next beat". It still picks up proximity glow, direct-flash flicker, entry-flash,
// and the per-beat pulse so it reads as part of the same lock-on language.
// dimFactor < 1 is used for the doubletime half-beat "first dot" — still glows, but fainter.
const paintFirstBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  proximity01: number, entryFlashBoost: number, beatPulseBoost: number, focusBoost: number,
  dimFactor: number = 1, tutorialHighlight: boolean = false, focused: boolean = false,
  tickLength: number = SLOT_CROSSHAIR_LENGTHS_TRAJECTORY[0],
) => {
  const proximityAlpha = TRAJECTORY_FIRST_BEAT_DOT_ALPHA
    + (TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA - TRAJECTORY_FIRST_BEAT_DOT_ALPHA) * proximity01;
  // multiplicative pulse is the default; on top of the dot (or on the focused target's dot,
  // which is the bright "you're aimed at this target" cue) we'd saturate to 1 and lose the
  // pulse, so blend toward a normalized [LIT_MIN, 1] pulse so the rhythm stays visible at the
  // bright state with a high minimum opacity.
  const beatPulse01 = (beatPulseBoost - 1) / (RETICULE_BEAT_PULSE_PEAK - 1);
  const lit01 = focused ? 1 : proximity01;
  const multiplicativeAlpha = proximityAlpha * entryFlashBoost * beatPulseBoost * focusBoost * dimFactor;
  const litAlpha = (TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA
    + (1 - TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA) * beatPulse01)
    * entryFlashBoost * focusBoost * dimFactor;
  const rawAlpha = multiplicativeAlpha * (1 - lit01) + litAlpha * lit01;
  const alpha = Math.min(1, tutorialHighlight ? Math.max(rawAlpha, 0.95) : rawAlpha);
  const glow01 = Math.max(0, Math.min(1, (entryFlashBoost - 1) / (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1)));
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  const dotHsl = tutorialHighlight ? TUTORIAL_FIRST_DOT_HSL : RETICULE_DASH_HSL;
  if (glow01 > 0) {
    ctx.shadowBlur = TRAJECTORY_DIRECT_FLASH_GLOW_MAX_BLUR * glow01;
    ctx.shadowColor = `hsla(${RETICULE_DASH_HSL}, ${TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA * glow01})`;
  }
  ctx.fillStyle = `hsla(${dotHsl}, ${alpha})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_FIRST_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
  // for the focused (centermost) target, swap the dim halo + crosshair for a bright-white
  // outer ring + crosshair sized to match the ship's aim disc, so the locked-on target reads
  // as a mirror of the player's reticule. Non-focused dots keep the faint dashed halo cue.
  if (focused) {
    const focusedAlpha = TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA
      + (1 - TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA) * beatPulse01;
    ctx.strokeStyle = `hsla(${FOCUSED_FIRST_DOT_HSL}, ${focusedAlpha})`;
    ctx.lineWidth = FOCUSED_FIRST_DOT_RING_LINE_WIDTH;
    ctx.setLineDash(FOCUSED_FIRST_DOT_RING_DASH);
    ctx.beginPath();
    ctx.arc(px, py, FOCUSED_FIRST_DOT_RING_RADIUS, 0, TAU);
    ctx.stroke();
    ctx.setLineDash(FOCUSED_FIRST_DOT_CROSSHAIR_DASH);
    const fInner = FOCUSED_FIRST_DOT_RING_RADIUS + FOCUSED_FIRST_DOT_CROSSHAIR_GAP;
    const fOuter = fInner + FOCUSED_FIRST_DOT_CROSSHAIR_LENGTH;
    ctx.beginPath();
    ctx.moveTo(px - fOuter, py); ctx.lineTo(px - fInner, py);
    ctx.moveTo(px + fInner, py); ctx.lineTo(px + fOuter, py);
    ctx.moveTo(px, py - fOuter); ctx.lineTo(px, py - fInner);
    ctx.moveTo(px, py + fInner); ctx.lineTo(px, py + fOuter);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = prevShadowBlur;
    ctx.shadowColor = prevShadowColor;
    return;
  }
  const rawHaloAlpha = TRAJECTORY_FIRST_BEAT_HALO_ALPHA
    * entryFlashBoost * beatPulseBoost * focusBoost * dimFactor;
  const haloAlpha = Math.min(1, tutorialHighlight ? Math.max(rawHaloAlpha, 0.6) : rawHaloAlpha);
  ctx.strokeStyle = `hsla(${dotHsl}, ${haloAlpha})`;
  ctx.lineWidth = TRAJECTORY_FIRST_BEAT_HALO_LINE_WIDTH;
  ctx.setLineDash(TRAJECTORY_FIRST_BEAT_HALO_DASH);
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_FIRST_BEAT_HALO_RADIUS, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = TRAJECTORY_FIRST_BEAT_CROSSHAIR_LINE_WIDTH;
  ctx.setLineDash(TRAJECTORY_FIRST_BEAT_CROSSHAIR_DASH);
  const inner = TRAJECTORY_FIRST_BEAT_CROSSHAIR_INNER;
  const outer = inner + tickLength;
  ctx.beginPath();
  ctx.moveTo(px - outer, py); ctx.lineTo(px - inner, py);
  ctx.moveTo(px + inner, py); ctx.lineTo(px + outer, py);
  ctx.moveTo(px, py - outer); ctx.lineTo(px, py - inner);
  ctx.moveTo(px, py + inner); ctx.lineTo(px, py + outer);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = prevShadowBlur;
  ctx.shadowColor = prevShadowColor;
};

const paintBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  entryFlashBoost: number, focusBoost: number,
) => {
  const alpha = Math.min(1, TRAJECTORY_BEAT_DOT_ALPHA * entryFlashBoost * focusBoost);
  ctx.fillStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
};

// half-beat dot interleaves between regular beat dots when doubletime is active — visually
// reads as the same kind of cue but fainter and slightly smaller, so on-beat dots still anchor.
const paintHalfBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  entryFlashBoost: number, focusBoost: number,
) => {
  const alpha = Math.min(1, TRAJECTORY_BEAT_DOT_ALPHA * TRAJECTORY_HALF_BEAT_DOT_ALPHA_FACTOR * entryFlashBoost * focusBoost);
  ctx.fillStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_HALF_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
};

const paintAimIntersectionX = (
  ctx: CanvasRenderingContext2D, px: number, py: number, entryFlashBoost: number, focusBoost: number,
) => {
  const r = TRAJECTORY_AIM_INTERSECTION_X_RADIUS;
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${Math.min(1, TRAJECTORY_AIM_INTERSECTION_X_ALPHA * entryFlashBoost * focusBoost)})`;
  ctx.lineWidth = TRAJECTORY_AIM_INTERSECTION_X_LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(px - r, py - r);
  ctx.lineTo(px + r, py + r);
  ctx.moveTo(px + r, py - r);
  ctx.lineTo(px - r, py + r);
  ctx.stroke();
};

// detect whether the first-beat lock dot overlaps the aim disc, so the disc can brighten.
const firstDotOverlapsReticule = (px: number, py: number, retX: number, retY: number): boolean => {
  const R = BULLET_HIT_RADIUS_ON_BEAT;
  const ddx = px - retX;
  const ddy = py - retY;
  return ddx * ddx + ddy * ddy <= (R + TRAJECTORY_FIRST_BEAT_DOT_RADIUS) * (R + TRAJECTORY_FIRST_BEAT_DOT_RADIUS);
};

// 0 = far away (no glow), 1 = touching the disc (full lit). Smooth ramp through the proximity pad.
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

// overlapsReticule = strict hit (powers reticule lock-on visuals); slotProximities[k-1] = soft
// 0..1 proximity between the k-beat trajectory dot and whichever of the slot's reticules sits
// closest, used by the per-slot hover rings. slotWinnerReticuleIdx[k-1] is the index INTO the
// slot's reticule list of the winner (so renderer knows which prong to anchor the ring on);
// -1 when no reticule is close.
type DotWalkResult = {
  overlapsReticule: boolean;
  slotProximities: number[];
  slotWinnerReticuleIdx: number[];
};

// the cone is computed in the apex's "virtual" frame (toroidalDelta-remapped), so dot
// positions can land outside [0,w)×[0,h). Wrapping back into the canvas before painting makes
// dots reappear on the opposite edge — matching how the actual target sprite wraps — so the
// trajectory preview stays visible when the tracked object crosses a screen edge.
const wrapToCanvas = (x: number, y: number, w: number, h: number): [number, number] => [
  ((x % w) + w) % w,
  ((y % h) + h) % h,
];

// dots mark target position at successive beats — direct preview of where the player needs to aim.
// in doubletime, an extra fainter dot is interleaved at each half-beat between the beat dots,
// and a second, fainter "first dot" precedes the on-beat first dot at the half-beat lead.
const drawBeatDotsAlongRay = (
  ctx: CanvasRenderingContext2D,
  rawStartX: number, rawStartY: number, ux: number, uy: number,
  reticulesBySlot: Array<Array<[number, number]>>,
  sMin: number, sMax: number, dotStep: number, dotOffset: number,
  entryFlashBoost: number, beatPulseBoost: number, focusBoost: number,
  w: number, h: number, doubletime: boolean, tutorialHighlight: boolean, focused: boolean,
): DotWalkResult => {
  let overlapsReticule = false;
  const slotCount = reticulesBySlot.length;
  const slotProximities: number[] = new Array(slotCount).fill(0);
  const slotWinnerReticuleIdx: number[] = new Array(slotCount).fill(-1);
  // doubletime halves the spacing and marks every other k as a half-beat (off-beat) dot.
  const step = doubletime ? dotStep * 0.5 : dotStep;
  const isHalfBeatK = (k: number): boolean => doubletime && (k % 2 === 1);
  // on-beat dot indices are anchored to the target (next-beat future position), not to the wedge —
  // letting cone clipping exclude them produces a worse "lock cue lies about position" bug than
  // the cosmetic spill it would prevent. Each slot's on-beat dot (and the doubletime half-beat
  // first-dot lead) always paints, regardless of cone clipping.
  const firstHalfBeatK = 1;
  // 1-indexed slot → k value at which that slot's on-beat dot appears
  const slotToK = (slot: number): number => doubletime ? slot * 2 : slot;
  const maxSlotK = slotCount > 0 ? slotToK(slotCount) : 0;
  const isAnchorK = (k: number): boolean => {
    if (doubletime && k === firstHalfBeatK) return true;
    if (k <= 0 || k > maxSlotK) return false;
    if (doubletime && k % 2 !== 0) return false;
    const slot = doubletime ? k / 2 : k;
    return reticulesBySlot[slot - 1].length > 0;
  };
  let drawnOnBeatDots = 0;
  let drawnHalfBeatDots = 0;
  for (let k = 1; ; k++) {
    const sK = dotOffset + step * k;
    const isFirstBeatDot = isAnchorK(k);
    if (sK > sMax && k > maxSlotK) break;
    if (sK > sMax && !isFirstBeatDot) continue;
    if (sK < sMin && !isFirstBeatDot) continue;
    const px = rawStartX + ux * sK;
    const py = rawStartY + uy * sK;
    const [drawX, drawY] = wrapToCanvas(px, py, w, h);
    const halfBeat = isHalfBeatK(k);
    if (halfBeat) {
      if (drawnHalfBeatDots === 0) {
        // dimmed first-dot glow — no proximity check against the on-beat reticule, since
        // this dot represents a different bullet endpoint (half-beat shot, not on-beat shot).
        if (SHOW_FIRST_BEAT_DOT) {
          paintFirstBeatDot(
            ctx, drawX, drawY, 0, entryFlashBoost, beatPulseBoost, focusBoost,
            TRAJECTORY_HALF_BEAT_FIRST_DOT_ALPHA_FACTOR, false, focused,
          );
        }
      } else {
        paintHalfBeatDot(ctx, drawX, drawY, entryFlashBoost, focusBoost);
      }
      drawnHalfBeatDots++;
    } else {
      const slotIdx = drawnOnBeatDots; // 0-based slot for this on-beat dot
      const slotReticules = slotIdx < slotCount ? reticulesBySlot[slotIdx] : [];
      if (slotReticules.length > 0) {
        let bestProximity = 0;
        let bestRetIdx = -1;
        let anyStrictOverlap = false;
        for (let r = 0; r < slotReticules.length; r++) {
          const [retXk, retYk] = slotReticules[r];
          const proximityR = firstDotProximity01(px, py, retXk, retYk);
          if (proximityR > bestProximity) { bestProximity = proximityR; bestRetIdx = r; }
          if (slotIdx === 0 && firstDotOverlapsReticule(px, py, retXk, retYk)) anyStrictOverlap = true;
        }
        const tickLength = slotCrosshairLengthTrajectory(slotIdx + 1);
        if (SHOW_FIRST_BEAT_DOT) {
          // tutorial highlight + the 1st-dot strict-overlap signal only apply to the 1-beat slot.
          paintFirstBeatDot(
            ctx, drawX, drawY, bestProximity, entryFlashBoost, beatPulseBoost, focusBoost,
            1, slotIdx === 0 ? tutorialHighlight : false, slotIdx === 0 ? focused : false,
            tickLength,
          );
        }
        if (anyStrictOverlap) overlapsReticule = true;
        if (bestProximity > slotProximities[slotIdx]) {
          slotProximities[slotIdx] = bestProximity;
          slotWinnerReticuleIdx[slotIdx] = bestRetIdx;
        }
      } else {
        paintBeatDot(ctx, drawX, drawY, entryFlashBoost, focusBoost);
      }
      drawnOnBeatDots++;
    }
  }
  return { overlapsReticule, slotProximities, slotWinnerReticuleIdx };
};

const drawAimIntersectionsAlongRay = (
  ctx: CanvasRenderingContext2D,
  rawStartX: number, rawStartY: number, ux: number, uy: number,
  centerX: number, centerY: number, radius: number,
  sMin: number, sMax: number, entryFlashBoost: number, focusBoost: number,
  w: number, h: number,
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
    const [drawX, drawY] = wrapToCanvas(rawStartX + ux * s, rawStartY + uy * s, w, h);
    paintAimIntersectionX(ctx, drawX, drawY, entryFlashBoost, focusBoost);
  }
};

// reticule pos may live on a different toroidal image of the world; remap before overlap checks.
const remapReticuleToTarget = (apex: Vec, reticulePos: Vec, w: number, h: number): [number, number] => {
  const [retDx, retDy] = toroidalDelta(reticulePos.x - apex.x, reticulePos.y - apex.y, w, h);
  return [apex.x + retDx, apex.y + retDy];
};

// on-rhythm aim spot uses the same lock-circle + crosshair visual as the first-beat dot so the
// player reads them as the same kind of cue ("targeting reticule"). Brightens ONLY when firing
// now would actually hit the target on the next beat (player's reticule is on the spot AND the
// geometry works out for an on-beat hit); dim otherwise.
const paintOnRhythmSpot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  willHitOnBeat: boolean, reachable: boolean,
  entryFlashBoost: number, beatPulseBoost: number, focusBoost: number,
) => {
  const baseAlpha = willHitOnBeat ? TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_REACHABLE : TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_UNREACHABLE;
  const alpha = Math.min(1, baseAlpha * entryFlashBoost * beatPulseBoost * focusBoost);
  const entryGlow01 = Math.max(0, Math.min(1, (entryFlashBoost - 1) / (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1)));
  paintOnRhythmReticule(ctx, px, py, alpha, TRAJECTORY_ON_RHYTHM_SPOT_LINE_WIDTH + (entryFlashBoost - 1), entryGlow01, !reachable);
};

// the aim circle is the locus of bullet endpoints at t=beatGrid over all headings —
// radius = bulletSpeed*beat, center accounts for inherited ship velocity. For an on-beat hit
// the bullet endpoint at t=beatGrid must land EXACTLY on the target's future body surface:
// land outside the body and you miss; land inside and the bullet collided BEFORE the beat
// (early/off-beat hit) since it passed through the body en route. So the aim point is the
// intersection of the aim circle with the target's predicted body circle on the player's side.
//
// Reachability ladder (D = aimCenter→C_future, |D| = dist between centers):
//   |D| > aimRadius + r : target running away — bullet can't reach it at all.
//   |D| < aimRadius - r : target too close/slow — every heading overshoots → only early hits.
//   ||D| - aimRadius| ≤ r : the two circles cross → on-beat hit reachable on the near surface.
//
// When reachable, the aim point is C_future - r·D̂ (near surface). When NOT reachable, we still
// place the spot at the target's predicted center so the player sees where the lead would be,
// but `reachable` is false so the renderer can tint the target red.
type OnBeatAim = { x: number; y: number; reachable: boolean; willHitOnBeat: boolean };
const computeOnBeatAim = (
  cx: number, cy: number, velX: number, velY: number, radius: number,
  aimCenterX: number, aimCenterY: number, aimRadius: number, beatGrid: number,
  retX: number, retY: number,
): OnBeatAim => {
  const futureX = cx + velX * beatGrid;
  const futureY = cy + velY * beatGrid;
  const dx = futureX - aimCenterX;
  const dy = futureY - aimCenterY;
  const dist = Math.hypot(dx, dy);
  const reachable = dist >= Math.max(0, aimRadius - radius) && dist <= aimRadius + radius;
  let spotX: number;
  let spotY: number;
  if (reachable && dist > 1e-6) {
    spotX = futureX - (dx / dist) * radius;
    spotY = futureY - (dy / dist) * radius;
  } else {
    spotX = futureX;
    spotY = futureY;
  }
  // hit detection compares the aim disc (bullet at t=beatGrid) to the target's future
  // CENTER with combined radii — same logic the actual collision test uses — not to the spot,
  // since the spot sits on the body surface and would under-detect by the target's radius.
  const hitTol = radius + BULLET_HIT_RADIUS_ON_BEAT;
  const retDx = retX - futureX;
  const retDy = retY - futureY;
  const willHitOnBeat = reachable && retDx * retDx + retDy * retDy <= hitTol * hitTol;
  return { x: spotX, y: spotY, reachable, willHitOnBeat };
};

// core trajectory renderer — operates on a position/velocity snapshot, with optional cone clipping.
// alphaMultiplier folds in entry-flash boost and exit-fade decay; clipToCone is false during fade so the
// lingering ghost remains visible even after the target has left the radar wedge.
const EMPTY_DOT_WALK_RESULT: DotWalkResult = { overlapsReticule: false, slotProximities: [], slotWinnerReticuleIdx: [] };

const paintTrajectoryFromSnapshot = (
  ctx: TrajectoryContext, snap: TrajectorySnapshot, firstSeen: number,
  alphaMultiplier: number, clipToCone: boolean,
  showOnRhythmSpot: boolean,
): DotWalkResult => {
  const speed = Math.hypot(snap.velX, snap.velY);
  if (speed < 1) return EMPTY_DOT_WALK_RESULT;
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
    if (clip.sMax <= clip.sMin) return EMPTY_DOT_WALK_RESULT;
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
  // the centermost target (the one with the on-rhythm reticule) gets a uniform alpha boost
  // applied to every preview element on its trajectory, so the player can spot which target their
  // next on-beat shot is locked onto at a glance.
  const focusBoost = showOnRhythmSpot ? FOCUSED_TARGET_BRIGHTNESS : 1;
  // during the entry-flash window, override the pulse ramp so brightness peaks immediately rather
  // than easing in — the flash is the visual cue that the contact JUST appeared.
  const effectivePulse = entryFlashBoost > 1 ? Math.max(pulse, 1) : pulse;
  ctx.ctx.globalAlpha = Math.min(1, TRAJECTORY_ALPHA * effectivePulse * alphaMultiplier);

  const [retX, retY] = remapReticuleToTarget(ctx.apex, ctx.reticulePos, ctx.w, ctx.h);
  const reticulesBySlot: Array<Array<[number, number]>> = ctx.reticulesBySlot.map(slotRets =>
    slotRets.map(p => remapReticuleToTarget(ctx.apex, p, ctx.w, ctx.h)),
  );
  const [aimCenterX, aimCenterY] = remapReticuleToTarget(ctx.apex, ctx.aimCircleCenter, ctx.w, ctx.h);
  const dotStep = speed * ctx.beatGrid;
  const dotOffset = -(r + edgePad);
  ctx.ctx.save();
  ctx.ctx.setLineDash([]);
  if (SHOW_AIM_INTERSECTION_X) {
    drawAimIntersectionsAlongRay(
      ctx.ctx, rawStartX, rawStartY, ux, uy, aimCenterX, aimCenterY,
      ctx.aimCircleRadius, sMin, sMax, entryFlashBoost, focusBoost, ctx.w, ctx.h,
    );
  }
  const result = drawBeatDotsAlongRay(
    ctx.ctx, rawStartX, rawStartY, ux, uy, reticulesBySlot,
    sMin, sMax, dotStep, dotOffset, entryFlashBoost, beatPulseBoost, focusBoost,
    ctx.w, ctx.h, ctx.doubletime, ctx.tutorialHighlight, showOnRhythmSpot,
  );
  if (SHOW_ON_RHYTHM_RETICULE && showOnRhythmSpot) {
    const aim = computeOnBeatAim(
      cx, cy, snap.velX, snap.velY, r,
      aimCenterX, aimCenterY, ctx.aimCircleRadius, ctx.beatGrid, retX, retY,
    );
    const [aimDrawX, aimDrawY] = wrapToCanvas(aim.x, aim.y, ctx.w, ctx.h);
    paintOnRhythmSpot(ctx.ctx, aimDrawX, aimDrawY, aim.willHitOnBeat, aim.reachable, entryFlashBoost, beatPulseBoost, focusBoost);
  }
  ctx.ctx.restore();
  return result;
};

// refresh the track for an in-cone target — entry flash starts when no track existed, or when the
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

// the trajectory ray itself overlaps the cone when its forward path (from just ahead of the
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

// per-target live render — checks cone membership and updates track.
// Treat the trajectory as "in cone" if EITHER the target overlaps the cone OR its forward path
// crosses the cone; the player can still aim the radar at the trajectory line itself.
const previewLiveTarget = (
  ctx: TrajectoryContext, t: ReticuleTarget, rendered: Set<object>,
  showSpot: boolean,
): DotWalkResult => {
  const [dx, dy] = toroidalDelta(t.pos.x - ctx.apex.x, t.pos.y - ctx.apex.y, ctx.w, ctx.h);
  const tr = t.radius ?? 0;
  const targetInCone = targetIsInsideCone(dx, dy, tr, ctx.frame);
  const rayInCone = !targetInCone && trajectoryRayOverlapsCone(dx, dy, t, ctx.frame);
  if (!targetInCone && !rayInCone) return EMPTY_DOT_WALK_RESULT;
  const track = refreshTrack(ctx.trajectoryTracks, t, ctx.beatTime);
  rendered.add(t as unknown as object);
  // when only the ray (not the target itself) is in the cone, disable cone clipping so the
  // visible dots span the full forward path — clipping would chop the line back inside the wedge
  // and could omit the section the radar is actually overlapping.
  return paintTrajectoryFromSnapshot(ctx, track.snapshot, track.firstSeen, 1, targetInCone, showSpot);
};

// drain expired fade entries and render fading-out trajectories for targets that left the cone or
// were destroyed while in it — keeps a 2s "ghost" of the last-seen path that decays to invisible.
// If the target is still alive, refresh the snapshot from its live pos/vel each frame so the ghost
// animates with the target instead of freezing where the radar last saw it.
const renderFadingTrajectories = (
  ctx: TrajectoryContext, rendered: Set<object>,
  liveByKey: Map<object, ReticuleTarget>,
) => {
  for (const [key, track] of ctx.trajectoryTracks) {
    if (rendered.has(key)) continue;
    const fade = computeFadeAlpha(track.lastInConeAt, ctx.beatTime);
    if (fade <= 0) {
      ctx.trajectoryTracks.delete(key);
      continue;
    }
    const live = liveByKey.get(key);
    if (live) {
      track.snapshot = {
        posX: live.pos.x, posY: live.pos.y, velX: live.vel.x, velY: live.vel.y,
        radius: live.radius ?? track.snapshot.radius,
      };
    }
    paintTrajectoryFromSnapshot(ctx, track.snapshot, track.firstSeen, fade, false, false);
  }
};

// of all visible targets, pick the one whose center sits nearest the radar axis line — that's
// the single target the on-rhythm aim spot will be drawn for. Returns null if no eligible target.
// Exported so the main render loop can give that same target a brightness boost on its sprite.
export const pickCenterMostTargetForFocus = (
  apex: Vec, frame: ConeFrame, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>,
): ReticuleTarget | null => {
  if (frame.length <= 0) return null;
  let best: ReticuleTarget | null = null;
  let bestPerp = Infinity;
  for (const t of targets) {
    const [dx, dy] = toroidalDelta(t.pos.x - apex.x, t.pos.y - apex.y, w, h);
    const tr = t.radius ?? 0;
    const targetInCone = targetIsInsideCone(dx, dy, tr, frame);
    const rayInCone = !targetInCone && trajectoryRayOverlapsCone(dx, dy, t, frame);
    if (!targetInCone && !rayInCone) continue;
    const forward = dx * frame.axisX + dy * frame.axisY;
    if (forward <= 0) continue;
    const perp = Math.abs(dx * frame.axisY - dy * frame.axisX);
    if (perp < bestPerp) { bestPerp = perp; best = t; }
  }
  return best;
};

const pickCenterMostTarget = (
  ctx: TrajectoryContext, targets: ReadonlyArray<ReticuleTarget>,
): ReticuleTarget | null =>
  pickCenterMostTargetForFocus(ctx.apex, ctx.frame, ctx.w, ctx.h, targets);

// walks every visible target; returns strict overlap (for the 1-beat reticule lock-on visual),
// the max soft proximity per slot (0..1, used by each slot's hover-commit ring), and which
// reticule index inside the slot's reticule list won (so the renderer knows which prong to
// anchor the hover ring on). Slot k's data is at index k-1; entries beyond the renderer's slot
// count are absent.
export type TrajectoryPreviewResult = {
  overlapsReticule: boolean;
  slotProximities: number[];
  slotWinnerReticuleIdx: number[];
};

const emptySlotProximities = (n: number): number[] => new Array(n).fill(0);
const emptyWinnerIdx = (n: number): number[] => new Array(n).fill(-1);

export const paintTrajectoryPreviews = (
  ctx: TrajectoryContext, targets: ReadonlyArray<ReticuleTarget>,
): TrajectoryPreviewResult => {
  const slotCount = ctx.reticulesBySlot.length;
  if (ctx.frame.length <= 0) return { overlapsReticule: false, slotProximities: emptySlotProximities(slotCount), slotWinnerReticuleIdx: emptyWinnerIdx(slotCount) };
  ctx.ctx.save();
  ctx.ctx.setLineDash([]);
  ctx.ctx.lineWidth = 1.5;
  ctx.ctx.shadowBlur = 0;
  const rendered = new Set<object>();
  const spotTarget = pickCenterMostTarget(ctx, targets);
  let overlapsReticule = false;
  const slotProximities = emptySlotProximities(slotCount);
  const slotWinnerReticuleIdx = emptyWinnerIdx(slotCount);
  const liveByKey = new Map<object, ReticuleTarget>();
  for (const t of targets) liveByKey.set(t as unknown as object, t);
  for (const t of targets) {
    const r = previewLiveTarget(ctx, t, rendered, t === spotTarget);
    if (r.overlapsReticule) overlapsReticule = true;
    for (let i = 0; i < slotCount && i < r.slotProximities.length; i++) {
      if (r.slotProximities[i] > slotProximities[i]) {
        slotProximities[i] = r.slotProximities[i];
        slotWinnerReticuleIdx[i] = r.slotWinnerReticuleIdx[i];
      }
    }
  }
  renderFadingTrajectories(ctx, rendered, liveByKey);
  ctx.ctx.restore();
  return { overlapsReticule, slotProximities, slotWinnerReticuleIdx };
};
