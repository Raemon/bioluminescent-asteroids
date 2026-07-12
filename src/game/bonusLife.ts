import type { Game } from "../Game";
import { popupBonusLife } from "./popups";
import { syncHud } from "./hud";

export const FIRST_BONUS_LIFE_SCORE = 50000;

// Awards a free life at FIRST_BONUS_LIFE_SCORE points; each threshold after
//   that costs double the last. Loops in case a single score gain crosses
//   more than one threshold (e.g. a fat on-beat multiplier).
//   The C-major powerup arpeggio is the same "got something good" jingle the
//   canister pickups use, so the milestone reads as a real reward.
export const checkBonusLife = (game: Game) => {
  while (game.score >= game.nextBonusLifeScore) {
    game.lives += 1;
    game.nextBonusLifeScore *= 2;
    game.sound.play("powerup");
    game.popups.push(popupBonusLife(game.ship.pos));
    syncHud(game);
  }
};
