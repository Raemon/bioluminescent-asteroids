// Stress-tests the master mix chain against stacked baked sounds, without ears.
//
// Decodes the real baked mp3s in headless Chromium, replays busy-moment
// schedules through candidate master-dynamics graphs in an OfflineAudioContext,
// and reports, per (scenario x variant):
//   peak      highest |sample| out of the chain (the DAC hard-clips past 1.0)
//   clip%     fraction of samples beyond +/-1.0 — audible crackle when > 0
//   rms       overall loudness of the render
//   gr        mean gain reduction vs the dynamics-free reference, loud windows
//   ripple    mean |delta gain| between adjacent 5 ms windows — gain pumping
//             fast enough to read as distortion rather than as level
//
//   npm run check:mix-stress
//
// The "current" variant must mirror buildMixGraph in src/Sound.ts. The check
// FAILS if the current chain lets any scenario clip (samples beyond +/-1.0)
// or peak above the soft-clip ceiling — the regression that made stacked
// sounds crackle after the baked-sounds refactor.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";
const PORT = Number(process.env.PORT) || 5201;
const PUBLIC_DIR = new URL("../public", import.meta.url).pathname;

const MIME = { ".mp3": "audio/mpeg", ".json": "application/json", ".html": "text/html" };
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>mix stress</title>");
      return;
    }
    const body = await readFile(join(PUBLIC_DIR, decodeURIComponent(req.url.split("?")[0])));
    res.writeHead(200, { "content-type": MIME[extname(req.url)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const page = await browser.newPage();
page.on("console", (m) => console.log("  page>", m.text()));
page.on("pageerror", (e) => console.error("  page error>", e));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });

const results = await page.evaluate(async () => {
  const RATE = 48000;
  const VOLUME = 2; // Sound.volume default; liveSum/bakedSum gain at base 1.0

  const FILES = [
    "explosionLarge__1.0000", "explosionMedium__1.0000", "explosionSmall__1.0000",
    "bell__1.0000", "crystalShatterLarge__1.0000", "crystalShatterSmall__1.0000",
    "comboChime__261.6300", "comboChime__392.0000", "scoreBlip__1.0000",
    "bgBeat__1112.5000", "fireBeat__1.0000", "fire__1.0000",
    "alienExplode__1.0000", "alienFireBig__0.0000", "bassKick__1.0000",
    "shockwaveBoom__1.0000", "asteroidBoomBeat__1.0000",
  ];
  const MUSIC = ["halo-music/cinematic-el-ambient", "halo-music/cinematic-el-melodic"];

  // Voices whose mp3 carries its own compressor + limiter (Tone recipes, the
  // ElevenLabs one-shots). Mirrors Sound.PREMASTERED_BAKES: those play through
  // the baked leg's glue; a raw-voice bake plays through the live leg, so a
  // scenario has to route each file the way the game does.
  const PREMASTERED = new Set([
    "bgBeat", "fireBeat", "bassKick", "bassBoom", "bassPluck", "bassSnap",
    "chime", "drainChime", "powerup", "waveClear", "cometNote",
    "wraithScream", "wraithHit", "wraithLunge", "wraithDeath",
  ]);
  const gains = await fetch("/sounds/baked/bake-gains.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

  const decodeCtx = new AudioContext({ sampleRate: RATE });
  const buffers = {};
  const filePeaks = {};
  const premastered = {};
  for (const name of [...FILES, ...MUSIC]) {
    const url = name.includes("/") ? `/sounds/${name}.mp3` : `/sounds/baked/${name}.mp3`;
    const ab = await (await fetch(url)).arrayBuffer();
    const buf = await decodeCtx.decodeAudioData(ab);
    // Undo the encode-time normalization, exactly as Sound does on decode.
    const g = gains[name] ?? 1;
    if (g !== 1) {
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= g;
      }
    }
    premastered[name] = PREMASTERED.has(name.split("__")[0]);
    buffers[name] = buf;
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    filePeaks[name] = peak;
  }
  await decodeCtx.close();

  const comp = (threshold, ratio, knee, attack, release) =>
    ({ type: "comp", threshold, ratio, knee, attack, release });
  const gain = (value) => ({ type: "gain", value });
  const clip = (knee, ceiling) => ({ type: "clip", knee, ceiling });

  // Stage lists: liveSum -> livePre -> shared -> destination,
  //              bakedSum -> bakedPre -> shared -> destination.
  const VARIANTS = {
    reference: { livePre: [], bakedPre: [], shared: [] },
    // The chain that shipped with the baked-sounds refactor: baked leg
    // straight into a fast-release 20:1 "limiter" that neither stopped overs
    // (the DAC hard-clipped them) nor moved its gain slower than audio rate.
    "pre-fix": {
      livePre: [comp(-18, 3, 12, 0.01, 0.18)],
      bakedPre: [],
      shared: [comp(-1, 20, 0, 0.003, 0.01)],
    },
    // Mirror of buildMixGraph in src/Sound.ts — keep in lockstep.
    current: {
      livePre: [comp(-18, 3, 12, 0.01, 0.18)],
      bakedPre: [comp(-10, 2.5, 12, 0.006, 0.25), gain(0.83)],
      shared: [comp(-2, 20, 6, 0.003, 0.12), clip(0.87, 0.985)],
    },
  };

  const buildStage = (ctx, s) => {
    if (s.type === "comp") {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = s.threshold; c.ratio.value = s.ratio; c.knee.value = s.knee;
      c.attack.value = s.attack; c.release.value = s.release;
      return c;
    }
    if (s.type === "gain") {
      const g = ctx.createGain();
      g.gain.value = s.value;
      return g;
    }
    if (s.type === "clip") {
      const w = ctx.createWaveShaper();
      const N = 8192, curve = new Float32Array(N);
      const knee = s.knee, ceil = s.ceiling;
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * 2 - 1;
        const a = Math.abs(x);
        curve[i] = a <= knee ? x : Math.sign(x) * (knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee)));
      }
      w.curve = curve;
      return w;
    }
    throw new Error(`unknown stage ${s.type}`);
  };

  const chain = (ctx, stages, dest) => {
    let head = dest;
    for (let i = stages.length - 1; i >= 0; i--) {
      const node = buildStage(ctx, stages[i]);
      node.connect(head);
      head = node;
    }
    return head;
  };

  // Events: { file, t, ch, dup } — dup replays the same buffer dup times with
  // playBaked's 1/sqrt(k) same-key pileup duck applied to each copy.
  const beats = (file, ch, period, from, to) => {
    const out = [];
    for (let t = from; t < to; t += period) out.push({ file, t, ch });
    return out;
  };
  const SCENARIOS = {
    "single explosion": [{ file: "explosionLarge__1.0000", t: 0.5, ch: "sfx" }],
    "shockwaveBoom alone": [{ file: "shockwaveBoom__1.0000", t: 0.5, ch: "sfx" }],
    "bgBeat alone": beats("bgBeat__1112.5000", "basePulse", 0.5, 0.2, 3.8),
    "multikill (5 sfx + beat)": [
      ...beats("bgBeat__1112.5000", "basePulse", 0.5, 0.2, 3.8),
      { file: "explosionLarge__1.0000", t: 1.0, ch: "sfx" },
      { file: "explosionMedium__1.0000", t: 1.004, ch: "sfx" },
      { file: "bell__1.0000", t: 1.008, ch: "sfx" },
      { file: "crystalShatterLarge__1.0000", t: 1.012, ch: "sfx" },
      { file: "comboChime__261.6300", t: 1.05, ch: "sfx" },
      { file: "scoreBlip__1.0000", t: 1.1, ch: "sfx" },
    ],
    "same-frame pileup x6": [
      ...beats("bgBeat__1112.5000", "basePulse", 0.5, 0.2, 3.8),
      { file: "explosionLarge__1.0000", t: 1.0, ch: "sfx", dup: 6 },
    ],
    "mayhem (12 sfx + beat + music)": [
      ...beats("bgBeat__1112.5000", "basePulse", 0.5, 0.2, 3.8),
      ...beats("fireBeat__1.0000", "sfx", 0.25, 0.3, 3.6),
      { file: "halo-music/cinematic-el-ambient", t: 0, ch: "music", gain: 0.7 },
      { file: "halo-music/cinematic-el-melodic", t: 0, ch: "music", gain: 0.7 },
      { file: "shockwaveBoom__1.0000", t: 0.9, ch: "sfx" },
      { file: "explosionLarge__1.0000", t: 1.0, ch: "sfx" },
      { file: "explosionMedium__1.0000", t: 1.01, ch: "sfx" },
      { file: "explosionSmall__1.0000", t: 1.02, ch: "sfx" },
      { file: "crystalShatterLarge__1.0000", t: 1.03, ch: "sfx" },
      { file: "crystalShatterSmall__1.0000", t: 1.05, ch: "sfx" },
      { file: "bell__1.0000", t: 1.06, ch: "sfx" },
      { file: "alienExplode__1.0000", t: 1.2, ch: "sfx" },
      { file: "alienFireBig__0.0000", t: 1.3, ch: "sfx" },
      { file: "bassKick__1.0000", t: 1.5, ch: "sfx" },
      { file: "comboChime__261.6300", t: 1.55, ch: "sfx" },
      { file: "comboChime__392.0000", t: 1.7, ch: "sfx" },
      { file: "asteroidBoomBeat__1.0000", t: 1.8, ch: "sfx" },
      { file: "explosionLarge__1.0000", t: 2.2, ch: "sfx" },
      { file: "alienExplode__1.0000", t: 2.3, ch: "sfx" },
    ],
  };

  const DUR = 4.5;
  const render = async (events, variant) => {
    const ctx = new OfflineAudioContext(2, Math.ceil(DUR * RATE), RATE);
    // One shared master section, exactly like Sound.buildMixGraph: both legs
    // join the same node instances, so the shared dynamics see the summed mix.
    const sharedIn = chain(ctx, variant.shared, ctx.destination);
    const liveIn = chain(ctx, variant.livePre, sharedIn);
    const bakedIn = chain(ctx, variant.bakedPre, sharedIn);
    const liveSum = ctx.createGain(); liveSum.gain.value = VOLUME; liveSum.connect(liveIn);
    const bakedSum = ctx.createGain(); bakedSum.gain.value = VOLUME; bakedSum.connect(bakedIn);
    // channel gains all default to 1.0; music routes to the live leg (halo
    // stems connect to chMusicLive), everything baked to the baked leg.
    for (const ev of events) {
      const dup = ev.dup ?? 1;
      for (let k = 1; k <= dup; k++) {
        const src = ctx.createBufferSource();
        src.buffer = buffers[ev.file];
        const g = ctx.createGain();
        g.gain.value = (ev.gain ?? 1) * (dup > 1 ? 1 / Math.sqrt(k) : 1);
        src.connect(g);
        // Music stems connect to chMusicLive; a raw-voice bake joins the live
        // leg like the graph it was rendered from; only pre-mastered files
        // take the glue leg.
        g.connect(ev.ch !== "music" && premastered[ev.file] ? bakedSum : liveSum);
        src.start(ev.t);
      }
    }
    const buf = await ctx.startRendering();
    return [buf.getChannelData(0), buf.getChannelData(1)];
  };

  const metrics = (out, ref) => {
    const n = out[0].length;
    let peak = 0, over = 0, sumSq = 0;
    for (const chd of out) {
      for (let i = 0; i < n; i++) {
        const a = Math.abs(chd[i]);
        if (a > peak) peak = a;
        if (a > 1.0) over++;
        sumSq += chd[i] * chd[i];
      }
    }
    // DynamicsCompressor imposes a ~6 ms lookahead delay per stage, so the
    // output lags the dynamics-free reference. Find the integer lag (in 1 ms
    // steps up to 30 ms) that best aligns the two envelopes before comparing
    // windowed gain, or latency masquerades as huge gain ripple.
    const E = Math.floor(RATE / 1000);
    const env = (data) => {
      const ne = Math.floor(n / E);
      const e = new Float32Array(ne);
      for (let w = 0; w < ne; w++) {
        let s = 0;
        for (const chd of data) for (let i = w * E; i < (w + 1) * E; i++) s += chd[i] * chd[i];
        e[w] = Math.sqrt(s / (2 * E));
      }
      return e;
    };
    const eOut = env(out), eRef = env(ref);
    let bestLag = 0, bestScore = -Infinity;
    for (let lag = 0; lag <= 30; lag++) {
      let s = 0;
      for (let w = 0; w + lag < eOut.length; w++) s += eOut[w + lag] * eRef[w];
      if (s > bestScore) { bestScore = s; bestLag = lag; }
    }
    // Windowed gain vs reference at the aligned offset, 5 ms windows.
    const W = 5 * E;
    const nw = Math.floor((n - bestLag * E) / W);
    const winRms = (data, start) => {
      let s = 0;
      for (const chd of data) for (let i = start; i < start + W; i++) s += chd[i] * chd[i];
      return Math.sqrt(s / (2 * W));
    };
    let grSum = 0, grN = 0, ripSum = 0, ripN = 0, prevDb = null;
    for (let w = 0; w < nw; w++) {
      const r = winRms(ref, w * W);
      if (r < 0.02) { prevDb = null; continue; } // ~-34 dBFS: quiet, gain meaningless
      const gDb = 20 * Math.log10(Math.max(winRms(out, w * W + bestLag * E), 1e-9) / r);
      grSum += gDb; grN++;
      if (prevDb !== null) { ripSum += Math.abs(gDb - prevDb); ripN++; }
      prevDb = gDb;
    }
    return {
      peak: peak.toFixed(3),
      clipPct: ((over / (2 * n)) * 100).toFixed(3),
      rmsDb: (20 * Math.log10(Math.sqrt(sumSq / (2 * n)) + 1e-9)).toFixed(1),
      grDb: grN ? (grSum / grN).toFixed(2) : "-",
      rippleDb: ripN ? (ripSum / ripN).toFixed(3) : "-",
    };
  };

  const table = {};
  for (const [sName, events] of Object.entries(SCENARIOS)) {
    const ref = await render(events, VARIANTS.reference);
    table[sName] = {};
    for (const [vName, variant] of Object.entries(VARIANTS)) {
      const out = vName === "reference" ? ref : await render(events, variant);
      table[sName][vName] = metrics(out, ref);
    }
  }
  return { filePeaks, table };
});

