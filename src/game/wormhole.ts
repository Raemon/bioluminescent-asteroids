import type { Vec } from "../vec";
// Seeds only — cosmetic stream so the portal's swirl/jitter never perturbs the
// gameplay RNG draw count and desyncs replays.
import { cosmeticRng as rng } from "./rng";

// A departure portal: comets that time out and aliens that fly past the far
// edge leave THROUGH this instead of fading/popping off. Distinct from the
// canister upgrade's flat radial-streak vortex (Canister.renderWarp) — that one
// is a head-on swirl of spokes collapsing to a point. This is a torn wound in
// space — a writhing organic maw that reaches out with grasping tendrils and
// churns a dark vortex down to a lightless throat, so a body reads as being
// SUCKED IN and swallowed. Its slight tilt is fixed to the SCREEN, not to the
// body's line of flight, so it reads the same from every approach.
//
// Aesthetic: not the aliens' clean crimson bioluminescence but something
// hungrier — a dark red / purple / black wound. The throat is near-black void
// bleeding out through blood-red to a bruised violet membrane; a nest of
// writhing tendrils claws inward from the rim like a sea-anemone mouth or a
// tear in living tissue, and the whole thing pulses and wobbles as it drinks.
// (Recolour hooks stay live so the wave-skip portals can wear their distinct
// emerald.)
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

// The inner iris (the actual hole) sits inside the outer membrane, which frames
// it. This is the inner iris's fraction of the full long axis; the gap out to 1
// is the membrane's width, and the tendrils reach out past 1.
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
// toward this point; renderWormholes paints the throat void at the same spot.
export const warpAnchorOffset = (
  bodyRadius: number, _heading: number,
): { dx: number; dy: number } => {
  const d = portalLongAxis(bodyRadius) * INNER_FRAC * 0.55 * TILT; // = -ringCenterY at depth 1
  return { dx: 0, dy: -d };
};

// Depth vortex: churning loops spiralling toward a vanishing point, each pushed
// "back" so the eye falls into a receding throat rather than a flat disc.
const VORTEX_LOOPS = 7;

// Hue band for the portal's own light — a dark red/purple/black wound. The
// membrane runs bruised violet, the mid ring blood-red, and the throat plunges
// to near-black void. Three anchors so the depth ramp can drift hue across the
// whole band instead of a single flat tint.
const MEMBRANE_HUE = 296; // outer bruised violet
const THROAT_HUE = 350; // inner blood-red bleeding to black

