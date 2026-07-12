import type { Vec } from "../vec";
// Seeds only — cosmetic stream so the portal's swirl/jitter never perturbs the
// gameplay RNG draw count and desyncs replays.
import { cosmeticRng as rng } from "./rng";

// A 3D departure portal: comets that time out and aliens that fly past the far
// edge leave THROUGH this instead of fading/popping off. Distinct from the
// canister upgrade's flat radial-streak vortex (Canister.renderWarp) — that one
// is a head-on swirl of spokes collapsing to a point. This is a perspective-
// tilted iris with a tunnel of depth-rings receding INTO the screen, a swirling
// event horizon, and a bright rim, so you read a hole punched in space that the
// body shrinks down through.
//
// The effect is purely cosmetic and self-contained (same lifecycle shape as
// DriftBurst): spawn → update(dt) prunes by life → render() draws additively.
// The body's suck-in (scale-down + slide toward the anchor + spin) lives on the
// entity itself in its warp-out phase; the wormhole only owns the portal so the
// two can be sequenced (open → swallow → collapse) and the body always draws
// in front of the tunnel mouth.

const TAU = Math.PI * 2;

// Lifecycle (seconds): the mouth irises open, holds while the body is swallowed,
// then collapses. WARP_OUT_DURATION on the entity is tuned to land mid-hold.
const OPEN = 0.34;
const HOLD = 0.42;
const CLOSE = 0.4;
export const WORMHOLE_LIFE = OPEN + HOLD + CLOSE;

// Perspective tilt: the portal is an ellipse, not a circle, so it reads as a
// ring lying at an angle in 3D rather than a flat target painted on the screen.
const TILT = 0.46; // vertical squash of the ellipse (1 = head-on circle)

// Long axis (px) of a portal torn by a body of this radius. The floor keeps a
// tiny body from punching an invisibly small hole. spawnWormhole and the
// entity's dive-anchor both go through this so the body always falls toward the
// portal's actual throat.
export const portalLongAxis = (bodyRadius: number): number => Math.max(34, bodyRadius * 1.85);

// Screen offset from the portal centre to its vanishing-point throat, for a body
// of the given radius flying along `heading`. The entity eases its dive toward
// this point; renderWormholes paints the throat spark at the same spot.
export const warpAnchorOffset = (
  bodyRadius: number, heading: number,
): { dx: number; dy: number } => {
  const d = portalLongAxis(bodyRadius) * 0.55 * TILT; // = -ringCenterY at depth 1
  return { dx: Math.sin(heading) * d, dy: -Math.cos(heading) * d };
};

// Depth tunnel: concentric rings shrinking toward a vanishing point, each pushed
// "back" so the eye falls into a receding throat rather than a flat disc.
const TUNNEL_RINGS = 7;

// Hue band for the portal's own light — a cold violet-blue event horizon that
// won't be mistaken for the warm gold of the upgrade warp or a kill explosion.
const RIM_HUE = 268;
const THROAT_HUE = 210;

export type Wormhole = {
  x: number;
  y: number;
  // Long axis of the ellipse (px) at full open — scaled from the body's radius
  // so a big alien tears a bigger hole than a comet.
  radius: number;
  // Orientation of the ellipse's long axis: aligned to the body's heading so the
  // portal looks punched along its line of flight.
  angle: number;
  hueShift: number; // small per-portal hue jitter so they don't all match
  seed: number;
  life: number;
  maxLife: number;
  // Hue overrides for recoloured portals (the wave-skip kind). The defaults
  // reproduce the classic violet departure portal.
  rimHue?: number;
  throatHue?: number;
};

export type WormholeOpts = {
  holdSec?: number;
  rimHue?: number;
  throatHue?: number;
};

