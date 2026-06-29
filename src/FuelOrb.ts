import { Vec, v, rand, sub, len, mul, TAU, addScaledMut, circleHit } from "./vec";
import { drawGlow } from "./glow";
import { cosmeticRng } from "./game/rng";

// Sprite jitter draws from the COSMETIC stream — buildSprite runs lazily inside
// render(), so pulling from the gameplay rng there would desync replays.
const crand = (min: number, max: number) => min + cosmeticRng() * (max - min);

// A coolant cell — the consolation drop a gold-ore rock leaves when an on-beat
// crack DOESN'T contain an upgrade (Fuel Mode only). It used to be a formless
// puff of additive vapour; now it's a real game object: a sealed cyan coolant
// orb with a lit glass body, a banded equator window, a two-stroke rim and a
// soft additive aura, so it reads as a deliberate pickup you fly into rather
// than a stray particle. It drifts gently from the crack site, and after a long
// lifetime dims and flicker-warps out like an uncollected canister.

// Coolant cyan so it reads as "fuel", clearly apart from the gold ore and the
// white powerup pods.
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
  // gentle bob phase so the orb breathes in place rather than sitting dead-still.
  private bobPhase: number;
  // slow 2D spin of the prebaked body so the window catches the light as it turns.
  private rot: number;
  private rotSpeed: number;
  // Prebaked coolant-cell body sprite + its half-extent (radius incl. rim pad).
  private sprite: HTMLCanvasElement | null = null;
  private spriteHalf = 0;
  // Window-only sprite (the bright coolant band on transparent), reused as the
  // additive shimmer overlay so the glow lands on the band and nowhere else.
  private windowSprite: HTMLCanvasElement | null = null;

  constructor(pos: Vec, vel: Vec) {
    this.pos = pos;
    this.vel = vel;
    this.bobPhase = rand(0, TAU);
    this.rot = crand(0, TAU);
    this.rotSpeed = crand(-0.5, 0.5);
  }

  update(dt: number, _w: number, _h: number) {
    this.age += dt;
    this.rot += this.rotSpeed * dt;
    addScaledMut(this.pos, this.vel, dt);
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
    if (!this.sprite) this.buildSprite();
    const time = t * 0.001;
    const fade = this.fadeAlpha(time);
    // Slow asymmetric breathing so the cell swells and thins a touch like a
    // pressurised reserve rather than sitting dead-still.
    const breathe = 0.94 + 0.06 * Math.sin(time * 1.7 + this.bobPhase);
    // coolant shimmer through the window, a slow rolling pulse so the cell reads
    // as "charged" without flashing like a powerup pod.
    const shimmer = 0.5 + 0.5 * Math.sin(time * 2.2 + this.bobPhase);

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    // Soft aura behind the body — additive, kept inside the wrap-pad reach so it
    // never clips at the screen edge. Reads as the cell's coolant haze, not a
    // formless puff: the solid body sits crisply on top of it.
    ctx.globalCompositeOperation = "lighter";
    drawGlow(ctx, 0, 0, this.radius * 1.45, this.hue, 0.22 * fade);
    ctx.globalAlpha = 1;

    // The lit coolant body (glass shell + baked window) — solid, drawn once,
    // just spun and breathed per frame. source-over so the rim occludes cleanly.
    ctx.globalCompositeOperation = "source-over";
    ctx.rotate(this.rot);
    ctx.scale(breathe, breathe);
    ctx.globalAlpha = fade;
    ctx.drawImage(this.sprite!, -this.spriteHalf, -this.spriteHalf);
    ctx.globalAlpha = 1;

    // Additive coolant shimmer over the window band only, keyed to the same
    // baked sprite so the glow rolls across the band in place rather than the
    // whole cell lighting up.
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.45 * shimmer * fade;
    ctx.drawImage(this.windowSprite!, -this.spriteHalf, -this.spriteHalf);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // Prebake the coolant cell once: a near-round glass shell with an offset
  // upper-left hot-spot, a deep cool terminator, a bright coolant window banded
  // across its middle, a crisp specular catch, and a dark/bright two-stroke rim.
  // Static appearance → drawn once, then just rotated/breathed per frame.
  private buildSprite() {
    const R = this.radius;
    const pad = 4;
    const half = R * 1.08 + pad;
    const size = Math.ceil(half * 2);
    this.spriteHalf = half;

    // A faint per-orb oval squash so the cells aren't all identical perfect
    // circles — still clearly round, just with a hint of cast metal/glass.
    const squash = crand(0.94, 1.0);
    const rimPath = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      c.ellipse(0, 0, R * 1.04, R * 1.04 * squash, 0, 0, TAU);
      c.closePath();
    };

    this.sprite = this.paintBody(size, half, rimPath);
    this.windowSprite = this.paintWindow(size, half);
  }

  // Trace the bright coolant window: a band across the cell's equator (capsule
  // shape) where the shell is "transparent" and the glowing reserve shows
  // through. Shared by the body bake and the shimmer overlay so they line up.
  private windowPath(c: CanvasRenderingContext2D, R: number) {
    const bw = R * 1.0; // half-width of the band
    const bh = R * 0.4; // half-height of the band
    c.beginPath();
    c.moveTo(-bw, -bh);
    c.lineTo(bw, -bh);
    c.arc(bw, 0, bh, -Math.PI / 2, Math.PI / 2);
    c.lineTo(-bw, bh);
    c.arc(-bw, 0, bh, Math.PI / 2, -Math.PI / 2);
    c.closePath();
  }

  private paintBody(
    size: number, half: number,
    rimPath: (c: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const c = cv.getContext("2d")!;
    c.translate(half, half);
    const R = this.radius;
    const H = this.hue;

    // Glass shell: deep teal metal-glass with an offset upper-left hot-spot and
    // a cool, dark terminator on the lower-right. Hue drifts cooler into shadow
    // so the shell reads as lit glass, not a flat cyan disc.
    const body = c.createRadialGradient(-R * 0.42, -R * 0.46, R * 0.1, 0, 0, R * 1.32);
    body.addColorStop(0, `hsl(${H - 4}, 70%, 60%)`);
    body.addColorStop(0.5, `hsl(${H}, 62%, 34%)`);
    body.addColorStop(1, `hsl(${H + 14}, 60%, 12%)`);
    c.fillStyle = body;
    rimPath(c);
    c.fill();

    // Interior detail clipped to the shell.
    c.save();
    rimPath(c);
    c.clip();

    // A darker lower-right pool so the unlit half of the shell has weight.
    const shade = c.createRadialGradient(R * 0.4, R * 0.5, 0, R * 0.4, R * 0.5, R * 1.1);
    shade.addColorStop(0, `hsla(${H + 16}, 60%, 8%, 0.5)`);
    shade.addColorStop(1, `hsla(${H + 16}, 60%, 8%, 0)`);
    c.fillStyle = shade;
    c.fillRect(-half, -half, size, size);

    // The coolant window: bright cyan reserve glowing through a banded port,
    // with its own offset hot-spot so the fluid reads as lit, not a flat fill.
    this.paintWindowFluid(c, R, H);

    // Hairline plating seams above and below the window so the shell reads as a
    // machined cell, not a marble.
    c.lineWidth = 1.1;
    c.strokeStyle = `hsla(${H - 6}, 70%, 78%, 0.4)`;
    for (const sy of [-R * 0.62, R * 0.62]) {
      c.beginPath();
      c.moveTo(-R * 0.92, sy);
      c.lineTo(R * 0.92, sy);
      c.stroke();
    }
    c.restore();

    // Crisp specular catch on the lit upper-left shoulder — the cheapest "it's a
    // glass sphere" cue.
    const sx = -R * 0.42, sy = -R * 0.46;
    const spec = c.createRadialGradient(sx, sy, 0, sx, sy, R * 0.4);
    spec.addColorStop(0, `hsla(${H + 6}, 100%, 96%, 0.95)`);
    spec.addColorStop(0.6, `hsla(${H + 6}, 100%, 90%, 0.2)`);
    spec.addColorStop(1, `hsla(${H + 6}, 100%, 90%, 0)`);
    c.fillStyle = spec;
    c.beginPath();
    c.arc(sx, sy, R * 0.4, 0, TAU);
    c.fill();

    // Two-stroke rim: dark outer occlusion contact + thin bright inner catch.
    c.globalCompositeOperation = "source-over";
    c.lineJoin = "round";
    c.lineWidth = 3;
    c.strokeStyle = `hsla(${H + 18}, 50%, 5%, 0.9)`;
    rimPath(c);
    c.stroke();
    c.lineWidth = 1.2;
    c.strokeStyle = `hsla(${H - 4}, 90%, 82%, 0.8)`;
    rimPath(c);
    c.stroke();
    return cv;
  }

  // Paint the glowing coolant fluid into an already-clipped context. Shared by
  // the body bake and the window-only shimmer sprite so they register exactly.
  private paintWindowFluid(c: CanvasRenderingContext2D, R: number, H: number) {
    c.save();
    this.windowPath(c, R);
    c.clip();
    // Bright fluid with an upper-left hot-spot fading to a deeper teal floor.
    const fluid = c.createRadialGradient(-R * 0.3, -R * 0.18, 0, 0, 0, R * 1.05);
    fluid.addColorStop(0, `hsla(${H - 6}, 100%, 92%, 0.98)`);
    fluid.addColorStop(0.45, `hsla(${H}, 100%, 70%, 0.95)`);
    fluid.addColorStop(1, `hsla(${H + 10}, 95%, 40%, 0.92)`);
    c.fillStyle = fluid;
    c.fillRect(-R * 1.3, -R * 0.6, R * 2.6, R * 1.2);
    // A thin bright meniscus line through the middle so the fluid has a level.
    c.strokeStyle = `hsla(${H - 8}, 100%, 96%, 0.7)`;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(-R, -R * 0.06);
    c.lineTo(R, -R * 0.06);
    c.stroke();
    c.restore();

    // A two-stroke frame around the window port so it reads as a sealed glass
    // panel, not a paint smear.
    c.lineJoin = "round";
    c.lineWidth = 2;
    c.strokeStyle = `hsla(${H + 16}, 60%, 6%, 0.85)`;
    this.windowPath(c, R);
    c.stroke();
    c.lineWidth = 0.9;
    c.strokeStyle = `hsla(${H - 6}, 100%, 88%, 0.8)`;
    this.windowPath(c, R);
    c.stroke();
  }

  // Window-only sprite: the coolant fluid on transparent, used as the additive
  // shimmer overlay so the rolling glow lands exactly on the band.
  private paintWindow(size: number, half: number): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const c = cv.getContext("2d")!;
    c.translate(half, half);
    this.paintWindowFluid(c, this.radius, this.hue);
    return cv;
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
