import { Vec, add, mul, wrap, TAU } from "./vec";

export class Bullet {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  radius = 2.5;
  trail: Vec[] = [];

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
    for (let i = 0; i < this.trail.length; i++) {
      const segmentT = i / this.trail.length;
      const p = this.trail[i];
      const r = this.radius * segmentT * 1.5;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 5);
      grad.addColorStop(0, `hsla(180, 100%, 80%, ${0.5 * segmentT})`);
      grad.addColorStop(1, "hsla(180, 100%, 60%, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 5, 0, TAU);
      ctx.fill();
    }

    const r = this.radius;
    const halo = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, r * 7);
    halo.addColorStop(0, "hsla(180, 100%, 90%, 0.9)");
    halo.addColorStop(0.4, "hsla(180, 100%, 70%, 0.4)");
    halo.addColorStop(1, "hsla(180, 100%, 60%, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, r * 7, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "hsla(180, 100%, 98%, 1)";
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
