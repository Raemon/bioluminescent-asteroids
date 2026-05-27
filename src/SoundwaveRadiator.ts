import type { SilhouetteSample } from "./Asteroid";

// Radiating-soundwave visualiser for fragmented (post-split) bassteroids.
// Replaces the slow glow Trail once a bassteroid has been broken into mediums
// or smalls — at which point its drone voice fades in and the piece should
// "sing" outward rather than leave a wake behind it.
//
// Each wave is a closed polygon shaped like a simplified silhouette of the
// chunk it came from (see buildBassSilhouette in Asteroid.ts). The wave is
// anchored to the position where it was emitted — as time passes it expands
// radially around that origin while the bassteroid itself drifts away, so a
// stationary ring of past-emitted waves forms a true "radiating from source"
// figure rather than a wake that follows the body.
//
// Design knobs and why they're set where they are:
//
//   Emission cadence (EMIT_INTERVAL_BY_KIND, seconds):
//     One wave roughly every 0.55–0.85 s, keyed to pitch. Faster kinds emit
//     more often — the visual rate matches the audio impression of "the
//     higher voices feel busier" without coupling to the audio graph.
//
//   Wave lifetime (WAVE_LIFETIME, seconds):
//     2.2 s. Long enough that 3–4 waves coexist on screen at any moment,
//     giving the layered concentric look. Short enough that even at the
//     slowest emission rate there's no gap.
//
//   Expansion curve:
//     1.0 → MAX_RADIUS_MULT × silhouette, ease-out (1 - (1-t)^2). The
//     leading edge is fastest at birth and slows as it disperses — reads
//     as energy radiating into space, like the Pulsar shockwave does.
//
//   Opacity envelope:
//     Triangular: rises 0 → 1 over the first 18 % of the wave's life, then
//     fades 1 → 0 over the remaining 82 %. The rise is short so the wave
//     appears as a crisp leading edge; the long tail leaves a soft ghost
//     well behind the expanding front. Multiplied by the LFO amplitude so
//     "softer" parts of the drone produce fainter waves.
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

const STRIDE = 4; // originX, originY, age, snapshotRotation
const CAPACITY = 8;

// Per-kind tuning. Lower-pitched voices emit slower and grow into bigger
// radii (deep sound = broad waves); higher-pitched voices emit faster with
// tighter radii (high sound = quick, contained pulses).
type BassKind = "bassA" | "bassB" | "bassC" | "bassD";

const EMIT_INTERVAL_BY_KIND: Record<BassKind, number> = {
  bassA: 0.85, // deepest voice — slowest, broadest
  bassB: 0.65,
  bassC: 0.75,
  bassD: 0.55, // highest voice — quickest, tightest
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

const WAVE_LIFETIME = 2.2;
const FADE_IN_FRACTION = 0.18;

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
  // any wave emitted this tick. Existing waves stay anchored to their own
  // recorded origin (not pulled along with the bassteroid).
  update(dt: number, x: number, y: number) {
    // Age existing waves first; the renderer culls anything past lifetime.
    const buf = this.buf;
    for (let i = 0; i < this.count; i++) {
      buf[i * STRIDE + 2] += dt;
    }
    // Emission timer.
    this.timeSinceEmit += dt;
    const interval = EMIT_INTERVAL_BY_KIND[this.kind] + this.emitJitter;
    if (this.timeSinceEmit >= interval) {
      this.timeSinceEmit -= interval;
      this.emitWave(x, y);
    }
  }

  private emitWave(x: number, y: number) {
    const base = this.head * STRIDE;
    this.buf[base] = x;
    this.buf[base + 1] = y;
    this.buf[base + 2] = 0;
    // Small per-wave rotation so successive waves don't stamp on top of
    // each other rigidly — gives a subtle "the resonance shape rotates a
    // little each cycle" feel.
    this.buf[base + 3] = Math.random() * Math.PI * 2;
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
      // Floor of 0.35 on the modulation so even at LFO trough the wave is
      // still visible — a totally dark wave would just disappear and feel
      // like a glitch.
      let env: number;
      if (t < FADE_IN_FRACTION) {
        env = t / FADE_IN_FRACTION;
      } else {
        env = 1 - (t - FADE_IN_FRACTION) / (1 - FADE_IN_FRACTION);
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

      // Outer soft fill — sells the bloom under additive blend.
      ctx.beginPath();
      for (let s = 0; s < silN; s++) {
        const sample = sil[s];
        // Rotate the silhouette unit-vector by `rot`.
        const ux = sample.ax * cosR - sample.ay * sinR;
        const uy = sample.ax * sinR + sample.ay * cosR;
        const px = ox + ux * sample.r * polyR;
        const py = oy + uy * sample.r * polyR;
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = `hsla(${hue}, 100%, ${lightness}%, ${alpha * 0.45})`;
      ctx.fill();

      // Crisp leading-edge stroke — gives the wave a defined "front" so
      // multiple stacked waves read as discrete rings rather than a fog.
      // Thickness tapers as the wave expands (energy spreading thinner).
      const edgeAlpha = Math.min(1, alpha * 1.6);
      ctx.lineWidth = Math.max(0.8, 2.2 * (1 - grow * 0.6));
      ctx.strokeStyle = `hsla(${hue}, 100%, ${Math.min(95, lightness + 12)}%, ${edgeAlpha})`;
      ctx.stroke();
    }
  }
}
