import type { Game } from "../Game";
import { syncHud } from "./hud";

// Why: end-of-wave summary panel — staggers five rows in, then drains the
//   bonus into the score 50 points at a time. Non-blocking: the next wave
//   spawns immediately while this fades over the playfield.

const PANEL_ID = "wave-summary";
const TICK_AMOUNT = 50;
const TICK_TARGET_MS = 1400; // total duration the tickdown should target
const MIN_TICK_MS = 18;
const HOLD_AFTER_TICK_MS = 700;
const FADE_OUT_MS = 600;

type SummaryEls = {
  root: HTMLElement;
  rows: HTMLElement[];
  bonusValueEl: HTMLElement;
  scoreValueEl: HTMLElement;
};

let activeTimers: number[] = [];

const cancelActiveTimers = () => {
  for (const id of activeTimers) window.clearTimeout(id);
  activeTimers = [];
};

const buildPanel = (): SummaryEls => {
  let root = document.getElementById(PANEL_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = PANEL_ID;
    root.innerHTML = `
      <div class="ws-row ws-title"><span class="ws-label">Completed Wave</span> <span class="ws-value" data-row="wave"></span></div>
      <div class="ws-row"><span class="ws-label">Max Rhythm</span> <span class="ws-value" data-row="max"></span></div>
      <div class="ws-row"><span class="ws-label">Final Rhythm</span> <span class="ws-value" data-row="final"></span></div>
      <div class="ws-row ws-bonus"><span class="ws-label">Bonus</span> <span class="ws-value" data-row="bonus"></span></div>
      <div class="ws-row ws-score"><span class="ws-label">Score</span> <span class="ws-value" data-row="score"></span></div>
    `;
    document.body.appendChild(root);
  }
  const rows = Array.from(root.querySelectorAll<HTMLElement>(".ws-row"));
  return {
    root,
    rows,
    bonusValueEl: root.querySelector<HTMLElement>('[data-row="bonus"]')!,
    scoreValueEl: root.querySelector<HTMLElement>('[data-row="score"]')!,
  };
};

const setRow = (root: HTMLElement, key: string, text: string) => {
  const el = root.querySelector<HTMLElement>(`[data-row="${key}"]`);
  if (el) el.textContent = text;
};

// Why: bump the score row briefly each tick so the eye tracks the cascade,
//   without being so loud that it competes with gameplay below.
const pulseScore = (el: HTMLElement) => {
  el.classList.remove("ws-pulse");
  void el.offsetWidth;
  el.classList.add("ws-pulse");
};

export const showWaveSummary = (
  game: Game,
  completedWave: number,
  maxRhythm: number,
  finalRhythm: number,
) => {
  cancelActiveTimers();
  const bonus = (maxRhythm + finalRhythm) * 100;
  const { root, rows, bonusValueEl, scoreValueEl } = buildPanel();

  setRow(root, "wave", String(completedWave));
  setRow(root, "max", `x${maxRhythm}`);
  setRow(root, "final", `x${finalRhythm}`);
  setRow(root, "bonus", String(bonus));
  setRow(root, "score", String(game.score));

  // Reset visual state and force reflow so the entrance animation re-plays.
  root.classList.remove("show", "fade-out");
  for (const row of rows) row.classList.remove("in");
  void root.offsetWidth;
  root.classList.add("show");

  // Stagger each row in.
  rows.forEach((row, i) => {
    const id = window.setTimeout(() => row.classList.add("in"), 80 + i * 130);
    activeTimers.push(id);
  });

  // After the rows have all landed, drain the bonus into the score.
  const drainStartMs = 80 + rows.length * 130 + 250;
  const startDrain = window.setTimeout(() => {
    if (bonus <= 0) {
      scheduleFadeOut(root);
      return;
    }
    const ticks = Math.ceil(bonus / TICK_AMOUNT);
    const intervalMs = Math.max(MIN_TICK_MS, Math.floor(TICK_TARGET_MS / ticks));
    let remaining = bonus;
    let displayedScore = game.score;
    bonusValueEl.classList.add("ws-draining");

    const step = () => {
      const delta = Math.min(TICK_AMOUNT, remaining);
      remaining -= delta;
      displayedScore += delta;
      game.score += delta;
      bonusValueEl.textContent = String(remaining);
      scoreValueEl.textContent = String(displayedScore);
      pulseScore(scoreValueEl);
      // Keep the HUD score readout in sync as we drain, so the player can
      // see the total climb in the corner too.
      syncHud(game);
      if (remaining > 0) {
        const id = window.setTimeout(step, intervalMs);
        activeTimers.push(id);
      } else {
        bonusValueEl.classList.remove("ws-draining");
        scheduleFadeOut(root);
      }
    };
    step();
  }, drainStartMs);
  activeTimers.push(startDrain);
};

const scheduleFadeOut = (root: HTMLElement) => {
  const id = window.setTimeout(() => {
    root.classList.add("fade-out");
    const off = window.setTimeout(() => {
      root.classList.remove("show", "fade-out");
    }, FADE_OUT_MS);
    activeTimers.push(off);
  }, HOLD_AFTER_TICK_MS);
  activeTimers.push(id);
};

export const hideWaveSummary = () => {
  cancelActiveTimers();
  const root = document.getElementById(PANEL_ID);
  if (root) root.classList.remove("show", "fade-out");
};
