import type { Game } from "../Game";
import { Asteroid, AsteroidKind, AsteroidSize, BASS_MEASURE_LENGTH, SIZE_SPAWN_SPEED, spawnAsteroidAtEdge, spawnBossAt } from "../Asteroid";
import { spawnComet as spawnCometAtEdge } from "../Comet";
import { AlienSize, spawnAlienAtEdge } from "../Alien";
import { spawnCanister } from "../Canister";
import { rand, v, TAU } from "../vec";
import { rng } from "./rng";
import { BEAT_GRID } from "./rhythmConstants";
import { spawnAwayFromShip } from "./spawnAwayFromShip";
import { newWaveEventSchedule, maybeSchedule } from "./waveEvents";
import { startShockwave } from "./shockwave";
import { emitCrackParticles } from "./particleBursts";
import { alignVelocityToRhythm, BeatClaimSet, newBeatClaimSet } from "./rhythmTrajectory";
import { ENTITY_CONFIG as CFG } from "./entityConfig";

// snap each fresh edge-spawn so its crossing of the player's natural
// kill range lands on a beat. Boss is exempt — it has its own slow drift.
//
// Reference point is the screen centre, *not* the ship — incoming rocks take
// several seconds to cross the field, by which time a moving ship has long
// left where it was. Using the screen centre as the encounter anchor means
// the timing is stable: the player can position themselves anywhere near
// the centre and still get a predictable beat-aligned procession of rocks.
// Spawn speed band for an asteroid, scaled per kind. Large solid crystals
// drift in slower than their size band (see CFG.solidCrystal.largeSpawnSpeedMul)
// — handing the aligner a slowed band keeps them beat-aligned at the lower
// speed rather than just decelerating a stock rock after the fact.
const spawnSpeedRange = (a: Asteroid): [number, number] => {
  const [lo, hi] = SIZE_SPAWN_SPEED[a.size];
  if (a.kind === "solidCrystal") {
    const m = CFG.solidCrystal.largeSpawnSpeedMul;
    return [lo * m, hi * m];
  }
  if (a.kind === "glassPrison") {
    const m = CFG.glassPrison.spawnSpeedMul;
    return [lo * m, hi * m];
  }
  return [lo, hi];
};

const alignIncomingToRhythm = (game: Game, a: Asteroid, claimed?: BeatClaimSet) => {
  if (a.isBoss()) return;
  const range = spawnSpeedRange(a);
  const centre = { x: game.w / 2, y: game.h / 2 };
  alignVelocityToRhythm(a.pos, a.vel, {
    refPos: centre,
    beatTime: game.beatTime,
    speedRange: range,
    engageRadius: CFG.engageRadius.incoming,
    // edge spawns sit many beats out; slot pool must cover slowest crossing
    maxBeats: 24,
    claimed,
  });
};

// a split child inherits the bullet's impact velocity (fast, fan-shaped)
// and starts essentially on top of the ship. We let its outward speed flex
// ±~35% so the moment it reaches CFG.engageRadius.split lands on a beat —
// and give it up to ±18 px of position nudge along its outward direction
// as a second degree of freedom (reads as "explosion shoved it a bit
// further out", not a teleport). Min 1 beat ahead so the player has at
// least 500 ms to react and re-aim. Sibling children share a `claimed`
// set so a parent's two kids end up on adjacent beats rather than
// colliding on one.
//
// refVel = ship.vel because an actively-flying player covers 200–460 px
// in the 1–2 beat alignment window — more than a ring radius. Without this
// the debris is aligned to a stale "ghost ship" position and a moving
// player never sees combo-able children.
export const alignSplitChildToRhythm = (game: Game, child: Asteroid, claimed?: BeatClaimSet) => {
  if (child.isBossFamily()) return;
  const speed = Math.hypot(child.vel.x, child.vel.y);
  if (speed < 1) return;
  alignVelocityToRhythm(child.pos, child.vel, {
    refPos: game.ship.pos,
    refVel: game.ship.vel,
    beatTime: game.beatTime,
    speedRange: [speed * 0.65, speed * 1.35],
    engageRadius: CFG.engageRadius.split,
    minBeats: 1,
    maxBeats: 6,
    maxPosNudge: 18,
    claimed,
  });
};

