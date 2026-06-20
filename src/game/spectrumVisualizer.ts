import type { Game } from "../Game";

// Master-bus spectrum visualizer, fed by the real audio graph
// (Sound.readSpectrum() taps an AnalyserNode at the master output, so it sees
// the full mix: sfx, halo music, vocals, base pulse). Always-on "the music is
// playing" floor-glow.
//
// Multiple visual MODES share one analysis pass and switch live with the number
// keys 1-5 (wired in Game.ts). The per-frame band envelope-follow below runs
// once regardless of mode; each mode is a pure draw over bandHeights/bandPeaks
// (or, for the scope, the raw waveform). See VisualizerMode / drawMode().
//
//   1  bars       mirrored bar EQ pinned to the bottom (the original)
//   2  radial     the same bands as a ring pulsing outward from center
//   3  waterfall  a scrolling spectrogram (history of spectra drifting up)
//   4  particles  onset-driven sparks thrown from band spikes
//   5  scope      time-domain oscilloscope across the center line
//
// Performance contract (the whole reason this file is shaped the way it is):
//   - readSpectrum()/readWaveform() return reused arrays; we never copy them.
//   - All per-band state lives in fixed Float32Arrays allocated once at module
//     load. The frame path allocates nothing (the particle pool is preallocated
//     too).
//   - One additive glow sprite is baked once and stamped with drawImage — no
//     ctx.shadowBlur (a per-frame GPU killer here and a house no-go). Bloom is
//     "lighter" + the soft sprite.
//   - The waterfall scrolls a single offscreen canvas (drawImage self-blit),
//     not a per-pixel ImageData rewrite.
//
// Bin → band mapping (buildBarBands): the FFT gives linear-frequency bins; we
// map BANDS onto a perceptual (roughly log) slice so bass and mids each get
// real estate instead of being crushed into the leftmost few bins.
//
// Smoothing: AnalyserNode applies smoothingTimeConstant (temporal IIR on the
// raw FFT); on top each band does asymmetric envelope follow — snap up fast
// (ATTACK), fall slow (RELEASE) — plus a slow-falling peak cap. That
// attack-fast/release-slow shape reads as music reacting, not noise flickering.

export type VisualizerMode = "bars" | "radial" | "waterfall" | "particles" | "scope";

// Index order matches the number keys 1..5.
export const VISUALIZER_MODES: VisualizerMode[] = ["bars", "radial", "waterfall", "particles", "scope"];

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
// Master opacity — scales every layer so the whole visualizer dims uniformly
// without re-tuning each per-layer alpha.
const MASTER_OPACITY = 0.2;

// Per-band envelope state (one entry per unique frequency band; both mirror
// halves read from these).
const bandHeights = new Float32Array(BANDS);
const bandPeaks = new Float32Array(BANDS);
// Previous-frame band height, so onset detection (mode 4) can see the jump.
const bandPrev = new Float32Array(BANDS);

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

// Bar index → frequency band. Mirrored about center: the two center bars are
// band 0 (bass), both outer edges are the top band (treble).
const bandForBar = (i: number) => (i < BANDS ? BANDS - 1 - i : i - BANDS);

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
// current FFT (or decay toward 0 when there's no running context, so bars
// settle smoothly on pause instead of snapping off). One pass over the unique
// bands; mirrored modes read each band twice.
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
    bandPrev[i] = cur;
    const rate = target > cur ? ATTACK : RELEASE;
    const next = cur + (target - cur) * rate;
    bandHeights[i] = next;
    bandPeaks[i] = next >= bandPeaks[i] ? next : Math.max(next, bandPeaks[i] - PEAK_FALL * (1 / 60));
  }
};

