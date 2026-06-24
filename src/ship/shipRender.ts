import type { Ship } from "../Ship";
import { Vec, add, fromAngle, TAU } from "../vec";
// Render-only flame/vent jitter — cosmetic stream so it can't desync replays.
import { cosmeticRng as rng } from "../game/rng";
import { POWERUP_HUE } from "../Canister";
import { renderComboHalo } from "./shipComboHalo";
import { haloVertices } from "./shipHitbox";

const invulnFlicker = (ship: Ship, t: number): number =>
  ship.invuln > 0 ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.025)) : 1;

// triangle vertices in local space; reused for stroke + fill.
const shipHullVertices = (ship: Ship): Vec[] => [
  fromAngle(ship.heading, ship.radius * 1.4),
  fromAngle(ship.heading + Math.PI * 0.78, ship.radius * 1.0),
  fromAngle(ship.heading - Math.PI * 0.78, ship.radius * 1.0),
];

// shares the combo halo's snap-and-fade so every ship light rides one rhythm
const paintShipHull = (ctx: CanvasRenderingContext2D, verts: Vec[], invuln: number, beatPulse: number) => {
  const beatBrightness = 0.7 + 0.3 * beatPulse;
  ctx.strokeStyle = `hsla(195, 100%, 75%, ${0.95 * beatBrightness * invuln})`;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "hsla(195, 100%, 70%, 1)";
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (const vert of verts.slice(1)) ctx.lineTo(vert.x, vert.y);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = `hsla(195, 100%, 60%, ${0.12 * invuln})`;
  ctx.fill();
};

// thrust flame is a hot radial gradient anchored behind the ship; jitter sells active combustion.
const paintThrustFlame = (ctx: CanvasRenderingContext2D, ship: Ship) => {
  if (!ship.thrustOn) return;
  const back = fromAngle(ship.heading + Math.PI, ship.radius * 1.8 + rng() * 4);
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
  const tip = add(corner, fromAngle(ship.heading, ship.radius * 0.55 + rng() * 3));
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
  const flarePulse = 0.85 + rng() * 0.3;
  for (const cornerOffset of [Math.PI * 0.78, -Math.PI * 0.78]) {
    paintRetroCornerFlare(ctx, ship, cornerOffset, flarePulse);
  }
};

// side-engine jet vents from the flank opposite the push direction. Warm hue
// separates it visually from the cyan forward/retro flames so the player can
// tell which engine is firing at a glance.
const paintSideJet = (ctx: CanvasRenderingContext2D, ship: Ship, side: "port" | "starboard") => {
  const ventAngle = ship.heading + (side === "port" ? Math.PI / 2 : -Math.PI / 2);
  const vent = fromAngle(ventAngle, ship.radius * 0.85 + rng() * 3);
  const flareR = 12 * (0.85 + rng() * 0.3);
  const grad = ctx.createRadialGradient(vent.x, vent.y, 0, vent.x, vent.y, flareR);
  grad.addColorStop(0, "hsla(38, 100%, 90%, 1.0)");
  grad.addColorStop(0.4, "hsla(28, 100%, 65%, 0.55)");
  grad.addColorStop(1, "hsla(20, 100%, 55%, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(vent.x, vent.y, flareR, 0, TAU);
  ctx.fill();
};

const paintSideJets = (ctx: CanvasRenderingContext2D, ship: Ship) => {
  if (ship.portThrustOn) paintSideJet(ctx, ship, "port");
  if (ship.starboardThrustOn) paintSideJet(ctx, ship, "starboard");
};

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

// shield ring sits outside the hitbox halo — purely cosmetic, multi-pass glow
const paintShieldRing = (ctx: CanvasRenderingContext2D, ship: Ship, beatPulse: number) => {
  if (!ship.shieldActive) return;
  const shieldBrightness = 0.6 + 0.4 * beatPulse;
  const shieldHue = POWERUP_HUE.shield;
  const ringOffset = ship.haloOffset + ship.shieldRingOffset;
  const ring = haloVertices(ship, ringOffset);
  ctx.shadowColor = `hsla(${shieldHue}, 100%, 70%, 1)`;
  ctx.strokeStyle = `hsla(${shieldHue}, 100%, 60%, ${0.35 * shieldBrightness})`;
  ctx.lineWidth = 4.5;
  traceRoundedTriangle(ctx, ring, 10);
  ctx.stroke();
  ctx.strokeStyle = `hsla(${shieldHue}, 100%, 88%, ${0.95 * shieldBrightness})`;
  ctx.lineWidth = 1.6;
  traceRoundedTriangle(ctx, ring, 10);
  ctx.stroke();
};

// cosmetic on-beat scale-up — draws the eye to the rhythm, hitbox unchanged
const applyBeatScale = (ctx: CanvasRenderingContext2D, beatPulse: number) => {
  if (beatPulse <= 0) return;
  const beatScale = 1 + 0.08 * beatPulse;
  ctx.scale(beatScale, beatScale);
};

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
  paintSideJets(ctx, ship);
  paintShieldRing(ctx, ship, beatPulse);
  ctx.restore();
};
