import type { AlienSize } from "../Alien";

export const WAVE_DIRECTOR_CONFIG = {
  engageRadius: {
    incoming: 310,
    split: 150,
  },

  rhythm: {
    chancePerCombo: 0.01,
    speedPerCombo: 0.05,
  },

  // dampens remaining headline rolls once one fires, so they rarely stack.
  headline: {
    dampen: 0.35,
  },

  canister: {
    featureFreeSpawns: false,
    firstWave: 3,
    chancePerWave: 1 / 3,
    spawnWindow: [8, 24] as [number, number],
  },

  alien: {
    firstWave: 4,
    chancePerWave: 1 / 3,
    spawnWindow: [5, 22] as [number, number],
  },

  comet: {
    firstWave: 3,
    chancePerWave: 0.6,
    spawnWindow: [4, 16] as [number, number],
    lifetime: [22, 30] as [number, number],
  },

  shockwave: {
    firstWave: 4,
    chancePerWave: 1 / 20,
    spawnWindow: [6, 22] as [number, number],
  },

  tink: {
    firstWave: 4,
    chancePerWave: 1 / 3,
  },

  // firstWave guarantees one gem; later waves roll per spawn.
  goldCrystal: {
    firstWave: 1,
    perSpawnChance: 0.25,
  },

  // Solid crystal: tougher than a regular gem rock (16 HP + 4× small fragments).
  // Introduced later than gold so the player has time to learn the gem-drop
  // dynamic with a single-HP target before facing a 16-HP variant.
  solidCrystal: {
    firstWave: 2,
    perSpawnChance: 0.12,
  },

  boss: {
    waves: [11] as readonly number[],
    foreshadowWaves: [10] as readonly number[],
  },

  bgBeatIntensity: {
    base: 0.08,
    range: 0.92,
    rampWaves: 30,
  },

  alienSizeShare: (wave: number, size: AlienSize): number => {
    if (wave < 6) return size === "small" ? 0.7 : size === "medium" ? 0.3 : 0;
    if (wave < 10) return size === "small" ? 0.45 : size === "medium" ? 0.4 : 0.15;
    return size === "small" ? 0.3 : size === "medium" ? 0.35 : 0.35;
  },
} as const;
