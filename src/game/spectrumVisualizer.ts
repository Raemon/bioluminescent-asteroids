import type { Game } from "../Game";

// Master-bus spectrum visualizer, fed by the real audio graph
// (Sound.readSpectrum() taps an AnalyserNode at the master output, so it sees
// the full mix: sfx, halo music, vocals, base pulse). Always-on "the music is
// playing" glow — a ring of spokes wrapped around the pulsar, pulsing outward.
//
// Performance contract (the whole reason this file is shaped the way it is):
//   - readSpectrum() returns a reused array; we never copy it.
//   - All per-band state lives in fixed Float32Arrays allocated once at module
//     load. The frame path allocates nothing.
//   - One additive glow sprite is baked once and stamped with drawImage — no
//     ctx.shadowBlur (a per-frame GPU killer here and a house no-go). Bloom is
//     "lighter" + the soft sprite.
//
// Bin → band mapping (buildBarBands): the FFT gives linear-frequency bins; we
// map BANDS onto a perceptual (roughly log) slice so bass and mids each get
// real estate instead of being crushed into the leftmost few bins.
//
// Smoothing: AnalyserNode applies smoothingTimeConstant (temporal IIR on the
// raw FFT); on top each band does asymmetric envelope follow — snap up fast
// (ATTACK), fall slow (RELEASE) — plus a slow-falling peak cap. That
// attack-fast/release-slow shape reads as music reacting, not noise flickering.

const BANDS = 64;
const BAR_COUNT = BANDS * 2;
// Don't waste bands on the top octave of the FFT — most of the audible energy
// and all the musical content sits below this fraction of Nyquist.
const SPECTRUM_HI_FRACTION = 0.62;

const ATTACK = 0.55;
const RELEASE = 0.09;
const PEAK_FALL = 0.32;

const BASE_HUE = 192;
const HUE_SPREAD = 86;
// Master opacity — scales every layer so the whole visualizer dims uniformly
// without re-tuning each per-layer alpha.
const MASTER_OPACITY = 0.2;

// Per-band envelope state (one entry per unique frequency band).
const bandHeights = new Float32Array(BANDS);
const bandPeaks = new Float32Array(BANDS);

// For each band: the FFT bin range [lo, hi) it averages. Built lazily once we
// know frequencyBinCount (it depends on the analyser's fftSize).
let bandBinLo: Int32Array | null = null;
let bandBinHi: Int32Array | null = null;
let bandBinCount = 0;

const buildBarBands = (binCount: number) => {
  if (bandBinLo && bandBinCount === binCount) return;
  bandBinLo = new Int32Array(BANDS);
  bandBinHi = new Int32Array(BANDS);
  bandBinCount = binCount;
  const usable = Math.max(2, Math.floor(binCount * SPECTRUM_HI_FRACTION));
  const logLo = Math.log(1);
  const logHi = Math.log(usable);
  let prev = 1;
  for (let i = 0; i < BANDS; i++) {
    const t = (i + 1) / BANDS;
    const edge = Math.round(Math.exp(logLo + (logHi - logLo) * t));
    const lo = prev;
    const hi = Math.max(lo + 1, edge);
    bandBinLo[i] = lo;
    bandBinHi[i] = hi;
    prev = hi;
  }
};

const hueForBand = (band: number) => BASE_HUE + (band / BANDS) * HUE_SPREAD;

// Soft radial glow sprite, baked once. Stamped (scaled) under "lighter" to
// bloom without shadowBlur.
let glowSprite: HTMLCanvasElement | null = null;
const GLOW_SIZE = 64;
const buildGlowSprite = (): HTMLCanvasElement => {
  if (glowSprite) return glowSprite;
  const c = document.createElement("canvas");
  c.width = GLOW_SIZE;
  c.height = GLOW_SIZE;
  const g = c.getContext("2d")!;
  const r = GLOW_SIZE / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
  glowSprite = c;
  return c;
};

// Run the shared per-frame analysis: envelope-follow every band from the
// current FFT (or decay toward 0 when there's no running context, so the ring
// settles smoothly on pause instead of snapping off).
const updateBands = (bins: Uint8Array | null) => {
  const lo = bandBinLo!;
  const hi = bandBinHi!;
  for (let i = 0; i < BANDS; i++) {
    let target = 0;
    if (bins) {
      let sum = 0;
      const a = lo[i];
      const b = Math.min(hi[i], bins.length);
      for (let k = a; k < b; k++) sum += bins[k];
      const avg = sum / Math.max(1, b - a) / 255;
      // Gentle gamma so quiet content still shows without the loud stuff
      // pinning the whole band to the ceiling.
      target = Math.pow(avg, 0.72);
    }
    const cur = bandHeights[i];
    const rate = target > cur ? ATTACK : RELEASE;
    const next = cur + (target - cur) * rate;
    bandHeights[i] = next;
    bandPeaks[i] = next >= bandPeaks[i] ? next : Math.max(next, bandPeaks[i] - PEAK_FALL * (1 / 60));
  }
};