// re-export so kill-effects callers don't have to import from two
// modules just to share a per-event claim set among sibling children.
export { newBeatClaimSet };
export type { BeatClaimSet };

export const rhythmSpeedMul = (game: Game): number => 1 + game.beatCombo * CFG.rhythm.speedPerCombo;
const rhythmChanceBonus = (game: Game): number => game.beatCombo * CFG.rhythm.chancePerCombo;

// predicates let the wave director read declaratively, not as inline boolean expressions.
export const isBossWave = (wave: number): boolean => CFG.boss.waves.includes(wave);
export const isBossForeshadowWave = (wave: number): boolean => CFG.boss.foreshadowWaves.includes(wave);

// internal wave numbering stays 1-based (so all the wave >= N gates keep working);
// the player-facing label is shifted down by one so the warm-up rock is "Wave 0".
export const displayWave = (wave: number): number => wave - 1;

// Persistent across runs: once the player has ever reached 6x rhythm, they've
// outgrown the single-rock warm-up. Future normal-mode runs (not tutorial)
// skip straight to internal wave 2 — the first proper wave.
const VETERAN_KEY = "pulsar.veteran";

export const isVeteranPilot = (): boolean => {
  try {
    return localStorage.getItem(VETERAN_KEY) === "1";
  } catch {
    return false;
  }
};

export const markVeteranPilot = () => {
  try {
    localStorage.setItem(VETERAN_KEY, "1");
  } catch {
    // localStorage may be blocked (private mode); next run just won't skip.
  }
};

export const updateBgBeatIntensity = (game: Game) => {
  // a deliberate per-wave set wins over any in-flight calibration→play loudness ramp.
  game.beatIntensityRamp = null;
  const ramp = Math.max(0, Math.min(1, (game.wave - 1) / CFG.bgBeatIntensity.rampWaves));
  game.sound.bgBeatIntensity = CFG.bgBeatIntensity.base + ramp * CFG.bgBeatIntensity.range;
};

// snap-to-grid guarantees every bassteroid fires on a pulsar beat despite float drift.
export const alignBassBeat = (game: Game, asteroid: Asteroid) => {
  if (!asteroid.isBass()) return;
  const gridSnappedOffset = Math.round(asteroid.measureOffset / BEAT_GRID) * BEAT_GRID;
  asteroid.measureOffset = gridSnappedOffset;
  const k = Math.ceil((game.beatTime - gridSnappedOffset - 1e-6) / BASS_MEASURE_LENGTH);
  const raw = k * BASS_MEASURE_LENGTH + gridSnappedOffset;
  asteroid.nextBeatAt = Math.round(raw / BEAT_GRID) * BEAT_GRID;
};

// paired-wave intro (one bass, then both, then decorators) trains the player gradually.
export const activeSpecialsForWave = (game: Game, wave: number): AsteroidKind[] => {
  if (wave < 3) return [];
  if (wave === 3) return [game.bassOrder[0]];
  if (wave === 4) return [game.bassOrder[1]];
  const specials: AsteroidKind[] = [game.bassOrder[0], game.bassOrder[1]];
  const lateUnlockOrder: AsteroidKind[] = ["chime", "bell", "warble", game.bassOrder[2], game.bassOrder[3]];
  // pair waves hold each new sound steady so the player has time to learn it before the next.
  const lateCount = Math.max(0, Math.min(lateUnlockOrder.length, Math.floor((wave - 5) / 2)));
  for (let i = 0; i < lateCount; i++) specials.push(lateUnlockOrder[i]);
  return specials;
};

