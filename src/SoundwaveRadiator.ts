import type { SilhouetteSample } from "./Asteroid";

// Radiating-soundwave visualiser for fragmented (post-split) bassteroids.
// Replaces the slow glow Trail once a bassteroid has been broken into mediums
// or smalls — at which point its drone voice fades in and the piece should
// "sing" outward rather than leave a wake behind it.
//
// Design role — this is the *non-rhythmic* counterpart to the bassteroid's
// own visual: the body sprite already throbs on the beat (the rhythmic layer),
// so the nebula must read as continuous ambient hum between beats. Anything
// that feels like a second pulse here would compete with the body's pulse
// and muddy the visual rhythm. Hence the five-band incommensurate breath
// (see BREATH_FREQS / BREATH_RATES) and the deliberate absence of a per-puff
// amplitude envelope — the breath is constant across each puff's life, only
// the puff's overall opacity envelopes in and out.
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

// Per-wave packed record:
//   0: originX        1: originY
//   2: age            3: snapshotRotation
//   4: inheritedVelX  5: inheritedVelY
//   6: speed          7: velAngle (unit-vector angle of inherited velocity)
//   8: birthSeed      (per-wave randomised phase for the breath/wobble terms)
const STRIDE = 9;
const CAPACITY = 16;

// Fraction of the fragment's velocity each wave inherits at emission. < 1 so
// waves drift slightly behind the fragment ("almost keeping up with it") and
// the fragment pulls ahead, leaving a soft cluster of breathing nebulae in
// its wake rather than a stationary ring.
const VELOCITY_INHERIT = 0.82;

// How far back along the fragment's velocity vector each new wave is born,
// in units of the fragment's current radius. Slight offset makes the puffs
// emerge from behind the body like a wake rather than directly on top of it.
const EMIT_BACK_OFFSET = 0.55;

// Anisotropic stretch: the silhouette is elongated along the velocity vector
// (head + tail). STRETCH_AXIAL is the multiplier applied along velocity, and
// STRETCH_LATERAL across it. The asymmetry plus a small head/tail bias gives
// a comet/teardrop hint — the wave "trails" the fragment rather than radiating
// as a perfect circle. Effect scales with speed (see render).
const STRETCH_AXIAL_MAX = 1.55;
const STRETCH_LATERAL_MIN = 0.78;
// Reference speed (px/s) at which the stretch reaches roughly its full
// strength. Below this the wave is nearly round; above it the teardrop
// shape stays bounded.
const STRETCH_REF_SPEED = 140;

