import { Game } from "./Game";

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
if (!canvas) throw new Error("Canvas #stage not found");

const game = new Game(canvas);

let last = performance.now();
const tick = (now: number) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  game.update(dt);
  game.render();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
