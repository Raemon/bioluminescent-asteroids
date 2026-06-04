// Shared glow-sprite cache. We pre-render a radial gradient into an offscreen
// canvas per hue bucket and then blit it with drawImage instead of allocating a
// new radial gradient every frame for every particle/bullet/nucleus. This is
// the single biggest Canvas2D performance lever in this codebase.

const SPRITE_SIZE = 128;
const HUE_BUCKET_STEP = 15;
const HUE_BUCKETS = Math.ceil(360 / HUE_BUCKET_STEP);

const glowSpriteByBucket: HTMLCanvasElement[] = new Array(HUE_BUCKETS);
let whiteGlowSprite: HTMLCanvasElement | null = null;

const buildGlowSprite = (hue: number, saturation: number): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext("2d")!;
  const c = SPRITE_SIZE / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, `hsla(${hue}, ${saturation}%, 80%, 1)`);
  grad.addColorStop(0.25, `hsla(${hue}, ${saturation}%, 65%, 0.55)`);
  grad.addColorStop(0.6, `hsla(${hue}, ${saturation}%, 55%, 0.15)`);
  grad.addColorStop(1, `hsla(${hue}, ${saturation}%, 55%, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return canvas;
};

export const getGlowSprite = (hue: number): HTMLCanvasElement => {
  const normalized = ((hue % 360) + 360) % 360;
  const bucket = Math.floor(normalized / HUE_BUCKET_STEP) % HUE_BUCKETS;
  let sprite = glowSpriteByBucket[bucket];
  if (!sprite) {
    sprite = buildGlowSprite(bucket * HUE_BUCKET_STEP, 95);
    glowSpriteByBucket[bucket] = sprite;
  }
  return sprite;
};

// combo ≥ 12 wants a true-white glow — building a desaturated sprite once
// is cheaper than baking saturation into every cached hue bucket.
const getWhiteGlowSprite = (): HTMLCanvasElement => {
  if (!whiteGlowSprite) whiteGlowSprite = buildGlowSprite(0, 0);
  return whiteGlowSprite;
};

// Draws a glow blob of radius `r` at (x, y) using the cached sprite. The
// sprite extends a bit past its full radius for soft falloff, so we draw at
// 2*r on a side. Uses globalAlpha for fade; the caller is responsible for
// restoring composite state.
export const drawGlow = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  hue: number,
  alpha: number,
  white: boolean = false,
) => {
  const sprite = white ? getWhiteGlowSprite() : getGlowSprite(hue);
  const size = r * 2;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, x - r, y - r, size, size);
};
