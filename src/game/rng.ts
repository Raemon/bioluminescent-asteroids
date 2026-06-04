// Seeded PRNG (mulberry32) shared by the entire sim so replays reproduce
// every Math.random()-driven decision from a single 32-bit seed.

let state = (Math.random() * 0x100000000) >>> 0;

export const seedRng = (seed: number): void => {
  state = seed >>> 0;
};

export const getRngSeed = (): number => state;

export const rng = (): number => {
  state = (state + 0x6D2B79F5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const rngInt = (nExclusive: number): number => Math.floor(rng() * nExclusive);

export const rngRange = (min: number, max: number): number => min + rng() * (max - min);

export const rngPick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
