import { Vec, TAU } from "../../vec";
import { RETICULE_DASH_HSL } from "./radarCone";
import { BULLET_HIT_RADIUS_ON_BEAT, BULLET_HIT_RADIUS_OFF_BEAT, ReticuleTarget } from "./trajectoryPreview";
import { toroidalDelta } from "./coneGeometry";

const RETICULE_LINE_DASH: [number, number] = [4, 4];
const RETICULE_HITBOX_ALPHA = 0.28;
const RETICULE_COOLDOWN_DIM = 0.3;
// dashed crosshair sticking out past the outer disc — reads as "this is a targeting sight",
// matching the lock-circle crosshair used on the on-rhythm aim spot.
const RETICULE_CROSSHAIR_GAP = 3;
const RETICULE_CROSSHAIR_LENGTH = 6;
const RETICULE_CROSSHAIR_DASH: [number, number] = [2, 2];
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

// tutorial highlight ("Use your targeting tools to aim.") — repaints the dashed ring
// in white with a steady yellow shadow-blur halo so the player's eye is pulled to it.
const TUTORIAL_HIGHLIGHT_HSL = "0, 0%, 100%";
const TUTORIAL_HIGHLIGHT_GLOW_HSL = "52, 100%, 60%";
const TUTORIAL_HIGHLIGHT_GLOW_BLUR = 18;
const TUTORIAL_HIGHLIGHT_GLOW_ALPHA = 0.9;

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
  overlapsTarget: boolean, directFlash: number, tutorialHighlight: boolean = false,
) => {
  const overlapBoost = overlapsTarget ? RETICULE_OVERLAP_BRIGHTNESS : 1;
  const hitAlpha = Math.min(1, baseAlpha * overlapBoost * (1 + directFlash));
  const flash01 = directFlash > 0 ? directFlash / RETICULE_DIRECT_FLASH_DEPTH : 0;
  ctx.globalAlpha = 1;
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  if (tutorialHighlight) {
    ctx.shadowBlur = TUTORIAL_HIGHLIGHT_GLOW_BLUR;
    ctx.shadowColor = `hsla(${TUTORIAL_HIGHLIGHT_GLOW_HSL}, ${TUTORIAL_HIGHLIGHT_GLOW_ALPHA})`;
  } else if (flash01 > 0) {
    ctx.shadowBlur = RETICULE_DIRECT_FLASH_GLOW_MAX_BLUR * flash01;
    ctx.shadowColor = `hsla(${RETICULE_DASH_HSL}, ${RETICULE_DIRECT_FLASH_GLOW_ALPHA * flash01})`;
  }
  const dashHsl = tutorialHighlight ? TUTORIAL_HIGHLIGHT_HSL : RETICULE_DASH_HSL;
  ctx.strokeStyle = `hsla(${dashHsl}, ${tutorialHighlight ? Math.max(hitAlpha, 0.85) : hitAlpha})`;
  ctx.lineWidth = 1 + directFlash * RETICULE_DIRECT_FLASH_LINE_WIDTH_BOOST;
  ctx.setLineDash(RETICULE_LINE_DASH);
  ctx.beginPath();
  ctx.arc(reticulePos.x, reticulePos.y, BULLET_HIT_RADIUS_OFF_BEAT, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(reticulePos.x, reticulePos.y, BULLET_HIT_RADIUS_ON_BEAT, 0, TAU);
  ctx.stroke();
  ctx.setLineDash(RETICULE_CROSSHAIR_DASH);
  const cInner = BULLET_HIT_RADIUS_ON_BEAT + RETICULE_CROSSHAIR_GAP;
  const cOuter = cInner + RETICULE_CROSSHAIR_LENGTH;
  ctx.beginPath();
  ctx.moveTo(reticulePos.x - cOuter, reticulePos.y); ctx.lineTo(reticulePos.x - cInner, reticulePos.y);
  ctx.moveTo(reticulePos.x + cInner, reticulePos.y); ctx.lineTo(reticulePos.x + cOuter, reticulePos.y);
  ctx.moveTo(reticulePos.x, reticulePos.y - cOuter); ctx.lineTo(reticulePos.x, reticulePos.y - cInner);
  ctx.moveTo(reticulePos.x, reticulePos.y + cInner); ctx.lineTo(reticulePos.x, reticulePos.y + cOuter);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = prevShadowBlur;
  ctx.shadowColor = prevShadowColor;
};
