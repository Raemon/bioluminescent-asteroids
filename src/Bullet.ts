import { Vec, add, mul, wrap, TAU } from "./vec";
import { drawGlow } from "./glow";

// Damage dealt by a non-rhythm bullet — enough to one-shot a small asteroid
// but takes the full size table (4/2/1) of hits to chew through a large.
export const BULLET_DAMAGE_BASE = 1;
// Damage dealt by an on-beat bullet — 4× the base, sized to one-shot any
// non-bass asteroid and meaningfully crack a bassteroid (which carries a 4×
// HP multiplier of its own, so an on-beat shot does a "normal hit" against
// armour).
export const BULLET_DAMAGE_BEAT = 4;

export class Bullet {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  // Base radius before any on-beat / pierce sizing. Non-beat shots render
  // and collide at this radius; on-beat shots render slightly larger.
  radius = 1.8;
  trail: Vec[] = [];
  // True when fired within the on-beat window. Drives a deeper-blue, larger
  // glow so the player can see at a glance that the shot landed on the grid,
  // and is read by Game on collision to apply the combo score multiplier.
  // Also bumps the damage from BULLET_DAMAGE_BASE to BULLET_DAMAGE_BEAT.
  onBeat = false;
  // Set by Ship.fire when the player has the pierce powerup active. Game's
  // collision pass keeps a piercing bullet alive on hit instead of consuming
  // it, so a single shot can punch through a row of asteroids.
  pierce = false;

  constructor(pos: Vec, vel: Vec, life: number) {
    this.pos = { ...pos };
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
  }

  damage(): number {
    return this.onBeat ? BULLET_DAMAGE_BEAT : BULLET_DAMAGE_BASE;
  }

  // Effective collision/visual radius. On-beat shots are larger than the
  // base — both visually (heft) and as a small aim-assist for rhythm play.
  effectiveRadius(): number {
    return this.onBeat ? this.radius * 1.7 : this.radius;
  }

  update(dt: number, w: number, h: number) {
    this.life -= dt;
    this.trail.push({ ...this.pos });
    if (this.trail.length > 8) this.trail.shift();
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // On-beat: deep saturated blue (hue 220) — sells "weightier" rhythm shot.
    // Pierce: yellow. Non-beat: pale cyan, smaller and quieter visually.
    const trailHue = this.onBeat ? 220 : this.pierce ? 60 : 180;
    const headHue = this.onBeat ? 222 : this.pierce ? 60 : 180;
    const trailAlphaScale = this.onBeat ? 0.85 : 0.4;
    const headAlpha = this.onBeat ? 1.0 : 0.75;
    const headRadiusMul = this.onBeat ? 10 : 6;
    const coreRadius = this.effectiveRadius();
    for (let i = 0; i < this.trail.length; i++) {
      const segmentT = i / this.trail.length;
      const p = this.trail[i];
      const r = coreRadius * segmentT * 1.5;
      drawGlow(ctx, p.x, p.y, r * 5, trailHue, trailAlphaScale * segmentT);
    }

    drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul, headHue, headAlpha);
    ctx.globalAlpha = 1;
    // Bright core dot — for on-beat use a near-white blue-tinted highlight so
    // the deep-blue halo reads as the carrier and the core still pops.
    ctx.fillStyle = this.onBeat
      ? "hsla(220, 100%, 85%, 1)"
      : this.pierce
        ? "hsla(60, 100%, 96%, 1)"
        : "hsla(180, 100%, 98%, 1)";
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, coreRadius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
