import { Vec, addScaledMut, wrapMut, TAU } from "./vec";
import { drawGlow } from "./glow";
import { AlienSize } from "./Alien";
import { BEAT_GRID } from "./game/rhythmConstants";

// Bullets shot BY aliens. The player can be hit by them (handled in Game).
// Distinct hue from player bullets (cyan/gold) — these run hot pink/violet/
// green per source so the player can read "incoming, not mine" at a glance.
// Per-size visible radius. Small bullets read as a faster, tighter pinprick;
// medium/big stay chunky so their threat is legible at distance.
const SIZE_BULLET_RADIUS: Record<AlienSize, number> = {
  big: 2.6,
  medium: 3.4,
  small: 2.2,
};

// Beats of flight time before the bullet expires. Small fires only once every
// 4 beats, so its bullet flies longer to compensate — the threat is sparse but
// covers more of the field per shot.
const SIZE_BULLET_LIFE_BEATS: Record<AlienSize, number> = {
  big: 3,
  medium: 3,
  small: 5,
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
    this.maxLife = BEAT_GRID * SIZE_BULLET_LIFE_BEATS[size];
    this.life = this.maxLife;
  }

  update(dt: number, w: number, h: number) {
    this.life -= dt;
    this.trail.push({ ...this.pos });
    if (this.trail.length > 10) this.trail.shift();
    addScaledMut(this.pos, this.vel, dt);
    wrapMut(this.pos, w, h);
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
    if (this.size === "big") {
      // Pointy dart — long nose, narrow waist, short tail. Oriented along velocity.
      const angle = Math.atan2(this.vel.y, this.vel.x);
      ctx.translate(this.pos.x, this.pos.y);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(r * 3.2, 0);
      ctx.lineTo(r * 0.2, -r * 0.9);
      ctx.lineTo(-r * 1.6, -r * 0.35);
      ctx.lineTo(-r * 1.6, r * 0.35);
      ctx.lineTo(r * 0.2, r * 0.9);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}
