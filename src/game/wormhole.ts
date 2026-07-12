import type { Vec } from "../vec";
// Seeds only — cosmetic stream so the portal's swirl/jitter never perturbs the
// gameplay RNG draw count and desyncs replays.
import { cosmeticRng as rng } from "./rng";

// A departure portal: comets that time out and aliens that fly past the far
// edge leave THROUGH this instead of fading/popping off. Distinct from the
// canister upgrade's flat radial-streak vortex (Canister.renderWarp) — that one
// is a head-on swirl of spokes collapsing to a point. This is a round hole in
// space — an outer bezel RIM ringing an INNER iris with a swirling event horizon
// and a tunnel of depth-rings receding into the screen — so a body reads as
// dropping down a shaft, and it reads the same from every approach because its
// slight tilt is fixed to the SCREEN, not to the body's line of flight.
//
// Aesthetic: it shares the aliens' crimson-manta bioluminescence — the rim is
// carved with radial rib ticks like the manta's wing seams, and the whole thing
// glows in the same blood-red band the aliens live in — so an alien diving home
// reads as returning to something of its own kind. (Recolour hooks stay live so
// the wave-skip portals can wear their distinct emerald.)
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

// Screen-fixed tilt: the hole is an ellipse squashed on the vertical so it reads
// as a round shaft seen from slightly above rather than a flat disc — but the
// squash is ALWAYS along the screen's y-axis, never rotated to the body's
// heading, so the portal looks identical no matter which way a body approached.
const TILT = 0.6; // vertical squash of the ellipse (1 = head-on circle)

// The inner iris (the actual hole) sits inside the outer bezel rim, which frames
// it. This is the inner iris's fraction of the full long axis; the gap out to 1
// is the rim's width.
const INNER_FRAC = 0.74;

// Long axis (px) of a portal torn by a body of this radius. The floor keeps a
// tiny body from punching an invisibly small hole. spawnWormhole and the
// entity's dive-anchor both go through this so the body always falls toward the
// portal's actual throat.
export const portalLongAxis = (bodyRadius: number): number => Math.max(40, bodyRadius * 2.0);

// Screen offset from the portal centre to its vanishing-point throat. Because
// the tilt is screen-fixed the throat always sits straight up-screen from the
// centre (up the minor axis), independent of the body's heading — every body
// dives "up and back" into the same visible shaft. The entity eases its dive
// toward this point; renderWormholes paints the throat spark at the same spot.
export const warpAnchorOffset = (
  bodyRadius: number, _heading: number,
): { dx: number; dy: number } => {
  const d = portalLongAxis(bodyRadius) * INNER_FRAC * 0.55 * TILT; // = -ringCenterY at depth 1
  return { dx: 0, dy: -d };
};

// Depth tunnel: concentric rings shrinking toward a vanishing point, each pushed
// "back" so the eye falls into a receding throat rather than a flat disc.
const TUNNEL_RINGS = 7;

// Hue band for the portal's own light — the aliens' blood-red crimson so a
// departing manta reads as returning to something of its own kind. The rim runs
// a touch warmer (toward orange-red) than the deep-red throat, echoing the
// alien family's own big→small hue drift.
const RIM_HUE = 6;
const THROAT_HUE = 354;

