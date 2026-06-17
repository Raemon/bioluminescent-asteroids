import type { Game } from "../Game";
import { syncHud } from "./hud";
import { BEAT_GRID } from "./rhythmConstants";
import { checkBonusLife } from "./bonusLife";
import { formatScore } from "./formatScore";

// end-of-wave summary text — one row appears per beat with a paired
//   sound, then the bonus drains into the score at four ticks per beat with
//   a rhythmic melodic pattern (pentatonic loop + downbeat accent). After
//   the drain ends, the panel holds for 1 second then fades over 2 seconds.
//   Non-blocking: the next wave spawns immediately while this plays out
//   over the playfield, anchored to the center of the screen.

const PANEL_ID = "wave-summary";

// Drain schedule: the bonus is paid out in chunks that start at 50/each and
//   double every 8 chunks (50, 50, ..., 100, 100, ..., 200, ...). The chunk
//   count is rounded up to a multiple of 4 so the cascade always closes on a
//   beat boundary. The last chunk is shrunk so the total equals the bonus.
const DRAIN_BASE_CHUNK = 50;
const DRAIN_DOUBLE_EVERY = 8;
const DRAIN_CHUNK_GROUP = 4;
const chunkSizeAt = (i: number) =>
  DRAIN_BASE_CHUNK * Math.pow(2, Math.floor(i / DRAIN_DOUBLE_EVERY));
const planDrainChunks = (total: number): number[] => {
  if (total <= 0) return [];
  const chunks: number[] = [];
  let acc = 0;
  let i = 0;
  while (acc < total) {
    const size = chunkSizeAt(i);
    chunks.push(size);
    acc += size;
    i++;
  }
  // Round count up to a multiple of DRAIN_CHUNK_GROUP by extending the
  //   schedule (the padding chunks will be trimmed to 0 below).
  while (chunks.length % DRAIN_CHUNK_GROUP !== 0) {
    chunks.push(chunkSizeAt(chunks.length));
    acc += chunks[chunks.length - 1];
  }
  // Trim from the tail so the chunks sum to exactly `total`.
  let overflow = acc - total;
  for (let j = chunks.length - 1; j >= 0 && overflow > 0; j--) {
    const take = Math.min(overflow, chunks[j]);
    chunks[j] -= take;
    overflow -= take;
  }
  return chunks;
};

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
      <div class="ws-row ws-drift"><span class="ws-label">Drift Shot</span> <span class="ws-value" data-row="drift"></span></div>
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

// Opening bell on C4 (220 * 1.189 ≈ 261.6 Hz) anchors the sequence to the
//   game's C — same C the bass field and halo pad sit on. The remaining
//   rows climb a C-major pentatonic ladder (C5, D5, E5, G5, C6) so the
//   sequence resolves cleanly back to the C anchor rather than tolling the
//   same bell six times. Chime is baked at C6+G6 (pitchRatio 1.0); the
//   lower entries playback-rate-shift the same buffer.
const C_BELL = 1.189;
const CHIME_C5 = 0.5;       // C5+G5
const CHIME_D5 = 0.5612;    // D5+A5  (9th — passing tone)
const CHIME_E5 = 0.6299;    // E5+B5  (major 3rd of C)
const CHIME_G5 = 0.7491;    // G5+D6  (5th)
const CHIME_C6 = 1.0;       // C6+G6  (baked)
const ROW_SOUNDS: Array<{ name: "chime" | "bell"; pitch: number }> = [
  { name: "bell",  pitch: C_BELL },
  { name: "chime", pitch: CHIME_C5 },
  { name: "chime", pitch: CHIME_D5 },
  { name: "chime", pitch: CHIME_E5 },
  { name: "chime", pitch: CHIME_G5 },
  { name: "chime", pitch: CHIME_C6 },
];

