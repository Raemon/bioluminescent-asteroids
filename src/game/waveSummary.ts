import type { Game } from "../Game";
import { BEAT_GRID } from "./rhythmConstants";
import { formatScore } from "./formatScore";
import { cancelBeatCues, enqueueBeatCue } from "./beatCues";

// end-of-wave summary text — one row appears per beat with a paired
//   sound, then the bonus drains into the score at four ticks per beat with
//   a rhythmic melodic pattern (pentatonic loop + downbeat accent). After
//   the drain ends, the panel holds for 1 second then fades over 2 seconds.
//   Non-blocking: the next wave spawns immediately while this plays out
//   over the playfield, anchored to the center of the screen.
//
// The whole timeline is built by buildSummarySchedule as absolute beatTime
//   slots snapped to the beat grid, so the summary's beats land on the same
//   grid the bgBeat pulse and halo music play on. Sounds ride the beat-cue
//   scheduler (game/beatCues.ts, sample-accurate lookahead); DOM reveals sit
//   on absolute setTimeouts from one anchor — approximate is fine for text,
//   and nothing chains, so timer error never accumulates across the drain.

const PANEL_ID = "wave-summary";
const CUE_TAG = "waveSummary";

// Drain schedule: the bonus is paid out in chunks whose size doubles every
//   DRAIN_DOUBLE_EVERY chunks. Doubling matches TICKS_PER_CHIME, so each
//   chime rung arrives exactly when the payout-per-blip doubles. The chunk
//   count is rounded up to a multiple of 4 so the cascade always closes on a
//   beat boundary. The last chunk is shrunk so the total equals the bonus.
const DRAIN_BASE_CHUNK = 50;
const DRAIN_DOUBLE_EVERY = 16;
const DRAIN_CHUNK_GROUP = 4;
const chunkSizeAt = (i: number) =>
  DRAIN_BASE_CHUNK * Math.pow(2, Math.floor(i / DRAIN_DOUBLE_EVERY));