// A dense, smooth ring of spokes wrapped around the pulsar, growing outward.
// All BAR_COUNT spokes sweep the full circle (so it reads as one continuous
// ring, not sparse fans), but the frequency→angle layout is folded to be
// mirror-symmetric about the pulsar's magnetic-axis line: bass lands on BOTH
// ends of the beam axis — the directions the lighthouse flashes streak toward —
// and treble meets in the perpendicular gaps. Quartering the circle (bass→treble
// →bass→treble) yields the 4-fold mirror the flashes already suggest.
// Max spoke reach as a multiple of the pulsar radius, so the whole ring scales
// in lockstep with the pulsar (18.75 = 75px at the wave-1 radius of 4px).
const RADIAL_BAR_MAX_MULT = 18.75;
// Extra dimming on top of MASTER_OPACITY, just for the pulsar ring.
const RADIAL_OPACITY = 0.25;
// Inner radius as a multiple of the pulsar radius. 1 = spokes start at the
// pulsar's edge and radiate straight out with no gap.
const RADIAL_INNER_R_MULT = 1;
// Spoke i → frequency band, folded into quarters and mirrored so band 0 (bass)
// sits on the axis at all four quadrant seams and the top band at the diagonals.
const radialBandForSpoke = (i: number) => {
  const q = (i / BAR_COUNT) * 4; // 0..4 around the circle
  const inQuarter = q % 1; // 0..1 within the current quarter
  const tri = (Math.floor(q) & 1) === 0 ? inQuarter : 1 - inQuarter; // zig-zag
  return Math.min(BANDS - 1, Math.floor(tri * BANDS));
};
const drawRadial = (game: Game) => {
  const { ctx } = game;
  const { x: cx, y: cy, r, beamAngle } = game.pulsar.visualizerAnchor();
  // Spokes start at the pulsar's surface and radiate straight out.
  const inner = r * RADIAL_INNER_R_MULT;
  const barMax = r * RADIAL_BAR_MAX_MULT;
  const sprite = buildGlowSprite();

  // Spoke i's absolute screen angle, measured from the beam axis so the ring's
  // bass seams line up with the flash directions.
  const angFor = (i: number) => beamAngle + (i / BAR_COUNT) * Math.PI * 2;

  // Pass 1 — radial spokes.
  ctx.lineCap = "round";
  for (let i = 0; i < BAR_COUNT; i++) {
    const band = radialBandForSpoke(i);
    const v = bandHeights[band];
    if (v < 0.002) continue;
    const ang = angFor(i);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const len = v * barMax;
    const hue = hueForBand(band);
    ctx.strokeStyle = `hsla(${hue}, 95%, 68%, ${0.7 * Math.min(1, v * 2) * MASTER_OPACITY * RADIAL_OPACITY})`;
    ctx.lineWidth = 3 + v * 4;
    ctx.beginPath();
    ctx.moveTo(cx + ca * inner, cy + sa * inner);
    ctx.lineTo(cx + ca * (inner + len), cy + sa * (inner + len));
    ctx.stroke();
  }

  // Pass 2 — glow stamps at the spoke tips.
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < BAR_COUNT; i++) {
    const band = radialBandForSpoke(i);
    const v = bandHeights[band];
    if (v < 0.02) continue;
    const ang = angFor(i);
    const len = v * barMax;
    const tx = cx + Math.cos(ang) * (inner + len);
    const ty = cy + Math.sin(ang) * (inner + len);
    const glowR = (10 + v * 26) * (r / 4);
    ctx.globalAlpha = (0.07 + v * 0.2) * MASTER_OPACITY * RADIAL_OPACITY;
    ctx.drawImage(sprite, tx - glowR, ty - glowR, glowR * 2, glowR * 2);
  }
};

// Advance the spectrum bands from the live audio. Mutates module state, so it
// must run exactly ONCE per frame — call it before any paint, never per wrap copy.
export const updateSpectrumVisualizer = (game: Game) => {
  const bins = game.sound.readSpectrum();
  buildBarBands(bins ? bins.length : 256);
  updateBands(bins);
};

// Paint the pulsar ring at the current transform (reads no live audio — pure
// draw from the bands updateSpectrumVisualizer set). The scroll camera calls
// this inside the wrapped world layer so the ring follows the wrapped pulsar.
export const paintSpectrumVisualizer = (game: Game) => {
  game.ctx.save();
  drawRadial(game);
  game.ctx.restore();
};
