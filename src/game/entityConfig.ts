import type { AlienSize } from "../Alien";
import type { AsteroidKind, AsteroidSize } from "../Asteroid";

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

  // Shared despawn-timer range for mid-wave visitors (comets, aliens, meteor
  // showers) — each rolls its own random value from this range at spawn so
  // they don't all clear out in lockstep.
  warpLifetime: {
    range: [10, 36] as [number, number],
  },

  // Post-boss arc (display-level 11+): the per-wave entity count resets to
  // waveCount and re-ramps on the pre-boss two-wave cadence, with the new
  // kinds (prison / warble / torus / citadel) stacking on top.
  postBoss: {
    firstWave: 12,
    waveCount: 3,
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

  // Phase citadel — the warble's massive slow-turning cousin (display-level
  // 11-19). A heavily-armoured phased shell with a ship-shaped escape hole
  // through the middle. It phases out for a long stretch of the music, then
  // back in for an equally long stretch; the intended kill is to drift into
  // the hole while the shell is out of phase and shoot the unarmoured inner
  // wall from inside. The hole is always safe for the ship; the outer shell's
  // damageReduction (in ENTITY_STATS) deflects all but the heaviest outside
  // shots.
  citadel: {
    firstWave: 12,
    lastWave: 20,
    perSpawnChance: 0.15,
    // Ponderous mass — drifts in far slower than its size band.
    spawnSpeedMul: 0.4,
    // Phase cycle: solid for solidBeats, out of phase for outBeats, with a
    // fadeBeats-wide crossfade centred on each transition.
    solidBeats: 16,
    outBeats: 16,
    fadeBeats: 2,
    lowOpacity: 0.5,
    // Opacity at the exact solid↔out transition (the fade midpoint) — kept in
    // config so the render crossfade and the tick's solid flip stay aligned.
    solidThreshold: 0.75,
    // Escape hole = the ship's visible triangle scaled up by this factor.
    holeScale: 3.4,
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
    // alien size rolls only pick up a rhythm bonus once combo clears this.
    rhythmComboThreshold: 12,
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

  // Wave-skip portal a player-killed alien tears open at its death spot. Fly
  // into it to end the wave on the spot and jump ahead — bigger aliens tear
  // holes that reach further. Never past a boss wave (see waveSkip.ts).
  skipWormhole: {
    // [min, max] waves skipped past the normal next wave, rolled per size.
    skips: {
      small: [1, 1],
      medium: [2, 3],
      big: [3, 5],
    } as Record<AlienSize, [number, number]>,
    // Beats the mouth stays enterable before irising shut on its own.
    lifetimeBeats: 24,
    // Fraction of the mouth's long axis that counts as flying in.
    entryRadiusFrac: 0.8,
    // Beats between successive skipped-wave title announces.
    titleCadenceBeats: 4,
    // Beats after the landing wave spawns before the return portal blooms.
    emergeDelayBeats: 4,
    // Beats between the return portal blooming and the ship flying out.
    emergeRideBeats: 1,
    // Seconds for the cosmetic fly-out scale/spin.
    emergeSec: 0.5,
    invulnOnEmerge: 2.0,
    // Body radius fed to portalLongAxis for the return portal.
    emergePortalBodyRadius: 30,
    // Emerald light so "fly in here" never reads as the violet departure
    // portal or the warm gold upgrade warp.
    rimHue: 148,
    throatHue: 126,
  },

  comet: {
    firstWave: 3,
    chancePerWave: 0.6,
    spawnWindow: [4, 16] as [number, number],
    // lifetime before warp-out is randomized per spawn — see warpLifetime.range.
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
    baseScore: 500,
    // Hard cap on a single meteor's lifetime (seconds), so a trailing/laggy
    // member of the flock can't linger far past the rest of the shower.
    lifetime: [8, 14] as [number, number],
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

  // Solid crystal: tougher than a regular gem rock. Introduced later than gold so
  // the player learns the gem-drop dynamic on a single-HP target first.
  // Combat stats (hp/score/radius/damageReduction) live in ENTITY_STATS.
  solidCrystal: {
    firstWave: 2,
    perSpawnChance: 0.12,
    // Heavy: drifts in slower than its band (fed to the rhythm aligner scaled,
    // so it still crosses the kill range on a beat, just later).
    largeSpawnSpeedMul: 0.5,
    // Standalone solidCrystalSmall — a rare "treat" spawn on its own roll.
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
  // Combat stats (hp/score/radius/damageReduction) live in ENTITY_STATS per
  // tier (burstGemMedium / burstGemBig); this block is spawn + burst tuning.
  burstGem: {
    // Rare across the early/mid arc (a low per-rock roll); recurring post-boss.
    firstWave: 3,
    lastEarlyWave: 10,
    perSpawnChance: 0.05,
    // From this internal wave (display 11) the gem shows up much more often.
    frequentWave: 12,
    frequentChance: 0.18,
    // Heavy: drifts in slower than its size band so the tough target reads.
    spawnSpeedMul: 0.45,
    // When a gem slot fires, the chance it's the big 8-fan tier; else medium.
    bigChance: 0.25,
    // Flung-Gem launch speed (px/s) — fast, they read as flung-apart blades.
    shardSpeed: 360,
    medium: {
      shardCount: 4,
    },
    big: {
      shardCount: 8,
    },
  },

  // Glass prison — appears from display-level 11 onward (internal wave 12+,
  // immediately after the boss fight). Fragile indigo crystal shell with
  // wraiths locked inside; the single killing hit shatters the shell and
  // frees a brood of wraiths.
  // Combat stats (hp/score/radius) live in ENTITY_STATS.
  glassPrison: {
    firstWave: 12,
    perSpawnChance: 0.33,
    // Wraiths released when the shell shatters (inclusive range).
    minWraiths: 2,
    maxWraiths: 4,
    // Heavy — drifts in slower so the player can read "crack this open?" first.
    spawnSpeedMul: 0.55,
  },

  // Wraith — what spawns out of a shattered prison. No standalone spawn; it
  // exists only as a glassPrison drop. Low HP relative to its menace, but
  // pursues the ship and writhes so cleanly lining up the kill is the trick.
  // Combat stats (hp/score/radius) live in ENTITY_STATS.
  wraith: {
    // Fade-in / damage-immune window (s) after emerging — a beat to react.
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
  // Combat stats (hp/score/radius/hue) for torus/torusArc/torusChunk live in
  // ENTITY_STATS; this block is spawn + ring-geometry tuning.
  torus: {
    firstWave: 12,
    perSpawnChance: 0.18,
    // Tube thickness as a fraction of the outer radius — the painted ring band
    // and the inner (passable) hole both derive from this.
    tubeFrac: 0.34,
    // Heavy mechanical mass: drifts in slower so the tough target is readable.
    spawnSpeedMul: 0.5,
    // Every break blows the phantom ring this much wider than before (first
    // relative to the intact ring's centreline, then again each time a
    // half-ring shatters), so the broken formation keeps opening up and the
    // gaps stay practical to fly through.
    breakExpand: 1.3,
    // Chunks spalled off each half-ring when it breaks (besides the sliver).
    chunkCount: 2,
    // Phantom-ring spin rate (rad/s) the fragments orbit their shared centre at.
    ringSpin: 0.17,
  },

  // Combat stats (hp/score/radius/hue/damageReduction) for the whole boss and
  // its fragments live in ENTITY_STATS; this block is the fight's timing tuning.
  boss: {
    waves: [11] as readonly number[],
    foreshadowWaves: [10] as readonly number[],
    // Iris radius for the whole-body eyelid layout (not the bossEye fragment).
    eyeRadius: 48,
    // Bolt projectile speed; cadence + telegraph snap to the boss 8-beat rhythm.
    eyeBulletSpeed: 200,
    // Total dormant intro before the boss becomes live and damageable; only the
    // trailing revealActiveDuration carries the shudder / dust-off / eye-open.
    revealDuration: 60.0,
    revealActiveDuration: 8.0,
  },

  bgBeatIntensity: {
    base: 0.6,
    range: 0.4,
    rampWaves: 30,
  },

  alienSizeShare: (wave: number, size: AlienSize): number => {
    if (wave < 5) return size === "small" ? 0.6 : size === "medium" ? 0.4 : 0;
    return size === "small" ? 0.4 : size === "medium" ? 0.35 : 0.25;
  },
} as const;

// Per-kind combat/visual stats — the single source of truth fetched via
// entityStat / ENTITY_STATS[kind], replacing the old switch-on-kind tables.
// hp/score/radius are a plain number, or a per-size record for the families that
// ladder by AsteroidSize (boss, bass, torusArc). A field left off falls back to
// the stock asteroid size band; hue left off rolls a fresh wave hue at spawn.
type Sized = number | Partial<Record<AsteroidSize, number>>;

export type EntityStats = {
  hp?: Sized;
  score?: Sized;
  radius?: Sized;
  hue?: number;
  damageReduction?: number;
  // Outline vertex count; kinds without one keep the smooth 60-sample default.
  outlineSamples?: number;
};

export const ENTITY_STATS: Partial<Record<AsteroidKind, EntityStats>> = {
  // Bassteroids are 2× the stock HP ladder (armoured); each voice has its hue.
  bassA: {
    hp: { huge: 16, large: 8, medium: 4, small: 2 },
    hue: 0,
  },
  bassB: {
    hp: { huge: 16, large: 8, medium: 4, small: 2 },
    hue: 28,
  },
  bassC: {
    hp: { huge: 16, large: 8, medium: 4, small: 2 },
    hue: 192,
  },
  bassD: {
    hp: { huge: 16, large: 8, medium: 4, small: 2 },
    hue: 290,
  },

  // Sound-decorator rocks — stock stats, only a hue (+ bell's masonry outline).
  chime: {
    hue: 52,
  },
  bell: {
    hue: 285,
    outlineSamples: 22,
  },
  warble: {
    hue: 130,
  },

  // The warble's fortress cousin. Low HP behind heavy armour: a shot from
  // inside the escape hole bypasses the armour entirely (see citadelInnerHit),
  // so one rhythm bullet from within breaks it up.
  citadel: {
    hp: 4,
    score: 2200,
    radius: 140,
    hue: 150,
    damageReduction: 8,
  },

  // Boss family — six distinct pieces. The whole-body boss ladders by size so
  // its split children can reuse the band; the fragments are single-size.
  boss: {
    hp: { huge: 48, large: 48, medium: 18, small: 6 },
    score: { huge: 2500, large: 2500, medium: 800, small: 300 },
    radius: { huge: 132, large: 132, medium: 104, small: 30 },
    hue: 12,
    damageReduction: 4,
  },
  // Hemisphere armour is directional: the rounded shell keeps the reduction,
  // the exposed cut face has none (see Asteroid.damageReductionAt).
  bossHemisphere: {
    hp: 18,
    score: 800,
    radius: 104,
    hue: 12,
    damageReduction: 4,
  },
  bossEye: {
    hp: 10,
    score: 1200,
    radius: 48,
    hue: 12,
  },
  bossPlate: {
    hp: 6,
    score: 300,
    radius: 30,
    hue: 12,
  },
  bossIrisShard: {
    hp: 6,
    score: 300,
    radius: 30 * 0.85,
    hue: 12,
  },
  bossEmber: {
    hp: 6,
    score: 300,
    radius: 30 * 0.55,
    hue: 12,
  },

  solidCrystal: {
    hp: 5,
    score: 400,
    radius: 30,
    hue: 238,
    damageReduction: 3,
    outlineSamples: 7,
  },
  solidCrystalSmall: {
    hp: 2,
    score: 200,
    hue: 238,
    damageReduction: 3,
    outlineSamples: 6,
  },

  // Solid gold — gem and shards share the cut-gold material; tiers differ in
  // radius + shard count (shardCount lives on the burstGem config block).
  burstGemMedium: {
    hp: 8,
    score: 800,
    radius: 34,
    hue: 46,
    damageReduction: 4,
    outlineSamples: 8,
  },
  burstGemBig: {
    hp: 8,
    score: 800,
    radius: 64,
    hue: 46,
    damageReduction: 4,
    outlineSamples: 8,
  },

  glassPrison: {
    hp: 1,
    score: 600,
    radius: 46,
    hue: 258,
    outlineSamples: 8,
  },
  wraith: {
    hp: 5,
    score: 900,
    radius: 26,
    hue: 286,
  },

  // Steel-cyan ring; arc/chunk radius is set by split() from ring geometry.
  torus: {
    hp: 12,
    score: 1100,
    radius: 100,
    hue: 196,
  },
  // Half-ring at "large"; the shorter sliver it breaks into at "medium".
  torusArc: {
    hp: { large: 6, medium: 3 },
    score: { large: 600, medium: 300 },
    hue: 196,
  },
  torusChunk: {
    hp: 2,
    score: 150,
    hue: 196,
  },

  // Cathedral debris a "bell" shatters into; hue here is only a standalone
  // fallback (the parent bell's hue is passed in at split).
  cathedralKeystone: {
    hp: 2,
    hue: 285,
    outlineSamples: 8,
  },
  glassShard: {
    hp: 2,
    hue: 285,
    outlineSamples: 6,
  },
  columnDrum: {
    hp: 2,
    hue: 285,
    outlineSamples: 16,
  },
  rubbleBlock: {
    hp: 2,
    hue: 285,
    outlineSamples: 16,
  },
};

const resolveSized = (stat: Sized | undefined, size: AsteroidSize): number | undefined =>
  typeof stat === "object" ? stat[size] : stat;

// Fetch a per-kind combat stat, resolving a size-varying entry against `size`
// and falling back to the stock asteroid size band. Replaces getMaxHp / KIND_HP.
export function entityStat(kind: AsteroidKind, size: AsteroidSize, field: "hp" | "score" | "radius"): number {
  const resolved = resolveSized(ENTITY_STATS[kind]?.[field], size);
  return resolved ?? ENTITY_CONFIG.asteroid[field][size];
}
