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
// Aesthetic: a BLACK wound lit only by RED. The membrane and throat are
// near-black flesh — the portal reads first as a hole of pure darkness cut into
// space. Every warm note is a highlight riding an edge: a molten event-horizon
// lip, red-hot threads spiralling down the vortex, embers glowing in the
// grasping tendrils, and a single coal deep in the throat the body falls
// toward. The red runs from a hot white-cored crimson on the sharpest edges out
// to a deep oxblood in the folds, so the light reads as fire caught on black
// tissue rather than a flat tint. The whole thing pulses and wobbles as it
// drinks. (Recolour hooks stay live so the wave-skip portals can wear their
// distinct emerald.)
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

// Hue band for the portal's own light — a black wound lit by red. Both anchors
// live in the red band; the body of the portal is near-black and the hue only
// shows where light catches an edge. The rim highlight runs a touch toward
// orange (hotter, fire-caught-on-flesh) and the throat a touch toward oxblood
// (deeper, cooler) so the warm edges and the deep folds read as different
// temperatures of the same coal rather than one flat crimson.
const MEMBRANE_HUE = 8; // rim highlight — hot orange-red
const THROAT_HUE = 352; // throat/vortex — deep oxblood red

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

// Cinders drifting up out of the throat — tiny hot motes that rise from the
// deep vanishing point toward the lip and fade, like sparks lifting off a fire.
// Pure decoration over the black pit; their motion is derived analytically from
// the render clock so nothing new is drawn from the RNG (replay-safe).
const EMBER_COUNT = 9;