export type Wormhole = {
  x: number;
  y: number;
  // Long axis of the ellipse (px) at full open — scaled from the body's radius
  // so a big alien tears a bigger hole than a comet.
  radius: number;
  // Vestigial: the portal's tilt is now screen-fixed, so nothing rotates the
  // frame by this. Kept as a small per-portal phase so the rim ticks and swirl
  // don't all line up between simultaneous portals. spawnWormhole seeds it from
  // the heading purely so replays stay deterministic.
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
// diving body eases toward (mirrors warpAnchorOffset for a live portal). The
// tilt is screen-fixed, so the throat sits straight up-screen from the centre.
export const throatPointOf = (wh: Wormhole): { x: number; y: number } => {
  const d = wh.radius * INNER_FRAC * 0.55 * TILT;
  return { x: wh.x, y: wh.y - d };
};

// Clip the current context so that anything drawn afterward is HIDDEN where it
// crosses behind the far (upper) lip of the portal's inner iris — the ship
// sinking into the hole vanishes down the throat instead of floating over it.
//
// The mask is the whole viewport MINUS the far half of the inner iris: the top
// half of the tilted iris ellipse, from its horizontal centre-line up. A hull
// pixel up-screen of that centre-line and inside the iris falls in the hole and
// is masked away; the near (lower) lip never hides anything, so the ship reads
// as tucking under the far rim while its near side still overlaps the mouth.
//
// Coords are world-space — call it inside the same camera-translated frame the
// ship draws in. `screenW/H` bound the "keep everything" outer rect (generous
// padding covers shake); `open` mirrors renderWormholes so the iris the crop
// uses matches the one on screen exactly.
export const clipBehindPortalFarLip = (
  ctx: CanvasRenderingContext2D, wh: Wormhole, screenW: number, screenH: number,
): void => {
  const elapsed = wh.maxLife - wh.life;
  const open = mouthOpen(elapsed, wh.life);
  if (open < 0.02) return;
  const inner = wh.radius * INNER_FRAC * open;
  const ry = inner * TILT;
  // Outer rect spans well past the viewport in every direction (the frame is
  // camera-translated, so 0,0 isn't the screen origin) — it's the "show this".
  const pad = Math.max(screenW, screenH);
  ctx.beginPath();
  ctx.rect(wh.x - screenW - pad, wh.y - screenH - pad, (screenW + pad) * 2, (screenH + pad) * 2);
  // Far-half of the iris as its own closed sub-path: the upper semicircle of the
  // tilted ellipse (canvas −y is up-screen, so π→2π sweeps the top edge), closed
  // along its diameter. moveTo starts it fresh so no stray chord links it to the
  // rect. evenodd punches this hole out of the rect → everything but the far lip
  // survives.
  ctx.moveTo(wh.x - inner, wh.y);
  ctx.ellipse(wh.x, wh.y, inner, ry, 0, Math.PI, TAU);
  ctx.closePath();
  ctx.clip("evenodd");
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

// Centre of the tunnel ring at a given depth, in the portal's (unrotated,
// screen-fixed) frame. Rings march from the inner-iris mouth (depth 0, centred
// on origin) straight up-screen toward the vanishing point, so the stack bores
// back-and-"up" into the screen the same way from every approach. `inner` is the
// inner iris's long axis (= long * INNER_FRAC).
const ringCenterY = (inner: number, depth: number): number => -inner * 0.55 * TILT * depth;

// Build the ellipse path for one tunnel ring at the given depth (0 = inner mouth,
// 1 = vanishing point), squashed on the screen y-axis. Deeper rings shrink
// (perspective falloff), slide up toward the vanishing point, and twist — so the
// stack reads as a corkscrew throat, not nested flat circles.
const ringPath = (
  ctx: CanvasRenderingContext2D, inner: number, depth: number, swirl: number,
): void => {
  // Receding scale: a perspective-ish 1/(1+kd) falloff packs the far rings
  // tight near the vanishing point.
  const scale = 1 / (1 + depth * 2.4);
  const rx = inner * scale;
  const ry = inner * TILT * scale;
  const cy = ringCenterY(inner, depth);
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

// Trace a screen-fixed tilted ellipse of the given long axis into the current
// path — the shared silhouette of the outer bezel and the inner iris.
const ellipsePath = (ctx: CanvasRenderingContext2D, long: number): void => {
  ctx.beginPath();
  ctx.ellipse(0, 0, long, long * TILT, 0, 0, TAU);
};

// Number of radial rib ticks carved around the outer bezel — the manta-wing
// seam vocabulary borrowed onto the rim so the hole reads as the aliens' own
// architecture rather than a generic vortex.
const RIM_TICKS = 22;

// Paint the outer bezel rim: a raised ring framing the inner iris, carved with
// radial rib ticks like the alien wings' structural seams, lit in the crimson
// band. `long` is the full long axis, `inner` the iris long axis it frames.
const renderRim = (
  ctx: CanvasRenderingContext2D,
  long: number, inner: number, rimHue: number, open: number, shimmer: number,
  swirl: number,
): void => {
  // 1) Bezel band — a soft glowing annulus between the iris edge and the outer
  //    lip, brightest along its mid-line so it reads as a rounded raised rim.
  ctx.save();
  ctx.scale(1, TILT);
  const mid = (long + inner) * 0.5;
  const band = ctx.createRadialGradient(0, 0, inner * 0.92, 0, 0, long);
  band.addColorStop(0, `hsla(${rimHue - 6}, 90%, 30%, 0)`);
  band.addColorStop((mid - inner * 0.92) / (long - inner * 0.92), `hsla(${rimHue}, 95%, 55%, ${0.5 * open * shimmer})`);
  band.addColorStop(1, `hsla(${rimHue + 6}, 85%, 34%, 0)`);
  ctx.fillStyle = band;
  ctx.beginPath();
  ctx.arc(0, 0, long, 0, TAU);
  ctx.arc(0, 0, inner * 0.92, 0, TAU, true);
  ctx.fill("evenodd");
  ctx.restore();

  // 2) Radial rib ticks — short spokes bridging the iris edge to the outer lip,
  //    evenly spaced around the bezel like the manta's wing seams. The swirl
  //    phase drifts them so the rim slowly turns.
  ctx.lineCap = "round";
  for (let i = 0; i < RIM_TICKS; i++) {
    const a = (i / RIM_TICKS) * TAU + swirl * 0.15;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x0 = ca * inner;
    const y0 = sa * inner * TILT;
    const x1 = ca * long;
    const y1 = sa * long * TILT;
    // Ticks catch the light unevenly — a slow per-tick shimmer keeps the rim
    // crackling with the same bioluminescent flicker the alien ribs have.
    const flick = 0.55 + 0.45 * Math.sin(swirl * 2.2 + i * 1.7);
    ctx.strokeStyle = `hsla(${rimHue + 8}, 100%, 62%, ${0.5 * open * flick})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // 3) Outer lip — a bright thin ring bounding the whole hole, with a soft wide
  //    glow underneath, so the bezel has a clean crackling edge.
  ellipsePath(ctx, long);
  ctx.lineWidth = 6;
  ctx.strokeStyle = `hsla(${rimHue}, 95%, 68%, ${0.28 * open * shimmer})`;
  ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = `hsla(${rimHue + 6}, 100%, 88%, ${0.7 * open * shimmer})`;
  ctx.stroke();
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
    const inner = long * INNER_FRAC;
    const rimHue = (wh.rimHue ?? RIM_HUE) + wh.hueShift;
    const throatHue = (wh.throatHue ?? THROAT_HUE) + wh.hueShift;
    // Slow rotation of the whole swirl, plus a fast shimmer on the rim.
    const swirl = tSec * 1.8 + wh.seed;
    const shimmer = 0.78 + 0.22 * Math.sin(tSec * 18 + wh.seed);

    ctx.save();
    ctx.translate(wh.x, wh.y);
    // No frame rotation: the tilt is screen-fixed so the hole reads identically
    // regardless of the direction the departing body came from.

    // 1) Throat glow — a soft elliptical wash filling the inner iris so the hole
    //    reads as lit-from-within depth rather than an empty outline. Squash y
    //    to draw the ellipse with a plain radial gradient.
    ctx.save();
    ctx.scale(1, TILT);
    const throat = ctx.createRadialGradient(0, 0, 0, 0, 0, inner);
    throat.addColorStop(0, `hsla(${throatHue}, 90%, 62%, ${0.5 * open})`);
    throat.addColorStop(0.55, `hsla(${rimHue}, 88%, 44%, ${0.3 * open})`);
    throat.addColorStop(1, `hsla(${rimHue}, 85%, 24%, 0)`);
    ctx.fillStyle = throat;
    ctx.beginPath();
    ctx.arc(0, 0, inner, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 2) Depth tunnel — receding twisted rings boring into the screen. Far
    //    rings are dimmer and deeper-red (atmospheric depth); the swirl twist
    //    makes the stack corkscrew so the eye falls in.
    for (let r = 0; r < TUNNEL_RINGS; r++) {
      const depth = r / (TUNNEL_RINGS - 1);
      const fade = (1 - depth * 0.78) * open;
      if (fade < 0.03) continue;
      ringPath(ctx, inner, depth, swirl);
      ctx.lineWidth = 1.1 + (1 - depth) * 1.6;
      const l = 74 - depth * 32; // brighter at the mouth, dim down the throat
      ctx.strokeStyle = `hsla(${throatHue - depth * 18}, 92%, ${l}%, ${0.55 * fade})`;
      ctx.stroke();
    }

    // 3) Event-horizon lip — the bright leading edge of the inner iris. A wide
    //    soft glow stroke with a hot thin core on top, both swept by the shimmer
    //    so the iris edge crackles with energy.
    ringPath(ctx, inner, 0, swirl);
    ctx.lineWidth = 6;
    ctx.strokeStyle = `hsla(${throatHue}, 95%, 70%, ${0.3 * open * shimmer})`;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `hsla(${throatHue + 6}, 100%, 90%, ${0.85 * open * shimmer})`;
    ctx.stroke();

    // 4) Vanishing-point spark — a tiny hot point deep in the throat the body
    //    falls toward (the same point beginWarpOut aims the body at). Brightest
    //    mid-life, gone by collapse.
    const vy = ringCenterY(inner, 1);
    const spark = open * shimmer;
    const sg = ctx.createRadialGradient(0, vy, 0, 0, vy, inner * 0.3);
    sg.addColorStop(0, `hsla(${throatHue}, 100%, 96%, ${0.9 * spark})`);
    sg.addColorStop(1, `hsla(${throatHue}, 100%, 80%, 0)`);
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(0, vy, inner * 0.3, 0, TAU);
    ctx.fill();

    // 5) Outer bezel rim — the raised, rib-carved frame around the iris. Drawn
    //    last so its lip sits proud in front of the throat glow.
    renderRim(ctx, long, inner, rimHue, open, shimmer, swirl);

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