// boost velocity in place by the current rhythm-speed multiplier; called
//   *after* rhythm alignment so the alignment math (which works in the
//   unscaled SIZE_SPAWN_SPEED band) stays valid — the speedup just makes the
//   target arrive a touch earlier than its assigned beat slot.
const applyRhythmSpeed = (game: Game, vel: { x: number; y: number }) => {
  const k = rhythmSpeedMul(game);
  if (k === 1) return;
  vel.x *= k;
  vel.y *= k;
};

// shared retry helper keeps the "no rock on top of the ship" rule in one place.
//   Every fresh spawn is rhythm-aligned post-roll so the player's first clean
//   shot at the rock can land on a beat — see alignIncomingToRhythm. The
//   optional `claimed` set spreads a batch of spawns across distinct beat
//   slots instead of stacking them all on the same beat.
const spawnAsteroidAway = (
  game: Game,
  minDist: number,
  kind?: AsteroidKind,
  size?: "large" | "medium" | "small",
  claimed?: BeatClaimSet,
) => {
  const a = spawnAwayFromShip(() => spawnAsteroidAtEdge(game.w, game.h, undefined, kind, size), game.ship.pos, minDist);
  // Heavy solid crystals drift slower; pre-scale before alignment so even a
  //   no-candidate fallback keeps the ponderous speed. The aligner works in
  //   the matching slowed band (see spawnSpeedRange), so a successful match
  //   stays slow too.
  if (a.kind === "solidCrystal") {
    a.vel.x *= CFG.solidCrystal.largeSpawnSpeedMul;
    a.vel.y *= CFG.solidCrystal.largeSpawnSpeedMul;
  }
  if (a.kind === "glassPrison") {
    a.vel.x *= CFG.glassPrison.spawnSpeedMul;
    a.vel.y *= CFG.glassPrison.spawnSpeedMul;
  }
  alignIncomingToRhythm(game, a, claimed);
  applyRhythmSpeed(game, a.vel);
  return a;
};

// specials need alignBassBeat so their first downbeat lands on the pulsar grid immediately.
const spawnSpecial = (game: Game, kind: AsteroidKind, claimed?: BeatClaimSet): Asteroid => {
  const a = spawnAsteroidAway(game, 220, kind, undefined, claimed);
  alignBassBeat(game, a);
  return a;
};

// standalone solidCrystalSmall has a fixed small size + kind so we roll it
// outside activeSpecialsForWave. Same "rare treat" slot the tink roll filled.
const spawnSolidCrystalSmall = (game: Game, claimed?: BeatClaimSet): Asteroid =>
  spawnAsteroidAway(game, 200, "solidCrystalSmall", "small", claimed);

// pre-align first fire to the next BEAT_GRID slot so saucer shots lock into
// the rhythm immediately. From there the alien advances through its own
// fire pattern (see ALIEN_FIRE_PATTERN_BEATS in Alien.ts).
export const spawnAlien = (game: Game, size: AlienSize) => {
  const a = spawnAwayFromShip(() => spawnAlienAtEdge(game.w, game.h, size), game.ship.pos, 260, 6);
  applyRhythmSpeed(game, a.vel);
  a.nextFireAt = Math.ceil((game.beatTime + 0.5) / BEAT_GRID) * BEAT_GRID;
  a.firePatternIndex = 0;
  game.aliens.push(a);
  game.sound.startAlienDrone(a, size, a.pos);
};

