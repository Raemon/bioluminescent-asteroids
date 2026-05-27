import type { SilhouetteSample } from "./Asteroid";

// Radiating-soundwave visualiser for fragmented (post-split) bassteroids.
// Replaces the slow glow Trail once a bassteroid has been broken into mediums
// or smalls — at which point its drone voice fades in and the piece should
// "sing" outward rather than leave a wake behind it.
//
// Each wave is a closed polygon shaped like a simplified silhouette of the
// chunk it came from (see buildBassSilhouette in Asteroid.ts). At emission
// the wave inherits a fraction (VELOCITY_INHERIT) of the fragment's
// velocity, so it drifts along behind the fragment instead of being left
// fully behind — the cluster reads as a nebula that's almost (but not
// quite) keeping up with the broken ship-piece.
//
// Design knobs and why they're set where they are:
//
//   Emission cadence (EMIT_INTERVAL_BY_KIND, seconds):
//     One wave roughly every 0.27–0.42 s, keyed to pitch. Faster kinds emit
//     more often — the visual rate matches the audio impression of "the
//     higher voices feel busier" without coupling to the audio graph. The
//     cadence is paired with a short WAVE_LIFETIME so the field reads as a
//     dense cluster of brief soft puffs.
//
//   Wave lifetime (WAVE_LIFETIME, seconds):
//     1.1 s with a squared fade-out tail — short enough that each puff
//     feels transient, long enough that several always coexist so the
//     cluster never empties out.
//
//   Expansion curve:
//     1.0 → MAX_RADIUS_MULT × silhouette, ease-out (1 - (1-t)^2). The
//     leading edge is fastest at birth and slows as it disperses — reads
//     as energy radiating into space, like the Pulsar shockwave does.
//
//   Opacity envelope:
//     Asymmetric: rises 0 → 1 over the first 14 % of life, then fades on a
//     squared falloff (k²) so the tail drops away fast. Multiplied by the
//     LFO amplitude so "softer" parts of the drone produce fainter waves.
//
//   Edge softness:
//     No single crisp stroke. Each wave is rendered as a stack of 4
//     concentric silhouette fills scaled around the body, with quickly
//     decaying alphas (FEATHER_ALPHAS). Under additive blend this produces
//     a feathered halo — there's still a perceptible edge, but it's blurry
//     by construction, like a nebula rim.
//
//   Colour (pitch → hue, volume → lightness):
//     Hue comes from the asteroid's KIND_HUE (already pitch-coded:
//     A=0 red, B=28 orange, C=215 blue, D=290 purple). Lightness rides the
//     drone LFO between 55 % (trough) and 88 % (peak). Small / gen-2 voices
//     are an octave higher — we lift their lightness floor by 8 pp so the
//     "higher pitch = brighter" reading holds at the per-wave level too.
//
//   Composite:
//     Caller sets globalCompositeOperation = "lighter" once around the
//     whole trail/radiator pass (see trailsRender.ts). Render() does NOT
//     toggle composite mode — multiple radiators stacking under additive
//     blend produces the bloom we want.
//
// Performance:
//   Fixed-capacity Float32Array, ring-buffer write pattern, no per-wave
//   allocation after construction. Path is built with beginPath/moveTo/
//   lineTo on a pre-cached SilhouetteSample list (cos/sin already baked).

const STRIDE = 6; // originX, originY, age, snapshotRotation, inheritedVelX, inheritedVelY
const CAPACITY = 16;

// Fraction of the fragment's velocity each wave inherits at emission. < 1 so
// waves drift slightly behind the fragment ("almost keeping up with it") and
// the fragment pulls ahead, leaving a soft cluster of breathing nebulae in
// its wake rather than a stationary ring.
const VELOCITY_INHERIT = 0.82;

// Per-kind tuning. Lower-pitched voices emit slower and grow into bigger
// radii (deep sound = broad waves); higher-pitched voices emit faster with
// tighter radii (high sound = quick, contained pulses).
type BassKind = "bassA" | "bassB" | "bassC" | "bassD";

// Tighter cadence so the cluster reads as a continuous breathing fog rather
// than discrete pulses. Roughly halved from the previous setting, paired
// with a shorter lifetime below to keep the on-screen density similar.
const EMIT_INTERVAL_BY_KIND: Record<BassKind, number> = {
  bassA: 0.42, // deepest voice — slowest, broadest
  bassB: 0.32,
  bassC: 0.37,
  bassD: 0.27, // highest voice — quickest, tightest
};

