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
import { HALO_MUSIC_POOL } from "./haloMusicConfig";
import { hideWaveSummary } from "./waveSummary";

// once a player reaches 6x rhythm we flip this flag so future runs skip the
//   wave-1 tutorial overlays. localStorage may be blocked (private mode) — in
//   that case the tutorial harmlessly re-shows next session.
const FIRST_WAVE_TUTORIAL_KEY = "pulsar.firstWaveTutorialDone.v1";
export const isFirstWaveTutorialComplete = (): boolean => {
  try {
    return localStorage.getItem(FIRST_WAVE_TUTORIAL_KEY) === "1";
  } catch {
    return false;
  }
};
export const markFirstWaveTutorialComplete = () => {
  try {
    localStorage.setItem(FIRST_WAVE_TUTORIAL_KEY, "1");
  } catch {
    // best-effort persistence; ignore quota / blocked storage.
  }
};

// React-side <FirstWaveHint> subscribes to this so the canvas/game loop stays
//   out of layout + transitions — CSS + a single setTimeout do the dismiss work.
export const setFirstWaveHintStage = (game: Game, stage: 0 | 1 | 2 | 3) => {
  if (game.firstWaveHintStage === stage) return;
  game.firstWaveHintStage = stage;
  // stage transitions always reset the sub-line + the stage-2 hit pips; both
  //   re-open only when the player's on-beat hits during stage 2 fill them.
  if (game.firstWaveHintSubVisible) setFirstWaveHintSubVisible(game, false);
  if (game.firstWaveOnBeatHitCount !== 0) {
    game.firstWaveOnBeatHitCount = 0;
    emitFirstWaveHintHitProgress(0);
  }
  window.dispatchEvent(new CustomEvent("first-wave-hint:stage", { detail: { stage } }));
  if (stage === 3) {
    // seed the diamond row with the player's current rhythm (capped at 3),
    //   then fire ready if they're already at or past 3x — otherwise the
    //   hold waits until applyHitToCombo emits ready as they rebuild.
    emitFirstWaveHintRhythmProgress(Math.min(game.beatCombo, 3));
    if (game.beatCombo >= 3) emitFirstWaveHintStage3Ready();
  } else {
    // leaving stage 3 (or never entering it) clears the diamond row.
    emitFirstWaveHintRhythmProgress(0);
  }
};

export const setFirstWaveHintSubVisible = (game: Game, visible: boolean) => {
  if (game.firstWaveHintSubVisible === visible) return;
  game.firstWaveHintSubVisible = visible;
  window.dispatchEvent(new CustomEvent("first-wave-hint:sub", { detail: { visible } }));
};

// stage-1 progress diamonds (3 of them) light up as the player banks on-beat
//   fires; React redraws when this fires.
export const emitFirstWaveHintProgress = (count: number) => {
  window.dispatchEvent(new CustomEvent("first-wave-hint:progress", { detail: { count } }));
};

// stage-2 progress diamonds (3 of them) light up as the player banks on-beat
//   hits; on the third one, the sub-line ("Use your targeting tools to help")
//   reveals via setFirstWaveHintSubVisible.
export const emitFirstWaveHintHitProgress = (count: number) => {
  window.dispatchEvent(new CustomEvent("first-wave-hint:hitProgress", { detail: { count } }));
};

// stage-3 ready: fires once `beatCombo` reaches 3 while stage 3 is showing.
//   Until then, the React component holds stage 3 at full opacity instead of
//   starting its 3s dismissal timer. If the player is already past 3x rhythm
//   at stage-3 entry (the usual case), this fires immediately.
export const emitFirstWaveHintStage3Ready = () => {
  window.dispatchEvent(new CustomEvent("first-wave-hint:stage3Ready"));
};

// stage-3 diamonds (3 of them) mirror the player's current rhythm count
//   (capped at 3). When the player enters stage 3 below 3x, the row fills
//   as on-beat hits land; when they enter at 3x or higher, all three are
//   already filled.
export const emitFirstWaveHintRhythmProgress = (count: number) => {
  window.dispatchEvent(new CustomEvent("first-wave-hint:rhythmProgress", { detail: { count } }));
};


// Fisher-Yates over Array.sort — sort's randomness is biased and varies across engines.
const shuffled = <T,>(arr: ReadonlyArray<T>): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// title screen needs visible motion; decorative rocks don't carry HP or split logic.
const spawnTitleDecorativeAsteroids = (game: Game) => {
  const decorativeAsteroidIndices = [0, 1, 2, 3, 4];
  for (const _ of decorativeAsteroidIndices) {
    game.asteroids.push(spawnAsteroidAtEdge(game.w, game.h));
  }
};

// drone loops can outlive a wave — every state-leaver calls this to avoid stale audio.
const stopAllPersistentAudio = (game: Game) => {
  game.sound.stopAllAlienDrones();
  game.sound.stopAllBassteroidDrones();
  game.sound.stopAllCometShimmers();
  game.sound.stopHaloAmbient();
  game.comets = [];
};

// lifecycle transitions have their own cues; the loseCombo wrrr would just clutter them.
const clearComboSilently = (game: Game) => {
  game.beatCombo = 0;
  game.firedOffBeatSinceLastBeat = false;
  syncComboHud(game);
};

