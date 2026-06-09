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
  // The big-iris laser shot — drawn as a beam-streak (long bright trail,
  // lensflare muzzle, white-hot core) rather than a soft plasma orb.
  isBossLaser = false;
  // Post-break hemisphere plasma ball — drawn as a heavy charged sphere
  // with a long crimson tail and a soft inner star. Distinct silhouette
  // from the laser so the player can read "slow ball, dodgeable arc" vs
  // "fast laser, react now".
  isBossHemiPlasma = false;
  // Optional cross-fade window at end of life. When set, alpha ramps from 1
  // at (life == fadeStartLife) down to 0 at (life == 0).
  fadeStartLife = 0;

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
    const trailCap = this.isBossLaser ? 28 : 10;
    if (this.trail.length > trailCap) this.trail.shift();
    addScaledMut(this.pos, this.vel, dt);
    wrapMut(this.pos, w, h);
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const trailHue = this.hue;
    const headHue = this.hue;
    if (this.isBoss) {
      // End-of-life fade window: hemisphere plasma fades out over its last
      // beat instead of just popping when life hits 0.
      let alpha = 1;
      if (this.fadeStartLife > 0 && this.life < this.fadeStartLife) {
        alpha = Math.max(0, this.life / this.fadeStartLife);
      }
      if (this.isBossLaser) {
        // Beam-streak laser. Long bright tail along the entire trail
        // history, white-hot core at the head, prismatic blue/violet
        // perpendicular flare. Reads as a continuous beam fired from the
        // muzzle even though the underlying entity is a fast bullet.
        // Tail beam.
        for (let i = 0; i < this.trail.length; i++) {
          const segmentT = i / this.trail.length;
          const p = this.trail[i];
          drawGlow(ctx, p.x, p.y, this.radius * (2.2 + 3.5 * segmentT), trailHue, 0.7 * segmentT * alpha);
          drawGlow(ctx, p.x, p.y, this.radius * (0.8 + 1.4 * segmentT), trailHue + 30, 0.9 * segmentT * alpha, true);
        }
        // Hot inner ribbon — narrow white core stretched along the trail.
        if (this.trail.length > 1) {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.lineCap = "round";
          ctx.strokeStyle = `hsla(48, 100%, 96%, 0.95)`;
          ctx.lineWidth = this.radius * 0.55;
          ctx.beginPath();
          ctx.moveTo(this.trail[0].x, this.trail[0].y);
          for (let i = 1; i < this.trail.length; i++) ctx.lineTo(this.trail[i].x, this.trail[i].y);
          ctx.lineTo(this.pos.x, this.pos.y);
          ctx.stroke();
          ctx.restore();
        }
        // Head: brilliant white-hot core + wide crimson corona + a
        // perpendicular lensflare slash that sells the beam tip.
        drawGlow(ctx, this.pos.x, this.pos.y, this.radius * 5.5, headHue, 0.9 * alpha);
        drawGlow(ctx, this.pos.x, this.pos.y, this.radius * 2.5, headHue + 25, 0.95 * alpha, true);
        ctx.fillStyle = `hsla(48, 100%, 98%, ${0.98 * alpha})`;
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, this.radius * 0.85, 0, Math.PI * 2);
        ctx.fill();
        // Perpendicular lensflare line — short hot streak crossing the
        // beam tip to suggest a focusing aperture.
        const angle = Math.atan2(this.vel.y, this.vel.x);
        const perpX = -Math.sin(angle);
        const perpY = Math.cos(angle);
        const flareR = this.radius * 4.5;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.lineCap = "round";
        ctx.strokeStyle = `hsla(48, 100%, 96%, 0.85)`;
        ctx.lineWidth = this.radius * 0.4;
        ctx.beginPath();
        ctx.moveTo(this.pos.x - perpX * flareR, this.pos.y - perpY * flareR);
        ctx.lineTo(this.pos.x + perpX * flareR, this.pos.y + perpY * flareR);
        ctx.stroke();
        ctx.restore();
        ctx.restore();
        return;
      }
      // Heavy plasma sphere (boss whole-body iris and post-break
      // hemispheres). Chunky bright core with a wide crimson corona, fat
      // tapered tail, and a slow orbiting inner glint that makes the ball
      // feel "alive" rather than flat.
      for (let i = 0; i < this.trail.length; i++) {
        const segmentT = i / this.trail.length;
        const p = this.trail[i];
        drawGlow(ctx, p.x, p.y, this.radius * (1.6 + 1.0 * segmentT), trailHue, 0.55 * segmentT * alpha);
      }
      drawGlow(ctx, this.pos.x, this.pos.y, this.radius * (this.isBossHemiPlasma ? 4.6 : 3.8), headHue, 0.85 * alpha);
      drawGlow(ctx, this.pos.x, this.pos.y, this.radius * (this.isBossHemiPlasma ? 1.9 : 1.5), headHue + 30, 0.9 * alpha, true);
      ctx.fillStyle = `hsla(48, 100%, 96%, ${0.95 * alpha})`;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.radius * (this.isBossHemiPlasma ? 0.6 : 0.5), 0, Math.PI * 2);
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
