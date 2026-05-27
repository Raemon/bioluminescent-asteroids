/**
 * SoundVisualizer
 * ---------------
 * One-take, static "album cover" for a short game sound.
 *
 * Design goals:
 *   - Engine-agnostic. Caller hands us an AudioContext and a play() callback.
 *   - Captures a full take into a buffer, then renders ONE composite artwork.
 *     (A live oscilloscope is useless on 80ms sounds; the static keepsake is
 *     what tells you what the sound IS.)
 *   - Packs amplitude envelope + spectral colour + peak/centroid/duration
 *     into a single legible canvas, matched to the game's neon-vector vibe.
 *
 * Capture strategy:
 *   We create an internal AnalyserNode (`tap`) and an internal
 *   MediaStreamAudioDestinationNode (`streamTap`). To capture, the caller
 *   either:
 *     (a) connects their per-sound output graph to `vis.tap` in parallel to
 *         ctx.destination, OR
 *     (b) uses the convenience `captureViaDestinationHijack()` which
 *         temporarily wraps `ctx.destination` by routing through a tap node
 *         the caller can splice into their master bus.
 *
 *   The simple, robust path used here: caller wires a parallel send into
 *   `visualizer.tap` BEFORE calling capture(). `capture()` then triggers
 *   play() and polls the AnalyserNode every animation frame into a Float32
 *   sample buffer for the requested duration. After the take ends we run a
 *   one-shot FFT (via a second OfflineAudioContext re-analysis) for the
 *   spectral picture.
 *
 *   For ad-hoc testing without wiring, `makeFakeBlip()` produces a short FM
 *   sound that routes itself through `vis.tap` automatically.
 */

export interface SoundVisualizerOpts {
  width?: number;
  height?: number;
  /** Optional palette override. Default picks from spectral centroid. */
  accent?: string;
}

export interface SoundStats {
  peakDb: number;
  rmsDb: number;
  durationMs: number;
  centroidHz: number;
  brightnessHz: number; // 85th-percentile spectral edge
  attackMs: number;
  decayMs: number;
  zcr: number; // zero-crossing rate (noisiness proxy)
}

type RGB = [number, number, number];

const FFT_SIZE = 2048;

