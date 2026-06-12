import type { AlienSize } from "../Alien";
import type { AsteroidSize } from "../Asteroid";

// Central tunables for every spawnable entity and a few environment effects.
// Spawn rules (firstWave, chancePerWave, spawnWindow) live alongside the
// per-entity stat blocks (hp, radius, score, speed) so all "what is this
// thing and when does it show up" knobs are in one place.
export const ENTITY_CONFIG = {
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

  asteroid: {
    radius: { large: 50, medium: 28, small: 16 } as Record<AsteroidSize, number>,
    hp: { large: 4, medium: 2, small: 1 } as Record<AsteroidSize, number>,
    score: { large: 20, medium: 50, small: 100 } as Record<AsteroidSize, number>,
    spawnSpeed: {
      large: [40, 90],
      medium: [55, 105],
      small: [60, 110],
    } as Record<AsteroidSize, [number, number]>,
  },

  // Bassteroids share asteroid radius/score but are 4× tougher so the rhythm
  // system has real teeth — a rhythm-bullet (4 damage) needs four hits to
  // crack a large bassteroid, matching the "armoured" silhouette.
  // maxLevel is the last *internal* wave on which bassteroids may appear
  // (display-level = wave - 1); they vanish after that so the post-boss arc
  // can introduce a new ambient texture.
  bassteroid: {
    hpMultiplier: 2,
    maxLevel: 10,
  },

  // Decorator asteroid kinds (chime/bell/warble) share asteroid stats — they
  // exist purely to add a melodic colour on top of the bass rhythm. Each entry
  // is the internal wave on which that kind first unlocks via
  // activeSpecialsForWave; chime/warble keep their original staggered intro
  // while bell holds back until the post-boss arc (display-level 11+).
  bell: {
    firstWave: 12,
  },

  canister: {
    featureFreeSpawns: true,
    firstWave: 3,
    chancePerWave: 1 / 7,
    spawnWindow: [8, 24] as [number, number],
    radius: 16,
    // brief vortex flash before the canister vanishes — a deliberate departure
    // when the player lets a pod drift past, not just a soft offscreen fade.
    warpDuration: 0.45,
  },

  alien: {
    firstWave: 4,
    chancePerWave: 1 / 3,
    spawnWindow: [5, 22] as [number, number],
    radius: { big: 38, medium: 24, small: 16 } as Record<AlienSize, number>,
    hp: { big: 4, medium: 2, small: 1 } as Record<AlienSize, number>,
    score: { big: 400, medium: 220, small: 130 } as Record<AlienSize, number>,
    speed: {
      big: [33, 53],
      medium: [47, 73],
      small: [63, 93],
    } as Record<AlienSize, [number, number]>,
    bulletSpeed: { big: 110, medium: 140, small: 200 } as Record<AlienSize, number>,
  },

  comet: {
    firstWave: 3,
    chancePerWave: 0.6,
    spawnWindow: [4, 16] as [number, number],
    lifetime: [22, 30] as [number, number],
    hitRadius: 24,
    fadeIn: 1.6,
    fadeOut: 2.0,
  },

  shockwave: {
    firstWave: 4,
    chancePerWave: 1 / 15,
    spawnWindow: [6, 22] as [number, number],
    // strong enough to redirect the ship, weak enough to avoid an unrecoverable spin.
    shipImpulse: 320,
    // shattered fragments — flung-apart read.
    childKick: 220,
    // boss can't be one-shot by environment; still nudged for feedback.
    bossKick: 120,
    // grace frame so the player isn't punished for being kicked into debris.
    shipGrace: 0.6,
  },

  // firstWave guarantees one gem; later waves roll per spawn.
  goldCrystal: {
    firstWave: 1,
    perSpawnChance: 0.25,
    radius: 14,
    // long enough that a player can swing back for it after handling rubble,
    // short enough that uncollected gems don't clutter the rest of the wave.
    lifetime: 18,
    // payoff for flying through the gem (no rhythm skill required).
    pickupScore: 2500,
    // probability that a cracked gem actually contains an upgrade. The rest of
    // the time it pays out revealScore — same structure as comet kills, so the
    // player reads it as a "consolation jackpot" rather than a miss.
    upgradeChance: 0.4,
    revealScore: 250,
  },

  // Solid crystal: tougher than a regular gem rock (16 HP + 4× small fragments).
  // Introduced later than gold so the player has time to learn the gem-drop
  // dynamic with a single-HP target before facing a 16-HP variant.
  solidCrystal: {
    firstWave: 2,
    perSpawnChance: 0.12,
    // large variant renders slightly oversized to feel more dangerous.
    largeRadius: 43,
    // Large solid crystals are heavy — they drift in noticeably slower than
    // their size band would suggest, so the player has time to read the tough
    // target and line up. Fed to the rhythm aligner as a scaled speed band
    // (not applied post-hoc) so the crystal still crosses the kill range on a
    // beat, just later and more ponderously.
    largeSpawnSpeedMul: 0.5,
    largeHp: 9,
    largeScore: 400,
    smallHp: 4,
    smallScore: 200,
    // Subtracted from every incoming hit before it touches HP. A plain 1-damage
    // shot does nothing and visibly bounces off; only on-beat (4) and boosted
    // (8) shots get through, the latter chipping 1 HP. Faceted ice should feel
    // like it wants a real hit, not a peashooter.
    damageReduction: 7,
    // Standalone solidCrystalSmall — a rare "treat" spawn on its own roll
    // (4 HP shard, smallScore on kill). Same cadence the tink roll used.
    smallSpawn: {
      firstWave: 4,
      chancePerWave: 1 / 3,
    },
  },

  // Glass prison — appears from display-level 11 onward (internal wave 12+,
  // immediately after the boss fight). Sixteen-HP indigo crystal shell with
  // a wraith locked inside; the killing hit shatters the shell and frees
  // the wraith.
  glassPrison: {
    firstWave: 12,
    perSpawnChance: 0.18,
    radius: 46,
    hp: 16,
    score: 600,
    // Heavy — drifts in slower than its size band suggests so the player has
    // time to read "do I want to crack this thing open?" before committing.
    spawnSpeedMul: 0.55,
  },

  // Wraith — what spawns out of a shattered prison. No standalone spawn; it
  // exists only as a glassPrison drop. Low HP relative to its menace, but
  // pursues the ship and writhes so cleanly lining up the kill is the trick.
  wraith: {
    radius: 26,
    hp: 5,
    score: 900,
    // How long (seconds) the wraith fades in / cannot damage the player after
    // emerging. Gives the player a beat to react to the new threat.
    emergeDuration: 0.9,
    // Pursuit acceleration (px/s/s) while drifting toward the ship.
    pursuitAccel: 36,
    // Pursuit speed cap (px/s) outside of lunges.
    maxPursuitSpeed: 95,
    // Lunge: an additional burst toward the ship. Fires on a beat-aligned
    // cadence (every lungePeriodMeasures bass measures). Per-wraith phase
    // offset is set at spawn so several wraiths stagger across the grid.
    lungePeriodMeasures: 2,
    lungeDuration: 0.65,
    lungeAccel: 380,
  },

  boss: {
    waves: [11] as readonly number[],
    foreshadowWaves: [10] as readonly number[],
    // The whole-body large solidifies out of the grown background planet;
    // the killing hit cracks it into two hemispheres + an eye-core. Mediums
    // are the hemispheres (~70% of full-body radius); smalls are the plate
    // fragments that come off them.
    radius: { large: 132, medium: 62, small: 30 } as Record<AsteroidSize, number>,
    hp: { large: 60, medium: 18, small: 6 } as Record<AsteroidSize, number>,
    score: { large: 2500, medium: 800, small: 300 } as Record<AsteroidSize, number>,
    // The eye-core is a third gen-1 fragment alongside the two hemispheres:
    // smaller, slightly less HP, keeps shooting until destroyed. On death it
    // breaks into 2 iris shards + 1 inert pupil ember (all small-size).
    eyeRadius: 48,
    eyeHp: 10,
    eyeScore: 1200,
    // Bolt projectile speed. Cadence + telegraph are no longer dt-driven —
    // both the iris laser and the post-break hemisphere plasma are snapped
    // to the boss's 8-beat rhythm (see Asteroid.tickBossRhythm).
    eyeBulletSpeed: 200,
    // 8-second grow-and-reveal before the boss becomes live and damageable.
    revealDuration: 8.0,
    // menace-rim red — matches the foreshadowing planet's tint.
    hue: 12,
  },

  bgBeatIntensity: {
    base: 0.6,
    range: 0.4,
    rampWaves: 30,
  },

  alienSizeShare: (wave: number, size: AlienSize): number => {
    if (wave < 6) return size === "small" ? 0.7 : size === "medium" ? 0.3 : 0;
    if (wave < 10) return size === "small" ? 0.45 : size === "medium" ? 0.4 : 0.15;
    return size === "small" ? 0.3 : size === "medium" ? 0.35 : 0.35;
  },
} as const;
