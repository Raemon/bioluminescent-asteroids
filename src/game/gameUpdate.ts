import type { Game } from "../Game";
import { dist } from "../vec";
import { Asteroid } from "../Asteroid";
import { Alien, ALIEN_FIRE_PATTERN_BEATS } from "../Alien";
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
import { showWaveSummary } from "./waveSummary";
import {
  handleCollisions,
  handleAlienHits,
  handleAlienBulletHits,
  handleCometHits,
  handleCanisterPickups,
  handleCanisterShots,
  handleGoldCrystalPickups,
} from "./collisions";
import { startGame, showTitle, togglePause, respawn, setFirstWaveHintStage, setFirstWaveHintSubVisible, emitFirstWaveHintProgress, emitFirstWaveHintRhythmProgress } from "./lifecycle";
import { syncHud, syncPowerupHud } from "./hud";
import { renderKilledRow, stopParade } from "./killedParade";
import { updatePopups } from "./popups";
import { emitExplosion } from "./particleBursts";
import { musicDtForFrame } from "./slowMo";
import { hideScoreEntry, isScoreEntryBlockingEnter, showScoreEntry, tickLeaderboardKeyRepeat } from "./scoreEntry";

// single dispatcher means main.ts has one update entry; per-state branches live below.
export const updateGame = (game: Game, dt: number) => {
  if (game.input.pressed("escape") || game.input.pressed("esc")) togglePause(game);
  else if (game.state === "paused" && (game.input.pressed("enter") || game.input.pressed("return"))) togglePause(game);
  if (game.state === "paused") { game.input.endFrame(); return; }
  game.time += dt * 1000;
  // title/gameover/paused freeze beatTime; playing+dying defer pulsar to after tickBassBeats.
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

// title needs cosmetic motion + enter-to-start; nothing else fires here.
const updateTitle = (game: Game, dt: number) => {
  if (game.input.pressed("enter") || game.input.pressed("return")) startGame(game);
  tickLeaderboardKeyRepeat(game, dt);
  for (const a of game.asteroids) a.update(dt, game.w, game.h);
  game.particles.update(dt);
};

// gameover drains the bassteroid field one downbeat at a time — music outlives the player.
// bgBeat sub-bass + comet notes keep ticking so the parade has a steady pulse to align to,
//   and the pulsar's beat-driven flash piggybacks on the same beatTime via Pulsar.update().
const updateGameOver = (game: Game, dt: number) => {
  // Escape dismisses score entry so the player can skip submission and press Enter to restart.
  //   Handled here in addition to the input-level listener for the case where the player clicked
  //   outside the input before pressing Escape.
  if (game.input.pressed("escape") || game.input.pressed("esc")) hideScoreEntry(game);
  const enterPressed = game.input.pressed("enter") || game.input.pressed("return");
  if (enterPressed && !isScoreEntryBlockingEnter(game)) {
    stopParade(game);
    game.killedRowEl.classList.add("hidden");
    game.killedSnapshots = [];
    showTitle(game);
  }
  // Up/down navigate the leaderboard once the callsign input isn't focused —
  //   otherwise arrow keys would scroll the list while the player is typing.
  if (document.activeElement !== game.scoreEntryInputEl) {
    tickLeaderboardKeyRepeat(game, dt);
  }
  for (const a of game.asteroids) a.update(dt, game.w, game.h);
  game.beatTime += dt;
  tickAuxBeats(game);
  detonateScheduledBassRocks(game);
  for (const s of game.shards) s.update(dt);
  game.shards = game.shards.filter((s) => s.life > 0);
  game.particles.update(dt);
};

// turns the gameover into a slow rhythmic field-clear instead of a static "you died" screen.
const detonateScheduledBassRocks = (game: Game) => {
  let anyExploded = false;
  for (const a of game.asteroids) {
    if (!a.isBass()) continue;
    if (game.beatTime < a.nextBeatAt) continue;
    const sound = BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"];
    const pitchRatio = BASS_SPLIT_PITCH_RATIO[a.splitLevel] ?? 1;
    game.sound.play(sound, pitchRatio, a.pos);
    game.sound.stopBassteroidDrone(a);
    a.hp = 0;
    emitExplosion(game.particles, game.shards, a, false);
    anyExploded = true;
  }
  if (anyExploded) game.asteroids = game.asteroids.filter((a: Asteroid) => !(a.isBass() && a.hp <= 0));
};

// world keeps running while the ship is gone — music, beats, aliens, comets all play on.
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
  game.sound.stopHaloAmbient();
  game.comets = [];
  game.lastRunScore = game.score;
  game.lastRunScoreId = null;
  game.overlayTitleEl.textContent = "Game Over";
  game.overlayStartEl.innerHTML = `score <strong>${String(game.score).padStart(6, "0")}</strong> &nbsp;·&nbsp; press <span class="key">enter</span> to restart`;
  game.overlayEl.classList.remove("hidden");
  renderKilledRow(game);
  showScoreEntry(game);
};

