import type { Game } from "../Game";
import { syncHud } from "./hud";
import { BEAT_GRID } from "./rhythmConstants";

// Why: end-of-wave summary text — one row appears per beat with a paired
//   sound, then the bonus drains into the score at four ticks per beat (also
//   with a sound per tick). After the drain ends, the final score holds for
//   2 beats while the rest of the text fades over those same 2 beats, then
//   the score itself fades over 1 beat. Non-blocking: the next wave spawns
//   immediately while this plays out over the playfield.

const PANEL_ID = "wave-summary";
const TICK_AMOUNT = 50;

// Why: BEAT_GRID is in seconds; everything in this file is in milliseconds.
const BEAT_MS = BEAT_GRID * 1000; // 500ms at 120 BPM
const TICKS_PER_BEAT = 4;
const TICK_MS = BEAT_MS / TICKS_PER_BEAT; // 125ms

// Why: small lead-in before the first row so the entrance doesn't collide
//   with the wave-clear chord that fires the same frame.
const FIRST_ROW_DELAY_MS = BEAT_MS;

// Why: short pause after the last row lands before the drain begins, so the
//   ear gets one clean beat to register the bonus number before it starts
//   moving.
const PAUSE_BEFORE_DRAIN_MS = BEAT_MS;

// Why: per the spec — drain ends → hold 2 beats while rest fades → score
//   fades over 1 beat. The CSS transitions match these durations.
const HOLD_AND_REST_FADE_MS = BEAT_MS * 2;
const SCORE_FADE_MS = BEAT_MS;

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

// Why: the title row gets the "chime" — it's the loudest, longest-tailed of
//   the row sounds, marking the start of the report. The four data rows use
//   "tink" with a slow upward pitch climb so the ear hears each line land
//   one step higher, like a ledger being filled in.
const ROW_SOUNDS: Array<{ name: "chime" | "tink"; pitch: number }> = [
  { name: "chime", pitch: 1 },
  { name: "tink", pitch: 1.0 },
  { name: "tink", pitch: 1.122 }, // ~whole step up
  { name: "tink", pitch: 1.26 },  // ~major third up
  { name: "tink", pitch: 1.498 }, // ~perfect fifth up
];

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
  root.classList.remove("fade-rest", "fade-score");
  for (const row of rows) row.classList.remove("in");
  void root.offsetWidth;

  // One row per beat, each with a paired sound.
  rows.forEach((row, i) => {
    const delay = FIRST_ROW_DELAY_MS + i * BEAT_MS;
    const id = window.setTimeout(() => {
      row.classList.add("in");
      const cue = ROW_SOUNDS[i];
      if (cue) game.sound.play(cue.name, cue.pitch);
    }, delay);
    activeTimers.push(id);
  });

  // After the rows have all landed, drain the bonus into the score.
  const drainStartMs = FIRST_ROW_DELAY_MS + rows.length * BEAT_MS + PAUSE_BEFORE_DRAIN_MS;
  const startDrain = window.setTimeout(() => {
    if (bonus <= 0) {
      scheduleFadeOut(root);
      return;
    }
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
      syncHud(game);

      // Why: tick pitch walks up slightly across the drain so a long bonus
      //   run feels like it's climbing instead of repeating a single note.
      //   Capped so very large bonuses don't shriek.
      const climb = Math.min(0.6, (bonus - remaining) / Math.max(bonus, 1) * 0.5);
      game.sound.play("scoreBlip", 1 + climb);

      if (remaining > 0) {
        const id = window.setTimeout(step, TICK_MS);
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

// Two-phase fade-out:
//   1) Final score holds in place for 2 beats while every other row fades
//      out over those same 2 beats.
//   2) The score row then fades over 1 beat.
const scheduleFadeOut = (root: HTMLElement) => {
  root.classList.add("fade-rest");
  const id = window.setTimeout(() => {
    root.classList.add("fade-score");
    const off = window.setTimeout(() => {
      root.classList.remove("fade-rest", "fade-score");
    }, SCORE_FADE_MS);
    activeTimers.push(off);
  }, HOLD_AND_REST_FADE_MS);
  activeTimers.push(id);
};

export const hideWaveSummary = () => {
  cancelActiveTimers();
  const root = document.getElementById(PANEL_ID);
  if (root) {
    root.classList.remove("fade-rest", "fade-score");
    const rows = root.querySelectorAll<HTMLElement>(".ws-row");
    for (const row of rows) row.classList.remove("in");
  }
};