// comet's first melody note locks to the next bass-measure downbeat (every BASS_MEASURE_LENGTH s),
//   not just the next BEAT_GRID — gives the entrance whoosh ~1–2s of solo space before the line begins
//   and ensures the sung-in pitch coincides with a downbeat hit instead of an interior tick. Each
//   subsequent note steps by 2 BEAT_GRID (=1s) per COMET_MELODY's slower phrase pulse.
//
// Comets pay 1000 × beatCombo on an on-beat kill (the single biggest combo
// payout in the game) and a flat 500 off-beat. Aligning the traversal speed
// so the comet crosses the engagement ring on a beat means an on-rhythm
// player can land the big payout on-beat without having to guess the comet's
// individual phase.
// ±15 % is enough wiggle room to absorb the small phase mismatch without
// noticeably altering the comet's "slow celestial visitor" cadence.
export const spawnComet = (game: Game) => {
  const c = spawnCometAtEdge(game.w, game.h);
  c.lifetime = rand(CFG.comet.lifetime[0], CFG.comet.lifetime[1]);
  const cometEntryLead = 0.6;
  c.nextNoteBeatTime = Math.ceil((game.beatTime + cometEntryLead) / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
  const cometSpeed = Math.hypot(c.vel.x, c.vel.y);
  if (cometSpeed > 0) {
    const centre = { x: game.w / 2, y: game.h / 2 };
    alignVelocityToRhythm(c.pos, c.vel, {
      refPos: centre,
      beatTime: game.beatTime,
      speedRange: [cometSpeed * 0.85, cometSpeed * 1.15],
      engageRadius: CFG.engageRadius.incoming,
      maxBeats: 24,
    });
  }
  applyRhythmSpeed(game, c.vel);
  game.comets.push(c);
  game.sound.startCometShimmer(c, c.pos);
};

// one entry replaces the previous if/else maze covering boss/foreshadow/normal wave dispatch.
//   One `claimed` set is shared across the wave's asteroid + standalone
//   solidCrystalSmall rolls so each fresh rock takes a distinct beat slot —
//   the result is a steady beat-by-beat target procession the player can
//   combo through.
// Tutorial: a single small practice rock, rhythm-aligned like a normal spawn so
//   its first-beat dot is meaningful, with a little materialize puff so a respawn
//   reads as "a fresh one drifts in".
export const spawnTutorialSmall = (game: Game) => {
  // The guided tutorial is the rookie's "first level"; consume the flag so the
  //   first real density wave after graduation streaks in normally.
  game.hasSpawnedFirstLevel = true;
  const a = spawnAsteroidAway(game, 240, undefined, "small", newBeatClaimSet());
  game.asteroids.push(a);
  emitCrackParticles(game.particles, a, true);
};

// Post-graduation tutorial spawn: one large rock at a time, respawning on clear
//   until the player finishes the hint progression. Avoids the difficulty cliff
//   of jumping straight from one small practice rock to the full 3-big wave.
export const spawnTutorialBig = (game: Game) => {
  const a = spawnAsteroidAway(game, 240, undefined, "large", newBeatClaimSet());
  game.asteroids.push(a);
  emitCrackParticles(game.particles, a, true);
};

export const spawnWave = (game: Game) => {
  game.asteroids = [];
  game.canisters = [];
  game.goldCrystals = [];
  game.waveEvents = newWaveEventSchedule();
  game.waveElapsed = 0;

  // First wave the player actually flies (display wave 0 on a normal start,
  //   display wave 1 for a veteran who skips the warm-up). Consumed here so
  //   only that opener gets the centre-out drift spawn — every later wave
  //   resumes streaking in from the edges.
  const isFirstLevel = !game.hasSpawnedFirstLevel;
  game.hasSpawnedFirstLevel = true;

  if (handleBossWave(game)) return;
  setForeshadowState(game);
  rollWaveEvents(game);
  const claimed = newBeatClaimSet();
  spawnWaveAsteroids(game, claimed, isFirstLevel);
  rollSolidCrystalSmallSpawn(game, claimed);
};

// capture planet pos BEFORE hiding it so the boss materialises where the player last saw the planet.
const handleBossWave = (game: Game): boolean => {
  if (!isBossWave(game.wave)) return false;
  const pos = game.pulsar.bossPlanetPos();
  game.pulsar.setBossPlanetState("active");
  game.asteroids.push(spawnBossAt(pos, game.w, game.h));
  return true;
};

// foreshadow wave swells the planet visibly; idle fallback handles edge cases like state restart.
const setForeshadowState = (game: Game) => {
  if (isBossForeshadowWave(game.wave)) {
    game.pulsar.setBossPlanetState("foreshadow");
  } else if (game.pulsar.bossPlanetState === "foreshadow") {
    game.pulsar.setBossPlanetState("idle");
  }
};

// Each independent event rolls on its own. The three "headline" events
// (shockwave, comet, alien) cross-suppress: when one rolls successfully,
// the next ones in the sequence have their chance multiplied by
// CFG.headline.dampen so a single wave rarely stacks two of them.
// Order is randomised each wave to keep the suppression symmetric.
const rollWaveEvents = (game: Game) => {
  if (CFG.canister.featureFreeSpawns && game.wave >= CFG.canister.firstWave) {
    maybeSchedule(game.waveEvents, CFG.canister.chancePerWave, CFG.canister.spawnWindow, () => {
      const c = spawnCanister(game.w, game.h, game.ship.pos);
      applyRhythmSpeed(game, c.vel);
      game.canisters.push(c);
      game.sound.play("canisterAppear", 1, c.pos);
    });
  }
  rollHeadlineEvents(game);
};

type HeadlineRoll = { gate: boolean; baseChance: number; fire: () => boolean };

const rollHeadlineEvents = (game: Game) => {
  // Rhythm additively boosts the alien-size rolls and the shockwave roll.
  //   Comet is left on its existing curve — only aliens + shockwave were asked for.
  const bonus = rhythmChanceBonus(game);
  const alienGate = game.wave >= CFG.alien.firstWave;
  const alienSizeRoll = (size: AlienSize): HeadlineRoll => ({
    gate: alienGate && CFG.alienSizeShare(game.wave, size) > 0,
    baseChance: CFG.alien.chancePerWave * CFG.alienSizeShare(game.wave, size) + bonus,
    fire: () => {
      maybeSchedule(game.waveEvents, 1, CFG.alien.spawnWindow, () => spawnAlien(game, size));
      return true;
    },
  });

  const rolls: HeadlineRoll[] = [
    {
      gate: game.wave >= CFG.shockwave.firstWave,
      baseChance: CFG.shockwave.chancePerWave + bonus,
      fire: () => {
        maybeSchedule(game.waveEvents, 1, CFG.shockwave.spawnWindow, () => startShockwave(game));
        return true;
      },
    },
    {
      gate: game.wave >= CFG.comet.firstWave,
      baseChance: CFG.comet.chancePerWave,
      fire: () => {
        maybeSchedule(game.waveEvents, 1, CFG.comet.spawnWindow, () => spawnComet(game));
        return true;
      },
    },
    alienSizeRoll("small"),
    alienSizeRoll("medium"),
    alienSizeRoll("big"),
  ];

  // randomise order so no single event always gets the un-dampened first roll.
  for (let i = rolls.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rolls[i], rolls[j]] = [rolls[j], rolls[i]];
  }

  let dampen = 1;
  for (const r of rolls) {
    if (!r.gate) continue;
    if (rng() >= r.baseChance * dampen) continue;
    r.fire();
    dampen *= CFG.headline.dampen;
  }
};

