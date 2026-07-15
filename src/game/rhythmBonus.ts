import type { Game } from "../Game";
import { Vec } from "../vec";
import { comboGrid } from "./rhythmGate";
import { syncComboHud, syncHud, flashScoreGain } from "./hud";
import { checkBonusLife } from "./bonusLife";
import { popupCombo, popupRapidRhythm, popupStreakBonus, popupTwinShot } from "./popups";
import { resetStreak, STREAK_MAX_GAP } from "./streakBurst";

// Beat bonuses on top of the per-hit combo increment:
//   Rapid Rhythm — combo hits on two back-to-back beats pays +1 rhythm.
//   Twin Shot   — a second combo hit on the SAME beat (prong pair) pays +2.
// Bonus increments are queued with staggered fire times rather than applied
// inline, so the triggering hit's own xN popup renders before the bonus xN+1
// (and Twin Shot's xN+2 / xN+3 pop one after the other).
const BONUS_FLASH_STAGGER = 0.18;

const queueRhythmBonus = (game: Game, pos: Vec, order: number) => {
  game.pendingRhythmBonuses.push({
    fireAt: game.perceivedBeatTime + order * BONUS_FLASH_STAGGER,
    pos: { x: pos.x, y: pos.y - order * 14 },
  });
};

// The orbs always spin at 1 rev / 4 beats — the streak no longer locks a per-gap
//   interval, so the orbit speed is a single steady rate for every streak.
const STREAK_ORBIT_BEATS = 4;

const STREAK_BASE_POINTS = 25;
const STREAK_BASE_POINTS_LASER = 5;

// Every counted streak shot pays escalating points on the spot, flashed as a
//   small "Streak +N" tag the way the Bassteroid resonance bonuses are. Flat
//   score — no rhythm multiply.
const awardStreakShot = (game: Game, hitPos: Vec) => {
  if (game.streakShots > game.bestStreakThisWave) game.bestStreakThisWave = game.streakShots;
  const base = game.ship.lasershotActive ? STREAK_BASE_POINTS_LASER : STREAK_BASE_POINTS;
  const points = base * 2 ** (game.streakShots - 1);
  game.score += points;
  flashScoreGain(game, points);
  checkBonusLife(game);
  // not every streak shot is a kill (e.g. a bass chip), so sync the score
  //   readout here rather than relying on the kill path's syncHud.
  syncHud(game);
  game.popups.push(popupStreakBonus(hitPos, points));
};

// Begin a fresh streak from a single shot: a silent seed — no orb, nothing on
//   screen — waiting for a 2nd in-window shot to confirm the rhythm.
const startStreak = (game: Game, grid: number, beatCenter: number) => {
  game.streakInterval = STREAK_ORBIT_BEATS;
  game.streakGrid = grid;
  game.streakShots = 0;
  game.streakEstablished = false;
  game.streakLastBeatCenter = beatCenter;
};

// Rhythmic-consistency reward: keep landing combo-shots close together and a ring
//   of orbs grows around the reticule. Called once per new-beat combo shot
//   (same-beat prong pairs are filtered out by the caller). A shot extends the
//   streak as long as it lands within STREAK_MAX_GAP beats of the last one; the
//   gap no longer has to repeat a fixed interval. `grid`/`beatCenter` are the
//   caller's, so the gap is in grid units and stays meaningful under doubletime.
const trackStreak = (game: Game, grid: number, beatCenter: number, hitPos: Vec) => {
  // No streak in flight (or the ring already faded away): this shot seeds one.
  if (game.streakGrid <= 0) {
    startStreak(game, grid, beatCenter);
    return;
  }

  const gapBeats = Math.round((beatCenter - game.streakLastBeatCenter) / grid);
  const qualifies = gapBeats >= 1 && gapBeats <= STREAK_MAX_GAP && grid === game.streakGrid;

  // First confirmation: the 2nd in-window shot establishes the streak and mints
  //   the first orb. The seed shot itself never counts — only 2nd-and-onward
  //   shots are streak shots.
  if (qualifies && !game.streakEstablished) {
    game.streakEstablished = true;
    game.streakShots = 1;
    game.streakLastBeatCenter = beatCenter;
    game.sound.play("tink", 1, hitPos);
    awardStreakShot(game, hitPos);
    return;
  }

  // Established and this shot lands in the window: add an orb, refresh the ring.
  if (qualifies && game.streakEstablished) {
    game.streakShots += 1;
    game.streakLastBeatCenter = beatCenter;
    game.sound.play("tink", 1, hitPos);
    awardStreakShot(game, hitPos);
    return;
  }

  // Out of the window (or grid changed): drop the old streak — every shot
  //   already paid on landing — and this shot seeds a fresh one.
  resetStreak(game);
  startStreak(game, grid, beatCenter);
};

