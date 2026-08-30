// Regression check for replay export audio.
//
// Drives Sound through the exact prewarm → capture-context → offline-render
// path videoExport.ts uses (minus the video encoder), fires a spread of voices
// across every dispatch style, and asserts the render is stereo, non-silent,
// and non-silent in EVERY second it fired something — not just at the start.
//
// It exists because the export is the one place where the loading rules
// invert. Gameplay is happy to render a voice live while its mp3 lands; the
// exporter steps frames faster than real time, so a load that resolves
// mid-sweep resolves against a clock that has already raced past the moment
// the voice needed. Everything must be resident before frame one. Two bugs
// this catches: a prewarm that returns while loads are still in flight, and a
// play-time decode that goes through the idle-paced background queue.
//
//   npm run check:export-audio      (needs a browser; CHROME_PATH to override)
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT) || 5231;
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise((res) => vite.stdout.on("data", (c) => { if (c.toString().includes("Local:")) setTimeout(res, 500); }));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium", args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const page = await browser.newPage();
page.on("console", (m) => { const t = m.text(); if (!t.startsWith("[vite]")) console.log("  page>", t); });
await page.goto(`http://localhost:${PORT}/sound`, { waitUntil: "domcontentloaded" });

const result = await page.evaluate(async () => {
  const [{ Sound }, cfg, cap] = await Promise.all([
    import("/src/Sound.ts"),
    import("/src/soundConfig.ts"),
    import("/src/game/audioCapture.ts"),
  ]);
  await cfg.loadSoundConfig();
  const sound = new Sound();
  sound.ensureContext();

  const t0 = performance.now();
  await sound.prewarmForExport();
  const prewarmMs = Math.round(performance.now() - t0);
  const states = { queued: 0, fetching: 0, loaded: 0, failed: 0 };
  for (const v of sound.bakedLoadStates.values()) states[v]++;

  // Same construction as videoExport.ts: an OfflineAudioContext behind a
  // CaptureAudioContext driven by an ExportClock.
  const sampleRate = 48000;
  const durationSec = 8;
  const offline = new OfflineAudioContext(2, sampleRate * durationSec, sampleRate);
  const clock = new cap.ExportClock();
  sound.beginExportCapture(new cap.CaptureAudioContext(offline, clock));

  // A spread of voices across every dispatch style: baked-only (no fallback),
  // newly baked with a fallback, parameterized, drones, and music.
  const fired = [];
  const at = (sec, fn, label) => { clock.now = sec; try { fn(); fired.push(label); } catch (e) { fired.push(label + "!" + e); } };
  clock.now = 0;
  at(0.1, () => sound.play("fireBeat"), "fireBeat");
  at(0.3, () => sound.playBgBeatAt(1, 0.3), "bgBeat");
  at(0.5, () => sound.play("asteroidBoomBeat"), "asteroidBoomBeat");
  at(0.7, () => sound.play("explosionLarge"), "explosionLarge");
  at(0.9, () => sound.playLaserShot(8, 4), "laserShot");
  at(1.1, () => sound.play("death"), "death");
  at(1.4, () => sound.playComboChime(5), "comboChime");
  at(1.7, () => sound.playDriftShotHit(6), "driftShotHit");
  at(2.0, () => sound.play("bell", 0.55), "bell@chip");
  at(2.3, () => sound.play("crystalShatterLarge", 0), "crystalShatterLarge");
  at(2.6, () => sound.play("summaryDownbeat", 2), "summaryDownbeat");
  at(2.9, () => sound.play("scoreBlip", 1.335), "scoreBlip");
  at(3.2, () => sound.play("bossHit"), "bossHit");
  at(3.5, () => sound.startThrust?.() ?? sound.play("thrust"), "thrust");
  at(4.0, () => sound.play("meteorShower"), "meteorShower");
  clock.now = durationSec;

  sound.endExportCapture();
  const rendered = await offline.startRendering();

  // Per-second RMS so a render that is loud only at the very start (i.e. the
  // later voices went missing) is distinguishable from one that isn't.
  const perSecond = [];
  for (let s = 0; s < durationSec; s++) {
    let sum = 0, n = 0;
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      const d = rendered.getChannelData(ch);
      for (let i = s * sampleRate; i < Math.min((s + 1) * sampleRate, d.length); i++) { sum += d[i] * d[i]; n++; }
    }
    perSecond.push(Number((Math.sqrt(sum / Math.max(1, n))).toFixed(5)));
  }
  let peak = 0;
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    const d = rendered.getChannelData(ch);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  return { prewarmMs, states, fired, peak: Number(peak.toFixed(4)), perSecondRms: perSecond, channels: rendered.numberOfChannels };
});

console.log(JSON.stringify(result, null, 1));
const silentSeconds = result.perSecondRms.slice(0, 5).filter((v) => v < 1e-4).length;
const ok = result.peak > 0.01 && silentSeconds === 0 && result.states.queued === 0 && result.states.fetching === 0;
console.log(ok ? "PASS: export render carries audio for every second voices were fired in" : "FAIL");
await browser.close();
vite.kill("SIGTERM");
process.exit(ok ? 0 : 1);