export class SoundVisualizer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly opts: Required<Pick<SoundVisualizerOpts, "width" | "height">> & {
    accent?: string;
  };

  /** The node the caller must connect their sound's output into (in parallel
   *  to ctx.destination) before invoking capture(). */
  tap: AnalyserNode | null = null;
  /** Optional pre-tap gain so the caller has a stable target node even before
   *  an AudioContext exists. Lazily created. */
  private tapInput: GainNode | null = null;

  /** Time-domain samples captured at audioCtx.sampleRate. */
  private samples: Float32Array | null = null;
  private sampleRate = 48000;

  /** Pre-computed visual buffers. */
  private envelope: Float32Array | null = null; // length = visual columns
  private centroidPerCol: Float32Array | null = null;
  private spectroCols: Float32Array[] | null = null; // per-col FFT magnitudes (sqrt-scaled)
  private stats: SoundStats | null = null;

  constructor(canvas: HTMLCanvasElement, opts: SoundVisualizerOpts = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("SoundVisualizer: 2D canvas context unavailable");
    this.ctx2d = ctx;
    this.opts = {
      width: opts.width ?? 480,
      height: opts.height ?? 120,
      accent: opts.accent,
    };
    this.applyDpr();
  }

  /** Attaches a fresh AnalyserNode to the given AudioContext. The caller
   *  should `node.connect(vis.getTap(ctx))` on every voice they want
   *  captured. Calling this multiple times is safe — same node returned. */
  getTap(ctx: AudioContext): AudioNode {
    if (!this.tap || this.tap.context !== ctx) {
      this.tapInput = ctx.createGain();
      this.tapInput.gain.value = 1.0;
      this.tap = ctx.createAnalyser();
      this.tap.fftSize = FFT_SIZE;
      this.tap.smoothingTimeConstant = 0; // we want raw frames
      this.tapInput.connect(this.tap);
      // Analyser is a sink; nothing else needed.
    }
    return this.tapInput!;
  }

  /**
   * Trigger `play()` and record `durationSec` of output from the tap.
   * The caller is responsible for having already routed their sound's
   * graph through `getTap(ctx)`.
   */
  async capture(
    ctx: AudioContext,
    play: () => void,
    durationSec: number
  ): Promise<void> {
    const tapInput = this.getTap(ctx) as GainNode;
    const analyser = this.tap!;
    this.sampleRate = ctx.sampleRate;

    const totalSamples = Math.ceil(durationSec * ctx.sampleRate);
    const out = new Float32Array(totalSamples);
    let written = 0;

    // We pull time-domain frames from the analyser as fast as rAF allows.
    // The analyser internally holds the most recent fftSize samples. Between
    // frames we may miss-or-overlap audio; to reduce that, we run a parallel
    // ScriptProcessor-style capture via an OfflineAudioContext is heavy and
    // engine-bound. Instead we use the most reliable browser-supported path:
    // AudioWorklet would be ideal but we keep it dependency-free. The frame
    // overlap risk is small for sounds <1s when rAF runs at 60Hz (fftSize at
    // 48kHz = ~43ms window; rAF interval ~16ms — heavy overlap, so we just
    // copy the newest tail each frame.)
    const frame = new Float32Array(analyser.fftSize);
    const startTime = ctx.currentTime;

    // Resume context if suspended (e.g. before any user gesture).
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* ignore */ }
    }

    // Reset tap input gain in case left clamped.
    tapInput.gain.value = 1.0;

    // Trigger the sound.
    try { play(); } catch (e) {
      // Even if play() throws, we still record silence for the duration so
      // the visualizer renders an empty take rather than hangs.
      // eslint-disable-next-line no-console
      console.warn("SoundVisualizer.capture: play() threw", e);
    }

    // Poll loop.
    await new Promise<void>((resolve) => {
      const tick = () => {
        analyser.getFloatTimeDomainData(frame);
        // Estimate samples since start; copy only the freshest slice we
        // haven't written yet to avoid duplicating overlap.
        const nowSamples = Math.floor((ctx.currentTime - startTime) * ctx.sampleRate);
        const target = Math.min(nowSamples, totalSamples);
        const need = target - written;
        if (need > 0) {
          const slice = frame.subarray(Math.max(0, frame.length - need), frame.length);
          out.set(slice.subarray(0, Math.min(slice.length, totalSamples - written)), written);
          written += Math.min(slice.length, totalSamples - written);
        }
        if (written >= totalSamples) { resolve(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    this.samples = out;
    this.analyze();
  }

  /**
   * Ingest an already-rendered AudioBuffer (e.g. the result of
   * OfflineAudioContext.startRendering()) and feed it through the same
   * analyze() pipeline as the live capture path. The rendered artwork is
   * therefore identical to a live capture; this is just the "no live ctx
   * needed" entry point used by the editor's startup pre-render.
   */
  ingestBuffer(buf: AudioBuffer): void {
    const out = new Float32Array(buf.length);
    buf.copyFromChannel(out, 0);
    this.samples = out;
    this.sampleRate = buf.sampleRate;
    this.analyze();
  }

  /** Pre-compute envelope, per-column FFTs, centroids, and stats. */
  private analyze(): void {
    if (!this.samples) return;
    const samples = this.samples;
    const sr = this.sampleRate;
    const cols = this.opts.width; // 1 column per pixel of design width
    const env = new Float32Array(cols);
    const centroids = new Float32Array(cols);
    const brightness = new Float32Array(cols);
    const spectroCols: Float32Array[] = new Array(cols);

    const win = Math.max(64, Math.floor(samples.length / cols));
    const fft = new SimpleFFT(nearestPow2(Math.min(1024, win)));
    const winLen = fft.size;
    const hann = makeHann(winLen);
    const work = new Float32Array(winLen);

    let peak = 0;
    let sumSq = 0;
    let zc = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
      sumSq += samples[i] * samples[i];
      if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) zc++;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, samples.length));

    for (let c = 0; c < cols; c++) {
      const start = Math.floor((c * samples.length) / cols);
      const end = Math.floor(((c + 1) * samples.length) / cols);
      let p = 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(samples[i]);
        if (v > p) p = v;
      }
      env[c] = p;

      // Windowed FFT around the column center.
      const center = Math.floor((start + end) / 2);
      const half = winLen >> 1;
      for (let i = 0; i < winLen; i++) {
        const idx = center - half + i;
        work[i] = idx >= 0 && idx < samples.length ? samples[idx] * hann[i] : 0;
      }
      const mag = fft.magnitude(work); // length winLen/2
      spectroCols[c] = mag;

      // Spectral centroid + 85th percentile brightness edge.
      let num = 0, den = 0;
      for (let k = 1; k < mag.length; k++) {
        const m = mag[k];
        const f = (k * sr) / winLen;
        num += f * m;
        den += m;
      }
      centroids[c] = den > 1e-9 ? num / den : 0;

      // Cumulative-energy brightness edge (85%).
      let totalE = 0;
      for (let k = 0; k < mag.length; k++) totalE += mag[k];
      const target = totalE * 0.85;
      let acc = 0;
      let edge = 0;
      for (let k = 0; k < mag.length; k++) {
        acc += mag[k];
        if (acc >= target) { edge = (k * sr) / winLen; break; }
      }
      brightness[c] = edge;
    }

    // Attack: time from start until envelope reaches 90% of peak.
    // Decay: time from peak back down to 10% of peak.
    let attackEnd = 0, peakIdx = 0, decayEnd = env.length - 1;
    let envPeak = 0;
    for (let i = 0; i < env.length; i++) { if (env[i] > envPeak) { envPeak = env[i]; peakIdx = i; } }
    const attackThresh = envPeak * 0.9;
    for (let i = 0; i <= peakIdx; i++) { if (env[i] >= attackThresh) { attackEnd = i; break; } }
    const decayThresh = envPeak * 0.1;
    for (let i = peakIdx; i < env.length; i++) { if (env[i] <= decayThresh) { decayEnd = i; break; } }

    const durationMs = (samples.length / sr) * 1000;
    const colToMs = durationMs / env.length;

    // Energy-weighted centroid (overall).
    let cNum = 0, cDen = 0;
    for (let c = 0; c < cols; c++) {
      const w = env[c];
      cNum += centroids[c] * w;
      cDen += w;
    }
    const overallCentroid = cDen > 1e-9 ? cNum / cDen : 0;
    let bNum = 0, bDen = 0;
    for (let c = 0; c < cols; c++) {
      const w = env[c];
      bNum += brightness[c] * w;
      bDen += w;
    }
    const overallBrightness = bDen > 1e-9 ? bNum / bDen : 0;

    this.envelope = env;
    this.centroidPerCol = centroids;
    this.spectroCols = spectroCols;
    this.stats = {
      peakDb: 20 * Math.log10(Math.max(1e-6, peak)),
      rmsDb: 20 * Math.log10(Math.max(1e-6, rms)),
      durationMs,
      centroidHz: overallCentroid,
      brightnessHz: overallBrightness,
      attackMs: attackEnd * colToMs,
      decayMs: (decayEnd - peakIdx) * colToMs,
      zcr: zc / (samples.length / sr),
    };
  }

  getStats(): SoundStats {
    if (!this.stats) {
      return {
        peakDb: -Infinity, rmsDb: -Infinity, durationMs: 0,
        centroidHz: 0, brightnessHz: 0, attackMs: 0, decayMs: 0, zcr: 0,
      };
    }
    return this.stats;
  }

  /** Renders the composite artwork. Idempotent. */
  render(): void {
    const W = this.opts.width;
    const H = this.opts.height;
    const g = this.ctx2d;
    g.save();
    g.clearRect(0, 0, W, H);

    // ---- Background: deep space gradient with a faint grid baseline. ----
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#05071a");
    bg.addColorStop(1, "#01020a");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // Faint horizontal centerline.
    g.strokeStyle = "rgba(106, 215, 255, 0.08)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, H * 0.62);
    g.lineTo(W, H * 0.62);
    g.stroke();

    if (!this.envelope || !this.stats) {
      // Idle state: a thin pulse line + label.
      g.fillStyle = "rgba(106, 215, 255, 0.35)";
      g.font = "10px 'Space Grotesk', monospace";
      g.textBaseline = "middle";
      g.fillText("— no capture —", 12, H / 2);
      g.restore();
      return;
    }

    const env = this.envelope;
    const centroids = this.centroidPerCol!;
    const spectro = this.spectroCols!;
    const stats = this.stats;

    // Color palette derived from overall spectral centroid: pitch -> hue.
    // 80Hz → deep magenta, 800Hz → cyan, 4kHz → lime, 12kHz → hot yellow.
    const accent = this.opts.accent
      ? hexToRgb(this.opts.accent)
      : centroidToColor(stats.centroidHz);

    // ---- Spectrogram band along the bottom (low-key, behind envelope). ----
    // Renders as a subtle frequency carpet so we can see noise vs tone.
    const specTop = H * 0.62;
    const specBot = H - 14;
    const specH = specBot - specTop;
    const bins = spectro[0].length;
    const fMax = this.sampleRate / 2;
    // We use a log-frequency mapping (20Hz..fMax).
    const logMin = Math.log(20);
    const logMax = Math.log(fMax);
    const cols = env.length;
    // Find max magnitude for normalization.
    let maxMag = 1e-9;
    for (let c = 0; c < cols; c++) {
      const arr = spectro[c];
      for (let k = 1; k < arr.length; k++) if (arr[k] > maxMag) maxMag = arr[k];
    }

    // Draw spectrogram as small rects per (col, log-row), additive blending.
    g.globalCompositeOperation = "lighter";
    const ROWS = 28;
    for (let r = 0; r < ROWS; r++) {
      const f0 = Math.exp(logMin + (r / ROWS) * (logMax - logMin));
      const f1 = Math.exp(logMin + ((r + 1) / ROWS) * (logMax - logMin));
      const k0 = Math.max(1, Math.floor((f0 / fMax) * bins));
      const k1 = Math.max(k0 + 1, Math.floor((f1 / fMax) * bins));
      const y = specTop + (1 - r / ROWS) * specH - specH / ROWS;
      for (let c = 0; c < cols; c++) {
        let m = 0;
        const arr = spectro[c];
        for (let k = k0; k < k1 && k < arr.length; k++) m += arr[k];
        m /= (k1 - k0);
        const a = Math.pow(m / maxMag, 0.55);
        if (a < 0.04) continue;
        g.fillStyle = `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, ${a * 0.55})`;
        g.fillRect(c, y, 1, Math.max(1, specH / ROWS));
      }
    }
    g.globalCompositeOperation = "source-over";

    // ---- Amplitude envelope: filled silhouette mirrored around center. ----
    // The silhouette is the main "subject" of the artwork.
    const envTop = 10;
    const envBot = H * 0.62 - 2;
    const envMid = (envTop + envBot) / 2;
    const envHalf = (envBot - envTop) / 2;

    // Find peak envelope value for normalization within drawing.
    let envMax = 1e-9;
    for (let c = 0; c < cols; c++) if (env[c] > envMax) envMax = env[c];

    // Glow pass — bright neon halo.
    g.save();
    g.shadowColor = `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 0.9)`;
    g.shadowBlur = 14;
    g.fillStyle = `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 0.18)`;
    g.beginPath();
    g.moveTo(0, envMid);
    for (let c = 0; c < cols; c++) {
      const h = (env[c] / envMax) * envHalf;
      g.lineTo(c, envMid - h);
    }
    for (let c = cols - 1; c >= 0; c--) {
      const h = (env[c] / envMax) * envHalf;
      g.lineTo(c, envMid + h);
    }
    g.closePath();
    g.fill();
    g.restore();

    // Crisp top edge — colored by per-column spectral centroid (pitch curve
    // baked into the silhouette outline).
    g.lineWidth = 1.25;
    for (let c = 1; c < cols; c++) {
      const h0 = (env[c - 1] / envMax) * envHalf;
      const h1 = (env[c] / envMax) * envHalf;
      const col = centroidToColor(centroids[c]);
      g.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.95)`;
      g.beginPath();
      g.moveTo(c - 1, envMid - h0);
      g.lineTo(c, envMid - h1);
      g.stroke();
      // Mirror bottom edge but dimmer.
      g.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.5)`;
      g.beginPath();
      g.moveTo(c - 1, envMid + h0);
      g.lineTo(c, envMid + h1);
      g.stroke();
    }

    // ---- Peak ceiling line (dashed). ----
    const peakY = envMid - envHalf;
    g.strokeStyle = "rgba(216, 243, 255, 0.35)";
    g.setLineDash([3, 4]);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, peakY);
    g.lineTo(W, peakY);
    g.stroke();
    g.setLineDash([]);

    // ---- Attack tick + decay tick — small vertical hairlines. ----
    const attackCol = Math.floor((stats.attackMs / stats.durationMs) * cols);
    const peakIdx = (() => { let m = 0, idx = 0; for (let c = 0; c < cols; c++) if (env[c] > m) { m = env[c]; idx = c; } return idx; })();
    const decayCol = peakIdx + Math.floor((stats.decayMs / stats.durationMs) * cols);
    g.strokeStyle = "rgba(216, 243, 255, 0.4)";
    g.lineWidth = 1;
    for (const x of [attackCol, decayCol]) {
      if (x <= 0 || x >= cols) continue;
      g.beginPath();
      g.moveTo(x + 0.5, envTop);
      g.lineTo(x + 0.5, envBot);
      g.stroke();
    }

    // ---- Centroid sidebar: thin vertical bar on the right edge whose
    //      height/color encodes the dominant pitch. ----
    const sbX = W - 6;
    const sbTop = 10;
    const sbBot = H - 14;
    const cNorm = Math.min(1, Math.log(Math.max(20, stats.centroidHz) / 20) / Math.log(fMax / 20));
    const sbY = sbTop + (1 - cNorm) * (sbBot - sbTop);
    g.fillStyle = "rgba(216, 243, 255, 0.07)";
    g.fillRect(sbX, sbTop, 3, sbBot - sbTop);
    g.fillStyle = `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 1)`;
    g.shadowColor = `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 0.9)`;
    g.shadowBlur = 6;
    g.fillRect(sbX - 1, sbY - 1, 5, 3);
    g.shadowBlur = 0;

    // ---- Transient fingerprint dots: place a dot at each local maxima of
    //      the envelope (with a small floor), sized by prominence. ----
    const transients = findTransients(env, envMax);
    for (const t of transients) {
      const x = t.idx + 0.5;
      const h = (env[t.idx] / envMax) * envHalf;
      const y = envMid - h - 3;
      const col = centroidToColor(centroids[t.idx]);
      g.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${0.6 + 0.4 * t.prom})`;
      g.shadowColor = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.9)`;
      g.shadowBlur = 6;
      g.beginPath();
      g.arc(x, y, 1.4 + 1.6 * t.prom, 0, Math.PI * 2);
      g.fill();
    }
    g.shadowBlur = 0;

    // ---- Numeric annotations: tucked into the corners, mono, low-key. ----
    g.font = "10px 'Space Grotesk', ui-monospace, monospace";
    g.textBaseline = "alphabetic";
    g.fillStyle = "rgba(216, 243, 255, 0.7)";
    const padX = 8;

    // Top-left: duration
    g.textAlign = "left";
    g.fillText(`${stats.durationMs.toFixed(0)} ms`, padX, 14);

    // Top-right (just inside sidebar): peak dB
    g.textAlign = "right";
    g.fillText(`${stats.peakDb.toFixed(1)} dB`, W - 12, 14);

    // Bottom-left: centroid pitch
    g.textAlign = "left";
    g.fillStyle = `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 0.85)`;
    g.fillText(formatHz(stats.centroidHz), padX, H - 4);

    // Bottom-right: attack/decay
    g.textAlign = "right";
    g.fillStyle = "rgba(216, 243, 255, 0.55)";
    g.fillText(
      `A ${stats.attackMs.toFixed(0)} · D ${stats.decayMs.toFixed(0)}`,
      W - 12, H - 4
    );

    g.restore();
  }

  /** Sets up the device-pixel-ratio backing store. Call after canvas resize. */
  applyDpr(): void {
    const W = this.opts.width;
    const H = this.opts.height;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

/* ------------------------------------------------------------------------ */
/*  Helpers                                                                 */
/* ------------------------------------------------------------------------ */

function nearestPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function makeHann(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  return w;
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = h.length === 3
    ? h.split("").map((c) => c + c).join("")
    : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Map a spectral centroid (Hz) to a neon hue along the game's palette.
 *  Anchors: 80Hz magenta → 600Hz cyan → 3kHz lime → 10kHz hot yellow. */
function centroidToColor(hz: number): RGB {
  if (!isFinite(hz) || hz <= 0) return [106, 215, 255];
  const stops: { hz: number; c: RGB }[] = [
    { hz: 60,    c: [255, 90, 200] }, // magenta
    { hz: 250,   c: [180, 130, 255] }, // violet
    { hz: 800,   c: [106, 215, 255] }, // cyan (canonical Pulsar accent)
    { hz: 3000,  c: [140, 255, 200] }, // mint
    { hz: 8000,  c: [255, 230, 120] }, // hot yellow
    { hz: 16000, c: [255, 170, 90] },  // ember orange
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (hz <= b.hz) {
      const la = Math.log(a.hz), lb = Math.log(b.hz), lh = Math.log(Math.max(20, hz));
      const t = Math.max(0, Math.min(1, (lh - la) / (lb - la)));
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * t),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * t),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * t),
      ];
    }
  }
  return stops[stops.length - 1].c;
}

