import { Game } from "./Game";
import { loadSoundConfig } from "./soundConfig";
import { installBetaTest } from "./game/betaTest";

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
if (!canvas) throw new Error("Canvas #stage not found");

// Pull /sounds/config.json before any audio fires so cfgN() returns tuned
// values from the very first shot. We don't block boot on this — if the
// fetch fails, sounds fall back to hardcoded defaults inside Sound.ts.
loadSoundConfig();

const game = new Game(canvas);
(window as any).__game = game;
installBetaTest(game);

let last = performance.now();
const tick = (now: number) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  game.update(dt);
  game.render();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
