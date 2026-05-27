import { Game } from "./Game";
import { loadSoundConfig } from "./soundConfig";

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
if (!canvas) throw new Error("Canvas #stage not found");

// Pull /sounds/config.json before any audio fires so cfgN() returns tuned
// values from the very first shot. We don't block boot on this — if the
// fetch fails, sounds fall back to hardcoded defaults inside Sound.ts.
loadSoundConfig();

const game = new Game(canvas);

let last = performance.now();
const __startWall = performance.now();
const __dtLog: Array<{ rawMs: number; clampedMs: number; sinceStart: number }> = [];
const tick = (now: number) => {
  const rawDtMs = now - last;
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (__dtLog.length < 200) {
    __dtLog.push({ rawMs: +rawDtMs.toFixed(1), clampedMs: +(dt * 1000).toFixed(1), sinceStart: +(now - __startWall).toFixed(1) });
    if (__dtLog.length === 200) {
      console.log("DT_LOG", JSON.stringify(__dtLog));
    }
  }
  game.update(dt);
  game.render();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