const MAX_RADIUS_MULT_BY_KIND: Record<BassKind, number> = {
  bassA: 3.6,
  bassB: 3.1,
  bassC: 3.3,
  bassD: 2.7,
};

// LFO rates (Hz) for the per-kind drone amplitude swell. Copied from the
// Sound.ts pulseRate table so the visualiser breathes in sync with the
// drone amplitude curve without needing an AnalyserNode read.
const LFO_RATE_BY_KIND: Record<BassKind, number> = {
  bassA: 0.09,
  bassB: 0.13,
  bassC: 0.07,
  bassD: 0.17,
};

// Shorter lifetime than before — paired with the faster emit cadence above,
// the field reads as a denser cluster of brief soft puffs rather than long
// concentric rings.
const WAVE_LIFETIME = 1.1;
const FADE_IN_FRACTION = 0.14;

// Feathered-edge stack: each wave is rendered as N concentric silhouette
// fills with these radius multipliers and alpha multipliers. Outermost
// (faintest, biggest) listed first; under additive blend this stack reads
// as a soft halo with no hard line — the "blurry nebula edge" look.
// Module-scope so we don't reallocate per wave per frame.
const FEATHER_SCALES = [1.32, 1.18, 1.06, 0.94];
const FEATHER_ALPHAS = [0.18, 0.28, 0.42, 0.5];

export class SoundwaveRadiator {
  private readonly buf: Float32Array;
  private head = 0;
  private count = 0;
  private timeSinceEmit = 0;

  // Cached per-instance — read on every emit and every render frame.
  private readonly silhouette: SilhouetteSample[];
  private readonly hue: number;
  private readonly kind: BassKind;
  // Octave-aware lightness floor lift: small/gen-2 voices sit one octave
  // up, so we want their waves a touch brighter overall to read as the
  // higher register.
  private readonly lightnessLift: number;
  // Per-instance LFO phase offset so two pieces of the same kind don't
  // breathe in lockstep — the field reads as several voices rather than
  // one big synchronised pulse.
  private readonly lfoPhase: number;
  // Per-instance jitter on emission timing so a cluster of fragments
  // doesn't ring out on the exact same frame.
  private readonly emitJitter: number;

  constructor(kind: BassKind, hue: number, silhouette: SilhouetteSample[], isHighOctave: boolean) {
    this.kind = kind;
    this.hue = hue;
    this.silhouette = silhouette;
    this.lightnessLift = isHighOctave ? 8 : 0;
    this.lfoPhase = Math.random() * Math.PI * 2;
    this.emitJitter = (Math.random() - 0.5) * 0.15;
    this.buf = new Float32Array(CAPACITY * STRIDE);
    // Pre-fill: emit one wave immediately so the visualiser doesn't have a
    // dead beat right after the bassteroid splits.
    this.timeSinceEmit = EMIT_INTERVAL_BY_KIND[kind] + this.emitJitter;
  }

  // Advance time, emit new waves at the kind's cadence, and age live waves.
  // `(x, y)` is the bassteroid's current position — used as the origin of
  // any wave emitted this tick. Existing waves drift along their inherited
  // velocity (a fraction of the fragment's velocity at emission time) so the
  // nebula cluster trails the fragment instead of being left fully behind.
  update(dt: number, x: number, y: number, vx: number, vy: number) {
    const buf = this.buf;
    for (let i = 0; i < this.count; i++) {
      const off = i * STRIDE;
      buf[off + 2] += dt;
      buf[off] += buf[off + 4] * dt;
      buf[off + 1] += buf[off + 5] * dt;
    }
    // Emission timer.
    this.timeSinceEmit += dt;
    const interval = EMIT_INTERVAL_BY_KIND[this.kind] + this.emitJitter;
    if (this.timeSinceEmit >= interval) {
      this.timeSinceEmit -= interval;
      this.emitWave(x, y, vx, vy);
    }
  }