// carries the prior run's trophy lineup so a returning player still sees what they took down.
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
  game.goldCrystals = [];
  stopAllPersistentAudio(game);
  game.aliens = [];
  game.alienBullets = [];
  game.waveEvents = newWaveEventSchedule();
  game.slowMoTimer = 0;
  game.sound.bgBeatIntensity = 0;
  game.pulsar.setBossPlanetState("idle");
  spawnTitleDecorativeAsteroids(game);
  game.ship.prongActive = false;
  game.ship.rapidActive = false;
  game.ship.pierceActive = false;
  game.ship.shieldActive = false;
  game.ship.radarActive = false;
  game.ship.longshotActive = false;
  game.ship.sideEnginesActive = false;
  syncPowerupHud(game);
  hideScoreEntry(game);
  showLeaderboard(game);
  hideWaveSummary();
  setFirstWaveHintStage(game, 0);
  game.waveTransitioning = false;
};

// per-run randomised bass intro order means the wave-2/3 picks vary between runs.
export const startGame = (game: Game) => {
  game.sound.resume();
  game.sound.preloadPilotLog(6);
  game.sound.preloadPilotLog(12);
  // Warm every halo music stem in the pool so whichever variation gets
  // randomly picked at the first 4x doesn't pay fetch+decode latency.
  // Pool size × 2 stems × ~600 KB ≈ 2.5 MB for the current 2-variation pool —
  // small enough to load eagerly at game start.
  for (const variation of HALO_MUSIC_POOL) {
    game.sound.preloadHaloMusic(variation);
  }
  game.betaMode = false;
  game.state = "playing";
  game.score = 0;
  game.wave = 1;
  game.lives = 3;
  game.waveTransitioning = false;
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
  game.firstWaveOnBeatFireCount = 0;
  game.firstWaveOnBeatHitCount = 0;
  emitFirstWaveHintProgress(0);
  emitFirstWaveHintHitProgress(0);
  emitFirstWaveHintRhythmProgress(0);
  setFirstWaveHintStage(game, isFirstWaveTutorialComplete() ? 0 : 1);
  game.overlayEl.classList.add("hidden");
  hideScoreEntry(game);
  game.leaderboardEl.classList.add("hidden");
  game.lastRunScore = null;
  game.lastRunScoreId = null;
  syncHud(game);
};

// run-scoped state only; spawnWave handles per-wave timers separately.
const resetRunTimers = (game: Game) => {
  game.beatTime = 0;
  game.lastBgBeatIndex = -1;
  game.nextBeatToEvaluate = 0;
  game.beatCombo = 0;
  game.maxCombo = 0;
  game.maxComboThisWave = 0;
  game.firedOffBeatSinceLastBeat = false;
  game.slowMoTimer = 0;
  game.hasLostComboEver = false;
  game.pilotLog1Unlocked = false;
  game.pilotLog3Unlocked = false;
};

// parade + drones from the previous title screen must be torn down before the new run runs.
const resetRunCollections = (game: Game) => {
  game.bullets = [];
  game.popups = [];
  game.shards = [];
  game.canisters = [];
  game.goldCrystals = [];
  game.killedSnapshots = [];
  game.killTally = {};
  stopParade(game);
  game.killedRowEl.classList.add("hidden");
  stopAllPersistentAudio(game);
  game.aliens = [];
  game.alienBullets = [];
  game.waveEvents = newWaveEventSchedule();
};

// one esc handler keeps the pause toggle simple; sub-helpers cover the per-state side effects.
export const togglePause = (game: Game) => {
  if (game.state === "playing") enterPause(game);
  else if (game.state === "paused") leavePause(game);
};

const enterPause = (game: Game) => {
  game.state = "paused";
  game.ship.thrustOn = false;
  game.ship.reverseThrustOn = false;
  game.ship.portThrustOn = false;
  game.ship.starboardThrustOn = false;
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopSideThrust();
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

// lets a stuck player exit cleanly via the kill-row screen without having to die out.
export const abortMission = (game: Game) => {
  if (game.state !== "paused") return;
  game.state = "gameover";
  game.ship.thrustOn = false;
  game.ship.reverseThrustOn = false;
  game.ship.portThrustOn = false;
  game.ship.starboardThrustOn = false;
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopSideThrust();
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

// combo grid may have flipped (8ths→quarters if previous life had rapid); rebase the eval index.
export const respawn = (game: Game) => {
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  game.ship.invuln = 2.2;
  game.nextBeatToEvaluate = Math.max(0, Math.floor((game.beatTime - BEAT_WINDOW) / comboGrid(game)) + 1);
  game.state = "playing";
  syncHud(game);
};

// death pauses beatTime so a leftover streak would pin the HUD until respawn — drop it now.
export const killShip = (game: Game) => {
  game.lives -= 1;
  game.shake = 1.5;
  game.state = "dying";
  game.dyingTimer = 1.8;
  clearComboSilently(game);
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopSideThrust();
  game.sound.stopHaloAmbient();
  game.sound.play("death");
  emitShipDebris(game.particles, game.ship.pos);
  game.ship.alive = false;
};

// Slider position is the source of truth; volumeEl.max = 200 corresponds to
// volume multiplier 2.0. lastNonZeroVolume lets the M key restore the prior
// level after a mute toggle instead of jumping back to max.
let lastNonZeroVolume = 2;

export const applyVolume = (game: Game, multiplier: number) => {
  game.sound.setVolume(multiplier);
  if (multiplier > 0) lastNonZeroVolume = multiplier;
  game.volumeEl.value = String(Math.round(multiplier * 100));
  game.volumeEl.classList.toggle("muted", multiplier === 0);
};

export const toggleMute = (game: Game) => {
  const next = game.sound.volume > 0 ? 0 : lastNonZeroVolume;
  applyVolume(game, next);
};
