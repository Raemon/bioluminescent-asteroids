import type { Game } from "../Game";
import { Asteroid, AsteroidKind, BASS_MEASURE_LENGTH, SIZE_SPAWN_SPEED, spawnAsteroidAtEdge, spawnBossAt } from "../Asteroid";
import { spawnComet as spawnCometAtEdge } from "../Comet";
import { AlienSize, spawnAlienAtEdge } from "../Alien";
import { spawnCanister } from "../Canister";
import { rand } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { spawnAwayFromShip } from "./spawnAwayFromShip";
import { newWaveEventSchedule, maybeSchedule } from "./waveEvents";
import { startShockwave } from "./shockwave";
import { emitCrackParticles } from "./particleBursts";
import { alignVelocityToRhythm, BeatClaimSet, newBeatClaimSet } from "./rhythmTrajectory";

// 0.5 s (one BEAT_GRID) of bullet flight = 310 px at the ship's 620 px/s
// muzzle velocity. An asteroid crossing this ring on beat N+1 can be hit by
// a bullet fired on beat N — the canonical "fire to the metronome" rhythm
// that drives the combo system. Closer rings collapse fire and hit to the
// same beat; farther rings push the hit out to beat N+2 (harder to track).
const INCOMING_ENGAGE_RADIUS = 310;

// split children spawn essentially on top of the ship (right where the
// parent died); the player's natural follow-up shot lands when they've
// drifted ~150 px outward — far enough that the bullet flight (~0.25 s) is
// short and the hit can land on the *next* beat after the kill, which is
// exactly when the player will fire next.
const SPLIT_ENGAGE_RADIUS = 150;

// snap each fresh edge-spawn so its crossing of the player's natural
// kill range lands on a beat. Boss is exempt — it has its own slow drift.
//
// Reference point is the screen centre, *not* the ship — incoming rocks take
// several seconds to cross the field, by which time a moving ship has long
// left where it was. Using the screen centre as the encounter anchor means
// the timing is stable: the player can position themselves anywhere near
// the centre and still get a predictable beat-aligned procession of rocks.
const alignIncomingToRhythm = (game: Game, a: Asteroid, claimed?: BeatClaimSet) => {
  if (a.isBoss()) return;
  const range = SIZE_SPAWN_SPEED[a.size];
  const centre = { x: game.w / 2, y: game.h / 2 };
  alignVelocityToRhythm(a.pos, a.vel, {
    refPos: centre,
    beatTime: game.beatTime,
    speedRange: range,
    engageRadius: INCOMING_ENGAGE_RADIUS,
    // edge spawns sit far away — many beats out. Allowing up to 24
    // candidate slots covers even the slowest large rock's crossing time.
    maxBeats: 24,
    claimed,
  });
};