// First level only. Instead of streaking in from a screen edge, the opening
// wave's rocks materialise in a loose ring around the centre — right where the
// ship spawns — and drift gently *outward*. Each one sits a little past the
// resting reticule's reach, so one soft thrust is enough to glide after it and
// bring its first-beat target dot under the crosshair. It's the calmest
// possible introduction to lining a shot up on the beat.
const FIRST_LEVEL_DRIFT = {
  // spawn distance band as fractions of the incoming engage ring. Pushed
  //   further out than the original single ringFrac so the opener needs a
  //   gentle chase; the max can sit slightly past the ring.
  distMinFrac: 0.9,
  distMaxFrac: 1.1,
  // nudge after the sorted-distance spread so rocks aren't perfectly ordered.
  distJitter: 22,
  // slow, ponderous outward drift — a calm, readable target to chase.
  speed: [30, 46] as [number, number],
};

// Random bearings + distances that tend to spread (one closer, one farther).
//   Sample `count` uniform distances, sort them, jitter each — on average
//   that lands noticeably different radii without hardcoding tiers. Angles
//   are sampled with a minimum angular separation so rocks don't visually
//   overlap at the engage ring; with the largest plausible opener count
//   (~5 on a veteran skip) and ~30° min spacing the budget is comfortable.
const FIRST_LEVEL_MIN_ANGLE_SEP = (30 * Math.PI) / 180;
const sampleFirstLevelPlacements = (count: number, engage: number): Array<{ angle: number; dist: number }> => {
  const minDist = engage * FIRST_LEVEL_DRIFT.distMinFrac;
  const maxDist = engage * FIRST_LEVEL_DRIFT.distMaxFrac;
  const distSamples: number[] = [];
  for (let i = 0; i < count; i++) distSamples.push(minDist + rng() * (maxDist - minDist));
  distSamples.sort((a, b) => a - b);
  // Shrink the floor if the budget can't fit — keeps us robust to large counts
  //   while preserving the visual goal in the common case.
  const sep = Math.min(FIRST_LEVEL_MIN_ANGLE_SEP, (TAU / Math.max(count, 1)) * 0.9);
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    let chosen = rng() * TAU;
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = rng() * TAU;
      if (angles.every(a => angularDist(a, candidate) >= sep)) { chosen = candidate; break; }
      if (attempt === 0) chosen = candidate;
    }
    angles.push(chosen);
  }
  const placements: Array<{ angle: number; dist: number }> = [];
  for (let i = 0; i < count; i++) {
    const dist = Math.max(minDist, Math.min(maxDist, distSamples[i] + rand(-FIRST_LEVEL_DRIFT.distJitter, FIRST_LEVEL_DRIFT.distJitter)));
    placements.push({ angle: angles[i], dist });
  }
  return placements;
};