  private emitWave(x: number, y: number, vx: number, vy: number) {
    const base = this.head * STRIDE;
    this.buf[base] = x;
    this.buf[base + 1] = y;
    this.buf[base + 2] = 0;
    // Small per-wave rotation so successive waves don't stamp on top of
    // each other rigidly — gives a subtle "the resonance shape rotates a
    // little each cycle" feel.
    this.buf[base + 3] = Math.random() * Math.PI * 2;
    this.buf[base + 4] = vx * VELOCITY_INHERIT;
    this.buf[base + 5] = vy * VELOCITY_INHERIT;
    this.head = (this.head + 1) % CAPACITY;
    if (this.count < CAPACITY) this.count += 1;
  }

  // Render every live wave as a fading expanding silhouette. Caller must
  // have set globalCompositeOperation = "lighter" already.
  //
  //   tSeconds — wall-clock time used to evaluate the drone LFO.
  //   scaleRadius — the bassteroid's current radius in pixels; silhouette
  //     samples are normalised to 1 and we multiply by this on draw.
  render(ctx: CanvasRenderingContext2D, tSeconds: number, scaleRadius: number) {
    if (this.count === 0) return;
    const buf = this.buf;
    const sil = this.silhouette;
    const silN = sil.length;
    const hue = this.hue;
    const maxR = MAX_RADIUS_MULT_BY_KIND[this.kind];
    const lift = this.lightnessLift;

    // Drone amplitude proxy — closed-form sine matching the WebAudio LFO
    // rate. Range [0, 1]; 0 = drone trough, 1 = drone peak.
    const omega = tSeconds * Math.PI * 2 * LFO_RATE_BY_KIND[this.kind] + this.lfoPhase;
    const droneAmp = 0.5 + 0.5 * Math.sin(omega);

    for (let i = 0; i < this.count; i++) {
      const off = i * STRIDE;
      const age = buf[off + 2];
      if (age >= WAVE_LIFETIME) continue;
      const t = age / WAVE_LIFETIME;

      // Ease-out radial growth — leading edge slows as the wave disperses.
      const grow = 1 - (1 - t) * (1 - t);
      const ringScale = 1 + (maxR - 1) * grow;

      // Triangular opacity envelope, then modulated by the drone amplitude.
      // Faster fade-out (squared falloff after the peak) — paired with the
      // higher emit cadence, the cluster reads as quick soft puffs rather
      // than persistent rings. Floor of 0.35 on the LFO so the wave never
      // disappears entirely.
      let env: number;
      if (t < FADE_IN_FRACTION) {
        env = t / FADE_IN_FRACTION;
      } else {
        const k = 1 - (t - FADE_IN_FRACTION) / (1 - FADE_IN_FRACTION);
        env = k * k;
      }
      const ampMod = 0.35 + 0.65 * droneAmp;
      const alpha = env * ampMod * 0.55;
      if (alpha < 0.01) continue;

      // Volume → lightness. Bright at LFO peak, dimmer at trough. The wave
      // also darkens slightly as it expands (energy dissipating outward).
      const lightness = (55 + lift) + (33 * droneAmp) - (8 * grow);

      const ox = buf[off];
      const oy = buf[off + 1];
      const rot = buf[off + 3];
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const polyR = scaleRadius * ringScale;

      // Blurry feathered edge: stack the concentric silhouette fills (see
      // FEATHER_SCALES / FEATHER_ALPHAS at module scope). Outermost (faintest,
      // biggest) first so brighter inner shells paint over it.
      for (let k = 0; k < FEATHER_SCALES.length; k++) {
        const ringR = polyR * FEATHER_SCALES[k];
        const ringAlpha = alpha * FEATHER_ALPHAS[k];
        if (ringAlpha < 0.005) continue;
        ctx.beginPath();
        for (let s = 0; s < silN; s++) {
          const sample = sil[s];
          // Rotate the silhouette unit-vector by `rot`.
          const ux = sample.ax * cosR - sample.ay * sinR;
          const uy = sample.ax * sinR + sample.ay * cosR;
          const px = ox + ux * sample.r * ringR;
          const py = oy + uy * sample.r * ringR;
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        // Outer shells slightly cooler/darker, inner brighter — keeps a
        // perceptible (but soft) edge while staying blurry overall.
        const ringLight = Math.min(95, lightness + (k - 1) * 4);
        ctx.fillStyle = `hsla(${hue}, 100%, ${ringLight}%, ${ringAlpha})`;
        ctx.fill();
      }
    }
  }
}
