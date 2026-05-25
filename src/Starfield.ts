import { rand } from "./vec";

type Star = {
  x: number;
  y: number;
  size: number;
  hue: number;
  twinklePhase: number;
  twinkleSpeed: number;
  depth: number;
};

type NebulaBlob = {
  x: number;
  y: number;
  radius: number;
  hue: number;
  alpha: number;
  driftX: number;
  driftY: number;
};

export class Starfield {
  stars: Star[] = [];
  nebula: NebulaBlob[] = [];
  w: number;
  h: number;
  // Pre-rendered nebula layer. The nebula barely moves (a slow ±40px drift),
  // so baking it once and translating the whole canvas per frame is visually
  // indistinguishable from per-frame rebuilds at a fraction of the cost.
  nebulaSprite: HTMLCanvasElement | null = null;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const starCount = Math.floor((w * h) / 2400);
    for (let i = 0; i < starCount; i++) {
      this.stars.push({
        x: rand(0, w),
        y: rand(0, h),
        size: rand(0.3, 2.0),
        hue: rand(180, 260),
        twinklePhase: rand(0, Math.PI * 2),
        twinkleSpeed: rand(0.4, 2.0),
        depth: rand(0.2, 1.0),
      });
    }
    const nebulaBlobsByLocation = [
      { x: w * 0.2, y: h * 0.3 },
      { x: w * 0.75, y: h * 0.7 },
      { x: w * 0.5, y: h * 0.5 },
      { x: w * 0.85, y: h * 0.2 },
      { x: w * 0.15, y: h * 0.85 },
    ];
    for (const loc of nebulaBlobsByLocation) {
      this.nebula.push({
        x: loc.x,
        y: loc.y,
        radius: rand(180, 380),
        hue: rand(200, 290),
        alpha: rand(0.03, 0.08),
        driftX: rand(-3, 3),
        driftY: rand(-3, 3),
      });
    }
    this.buildNebulaSprite();
  }

  buildNebulaSprite() {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(this.w));
    canvas.height = Math.max(1, Math.floor(this.h));
    const ctx = canvas.getContext("2d")!;
    ctx.globalCompositeOperation = "lighter";
    for (const nebulaBlob of this.nebula) {
      const grad = ctx.createRadialGradient(nebulaBlob.x, nebulaBlob.y, 0, nebulaBlob.x, nebulaBlob.y, nebulaBlob.radius);
      grad.addColorStop(0, `hsla(${nebulaBlob.hue}, 90%, 60%, ${nebulaBlob.alpha})`);
      grad.addColorStop(0.5, `hsla(${nebulaBlob.hue + 20}, 80%, 50%, ${nebulaBlob.alpha * 0.4})`);
      grad.addColorStop(1, `hsla(${nebulaBlob.hue}, 90%, 60%, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(nebulaBlob.x - nebulaBlob.radius, nebulaBlob.y - nebulaBlob.radius, nebulaBlob.radius * 2, nebulaBlob.radius * 2);
    }
    this.nebulaSprite = canvas;
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.buildNebulaSprite();
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (this.nebulaSprite) {
      const driftX = Math.sin(t * 0.0003) * 20;
      const driftY = Math.cos(t * 0.00025) * 20;
      ctx.drawImage(this.nebulaSprite, driftX, driftY);
    }
    for (const starInField of this.stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * 0.001 * starInField.twinkleSpeed + starInField.twinklePhase);
      const alpha = 0.13 + 0.32 * twinkle * starInField.depth;
      const size = starInField.size * (0.7 + 0.3 * twinkle);
      ctx.fillStyle = `hsla(${starInField.hue}, 80%, 85%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(starInField.x, starInField.y, size, 0, Math.PI * 2);
      ctx.fill();
      if (starInField.size > 1.3) {
        ctx.fillStyle = `hsla(${starInField.hue}, 80%, 85%, ${alpha * 0.4})`;
        ctx.beginPath();
        ctx.arc(starInField.x, starInField.y, size * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
