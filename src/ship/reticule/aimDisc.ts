import { Vec, TAU } from "../../vec";
import { RETICULE_DASH_HSL } from "./radarCone";
import { BULLET_HIT_RADIUS_ON_BEAT, BULLET_HIT_RADIUS_OFF_BEAT, ReticuleTarget } from "./trajectoryPreview";
import { toroidalDelta } from "./coneGeometry";

const RETICULE_LINE_DASH: [number, number] = [4, 4];
const RETICULE_HITBOX_ALPHA = 0.28;
const RETICULE_COOLDOWN_DIM = 0.3;
// brightness boost when the disc covers a target tells the player "this shot will land".
const RETICULE_OVERLAP_BRIGHTNESS = 3;
// when the disc is directly over an object (vs. just near a lock dot), add a hard flicker so
// the player can't miss the cue. Driven by beatTime so it's deterministic across frames.
const RETICULE_DIRECT_FLASH_HZ = 6;
const RETICULE_DIRECT_FLASH_DEPTH = 0.7;
const RETICULE_DIRECT_FLASH_LINE_WIDTH_BOOST = 1.5;
// shadow-blur halo turns the flash into a glow that bleeds outside the dashed ring.
const RETICULE_DIRECT_FLASH_GLOW_MAX_BLUR = 24;
const RETICULE_DIRECT_FLASH_GLOW_ALPHA = 0.9;

// pre-check whether any target's silhouette overlaps the on-beat disc before painting anything.
export const reticuleOverlapsAnyTarget = (
  reticulePos: Vec, targets: ReadonlyArray<ReticuleTarget>, w: number, h: number,
): boolean => {
  for (const t of targets) {
    const [dx, dy] = toroidalDelta(reticulePos.x - t.pos.x, reticulePos.y - t.pos.y, w, h);
    const rSum = (t.radius ?? 0) + BULLET_HIT_RADIUS_ON_BEAT;
    if (dx * dx + dy * dy <= rSum * rSum) return true;
  }
  return false;
};

// stricter "directly on" check — the reticule's centre is inside the target's body. Used for
// the loud flash cue (vs. just-near, which uses the broader overlap above).
export const reticuleDirectlyOnTarget = (
  reticulePos: Vec, targets: ReadonlyArray<ReticuleTarget>, w: number, h: number,
): boolean => {
  for (const t of targets) {
    const [dx, dy] = toroidalDelta(reticulePos.x - t.pos.x, reticulePos.y - t.pos.y, w, h);
    const r = t.radius ?? 0;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
};

// triangle wave in [0, DEPTH] driven by beatTime — reads as a clear flicker, not a slow pulse.
export const computeDirectFlashPulse = (beatTime: number): number => {
  const phase = (beatTime * RETICULE_DIRECT_FLASH_HZ) % 1;
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return RETICULE_DIRECT_FLASH_DEPTH * tri;
};

// dim during cooldown + slow pulse so the player feels the rhythm window even with nothing in sight.
export const computeBaseHitAlpha = (onCooldown: boolean, hitboxPulse: number): number =>
  RETICULE_HITBOX_ALPHA * (onCooldown ? RETICULE_COOLDOWN_DIM : 1) * hitboxPulse;

// two concentric dashed circles — inner is off-beat hit radius, outer is on-beat (larger).
// directFlash adds an overt flicker when the disc centre is over an object body, including a
// shadow-blur halo so it reads as a glow rather than just a brightness bump.
export const paintAimDiscs = (
  ctx: CanvasRenderingContext2D, reticulePos: Vec, baseAlpha: number,
  overlapsTarget: boolean, directFlash: number,
) => {
  const overlapBoost = overlapsTarget ? RETICULE_OVERLAP_BRIGHTNESS : 1;
  const hitAlpha = Math.min(1, baseAlpha * overlapBoost * (1 + directFlash));
  const flash01 = directFlash > 0 ? directFlash / RETICULE_DIRECT_FLASH_DEPTH : 0;
  ctx.globalAlpha = 1;
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  if (flash01 > 0) {
    ctx.shadowBlur = RETICULE_DIRECT_FLASH_GLOW_MAX_BLUR * flash01;
    ctx.shadowColor = `hsla(${RETICULE_DASH_HSL}, ${RETICULE_DIRECT_FLASH_GLOW_ALPHA * flash01})`;
  }
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${hitAlpha})`;
  ctx.lineWidth = 1 + directFlash * RETICULE_DIRECT_FLASH_LINE_WIDTH_BOOST;
  ctx.setLineDash(RETICULE_LINE_DASH);
  ctx.beginPath();
  ctx.arc(reticulePos.x, reticulePos.y, BULLET_HIT_RADIUS_OFF_BEAT, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(reticulePos.x, reticulePos.y, BULLET_HIT_RADIUS_ON_BEAT, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = prevShadowBlur;
  ctx.shadowColor = prevShadowColor;
};
