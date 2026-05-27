import type { Game } from "../Game";
import { dist } from "../vec";
import { Asteroid } from "../Asteroid";
import { Alien, ALIEN_FIRE_PERIOD_BEATS } from "../Alien";
import { Bullet } from "../Bullet";
import { BEAT_GRID } from "./rhythmConstants";
import {
  isInBeatWindow,
  logBeatEvent,
  spawnBeatDebugPopup,
  evaluateClosedBeats,
  currentBeatPulse,
} from "./rhythmGate";
import { BASS_KIND_SOUND, BASS_SPLIT_PITCH_RATIO, tickBassBeats, tickAuxBeats } from "./bassClock";
import { tickWaveEvents } from "./waveEvents";
import { detonateShockwave } from "./shockwave";
import { spawnWave, isBossWave, updateBgBeatIntensity } from "./waveDirector";
import {
  handleCollisions,
  handleAlienHits,
  handleAlienBulletHits,
  handleCometHits,
  handleCanisterPickups,
  handleCanisterShots,
} from "./collisions";
import { startGame, showTitle, togglePause, respawn } from "./lifecycle";
import { syncHud, syncPowerupHud } from "./hud";
import { renderKilledRow } from "./killedParade";
import { updatePopups } from "./popups";
import { emitExplosion } from "./particleBursts";
import { musicDtForFrame } from "./slowMo";

// Why: single dispatcher means main.ts has one update entry; per-state branches live below.
export const updateGame = (game: Game, dt: number) => {
  if (game.input.pressed("escape") || game.input.pressed("esc")) togglePause(game);
  if (game.state === "paused") { game.input.endFrame(); return; }
  game.time += dt * 1000;
  // Why: title/gameover/paused freeze beatTime; playing+dying defer pulsar to after tickBassBeats.
  if (game.state !== "playing" && game.state !== "dying") game.pulsar.update(dt, game.beatTime, BEAT_GRID);
  routeStateUpdate(game, dt);
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 3);
  game.input.endFrame();
};

const routeStateUpdate = (game: Game, dt: number) => {
  if (game.state === "title") updateTitle(game, dt);
  else if (game.state === "gameover") updateGameOver(game, dt);
  else if (game.state === "dying") updateDying(game, dt);
  else updatePlaying(game, dt);
};

// Why: title needs cosmetic motion + enter-to-start; nothing else fires here.
const updateTitle = (game: Game, dt: number) => {
  if (game.input.pressed("enter") || game.input.pressed("return")) startGame(game);
  for (const a of game.asteroids) a.update(dt, game.w, game.h);
  game.particles.update(dt);
};

// Why: gameover drains the bassteroid field one downbeat at a time — music outlives the player.
// Why: bgBeat sub-bass + comet notes keep ticking so the parade has a steady pulse to align to,
//   and the pulsar's beat-driven flash piggybacks on the same beatTime via Pulsar.update().
const updateGameOver = (game: Game, dt: number) => {
  if (game.input.pressed("enter") || game.input.pressed("return")) showTitle(game);
  for (const a of game.asteroids) a.update(dt, game.w, game.h);
  game.beatTime += dt;
  tickAuxBeats(game);
  detonateScheduledBassRocks(game);
  for (const s of game.shards) s.update(dt);
  game.shards = game.shards.filter((s) => s.life > 0);
  game.particles.update(dt);
};

// Why: turns the gameover into a slow rhythmic field-clear instead of a static "you died" screen.
const detonateScheduledBassRocks = (game: Game) => {
  let anyExploded = false;
  for (const a of game.asteroids) {
    if (!a.isBass()) continue;
    if (game.beatTime < a.nextBeatAt) continue;
    const sound = BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"];
    const pitchRatio = BASS_SPLIT_PITCH_RATIO[a.splitLevel] ?? 1;
    game.sound.play(sound, pitchRatio);
    game.sound.stopBassteroidDrone(a);
    a.hp = 0;
    emitExplosion(game.particles, game.shards, a, false);
    anyExploded = true;
  }
  if (anyExploded) game.asteroids = game.asteroids.filter((a: Asteroid) => !(a.isBass() && a.hp <= 0));
};

