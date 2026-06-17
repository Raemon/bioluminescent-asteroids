import { Vec, add, fromAngle, rand, TAU, addScaledMut, scaleMut } from "./vec";
import { Asteroid } from "./Asteroid";

export class Shard {
  pos: Vec;
  vel: Vec;
  rotation: number;
  rotSpeed: number;
  vertices: Vec[];
  hue: number;
  life: number;
  maxLife: number;

  constructor(pos: Vec, vel: Vec, vertices: Vec[], hue: number, life: number, initialRotation: number) {
    this.pos = pos;
    this.vel = vel;
    this.rotation = initialRotation;
    this.rotSpeed = rand(-2, 2);
    this.vertices = vertices;
    this.hue = hue;
    this.life = life;
    this.maxLife = life;
  }

  update(dt: number) {
    addScaledMut(this.pos, this.vel, dt);
    scaleMut(this.vel, 1 - 0.5 * dt);
    this.rotation += this.rotSpeed * dt;
    this.life -= dt;
  }

  render(ctx: CanvasRenderingContext2D) {
    const t = this.life / this.maxLife;
    if (t <= 0) return;
    const alpha = t * t;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    for (let i = 0; i < this.vertices.length; i++) {
      const vx = this.vertices[i].x;
      const vy = this.vertices[i].y;
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
    ctx.fillStyle = `hsla(${this.hue}, 80%, 35%, ${alpha * 0.3})`;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `hsla(${this.hue + 15}, 100%, 80%, ${alpha})`;
    ctx.stroke();
    ctx.restore();
  }
}

export const shatterAsteroid = (asteroid: Asteroid): Shard[] => {
  const shardCount = asteroid.size === "huge" ? 14 : asteroid.size === "large" ? 10 : asteroid.size === "medium" ? 7 : 5;
  const shards: Shard[] = [];
  const samples = asteroid.outline.length;
  const indexBucketsBySharedShard = Array.from({ length: shardCount }, (_, i) => i);
  for (const shardIndex of indexBucketsBySharedShard) {
    const startIdx = Math.floor((shardIndex / shardCount) * samples);
    const endIdx = Math.floor(((shardIndex + 1) / shardCount) * samples);
    const verts: Vec[] = [{ x: 0, y: 0 }];
    for (let i = startIdx; i <= endIdx; i++) {
      const idx = i % samples;
      const angle = (idx / samples) * TAU;
      const r = asteroid.outline[idx];
      verts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    const midAngle = ((startIdx + endIdx) / 2 / samples) * TAU + asteroid.rotation;
    const speed = rand(60, 160);
    const outwardVel = fromAngle(midAngle, speed);
    const totalVel = add(outwardVel, asteroid.vel);
    shards.push(new Shard({ ...asteroid.pos }, totalVel, verts, asteroid.hue, rand(0.9, 1.6), asteroid.rotation));
  }
  return shards;
};
