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

// Tiny static background stars — no twinkle, no halo, no per-frame
// trig. Baked once into a sprite at construct/resize time so the dense
// field costs nothing at draw time.
type DustStar = {
  x: number;
  y: number;
  size: number;
  hue: number;
  alpha: number;
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
  dust: DustStar[] = [];
  nebula: NebulaBlob[] = [];
  w: number;
  h: number;
  // Pre-rendered nebula layer. The nebula barely moves (a slow ±40px drift),
  // so baking it once and translating the whole canvas per frame is visually
  // indistinguishable from per-frame rebuilds at a fraction of the cost.
  nebulaSprite: HTMLCanvasElement | null = null;
  // Pre-rendered dust-star layer. Dense, faint, static — bakes once so the
  // sub-pixel-level field is free at draw time.
  dustSprite: HTMLCanvasElement | null = null;

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
    // Dense field of pin-prick stars. ~10x the count of the twinkling layer
    // so unlit planet silhouettes show as voids against texture rather than
    // floating in featureless black.
    const dustCount = Math.floor((w * h) / 240);
    for (let i = 0; i < dustCount; i++) {
      this.dust.push({
        x: rand(0, w),
        y: rand(0, h),
        size: rand(0.25, 0.7),
        hue: rand(180, 260),
        alpha: rand(0.18, 0.55),
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
    this.buildDustSprite();
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

  buildDustSprite() {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(this.w));
    canvas.height = Math.max(1, Math.floor(this.h));
    const ctx = canvas.getContext("2d")!;
    ctx.globalCompositeOperation = "lighter";
    for (const d of this.dust) {
      ctx.fillStyle = `hsla(${d.hue}, 70%, 88%, ${d.alpha})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
      ctx.fill();
    }
    this.dustSprite = canvas;
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.buildNebulaSprite();
    this.buildDustSprite();
  }

  // camera is optional so the starfield still renders fine in isolation
  // (tests, splash screens). When supplied, the field rolls around the
  // pulsar's focal point and the closer (lower-depth) twinkling stars fan
  // outward from it as approach grows, so the whole scene reads as one
  // coherent camera dolly rather than a static backdrop behind a moving
  // pulsar. The pre-baked dust + nebula sprites get a single shared rolled-
  // and-zoomed transform (uniform parallax for the deepest layer); the
  // twinkling stars are repositioned per-star so their parallax scales by
  // depth.
  render(
    ctx: CanvasRenderingContext2D,
    t: number,
    camera?: { focalX: number; focalY: number; roll: number; approach: number },
  ) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    const focalX = camera ? camera.focalX : this.w / 2;
    const focalY = camera ? camera.focalY : this.h / 2;
    const roll = camera ? camera.roll : 0;
    const approach = camera ? camera.approach : 0;
    // Deepest layers (nebula, dust) move the least — a small uniform zoom
    // outward from the focal point so they still feel attached to the
    // camera but don't streak past.
    const farZoom = 1 + 0.06 * approach;
    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);

    if (this.nebulaSprite) {
      const driftX = Math.sin(t * 0.0003) * 20;
      const driftY = Math.cos(t * 0.00025) * 20;
      ctx.save();
      ctx.translate(focalX, focalY);
      ctx.rotate(roll);
      ctx.scale(farZoom, farZoom);
      ctx.translate(-focalX + driftX, -focalY + driftY);
      ctx.drawImage(this.nebulaSprite, 0, 0);
      ctx.restore();
    }
    if (this.dustSprite) {
      ctx.save();
      ctx.translate(focalX, focalY);
      ctx.rotate(roll);
      ctx.scale(farZoom, farZoom);
      ctx.translate(-focalX, -focalY);
      ctx.drawImage(this.dustSprite, 0, 0);
      ctx.restore();
    }

    for (const starInField of this.stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * 0.001 * starInField.twinkleSpeed + starInField.twinklePhase);
      const alpha = 0.13 + 0.32 * twinkle * starInField.depth;
      const size = starInField.size * (0.7 + 0.3 * twinkle);
      // Per-star parallax: closer (lower depth) stars fan outward from the
      // focal point faster. Combined with the camera roll, the field reads
      // as a real 3D dolly toward the pulsar.
      const parallax = 1 + approach * (0.42 - 0.32 * starInField.depth);
      const rx = (starInField.x - focalX) * parallax;
      const ry = (starInField.y - focalY) * parallax;
      const sx = focalX + rx * cosR - ry * sinR;
      const sy = focalY + rx * sinR + ry * cosR;
      ctx.fillStyle = `hsla(${starInField.hue}, 80%, 85%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(sx, sy, size, 0, Math.PI * 2);
      ctx.fill();
      if (starInField.size > 1.3) {
        ctx.fillStyle = `hsla(${starInField.hue}, 80%, 85%, ${alpha * 0.4})`;
        ctx.beginPath();
        ctx.arc(sx, sy, size * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