// ── Mode 1: bars ───────────────────────────────────────────────────────────
const drawBars = (game: Game) => {
  const { ctx, w, h } = game;
  const maxH = BAR_HEIGHT_MAX_PX;
  const slot = w / BAR_COUNT;
  const barW = slot * 0.74;
  const baseY = h;

  // Pass 1 — solid bars (one fill per bar; cheap rects, no glow yet).
  for (let i = 0; i < BAR_COUNT; i++) {
    const band = bandForBar(i);
    const v = bandHeights[band];
    if (v < 0.002) continue;
    const bh = v * maxH;
    const x = i * slot + (slot - barW) / 2;
    const hue = hueForBand(band);
    const grad = ctx.createLinearGradient(0, baseY - bh, 0, baseY);
    grad.addColorStop(0, `hsla(${hue}, 95%, 72%, ${0.5 * Math.min(1, v * 2) * MASTER_OPACITY})`);
    grad.addColorStop(1, `hsla(${hue - 18}, 90%, 46%, ${0.05 * MASTER_OPACITY})`);
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
    const hue = hueForBand(band);
    ctx.globalAlpha = (0.07 + v * 0.22) * MASTER_OPACITY;
    ctx.drawImage(sprite, cx - glowR, tipY - glowR, glowR * 2, glowR * 2);

    const pk = bandPeaks[band];
    if (pk > 0.05) {
      const pkY = baseY - pk * maxH;
      ctx.globalAlpha = 0.28 * Math.min(1, pk * 2) * MASTER_OPACITY;
      ctx.fillStyle = `hsla(${hue}, 100%, 85%, 1)`;
      ctx.fillRect(cx - barW / 2, pkY, barW, 2);
    }
  }
};

// ── Mode 2: radial ─────────────────────────────────────────────────────────
// A dense, smooth ring of spokes wrapped around the pulsar, growing outward.
// All BAR_COUNT spokes sweep the full circle (so it reads as one continuous
// ring, not sparse fans), but the frequency→angle layout is folded to be
// mirror-symmetric about the pulsar's magnetic-axis line: bass lands on BOTH
// ends of the beam axis — the directions the lighthouse flashes streak toward —
// and treble meets in the perpendicular gaps. Quartering the circle (bass→treble
// →bass→treble) yields the 4-fold mirror the flashes already suggest.
const RADIAL_BAR_MAX = 75;
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
    const len = v * RADIAL_BAR_MAX;
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
    const len = v * RADIAL_BAR_MAX;
    const tx = cx + Math.cos(ang) * (inner + len);
    const ty = cy + Math.sin(ang) * (inner + len);
    const glowR = 10 + v * 26;
    ctx.globalAlpha = (0.07 + v * 0.2) * MASTER_OPACITY * RADIAL_OPACITY;
    ctx.drawImage(sprite, tx - glowR, ty - glowR, glowR * 2, glowR * 2);
  }
};

// ── Mode 3: waterfall ──────────────────────────────────────────────────────
// A scrolling spectrogram: each frame we paint one fresh row at the bottom of
// an offscreen strip, scroll the whole strip up by one row (a self-blit), then
// blit the strip to screen. Old spectra drift upward into an aurora.
let wfCanvas: HTMLCanvasElement | null = null;
let wfCtx: CanvasRenderingContext2D | null = null;
const WF_H = 220; // strip height in rows; also its on-screen height in px
const buildWaterfall = (w: number): HTMLCanvasElement => {
  if (wfCanvas && wfCanvas.width === w) return wfCanvas;
  const c = wfCanvas ?? document.createElement("canvas");
  c.width = w;
  c.height = WF_H;
  wfCanvas = c;
  wfCtx = c.getContext("2d")!;
  return c;
};
const drawWaterfall = (game: Game) => {
  const { ctx, w, h } = game;
  const c = buildWaterfall(Math.max(2, Math.floor(w)));
  const g = wfCtx!;
  // Scroll existing content up by 1px (self-blit), then clear the new bottom row.
  g.globalCompositeOperation = "copy";
  g.drawImage(c, 0, -1);
  g.globalCompositeOperation = "source-over";
  g.clearRect(0, WF_H - 1, c.width, 1);

  // Paint the new bottom row: one rect per mirrored band across the width.
  const slot = c.width / BAR_COUNT;
  for (let i = 0; i < BAR_COUNT; i++) {
    const band = bandForBar(i);
    const v = bandHeights[band];
    if (v < 0.01) continue;
    const hue = hueForBand(band);
    const light = 38 + v * 42;
    g.fillStyle = `hsla(${hue}, 95%, ${light}%, ${Math.min(1, v * 2.2)})`;
    g.fillRect(i * slot, WF_H - 1, slot + 1, 1);
  }

  // Blit the strip to the bottom of the screen, additively so it sits over the
  // game without a hard black box.
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = MASTER_OPACITY * 3.2; // strip is already dim; lift it back
  ctx.drawImage(c, 0, h - WF_H, w, WF_H);
};