import { HALO_MUSIC_POOL, pickHaloMusicVariation } from "./haloMusicConfig";
import { BASS_MEASURE_LENGTH } from "../Asteroid";

// yellow-halo (combo ≥ 4) opens the ambient pad; combo ≥ 6 adds the
//   melodic layer; combo ≥ 12 adds layer 3 (a single new musical element per
//   variation — lonely violin / felt glockenspiel / synth-bass arp / chime
//   counter-melody); white-bullet tier (≥ 8) thickens the legacy synth pad
//   with an octave-up sparkle layer. Comet presence slides the colour-third
//   from E→Eb so the pad stays consonant with the comet's phrygian shimmer
//   instead of fighting it.
//
//   Music variation: each time combo crosses 4 from below, we pick a fresh
//   random variation from HALO_MUSIC_POOL — so successive combo runs in the
//   same wave don't always sound the same. The chosen variation persists on
//   game.sound.haloMusic.variation, so the 6x melodic-layer and 12x layer-3
//   toggles use the same variation's stems (no half-EL/half-self-built
//   mash-ups).
const syncHaloAmbient = (game: Game) => {
  const hasYellowHalo = game.beatCombo >= 4;
  const hasMelodic = game.beatCombo >= 6;
  const hasWhiteBullets = game.beatCombo >= 8;
  const hasLayer3 = game.beatCombo >= 12;

  if (HALO_MUSIC_POOL.length > 0) {
    // Pre-rendered music path. Three layers: ambient (4x) + melodic (6x) + layer3 (12x).
    if (hasYellowHalo) {
      if (!game.sound.haloMusic) {
        const variation = pickHaloMusicVariation();
        // Schedule the music's downbeat on the next bass-measure boundary
        // so the loop's chord changes align with the bass field's measure
        // clock. Worst-case wait is BASS_MEASURE_LENGTH (2 s); typical is
        // ~1 s. The 4x-combo halo "ignites" on the next downbeat rather
        // than mid-bar.
        const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
        const measureAlignDelay = nextDownbeat - game.beatTime;
        void game.sound.startHaloMusic(variation, hasMelodic, measureAlignDelay, hasLayer3);
      } else {
        game.sound.setHaloMusicMelodicLayer(hasMelodic);
        game.sound.setHaloMusicLayer3(hasLayer3);
      }
    } else if (game.sound.haloMusic) {
      game.sound.stopHaloMusic();
    }
  } else {
    // Legacy synthesized pad. 4x opens, 8x adds octave-up sparkle.
    if (hasYellowHalo) {
      if (!game.sound.haloAmbient) game.sound.startHaloAmbient(hasWhiteBullets ? 2 : 1);
      else game.sound.setHaloAmbientTier(hasWhiteBullets ? 2 : 1);
    } else if (game.sound.haloAmbient) {
      game.sound.stopHaloAmbient();
    }
  }
  game.sound.setHaloAmbientCometMode(game.comets.length > 0);
};

// ordered phases (ship → bass → world → collisions) so cause-and-effect reads top-down.
const updatePlaying = (game: Game, dt: number) => {
  const bulletsBeforeShipUpdate = game.bullets.length;
  game.ship.setCombo(game.beatCombo);
  syncHaloAmbient(game);
  game.ship.update(dt, game.input, game.particles, game.bullets, game.w, game.h, game.time, game.sound);
  const musicDt = tickSlowMoTimer(game, dt);
  tickBassBeats(game, musicDt);
  // pulsar runs against freshly-advanced beatTime so its flash lands with the bass voices.
  game.pulsar.update(dt, game.beatTime, BEAT_GRID);
  game.ship.tickComboHalo(musicDt, currentBeatPulse(game));
  if (game.bullets.length > bulletsBeforeShipUpdate) classifyNewBullets(game, bulletsBeforeShipUpdate);
  graceFrameNearAsteroids(game);
  tickWavePhase(game, dt, musicDt);
  tickWorldEntities(game, dt, musicDt);
  game.particles.update(musicDt);
  game.popups = updatePopups(game.popups, dt);
  runCollisionPasses(game);
  evaluateClosedBeats(game);
  syncPowerupHud(game);
  if (game.asteroids.length === 0 && !game.betaMode && !game.waveTransitioning) advanceWave(game);
};

// slow-mo timer ticks in wall-clock so its lifespan isn't extended by its own effect.
const tickSlowMoTimer = (game: Game, dt: number): number => {
  if (game.slowMoTimer > 0) game.slowMoTimer = Math.max(0, game.slowMoTimer - dt);
  return musicDtForFrame(dt, game.slowMoTimer);
};

