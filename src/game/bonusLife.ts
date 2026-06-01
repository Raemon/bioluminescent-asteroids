import type { Game } from "../Game";
import { popupBonusLife } from "./popups";
import { syncHud } from "./hud";

export const BONUS_LIFE_INTERVAL = 50000;

// Awards a free life every BONUS_LIFE_INTERVAL points. Loops in case a single
//   score gain crosses more than one threshold (e.g. a fat on-beat multiplier).
//   The C-major powerup arpeggio is the same "got something good" jingle the
//   canister pickups use, so the milestone reads as a real reward.
export const checkBonusLife = (game: Game) => {
  while (game.score >= game.nextBonusLifeScore) {
    game.lives += 1;
    game.nextBonusLifeScore += BONUS_LIFE_INTERVAL;
    game.sound.play("powerup");
    game.popups.push(popupBonusLife(game.ship.pos));
    syncHud(game);
  }
};