// ── Mode 4: particles ──────────────────────────────────────────────────────
// Onset-driven sparks: when a band jumps hard between frames, spawn a few
// particles rising from the floor at that band's x. Bass throws heavy slow
// sparks low and wide; treble throws fast bright ones. Fixed preallocated pool.
const P_MAX = 240;
const pX = new Float32Array(P_MAX);
const pY = new Float32Array(P_MAX);
const pVx = new Float32Array(P_MAX);
const pVy = new Float32Array(P_MAX);
const pLife = new Float32Array(P_MAX); // 1 → 0
const pHue = new Float32Array(P_MAX);
const pSize = new Float32Array(P_MAX);
let pNext = 0;
const ONSET_THRESHOLD = 0.12;
const spawnParticle = (x: number, y: number, vx: number, vy: number, hue: number, size: number) => {
  const i = pNext;
  pNext = (pNext + 1) % P_MAX;
  pX[i] = x;
  pY[i] = y;
  pVx[i] = vx;
  pVy[i] = vy;
  pLife[i] = 1;
  pHue[i] = hue;
  pSize[i] = size;
};
const drawParticles = (game: Game) => {
  const { ctx, w, h } = game;
  const slot = w / BAR_COUNT;
  // Spawn from onsets. A band's "is it bass" is band/BANDS (0 = bass).
  for (let i = 0; i < BAR_COUNT; i++) {
    const band = bandForBar(i);
    const jump = bandHeights[band] - bandPrev[band];
    if (jump < ONSET_THRESHOLD) continue;
    const x = i * slot + slot / 2;
    const bassness = 1 - band / BANDS;
    const hue = hueForBand(band);
    const count = jump > 0.28 ? 3 : 1;
    for (let n = 0; n < count; n++) {
      // Treble: fast, narrow, small. Bass: slow, wide, big.
      const spread = 0.6 + bassness * 2.4;
      const speed = (2.2 + (1 - bassness) * 4.5) * (0.7 + Math.abs(Math.sin(i * 12.9898 + n * 7.233)));
      const vx = (((i * 3 + n * 7) % 11) / 11 - 0.5) * spread;
      spawnParticle(x, h - 4, vx, -speed, hue, 1.5 + bassness * 3);
    }
  }

  // Integrate + draw under "lighter". Gravity pulls everything back down.
  const sprite = buildGlowSprite();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < P_MAX; i++) {
    const life = pLife[i];
    if (life <= 0) continue;
    pVy[i] += 0.06; // gravity
    pX[i] += pVx[i];
    pY[i] += pVy[i];
    const nl = life - 0.012;
    pLife[i] = nl <= 0 ? 0 : nl;
    if (pY[i] > h) {
      pLife[i] = 0;
      continue;
    }
    const r = pSize[i] * (2 + nl * 3);
    ctx.globalAlpha = nl * 0.5 * MASTER_OPACITY * 3.5;
    // Tint via a hue-rotated stamp would need a recolor pass; under "lighter"
    // a colored fill rect tip + white glow reads fine and stays cheap.
    ctx.drawImage(sprite, pX[i] - r, pY[i] - r, r * 2, r * 2);
  }
};