function formatHz(hz: number): string {
  if (!isFinite(hz) || hz <= 0) return "— Hz";
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

interface Transient { idx: number; prom: number; }
function findTransients(env: Float32Array, envMax: number): Transient[] {
  const out: Transient[] = [];
  const floor = envMax * 0.18;
  // Smooth the envelope a touch.
  const s = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    const a = env[Math.max(0, i - 1)], b = env[i], c = env[Math.min(env.length - 1, i + 1)];
    s[i] = (a + 2 * b + c) / 4;
  }
  const window = Math.max(3, Math.floor(env.length / 40));
  for (let i = window; i < s.length - window; i++) {
    let isMax = true;
    for (let j = -window; j <= window; j++) {
      if (j === 0) continue;
      if (s[i + j] >= s[i]) { isMax = false; break; }
    }
    if (isMax && s[i] > floor) {
      // Prominence: ratio of this peak to neighbouring valleys.
      let left = s[i], right = s[i];
      for (let j = i - window; j >= Math.max(0, i - window * 3); j--) left = Math.min(left, s[j]);
      for (let j = i + window; j <= Math.min(s.length - 1, i + window * 3); j++) right = Math.min(right, s[j]);
      const valley = Math.max(left, right, 1e-6);
      const prom = Math.min(1, (s[i] - valley) / envMax);
      if (prom > 0.04) out.push({ idx: i, prom });
    }
  }
  // Cap to keep visual uncluttered.
  out.sort((a, b) => b.prom - a.prom);
  return out.slice(0, 8);
}

