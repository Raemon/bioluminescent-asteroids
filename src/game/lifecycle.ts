import type { Game } from "../Game";
import { Ship } from "../Ship";
import { spawnAsteroidAtEdge, BASS_KINDS } from "../Asteroid";
import { ParticleSystem } from "../Particle";
import { v } from "../vec";
import { BEAT_WINDOW } from "./rhythmConstants";
import { syncHud, syncComboHud, syncPowerupHud } from "./hud";
import { comboGrid } from "./rhythmGate";
import { spawnWave, updateBgBeatIntensity } from "./waveDirector";
import { newWaveEventSchedule } from "./waveEvents";
import { stopParade } from "./killedParade";
import { renderKilledRow } from "./killedParade";
import { emitShipDebris } from "./particleBursts";
import { hideScoreEntry, showLeaderboard, showScoreEntry } from "./scoreEntry";

// Why: Fisher-Yates over Array.sort — sort's randomness is biased and varies across engines.
const shuffled = <T,>(arr: ReadonlyArray<T>): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// Why: title screen needs visible motion; decorative rocks don't carry HP or split logic.
const spawnTitleDecorativeAsteroids = (game: Game) => {
  const decorativeAsteroidIndices = [0, 1, 2, 3, 4];
  for (const _ of decorativeAsteroidIndices) {
    game.asteroids.push(spawnAsteroidAtEdge(game.w, game.h));
  }
};

// Why: drone loops can outlive a wave — every state-leaver calls this to avoid stale audio.
const stopAllPersistentAudio = (game: Game) => {
  game.sound.stopAllAlienDrones();
  game.sound.stopAllBassteroidDrones();
  game.sound.stopAllCometShimmers();
  game.sound.stopHaloAmbient();
  game.comets = [];
};

// Why: lifecycle transitions have their own cues; the loseCombo wrrr would just clutter them.
const clearComboSilently = (game: Game) => {
  game.beatCombo = 0;
  game.firedOffBeatSinceLastBeat = false;
  syncComboHud(game);
};

// Why: carries the prior run's trophy lineup so a returning player still sees what they took down.
export const showTitle = (game: Game) => {
  game.betaMode = false;
  game.state = "title";
  game.overlayTitleEl.textContent = "Pulsar";
  game.overlayStartEl.innerHTML = 'press <span class="key">enter</span> to begin';
  game.overlayEl.classList.remove("hidden");
  renderKilledRow(game);
  clearComboSilently(game);
  game.asteroids = [];
  game.canisters = [];
  stopAllPersistentAudio(game);
  game.aliens = [];
  game.alienBullets = [];
  game.waveEvents = newWaveEventSchedule();
  game.slowMoTimer = 0;
  game.sound.bgBeatIntensity = 0;
  game.pulsar.setBossPlanetState("idle");
  spawnTitleDecorativeAsteroids(game);
  game.ship.tridentActive = false;
  game.ship.rapidActive = false;
  game.ship.pierceActive = false;
  game.ship.shieldActive = false;
  game.ship.radarActive = false;
  syncPowerupHud(game);
  hideScoreEntry(game);
  showLeaderboard(game);
};

// Why: per-run randomised bass intro order means the wave-2/3 picks vary between runs.
export const startGame = (game: Game) => {
  game.sound.resume();
  game.betaMode = false;
  game.state = "playing";
  game.score = 0;
  game.wave = 1;
  game.lives = 3;
  resetRunTimers(game);
  resetRunCollections(game);
  game.bassOrder = shuffled(BASS_KINDS);
  game.particles = new ParticleSystem();
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  game.ship.invuln = 2.0;
  game.pulsar.setBossPlanetState("idle");
  game.pulsar.setWaveLevel(game.wave);
  updateBgBeatIntensity(game);
  spawnWave(game);
  game.overlayEl.classList.add("hidden");
  hideScoreEntry(game);
  game.leaderboardEl.classList.add("hidden");
  game.lastRunScore = null;
  game.lastRunScoreId = null;
  syncHud(game);
};

