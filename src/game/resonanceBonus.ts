import type { Game } from "../Game";

// Resonance bonus: each bassteroid voice currently shattered into multiple pieces
//   adds (pieces − 1) to the on-beat multiplier. A whole, unbroken bassteroid
//   contributes 0 (one piece); breaking it into 2 → +1, into 4 → +3. The four
//   voices (bassA–D) are independent lineages, so each only counts its own pieces.
//   The bonus stacks additively onto the Rhythm combo (see awardScoreForKill) and
//   applies to ALL on-beat kills, not just bass kills — sweep the field while the
//   broken pieces still ring.
export const resonanceBonus = (game: Game): number => {
  const perVoice: Record<string, number> = {};
  for (const a of game.asteroids) {
    if (a.isBass()) perVoice[a.kind] = (perVoice[a.kind] ?? 0) + 1;
  }
  let bonus = 0;
  for (const kind in perVoice) bonus += Math.max(0, perVoice[kind] - 1);
  return bonus;
};
