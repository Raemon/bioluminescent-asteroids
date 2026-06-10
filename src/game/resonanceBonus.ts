import type { Game } from "../Game";
import type { Asteroid, AsteroidSize } from "../Asteroid";

// Per-piece resonance value by size. Large bassteroids are worth nothing (an
//   unbroken rock gives no bonus); the medium and small fragments a break leaves
//   behind are each worth a flat point bounty while they're still on the field.
export const RESONANCE_VALUE: Record<AsteroidSize, number> = {
  large: 0,
  medium: 10,
  small: 25,
};

// One bassteroid piece's standalone contribution — used both for the live-field
//   total and for the "+N" tag that follows each fresh fragment after a break.
export const resonanceValueOf = (a: Asteroid): number =>
  a.isBass() ? RESONANCE_VALUE[a.size] : 0;

// Resonance bonus: the summed value of every live bassteroid piece on the field.
//   Each piece contributes independently of the others, so destroying one medium
//   leaves its sibling still worth +10. Added to a kill's base score before the
//   Rhythm multiply (see awardScoreForKill), and applied to ALL on-beat kills, not
//   just bass kills — sweep the field while the broken pieces still ring.
export const resonanceBonus = (game: Game): number => {
  let bonus = 0;
  for (const a of game.asteroids) bonus += resonanceValueOf(a);
  return bonus;
};
