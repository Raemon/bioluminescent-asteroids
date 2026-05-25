import { Vec, add, mul, wrap, TAU } from "./vec";
import { drawGlow } from "./glow";

export class Bullet {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  radius = 2.5;
  trail: Vec[] = [];
  // True when fired within the on-beat window. Drives a brighter, gold-tinted
  // glow so the player can see at a glance that the shot landed on the grid,
  // and is read by Game on collision to apply the combo score multiplier.
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

  update(dt: number, w: number, h: number) {
    this.life -= dt;
    this.trail.push({ ...this.pos });
    if (this.trail.length > 8) this.trail.shift();
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const trailHue = this.onBeat ? 48 : this.pierce ? 60 : 180;
    const headHue = this.onBeat ? 50 : this.pierce ? 60 : 180;
    const trailAlphaScale = this.onBeat ? 0.85 : 0.5;
    const headAlpha = this.onBeat ? 1.0 : 0.9;
    const headRadiusMul = this.onBeat ? 9 : 7;
    for (let i = 0; i < this.trail.length; i++) {
      const segmentT = i / this.trail.length;
      const p = this.trail[i];
      const r = this.radius * segmentT * 1.5;
      drawGlow(ctx, p.x, p.y, r * 5, trailHue, trailAlphaScale * segmentT);
    }

    const r = this.radius;
    drawGlow(ctx, this.pos.x, this.pos.y, r * headRadiusMul, headHue, headAlpha);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.onBeat ? "hsla(54, 100%, 96%, 1)" : this.pierce ? "hsla(60, 100%, 96%, 1)" : "hsla(180, 100%, 98%, 1)";
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
