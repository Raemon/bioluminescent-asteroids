import type { Game } from "../Game";
import { syncHud } from "./hud";
import { BEAT_GRID } from "./rhythmConstants";

// Why: end-of-wave summary text — one row appears per beat with a paired
//   sound, then the bonus drains into the score at four ticks per beat with
//   a rhythmic melodic pattern (pentatonic loop + downbeat accent). After
//   the drain ends, the panel holds for 1 second then fades over 2 seconds.
//   Non-blocking: the next wave spawns immediately while this plays out
//   over the playfield, anchored to the opposite quadrant from where the
//   ship is heading so it doesn't sit under the player's hull.

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

// Why: per the spec — drain ends → hold 1 second → fade entire panel over
//   2 seconds. The CSS transition matches the fade duration.
const HOLD_BEFORE_FADE_MS = 1000;
const FADE_OUT_MS = 2000;

// Why: predict where the ship will be in 1.5s and mirror that point around
//   the screen center, so the summary lands in the opposite quadrant from
//   where the player is heading.
const POSITION_LOOKAHEAD_S = 1.5;

// Why: keep the panel comfortably inside the viewport even when the ship is
//   tucked into a corner. Roughly half the panel's footprint at typical
//   widths/heights — overshoot is fine, it just clamps tighter.
const EDGE_MARGIN_X = 180;
const EDGE_MARGIN_Y = 140;

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

// Why: anchor the panel at the radial mirror of the ship's predicted
//   position. Predict 1.5s ahead so a fast-moving ship still has the panel
//   land out of their path. Clamp inside the viewport so corner-skirting
//   doesn't push the panel off-screen.
const positionPanel = (game: Game, root: HTMLElement) => {
  const futureX = game.ship.pos.x + game.ship.vel.x * POSITION_LOOKAHEAD_S;
  const futureY = game.ship.pos.y + game.ship.vel.y * POSITION_LOOKAHEAD_S;
  const mirrorX = game.w - futureX;
  const mirrorY = game.h - futureY;
  const left = Math.max(EDGE_MARGIN_X, Math.min(game.w - EDGE_MARGIN_X, mirrorX));
  const top = Math.max(EDGE_MARGIN_Y, Math.min(game.h - EDGE_MARGIN_Y, mirrorY));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
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

// Why: pentatonic loop for the drain. Pentatonic stays consonant against
//   any backing chord so the bonus-drain melody doesn't fight whatever
//   combo halo is currently playing. Cycling a five-note pattern over a
//   four-tick beat grid means the downbeat lands on a different scale
//   degree each beat, which is what gives the drain its "tune" instead of
//   "loop" character.
const DRAIN_PITCHES = [1.0, 1.122, 1.26, 1.498, 1.682];

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

  positionPanel(game, root);

  // Reset visual state and force reflow so the entrance animation re-plays.
  root.classList.remove("fade-out");
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
    let tickIndex = 0;
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

      // Why: cycle through a pentatonic pattern for the drain blips. Every
      //   4th tick is a downbeat — accent it with a soft "tink" on top of
      //   the blip so the ear hears a clear pulse instead of an undifferentiated
      //   stream. The blip itself is quiet by design; the tink gives the
      //   downbeat a glassy lift without overwhelming gameplay.
      const pitch = DRAIN_PITCHES[tickIndex % DRAIN_PITCHES.length];
      game.sound.play("scoreBlip", pitch);
      if (tickIndex % TICKS_PER_BEAT === 0) {
        game.sound.play("tink", pitch * 2); // octave up for sparkle
      }
      tickIndex++;

      if (remaining > 0) {
        const id = window.setTimeout(step, TICK_MS);
        activeTimers.push(id);
      } else {
        bonusValueEl.classList.remove("ws-draining");
        // Why: a soft chime caps the drain — closes the musical phrase so
        //   the silence that follows reads as an ending, not a dropout.
        game.sound.play("chime", 1.26);
        scheduleFadeOut(root);
      }
    };
    step();
  }, drainStartMs);
  activeTimers.push(startDrain);
};

// Hold for 1 second after the drain completes, then fade the entire panel
// (rows + score) over 2 seconds.
const scheduleFadeOut = (root: HTMLElement) => {
  const id = window.setTimeout(() => {
    root.classList.add("fade-out");
    const off = window.setTimeout(() => {
      root.classList.remove("fade-out");
    }, FADE_OUT_MS);
    activeTimers.push(off);
  }, HOLD_BEFORE_FADE_MS);
  activeTimers.push(id);
};

export const hideWaveSummary = () => {
  cancelActiveTimers();
  const root = document.getElementById(PANEL_ID);
  if (root) {
    root.classList.remove("fade-out");
    const rows = root.querySelectorAll<HTMLElement>(".ws-row");
    for (const row of rows) row.classList.remove("in");
  }
};
