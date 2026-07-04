import { Vec, v, rand, sub, len, mul, TAU, addScaledMut, circleHit, wrapMut } from "./vec";
import { OCTAHEDRON_EDGES, projectOctahedron } from "./octahedron";

// A fuel cell — the consolation drop a gold-ore rock leaves when an on-beat
// crack DOESN'T contain an upgrade (Fuel Mode only). It's drawn in the SAME
// family as the powerup canisters — a 3D tumbling wireframe octahedron in a
// soft bloom with a central glyph — so the player reads it as "a pickup pod"
// at a glance. It's kept distinct from a real upgrade by being coolant CYAN
// (the pods are white) and carrying a fuel-drop glyph instead of a letter, so
// the read is "same kind of thing, but it's fuel, not an upgrade". It drifts
// gently from the crack site, then dims and flicker-warps out after a long life.

// Coolant cyan so it reads as "fuel", clearly apart from the white powerup pods.
const ORB_HUE = 188;
const LIFETIME = 16;
// final fraction of life spent fading + flickering as a warp-out warning.
const FADE_TAIL = LIFETIME * 0.25;
const ORB_RADIUS = 13;

export class FuelOrb {
  pos: Vec;
  vel: Vec;
  hue = ORB_HUE;
  // Generous pickup radius — this is a reward, not a precision target.
  radius = ORB_RADIUS;
  age = 0;
  alive = true;
  // Three independent tumble axes, same as the powerup pod, so the projected
  // wireframe never settles into a flat 2D spin and reads as a 3D object.
  rotX: number;
  rotY: number;
  rotZ: number;
  rotSpeedX: number;
  rotSpeedY: number;
  rotSpeedZ: number;

  constructor(pos: Vec, vel: Vec) {
    this.pos = pos;
    this.vel = vel;
    this.rotX = rand(0, TAU);
    this.rotY = rand(0, TAU);
    this.rotZ = rand(0, TAU);
    // Slightly lazier tumble than a real pod so it feels like a settled drop
    // rather than fresh incoming traffic.
    this.rotSpeedX = rand(-1.6, 1.6);
    this.rotSpeedY = rand(-1.6, 1.6);
    this.rotSpeedZ = rand(-0.9, 0.9);
  }

  update(dt: number, w: number, h: number) {
    this.age += dt;
    this.rotX += this.rotSpeedX * dt;
    this.rotY += this.rotSpeedY * dt;
    this.rotZ += this.rotSpeedZ * dt;
    addScaledMut(this.pos, this.vel, dt);
    wrapMut(this.pos, w, h);
    // ease the drift toward a near-stop so the orb settles where it can be grabbed.
    this.vel.x *= Math.max(0, 1 - dt * 0.8);
    this.vel.y *= Math.max(0, 1 - dt * 0.8);
    if (this.age >= LIFETIME) this.alive = false;
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    return circleHit(this.pos, this.radius, point, pointRadius);
  }

  // Tail-end fade + quickening flicker, same warp-out warning the gem uses.
  private fadeAlpha(time: number): number {
    const remaining = LIFETIME - this.age;
    if (remaining >= FADE_TAIL) return 1;
    const tail = Math.max(0, remaining / FADE_TAIL);
    const flicker = 0.7 + 0.3 * Math.sin(time * (7 + (1 - tail) * 20));
    return tail * flicker;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    const time = t * 0.001;
    const fade = this.fadeAlpha(time);
    const pulse = 0.75 + 0.25 * Math.sin(time * 3 + this.age * 2);
    const H = this.hue;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Soft coolant-cyan bloom around the cell — the pod has a white bloom; ours
    // is tinted so the colour reads even before the wireframe resolves.
    const halo = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, this.radius * 2.0);
    halo.addColorStop(0, `hsla(${H}, 90%, 70%, ${0.5 * pulse * fade})`);
    halo.addColorStop(1, `hsla(${H}, 90%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius * 2.0, 0, TAU);
    ctx.fill();

    // 3D tumble: the same wireframe octahedron as the powerup pod, cyan instead
    // of white, with the same depth-fade so front edges pop.
    const r = this.radius * 1.05;
    const projected = projectOctahedron(this.rotX, this.rotY, this.rotZ, r);

    ctx.translate(this.pos.x, this.pos.y);
    ctx.lineWidth = 1.4;
    for (const [a, b] of OCTAHEDRON_EDGES) {
      const va = projected[a];
      const vb = projected[b];
      const depth = (va.z + vb.z) * 0.5;
      const depthAlpha = 0.55 + 0.45 * ((depth + r) / (2 * r));
      const light = 60 + 30 * depthAlpha;
      ctx.strokeStyle = `hsla(${H}, 95%, ${light.toFixed(0)}%, ${(0.85 * pulse * depthAlpha * fade).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(va.x, va.y);
      ctx.lineTo(vb.x, vb.y);
      ctx.stroke();
    }

    // Glyph stays upright so the player can always read it: a fuel drop, drawn
    // as a small filled teardrop so it's distinct from the pods' letters but the
    // same "marked pickup" idea.
    this.drawFuelGlyph(ctx, this.radius * 0.7, pulse * fade);

    ctx.restore();
  }

  // A simple upright fuel-drop glyph (rounded teardrop) centred on the cell.
  // Filled bright cyan with a tiny specular dot so it reads as a glowing droplet
  // rather than a flat shape, matching the pods' bright upright glyph.
  private drawFuelGlyph(ctx: CanvasRenderingContext2D, s: number, alpha: number) {
    const H = this.hue;
    ctx.beginPath();
    // teardrop: a point at the top easing into a round belly at the bottom.
    ctx.moveTo(0, -s);
    ctx.bezierCurveTo(s * 0.85, -s * 0.1, s * 0.78, s * 0.85, 0, s * 0.85);
    ctx.bezierCurveTo(-s * 0.78, s * 0.85, -s * 0.85, -s * 0.1, 0, -s);
    ctx.closePath();
    ctx.fillStyle = `hsla(${H - 4}, 100%, 85%, ${(0.95 * alpha).toFixed(3)})`;
    ctx.fill();
    // small upper specular so the droplet looks wet/lit.
    ctx.fillStyle = `hsla(${H + 8}, 100%, 96%, ${(0.9 * alpha).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(-s * 0.22, s * 0.18, s * 0.22, 0, TAU);
    ctx.fill();
  }
}

// Spawn a fuel orb at the cracked-open ore's spot, drifting a touch toward a
// random nearby point so it eases away from the crack and parks within reach.
export const spawnFuelOrbAt = (pos: Vec, w: number, h: number): FuelOrb => {
  const aim = v(rand(80, w - 80), rand(80, h - 80));
  const delta = sub(aim, pos);
  const dist = len(delta) || 1;
  const dir = mul(delta, 1 / dist);
  return new FuelOrb({ ...pos }, mul(dir, rand(25, 55)));
};