/* ------------------------------------------------------------------------ */
/*  SimpleFFT — iterative radix-2 for power-of-two sizes.                   */
/* ------------------------------------------------------------------------ */
class SimpleFFT {
  readonly size: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    this.size = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    let bits = 0;
    for (let n = size; n > 1; n >>= 1) bits++;
    for (let i = 0; i < size; i++) {
      let v = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) v |= 1 << (bits - 1 - b);
      this.rev[i] = v;
    }
  }

  /** Returns magnitude spectrum of length size/2 (DC removed). */
  magnitude(input: Float32Array): Float32Array {
    const N = this.size;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = input[this.rev[i]];
    for (let s = 1; s <= Math.log2(N); s++) {
      const m = 1 << s;
      const halfM = m >> 1;
      const step = N / m;
      for (let k = 0; k < N; k += m) {
        for (let j = 0; j < halfM; j++) {
          const tIdx = j * step;
          const tr =  this.cos[tIdx] * re[k + j + halfM] - this.sin[tIdx] * im[k + j + halfM];
          const ti =  this.cos[tIdx] * im[k + j + halfM] + this.sin[tIdx] * re[k + j + halfM];
          re[k + j + halfM] = re[k + j] - tr;
          im[k + j + halfM] = im[k + j] - ti;
          re[k + j] += tr;
          im[k + j] += ti;
        }
      }
    }
    const out = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / N;
    return out;
  }
}

