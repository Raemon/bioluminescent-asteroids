// Offline numeric model of the bgBeat MembraneSynth voice, to quantify how far
// the PERCEIVED attack lags the buffer's true start (sample 0 == the scheduled beat).
//
// Reproduces Tone.MembraneSynth faithfully (see node_modules/tone/.../MembraneSynth.ts):
//   freq(t): starts at note*octaves, exponential ramp to note over pitchDecay
//   amp(t):  exponential attack (0.001s) to 1, then exponential decay to sustain(0)
// We then measure onset three ways and compare against fireBeat (which has a tick).

const SR = 48000;
const DUR = 0.5; // enough to cover attack + most of decay

// --- Tone envelope helpers -------------------------------------------------
// Tone exponential attack: ramps 0->1; we approximate its standard curve.
// Tone uses a normalized exponential approach; the audible attack is ~attack secs.
function ampEnv(t, { attack, decay, sustain }) {
  if (t < 0) return 0;
  if (t < attack) {
    // exponential-ish rise: 1 - e^(-k t). Tone's "exponential" attack reaches
    // ~0.63 at one time-constant; it sets the ramp to complete near `attack`.
    const k = 5 / attack; // ~99% by t=attack
    return 1 - Math.exp(-k * t);
  }
  const td = t - attack;
  // exponentialRampToValueAtTime to sustain over `decay`
  const target = Math.max(sustain, 1e-4);
  const ratio = Math.pow(target / 1, td / decay);
  return Math.max(target, ratio);
}

// freq sweep: exponentialRamp from f0 to f1 over pitchDecay, then hold f1
function freqAt(t, f0, f1, pitchDecay) {
  if (t >= pitchDecay) return f1;
  const frac = t / pitchDecay;
  return f0 * Math.pow(f1 / f0, frac);
}

// Render a membrane voice. Integrate phase since frequency is time-varying.
function renderMembrane({ note, octaves, pitchDecay, attack, decay, sustain }) {
  const n = Math.floor(SR * DUR);
  const out = new Float32Array(n);
  const f0 = note * octaves;
  const f1 = note;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = freqAt(t, f0, f1, pitchDecay);
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(phase) * ampEnv(t, { attack, decay, sustain });
  }
  return out;
}

// Add a short bandpassed-noise "tick" transient at the front (one-pole approx).
function addTick(buf, { centerHz, decay, peak }) {
  const n = buf.length;
  // crude resonant tick: decaying sinusoid at centerHz with fast amp decay
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t > decay * 4) break;
    const env = Math.exp(-t / decay);
    buf[i] += peak * env * Math.sin(2 * Math.PI * centerHz * t);
  }
  return buf;
}

// --- Perceptual onset estimators ------------------------------------------
// 1) Energy-weighted centroid of the first 120ms (where the ear places "the hit")
function energyCentroidMs(buf, windowMs = 120) {
  const w = Math.floor((windowMs / 1000) * SR);
  let num = 0, den = 0;
  for (let i = 0; i < w; i++) {
    const e = buf[i] * buf[i];
    num += e * (i / SR);
    den += e;
  }
  return den > 0 ? (num / den) * 1000 : NaN;
}

// 2) Time to reach a fraction of peak amplitude (envelope follower)
function timeToFracPeakMs(buf, frac = 0.5) {
  // amplitude envelope via abs + one-pole smoothing (~5ms)
  const a = Math.exp(-1 / (0.005 * SR));
  let env = 0, peak = 0;
  const envBuf = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const x = Math.abs(buf[i]);
    env = a * env + (1 - a) * x;
    envBuf[i] = env;
    if (env > peak) peak = env;
  }
  const thresh = peak * frac;
  for (let i = 0; i < envBuf.length; i++) {
    if (envBuf[i] >= thresh) return (i / SR) * 1000;
  }
  return NaN;
}

// 3) High-passed energy centroid: the ear localizes onsets via mid/high
//    content. Crude 1-pole highpass at ~500 Hz, then centroid of first 120ms.
function hpEnergyCentroidMs(buf, cutoffHz = 500, windowMs = 120) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SR;
  const alpha = rc / (rc + dt);
  const hp = new Float32Array(buf.length);
  let prevX = 0, prevY = 0;
  for (let i = 0; i < buf.length; i++) {
    const y = alpha * (prevY + buf[i] - prevX);
    hp[i] = y;
    prevX = buf[i];
    prevY = y;
  }
  return energyCentroidMs(hp, windowMs);
}

function report(label, buf) {
  console.log(`\n${label}`);
  console.log(`  energy centroid (0-120ms):      ${energyCentroidMs(buf).toFixed(1)} ms`);
  console.log(`  hp-energy centroid (>500Hz):    ${hpEnergyCentroidMs(buf).toFixed(1)} ms`);
  console.log(`  time to 50% peak (5ms env):     ${timeToFracPeakMs(buf, 0.5).toFixed(1)} ms`);
  console.log(`  time to 90% peak:               ${timeToFracPeakMs(buf, 0.9).toFixed(1)} ms`);
}

// === Current bgBeat (downbeat, A0) ========================================
const A0 = 27.5;
const bg = renderMembrane({ note: A0, octaves: 8, pitchDecay: 0.08, attack: 0.001, decay: 0.6, sustain: 0 });
report("bgBeat (current): A0, octaves 8, pitchDecay 0.08", bg);

// === fireBeat membrane body (C3) for contrast — note it ALSO gets a pluck tick
const C3 = 130.81;
const fire = renderMembrane({ note: C3, octaves: 3, pitchDecay: 0.04, attack: 0.002, decay: 0.22, sustain: 0 });
report("fireBeat body only: C3, octaves 3, pitchDecay 0.04 (no tick)", fire);

// === Candidate A: tamed sweep =============================================
const tamed = renderMembrane({ note: A0, octaves: 3, pitchDecay: 0.02, attack: 0.001, decay: 0.6, sustain: 0 });
report("Candidate A: A0, octaves 3, pitchDecay 0.02 (tamed sweep)", tamed);

// === Candidate B: current sweep + tick ====================================
const ticked = addTick(renderMembrane({ note: A0, octaves: 8, pitchDecay: 0.08, attack: 0.001, decay: 0.6, sustain: 0 }), { centerHz: 1800, decay: 0.004, peak: 0.5 });
report("Candidate B: current + 1.8kHz tick (peak 0.5, 4ms)", ticked);

// === Candidate C: tamed sweep + tick ======================================
const both = addTick(renderMembrane({ note: A0, octaves: 3, pitchDecay: 0.02, attack: 0.001, decay: 0.6, sustain: 0 }), { centerHz: 1800, decay: 0.004, peak: 0.4 });
report("Candidate C: tamed + tick (peak 0.4)", both);
