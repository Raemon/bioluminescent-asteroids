import { Vec, addScaledMut, wrapMut } from "./vec";
import { drawGlow } from "./glow";
import { AlienSize } from "./Alien";
import { BEAT_GRID } from "./game/rhythmConstants";

// Bullets shot BY aliens. The player can be hit by them (handled in Game).
// Distinct hue from player bullets (cyan/gold) — these run hot pink/violet/
// green per source so the player can read "incoming, not mine" at a glance.
// Per-size visible radius. All three are tight stingers — the big one only
// reads as larger because its dart is longer, not because the head balloons.
const SIZE_BULLET_RADIUS: Record<AlienSize, number> = {
  big: 3.6,
  medium: 3.0,
  small: 2.4,
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

  // Boss plasma bolts use the same bullet pool but render as a chunky orb
  // rather than a stinger and have their own size/life envelope. The flag is
  // checked in render(); a true value bypasses the AlienSize sizing.
  isBoss = false;

  constructor(pos: Vec, vel: Vec, size: AlienSize, hue: number, isBoss: boolean = false) {
    this.pos = { ...pos };
    this.vel = vel;
    this.size = size;
    this.hue = hue;
    if (isBoss) {
      this.isBoss = true;
      // Big slow plasma sphere. Long flight time so an off-screen wrap
      // doesn't make it disappear mid-arc; chunky radius so the player can
      // read the threat at a glance.
      this.radius = 14;
      this.maxLife = BEAT_GRID * 8;
    } else {
      this.radius = SIZE_BULLET_RADIUS[size];
      this.maxLife = BEAT_GRID * SIZE_BULLET_LIFE_BEATS[size];
    }
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
    if (this.isBoss) {
      // Heavy plasma sphere — chunky bright core with a wide crimson
      // corona and a fat tapered tail. Reads at a glance as "incoming,
      // dodge it" without imitating the alien stinger silhouette.
      for (let i = 0; i < this.trail.length; i++) {
        const segmentT = i / this.trail.length;
        const p = this.trail[i];
        drawGlow(ctx, p.x, p.y, this.radius * (1.6 + 1.0 * segmentT), trailHue, 0.55 * segmentT);
      }
      drawGlow(ctx, this.pos.x, this.pos.y, this.radius * 3.8, headHue, 0.85);
      drawGlow(ctx, this.pos.x, this.pos.y, this.radius * 1.5, headHue + 30, 0.9, true);
      ctx.fillStyle = `hsla(48, 100%, 96%, 0.95)`;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.radius * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    // Tighter trail — narrower glow so the bullet reads as a precise stinger
    // rather than a smeared comet.
    for (let i = 0; i < this.trail.length; i++) {
      const segmentT = i / this.trail.length;
      const p = this.trail[i];
      const r = this.radius * segmentT * 1.0;
      drawGlow(ctx, p.x, p.y, r * 3.2, trailHue, 0.42 * segmentT);
    }
    const r = this.radius;
    // Restrained head halo — small bright core, not a blob.
    drawGlow(ctx, this.pos.x, this.pos.y, r * 3.5, headHue, 0.85);
    ctx.globalAlpha = 1;
    const angle = Math.atan2(this.vel.y, this.vel.x);
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(angle);
    // Per-size stinger silhouettes — all sharp slim darts pointed along
    // velocity. Big gets the longest barbed nose, medium a clean dart, small
    // a tight pinprick needle.
    let len: number;
    let waist: number;
    let tail: number;
    if (this.size === "big") {
      len = r * 4.2;
      waist = r * 0.9;
      tail = r * 1.8;
    } else if (this.size === "medium") {
      len = r * 4.0;
      waist = r * 0.75;
      tail = r * 1.5;
    } else {
      len = r * 3.6;
      waist = r * 0.6;
      tail = r * 1.2;
    }
    // Darker violet outline halo behind the bright core gives the stinger
    // a faint shadow so it stays legible on bright backgrounds.
    ctx.fillStyle = `hsla(${headHue}, 90%, 55%, 0.85)`;
    ctx.beginPath();
    ctx.moveTo(len, 0);
    ctx.lineTo(0, -waist);
    ctx.lineTo(-tail, -waist * 0.4);
    ctx.lineTo(-tail, waist * 0.4);
    ctx.lineTo(0, waist);
    ctx.closePath();
    ctx.fill();
    // Bright inner stinger — same shape, pulled in slightly so the violet
    // edge frames the white core.
    ctx.fillStyle = `hsla(${headHue + 40}, 100%, 96%, 1)`;
    ctx.beginPath();
    ctx.moveTo(len * 0.88, 0);
    ctx.lineTo(0, -waist * 0.7);
    ctx.lineTo(-tail * 0.88, -waist * 0.28);
    ctx.lineTo(-tail * 0.88, waist * 0.28);
    ctx.lineTo(0, waist * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