// ≤1 fire event per frame, but prong emits 2 bullets — they all share one beat flag.
const classifyNewBullets = (game: Game, firstNewIndex: number) => {
  const firedOnBeat = isInBeatWindow(game, game.beatTime);
  const count = game.bullets.length - firstNewIndex;
  for (let i = firstNewIndex; i < game.bullets.length; i++) {
    game.bullets[i].firedAtBeatTime = game.beatTime;
  }
  logBeatEvent(game, "FIRE", game.beatTime, `bullets=${count}`);
  spawnBeatDebugPopup(game, game.ship.pos, game.beatTime, "FIRE");
  if (firedOnBeat) handleOnBeatFire(game, firstNewIndex);
  else handleOffBeatFire(game);
  // deeper fireBeat pluck reinforces "you nailed the beat"; ship no longer plays its own.
  game.sound.play(firedOnBeat ? "fireBeat" : "fire");
};

// 0→1 priming step; above 1 only on-beat hits + beat closures bump combo, not consecutive fires.
const handleOnBeatFire = (game: Game, firstNewIndex: number) => {
  // boosted bullets fly while the yellow halo (combo ≥ 4, tier 2) is up.
  const boosted = game.ship.comboHaloTier >= 2;
  // combo ≥ 8 promotes to the white "super-boosted" tier — bigger hitbox.
  const superBoosted = game.beatCombo >= 8;
  for (let i = firstNewIndex; i < game.bullets.length; i++) {
    const newBullet = game.bullets[i];
    newBullet.onBeat = true;
    newBullet.boosted = boosted;
    newBullet.superBoosted = superBoosted;
  }
  game.sound.play("comboTick");
  if (game.beatCombo === 0) {
    game.beatCombo = 1;
    if (game.maxCombo < 1) game.maxCombo = 1;
    syncHud(game);
  }
  if (game.firstWaveHintStage === 1) {
    game.firstWaveOnBeatFireCount += 1;
    emitFirstWaveHintProgress(game.firstWaveOnBeatFireCount);
    if (game.firstWaveOnBeatFireCount >= 3) setFirstWaveHintStage(game, 2);
  } else if (game.firstWaveHintStage === 2 && !game.firstWaveHintSubVisible) {
    // first on-beat *fire* (hit or not) reveals the targeting sub-line; the
    //   three diamonds are independently gated on on-beat *hits*.
    setFirstWaveHintSubVisible(game, true);
  } else if (game.firstWaveHintStage === 3) {
    // 0→1 priming step mirrors into the stage-3 row. Diamonds start at 2x
    //   (diamond N = rhythm N+1), so priming alone leaves the row at 0.
    emitFirstWaveHintRhythmProgress(Math.max(0, Math.min(game.beatCombo - 1, 3)));
  }
};

// latch break till next beat closure so a kill on the same frame still rides the prior streak.
const handleOffBeatFire = (game: Game) => {
  game.firedOffBeatSinceLastBeat = true;
};

// cheap respawn-grace — extend invuln if a rock is still inside the safe radius near the end.
const graceFrameNearAsteroids = (game: Game) => {
  if (!(game.ship.invuln > 0 && game.ship.invuln < 0.4)) return;
  const safeRadius = 130;
  for (const a of game.asteroids) {
    if (dist(a.pos, game.ship.pos) < safeRadius) { game.ship.invuln = 0.4; return; }
  }
};

// shockwave's actual detonation lands one frame later when pulsar.shockJustFired flips.
const tickWavePhase = (game: Game, dt: number, _musicDt: number) => {
  game.waveElapsed += dt;
  tickWaveEvents(game.waveEvents, game.waveElapsed);
  if (game.pulsar.shockJustFired) detonateShockwave(game);
};

// Two-pointer in-place compaction: keeps surviving entries in their original
// slots, truncates the array. Avoids the per-frame array allocation that
// .filter() does even when nothing died.
const compactInPlace = <T>(arr: T[], alive: (item: T) => boolean): void => {
  let write = 0;
  for (let read = 0; read < arr.length; read++) {
    const item = arr[read];
    if (alive(item)) {
      if (write !== read) arr[write] = item;
      write++;
    }
  }
  arr.length = write;
};

