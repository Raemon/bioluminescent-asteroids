import type { Game } from "../Game";
import { syncHud } from "./hud";
import { BEAT_GRID } from "./rhythmConstants";

// end-of-wave summary text — one row appears per beat with a paired
//   sound, then the bonus drains into the score at four ticks per beat with
//   a rhythmic melodic pattern (pentatonic loop + downbeat accent). After
//   the drain ends, the panel holds for 1 second then fades over 2 seconds.
//   Non-blocking: the next wave spawns immediately while this plays out
//   over the playfield, anchored to the center of the screen.

const PANEL_ID = "wave-summary";
const TICK_AMOUNT = 100;

// BEAT_GRID is in seconds; everything in this file is in milliseconds.
const BEAT_MS = BEAT_GRID * 1000; // 500ms at 120 BPM
const TICKS_PER_BEAT = 4;
const TICK_MS = BEAT_MS / TICKS_PER_BEAT; // 125ms

// small lead-in before the first row so the entrance doesn't collide
//   with the wave-clear chord that fires the same frame.
const FIRST_ROW_DELAY_MS = BEAT_MS;

// short pause after the last row lands before the drain begins, so the
//   ear gets one clean beat to register the bonus number before it starts
//   moving.
const PAUSE_BEFORE_DRAIN_MS = BEAT_MS;

// per the spec — drain ends → hold 3 seconds → fade entire panel over
//   2 seconds. The CSS transition matches the fade duration.
const HOLD_BEFORE_FADE_MS = 3000;
const FADE_OUT_MS = 2000;

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
      <div class="ws-row ws-title">
        <span class="ws-completed">Completed</span>
        <span class="ws-wave"><span class="ws-wave-inner">Wave <span data-row="wave"></span></span></span>
      </div>
      <div class="ws-row ws-rhythm"><span class="ws-label">Max Rhythm</span> <span class="ws-value" data-row="max"></span></div>
      <div class="ws-row ws-rhythm"><span class="ws-label">Final Rhythm</span> <span class="ws-value" data-row="final"></span></div>
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

// bump the score row briefly each tick so the eye tracks the cascade,
//   without being so loud that it competes with gameplay below.
const pulseScore = (el: HTMLElement) => {
  el.classList.remove("ws-pulse");
  void el.offsetWidth;
  el.classList.add("ws-pulse");
};

// All row sounds use "bell" pitched to C4 (220 Hz * 1.189 ≈ 261.6 Hz) —
//   inharmonic temple bell on the game's C tonal anchor (same C the bass
//   field and halo pad sit on). Five tolling bells reads as haunting and
//   ceremonial without the chirpy-major-ascent of the previous chime+tink
//   ladder. The pitched bell also gets a softer peak (see playBell).
const C_BELL = 1.189;
const ROW_SOUNDS: Array<{ name: "chime" | "bell"; pitch: number }> = [
  { name: "bell", pitch: C_BELL },
  { name: "bell", pitch: C_BELL },
  { name: "bell", pitch: C_BELL },
  { name: "bell", pitch: C_BELL },
  { name: "bell", pitch: C_BELL },
];

// 16-step natural-minor melody for the drain. Downbeats (positions 0/4/8/12)
//   land on the chord roots of a rotating i — VI — III — VII progression
//   (A minor → F → C → G), which the summaryDownbeat chord voicing mirrors.
//   Between downbeats the line wanders through neighbor tones of the current
//   chord, with the contour drifting downward into the VI before climbing
//   back through III and VII — gives the drain a haunting circular feel
//   rather than a triumphant ascent.
const DRAIN_PITCHES = [
  1.0,    // A  (i root, downbeat)
  1.189,  // C  (b3)
  1.122,  // B  (2)
  1.0,    // A
  1.682,  // F  (VI root, downbeat — drops below for haunting lift)
  1.587,  // E
  1.498,  // Eb tritone color
  1.682,  // F
  1.189,  // C  (III root, downbeat)
  1.335,  // D
  1.498,  // Eb leading-tone tension
  1.682,  // F
  1.782,  // G  (VII root, downbeat)
  2.0,    // A  octave
  1.782,  // G
  1.682,  // F  (resolves into next phrase's drop to A)
];

export const showWaveSummary = (
  game: Game,
  completedWave: number,
  maxRhythm: number,
  finalRhythm: number,
  onFadeComplete?: () => void,
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
      scheduleFadeOut(root, onFadeComplete);
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

      // Play the next note in the haunting minor melody. Every 4th tick is
      //   a downbeat — summaryDownbeat layers a rotating i-VI-III-VII chord
      //   over a soft kick, and the chord index passed in selects which
      //   harmony lands. The drain melody's downbeat pitch is a chord tone
      //   of that voicing.
      const pitch = DRAIN_PITCHES[tickIndex % DRAIN_PITCHES.length];
      game.sound.play("scoreBlip", pitch);
      if (tickIndex % TICKS_PER_BEAT === 0) {
        const chordIndex = (tickIndex / TICKS_PER_BEAT) % 4;
        game.sound.play("summaryDownbeat", chordIndex);
      }
      tickIndex++;

      if (remaining > 0) {
        const id = window.setTimeout(step, TICK_MS);
        activeTimers.push(id);
      } else {
        bonusValueEl.classList.remove("ws-draining");
        // C-tuned bell caps the drain on the game's tonal anchor — closes
        //   the phrase on the same C the bass field is grounded in, so the
        //   silence reads as an earned ending rather than a bright sparkle.
        game.sound.play("bell", C_BELL);
        scheduleFadeOut(root, onFadeComplete);
      }
    };
    step();
  }, drainStartMs);
  activeTimers.push(startDrain);
};

// Hold for HOLD_BEFORE_FADE_MS after the drain completes, then fade the
// entire panel (rows + score) over FADE_OUT_MS. The fade-out class stays on
// after the animation ends (forwards fill-mode) so the panel remains
// invisible — the next showWaveSummary call clears it as part of its reset.
// onFadeComplete fires when the fade fully resolves, so callers can defer
// the next-wave spawn until the player has finished reading the summary.
const scheduleFadeOut = (root: HTMLElement, onFadeComplete?: () => void) => {
  const fadeStart = window.setTimeout(() => {
    root.classList.add("fade-out");
    if (onFadeComplete) {
      const done = window.setTimeout(onFadeComplete, FADE_OUT_MS);
      activeTimers.push(done);
    }
  }, HOLD_BEFORE_FADE_MS);
  activeTimers.push(fadeStart);
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