export const planDrainChunks = (total: number): number[] => {
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

const TICKS_PER_BEAT = 4;
const ROW_COUNT = 7;

// Resonant hum-chime, once per full drain chord cycle, climbing the
//   harmonic series over A3 — the root of the drain's i chord, so the
//   chimes sit inside the harmony while staying far above the low end.
//   The 5th/7th harmonics are skipped: their C#/G-flat color tones clash
//   with the Am-F-C-G progression underneath.
const TICKS_PER_CHIME = 16;
const DRAIN_CHIME_HARMONICS = [1, 2, 3, 4, 6, 8];

// per the spec — drain ends → hold 3 seconds → fade entire panel over
//   2 seconds. The CSS transition matches the fade duration.
const HOLD_BEFORE_FADE_MS = 3000;
const FADE_OUT_MS = 2000;

// The shared timeline for one transition, in absolute beatTime seconds. Both
//   halves consume it: the sim-clock driver (game/waveTransition.ts) pays the
//   score and fires the spawn on these slots, and showWaveSummary hangs its
//   cues and DOM timers on the same values — so panel, melody, and payout
//   can't drift apart, and everything sits on the global beat grid.
export type SummarySchedule = {
  chunks: number[];          // per-tick score payouts (planDrainChunks)
  rowBeats: number[];        // one reveal slot per summary row
  drainStartBeat: number;    // first drain tick
  drainTickBeats: number[];  // 16th-note grid, one per chunk
  chimeBeat: number;         // downbeat after the final 16th (cadence)
  spawnBeat: number;         // next-wave spawn, after hold + fade
};

export const buildSummarySchedule = (beatTimeNow: number, bonus: number): SummarySchedule => {
  const chunks = planDrainChunks(bonus);
  // Snap to the next beat boundary so every slot below lands on the grid the
  //   bgBeat pulse is scheduled against, instead of counting from whatever
  //   frame the last asteroid happened to die on.
  const startBeat = Math.ceil(beatTimeNow / BEAT_GRID) * BEAT_GRID;
  const rowBeats: number[] = [];
  // one-beat lead-in keeps the first row clear of the wave-clear chord.
  for (let i = 0; i < ROW_COUNT; i++) rowBeats.push(startBeat + (1 + i) * BEAT_GRID);
  // one clean beat after the last row before the numbers start moving.
  const drainStartBeat = startBeat + (2 + ROW_COUNT) * BEAT_GRID;
  const tick = BEAT_GRID / TICKS_PER_BEAT;
  const drainTickBeats = chunks.map((_, i) => drainStartBeat + i * tick);
  // Chunk count is a multiple of 4, so this is always a downbeat — the slot
  //   the phrase resolves on, one tick after the last blip.
  const chimeBeat = drainStartBeat + chunks.length * tick;
  const spawnBeat = chimeBeat + (HOLD_BEFORE_FADE_MS + FADE_OUT_MS) / 1000;
  return { chunks, rowBeats, drainStartBeat, drainTickBeats, chimeBeat, spawnBeat };
};

type SummaryEls = {
  root: HTMLElement;
  rows: HTMLElement[];
  bonusValueEl: HTMLElement;
  scoreValueEl: HTMLElement;
  extraLifeEl: HTMLElement;
  extraLifeValueEl: HTMLElement;
};

// The "Next ship" line fades in the instant the bonus finishes draining into
//   the score, then stays at full opacity. It carries no fade-out of its own —
//   nested inside the panel, it leaves with the rest of the summary when the
//   panel runs its 2s fade-out, so it remains until the summary is fully gone.

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
      <div class="ws-row ws-drift"><span class="ws-label">Longest Streak</span> <span class="ws-value" data-row="streak"></span></div>
      <div class="ws-row ws-bonus"><span class="ws-label">Bonus</span> <span class="ws-value" data-row="bonus"></span></div>
      <div class="ws-row ws-score"><span class="ws-label">Score</span> <span class="ws-value" data-row="score"></span></div>
      <div class="ws-row ws-extra-life" data-row="extra-life"><span class="ws-label">Next ship</span> <span class="ws-value" data-row="extra-life-value"></span></div>
    `;
    document.body.appendChild(root);
  }
  // The extra-life row is not part of the beat-stagger reveal — it stays
  //   hidden until revealExtraLife() fires after the drain completes, and
  //   keeping it out of `rows` keeps rows.length in sync with ROW_COUNT
  //   (the schedule builder's rowBeats length).
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>(".ws-row:not(.ws-extra-life)"),
  );
  return {
    root,
    rows,
    bonusValueEl: root.querySelector<HTMLElement>('[data-row="bonus"]')!,
    scoreValueEl: root.querySelector<HTMLElement>('[data-row="score"]')!,
    extraLifeEl: root.querySelector<HTMLElement>('[data-row="extra-life"]')!,
    extraLifeValueEl: root.querySelector<HTMLElement>('[data-row="extra-life-value"]')!,
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
const CHIME_F5 = 0.6674;    // F5+C6  (4th — passing tone into the 5th)
const CHIME_G5 = 0.7491;    // G5+D6  (5th)
const CHIME_C6 = 1.0;       // C6+G6  (baked)
const ROW_SOUNDS: Array<{ name: "chime" | "bell"; pitch: number }> = [
  { name: "bell",  pitch: C_BELL },
  { name: "chime", pitch: CHIME_C5 },
  { name: "chime", pitch: CHIME_D5 },
  { name: "chime", pitch: CHIME_E5 },
  { name: "chime", pitch: CHIME_F5 },
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

// The summary panel is purely cosmetic: the score drain and next-wave spawn
//   run on the sim clock (game/waveTransition.ts) against the same
//   SummarySchedule passed in here, and the panel *reads* game.score (drained
//   by the sim clock) so its numbers stay in lockstep with the real payout.
export const showWaveSummary = (
  game: Game,
  schedule: SummarySchedule,
  completedWave: number,
  maxRhythm: number,
  finalRhythm: number,
  bestStreak: number,
  driftBonuses: number,
) => {
  cancelActiveTimers();
  cancelBeatCues(game, CUE_TAG);
  const bonus = (maxRhythm + finalRhythm + driftBonuses + bestStreak) * 100;
  const { root, rows, bonusValueEl, scoreValueEl, extraLifeEl, extraLifeValueEl } = buildPanel();
  // Score the sim clock will drain the bonus on top of; the cosmetic numbers
  //   read game.score against this so the panel mirrors the real payout.
  const startScore = game.score;

  setRow(root, "wave", String(completedWave));
  setRow(root, "max", `x${maxRhythm}`);
  setRow(root, "final", `x${finalRhythm}`);
  // shown count includes the seed shot, so a 1-counted streak reads as 2.
  setRow(root, "streak", String(bestStreak > 0 ? bestStreak + 1 : 0));
  setRow(root, "drift", String(driftBonuses));
  setRow(root, "bonus", formatScore(bonus));
  setRow(root, "score", formatScore(game.score));

  // Reset visual state with transitions suppressed (ws-reset), so the rows
  //   snap to hidden instead of starting a visible 1→0 opacity transition
  //   the instant removing `fade-out` un-hides the panel. The reflow commits
  //   the snapped state before ws-reset comes off and transitions re-arm.
  root.classList.add("ws-reset");
  for (const row of rows) row.classList.remove("in");
  extraLifeEl.classList.remove("in");
  extraLifeValueEl.textContent = "";
  root.classList.remove("fade-out");
  void root.offsetWidth;
  root.classList.remove("ws-reset");

  // Reveal the next-bonus-life teaser the moment the drain finishes, so the
  //   threshold reads against the just-paid score and the line blooms in right
  //   as the bonus lands — then holds while the panel fades it out with the
  //   rest of the summary.
  const revealExtraLife = () => {
    extraLifeValueEl.textContent = formatScore(game.nextBonusLifeScore);
    extraLifeEl.classList.add("in");
  };

  // All DOM delays measured from the same beatTime the cue scheduler and sim
  //   driver compare against, converted at rate 1 — approximate under slow-mo,
  //   which is fine for text.
  const msUntil = (slotBeat: number) => Math.max(0, (slotBeat - game.beatTime) * 1000);

  // One row per beat; the paired sound rides the beat-cue scheduler so it
  //   lands on the grid sample-accurately while the reveal approximates.
  rows.forEach((row, i) => {
    const cue = ROW_SOUNDS[i];
    if (cue) enqueueBeatCue(game, { at: schedule.rowBeats[i], name: cue.name, pitch: cue.pitch, tag: CUE_TAG });
    const id = window.setTimeout(() => row.classList.add("in"), msUntil(schedule.rowBeats[i]));
    activeTimers.push(id);
  });

  if (schedule.chunks.length === 0) {
    const id = window.setTimeout(() => {
      revealExtraLife();
      scheduleFadeOut(root);
    }, msUntil(schedule.drainStartBeat));
    activeTimers.push(id);
    return;
  }

  // Drain melody, enqueued up front on the 16th grid. Every 4th tick is a
  //   downbeat — summaryDownbeat layers a rotating i-VI-III-VII chord over a
  //   soft kick, and the pitch passed selects which harmony lands; the drain
  //   melody's downbeat pitch is a chord tone of that voicing.
  schedule.drainTickBeats.forEach((at, i) => {
    enqueueBeatCue(game, { at, name: "scoreBlip", pitch: DRAIN_PITCHES[i % DRAIN_PITCHES.length], tag: CUE_TAG });
    if (i % TICKS_PER_BEAT === 0) {
      // Chime ticks duck the downbeat's chord pad (kick stays) so the
      //   chime's multi-second hum gets clear air while it blooms.
      const chimeTick = i % TICKS_PER_CHIME === 0;
      enqueueBeatCue(game, { at, name: chimeTick ? "summaryDownbeatDucked" : "summaryDownbeat", pitch: (i / TICKS_PER_BEAT) % 4, tag: CUE_TAG });
      if (chimeTick) {
        const idx = Math.min(i / TICKS_PER_CHIME, DRAIN_CHIME_HARMONICS.length - 1);
        enqueueBeatCue(game, { at, name: "drainChime", pitch: DRAIN_CHIME_HARMONICS[idx], tag: CUE_TAG });
      }
    }
  });
  // Cap the drain with the same C6+G6 chime the row sequence climbed to, on
  //   the downbeat after the final 16th — where the phrase resolves. Chime is
  //   harmonic (FM, C+G dyad) so it lands clean against the still-ringing
  //   G-major pad — root + fifth of C resolves to the game's tonal anchor.
  enqueueBeatCue(game, { at: schedule.chimeBeat, name: "chime", pitch: CHIME_C6, tag: CUE_TAG });
  // The next harmonic in the chime series arrives with the closing chime, so
  //   even a short drain (one mid-drain chime) hears the escalation land. A/E
  //   sit as 6th/3rd against the C+G dyad — consonant with the cadence.
  const chimeCount = Math.ceil(schedule.drainTickBeats.length / TICKS_PER_CHIME);
  const finaleIdx = Math.min(chimeCount, DRAIN_CHIME_HARMONICS.length - 1);
  enqueueBeatCue(game, { at: schedule.chimeBeat, name: "drainChime", pitch: DRAIN_CHIME_HARMONICS[finaleIdx], tag: CUE_TAG });

  // Panel numbers: one absolute timer per tick, each reading the sim-clock-
  //   drained score, so the display stays locked to the real payout even if
  //   a timer fires a frame off its slot.
  const drainVisualTick = () => {
    const drained = Math.max(0, game.score - startScore);
    const remaining = Math.max(0, bonus - drained);
    bonusValueEl.textContent = formatScore(remaining);
    scoreValueEl.textContent = formatScore(game.score);
    pulseScore(scoreValueEl);
  };
  const startId = window.setTimeout(() => bonusValueEl.classList.add("ws-draining"), msUntil(schedule.drainStartBeat));
  activeTimers.push(startId);
  for (const at of schedule.drainTickBeats) {
    const id = window.setTimeout(drainVisualTick, msUntil(at));
    activeTimers.push(id);
  }
  const completeId = window.setTimeout(() => {
    bonusValueEl.classList.remove("ws-draining");
    bonusValueEl.textContent = formatScore(Math.max(0, bonus - Math.max(0, game.score - startScore)));
    scoreValueEl.textContent = formatScore(game.score);
    revealExtraLife();
    scheduleFadeOut(root);
  }, msUntil(schedule.chimeBeat));
  activeTimers.push(completeId);
};

// Hold for HOLD_BEFORE_FADE_MS after the drain completes, then fade the
// entire panel (rows + score) over FADE_OUT_MS. The fade-out class stays on
// after the animation ends (forwards fill-mode) so the panel remains
// invisible — the next showWaveSummary call clears it as part of its reset.
// Purely cosmetic — the next-wave spawn is fired by the sim-clock driver.
const scheduleFadeOut = (root: HTMLElement) => {
  const fadeStart = window.setTimeout(() => {
    root.classList.add("fade-out");
  }, HOLD_BEFORE_FADE_MS);
  activeTimers.push(fadeStart);
};

export const hideWaveSummary = (game: Game) => {
  cancelActiveTimers();
  cancelBeatCues(game, CUE_TAG);
  const root = document.getElementById(PANEL_ID);
  if (root) {
    root.classList.add("ws-reset");
    root.classList.remove("fade-out");
    const rows = root.querySelectorAll<HTMLElement>(".ws-row");
    for (const row of rows) row.classList.remove("in");
    const extraLife = root.querySelector<HTMLElement>(".ws-extra-life");
    if (extraLife) extraLife.classList.remove("in");
    void root.offsetWidth;
    root.classList.remove("ws-reset");
  }
};
