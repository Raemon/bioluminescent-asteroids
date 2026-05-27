import { Vec, dist } from "../vec";

// Why: one retry loop replaces four near-identical "spawn at edge, retry while too close" copies.
// Why: capped retry mode exists so aliens don't loop forever if the ship sits in the centre.
export const spawnAwayFromShip = <T extends { pos: Vec }>(
  spawn: () => T,
  shipPos: Vec,
  minDistance: number,
  maxAttempts?: number,
): T => {
  let candidate = spawn();
  if (maxAttempts === undefined) {
    while (dist(candidate.pos, shipPos) < minDistance) candidate = spawn();
    return candidate;
  }
  let attempts = 0;
  while (dist(candidate.pos, shipPos) < minDistance && attempts < maxAttempts) {
    candidate = spawn();
    attempts += 1;
  }
  return candidate;
};