/* ------------------------------------------------------------------------ */
/*  Self-test helper                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Generates a short FM blip (~220ms) that you can use to verify the
 * visualizer without wiring the real game audio. Routes through both
 * `ctx.destination` (so you can hear it) AND `vis.getTap(ctx)` (so the
 * visualizer captures it).
 *
 * Returns a play() callback. Call this inside `capture(ctx, play, 0.3)`.
 */
export function makeFakeBlip(
  ctx: AudioContext,
  vis: SoundVisualizer,
  variant: "blip" | "thump" | "sparkle" = "blip"
): () => void {
  return () => {
    const t0 = ctx.currentTime;
    const tap = vis.getTap(ctx);

    if (variant === "thump") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(140, t0);
      osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.18);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.exponentialRampToValueAtTime(0.9, t0 + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.connect(tap);
      osc.start(t0);
      osc.stop(t0 + 0.25);
    } else if (variant === "sparkle") {
      const freqs = [880, 1320, 1760, 2640];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = f * (1 + i * 0.002);
        const start = t0 + i * 0.025;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.25, start + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
        osc.connect(g);
        g.connect(ctx.destination);
        g.connect(tap);
        osc.start(start);
        osc.stop(start + 0.2);
      });
    } else {
      // FM blip
      const carrier = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const gain = ctx.createGain();
      carrier.type = "sine";
      mod.type = "sine";
      carrier.frequency.setValueAtTime(660, t0);
      carrier.frequency.exponentialRampToValueAtTime(220, t0 + 0.2);
      mod.frequency.setValueAtTime(220, t0);
      mod.frequency.exponentialRampToValueAtTime(60, t0 + 0.2);
      modGain.gain.setValueAtTime(300, t0);
      modGain.gain.exponentialRampToValueAtTime(20, t0 + 0.2);
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.6, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      carrier.connect(gain);
      gain.connect(ctx.destination);
      gain.connect(tap);
      mod.start(t0);
      carrier.start(t0);
      mod.stop(t0 + 0.25);
      carrier.stop(t0 + 0.25);
    }
  };
}
