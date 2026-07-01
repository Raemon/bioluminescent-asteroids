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
    speedPerCombo: 0.0375,
  },

  // dampens remaining headline rolls once one fires, so they rarely stack.
  headline: {
    dampen: 0.35,
  },

  asteroid: {
    // "huge" is the twice-as-big tier: 2× a large rock's radius, 8 HP, and it
    // cleaves into a mass-conserving combo of large/medium/small (the 2-2-2-2
    // ladder: 1 huge = 2 large = 4 medium = 8 small). See Asteroid.splitRegular.
    radius: { huge: 100, large: 50, medium: 28, small: 16 } as Record<AsteroidSize, number>,
    hp: { huge: 8, large: 4, medium: 2, small: 1 } as Record<AsteroidSize, number>,
    score: { huge: 10, large: 20, medium: 50, small: 100 } as Record<AsteroidSize, number>,
    spawnSpeed: {
      huge: [28, 70],
      large: [40, 90],
      medium: [55, 105],
      small: [60, 110],
    } as Record<AsteroidSize, [number, number]>,
  },

  // Bassteroids share asteroid radius/score but are 4× tougher so the rhythm
  // system has real teeth — a rhythm-bullet (4 damage) needs four hits to
  // crack a large bassteroid, matching the "armoured" silhouette.
  // maxLevel is the last *internal* wave on which bassteroids spawn every
  // bass slot (display-level = wave - 1); past it the post-boss arc gives a
  // new ambient texture room, but they still surface at rareChanceAfterMax.
  bassteroid: {
    hpMultiplier: 2,
    maxLevel: 10,
    // past maxLevel bassteroids still surface, but each candidate slot only
    // rolls one in this often, so they stay an occasional accent.
    rareChanceAfterMax: 0.25,
  },

  // Decorator asteroid kinds (chime/bell/warble) share asteroid stats — they
  // exist purely to add a melodic colour on top of the bass rhythm. Each entry
  // is the internal wave on which that kind first unlocks via
  // activeSpecialsForWave; chime/warble keep their original staggered intro
  // while bell holds back until the post-boss arc (display-level 11+).
  bell: {
    firstWave: 12,
  },

  // Warble — a "phased" asteroid that appears in the post-boss arc (display-
  // level 11+, internal wave 12). Over each 4-beat measure it fades from a
  // solid body down to `lowOpacity` and back; while it's below the
  // `solidThreshold` fraction of that fade it goes intangible and bullets
  // pass straight through. The trick is to time a shot for when it's solid.
  warble: {
    firstWave: 12,
    perSpawnChance: 0.18,
    // Dimmest the body gets at the bottom of the fade (full = 1).
    lowOpacity: 0.35,
    // Opacity above which the rock is still solid/hittable; at or below it
    // the rock is phased out. Sits a little above lowOpacity so the
    // intangible window is the genuinely-faint trough, not the whole dim half.
    solidThreshold: 0.5,
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
    radius: { big: 76, medium: 48, small: 32 } as Record<AlienSize, number>,
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
    // lifetime is derived from the crossing distance at spawn (see
    // crossingLifetime) so the comet drifts in, crosses once, and drifts out.
    hitRadius: 24,
    fadeIn: 1.6,
    fadeOut: 2.0,
    // Multiplier on the base traversal speed. Above 1 the comet crosses the
    // field faster so it's harder to babysit on-screen and farm the on-beat
    // combo payout — you have to commit to the shot rather than herding it.
    speedMult: 1.7,
  },

  // Rare flock of smaller, faster comets. Worth less each but many at once.
  meteorShower: {
    firstWave: 5,
    chancePerWave: 0.12,
    spawnWindow: [4, 16] as [number, number],
    count: [3, 9] as [number, number],
    scale: 0.45,
    speedMult: 2,
    // shorter than a comet — fast movers clear the field quickly.
    lifetime: [10, 14] as [number, number],
    baseScore: 500,
    // One wave runs a guaranteed oversized swarm a few seconds in, with its
    // own thinned-out asteroid field so the swarm is the headline threat.
    swarmWave: {
      wave: 11,
      count: [6, 16] as [number, number],
      delay: [3, 5] as [number, number],
      asteroidCountMul: 0.5,
    },
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
  asteroidWithGem: {
    firstWave: 1,
    perSpawnChance: 0.5,
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

  // Gem swarm — the gold-diamond cousin of the meteor shower. A flock of bare
  // gems sweeps across the field, each a live rhythm target, so it's a brief
  // dense window of "comb through them for upgrades". Rarer than the meteor
  // shower and held back until the player knows the gem-drop dynamic cold.
  gemSwarm: {
    firstWave: 6,
    chancePerWave: 1 / 14,
    spawnWindow: [6, 22] as [number, number],
    count: [5, 10] as [number, number],
  },

  // Solid crystal: tougher than a regular gem rock (16 HP + 4× small fragments).
  // Introduced later than gold so the player has time to learn the gem-drop
  // dynamic with a single-HP target before facing a 16-HP variant.
  solidCrystal: {
    firstWave: 2,
    perSpawnChance: 0.12,
    // large variant renders slightly oversized to feel more dangerous.
    largeRadius: 30,
    // Large solid crystals are heavy — they drift in noticeably slower than
    // their size band would suggest, so the player has time to read the tough
    // target and line up. Fed to the rhythm aligner as a scaled speed band
    // (not applied post-hoc) so the crystal still crosses the kill range on a
    // beat, just later and more ponderously.
    largeSpawnSpeedMul: 0.5,
    largeHp: 5,
    largeScore: 400,
    smallHp: 4,
    smallScore: 200,
    // Subtracted from every incoming hit before it touches HP. A plain 1-damage
    // shot does nothing and visibly bounces off; only on-beat (4) and boosted
    // (8) shots get through, the latter chipping 1 HP. Faceted ice should feel
    // like it wants a real hit, not a peashooter. Smalls resist just as hard.
    largeDamageReduction: 3,
    smallDamageReduction: 3,
    // Standalone solidCrystalSmall — a rare "treat" spawn on its own roll
    // (4 HP shard, smallScore on kill). Same cadence the tink roll used.
    smallSpawn: {
      firstWave: 4,
      chancePerWave: 1 / 3,
    },
  },

  // Burst gem — a heavy, chunky solid-gold diamond. Tough in HP terms and almost
  // inert in motion (heavy → drifts in slowly). The killing hit doesn't drop a
  // pickup itself; instead it bursts into a fan of fast-flying collectible Gems,
  // rotated off the killing-shot axis so none flies straight back at the shooter.
  // Each flung Gem is a live rhythm target (fly in → die; shoot on-beat → points
  // or an upgrade). Two tiers share this block: a medium and a big variant.
  burstGem: {
    // Truly rare across the early/mid arc (display 2-9): no guaranteed intro
    // spawn, just a low per-rock roll. From the post-boss arc it's a recurring
    // threat.
    firstWave: 3,
    lastEarlyWave: 10,
    perSpawnChance: 0.05,
    // From this internal wave (display 11) the gem shows up much more often.
    frequentWave: 12,
    frequentChance: 0.18,
    hp: 8,
    score: 800,
    damageReduction: 4,
    // Heavy: drifts in noticeably slower than its size band, like a solid
    // crystal large, so the player can read the tough target and line up.
    spawnSpeedMul: 0.45,
    // When a gem slot fires, the chance it's the big 8-fan tier; otherwise medium.
    bigChance: 0.25,
    // Flung-Gem launch speed (px/s). Fast — they read as flung-apart blades,
    // not drifting rubble.
    shardSpeed: 360,
    medium: {
      radius: 34,
      shardCount: 4,
    },
    big: {
      radius: 64,
      shardCount: 8,
    },
  },

  // Glass prison — appears from display-level 11 onward (internal wave 12+,
  // immediately after the boss fight). Fragile indigo crystal shell with
  // wraiths locked inside; the single killing hit shatters the shell and
  // frees a brood of wraiths.
  glassPrison: {
    firstWave: 12,
    perSpawnChance: 0.33,
    radius: 46,
    hp: 1,
    score: 600,
    // Wraiths released when the shell shatters (inclusive range).
    minWraiths: 2,
    maxWraiths: 4,
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

  // Torus — a mechanical ring that solidifies in display-level 11+ (internal
  // wave 12, post-boss). Tougher than a normal large and drifts in slowly so
  // the player reads it as a deliberate puzzle-target. The killing hit cleaves
  // it into two C-shaped half-rings that keep orbiting a shared centre with the
  // donut gap intact; each half later breaks into a shorter arc + small chunks,
  // and every fragment holds its slot on a phantom rotating ring ("reassemble
  // the ring"). A flickering energy arc strings adjacent fragments together.
  torus: {
    firstWave: 12,
    perSpawnChance: 0.18,
    // Outer radius of the whole ring (its hitbox + visual footprint). Larger
    // than a stock large so the hole is wide enough to fly through after split.
    radius: 78,
    // Tube thickness as a fraction of the outer radius — the painted ring band
    // and the inner (passable) hole both derive from this.
    tubeFrac: 0.34,
    // Tough: a clean rhythm bullet (4 dmg) needs three hits to crack the ring.
    hp: 12,
    score: 1100,
    // Heavy mechanical mass: drifts in slower than its size band, like the
    // glass prison, so the tough target is readable.
    spawnSpeedMul: 0.5,
    // Steel-cyan. Cool industrial hue distinct from the indigo prison + warble
    // greens around it in the post-boss arc.
    hue: 196,
    // Half-ring (180° C) fragment: HP + the score it pays on the killing hit.
    arcHp: 6,
    arcScore: 600,
    // Shorter arc a half-ring breaks into (one ~110° sliver) + its debris.
    sliverHp: 3,
    sliverScore: 300,
    // Small terminal chunk knocked off when a half-ring breaks. Tougher than a
    // stock small so clearing the orbiting debris still asks for a clean shot.
    chunkHp: 2,
    chunkScore: 150,
    // How many chunks spall off each half-ring when it breaks (besides the
    // surviving sliver).
    chunkCount: 2,
    // Phantom-ring spin rate (rad/s) the fragments orbit their shared centre at.
    // Slow enough to read as a coherent rotating ring, not a blur.
    ringSpin: 0.5,
  },

  boss: {
    waves: [11] as readonly number[],
    foreshadowWaves: [10] as readonly number[],
    // The whole-body large solidifies out of the grown background planet;
    // the killing hit cracks it into two hemispheres + an eye-core. Mediums
    // are the hemispheres — kept close to the full-body radius so the halves
    // read as genuine cleaved chunks of the planet, not shrunken mediums.
    // Smalls are the plate fragments that come off them.
    // The boss has no "huge" tier; the huge entries mirror large purely to
    // satisfy the Record<AsteroidSize> shape and are never read.
    radius: { huge: 132, large: 132, medium: 104, small: 30 } as Record<AsteroidSize, number>,
    hp: { huge: 60, large: 60, medium: 18, small: 6 } as Record<AsteroidSize, number>,
    score: { huge: 2500, large: 2500, medium: 800, small: 300 } as Record<AsteroidSize, number>,
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
    // Total dormant intro before the boss becomes live and damageable. For
    // most of it the planetoid is a black, subdued, background-like silhouette
    // slowly swelling to full size; only the trailing revealActiveDuration
    // seconds carry the shudder / dust-off / eye-open.
    revealDuration: 60.0,
    // The trailing slice of revealDuration in which the boss shudders, dusts
    // off its crust, and the eye opens. The rest is the quiet black approach.
    revealActiveDuration: 8.0,
    // menace-rim red — matches the foreshadowing planet's tint.
    hue: 12,
    damageReduction: 3,
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