export const spawnWormhole = (
  list: Wormhole[], pos: Vec, bodyRadius: number, heading: number,
  opts?: WormholeOpts,
): Wormhole => {
  const life = OPEN + (opts?.holdSec ?? HOLD) + CLOSE;
  const wh: Wormhole = {
    x: pos.x,
    y: pos.y,
    radius: portalLongAxis(bodyRadius),
    angle: heading,
    hueShift: (rng() - 0.5) * 24,
    seed: rng() * TAU,
    life,
    maxLife: life,
    rimHue: opts?.rimHue,
    throatHue: opts?.throatHue,
  };
  list.push(wh);
  return wh;
};

export const updateWormholes = (list: Wormhole[], dt: number): Wormhole[] => {
  for (const wh of list) wh.life -= dt;
  return list.filter((wh) => wh.life > 0);
};

// Seconds a portal spends collapsing at the end of its life. Exported so the
// wave-skip code can cut a portal's remaining life to exactly the collapse.
export const WORMHOLE_CLOSE = CLOSE;

// A portal can swallow the ship only while the mouth is properly gaping —
// not during the iris-open and not once the collapse has begun.
export const wormholeEnterable = (wh: Wormhole): boolean =>
  wh.maxLife - wh.life >= OPEN && wh.life > CLOSE;

// Absolute position of the portal's vanishing-point throat — the point a
// diving body eases toward (mirrors warpAnchorOffset for a live portal).
export const throatPointOf = (wh: Wormhole): { x: number; y: number } => {
  const d = wh.radius * 0.55 * TILT;
  return { x: wh.x + Math.sin(wh.angle) * d, y: wh.y - Math.cos(wh.angle) * d };
};

// Mouth-open factor 0→1→0. Opens over the first OPEN seconds, collapses over
// the final CLOSE seconds of remaining life, holds at 1 between — expressed
// off both ends of the lifetime so a portal whose life is cut short (skip
// portals collapse early at wave end) still irises shut instead of popping.
const mouthOpen = (elapsed: number, life: number): number => {
  let open = 1;
  if (elapsed < OPEN) {
    const p = elapsed / OPEN; // ease-out so it snaps wide then settles
    open = 1 - (1 - p) * (1 - p);
  }
  if (life < CLOSE) {
    const p = 1 - life / CLOSE; // ease-in collapse to a slit
    open = Math.min(open, 1 - p * p);
  }
  return open;
};

// Centre of the tunnel ring at a given depth, in the portal's rotated frame
// (caller has already rotated by wh.angle). Rings march from the mouth (depth 0,
// centred on origin) up the minor axis toward the vanishing point, so the stack
// bores back-and-"up" into the screen.
const ringCenterY = (long: number, depth: number): number => -long * 0.55 * TILT * depth;