// a split child inherits the bullet's impact velocity (fast, fan-shaped)
// and starts essentially on top of the ship. We let its outward speed flex
// ±~35% so the moment it reaches SPLIT_ENGAGE_RADIUS lands on a beat — and
// give it up to ±18 px of position nudge along its outward direction as a
// second degree of freedom (reads as "explosion shoved it a bit further
// out", not a teleport). Min 1 beat ahead so the player has at least 500 ms
// to react and re-aim. Sibling children share a `claimed` set so a parent's
// two kids end up on adjacent beats rather than colliding on one.
//
// refVel = ship.vel because an actively-flying player covers 200–460 px
// in the 1–2 beat alignment window — more than a ring radius. Without this
// the debris is aligned to a stale "ghost ship" position and a moving
// player never sees combo-able children.
export const alignSplitChildToRhythm = (game: Game, child: Asteroid, claimed?: BeatClaimSet) => {
  if (child.isBoss()) return;
  const speed = Math.hypot(child.vel.x, child.vel.y);
  if (speed < 1) return;
  alignVelocityToRhythm(child.pos, child.vel, {
    refPos: game.ship.pos,
    refVel: game.ship.vel,
    beatTime: game.beatTime,
    speedRange: [speed * 0.65, speed * 1.35],
    engageRadius: SPLIT_ENGAGE_RADIUS,
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

// when true, upgrades free-spawn during waves; when false, upgrades only come from cracking gems.
const FEATURE_FREE_UPGRADE_SPAWNS = false;

// mid-wave window means the canister can't appear at warm-up start nor wave-clear end.
const CANISTER_FIRST_WAVE = 3;
const CANISTER_CHANCE_PER_WAVE = 1 / 3;
const CANISTER_SPAWN_WINDOW: [number, number] = [8, 24];

// wave 4+ ~1/3 chance so the saucer feels like an "event", not a fixed wave fixture.
//   Each alien size now rolls independently — see rollHeadlineEvents — so this is
//   the *summed* base chance, split across sizes by the current wave's size distribution.
const ALIEN_FIRST_WAVE = 4;
const ALIEN_CHANCE_PER_WAVE = 1 / 3;
const ALIEN_SPAWN_WINDOW: [number, number] = [5, 22];

// Rhythm (beatCombo) bumps headline-event spawn chances additively.
//   +1% per rhythm, applied to each alien size's roll and to the shockwave roll.
const RHYTHM_SPAWN_CHANCE_PER_COMBO = 0.01;
// Rhythm also multiplies the spawn speed of created world objects (asteroids,
//   aliens, comets, canisters) by +5% per rhythm. Player ship + bullets exempt.
const RHYTHM_SPAWN_SPEED_PER_COMBO = 0.05;
export const rhythmSpeedMul = (game: Game): number => 1 + game.beatCombo * RHYTHM_SPAWN_SPEED_PER_COMBO;
const rhythmChanceBonus = (game: Game): number => game.beatCombo * RHYTHM_SPAWN_CHANCE_PER_COMBO;

// per-wave share of each alien size — early waves bias to small/medium so
//   the player isn't crushed by a 4-HP saucer's debut. Each size rolls
//   independently in rollHeadlineEvents, so the share scales the *base*
//   chance before the rhythm bonus is added.
const alienSizeShare = (wave: number, size: AlienSize): number => {
  if (wave < 6) return size === "small" ? 0.7 : size === "medium" ? 0.3 : 0;
  if (wave < 10) return size === "small" ? 0.45 : size === "medium" ? 0.4 : 0.15;
  return size === "small" ? 0.3 : size === "medium" ? 0.35 : 0.35;
};

// shockwave / comet / alien are the three "headline" wave events. When one rolls,
// the remaining ones are dampened so a single wave rarely stacks two of them.
const HEADLINE_EVENT_DAMPEN = 0.35;

// tink stays off the unlock order so it reads as a treat, not a guaranteed sound.
const TINK_FIRST_WAVE = 4;
const TINK_CHANCE_PER_WAVE = 1 / 3;

// Gold-crystal asteroid: a "normal" rock with a faintly visible embedded
// gold gem. Killing it drops a collectible GoldCrystal pickup plus a small
// rubble cloud. Wave 4 is the introductory wave — exactly one gem rock
// guaranteed so the player sees the mechanic. Wave 5+, each spawned normal
// rock has a flat 25% chance to be a gem rock; lets the density scale with
// wave count without further tuning.
const GOLD_CRYSTAL_FIRST_WAVE = 4;
const GOLD_CRYSTAL_PER_SPAWN_CHANCE = 0.25;

// foreshadow wave swells the looming planet; boss wave hides it and spawns the boss instead.
const BOSS_WAVES = [11] as const;
const BOSS_FORESHADOW_WAVES = [10] as const;

// comet enters at wave 3 (alongside bassteroids) so its melody always weaves over a bass bed.
const COMET_FIRST_WAVE = 3;
const COMET_CHANCE_PER_WAVE = 0.6;
const COMET_SPAWN_WINDOW: [number, number] = [4, 16];
const COMET_LIFETIME: [number, number] = [22, 30];

// gated to wave 4+ so early-game stays focused on core mechanics before the field reshapes.
const SHOCKWAVE_FIRST_WAVE = 4;
const SHOCKWAVE_CHANCE_PER_WAVE = 1 / 20;
const SHOCKWAVE_SPAWN_WINDOW: [number, number] = [6, 22];

// predicates let the wave director read declaratively, not as inline boolean expressions.
export const isBossWave = (wave: number): boolean => (BOSS_WAVES as readonly number[]).includes(wave);
export const isBossForeshadowWave = (wave: number): boolean => (BOSS_FORESHADOW_WAVES as readonly number[]).includes(wave);

// ramp 0.08 → 1.0 across waves 1–31; player reaches the pulsar by wave 31 so rumble peaks.
export const updateBgBeatIntensity = (game: Game) => {
  // a deliberate per-wave set wins over any in-flight calibration→play loudness ramp.
  game.beatIntensityRamp = null;
  const ramp = Math.max(0, Math.min(1, (game.wave - 1) / 30));
  game.sound.bgBeatIntensity = 0.08 + ramp * 0.92;
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

// tink has a fixed small size + kind so we roll it outside activeSpecialsForWave.
const spawnTink = (game: Game, claimed?: BeatClaimSet): Asteroid =>
  spawnAsteroidAway(game, 200, "tink", "small", claimed);

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
  c.lifetime = rand(COMET_LIFETIME[0], COMET_LIFETIME[1]);
  const cometEntryLead = 0.6;
  c.nextNoteBeatTime = Math.ceil((game.beatTime + cometEntryLead) / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
  const cometSpeed = Math.hypot(c.vel.x, c.vel.y);
  if (cometSpeed > 0) {
    const centre = { x: game.w / 2, y: game.h / 2 };
    alignVelocityToRhythm(c.pos, c.vel, {
      refPos: centre,
      beatTime: game.beatTime,
      speedRange: [cometSpeed * 0.85, cometSpeed * 1.15],
      engageRadius: INCOMING_ENGAGE_RADIUS,
      maxBeats: 24,
    });
  }
  applyRhythmSpeed(game, c.vel);
  game.comets.push(c);
  game.sound.startCometShimmer(c, c.pos);
};

// one entry replaces the previous if/else maze covering boss/foreshadow/normal wave dispatch.
//   One `claimed` set is shared across the wave's asteroid + tink rolls so
//   each fresh rock takes a distinct beat slot — the result is a steady
//   beat-by-beat target procession the player can combo through.
// Tutorial: a single small practice rock, rhythm-aligned like a normal spawn so
//   its first-beat dot is meaningful, with a little materialize puff so a respawn
//   reads as "a fresh one drifts in".
export const spawnTutorialSmall = (game: Game) => {
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

  if (handleBossWave(game)) return;
  setForeshadowState(game);
  rollWaveEvents(game);
  const claimed = newBeatClaimSet();
  spawnWaveAsteroids(game, claimed);
  rollTinkSpawn(game, claimed);
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
// HEADLINE_EVENT_DAMPEN so a single wave rarely stacks two of them.
// Order is randomised each wave to keep the suppression symmetric.
const rollWaveEvents = (game: Game) => {
  if (FEATURE_FREE_UPGRADE_SPAWNS && game.wave >= CANISTER_FIRST_WAVE) {
    maybeSchedule(game.waveEvents, CANISTER_CHANCE_PER_WAVE, CANISTER_SPAWN_WINDOW, () => {
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
  const alienGate = game.wave >= ALIEN_FIRST_WAVE;
  const alienSizeRoll = (size: AlienSize): HeadlineRoll => ({
    gate: alienGate && alienSizeShare(game.wave, size) > 0,
    baseChance: ALIEN_CHANCE_PER_WAVE * alienSizeShare(game.wave, size) + bonus,
    fire: () => {
      maybeSchedule(game.waveEvents, 1, ALIEN_SPAWN_WINDOW, () => spawnAlien(game, size));
      return true;
    },
  });

  const rolls: HeadlineRoll[] = [
    {
      gate: game.wave >= SHOCKWAVE_FIRST_WAVE,
      baseChance: SHOCKWAVE_CHANCE_PER_WAVE + bonus,
      fire: () => {
        maybeSchedule(game.waveEvents, 1, SHOCKWAVE_SPAWN_WINDOW, () => startShockwave(game));
        return true;
      },
    },
    {
      gate: game.wave >= COMET_FIRST_WAVE,
      baseChance: COMET_CHANCE_PER_WAVE,
      fire: () => {
        maybeSchedule(game.waveEvents, 1, COMET_SPAWN_WINDOW, () => spawnComet(game));
        return true;
      },
    },
    alienSizeRoll("small"),
    alienSizeRoll("medium"),
    alienSizeRoll("big"),
  ];

  // randomise order so no single event always gets the un-dampened first roll.
  for (let i = rolls.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rolls[i], rolls[j]] = [rolls[j], rolls[i]];
  }

  let dampen = 1;
  for (const r of rolls) {
    if (!r.gate) continue;
    if (Math.random() >= r.baseChance * dampen) continue;
    r.fire();
    dampen *= HEADLINE_EVENT_DAMPEN;
  }
};

// Wave 1: a single large rock — a gentle warm-up before density ramps.
// Waves 2+: 3, 3, 4, 4, 5, 5... per-wave count gives the player a wave to consolidate before density bumps.
//   A single `claimed` set is shared across the wave's spawns (including the
//   tink roll below — see spawnWave) so each rock targets a distinct beat
//   slot, giving the player a sustainable beat-by-beat target procession.
const spawnWaveAsteroids = (game: Game, claimed: BeatClaimSet) => {
  const totalCount = game.wave === 1 ? 1 : 3 + Math.floor((game.wave - 2) / 2);
  const activeSpecials = activeSpecialsForWave(game, game.wave);
  const normalCount = Math.max(0, totalCount - activeSpecials.length);

  // Pre-roll the kind for each normal slot. On the introductory wave
  // (GOLD_CRYSTAL_FIRST_WAVE) we force exactly one slot to be a gem rock so
  // the player sees the mechanic; on later waves each slot rolls
  // independently at GOLD_CRYSTAL_PER_SPAWN_CHANCE.
  const slotKinds: AsteroidKind[] = [];
  for (let i = 0; i < normalCount; i++) {
    const isGem = game.wave > GOLD_CRYSTAL_FIRST_WAVE && Math.random() < GOLD_CRYSTAL_PER_SPAWN_CHANCE;
    slotKinds.push(isGem ? "goldCrystal" : "normal");
  }
  if (game.wave === GOLD_CRYSTAL_FIRST_WAVE && normalCount > 0 && !slotKinds.includes("goldCrystal")) {
    slotKinds[Math.floor(Math.random() * normalCount)] = "goldCrystal";
  }

  for (const kind of slotKinds) {
    const k = kind === "goldCrystal" ? "goldCrystal" : undefined;
    game.asteroids.push(spawnAsteroidAway(game, 200, k, "large", claimed));
  }
  for (const kind of activeSpecials) {
    game.asteroids.push(spawnSpecial(game, kind, claimed));
  }
};

// tink is a "treat", not a fixture; gated chance + late first-wave keeps it feeling rare.
const rollTinkSpawn = (game: Game, claimed: BeatClaimSet) => {
  if (game.wave >= TINK_FIRST_WAVE && Math.random() < TINK_CHANCE_PER_WAVE) {
    game.asteroids.push(spawnTink(game, claimed));
  }
};
