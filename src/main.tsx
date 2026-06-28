import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./style.css";

import { Game } from "./Game";
import { loadSoundConfig } from "./soundConfig";
import { installBetaTest } from "./game/betaTest";
import { installInstructionsDemos } from "./instructions";

// Mount React first and force a synchronous commit so the HUD/Overlay
// markup is on the page before bindHudElements() runs inside `new Game()`.
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("React root #root not found");
const root = createRoot(rootEl);
flushSync(() => {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
if (!canvas) throw new Error("Canvas #stage not found");

// Pull /sounds/config.json before any audio fires so cfgN() returns tuned
// values from the very first shot. We don't block boot on this — if the
// fetch fails, sounds fall back to hardcoded defaults inside Sound.ts.
loadSoundConfig();

const game = new Game(canvas);
(window as any).__game = game;
// Console hook: replay the most recently completed run without round-tripping
//   through the leaderboard. Useful for debugging replay determinism — record
//   a run, die, then call __replayLast() from devtools. Tracker-style sim-state
//   checkpoints assert automatically during any replay (no __replayDebug needed)
//   and log "[replay] checkpoint divergence at frame N" with the drifted fields.
(window as any).__replayLast = async () => {
  if (!game.lastRunReplay) { console.warn("no replay bytes yet — finish a run first"); return; }
  const { startReplay } = await import("./game/lifecycle");
  await startReplay(game, game.lastRunReplay);
};
// Inspect the live replay's accumulated checkpoint divergences (the precompute
//   sweep also stashes its own snapshot at window.__replayDivergences). Empty
//   array = no desync detected so far; null = no replay running.
(window as any).__divergences = () => game.replayPlayer?.divergences ?? null;
installBetaTest(game);
installInstructionsDemos();

let last = performance.now();
// Anchor the sim clock to the AudioContext hardware clock whenever audio is running, so beatTime
// (and the on-beat hum/bass scheduling that rides it) stays locked to the looping music instead
// of slowly drifting against it the way performance.now() does over a long run. Falls back to
// performance.now() before audio starts or while the context is suspended. lastAudio is the
// previous frame's audio-clock reading (null when audio wasn't running last frame).
let lastAudio: number | null = null;
// Rolling FPS — count frames over a window then publish; cheaper than smoothing per-frame dts.
const FPS_WINDOW_MS = 500;
let fpsWindowStart = last;
let fpsFrames = 0;
// ── TEMP perf probe (remove me) ──────────────────────────────────────────────
// Logs only on a slow frame (>20ms) so it's near-zero cost otherwise. Tells us,
// when a stutter hits: how long the frame took, which clock drove dt (audio vs
// perf.now), the raw audio-clock gap (to catch audio-context hitches that the
// sim-clock coupling turns into gameplay stutter), and what's actually on
// screen — so we can see whether anything from the suspected commit is present.
const SLOW_FRAME_MS = 20;
let probePrevNow = last;
// ─────────────────────────────────────────────────────────────────────────────
const tick = (now: number) => {
  const audioNow = game.sound.runningAudioTime();
  // 50ms clamp guards physics from a huge step after a stall/background, on either clock.
  const usedAudioClock = audioNow !== null && lastAudio !== null && audioNow > lastAudio;
  const dt = usedAudioClock
    ? Math.min(audioNow! - lastAudio!, 0.05)
    : Math.min((now - last) / 1000, 0.05);
  // TEMP perf probe: audio-clock gap this frame (NaN if audio not running yet).
  const audioGap = usedAudioClock ? audioNow! - lastAudio! : NaN;
  lastAudio = audioNow;
  last = now;
  const probeUpdateStart = performance.now();
  game.update(dt);
  const probeRenderStart = performance.now();
  game.render();
  // ── TEMP perf probe (remove me) ──
  const probeEnd = performance.now();
  const frameMs = probeEnd - probePrevNow;
  if (frameMs > SLOW_FRAME_MS) {
    console.log(
      `[lag] frame=${frameMs.toFixed(1)}ms ` +
      `update=${(probeRenderStart - probeUpdateStart).toFixed(1)} ` +
      `render=${(probeEnd - probeRenderStart).toFixed(1)} ` +
      `clock=${usedAudioClock ? "audio" : "perf"} audioGap=${(audioGap * 1000).toFixed(1)}ms | ` +
      `wave=${game.wave} ast=${game.asteroids.length} comet=${game.comets.length} ` +
      `alien=${game.aliens.length} bul=${game.bullets.length} shard=${game.shards.length}`,
    );
  }
  probePrevNow = probeEnd;
  // ─────────────────────────────────
  fpsFrames++;
  const windowElapsed = now - fpsWindowStart;
  if (windowElapsed >= FPS_WINDOW_MS) {
    const fps = (fpsFrames * 1000) / windowElapsed;
    game.debugFpsEl.textContent = `FPS ${fps.toFixed(0)}`;
    fpsWindowStart = now;
    fpsFrames = 0;
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