console.log("\ndecoded file peaks, after the bake-gain is undone (a raw-voice bake is");
console.log("the bare voice, so these are voice levels, not mastered ones):");
for (const [f, p] of Object.entries(results.filePeaks)) console.log(`  ${p.toFixed(3)}  ${f}`);

const failures = [];
for (const [scenario, variants] of Object.entries(results.table)) {
  console.log(`\n=== ${scenario}`);
  console.log("  variant".padEnd(28) + "peak".padEnd(9) + "clip%".padEnd(9) + "rms dB".padEnd(9) + "GR dB".padEnd(9) + "ripple dB/5ms");
  for (const [v, m] of Object.entries(variants)) {
    console.log(`  ${v.padEnd(26)}${String(m.peak).padEnd(9)}${String(m.clipPct).padEnd(9)}${String(m.rmsDb).padEnd(9)}${String(m.grDb).padEnd(9)}${m.rippleDb}`);
  }
  const m = variants.current;
  if (Number(m.clipPct) > 0) failures.push(`${scenario}: ${m.clipPct}% of samples beyond full scale`);
  if (Number(m.peak) > 0.985) failures.push(`${scenario}: peak ${m.peak} above the soft-clip ceiling`);
}

await browser.close();
server.close();
if (failures.length) {
  console.error(`\nFAIL: the current master chain clips under stacking:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASS: no scenario clips or escapes the soft-clip ceiling through the current chain");
process.exit(0);
