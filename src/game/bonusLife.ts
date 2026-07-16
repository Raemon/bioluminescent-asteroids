import type { Game } from "../Game";
import { popupBonusLife } from "./popups";
import { syncHud } from "./hud";

export const FIRST_BONUS_LIFE_SCORE = 50000;

// Bonus-life screen wash decays to zero over this many seconds — a soft medium
// bloom, slower than the laser fire flash so the milestone lingers a moment.
export const BONUS_LIFE_FLASH_DECAY = 0.6;

// Awards a free life at FIRST_BONUS_LIFE_SCORE points; each threshold after
//   that costs double the last. Loops in case a single score gain crosses
//   more than one threshold (e.g. a fat on-beat multiplier).
//   The milestone lands as a rite: a swelling major-key comet choir, the whole
//   hull flashing bright white, and a medium white wash across the screen.
export const checkBonusLife = (game: Game) => {
  while (game.score >= game.nextBonusLifeScore) {
    game.lives += 1;
    game.nextBonusLifeScore *= 2;
    game.sound.play("bonusLife");
    game.ship.bonusLifeFlash = 1;
    game.bonusLifeFlash = 1;
    game.popups.push(popupBonusLife(game.ship.pos));
    syncHud(game);
  }
};

// Full-screen additive white wash for the bonus-life milestone — medium
// brightness so it reads as a celebratory bloom, not a blinding cut. Painted in
// screen space above the entity layers, alongside the laser ambient flash. The
// ship is always screen-locked dead-centre, so a radial gradient anchored there
// reads as the flash bursting outward from the ship rather than the whole
// screen popping at once.
export const renderBonusLifeFlash = (ctx: CanvasRenderingContext2D, game: Game) => {
  const a = game.bonusLifeFlash * 0.45;
  if (a <= 0.001) return;
  const cx = game.w / 2;
  const cy = game.h / 2;
  const radius = Math.hypot(game.w, game.h) / 2;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, `rgba(255, 255, 255, ${a.toFixed(3)})`);
  gradient.addColorStop(1, `rgba(255, 255, 255, 0)`);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, game.w, game.h);
  ctx.restore();
};
