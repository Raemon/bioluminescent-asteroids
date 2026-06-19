import type { Game } from "../Game";

// Master-bus spectrum visualizer — a short bar EQ pinned across the bottom of
// the screen, fed by the real audio graph (Sound.readSpectrum() taps an
// AnalyserNode sitting at the master output, so it sees the full mix: sfx,
// halo music, vocals, base pulse). This is the always-on "the music is
// playing" element, the AAA rhythm-game floor-glow.
//
// Mirrored layout: the unique frequency bands are drawn twice, with bass at
// both the far-left and far-right edges and treble meeting in the center —
// a symmetric EQ rather than a left-to-right sweep.
//
// Performance contract (the whole reason this file is shaped the way it is):
//   - readSpectrum() returns a reused Uint8Array; we never copy it.
//   - All per-bar state (heights, peak holds) lives in fixed Float32Arrays
//     allocated once at module load. The frame path allocates nothing.
//   - One additive glow sprite is baked once and stamped per bar with
//     drawImage — no ctx.shadowBlur (it's a per-frame GPU killer here and a
//     house no-go). Bloom is "lighter" + the soft sprite.
//   - The whole pass is two fill batches (solid bars, then glow stamps),
//     not N save/restore pairs.
//
// Bin → bar mapping:
//   The FFT gives FREQ_BINS linear-frequency bins (bin 0 ≈ DC, last ≈ 22kHz).
//   Linear bins crammed into linear bars would leave the left third (all the
//   musically interesting bass/mid) in ~4 bars and waste the right two-thirds
//   on hiss nobody can hear. We map bars onto a perceptual (roughly log)
//   slice of the spectrum and average the bins that fall in each bar's band,
//   so bass and mids each get real estate. See buildBarBands().
//
// Smoothing:
//   The AnalyserNode already applies smoothingTimeConstant (temporal IIR on
//   the raw FFT). On top of that each bar does asymmetric envelope follow —
//   snap up fast (ATTACK), fall slow (RELEASE) — and a separate slow-falling
//   peak cap. That attack-fast/release-slow shape is what reads as "音楽"
//   reacting rather than flickering noise; it's the standard rhythm-game look.

// The spectrum is mirrored about screen center: BANDS unique frequency bands
// are computed once, then drawn twice — bass at both the far-left and
// far-right edges, treble meeting in the middle. BAR_COUNT is the visible
// total (2 × BANDS).
const BANDS = 64;
const BAR_COUNT = BANDS * 2;
// Don't waste bands on the top octave of the FFT — most of the audible energy
// and all the musical content sits below this fraction of Nyquist.
const SPECTRUM_HI_FRACTION = 0.62;

const ATTACK = 0.55;
const RELEASE = 0.09;
const PEAK_FALL = 0.32;

// Absolute cap on bar height in CSS px (canvas is rendered at LOGICAL_H=1080,
// so this is in the same logical-pixel space the rest of render() uses).
const BAR_HEIGHT_MAX_PX = 50;
const BASE_HUE = 192;
const HUE_SPREAD = 86;

// Per-band envelope state (one entry per unique frequency band; both mirror
// halves read from these).
const bandHeights = new Float32Array(BANDS);
const bandPeaks = new Float32Array(BANDS);

// For each band: the inclusive FFT bin range [lo, hi) it averages. Built lazily
// once we know frequencyBinCount (it depends on the analyser's fftSize).
let bandBinLo: Int32Array | null = null;
let bandBinHi: Int32Array | null = null;
let bandBinCount = 0;

const buildBarBands = (binCount: number) => {
  if (bandBinLo && bandBinCount === binCount) return;
  bandBinLo = new Int32Array(BANDS);
  bandBinHi = new Int32Array(BANDS);
  bandBinCount = binCount;
  const usable = Math.max(2, Math.floor(binCount * SPECTRUM_HI_FRACTION));
  // Log-spaced edges from bin 1 to `usable`, so each band covers a roughly
  // constant musical interval rather than a constant Hz width.
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

// Bar index → frequency band. Mirrored about center: both outer edges are
// band 0 (bass), the two center bars are the top band (treble).
const bandForBar = (i: number) => (i < BANDS ? i : BAR_COUNT - 1 - i);

// Soft radial glow sprite, baked once. Stamped (scaled) under "lighter" to
// bloom each bar tip without shadowBlur.
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

export const renderSpectrumVisualizer = (game: Game) => {
  const bins = game.sound.readSpectrum();
  const { ctx, w, h } = game;
  buildBarBands(bins ? bins.length : 256);

  const lo = bandBinLo!;
  const hi = bandBinHi!;
  const maxH = BAR_HEIGHT_MAX_PX;
  // Tiny gap between bars; bars span the full width.
  const slot = w / BAR_COUNT;
  const barW = slot * 0.74;
  const baseY = h;

  // Envelope-follow every frequency band from the current FFT (or decay toward
  // 0 when there's no running context yet — keeps the bars settling smoothly
  // instead of snapping off on pause). One pass over the unique bands; the
  // mirrored draw below reads each band twice.
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
    // Peak cap rides up instantly with the band, then sinks at PEAK_FALL/frame.
    bandPeaks[i] = next >= bandPeaks[i] ? next : Math.max(next, bandPeaks[i] - PEAK_FALL * (1 / 60));
  }

  ctx.save();

  // Pass 1 — solid bars (one fill per bar; cheap rects, no glow yet).
  for (let i = 0; i < BAR_COUNT; i++) {
    const band = bandForBar(i);
    const v = bandHeights[band];
    if (v < 0.002) continue;
    const bh = v * maxH;
    const x = i * slot + (slot - barW) / 2;
    const hue = BASE_HUE + (band / BANDS) * HUE_SPREAD;
    const grad = ctx.createLinearGradient(0, baseY - bh, 0, baseY);
    grad.addColorStop(0, `hsla(${hue}, 95%, 72%, ${0.5 * Math.min(1, v * 2)})`);
    grad.addColorStop(1, `hsla(${hue - 18}, 90%, 46%, 0.05)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, baseY - bh, barW, bh);
  }

  // Pass 2 — additive glow stamps at each bar tip + the peak cap line.
  const sprite = buildGlowSprite();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < BAR_COUNT; i++) {
    const band = bandForBar(i);
    const v = bandHeights[band];
    if (v < 0.02) continue;
    const bh = v * maxH;
    const cx = i * slot + slot / 2;
    const tipY = baseY - bh;
    const glowR = barW * (1.4 + v * 1.6);
    const hue = BASE_HUE + (band / BANDS) * HUE_SPREAD;
    ctx.globalAlpha = 0.07 + v * 0.22;
    // White bloom on top of the already-colored bar reads as the tip glowing,
    // and stays a single cached sprite (per-bar hue tinting isn't worth a
    // recolor pass under "lighter").
    ctx.drawImage(sprite, cx - glowR, tipY - glowR, glowR * 2, glowR * 2);

    // Peak cap — a thin bright line that hangs above the bar and falls slowly.
    const pk = bandPeaks[band];
    if (pk > 0.05) {
      const pkY = baseY - pk * maxH;
      ctx.globalAlpha = 0.28 * Math.min(1, pk * 2);
      ctx.fillStyle = `hsla(${hue}, 100%, 85%, 1)`;
      ctx.fillRect(cx - barW / 2, pkY, barW, 2);
    }
  }

  ctx.restore();
};