// Build the ellipse path for one tunnel ring at the given depth (0 = mouth,
// 1 = vanishing point), in the rotated frame. Deeper rings shrink (perspective
// falloff), slide up toward the vanishing point, and twist — so the stack reads
// as a corkscrew throat, not nested flat circles.
const ringPath = (
  ctx: CanvasRenderingContext2D, long: number, depth: number, swirl: number,
): void => {
  // Receding scale: a perspective-ish 1/(1+kd) falloff packs the far rings
  // tight near the vanishing point.
  const scale = 1 / (1 + depth * 2.4);
  const rx = long * scale;
  const ry = long * TILT * scale;
  const cy = ringCenterY(long, depth);
  const twist = swirl * depth;
  ctx.beginPath();
  const SAMP = 40;
  for (let i = 0; i <= SAMP; i++) {
    const a = (i / SAMP) * TAU + twist;
    const px = Math.cos(a) * rx;
    const py = cy + Math.sin(a) * ry;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
};

export const renderWormholes = (
  ctx: CanvasRenderingContext2D, list: Wormhole[], tSec: number,
): void => {
  if (list.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineJoin = "round";
  for (const wh of list) {
    const elapsed = wh.maxLife - wh.life;
    const open = mouthOpen(elapsed, wh.life);
    if (open < 0.02) continue;
    const long = wh.radius * open;
    const rimHue = (wh.rimHue ?? RIM_HUE) + wh.hueShift;
    const throatHue = (wh.throatHue ?? THROAT_HUE) + wh.hueShift;
    // Slow rotation of the whole swirl, plus a fast shimmer on the rim.
    const swirl = tSec * 1.8 + wh.seed;
    const shimmer = 0.78 + 0.22 * Math.sin(tSec * 18 + wh.seed);

    ctx.save();
    ctx.translate(wh.x, wh.y);
    // One rotated frame for the whole portal: the long axis follows the body's
    // heading, the minor axis is the tilt direction the throat bores along.
    ctx.rotate(wh.angle);

    // 1) Throat glow — a soft elliptical wash filling the mouth so the hole
    //    reads as lit-from-within depth rather than an empty outline. Squash y
    //    to draw the ellipse with a plain radial gradient.
    ctx.save();
    ctx.scale(1, TILT);
    const throat = ctx.createRadialGradient(0, 0, 0, 0, 0, long);
    throat.addColorStop(0, `hsla(${throatHue}, 90%, 70%, ${0.5 * open})`);
    throat.addColorStop(0.55, `hsla(${rimHue}, 85%, 52%, ${0.28 * open})`);
    throat.addColorStop(1, `hsla(${rimHue}, 80%, 30%, 0)`);
    ctx.fillStyle = throat;
    ctx.beginPath();
    ctx.arc(0, 0, long, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 2) Depth tunnel — receding twisted rings boring into the screen. Far
    //    rings are dimmer and bluer (atmospheric depth); the swirl twist makes
    //    the stack corkscrew so the eye falls in.
    for (let r = 0; r < TUNNEL_RINGS; r++) {
      const depth = r / (TUNNEL_RINGS - 1);
      const fade = (1 - depth * 0.78) * open;
      if (fade < 0.03) continue;
      ringPath(ctx, long, depth, swirl);
      ctx.lineWidth = 1.1 + (1 - depth) * 1.6;
      const l = 78 - depth * 34; // brighter at the mouth, dim down the throat
      ctx.strokeStyle = `hsla(${throatHue + depth * 30}, 90%, ${l}%, ${0.55 * fade})`;
      ctx.stroke();
    }

    // 3) Event-horizon rim — the bright leading lip of the mouth. A wide soft
    //    glow stroke with a hot thin core on top, both swept by the shimmer so
    //    the rim crackles with energy.
    ringPath(ctx, long, 0, swirl);
    ctx.lineWidth = 7;
    ctx.strokeStyle = `hsla(${rimHue}, 95%, 72%, ${0.3 * open * shimmer})`;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `hsla(${rimHue}, 100%, 90%, ${0.85 * open * shimmer})`;
    ctx.stroke();

    // 4) Vanishing-point spark — a tiny hot point deep in the throat the body
    //    falls toward (the same point beginWarpOut aims the body at). Brightest
    //    mid-life, gone by collapse.
    const vy = ringCenterY(long, 1);
    const spark = open * shimmer;
    const sg = ctx.createRadialGradient(0, vy, 0, 0, vy, long * 0.3);
    sg.addColorStop(0, `hsla(${throatHue}, 100%, 96%, ${0.9 * spark})`);
    sg.addColorStop(1, `hsla(${throatHue}, 100%, 80%, 0)`);
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(0, vy, long * 0.3, 0, TAU);
    ctx.fill();

    ctx.restore();
  }
  ctx.restore();
};

// How long a body takes to fall all the way through the mouth (warpT 0→1). It
// must finish comfortably BEFORE the mouth starts collapsing (OPEN + HOLD) so
// the body is gone while the throat is still wide — the 0.8 leaves headroom for
// the body to vanish a few frames early even at a low frame rate, rather than
// winking out against an already-shrinking iris.
export const WARP_OUT_DURATION = OPEN + HOLD * 0.8;