// 16-step haunting line for the drain. Downbeats (positions 0/4/8/12) land
//   on chord roots of the rotating i — VI — III — VII progression (A minor →
//   F → C → G) so the melody interlocks with the summaryDownbeat chord pad.
//   Between downbeats the line drifts through tritones, suspended fourths,
//   and unresolved seconds — every off-beat is a color tone, not a chord
//   tone, so the line never sits comfortably. The overall contour falls and
//   circles back rather than climbing to an octave-up resolution, so the
//   phrase reads as haunted/searching rather than chipper.
const DRAIN_PITCHES = [
  1.0,    // A   (i root, downbeat)
  1.498,  // Eb  (b5 tritone — eerie immediately after the root)
  1.335,  // D   (sus4 — suspended, doesn't resolve)
  1.189,  // C   (b3, lands soft into next downbeat)
  1.682,  // F   (VI root, downbeat — lift up to the new chord)
  1.587,  // E   (maj7 of F — half-step rub against the chord root)
  1.498,  // Eb  (tritone-of-A held over — drags the harmony backward)
  1.335,  // D   (suspended into III)
  1.189,  // C   (III root, downbeat — lands on the C anchor of the game)
  1.122,  // B   (maj7 of C — bell-like rub, refuses to resolve cleanly)
  1.0,    // A   (6th of C — drops below the tonic for unease)
  1.122,  // B   (suspended into VII)
  1.189,  // C   (chord pad plays G here; melody holds C as sus4 over it —
  //   an unresolved tension exactly when the ear wants the cadence)
  1.335,  // D   (5th of G chord — finally a chord tone, brief stability)
  1.122,  // B   (3rd of G — descending toward tonic)
  1.0,    // A   (9th of G — leans back into the next loop's downbeat)
];

export const showWaveSummary = (
  game: Game,
  completedWave: number,
  maxRhythm: number,
  finalRhythm: number,
  driftBonuses: number,
  onFadeComplete?: () => void,
) => {
  cancelActiveTimers();
  const bonus = (maxRhythm + finalRhythm + driftBonuses) * 100;
  const { root, rows, bonusValueEl, scoreValueEl } = buildPanel();

  setRow(root, "wave", String(completedWave));
  setRow(root, "max", `x${maxRhythm}`);
  setRow(root, "final", `x${finalRhythm}`);
  setRow(root, "drift", String(driftBonuses));
  setRow(root, "bonus", formatScore(bonus));
  setRow(root, "score", formatScore(game.score));

  // Reset visual state. Order matters: strip `in` from every row *before*
  //   removing `fade-out`, and reflow in between. Otherwise removing
  //   `fade-out` first un-hides the panel for a frame while the previous
  //   wave's rows still carry `in` (a flash of all data) and then their
  //   opacity transitions out — instead of the rows being at 0 the instant
  //   the panel reappears, ready for the staggered entrance.
  for (const row of rows) row.classList.remove("in");
  void root.offsetWidth;
  root.classList.remove("fade-out");
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
    const chunks = planDrainChunks(bonus);
    let remaining = bonus;
    let displayedScore = game.score;
    let tickIndex = 0;
    bonusValueEl.classList.add("ws-draining");

    const step = () => {
      const delta = chunks[tickIndex] ?? 0;
      remaining -= delta;
      displayedScore += delta;
      game.score += delta;
      bonusValueEl.textContent = formatScore(remaining);
      scoreValueEl.textContent = formatScore(displayedScore);
      pulseScore(scoreValueEl);
      syncHud(game);
      checkBonusLife(game);

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

      if (tickIndex < chunks.length) {
        const id = window.setTimeout(step, TICK_MS);
        activeTimers.push(id);
      } else {
        bonusValueEl.classList.remove("ws-draining");
        // Cap the drain with the same C6+G6 chime the row sequence climbed
        //   to. Chime is harmonic (FM, C+G dyad) so it lands clean against
        //   the still-ringing G-major pad — root + fifth of C resolves the
        //   phrase to the game's tonal anchor instead of clanging.
        game.sound.play("chime", CHIME_C6);
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
