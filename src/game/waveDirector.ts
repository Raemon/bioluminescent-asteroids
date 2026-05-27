import type { Game } from "../Game";
import { Asteroid, AsteroidKind, BASS_MEASURE_LENGTH, spawnAsteroidAtEdge, spawnBossAt } from "../Asteroid";
import { spawnComet as spawnCometAtEdge } from "../Comet";
import { AlienSize, ALIEN_FIRE_PERIOD_BEATS, spawnAlienAtEdge } from "../Alien";
import { spawnCanister } from "../Canister";
import { rand } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { spawnAwayFromShip } from "./spawnAwayFromShip";
import { newWaveEventSchedule, maybeSchedule } from "./waveEvents";
import { startShockwave } from "./shockwave";

// Why: mid-wave window means the canister can't appear at warm-up start nor wave-clear end.
const CANISTER_CHANCE_PER_WAVE = 1 / 3;
const CANISTER_SPAWN_WINDOW: [number, number] = [8, 24];

// Why: wave 3+ ~1/3 chance so the saucer feels like an "event", not a fixed wave fixture.
const ALIEN_FIRST_WAVE = 3;
const ALIEN_CHANCE_PER_WAVE = 1 / 3;
const ALIEN_SPAWN_WINDOW: [number, number] = [5, 22];

// Why: tink stays off the unlock order so it reads as a treat, not a guaranteed sound.
const TINK_FIRST_WAVE = 3;
const TINK_CHANCE_PER_WAVE = 1 / 3;

// Why: foreshadow wave swells the looming planet; boss wave hides it and spawns the boss instead.
const BOSS_WAVES = [10] as const;
const BOSS_FORESHADOW_WAVES = [9] as const;

// Why: comet enters at wave 2 (alongside bassteroids) so its melody always weaves over a bass bed.
const COMET_FIRST_WAVE = 2;
const COMET_CHANCE_PER_WAVE = 0.6;
const COMET_SPAWN_WINDOW: [number, number] = [4, 16];
const COMET_LIFETIME: [number, number] = [22, 30];

// Why: gated to wave 3+ so early-game stays focused on core mechanics before the field reshapes.
const SHOCKWAVE_FIRST_WAVE = 3;
const SHOCKWAVE_CHANCE_PER_WAVE = 1 / 5;
const SHOCKWAVE_SPAWN_WINDOW: [number, number] = [6, 22];

// Why: predicates let the wave director read declaratively, not as inline boolean expressions.
export const isBossWave = (wave: number): boolean => (BOSS_WAVES as readonly number[]).includes(wave);
export const isBossForeshadowWave = (wave: number): boolean => (BOSS_FORESHADOW_WAVES as readonly number[]).includes(wave);

// Why: ramp 0.08 → 1.0 across waves 1–30; player reaches the pulsar by wave 30 so rumble peaks.
export const updateBgBeatIntensity = (game: Game) => {
  const ramp = Math.max(0, Math.min(1, (game.wave - 1) / 29));
  game.sound.bgBeatIntensity = 0.08 + ramp * 0.92;
};

// Why: snap-to-grid guarantees every bassteroid fires on a pulsar beat despite float drift.
export const alignBassBeat = (game: Game, asteroid: Asteroid) => {
  if (!asteroid.isBass()) return;
  const gridSnappedOffset = Math.round(asteroid.measureOffset / BEAT_GRID) * BEAT_GRID;
  asteroid.measureOffset = gridSnappedOffset;
  const k = Math.ceil((game.beatTime - gridSnappedOffset - 1e-6) / BASS_MEASURE_LENGTH);
  const raw = k * BASS_MEASURE_LENGTH + gridSnappedOffset;
  asteroid.nextBeatAt = Math.round(raw / BEAT_GRID) * BEAT_GRID;
};

// Why: early waves bias to small/medium so the player isn't crushed by a 4-HP saucer's debut.
export const rollAlienSize = (wave: number): AlienSize => {
  if (wave < 5) return Math.random() < 0.7 ? "small" : "medium";
  if (wave < 9) {
    const r = Math.random();
    if (r < 0.45) return "small";
    if (r < 0.85) return "medium";
    return "big";
  }
  const r = Math.random();
  if (r < 0.3) return "small";
  if (r < 0.65) return "medium";
  return "big";
};

// Why: paired-wave intro (one bass, then both, then decorators) trains the player gradually.
export const activeSpecialsForWave = (game: Game, wave: number): AsteroidKind[] => {
  if (wave < 2) return [];
  if (wave === 2) return [game.bassOrder[0]];
  if (wave === 3) return [game.bassOrder[1]];
  const specials: AsteroidKind[] = [game.bassOrder[0], game.bassOrder[1]];
  const lateUnlockOrder: AsteroidKind[] = ["chime", "bell", "warble", game.bassOrder[2], game.bassOrder[3]];
  // Why: pair waves hold each new sound steady so the player has time to learn it before the next.
  const lateCount = Math.max(0, Math.min(lateUnlockOrder.length, Math.floor((wave - 4) / 2)));
  for (let i = 0; i < lateCount; i++) specials.push(lateUnlockOrder[i]);
  return specials;
};

// Why: shared retry helper keeps the "no rock on top of the ship" rule in one place.
const spawnAsteroidAway = (game: Game, minDist: number, kind?: AsteroidKind, size?: "large" | "medium" | "small") =>
  spawnAwayFromShip(() => spawnAsteroidAtEdge(game.w, game.h, undefined, kind, size), game.ship.pos, minDist);

