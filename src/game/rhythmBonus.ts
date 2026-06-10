import type { Game } from "../Game";
import { Vec } from "../vec";
import { comboGrid } from "./rhythmGate";
import { syncComboHud } from "./hud";
import { popupCombo, popupRapidRhythm, popupTwinShot } from "./popups";

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
