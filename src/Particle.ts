import { Vec, add, mul } from "./vec";
import { drawGlow } from "./glow";

export type Particle = {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  size: number;
  hue: number;
  shrink: number;
  drag: number;
};

export class ParticleSystem {
  particles: Particle[] = [];

  emit(p: Particle) {
    this.particles.push(p);
  }

  update(dt: number) {
    const aliveParticles: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.pos = add(p.pos, mul(p.vel, dt));
      p.vel = mul(p.vel, 1 - p.drag * dt);
      aliveParticles.push(p);
    }
    this.particles = aliveParticles;
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      const alpha = t * t;
      const r = p.size * (p.shrink ? t : 1);
      drawGlow(ctx, p.pos.x, p.pos.y, r * 4, p.hue, alpha);
    }
    ctx.globalAlpha = 1;
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      const alpha = t * t;
      const r = p.size * (p.shrink ? t : 1);
      ctx.fillStyle = `hsla(${p.hue}, 100%, 95%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
