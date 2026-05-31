import { Vec, TAU } from "../../vec";
import { RETICULE_DASH_HSL } from "./radarCone";
import { BULLET_HIT_RADIUS_ON_BEAT, BULLET_HIT_RADIUS_OFF_BEAT, ReticuleTarget } from "./trajectoryPreview";
import { toroidalDelta } from "./coneGeometry";

const RETICULE_LINE_DASH: [number, number] = [4, 4];
const RETICULE_HITBOX_ALPHA = 0.28;
const RETICULE_COOLDOWN_DIM = 0.3;
// when the reticule isn't touching a first-beat dot on any trajectory line, drop opacity so
// the bright state reads as a clear "this shot will land on the next beat" cue.
const RETICULE_OFF_FIRST_DOT_DIM = 0.35;
// dashed crosshair sticking out past the outer disc — reads as "this is a targeting sight",
// matching the lock-circle crosshair used on the on-rhythm aim spot.
const RETICULE_CROSSHAIR_GAP = 3;
const RETICULE_CROSSHAIR_LENGTH = 6;
const RETICULE_CROSSHAIR_DASH: [number, number] = [2, 2];
// brightness boost when the disc covers a target tells the player "this shot will land".
const RETICULE_OVERLAP_BRIGHTNESS = 3;

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

// dim during cooldown + slow pulse so the player feels the rhythm window even with nothing in sight.
export const computeBaseHitAlpha = (onCooldown: boolean, hitboxPulse: number): number =>
  RETICULE_HITBOX_ALPHA * (onCooldown ? RETICULE_COOLDOWN_DIM : 1) * hitboxPulse;

// two concentric dashed circles — inner is off-beat hit radius, outer is on-beat (larger).
// Bright only when a first-beat dot sits under the reticule (or tutorial highlight); otherwise
// dim, so the bright state means "this shot lands on the next beat" unambiguously. The per-beat
// pulse already lives in `baseAlpha` via the caller, so no time-varying flicker is added here.
export const paintAimDiscs = (
  ctx: CanvasRenderingContext2D, reticulePos: Vec, baseAlpha: number,
  overlapsTarget: boolean, onFirstBeatDot: boolean,
  tutorialHighlight: boolean = false,
) => {
  const overlapBoost = overlapsTarget ? RETICULE_OVERLAP_BRIGHTNESS : 1;
  const locked = onFirstBeatDot || tutorialHighlight;
  const offDotDim = locked ? 1 : RETICULE_OFF_FIRST_DOT_DIM;
  const hitAlpha = Math.min(1, baseAlpha * overlapBoost * offDotDim);
  ctx.globalAlpha = 1;
  const prevShadowBlur = ctx.shadowBlur;
  const prevShadowColor = ctx.shadowColor;
  if (tutorialHighlight) {
    ctx.shadowBlur = TUTORIAL_HIGHLIGHT_GLOW_BLUR;
    ctx.shadowColor = `hsla(${TUTORIAL_HIGHLIGHT_GLOW_HSL}, ${TUTORIAL_HIGHLIGHT_GLOW_ALPHA})`;
  }
  const dashHsl = tutorialHighlight ? TUTORIAL_HIGHLIGHT_HSL : RETICULE_DASH_HSL;
  ctx.strokeStyle = `hsla(${dashHsl}, ${tutorialHighlight ? Math.max(hitAlpha, 0.85) : hitAlpha})`;
  ctx.lineWidth = 1;
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
