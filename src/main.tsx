import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./style.css";

import { Game } from "./Game";
import { loadSoundConfig } from "./soundConfig";
import { installBetaTest } from "./game/betaTest";
import { installTutorialDemos } from "./tutorial";

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
installBetaTest(game);
installTutorialDemos();

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