const angularDist = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % TAU + TAU) % TAU);
  return Math.min(d, TAU - d);
};

// Spawn one opening-wave rock drifting straight out from the centre.
const spawnFirstLevelDrifter = (
  game: Game,
  angle: number,
  dist: number,
  kind: AsteroidKind | undefined,
  size: AsteroidSize,
  claimed: BeatClaimSet,
): Asteroid => {
  const cx = game.w / 2;
  const cy = game.h / 2;
  const engage = CFG.engageRadius.incoming;
  const pos = v(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist);
  // Heavy solid crystals keep their slowdown multiplier on top of the already
  //   gentle opener band.
  const mul = kind === "solidCrystal" ? CFG.solidCrystal.largeSpawnSpeedMul : 1;
  const band: [number, number] = [FIRST_LEVEL_DRIFT.speed[0] * mul, FIRST_LEVEL_DRIFT.speed[1] * mul];
  const speed = rand(band[0], band[1]);
  const vel = v(Math.cos(angle) * speed, Math.sin(angle) * speed);
  const a = new Asteroid(pos, vel, size, undefined, kind ?? "normal");
  // Beat-align the outward crossing of the engage ring (anchored at centre) so
  //   the rock's trajectory dots fall on the grid. The slow band means the
  //   aligner only nudges the ponderous drift, never speeds it up.
  alignVelocityToRhythm(a.pos, a.vel, {
    refPos: { x: cx, y: cy },
    beatTime: game.beatTime,
    speedRange: band,
    engageRadius: engage,
    maxBeats: 24,
    claimed,
  });
  return a;
};

