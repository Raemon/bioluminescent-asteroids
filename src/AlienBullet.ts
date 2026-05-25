import { Vec, add, mul, wrap, TAU } from "./vec";
import { drawGlow } from "./glow";
import { AlienSize } from "./Alien";

// Bullets shot BY aliens. The player can be hit by them (handled in Game).
// Distinct hue from player bullets (cyan/gold) — these run hot pink/violet/
// green per source so the player can read "incoming, not mine" at a glance.
export class AlienBullet {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  radius = 3.4;
  hue: number;
  size: AlienSize;
  trail: Vec[] = [];

  constructor(pos: Vec, vel: Vec, size: AlienSize, hue: number) {
    this.pos = { ...pos };
    this.vel = vel;
    this.size = size;
    this.hue = hue;
    // Long enough for a typical cross-screen traverse at the slowest bullet
    // speed (~220 px/s for big alien bullets). Off-screen bullets wrap with
    // the rest of the world.
    this.maxLife = 4.5;
    this.life = this.maxLife;
  }

  update(dt: number, w: number, h: number) {
    this.life -= dt;
    this.trail.push({ ...this.pos });
    if (this.trail.length > 10) this.trail.shift();
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const trailHue = this.hue;
    const headHue = this.hue;
    for (let i = 0; i < this.trail.length; i++) {
      const segmentT = i / this.trail.length;
      const p = this.trail[i];
      const r = this.radius * segmentT * 1.4;
      drawGlow(ctx, p.x, p.y, r * 5, trailHue, 0.55 * segmentT);
    }
    const r = this.radius;
    drawGlow(ctx, this.pos.x, this.pos.y, r * 7, headHue, 0.95);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `hsla(${headHue + 40}, 100%, 96%, 1)`;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
