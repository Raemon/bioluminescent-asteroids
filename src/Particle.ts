import { Vec } from "./vec";
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

  // In-place compaction + mutating integration: no per-frame array alloc, no
  // per-particle Vec alloc. With hundreds of particles flying every frame this
  // was a meaningful GC source.
  update(dt: number) {
    const arr = this.particles;
    let write = 0;
    for (let read = 0; read < arr.length; read++) {
      const p = arr[read];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      const drag = 1 - p.drag * dt;
      p.vel.x *= drag;
      p.vel.y *= drag;
      if (write !== read) arr[write] = p;
      write++;
    }
    arr.length = write;
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