// Paint the rising cinders. Each ember owns a fixed lane (angle + a phase offset
// so they don't pulse in unison) and cycles from deep in the throat (depth ~1)
// up to the mouth (depth 0), brightening then guttering out. `inner` is the iris
// long axis; `flux` drives the rise so they crawl with the rest of the maw.
const renderEmbers = (
  ctx: CanvasRenderingContext2D,
  inner: number, membraneHue: number, throatHue: number,
  open: number, phase: number, flux: number,
): void => {
  ctx.save();
  ctx.scale(1, TILT);
  for (let i = 0; i < EMBER_COUNT; i++) {
    // rise 0→1 over the ember's cycle; the fractional part loops it endlessly.
    const rise = (flux * 0.11 + i * 0.137) % 1;
    const depth = 1 - rise; // starts deep (1), climbs to the mouth (0)
    // Lane: a stable angle per ember, drifting slightly as it climbs so the
    // motes spiral up the vortex rather than rising in straight columns.
    const a = phase + i * 2.399 + rise * 1.1;
    const rr = inner * (0.12 + 0.7 * rise); // spiral outward as it climbs
    const cy = ringCenterY(inner, depth);
    const px = Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr;
    // Brightness arcs up then fades — brightest mid-climb, guttering at the top.
    const glow = Math.sin(rise * Math.PI);
    const rad = (0.7 + 1.3 * rise) * (inner / 60 + 0.6);
    const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, `hsla(${membraneHue + 10}, 100%, 82%, ${0.7 * glow * open})`);
    g.addColorStop(0.4, `hsla(${throatHue + 6}, 100%, 52%, ${0.4 * glow * open})`);
    g.addColorStop(1, `hsla(${throatHue}, 100%, 30%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
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
    // Two stacked strokes give the filament body: a near-black oxblood
    // underlayer for the fleshy mass, and a thin hot crimson core that glows
    // like a live ember buried in the tissue. The core flickers hard so the
    // nest looks like it's smouldering, tips fading out into the dark.
    const flick = 0.5 + 0.5 * Math.sin(flux * 2.1 + i * 1.9);
    ctx.lineWidth = 3.4;
    ctx.strokeStyle = `hsla(${throatHue}, 90%, 8%, ${0.5 * open})`; // black-red flesh
    ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `hsla(${membraneHue + 4}, 100%, 58%, ${0.55 * open * flick})`; // ember core
    ctx.stroke();
  }
  ctx.restore();
};

// Paint the outer membrane: a near-black fleshy annulus framing the iris, its
// inner and outer edges chewed by the wobble so it reads as living tissue torn
// open rather than a machined bezel, with only its outer edge catching a thin
// band of oxblood rim-light. `long` is the full long axis, `inner` the iris
// long axis it frames.
const renderMembrane = (
  ctx: CanvasRenderingContext2D,
  long: number, inner: number, membraneHue: number, throatHue: number,
  open: number, phase: number, flux: number,
): void => {
  ctx.save();
  ctx.scale(1, TILT);

  // 1) Membrane band — a filled organic annulus between two wobbled outlines:
  //    the ragged outer flesh edge and the iris edge it wraps. The flesh is
  //    near-black: it stays dark almost the whole way across (occluding the
  //    stars behind it) and only the outer edge catches a thin band of oxblood
  //    rim-light, dying back to nothing at the ragged outer lip. So the ring
  //    reads as black tissue with fire licking its far edge, not a lit annulus.
  const band = ctx.createRadialGradient(0, 0, inner, 0, 0, long);
  band.addColorStop(0, `hsla(${throatHue}, 90%, 3%, ${0.92 * open})`); // black at the iris
  band.addColorStop(0.5, `hsla(${throatHue}, 88%, 5%, ${0.88 * open})`); // still near-black flesh
  band.addColorStop(0.82, `hsla(${throatHue + 4}, 92%, 15%, ${0.7 * open})`); // oxblood rim-light band
  band.addColorStop(0.93, `hsla(${membraneHue}, 96%, 24%, ${0.42 * open})`); // hottest at the outer lip
  band.addColorStop(1, `hsla(${membraneHue}, 80%, 8%, 0)`); // fades out into space
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

    // 0) Outer bloom (additive): a soft red glow radiating well past the flesh
    //    into the surrounding space, so the black hole sits in a pool of its own
    //    dim red light instead of a hard cutout on the starfield. Squashed to the
    //    portal's tilt and breathing with the shimmer. Drawn first so the opaque
    //    membrane lands on top of its inner half and the bloom only shows as a
    //    halo bleeding outward.
    ctx.save();
    ctx.scale(1, TILT);
    const bloomR = long * 1.9;
    const bloom = ctx.createRadialGradient(0, 0, inner * 0.5, 0, 0, bloomR);
    bloom.addColorStop(0, `hsla(${throatHue}, 95%, 18%, ${0.22 * open * shimmer})`);
    bloom.addColorStop(0.5, `hsla(${throatHue - 4}, 95%, 12%, ${0.12 * open})`);
    bloom.addColorStop(1, `hsla(${throatHue - 4}, 95%, 8%, 0)`);
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(0, 0, bloomR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 1) Membrane (source-over): the solid near-black flesh ring. Drawn OPAQUE
    //    so it occludes the starfield — a real torn wound, not a translucent
    //    wash — with only its outer edge catching the oxblood rim-light.
    //    Everything after it is additive light on top.
    ctx.globalCompositeOperation = "source-over";
    renderMembrane(ctx, long, inner, membraneHue, throatHue, open, phase, flux);

    // 2) Throat void (source-over): the actual hole. A radial gradient from a
    //    dead-black centre out through oxblood to the iris — the lightless pit
    //    the body falls into. Opaque black core kills the stars behind it.
    ctx.save();
    ctx.scale(1, TILT);
    const void_ = ctx.createRadialGradient(0, 0, 0, 0, 0, inner);
    void_.addColorStop(0, `hsla(${throatHue}, 95%, 1%, ${0.98 * open})`); // dead-black pit
    void_.addColorStop(0.55, `hsla(${throatHue}, 92%, 3%, ${0.94 * open})`); // holds black deep in
    void_.addColorStop(0.85, `hsla(${throatHue}, 92%, 12%, ${0.72 * open})`); // oxblood only near the lip
    void_.addColorStop(1, `hsla(${membraneHue}, 95%, 20%, ${0.34 * open})`); // hot red meeting the iris
    ctx.fillStyle = void_;
    ctx.beginPath();
    ctx.arc(0, 0, inner, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Everything below is additive light layered over the dark pit.
    ctx.globalCompositeOperation = "lighter";

    // 3) Churning vortex (additive): roiling loops spiralling down to the
    //    vanishing point — red-hot threads of tissue-fire. Near loops churn
    //    wide and burn bright crimson with a hot inner core; far loops shrink,
    //    dim, and cool to a deep oxblood as they recede into the black throat.
    //    They stay in the red band the whole way down — never bruising to
    //    violet — so the drain reads as glowing coals, not cold rock.
    for (let r = 0; r < VORTEX_LOOPS; r++) {
      const depth = r / (VORTEX_LOOPS - 1);
      const fade = (1 - depth * 0.82) * open;
      if (fade < 0.03) continue;
      // Hue stays red, sliding just a few degrees toward oxblood with depth so
      // the far loops read cooler without ever leaving the crimson band.
      const hue = throatHue + 8 - depth * 10;
      // Wide soft under-stroke: the diffuse glow of the hot thread.
      vortexLoop(ctx, inner, depth, swirl, phase, flux);
      ctx.lineWidth = 2.6 + (1 - depth) * 3.4;
      ctx.strokeStyle = `hsla(${hue}, 92%, ${20 - depth * 12}%, ${0.36 * fade})`;
      ctx.stroke();
      // Thin hot core riding the same path: white-hot crimson on the near loops,
      // fading toward the deep throat. This is the "molten wire" catch.
      const coreL = 62 - depth * 40;
      ctx.lineWidth = 0.8 + (1 - depth) * 1.2;
      ctx.strokeStyle = `hsla(${hue + 4}, 100%, ${coreL}%, ${0.6 * fade})`;
      ctx.stroke();
    }

    // 4) Event-horizon lip (additive): the molten leading edge of the wobbled
    //    iris — the marquee red highlight. Three stacked strokes give it real
    //    heat: a wide soft crimson bloom, a mid oxblood body, and a thin
    //    near-white core so the lip reads as genuinely molten metal-of-flesh
    //    rather than a painted red line. All swept by the shimmer so it crackles.
    irisPath(ctx, inner, phase, flux);
    ctx.lineWidth = 9;
    ctx.strokeStyle = `hsla(${membraneHue}, 95%, 26%, ${0.34 * open * shimmer})`; // outer bloom
    ctx.stroke();
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = `hsla(${membraneHue + 2}, 100%, 44%, ${0.55 * open * shimmer})`; // crimson body
    ctx.stroke();
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = `hsla(${membraneHue + 14}, 100%, 82%, ${0.7 * open * shimmer})`; // white-hot core
    ctx.stroke();

    // 5) Vanishing-point pull (additive): a single burning coal deep in the
    //    throat the body falls toward (the point beginWarpOut aims the body at).
    //    A white-hot pinpoint core inside a tight crimson ember — kept small and
    //    dim so the throat stays a black pit with one glowing drain at its floor,
    //    not a lantern. This is the hottest red on screen, marking where matter
    //    disappears.
    const vy = ringCenterY(inner, 1);
    const pull = open * shimmer;
    const pg = ctx.createRadialGradient(0, vy, 0, 0, vy, inner * 0.36);
    pg.addColorStop(0, `hsla(${membraneHue + 12}, 100%, 78%, ${0.5 * pull})`); // white-hot pinpoint
    pg.addColorStop(0.28, `hsla(${throatHue + 6}, 100%, 46%, ${0.5 * pull})`); // crimson ember
    pg.addColorStop(1, `hsla(${throatHue}, 100%, 18%, 0)`);
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(0, vy, inner * 0.36, 0, TAU);
    ctx.fill();

    // 6) Rising cinders (additive): hot motes lifting out of the throat toward
    //    the lip and guttering out — sparks off a fire, drawn over the dark pit
    //    to give the black something to sparkle against.
    renderEmbers(ctx, inner, membraneHue, throatHue, open, phase, flux);

    // 7) Grasping tendrils (additive): the writhing cilia clawing inward from
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
