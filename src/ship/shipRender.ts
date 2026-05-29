import type { Ship } from "../Ship";
import { Vec, add, fromAngle, TAU } from "../vec";
import { POWERUP_HUE } from "../Canister";
import { renderComboHalo } from "./shipComboHalo";

// Why: per-frame jitter when invuln makes the ship visually telegraph that it can't be hit yet.
const invulnFlicker = (ship: Ship, t: number): number =>
  ship.invuln > 0 ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.025)) : 1;

// Why: triangle vertices in local space; reused for stroke + fill.
const shipHullVertices = (ship: Ship): Vec[] => [
  fromAngle(ship.heading, ship.radius * 1.4),
  fromAngle(ship.heading + Math.PI * 0.78, ship.radius * 1.0),
  fromAngle(ship.heading - Math.PI * 0.78, ship.radius * 1.0),
];

// Why: hull brightness sits at a baseline and snaps to peak on each beat, then fades — matches the
//   combo halo's snap-and-fade so every ship light shares one rhythm.
const paintShipHull = (ctx: CanvasRenderingContext2D, verts: Vec[], invuln: number, beatPulse: number) => {
  const beatBrightness = 0.7 + 0.3 * beatPulse;
  ctx.strokeStyle = `hsla(195, 100%, 75%, ${0.95 * beatBrightness * invuln})`;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "hsla(195, 100%, 70%, 1)";
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (const vert of verts.slice(1)) ctx.lineTo(vert.x, vert.y);
  ctx.closePath();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = `hsla(195, 100%, 60%, ${0.12 * invuln})`;
  ctx.fill();
};

// Why: thrust flame is a hot radial gradient anchored behind the ship; jitter sells active combustion.
const paintThrustFlame = (ctx: CanvasRenderingContext2D, ship: Ship) => {
  if (!ship.thrustOn) return;
  const back = fromAngle(ship.heading + Math.PI, ship.radius * 1.8 + Math.random() * 4);
  const grad = ctx.createRadialGradient(back.x, back.y, 0, back.x, back.y, 18);
  grad.addColorStop(0, "hsla(200, 100%, 80%, 0.9)");
  grad.addColorStop(0.5, "hsla(200, 100%, 60%, 0.3)");
  grad.addColorStop(1, "hsla(200, 100%, 60%, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(back.x, back.y, 18, 0, TAU);
  ctx.fill();
};

// Why: a single retro flare at one corner — hot white core + cyan halo, jitter for arc-light feel.
const paintRetroCornerFlare = (ctx: CanvasRenderingContext2D, ship: Ship, cornerOffset: number, flarePulse: number) => {
  const corner = fromAngle(ship.heading + cornerOffset, ship.radius * 1.0);
  const tip = add(corner, fromAngle(ship.heading, ship.radius * 0.55 + Math.random() * 3));
  const flareR = 12 * flarePulse;
  const grad = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, flareR);
  grad.addColorStop(0, "hsla(200, 100%, 92%, 1.0)");
  grad.addColorStop(0.35, "hsla(200, 100%, 70%, 0.55)");
  grad.addColorStop(1, "hsla(200, 100%, 60%, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, flareR, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `hsla(50, 100%, 92%, ${0.85 * flarePulse})`;
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 1.6, 0, TAU);
  ctx.fill();
};

// Why: twin flares show the retro venting forward from both rear corners, sells "reverse" visually.
const paintRetroFlares = (ctx: CanvasRenderingContext2D, ship: Ship) => {
  if (!ship.reverseThrustOn) return;
  const flarePulse = 0.85 + Math.random() * 0.3;
  for (const cornerOffset of [Math.PI * 0.78, -Math.PI * 0.78]) {
    paintRetroCornerFlare(ctx, ship, cornerOffset, flarePulse);
  }
};

// Why: shield ring snaps to peak on the beat and fades — same rhythm as the hull/halo.
const paintShieldRing = (ctx: CanvasRenderingContext2D, ship: Ship, beatPulse: number) => {
  if (!ship.shieldActive) return;
  const shieldRadius = ship.radius * 1.9;
  const shieldBrightness = 0.6 + 0.4 * beatPulse;
  const shieldHue = POWERUP_HUE.shield;
  ctx.strokeStyle = `hsla(${shieldHue}, 100%, 80%, ${0.75 * shieldBrightness})`;
  ctx.lineWidth = 1.4;
  ctx.shadowColor = `hsla(${shieldHue}, 100%, 70%, 1)`;
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.arc(0, 0, shieldRadius, 0, TAU);
  ctx.stroke();
  ctx.shadowBlur = 0;
};

// Why: ~8% cosmetic scale-up on the beat draws the eye to the rhythm without affecting collisions.
const applyBeatScale = (ctx: CanvasRenderingContext2D, beatPulse: number) => {
  if (beatPulse <= 0) return;
  const beatScale = 1 + 0.08 * beatPulse;
  ctx.scale(beatScale, beatScale);
};

// Why: all visual layers (halo behind, hull, thrust/retro flames, shield ring) painted in one save block.
export const renderShipBody = (ctx: CanvasRenderingContext2D, ship: Ship, t: number, beatPulse: number) => {
  if (!ship.alive) return;
  const invuln = invulnFlicker(ship, t);
  const verts = shipHullVertices(ship);
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  applyBeatScale(ctx, beatPulse);
  ctx.globalCompositeOperation = "lighter";
  renderComboHalo(ctx, ship, beatPulse);
  paintShipHull(ctx, verts, invuln, beatPulse);
  paintThrustFlame(ctx, ship);
  paintRetroFlares(ctx, ship);
  paintShieldRing(ctx, ship, beatPulse);
  ctx.restore();
};