// slow-mo slows the whole world via musicDt — asteroids, comets, aliens, bullets, shards, canisters.
//   Ship stays on wall-clock dt (updated earlier) so player reactions feel responsive.
const tickWorldEntities = (game: Game, _dt: number, musicDt: number) => {
  for (const c of game.comets) c.update(musicDt, game.w, game.h);
  pruneDeadComets(game);
  for (const a of game.asteroids) a.update(musicDt, game.w, game.h);
  for (const al of game.aliens) al.update(musicDt, game.w, game.h);
  tickAlienFire(game);
  for (const b of game.bullets) b.update(musicDt, game.w, game.h);
  compactInPlace(game.bullets, (b) => b.life > 0);
  for (const ab of game.alienBullets) ab.update(musicDt, game.w, game.h);
  compactInPlace(game.alienBullets, (ab) => ab.life > 0);
  for (const s of game.shards) s.update(musicDt);
  compactInPlace(game.shards, (s) => s.life > 0);
  for (const c of game.canisters) {
    const wasWarping = c.warping;
    c.update(musicDt, game.w, game.h);
    if (!wasWarping && c.warping) game.sound.play("canisterAppear", 1, c.pos);
  }
  compactInPlace(game.canisters, (c) => c.alive);
  for (const g of game.goldCrystals) g.update(musicDt, game.w, game.h);
  compactInPlace(game.goldCrystals, (g) => g.alive);
  updatePositionalAudio(game);
};

// Refresh the spatial listener and the per-frame pan/gain on every active
// drone. Listener is the ship (when alive); drones still pan after death so
// the post-mortem field-clear keeps positional cues. We pass the screen
// dimensions so pan saturates at the actual visible edges.
const updatePositionalAudio = (game: Game) => {
  game.sound.setListener(game.ship.pos.x, game.ship.pos.y, game.w, game.h);
  for (const a of game.asteroids) {
    if (a.isBass() && (a.size === "medium" || a.size === "small")) {
      game.sound.updateBassteroidDrone(a, a.pos);
    }
  }
  for (const al of game.aliens) game.sound.updateAlienDrone(al, al.pos);
  for (const c of game.comets) game.sound.updateCometShimmer(c, c.pos);
};

// pruning is a separate pass so we don't mutate game.comets mid-iteration of the update loop.
const pruneDeadComets = (game: Game) => {
  const survivingComets = [];
  for (const c of game.comets) {
    if (c.alive) survivingComets.push(c);
    else game.sound.stopCometShimmer(c);
  }
  game.comets = survivingComets;
};

// shots aim at the player's pos at fire-time — dodging works by moving between beats.
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
    game.sound.play(fireSound, 1, a.pos);
  } else {
    a.fireFlash = 1;
  }
  const pattern = ALIEN_FIRE_PATTERN_BEATS[a.size];
  const gap = pattern[a.firePatternIndex % pattern.length];
  a.firePatternIndex = (a.firePatternIndex + 1) % pattern.length;
  a.nextFireAt += gap * BEAT_GRID;
};

// collisions run before evaluateClosedBeats so trailing-edge closures see this frame's kills.
const runCollisionPasses = (game: Game) => {
  handleCollisions(game);
  handleAlienHits(game);
  handleAlienBulletHits(game);
  handleCometHits(game);
  handleCanisterPickups(game);
  handleCanisterShots(game);
  handleGoldCrystalPickups(game);
};

// Fade "Wave N" into the centre of the screen so it picks up directly from
// where the previous wave's "Completed Wave N" title sat in the summary panel.
const showWaveAnnounce = (game: Game) => {
  let el = document.getElementById("wave-announce");
  if (!el) {
    el = document.createElement("div");
    el.id = "wave-announce";
    const inner = document.createElement("span");
    el.appendChild(inner);
    document.body.appendChild(el);
  }
  const inner = el.firstElementChild as HTMLSpanElement;
  inner.textContent = `Wave ${game.wave}`;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  window.setTimeout(() => { el?.classList.remove("show"); }, 2800);
};

// the wave-clear cue (sound + pulsar pulse + boss state) fires
//   immediately on closure, but the next wave's spawn is deferred until the
//   summary panel has fully faded — the empty-asteroids playfield serves as
//   the breathing room while the player reads their bonus. waveTransitioning
//   gates the empty-asteroids check in the update loop so this only fires once.
const advanceWave = (game: Game) => {
  const wasBossWave = isBossWave(game.wave);
  const completedWave = game.wave;
  const maxRhythm = Math.max(1, game.maxComboThisWave);
  const finalRhythm = Math.max(1, game.beatCombo);
  const nextWave = completedWave + 1;
  game.sound.play("waveClear");
  game.sound.play("pulsarHum");
  game.pulsar.waveClear();
  if (wasBossWave) game.pulsar.setBossPlanetState("defeated");
  game.waveTransitioning = true;
  showWaveSummary(game, completedWave, maxRhythm, finalRhythm, () => {
    game.wave = nextWave;
    game.maxComboThisWave = game.beatCombo;
    game.pulsar.setWaveLevel(game.wave);
    updateBgBeatIntensity(game);
    spawnWave(game);
    showWaveAnnounce(game);
    syncHud(game);
    game.waveTransitioning = false;
  });
  syncHud(game);
};