// Why: world keeps running while the ship is gone — music, beats, aliens, comets all play on.
// The ship's alive=false flag already gates firing, rendering, and collisions.
const updateDying = (game: Game, dt: number) => {
  game.dyingTimer -= dt;
  updatePlaying(game, dt);
  if (game.dyingTimer > 0) return;
  if (game.lives <= 0) transitionToGameOver(game);
  else respawn(game);
};

const transitionToGameOver = (game: Game) => {
  game.state = "gameover";
  game.sound.stopAllAlienDrones();
  game.sound.stopAllBassteroidDrones();
  game.sound.stopAllCometShimmers();
  game.comets = [];
  game.overlayTitleEl.textContent = "Game Over";
  game.overlayStartEl.innerHTML = `score <strong>${String(game.score).padStart(6, "0")}</strong> &nbsp;·&nbsp; press <span class="key">enter</span> to restart`;
  game.overlayEl.classList.remove("hidden");
  renderKilledRow(game);
};

// Why: ordered phases (ship → bass → world → collisions) so cause-and-effect reads top-down.
const updatePlaying = (game: Game, dt: number) => {
  const bulletsBeforeShipUpdate = game.bullets.length;
  game.ship.setCombo(game.beatCombo);
  game.ship.update(dt, game.input, game.particles, game.bullets, game.w, game.h, game.time, game.sound);
  const musicDt = tickSlowMoTimer(game, dt);
  tickBassBeats(game, musicDt);
  // Why: pulsar runs against freshly-advanced beatTime so its flash lands with the bass voices.
  game.pulsar.update(dt, game.beatTime, BEAT_GRID);
  game.ship.tickComboHalo(musicDt, currentBeatPulse(game));
  if (game.bullets.length > bulletsBeforeShipUpdate) classifyNewBullets(game, bulletsBeforeShipUpdate);
  graceFrameNearAsteroids(game);
  tickWavePhase(game, dt, musicDt);
  tickWorldEntities(game, dt, musicDt);
  game.particles.update(dt);
  game.popups = updatePopups(game.popups, dt);
  runCollisionPasses(game);
  evaluateClosedBeats(game);
  syncPowerupHud(game);
  if (game.asteroids.length === 0) advanceWave(game);
};

// Why: slow-mo timer ticks in wall-clock so its lifespan isn't extended by its own effect.
const tickSlowMoTimer = (game: Game, dt: number): number => {
  if (game.slowMoTimer > 0) game.slowMoTimer = Math.max(0, game.slowMoTimer - dt);
  return musicDtForFrame(dt, game.slowMoTimer);
};

// Why: ≤1 fire event per frame, but trident emits 3 bullets — they all share one beat flag.
const classifyNewBullets = (game: Game, firstNewIndex: number) => {
  const newBullets = game.bullets.slice(firstNewIndex);
  const firedOnBeat = isInBeatWindow(game, game.beatTime);
  for (const newBullet of newBullets) newBullet.firedAtBeatTime = game.beatTime;
  logBeatEvent(game, "FIRE", game.beatTime, `bullets=${newBullets.length}`);
  spawnBeatDebugPopup(game, game.ship.pos, game.beatTime, "FIRE");
  if (firedOnBeat) handleOnBeatFire(game, newBullets);
  else handleOffBeatFire(game);
  // Why: deeper fireBeat pluck reinforces "you nailed the beat"; ship no longer plays its own.
  game.sound.play(firedOnBeat ? "fireBeat" : "fire");
};

// Why: 0→1 priming step; above 1 only on-beat hits + beat closures bump combo, not consecutive fires.
const handleOnBeatFire = (game: Game, newBullets: Bullet[]) => {
  // Why: boosted bullets fly while the yellow halo (combo ≥ 4, tier 2) is up.
  const boosted = game.ship.comboHaloTier >= 2;
  for (const newBullet of newBullets) {
    newBullet.onBeat = true;
    newBullet.boosted = boosted;
  }
  game.sound.play("comboTick");
  if (game.beatCombo === 0) {
    game.beatCombo = 1;
    syncHud(game);
  }
};

