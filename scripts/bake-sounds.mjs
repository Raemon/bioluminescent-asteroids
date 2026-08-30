// Renders every missing baked one-shot to public/sounds/baked/*.mp3 without a
// human having to sit in front of the game.
//
// The bake itself has always lived in the browser — Sound.bakeSound renders a
// voice through an OfflineAudioContext and POSTs the WAV to the dev server's
// /__bake-dump__ hook, which pipes it through ffmpeg (see vite.config.ts). All
// this script does is supply the browser: it boots `vite dev`, opens the page
// in headless Chromium, constructs a Sound, and waits for warmBakedCache to
// work through its queue. Files already on disk are fetched rather than
// re-rendered, and the dev hook refuses to overwrite them, so re-running this
// only fills in what's missing.
//
//   node scripts/bake-sounds.mjs           # fill in missing bakes
//   node scripts/bake-sounds.mjs --list    # report cache state, write nothing
//
// Requires ffmpeg with libmp3lame on PATH.

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";
const PORT = Number(process.env.PORT) || 5199;
const LIST_ONLY = process.argv.includes("--list");

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
});
vite.stderr.on("data", (c) => process.stderr.write(c));

const waitForServer = () =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vite did not start")), 60_000);
    vite.stdout.on("data", (c) => {
      process.stdout.write(c);
      if (c.toString().includes("Local:")) {
        clearTimeout(timer);
        setTimeout(resolve, 500);
      }
    });
  });

const shutdown = (code) => {
  vite.kill("SIGTERM");
  process.exit(code);
};

try {
  await waitForServer();
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (!t.startsWith("[vite]")) console.log("  page>", t);
  });
  await page.goto(`http://localhost:${PORT}/sound`, { waitUntil: "domcontentloaded" });

  const summary = await page.evaluate(async (listOnly) => {
    const [{ Sound }, cfg] = await Promise.all([
      import("/src/Sound.ts"),
      import("/src/soundConfig.ts"),
    ]);
    // Semantic knobs (fire's body/tick shape, the explosion trio, death) are
    // read inside the graph builders, so the config has to be in memory before
    // anything renders or the bake would freeze the hardcoded fallbacks.
    await cfg.loadSoundConfig();
    const sound = new Sound();
    sound.ensureContext();
    const states = () => {
      const out = { queued: 0, fetching: 0, loaded: 0, failed: 0 };
      for (const v of sound.bakedLoadStates.values()) out[v]++;
      return out;
    };
    if (listOnly) {
      await new Promise((r) => setTimeout(r, 3000));
      return { ...states(), pending: [] };
    }
    // A 404 on the mp3 flips the entry to "failed" and *then* chains the
    // offline render, so "nothing queued or fetching" is not the finish line —
    // wait for the render queue to drain too, and for the loaded count to sit
    // still, before deciding we're done.
    const deadline = Date.now() + 20 * 60 * 1000;
    let lastLoaded = -1;
    let still = 0;
    for (;;) {
      const s = states();
      const idle = s.queued === 0 && s.fetching === 0 && sound.bakingInFlight.size === 0;
      still = idle && s.loaded === lastLoaded ? still + 1 : 0;
      lastLoaded = s.loaded;
      if (still >= 3 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const pending = [];
    for (const [k, v] of sound.bakedLoadStates) if (v !== "loaded") pending.push(`${k}=${v}`);
    return { ...states(), pending };
  }, LIST_ONLY);

  console.log("\nbake cache:", summary);
  if (summary.pending?.length) console.log("not loaded:", summary.pending.join(", "));
  await browser.close();
  shutdown(0);
} catch (err) {
  console.error(err);
  shutdown(1);
}
