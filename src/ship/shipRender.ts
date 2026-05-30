import type { Ship } from "../Ship";
import { Vec, add, fromAngle, TAU } from "../vec";
import { POWERUP_HUE } from "../Canister";
import { renderComboHalo } from "./shipComboHalo";
import { haloVertices } from "./shipHitbox";

// per-frame jitter when invuln makes the ship visually telegraph that it can't be hit yet.
const invulnFlicker = (ship: Ship, t: number): number =>
  ship.invuln > 0 ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.025)) : 1;

// triangle vertices in local space; reused for stroke + fill.
const shipHullVertices = (ship: Ship): Vec[] => [
  fromAngle(ship.heading, ship.radius * 1.4),
  fromAngle(ship.heading + Math.PI * 0.78, ship.radius * 1.0),
  fromAngle(ship.heading - Math.PI * 0.78, ship.radius * 1.0),
];

// hull brightness sits at a baseline and snaps to peak on each beat, then fades — matches the
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

// thrust flame is a hot radial gradient anchored behind the ship; jitter sells active combustion.
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

// a single retro flare at one corner — hot white core + cyan halo, jitter for arc-light feel.
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

// twin flares show the retro venting forward from both rear corners, sells "reverse" visually.
const paintRetroFlares = (ctx: CanvasRenderingContext2D, ship: Ship) => {
  if (!ship.reverseThrustOn) return;
  const flarePulse = 0.85 + Math.random() * 0.3;
  for (const cornerOffset of [Math.PI * 0.78, -Math.PI * 0.78]) {
    paintRetroCornerFlare(ctx, ship, cornerOffset, flarePulse);
  }
};

// rounded-corner triangle path tracing the halo polygon; cornerRadius is in local pixels.
const traceRoundedTriangle = (
  ctx: CanvasRenderingContext2D,
  verts: Array<[number, number]>,
  cornerRadius: number,
) => {
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const prev = verts[(i + 2) % 3];
    const curr = verts[i];
    const next = verts[(i + 1) % 3];
    const inX = curr[0] - prev[0], inY = curr[1] - prev[1];
    const outX = next[0] - curr[0], outY = next[1] - curr[1];
    const inLen = Math.hypot(inX, inY) || 1;
    const outLen = Math.hypot(outX, outY) || 1;
    const r = Math.min(cornerRadius, inLen * 0.5, outLen * 0.5);
    const enter: [number, number] = [curr[0] - (inX / inLen) * r, curr[1] - (inY / inLen) * r];
    const exit: [number, number] = [curr[0] + (outX / outLen) * r, curr[1] + (outY / outLen) * r];
    if (i === 0) ctx.moveTo(enter[0], enter[1]);
    else ctx.lineTo(enter[0], enter[1]);
    ctx.quadraticCurveTo(curr[0], curr[1], exit[0], exit[1]);
  }
  ctx.closePath();
};

// shield draws a rounded-corner triangle tracing the (expanded) halo polygon — same shape as the hitbox.
const paintShieldRing = (ctx: CanvasRenderingContext2D, ship: Ship, beatPulse: number) => {
  if (!ship.shieldActive) return;
  const shieldBrightness = 0.6 + 0.4 * beatPulse;
  const shieldHue = POWERUP_HUE.shield;
  const halo = haloVertices(ship);
  ctx.strokeStyle = `hsla(${shieldHue}, 100%, 80%, ${0.75 * shieldBrightness})`;
  ctx.lineWidth = 1.4;
  ctx.shadowColor = `hsla(${shieldHue}, 100%, 70%, 1)`;
  ctx.shadowBlur = 16;
  traceRoundedTriangle(ctx, halo, 6);
  ctx.stroke();
  ctx.shadowBlur = 0;
};

// ~8% cosmetic scale-up on the beat draws the eye to the rhythm without affecting collisions.
const applyBeatScale = (ctx: CanvasRenderingContext2D, beatPulse: number) => {
  if (beatPulse <= 0) return;
  const beatScale = 1 + 0.08 * beatPulse;
  ctx.scale(beatScale, beatScale);
};

// all visual layers (halo behind, hull, thrust/retro flames, shield ring) painted in one save block.
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