// Why: latch break till next beat closure so a kill on the same frame still rides the prior streak.
const handleOffBeatFire = (game: Game) => {
  game.firedOffBeatSinceLastBeat = true;
};

// Why: cheap respawn-grace — extend invuln if a rock is still inside the safe radius near the end.
const graceFrameNearAsteroids = (game: Game) => {
  if (!(game.ship.invuln > 0 && game.ship.invuln < 0.4)) return;
  const safeRadius = 130;
  for (const a of game.asteroids) {
    if (dist(a.pos, game.ship.pos) < safeRadius) { game.ship.invuln = 0.4; return; }
  }
};

// Why: shockwave's actual detonation lands one frame later when pulsar.shockJustFired flips.
const tickWavePhase = (game: Game, dt: number, _musicDt: number) => {
  game.waveElapsed += dt;
  tickWaveEvents(game.waveEvents, game.waveElapsed);
  if (game.pulsar.shockJustFired) detonateShockwave(game);
};

// Why: asteroids use musicDt (slow with music); comets/bullets keep wall-clock to avoid double-slow.
const tickWorldEntities = (game: Game, dt: number, musicDt: number) => {
  for (const c of game.comets) c.update(dt, game.w, game.h);
  pruneDeadComets(game);
  for (const a of game.asteroids) a.update(musicDt, game.w, game.h);
  for (const al of game.aliens) al.update(dt, game.w, game.h);
  tickAlienFire(game);
  for (const b of game.bullets) b.update(dt, game.w, game.h);
  game.bullets = game.bullets.filter((b) => b.life > 0);
  for (const ab of game.alienBullets) ab.update(dt, game.w, game.h);
  game.alienBullets = game.alienBullets.filter((ab) => ab.life > 0);
  for (const s of game.shards) s.update(dt);
  game.shards = game.shards.filter((s) => s.life > 0);
  for (const c of game.canisters) c.update(dt, game.w, game.h);
  game.canisters = game.canisters.filter((c) => c.alive);
};

// Why: pruning is a separate pass so we don't mutate game.comets mid-iteration of the update loop.
const pruneDeadComets = (game: Game) => {
  const survivingComets = [];
  for (const c of game.comets) {
    if (c.alive) survivingComets.push(c);
    else game.sound.stopCometShimmer(c);
  }
  game.comets = survivingComets;
};

// Why: shots aim at the player's pos at fire-time — dodging works by moving between beats.
const tickAlienFire = (game: Game) => {
  if (game.aliens.length === 0) return;
  for (const a of game.aliens) {
    while (game.beatTime >= a.nextFireAt) fireOneAlienShot(game, a);
  }
};

const fireOneAlienShot = (game: Game, a: Alien) => {
  if (game.ship.alive) {
    game.alienBullets.push(a.fireAt(game.ship.pos));
    const fireSound = a.size === "big" ? "alienFireBig" : a.size === "medium" ? "alienFireMedium" : "alienFireSmall";
    game.sound.play(fireSound);
  } else {
    a.fireFlash = 1;
  }
  a.nextFireAt += ALIEN_FIRE_PERIOD_BEATS[a.size] * BEAT_GRID;
};

// Why: collisions run before evaluateClosedBeats so trailing-edge closures see this frame's kills.
const runCollisionPasses = (game: Game) => {
  handleCollisions(game);
  handleAlienHits(game);
  handleAlienBulletHits(game);
  handleCometHits(game);
  handleCanisterPickups(game);
  handleCanisterShots(game);
};

// Why: detect boss wave here so we can lock the planet hidden — a defeated boss must not reappear.
const advanceWave = (game: Game) => {
  const wasBossWave = isBossWave(game.wave);
  game.wave += 1;
  game.sound.play("waveClear");
  game.sound.play("pulsarHum");
  game.pulsar.waveClear();
  game.pulsar.setWaveLevel(game.wave);
  updateBgBeatIntensity(game);
  if (wasBossWave) game.pulsar.setBossPlanetState("defeated");
  spawnWave(game);
  syncHud(game);
};