// Why: specials need alignBassBeat so their first downbeat lands on the pulsar grid immediately.
const spawnSpecial = (game: Game, kind: AsteroidKind): Asteroid => {
  const a = spawnAsteroidAway(game, 220, kind);
  alignBassBeat(game, a);
  return a;
};

// Why: tink has a fixed small size + kind so we roll it outside activeSpecialsForWave.
const spawnTink = (game: Game): Asteroid => spawnAsteroidAway(game, 200, "tink", "small");

// Why: pre-align first fire to the global beat so saucer shots sync to the rhythm immediately.
export const spawnAlien = (game: Game, size: AlienSize) => {
  const a = spawnAwayFromShip(() => spawnAlienAtEdge(game.w, game.h, size), game.ship.pos, 260, 6);
  const period = ALIEN_FIRE_PERIOD_BEATS[size] * BEAT_GRID;
  a.nextFireAt = Math.ceil((game.beatTime + 0.5) / period) * period;
  game.aliens.push(a);
  game.sound.startAlienDrone(a, size);
};

// Why: shimmer fades up ~one beat before the first note so the comet sounds like it arrives, then plays.
export const spawnComet = (game: Game) => {
  const c = spawnCometAtEdge(game.w, game.h);
  c.lifetime = rand(COMET_LIFETIME[0], COMET_LIFETIME[1]);
  c.nextNoteBeatTime = Math.ceil((game.beatTime + 0.6) / BEAT_GRID) * BEAT_GRID;
  game.comets.push(c);
  game.sound.startCometShimmer(c);
};

// Why: one entry replaces the previous if/else maze covering boss/foreshadow/normal wave dispatch.
export const spawnWave = (game: Game) => {
  game.asteroids = [];
  game.canisters = [];
  game.waveEvents = newWaveEventSchedule();
  game.waveElapsed = 0;

  if (handleBossWave(game)) return;
  setForeshadowState(game);
  rollWaveEvents(game);
  spawnWaveAsteroids(game);
  rollTinkSpawn(game);
  rollAlienSpawn(game);
};

// Why: capture planet pos BEFORE hiding it so the boss materialises where the player last saw the planet.
const handleBossWave = (game: Game): boolean => {
  if (!isBossWave(game.wave)) return false;
  const pos = game.pulsar.bossPlanetPos();
  game.pulsar.setBossPlanetState("active");
  game.asteroids.push(spawnBossAt(pos, game.w, game.h));
  return true;
};

// Why: foreshadow wave swells the planet visibly; idle fallback handles edge cases like state restart.
const setForeshadowState = (game: Game) => {
  if (isBossForeshadowWave(game.wave)) {
    game.pulsar.setBossPlanetState("foreshadow");
  } else if (game.pulsar.bossPlanetState === "foreshadow") {
    game.pulsar.setBossPlanetState("idle");
  }
};

// Why: each event rolls independently so we can't get e.g. canister + shockwave coupled by accident.
const rollWaveEvents = (game: Game) => {
  maybeSchedule(game.waveEvents, CANISTER_CHANCE_PER_WAVE, CANISTER_SPAWN_WINDOW, () => {
    game.canisters.push(spawnCanister(game.w, game.h, game.ship.pos));
    game.sound.play("canisterAppear");
  });
  if (game.wave >= SHOCKWAVE_FIRST_WAVE) {
    maybeSchedule(game.waveEvents, SHOCKWAVE_CHANCE_PER_WAVE, SHOCKWAVE_SPAWN_WINDOW, () => startShockwave(game));
  }
  if (game.wave >= COMET_FIRST_WAVE) {
    maybeSchedule(game.waveEvents, COMET_CHANCE_PER_WAVE, COMET_SPAWN_WINDOW, () => spawnComet(game));
  }
};

// Why: 3, 3, 4, 4, 5, 5... per-wave count gives the player a wave to consolidate before density bumps.
const spawnWaveAsteroids = (game: Game) => {
  const totalCount = 3 + Math.floor((game.wave - 1) / 2);
  const activeSpecials = activeSpecialsForWave(game, game.wave);
  const normalCount = Math.max(0, totalCount - activeSpecials.length);

  const newAsteroidIndices = Array.from({ length: normalCount }, (_, i) => i);
  for (const _ of newAsteroidIndices) {
    game.asteroids.push(spawnAsteroidAway(game, 200));
  }
  for (const kind of activeSpecials) {
    game.asteroids.push(spawnSpecial(game, kind));
  }
};

// Why: tink is a "treat", not a fixture; gated chance + late first-wave keeps it feeling rare.
const rollTinkSpawn = (game: Game) => {
  if (game.wave >= TINK_FIRST_WAVE && Math.random() < TINK_CHANCE_PER_WAVE) {
    game.asteroids.push(spawnTink(game));
  }
};

// Why: size rolled at schedule-time and closed over the firing callback so it can't change mid-wave.
const rollAlienSpawn = (game: Game) => {
  if (game.wave < ALIEN_FIRST_WAVE || Math.random() >= ALIEN_CHANCE_PER_WAVE) return;
  const size = rollAlienSize(game.wave);
  maybeSchedule(game.waveEvents, 1, ALIEN_SPAWN_WINDOW, () => spawnAlien(game, size));
};