// Per-vertex breath — the silhouette radius is modulated by a sum of five
// sinusoids in (angle, time). This is the "ambient noise" layer that has
// to feel distinct from the rhythmic body-pulse the bassteroid already
// carries; the design goals here are explicitly:
//
//   * Continuous, not rhythmic. The bassteroid sprite already throbs on
//     beat — this nebula must be unrelated low-amplitude shimmer, the
//     "between-beats hum" of the drone, not another beat marker.
//   * No global envelope. The breath amplitude is constant over a puff's
//     life (no per-puff swell), so the effect reads as ongoing background
//     texture rather than a one-shot pulse.
//   * Avoid any felt period. Frequencies are irrationally related (φ-scaled)
//     so the sum never closes into a recognisable beat. Spatial frequencies
//     are mid-range (3–13 around the silhouette) and temporal rates sit at
//     3–6 Hz — fast enough to read as shimmer rather than as a slow throb.
//   * Per-wave decorrelation. Phase is offset by birthSeed so neighbouring
//     puffs aren't shimmering in lockstep — the cluster reads as several
//     independent voices, not one coherent oscillator.
//
// Five band-limited sinusoids approximate noise (Karplus-style additive
// synthesis) more convincingly than three; amplitudes drop with frequency
// so the high-frequency shimmer adds detail without dominating the shape.
const BREATH_FREQS = [3, 5, 7, 11, 13];
const BREATH_AMPS = [0.060, 0.048, 0.034, 0.022, 0.016];
// Hz at which each breath term sweeps its phase. Mid-band rates (~3–6 Hz)
// sit above the beat range so the effect doesn't accidentally lock to the
// drone tempo. Ratios are golden-ratio scaled to stay incommensurate.
const BREATH_RATES = [3.1, 3.7, 4.6, 5.3, 6.1];

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
    const speed = Math.hypot(vx, vy);
    const velAngle = speed > 1e-3 ? Math.atan2(vy, vx) : 0;
    // Offset emission backwards along velocity so the new puff is born in
    // the wake rather than on top of the fragment. Falls back to the raw
    // position if the fragment is essentially stationary.
    let ox = x;
    let oy = y;
    if (speed > 1e-3) {
      const ux = vx / speed;
      const uy = vy / speed;
      ox -= ux * EMIT_BACK_OFFSET * 16; // 16 ≈ small per-radius nudge; ship-scale handled in render
      oy -= uy * EMIT_BACK_OFFSET * 16;
    }
    this.buf[base] = ox;
    this.buf[base + 1] = oy;
    this.buf[base + 2] = 0;
    // Small per-wave rotation so successive waves don't stamp on top of
    // each other rigidly — gives a subtle "the resonance shape rotates a
    // little each cycle" feel.
    this.buf[base + 3] = Math.random() * Math.PI * 2;
    this.buf[base + 4] = vx * VELOCITY_INHERIT;
    this.buf[base + 5] = vy * VELOCITY_INHERIT;
    this.buf[base + 6] = speed;
    this.buf[base + 7] = velAngle;
    this.buf[base + 8] = Math.random() * Math.PI * 2;
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
      const alpha = env * ampMod * 0.15;
      if (alpha < 0.01) continue;

      // Volume → lightness. Bright at LFO peak, dimmer at trough. The wave
      // also darkens slightly as it expands (energy dissipating outward).
      const lightness = (55 + lift) + (33 * droneAmp) - (8 * grow);

      const ox = buf[off];
      const oy = buf[off + 1];
      const rot = buf[off + 3];
      const speed = buf[off + 6];
      const velAngle = buf[off + 7];
      const seed = buf[off + 8];
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const polyR = scaleRadius * ringScale;

      // --- Anisotropic stretch (teardrop along velocity vector).
      // The stretch is bounded by speed via a soft saturation curve. At rest
      // the wave is round; moving, it elongates along velocity and tucks
      // laterally — like a smoke puff being dragged by airflow. The shape
      // also widens slightly behind the body and narrows ahead so the puff
      // has a head/tail asymmetry (a real "wake" cue, not a mirrored ellipse).
      const speedT = speed / (speed + STRETCH_REF_SPEED);
      const axial = 1 + (STRETCH_AXIAL_MAX - 1) * speedT;
      const lateral = 1 - (1 - STRETCH_LATERAL_MIN) * speedT;
      const cosV = Math.cos(velAngle);
      const sinV = Math.sin(velAngle);
      // tailBias grows the trailing half of the puff and shrinks the leading
      // half. Scaled by speedT so the asymmetry only shows when moving.
      const tailBias = 0.25 * speedT;

      // Per-wave breath phases. Each term gets an independent phase offset
      // built from the wave's seed × an irrational multiplier — keeps the
      // five terms decorrelated and the cluster from shimmering in unison.
      // No per-puff envelope: breath amplitude is constant over the wave's
      // life so the effect reads as continuous ambient texture, not as a
      // second pulse layered on top of the bassteroid's beat throb.
      const tAbs = tSeconds;
      const TAU2 = Math.PI * 2;
      const bp0 = tAbs * BREATH_RATES[0] * TAU2 + seed * 1.000;
      const bp1 = tAbs * BREATH_RATES[1] * TAU2 + seed * 1.618;
      const bp2 = tAbs * BREATH_RATES[2] * TAU2 + seed * 2.414;
      const bp3 = tAbs * BREATH_RATES[3] * TAU2 + seed * 3.302;
      const bp4 = tAbs * BREATH_RATES[4] * TAU2 + seed * 4.236;

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

          // Per-vertex breath: sum of five band-limited sinusoids in
          // vertex-angle. Approximates the look of an FFT bin visualizer
          // riding the silhouette while avoiding any felt periodicity.
          const va = Math.atan2(uy, ux);
          const breath =
            BREATH_AMPS[0] * Math.sin(BREATH_FREQS[0] * va + bp0) +
            BREATH_AMPS[1] * Math.sin(BREATH_FREQS[1] * va + bp1) +
            BREATH_AMPS[2] * Math.sin(BREATH_FREQS[2] * va + bp2) +
            BREATH_AMPS[3] * Math.sin(BREATH_FREQS[3] * va + bp3) +
            BREATH_AMPS[4] * Math.sin(BREATH_FREQS[4] * va + bp4);
          const r = sample.r * (1 + breath) * ringR;

          // Convert the vertex into the velocity-aligned frame, apply
          // axial/lateral stretch and the trailing tail bias, then rotate
          // back to world coordinates.
          let lx = ux * r;
          let ly = uy * r;
          if (speedT > 0.001) {
            // Project (lx, ly) onto velocity axes.
            const along = lx * cosV + ly * sinV;
            const across = -lx * sinV + ly * cosV;
            // Stretch.
            let alongS = along * axial;
            const acrossS = across * lateral;
            // Tail bias: behind the centre (along < 0) is stretched more,
            // ahead (along > 0) compressed. Same sign convention as velocity.
            if (along < 0) alongS *= 1 + tailBias;
            else alongS *= 1 - tailBias * 0.6;
            // Rotate back: (alongS, acrossS) in velocity frame → world.
            lx = alongS * cosV - acrossS * sinV;
            ly = alongS * sinV + acrossS * cosV;
          }

          const px = ox + lx;
          const py = oy + ly;
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
