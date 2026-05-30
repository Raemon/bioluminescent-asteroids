import { Vec, add, mul, wrap, TAU } from "./vec";
import { drawGlow } from "./glow";
import { AlienSize } from "./Alien";
import { BEAT_GRID } from "./game/rhythmConstants";

// Bullets shot BY aliens. The player can be hit by them (handled in Game).
// Distinct hue from player bullets (cyan/gold) — these run hot pink/violet/
// green per source so the player can read "incoming, not mine" at a glance.
// Per-size visible radius. Small bullets read as a faster, tighter pinprick;
// medium/big stay chunky so their threat is legible at distance.
const SIZE_BULLET_RADIUS: Record<AlienSize, number> = {
  big: 3.8,
  medium: 3.4,
  small: 2.2,
};

export class AlienBullet {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  radius: number;
  hue: number;
  size: AlienSize;
  trail: Vec[] = [];

  constructor(pos: Vec, vel: Vec, size: AlienSize, hue: number) {
    this.pos = { ...pos };
    this.vel = vel;
    this.size = size;
    this.hue = hue;
    this.radius = SIZE_BULLET_RADIUS[size];
    // 3 beats of life vs the old 2 — same speed, so total range scales 1.5×.
    this.maxLife = BEAT_GRID * 3;
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
