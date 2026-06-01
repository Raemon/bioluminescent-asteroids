import type { Game } from "../Game";

// Staged reveal for the game-over / mission-aborted screen. Three lines
//   fade in left-of-the-parade in sequence:
//     1. "you reached Wave N"             — small caps subtitle, instant
//     2. "Peak Rhythm  Nx"                — big splashy headline + bell, ~1s in
//     3. "score: N"                       — small caps subtitle
//   Timers are tracked so a quick game-over → restart → game-over cycle
//   doesn't leave a half-finished animation re-firing on top of the new run.
const PEAK_DELAY_MS = 700;
const PEAK_FADE_MS = 1000;
const PEAK_HOLD_MS = 1100;

const C_BELL = 1.189;

let activeTimers: number[] = [];
let activeRoot: HTMLElement | null = null;

const cancelTimers = () => {
  for (const id of activeTimers) window.clearTimeout(id);
  activeTimers = [];
};

const setLine = (id: string, text: string) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

const resetVisibility = (root: HTMLElement) => {
  root.querySelectorAll<HTMLElement>(".go-line").forEach((el) => {
    el.classList.remove("in", "splash");
  });
};

export const showGameOverIntro = (game: Game, headlineKind: "gameover" | "aborted") => {
  cancelTimers();
  const root = document.getElementById("gameover-stack");
  if (!root) return;
  activeRoot = root;
  root.classList.remove("hidden");

  const waveLine = headlineKind === "aborted"
    ? `Mission aborted — Wave ${game.wave}`
    : `You reached Wave ${game.wave}`;
  setLine("gameover-wave", waveLine);
  setLine("gameover-peak-value", `${game.maxCombo}x`);
  setLine("gameover-score", `Score: ${String(game.score).padStart(6, "0")}`);

  resetVisibility(root);
  // force reflow so the .in transitions actually animate on restart.
  void root.offsetWidth;

  const wave = root.querySelector<HTMLElement>("#gameover-wave");
  const peak = root.querySelector<HTMLElement>("#gameover-peak");
  const score = root.querySelector<HTMLElement>("#gameover-score");

  if (wave) wave.classList.add("in");

  activeTimers.push(window.setTimeout(() => {
    if (peak) {
      peak.classList.add("in", "splash");
      game.sound.play("bell", C_BELL);
    }
  }, PEAK_DELAY_MS));

  activeTimers.push(window.setTimeout(() => {
    if (score) score.classList.add("in");
  }, PEAK_DELAY_MS + PEAK_FADE_MS + PEAK_HOLD_MS));
};

export const hideGameOverIntro = () => {
  cancelTimers();
  const root = activeRoot ?? document.getElementById("gameover-stack");
  if (root) {
    root.classList.add("hidden");
    resetVisibility(root);
  }
  activeRoot = null;
};