// ── Mode 5: scope ──────────────────────────────────────────────────────────
// Time-domain oscilloscope tucked into the top HUD strip, centred horizontally
// between the wave/score block on the left and the settings gear on the right.
// The raw master waveform draws as a glowing polyline whose colour, opacity and
// saturation are modulated per-sample by the band the spectrum says is loudest
// near that sample — so different notes paint the trace in different shades
// rather than a flat monochrome line.
//
// Geometry is in logical canvas px (1920×1080). The centreline sits high in the
// HUD bar; SCOPE_AMP is sized so a peak-volume waveform just dips past the combo
// chip ("X4 RHYTHM") and no further.
const SCOPE_CY = 30; // centreline y in the HUD strip
const SCOPE_AMP = 44; // peak excursion; SCOPE_CY + SCOPE_AMP lands just past combo
const SCOPE_X0_FRAC = 0.3; // left edge: clear of the score/wave block
const SCOPE_X1_FRAC = 0.7; // right edge: clear of the settings gear
// Map a horizontal position (0..1 across the scope) to the band whose energy
// colours the trace there: low x → bass, high x → treble, mirrored about the
// centre so the trace is symmetric like the bar EQ.
const scopeBandAt = (t: number) => {
  const m = t < 0.5 ? t * 2 : (1 - t) * 2; // 0 at edges, 1 at centre
  return Math.min(BANDS - 1, Math.floor((1 - m) * BANDS));
};
const drawScope = (game: Game) => {
  const { ctx, w } = game;
  const wave = game.sound.readWaveform();
  if (!wave || wave.length < 2) return;
  const x0 = w * SCOPE_X0_FRAC;
  const span = w * (SCOPE_X1_FRAC - SCOPE_X0_FRAC);
  const n = wave.length;
  // 1024 samples over ~770px is sub-pixel; stride to a few hundred segments so
  // the per-segment colouring stays cheap.
  const STRIDE = 4;
  const sampleY = (i: number) => SCOPE_CY + ((wave[i] - 128) / 128) * SCOPE_AMP;

  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  // Per-segment colouring: stroke each short run as its own path so opacity and
  // saturation can vary with the locally-dominant band. A handful of bloom
  // passes (wide+dim → thin+bright) gives the glow without shadowBlur.
  for (let pass = 0; pass < 3; pass++) {
    ctx.lineWidth = [6, 3, 1.5][pass];
    const aMul = [0.12, 0.22, 0.6][pass];
    let px = x0;
    let py = sampleY(0);
    for (let i = STRIDE; i < n; i += STRIDE) {
      const t = i / (n - 1);
      const band = scopeBandAt(t);
      const energy = bandHeights[band];
      const hue = hueForBand(band);
      // Louder bands → more opaque and more saturated; quiet content stays a
      // dim desaturated whisper so only the active notes light up.
      const sat = 45 + energy * 55;
      const alpha = (0.18 + energy * 0.82) * aMul * MASTER_OPACITY * 3;
      const x = x0 + t * span;
      const y = sampleY(i);
      ctx.strokeStyle = `hsla(${hue}, ${sat}%, 70%, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();
      px = x;
      py = y;
    }
  }
};

const drawMode = (game: Game, mode: VisualizerMode) => {
  switch (mode) {
    case "bars":
      return drawBars(game);
    case "radial":
      return drawRadial(game);
    case "waterfall":
      return drawWaterfall(game);
    case "particles":
      return drawParticles(game);
    case "scope":
      return drawScope(game);
  }
};

export const renderSpectrumVisualizer = (game: Game) => {
  const bins = game.sound.readSpectrum();
  buildBarBands(bins ? bins.length : 256);
  updateBands(bins);

  game.ctx.save();
  drawMode(game, game.visualizerMode ?? "bars");
  game.ctx.restore();
};
