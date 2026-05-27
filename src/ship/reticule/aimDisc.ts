import { Vec, TAU } from "../../vec";
import { RETICULE_DASH_HSL } from "./radarCone";
import { BULLET_HIT_RADIUS_ON_BEAT, BULLET_HIT_RADIUS_OFF_BEAT, ReticuleTarget } from "./trajectoryPreview";
import { toroidalDelta } from "./coneGeometry";

const RETICULE_LINE_DASH: [number, number] = [4, 4];
const RETICULE_HITBOX_ALPHA = 0.28;
const RETICULE_COOLDOWN_DIM = 0.3;
// Why: brightness boost when the disc covers a target tells the player "this shot will land".
const RETICULE_OVERLAP_BRIGHTNESS = 3;

// Why: pre-check whether any target's silhouette overlaps the on-beat disc before painting anything.
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

// Why: dim during cooldown + slow pulse so the player feels the rhythm window even with nothing in sight.
export const computeBaseHitAlpha = (onCooldown: boolean, hitboxPulse: number): number =>
  RETICULE_HITBOX_ALPHA * (onCooldown ? RETICULE_COOLDOWN_DIM : 1) * hitboxPulse;

// Why: two concentric dashed circles — inner is off-beat hit radius, outer is on-beat (larger).
export const paintAimDiscs = (
  ctx: CanvasRenderingContext2D, reticulePos: Vec, baseAlpha: number, overlapsTarget: boolean,
) => {
  const hitAlpha = baseAlpha * (overlapsTarget ? RETICULE_OVERLAP_BRIGHTNESS : 1);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${hitAlpha})`;
  ctx.lineWidth = 1;
  ctx.setLineDash(RETICULE_LINE_DASH);
  ctx.beginPath();
  ctx.arc(reticulePos.x, reticulePos.y, BULLET_HIT_RADIUS_OFF_BEAT, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(reticulePos.x, reticulePos.y, BULLET_HIT_RADIUS_ON_BEAT, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
};