export type Wormhole = {
  x: number;
  y: number;
  // Long axis of the ellipse (px) at full open — scaled from the body's radius
  // so a big alien tears a bigger hole than a comet.
  radius: number;
  // Vestigial as a frame rotation (the portal's tilt is screen-fixed), but used
  // as a per-portal phase so the tendrils and swirl of simultaneous portals
  // don't line up. spawnWormhole seeds it from the heading so replays stay
  // deterministic.
  angle: number;
  hueShift: number; // small per-portal hue jitter so they don't all match
  seed: number;
  life: number;
  maxLife: number;
  // Hue overrides for recoloured portals (the wave-skip kind). The defaults
  // reproduce the dark-wound departure portal; wave-skip wears emerald.
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

// Centre of the vortex loop at a given depth, in the portal's (unrotated,
// screen-fixed) frame. Loops march from the inner-iris mouth (depth 0, centred
// on origin) straight up-screen toward the vanishing point, so the vortex bores
// back-and-"up" into the screen the same way from every approach. `inner` is the
// inner iris's long axis (= long * INNER_FRAC).
const ringCenterY = (inner: number, depth: number): number => -inner * 0.55 * TILT * depth;

// A cheap deterministic value-noise: a sum of a few sines the caller can sample
// smoothly by angle so an outline wobbles organically instead of running a clean
// circle. `phase` decorrelates portals; `t` drifts it so the wobble crawls and
// writhes over time rather than sitting still.
const wobble = (a: number, phase: number, t: number): number =>
  Math.sin(a * 3 + phase + t) * 0.55
  + Math.sin(a * 5 - phase * 1.7 - t * 0.8) * 0.3
  + Math.sin(a * 8 + phase * 0.5 + t * 1.6) * 0.15;

// Trace one churning vortex loop at the given depth (0 = inner mouth, 1 =
// vanishing point) into the current path. Deeper loops shrink (perspective
// falloff), slide up toward the vanishing point, twist, AND get their radius
// chewed by the organic wobble — so the stack reads as a roiling corkscrew
// throat, not tidy nested circles. `flux` drives the time-varying wobble.
const vortexLoop = (
  ctx: CanvasRenderingContext2D,
  inner: number, depth: number, swirl: number, phase: number, flux: number,
): void => {
  // Receding scale: a perspective-ish 1/(1+kd) falloff packs the far loops
  // tight near the vanishing point.
  const scale = 1 / (1 + depth * 2.4);
  const rx = inner * scale;
  const ry = inner * TILT * scale;
  const cy = ringCenterY(inner, depth);
  const twist = swirl * depth;
  // Wobble gets meatier toward the mouth (near loops churn hard) and calms into
  // the tight far throat so the vanishing point stays a clean dark point.
  const chew = (0.28 + 0.16 * (1 - depth));
  ctx.beginPath();
  const SAMP = 48;
  for (let i = 0; i <= SAMP; i++) {
    const a = (i / SAMP) * TAU + twist;
    const w = 1 + wobble(a, phase + depth * 2, flux) * chew;
    const px = Math.cos(a) * rx * w;
    const py = cy + Math.sin(a) * ry * w;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
};

// Number of tendrils clawing inward from the membrane — the writhing cilia that
// make the maw read as a living mouth pulling matter in rather than a machined
// aperture.
const TENDRIL_COUNT = 13;

// Paint the nest of grasping tendrils: tapering filaments anchored just outside
// the iris that curl INWARD toward the throat, undulating as they go, so the
// hole looks like it's reaching out to drag a body down. `long` is the full
// long axis, `inner` the iris edge they spring from.
const renderTendrils = (
  ctx: CanvasRenderingContext2D,
  long: number, inner: number, membraneHue: number, throatHue: number,
  open: number, swirl: number, phase: number, flux: number,
): void => {
  ctx.save();
  ctx.scale(1, TILT); // draw in the squashed frame so tendrils hug the ellipse
  ctx.lineCap = "round";
  for (let i = 0; i < TENDRIL_COUNT; i++) {
    // Each tendril owns a base angle and its own drift so they writhe out of
    // phase — a slow crawl plus a per-tendril wiggle keeps the nest restless.
    const base = (i / TENDRIL_COUNT) * TAU + swirl * 0.4;
    const wig = Math.sin(flux * 1.3 + i * 2.399) * 0.5;
    // Reach: how far past the membrane the tip claws, breathing with the flux
    // and jittered per tendril so the silhouette is ragged, never a clean ring.
    const reachLen = long * (0.5 + 0.35 * (0.5 + 0.5 * Math.sin(flux + i * 1.7)));
    const rootR = inner * 1.02;
    const tipR = inner + reachLen;
    // Sample the tendril as a curved spine: it springs outward from the iris,
    // bows sideways (the curl), and the tip hooks back toward the throat.
    const SEG = 9;
    ctx.beginPath();
    for (let s = 0; s <= SEG; s++) {
      const u = s / SEG; // 0 root … 1 tip
      const r = rootR + (tipR - rootR) * u;
      // Curl: angular sweep grows along the length and hooks harder at the tip,
      // so the filament curves like a finger closing inward.
      const curl = (wig + 0.9 * u * u) * (1 - u * 0.25);
      const a = base + curl + wobble(u * 6, phase + i, flux) * 0.12 * u;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    // Two stacked strokes give the filament body: a dark thick underlayer for
    // the fleshy mass, a thin hot core so it glows like a lit vein. Both taper
    // via the flicker so tips fade out into the dark.
    const flick = 0.5 + 0.5 * Math.sin(flux * 2.1 + i * 1.9);
    ctx.lineWidth = 3.4;
    ctx.strokeStyle = `hsla(${throatHue - 8}, 85%, 20%, ${0.42 * open})`;
    ctx.stroke();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = `hsla(${membraneHue + 10}, 95%, 60%, ${0.5 * open * flick})`;
    ctx.stroke();
  }
  ctx.restore();
};

// Paint the outer membrane: a soft bruised-violet fleshy annulus framing the
// iris, its inner and outer edges chewed by the wobble so it reads as living
// tissue torn open rather than a machined bezel. `long` is the full long axis,
// `inner` the iris long axis it frames.
const renderMembrane = (
  ctx: CanvasRenderingContext2D,
  long: number, inner: number, membraneHue: number, throatHue: number,
  open: number, phase: number, flux: number,
): void => {
  ctx.save();
  ctx.scale(1, TILT);

  // 1) Membrane band — a filled organic annulus between two wobbled outlines:
  //    the ragged outer flesh edge and the iris edge it wraps. A radial gradient
  //    across it goes bruised-violet at the rim, darkening to near-black where it
  //    meets the void so the flesh reads as thickening into shadow.
  const band = ctx.createRadialGradient(0, 0, inner, 0, 0, long);
  band.addColorStop(0, `hsla(${throatHue - 6}, 80%, 10%, 0)`);
  band.addColorStop(0.4, `hsla(${throatHue}, 80%, 16%, ${0.5 * open})`);
  band.addColorStop(0.75, `hsla(${membraneHue}, 70%, 26%, ${0.6 * open})`);
  band.addColorStop(1, `hsla(${membraneHue + 12}, 60%, 14%, 0)`);
  ctx.fillStyle = band;
  ctx.beginPath();
  const SAMP = 64;
  // Outer flesh edge — wobbled, ragged.
  for (let i = 0; i <= SAMP; i++) {
    const a = (i / SAMP) * TAU;
    const r = long * (1 + wobble(a, phase, flux) * 0.12);
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  // Iris edge as an inner sub-path (reverse wind) so evenodd punches the hole.
  for (let i = 0; i <= SAMP; i++) {
    const a = (i / SAMP) * TAU;
    const r = inner * (1 + wobble(a, phase + 3, flux) * 0.06);
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.fill("evenodd");
  ctx.restore();
};

// Trace the wobbled iris edge (the leading lip of the actual hole) into the
// current path — used for the hot event-horizon stroke. Drawn in the squashed
// frame by the caller.
const irisPath = (
  ctx: CanvasRenderingContext2D, inner: number, phase: number, flux: number,
): void => {
  ctx.beginPath();
  const SAMP = 64;
  for (let i = 0; i <= SAMP; i++) {
    const a = (i / SAMP) * TAU;
    const r = inner * (1 + wobble(a, phase + 3, flux) * 0.06);
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r * TILT;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
};

export const renderWormholes = (
  ctx: CanvasRenderingContext2D, list: Wormhole[], tSec: number,
): void => {
  if (list.length === 0) return;
  ctx.save();
  ctx.lineJoin = "round";
  for (const wh of list) {
    const elapsed = wh.maxLife - wh.life;
    const open = mouthOpen(elapsed, wh.life);
    if (open < 0.02) continue;
    const long = wh.radius * open;
    const inner = long * INNER_FRAC;
    const membraneHue = (wh.rimHue ?? MEMBRANE_HUE) + wh.hueShift;
    const throatHue = (wh.throatHue ?? THROAT_HUE) + wh.hueShift;
    // Slow rotation of the whole swirl, a per-portal phase, and a churning flux
    // that drives every organic wobble so the maw writhes and pulses.
    const swirl = tSec * 1.4 + wh.seed;
    const phase = wh.angle * 1.7 + wh.seed;
    const flux = tSec * 2.3 + wh.seed;
    const shimmer = 0.78 + 0.22 * Math.sin(tSec * 16 + wh.seed);

    ctx.save();
    ctx.translate(wh.x, wh.y);
    // No frame rotation: the tilt is screen-fixed so the hole reads identically
    // regardless of the direction the departing body came from.

    // --- BACK-TO-FRONT, mostly additive so the light stacks and blooms ---

    // 1) Membrane (source-over): the solid bruised-violet flesh ring. Drawn
    //    first and OPAQUE so it occludes the starfield — a real torn wound, not
    //    a translucent wash. Everything after it is additive light on top.
    ctx.globalCompositeOperation = "source-over";
    renderMembrane(ctx, long, inner, membraneHue, throatHue, open, phase, flux);

    // 2) Throat void (source-over): the actual hole. A radial gradient from a
    //    dead-black centre out through blood-red to the iris — the lightless
    //    pit the body falls into. Opaque black core kills the stars behind it.
    ctx.save();
    ctx.scale(1, TILT);
    const void_ = ctx.createRadialGradient(0, 0, 0, 0, 0, inner);
    void_.addColorStop(0, `hsla(${throatHue}, 90%, 2%, ${0.96 * open})`);
    void_.addColorStop(0.45, `hsla(${throatHue}, 90%, 6%, ${0.9 * open})`);
    void_.addColorStop(0.8, `hsla(${throatHue}, 88%, 22%, ${0.7 * open})`);
    void_.addColorStop(1, `hsla(${membraneHue}, 80%, 24%, ${0.3 * open})`);
    ctx.fillStyle = void_;
    ctx.beginPath();
    ctx.arc(0, 0, inner, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Everything below is additive light layered over the dark pit.
    ctx.globalCompositeOperation = "lighter";

    // 3) Churning vortex (additive): roiling loops spiralling down to the
    //    vanishing point. Near loops churn wide and glow blood-red; far loops
    //    shrink, dim, and bleed toward violet-black as they recede into depth.
    for (let r = 0; r < VORTEX_LOOPS; r++) {
      const depth = r / (VORTEX_LOOPS - 1);
      const fade = (1 - depth * 0.82) * open;
      if (fade < 0.03) continue;
      vortexLoop(ctx, inner, depth, swirl, phase, flux);
      ctx.lineWidth = 1.0 + (1 - depth) * 1.8;
      const hue = throatHue - depth * 40; // red mouth → violet-black throat
      const l = 42 - depth * 26; // dark and bruised, never bright/clean
      ctx.strokeStyle = `hsla(${hue}, 95%, ${l}%, ${0.5 * fade})`;
      ctx.stroke();
    }

    // 4) Event-horizon lip (additive): the hot leading edge of the wobbled iris
    //    — a wide soft glow with a thin hotter core, both swept by the shimmer
    //    so the wound's lip crackles with a bruised-magenta energy.
    irisPath(ctx, inner, phase, flux);
    ctx.lineWidth = 5;
    ctx.strokeStyle = `hsla(${membraneHue + 4}, 90%, 34%, ${0.4 * open * shimmer})`;
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `hsla(${membraneHue + 16}, 100%, 66%, ${0.7 * open * shimmer})`;
    ctx.stroke();

    // 5) Vanishing-point pull (additive): a faint dark-red ember deep in the
    //    throat the body falls toward (the point beginWarpOut aims the body at).
    //    Kept dim so the throat stays a pit, not a lantern — just enough of a
    //    glow to mark the drain the vortex spirals into.
    const vy = ringCenterY(inner, 1);
    const pull = open * shimmer;
    const pg = ctx.createRadialGradient(0, vy, 0, 0, vy, inner * 0.34);
    pg.addColorStop(0, `hsla(${throatHue}, 100%, 40%, ${0.55 * pull})`);
    pg.addColorStop(1, `hsla(${throatHue}, 100%, 20%, 0)`);
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(0, vy, inner * 0.34, 0, TAU);
    ctx.fill();

    // 6) Grasping tendrils (additive): the writhing cilia clawing inward from
    //    the membrane. Drawn LAST so they curl proud in front of the throat,
    //    reaching over the lip to drag a body down.
    renderTendrils(ctx, long, inner, membraneHue, throatHue, open, swirl, phase, flux);

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