// called for every combo-incrementing on-beat hit (see applyHitToCombo).
export const trackRhythmComboHit = (game: Game, hitPos: Vec) => {
  const grid = comboGrid(game);
  const beatCenter = Math.round(game.perceivedBeatTime / grid) * grid;
  const prev = game.lastRhythmHitBeatCenter;
  const sameBeat = prev >= 0 && Math.abs(beatCenter - prev) < grid / 2;
  if (sameBeat) {
    game.rhythmHitsThisBeat += 1;
    // exactly the second hit on this beat — a third+ doesn't re-trigger.
    if (game.rhythmHitsThisBeat === 2 && game.lastRhythmHitPos) {
      const mid = {
        x: (game.lastRhythmHitPos.x + hitPos.x) / 2,
        y: (game.lastRhythmHitPos.y + hitPos.y) / 2,
      };
      game.popups.push(popupTwinShot(mid));
      queueRhythmBonus(game, hitPos, 1);
      queueRhythmBonus(game, hitPos, 2);
    }
  } else {
    const consecutiveBeat = prev >= 0 && Math.abs(beatCenter - prev - grid) < grid / 2;
    if (consecutiveBeat) {
      game.popups.push(popupRapidRhythm(hitPos));
      queueRhythmBonus(game, hitPos, 1);
    }
    game.lastRhythmHitBeatCenter = beatCenter;
    game.rhythmHitsThisBeat = 1;
    // streak only weighs new-beat shots — same-beat prong pairs neither extend
    //   nor break it (they resolve on this same beatCenter).
    trackStreak(game, grid, beatCenter, hitPos);
  }
  game.lastRhythmHitPos = { x: hitPos.x, y: hitPos.y };
};

const awardRhythmBonus = (game: Game, entry: Game["pendingRhythmBonuses"][number]) => {
  if (game.beatCombo === 0) return;
  game.beatCombo += 1;
  if (game.beatCombo > game.maxCombo) game.maxCombo = game.beatCombo;
  if (game.beatCombo > game.maxComboThisWave) game.maxComboThisWave = game.beatCombo;
  syncComboHud(game);
  game.sound.playComboChime(game.beatCombo, entry.pos);
  game.popups.push(popupCombo(entry.pos, game.beatCombo));
};

// mirrors tickPendingDriftBonuses: entries whose moment came pay +1 rhythm with
// its own chime + xN flash; dropped if the streak died in the meantime.
export const tickPendingRhythmBonuses = (game: Game) => {
  if (game.pendingRhythmBonuses.length === 0) return;
  const keep: typeof game.pendingRhythmBonuses = [];
  for (const entry of game.pendingRhythmBonuses) {
    if (game.perceivedBeatTime < entry.fireAt) { keep.push(entry); continue; }
    awardRhythmBonus(game, entry);
  }
  game.pendingRhythmBonuses = keep;
};

// Wave closed before a staged bonus's stagger arrived: pay it out immediately
//   so the wave-ending hit's bonus lands inside the summary snapshot.
export const flushPendingRhythmBonuses = (game: Game) => {
  for (const entry of game.pendingRhythmBonuses) awardRhythmBonus(game, entry);
  game.pendingRhythmBonuses = [];
};