// Why: run-scoped state only; spawnWave handles per-wave timers separately.
const resetRunTimers = (game: Game) => {
  game.beatTime = 0;
  game.lastBgBeatIndex = -1;
  game.nextBeatToEvaluate = 0;
  game.beatCombo = 0;
  game.maxCombo = 0;
  game.firedOffBeatSinceLastBeat = false;
  game.slowMoTimer = 0;
  game.hasLostComboEver = false;
  game.pilotLog1Unlocked = false;
};

// Why: parade + drones from the previous title screen must be torn down before the new run runs.
const resetRunCollections = (game: Game) => {
  game.bullets = [];
  game.popups = [];
  game.shards = [];
  game.canisters = [];
  game.killedSnapshots = [];
  game.killTally = {};
  stopParade(game);
  game.killedRowEl.classList.add("hidden");
  stopAllPersistentAudio(game);
  game.aliens = [];
  game.alienBullets = [];
  game.waveEvents = newWaveEventSchedule();
};

// Why: one esc handler keeps the pause toggle simple; sub-helpers cover the per-state side effects.
export const togglePause = (game: Game) => {
  if (game.state === "playing") enterPause(game);
  else if (game.state === "paused") leavePause(game);
};

const enterPause = (game: Game) => {
  game.state = "paused";
  game.ship.thrustOn = false;
  game.ship.reverseThrustOn = false;
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.overlayTitleEl.textContent = "Paused";
  game.overlayStartEl.innerHTML = 'press <span class="key">esc</span> or <span class="key">enter</span> to resume';
  game.overlayEl.classList.remove("hidden");
  game.abortEl.classList.remove("hidden");
};

const leavePause = (game: Game) => {
  game.state = "playing";
  game.overlayEl.classList.add("hidden");
  game.abortEl.classList.add("hidden");
};

// Why: lets a stuck player exit cleanly via the kill-row screen without having to die out.
export const abortMission = (game: Game) => {
  if (game.state !== "paused") return;
  game.state = "gameover";
  game.ship.thrustOn = false;
  game.ship.reverseThrustOn = false;
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  stopAllPersistentAudio(game);
  game.lastRunScore = game.score;
  game.lastRunScoreId = null;
  game.abortEl.classList.add("hidden");
  game.overlayTitleEl.textContent = "Mission Aborted";
  game.overlayStartEl.innerHTML = `score <strong>${String(game.score).padStart(6, "0")}</strong> &nbsp;·&nbsp; press <span class="key">enter</span> to restart`;
  game.overlayEl.classList.remove("hidden");
  renderKilledRow(game);
  showScoreEntry(game);
};

// Why: combo grid may have flipped (8ths→quarters if previous life had rapid); rebase the eval index.
export const respawn = (game: Game) => {
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  game.ship.invuln = 2.2;
  game.nextBeatToEvaluate = Math.max(0, Math.floor((game.beatTime - BEAT_WINDOW) / comboGrid(game)) + 1);
  game.state = "playing";
  syncHud(game);
};

// Why: death pauses beatTime so a leftover streak would pin the HUD until respawn — drop it now.
export const killShip = (game: Game) => {
  game.lives -= 1;
  game.shake = 1.5;
  game.state = "dying";
  game.dyingTimer = 1.8;
  clearComboSilently(game);
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopHaloAmbient();
  game.sound.play("death");
  emitShipDebris(game.particles, game.ship.pos);
  game.ship.alive = false;
};

// Why: label + class must follow sound.enabled so the player can see the mute outcome.
export const toggleMute = (game: Game) => {
  game.sound.setEnabled(!game.sound.enabled);
  game.muteEl.classList.toggle("muted", !game.sound.enabled);
  game.muteEl.textContent = game.sound.enabled ? "♪" : "✕";
};
