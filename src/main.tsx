import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./style.css";

import { Game } from "./Game";
import { loadSoundConfig } from "./soundConfig";
import { installBetaTest } from "./game/betaTest";
import { installInstructionsDemos } from "./instructions";

// Globally disable canvas shadowBlur — it's one of the most expensive 2D-canvas
// operations and was hurting FPS across the game. Swallow writes on the prototype
// so every existing `ctx.shadowBlur = N` site becomes a no-op without code changes.
(() => {
  const proto = (CanvasRenderingContext2D.prototype as unknown) as Record<string, unknown>;
  Object.defineProperty(proto, "shadowBlur", {
    get() { return 0; },
    set() { /* swallow */ },
    configurable: true,
  });
})();

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
//   a run, die, then call __replayLast() from devtools.
(window as any).__replayLast = async () => {
  if (!game.lastRunReplay) { console.warn("no replay bytes yet — finish a run first"); return; }
  const { startReplay } = await import("./game/lifecycle");
  await startReplay(game, game.lastRunReplay);
};
installBetaTest(game);
installInstructionsDemos();

let last = performance.now();
// Rolling FPS — count frames over a window then publish; cheaper than smoothing per-frame dts.
const FPS_WINDOW_MS = 500;
let fpsWindowStart = last;
let fpsFrames = 0;
const tick = (now: number) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  game.update(dt);
  game.render();
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
