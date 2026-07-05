import type { Game } from "../Game";
import { Vec } from "../vec";
import { comboGrid } from "./rhythmGate";
import { syncComboHud } from "./hud";
import { popupCombo, popupRapidRhythm, popupTwinShot } from "./popups";
import { endStreak, STREAK_MAX_GAP } from "./streakBurst";

// A streak shot at this ordinal (or beyond) also pays a bonus rhythm — queued as
//   a staggered xN flash after the shot's own combo popup, like a drift bonus.
const STREAK_BONUS_FROM = 3;

// Streak bonuses on top of the per-hit combo increment:
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

// Begin a fresh streak from a single shot: one orb, steady 4-beat spin, not yet
//   established (so it doesn't count toward the metric until a 2nd shot confirms).
const startStreak = (game: Game, grid: number, beatCenter: number) => {
  game.streakInterval = STREAK_ORBIT_BEATS;
  game.streakGrid = grid;
  game.streakShots = 1;
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
  if (game.streakShots < 1) {
    startStreak(game, grid, beatCenter);
    return;
  }

  const gapBeats = Math.round((beatCenter - game.streakLastBeatCenter) / grid);
  const qualifies = gapBeats >= 1 && gapBeats <= STREAK_MAX_GAP && grid === game.streakGrid;

  // First confirmation: the 2nd in-window shot establishes the streak — both shots
  //   now count toward the metric.
  if (qualifies && !game.streakEstablished) {
    game.streakEstablished = true;
    game.streakShots = 2;
    game.streakLastBeatCenter = beatCenter;
    game.streakShotsThisWave += 2;
    game.sound.play("tink", 1, hitPos);
    return;
  }

  // Established and this shot lands in the window: add an orb, refresh the ring.
  if (qualifies && game.streakEstablished) {
    game.streakShots += 1;
    game.streakLastBeatCenter = beatCenter;
    game.streakShotsThisWave += 1;
    game.sound.play("tink", 1, hitPos);
    // 3rd orb onward also pays a bonus rhythm, flashed after the shot's own xN
    //   (same staggered UI as a drift bonus).
    if (game.streakShots >= STREAK_BONUS_FROM) queueRhythmBonus(game, hitPos, 1);
    return;
  }

  // Out of the window (or grid changed): flare the old streak (if established),
  //   then this shot seeds a fresh one.
  endStreak(game);
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

// mirrors tickPendingDriftBonuses: entries whose moment came pay +1 rhythm with
// its own chime + xN flash; dropped if the streak died in the meantime.
export const tickPendingRhythmBonuses = (game: Game) => {
  if (game.pendingRhythmBonuses.length === 0) return;
  const keep: typeof game.pendingRhythmBonuses = [];
  for (const entry of game.pendingRhythmBonuses) {
    if (game.perceivedBeatTime < entry.fireAt) { keep.push(entry); continue; }
    if (game.beatCombo === 0) continue;
    game.beatCombo += 1;
    if (game.beatCombo > game.maxCombo) game.maxCombo = game.beatCombo;
    if (game.beatCombo > game.maxComboThisWave) game.maxComboThisWave = game.beatCombo;
    syncComboHud(game);
    game.sound.playComboChime(game.beatCombo, entry.pos);
    game.popups.push(popupCombo(entry.pos, game.beatCombo));
  }
  game.pendingRhythmBonuses = keep;
};