// Wave 0 (internal wave 1): a single large rock — a gentle warm-up before density ramps.
// Wave 1+ (internal wave 2+): 3, 3, 4, 4, 5, 5... per-wave count gives the player a wave to consolidate before density bumps.
//   A single `claimed` set is shared across the wave's spawns (including the
//   standalone solidCrystalSmall roll below — see spawnWave) so each rock
//   targets a distinct beat slot, giving the player a sustainable
//   beat-by-beat target procession.
const spawnWaveAsteroids = (game: Game, claimed: BeatClaimSet, isFirstLevel: boolean) => {
  const totalCount = game.wave === 1 ? 1 : 3 + Math.floor((game.wave - 2) / 2);
  const activeSpecials = activeSpecialsForWave(game, game.wave);
  const normalCount = Math.max(0, totalCount - activeSpecials.length);

  // Pre-roll the kind for each normal slot. On the introductory wave for a
  // given special (firstWave) we force exactly one slot of that kind so the
  // player sees the mechanic at least once; on later waves each slot rolls
  // independently at the configured per-spawn chance. Solid crystal rolls
  // are checked first — when one fires, the slot can't also become a gem rock.
  const slotKinds: AsteroidKind[] = [];
  for (let i = 0; i < normalCount; i++) {
    // Glass prison gated on its firstWave (post-boss). Rolled first so a
    // prison slot can't also pick up a gem or be downgraded to a solid crystal.
    const isPrison = game.wave >= CFG.glassPrison.firstWave && rng() < CFG.glassPrison.perSpawnChance;
    if (isPrison) { slotKinds.push("glassPrison"); continue; }
    const isSolid = game.wave > CFG.solidCrystal.firstWave && rng() < CFG.solidCrystal.perSpawnChance;
    if (isSolid) { slotKinds.push("solidCrystal"); continue; }
    const isGem = game.wave > CFG.goldCrystal.firstWave && rng() < CFG.goldCrystal.perSpawnChance;
    slotKinds.push(isGem ? "goldCrystal" : "normal");
  }
  if (game.wave === CFG.goldCrystal.firstWave && normalCount > 0 && !slotKinds.includes("goldCrystal")) {
    slotKinds[Math.floor(rng() * normalCount)] = "goldCrystal";
  }
  if (game.wave === CFG.solidCrystal.firstWave && normalCount > 0 && !slotKinds.includes("solidCrystal")) {
    slotKinds[Math.floor(rng() * normalCount)] = "solidCrystal";
  }
  // Introductory glassPrison wave is guaranteed one prison so the player meets
  // the new mechanic right away rather than rolling for it.
  if (game.wave === CFG.glassPrison.firstWave && normalCount > 0 && !slotKinds.includes("glassPrison")) {
    slotKinds[Math.floor(rng() * normalCount)] = "glassPrison";
  }

  const firstLevelPlacements = isFirstLevel
    ? sampleFirstLevelPlacements(slotKinds.length, CFG.engageRadius.incoming)
    : null;
  slotKinds.forEach((kind, slotIndex) => {
    const k = kind === "normal" ? undefined : kind;
    // Solid crystal is a medium-sized gem; everything else from this loop spawns large.
    const size: AsteroidSize = kind === "solidCrystal" ? "medium" : "large";
    const rock = isFirstLevel && firstLevelPlacements
      ? spawnFirstLevelDrifter(game, firstLevelPlacements[slotIndex].angle, firstLevelPlacements[slotIndex].dist, k, size, claimed)
      : spawnAsteroidAway(game, 200, k, size, claimed);
    game.asteroids.push(rock);
  });
  for (const kind of activeSpecials) {
    game.asteroids.push(spawnSpecial(game, kind, claimed));
  }
};

// solidCrystalSmall standalone is a "treat", not a fixture; gated chance + late
// first-wave keeps it feeling rare.
const rollSolidCrystalSmallSpawn = (game: Game, claimed: BeatClaimSet) => {
  const cfg = CFG.solidCrystal.smallSpawn;
  if (game.wave >= cfg.firstWave && rng() < cfg.chancePerWave) {
    game.asteroids.push(spawnSolidCrystalSmall(game, claimed));
  }
};
