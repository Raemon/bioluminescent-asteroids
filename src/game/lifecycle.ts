import type { Game } from "../Game";
import { Ship } from "../Ship";
import { spawnAsteroidAtEdge, BASS_KINDS } from "../Asteroid";
import { ParticleSystem } from "../Particle";
import { v } from "../vec";
import { syncHud, syncComboHud, syncPowerupHud } from "./hud";
import { comboGrid, beatWindow } from "./rhythmGate";
import { spawnWave, updateBgBeatIntensity, spawnTutorialSmall, isVeteranPilot } from "./waveDirector";
import { newWaveEventSchedule } from "./waveEvents";
import { stopParade } from "./killedParade";
import { renderKilledRow } from "./killedParade";
import { snapshotShipKill } from "./killSnapshot";
import { emitShipDebris } from "./particleBursts";
import { hideScoreEntry, isScoreEntryBlockingEnter, showLeaderboard, showScoreEntry } from "./scoreEntry";
import { BOSS_MUSIC_VARIATION, HALO_MUSIC_POOL, HAUNTING_MUSIC_POOL } from "./haloMusicConfig";
import { hideWaveSummary } from "./waveSummary";
import { hideGameOverIntro, showGameOverIntro } from "./gameOverIntro";
import { hasCalibrated, CALIBRATION_BEAT_INTENSITY } from "./beatCalibration";
import { pickIntroHints } from "./introHints";
import { isNewDaySession, markSessionStart } from "./sessionTracker";
import { rng, seedRng } from "./rng";
import { ReplayRecorder } from "./replayRecorder";
import { ReplayPlayer } from "./replayPlayer";
import { decodeReplay } from "./replayFormat";
import { resetHuePaletteCursor } from "../Asteroid";
import { getBindings, normalizeBindings, setReplayBindings } from "./controlBindings";

// React-side <FirstWaveHint> subscribes to this so the canvas/game loop stays
//   out of layout + transitions — CSS + a single setTimeout do the dismiss work.
export const setFirstWaveHintStage = (game: Game, stage: 0 | 1 | 2 | 3 | 4 | 5 | 6) => {
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
  if (stage === 5) {
    // build-to-4x stage. Wipe rhythm so the player has to rebuild from scratch
    //   — clearComboSilently also emits rhythmProgress(0) for the diamond row.
    clearComboSilently(game);
  } else {
    // leaving the build-to-4x stage (or never entering it) clears the diamond row.
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

// Guided-tutorial signals (consumed by the tutorial UI). hoverProgress drives the
//   "hold your reticule" circle (0→1 over one second); the two *Done events mark
//   the milestones that gate the spawn machine — see gameUpdate.tickTutorialSpawn.
export const emitTutorialHoverProgress = (value: number) => {
  window.dispatchEvent(new CustomEvent("tutorial:hoverProgress", { detail: { value } }));
};
// controls-phase usage (stage 1 + normal-mode start-of-run hint) — drives the
//   fade-as-used keys in <TutorialControlsHint>.
export const emitTutorialControls = (rotate: boolean, thrust: boolean, back: boolean, side: boolean, fire: boolean) => {
  window.dispatchEvent(new CustomEvent("tutorial:controls", { detail: { rotate, thrust, back, side, fire } }));
};
export const emitTutorialHoverDone = () => {
  window.dispatchEvent(new CustomEvent("tutorial:hoverDone"));
};
export const emitTutorialFireHitDone = () => {
  window.dispatchEvent(new CustomEvent("tutorial:fireHitDone"));
};


// Fisher-Yates over Array.sort — sort's randomness is biased and varies across engines.
const shuffled = <T,>(arr: ReadonlyArray<T>): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
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
  if (game.firstWaveHintStage === 5) emitFirstWaveHintRhythmProgress(0);
};

// carries the prior run's trophy lineup so a returning player still sees what they took down.
export const showTitle = (game: Game) => {
  // drop any active replay-binding override (lingers when a replay ran to end-of-stream
  //   and the player exits to title; otherwise the next live run sees the watched
  //   pilot's bindings instead of their own).
  setReplayBindings(null);
  game.betaMode = false;
  game.state = "title";
  game.overlayTitleEl.textContent = "Pulsar Drift";
  game.overlayStartEl.textContent = "Start";
  game.overlayStartEl.classList.remove("hidden");
  game.overlayEl.classList.remove("hidden");
  game.overlayEl.classList.remove("gameover-layout");
  hideGameOverIntro();
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
  emitGameState(game);
};

// First run gates on the latency calibrator: rhythm scoring is meaningless if the
//   player's "on the beat" presses are landing 150ms late through a Bluetooth
//   speaker and they've no idea where the beat even is. Once they've calibrated
//   (or skipped) the result persists, so every later run goes straight in.
//
// Resumes the AudioContext on the user gesture and awaits the baked-mp3 cache
//   before kicking off the run, so the first sounds always play from cache and
//   the live Tone fallback (which crashes on some browsers' stubbed Web Audio)
//   is never exercised during gameplay.
export const requestStart = (game: Game) => {
  if (game.calibrating || game.calibrationIntro || game.introOverlayActive || game.startPending) return;
  game.sound.resume();
  game.startPending = true;
  void game.sound.bakedCacheReady().then(() => {
    game.startPending = false;
    if (!hasCalibrated()) {
      startCalibrationIntro(game);
      return;
    }
    // Already-calibrated players get a pilot's-log opener instead of jumping
    //   straight in. New day (>=4h) → full triplet + "Become one with the
    //   Pulsar"; otherwise → one hint as a quick fade. Same shape for veterans
    //   and rookies on same-day re-entry.
    if (isNewDaySession()) {
      startGameWithIntro(game, "fullHints");
    } else {
      startGameWithIntro(game, "shortHint");
    }
  });
};

// Spin up a real run, but with the intro overlay riding on top — the world is
//   held by updateGame's introOverlayActive short-circuit while the beat ticks
//   under the black overlay. When IntroSequence fires `intro-sequence:done`,
//   we drop the flag and play takes over from the same beat clock.
const startGameWithIntro = (game: Game, kind: "fullHints" | "shortHint") => {
  markSessionStart();
  startGame(game);
  // startGame set state=playing and spawned the wave; immediately hide the
  //   world behind the intro and gate fire off via introOverlayActive.
  game.introOverlayActive = true;
  game.introOverlayStep = kind;
  game.introOverlayHints = pickIntroHints(kind === "fullHints" ? 3 : 1);
  game.ship.invuln = Math.max(game.ship.invuln, 2.0);
  // Hold the bgBeat at calibration loudness for the intro and ramp down once
  //   play actually begins; same pattern as the post-calibration hand-off.
  game.sound.bgBeatIntensity = CALIBRATION_BEAT_INTENSITY;
  game.beatIntensityRamp = null;
  window.dispatchEvent(new CustomEvent("intro-sequence:start", { detail: { kind, hints: game.introOverlayHints } }));
};

// Recalibration only (settings "Resync the beat"): the standalone calibrator
//   schedules its own beat, used when there's no run to fold the pulse into.
export const openBeatCalibrator = (game: Game) => {
  if (game.calibrating || game.calibrationIntro) return;
  game.calibrating = true;
  game.sound.resume();
  window.dispatchEvent(new CustomEvent("beat-calibrator:open", { detail: { sound: game.sound, intro: false } }));
};

// First run: the run actually begins, but the world is held and only the beat
//   plays while the player practices tapping in rhythm. The same beat clock
//   carries straight into live play (updateCalibration → finishCalibrationIntro),
//   so there's no stop-restart at the hand-off.
export const startCalibrationIntro = (game: Game) => {
  game.sound.resume();
  game.sound.preloadPilotLog(6);
  game.sound.preloadPilotLog(12);
  for (const variation of HALO_MUSIC_POOL) game.sound.preloadHaloMusic(variation);
  for (const variation of HAUNTING_MUSIC_POOL) game.sound.preloadHaloMusic(variation);
  // Boss music isn't in the random pool but plays on the level-10 boss wave;
  // preload it now so the wave 11 transition doesn't pay fetch latency.
  game.sound.preloadHaloMusic(BOSS_MUSIC_VARIATION);
  game.betaMode = false;
  game.state = "playing";
  game.calibrationIntro = true;
  game.calibrating = true;
  game.score = 0;
  game.wave = 1;
  game.lives = 3;
  game.nextBonusLifeScore = 50000;
  game.waveTransitioning = false;
  resetRunTimers(game);
  resetRunCollections(game);
  game.bassOrder = shuffled(BASS_KINDS);
  game.particles = new ParticleSystem();
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  game.ship.invuln = 1e9; // untouchable through the warm-up
  game.pulsar.setBossPlanetState("idle");
  game.pulsar.setWaveLevel(game.wave);
  game.sound.bgBeatIntensity = CALIBRATION_BEAT_INTENSITY;
  game.beatIntensityRamp = null;
  game.overlayEl.classList.add("hidden");
  hideScoreEntry(game);
  game.leaderboardEl.classList.add("hidden");
  game.lastRunScore = null;
  game.lastRunScoreId = null;
  syncHud(game);
  emitGameState(game);
  window.dispatchEvent(new CustomEvent("beat-calibrator:open", { detail: { sound: game.sound, intro: true } }));
};

// Player locked in: hand off the calibrator's beat clock to the pilot's-log
//   intro overlay. The world stays held (introOverlayActive shares the same
//   short-circuit path calibrationIntro uses) and beat keeps ticking under the
//   "Latency calibrated" beat and the 3-hint sequence. When the intro fires
//   `intro-sequence:done`, finalizeIntroToPlay brings wave 1 to life.
export const finishCalibrationIntro = (game: Game) => {
  game.calibrationIntro = false;
  game.calibrating = false;
  game.introOverlayActive = true;
  game.introOverlayStep = "latency";
  game.introOverlayHints = pickIntroHints(3);
  // startCalibrationIntro set invuln to 1e9 for the warm-up; replace (don't Math.max)
  // so the player is actually vulnerable once the post-calibration intro hands off to play.
  game.ship.invuln = 2.0;
  markSessionStart();
  // First-ever calibration always counts as a fresh day — kick off the latency
  //   announcement and queue the pilot's log triplet right after. The chain
  //   latency → fullHints → finalize is advanced by the Game.ts handler for
  //   `intro-sequence:done` (it re-fires `intro-sequence:start` for fullHints).
  window.dispatchEvent(new CustomEvent("intro-sequence:start", { detail: { kind: "latency", hints: game.introOverlayHints } }));
};

// Called by the Game-level `intro-sequence:done` handler to advance the chain.
//   For the post-calibration chain, "latency" hands off to "fullHints"; for
//   any single-leg chain (daily fullHints or shortHint, or the trailing
//   fullHints of the post-calibration chain), the next done finalizes play.
export const advanceIntroOverlay = (game: Game) => {
  if (game.introOverlayStep === "latency") {
    // Chain hands off to the pilot's-log triplet — keep the world frozen, the
    //   bg stays black, the beat keeps ticking under the new leg.
    game.introOverlayStep = "fullHints";
    window.dispatchEvent(new CustomEvent("intro-sequence:start", { detail: { kind: "fullHints", hints: game.introOverlayHints } }));
    return;
  }
  // shortHint or fullHints leg's text has fully faded out — the unfreeze
  //   already fired mid-fade, so this is just bookkeeping.
  finalizeIntroToPlay(game);
};

// Fired the moment IntroSequence begins fading from black — the world wakes up
//   *during* the fade-in instead of after it, so the player can move as soon as
//   the screen starts revealing. The bgBeat stays at the intro's loudness
//   (CALIBRATION_BEAT_INTENSITY) so the pulse doesn't dip when play starts; the
//   wave director will set per-wave levels on wave changes from there on.
export const unfreezeIntroWorld = (game: Game) => {
  if (!game.introOverlayActive) return;
  game.introOverlayActive = false;
  game.beatIntensityRamp = null;
  game.sound.bgBeatIntensity = CALIBRATION_BEAT_INTENSITY;
  // Post-calibration chain only: spawn wave 1 + tutorial if we haven't yet.
  //   startGameWithIntro already spawned the wave; in that case `hasSpawnedFirstLevel`
  //   is true and beginFirstWaveByTutorialFlag is skipped.
  if (!game.hasSpawnedFirstLevel) {
    game.firstWaveOnBeatFireCount = 0;
    game.firstWaveOnBeatHitCount = 0;
    game.tutorialActive = false;
    game.tutorialHoverDone = false;
    game.tutorialFireHitDone = false;
    emitFirstWaveHintProgress(0);
    emitFirstWaveHintHitProgress(0);
    emitFirstWaveHintRhythmProgress(0);
    beginFirstWaveByTutorialFlag(game, game.tutorialRequested, isVeteranPilot());
  }
  syncHud(game);
};

// Final cleanup after IntroSequence's last leg fades out completely. The world
//   has already been awake since `unfreezeIntroWorld` fired earlier in the
//   fade-in; this just clears the residual chain state.
export const finalizeIntroToPlay = (game: Game) => {
  unfreezeIntroWorld(game); // no-op if unfreeze already fired
  game.introOverlayStep = null;
  game.introOverlayHints = [];
};

// Tutorial button → guided tutorial (single practice rock + stage 1 controls hint);
//   Start button → skips straight to the single-asteroid warm-up (displayed Wave 0).
//   Veteran pilots (anyone who has ever hit 6x rhythm) skip the warm-up and start on
//   the first proper density wave instead. Used at both calibration hand-off and the
//   direct startGame path so the two stay in sync.
const beginFirstWaveByTutorialFlag = (game: Game, tutorial: boolean, veteran: boolean) => {
  game.tutorialControlsUsed = { rotate: false, thrust: false, back: false, side: false, fire: false };
  if (tutorial) {
    game.tutorialActive = true;
    spawnTutorialSmall(game);
    setFirstWaveHintStage(game, 1);
  } else {
    setFirstWaveHintStage(game, 0);
    if (veteran) {
      game.wave = 2;
      game.pulsar.setWaveLevel(game.wave);
      updateBgBeatIntensity(game);
      syncHud(game);
    }
    spawnWave(game);
    game.controlsHintActive = true;
    window.dispatchEvent(new CustomEvent("controls-hint:show"));
  }
};

// per-run randomised bass intro order means the wave-2/3 picks vary between runs.
// Overrides (set by startReplay) freeze the seed + tutorial/veteran flags so
//   wave-1 spawn reproduces deterministically from the recording.
export const startGame = (game: Game, overrides?: {
  seed: number;
  tutorial: boolean;
  veteran: boolean;
  recorder: false;
}) => {
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
  for (const variation of HAUNTING_MUSIC_POOL) {
    game.sound.preloadHaloMusic(variation);
  }
  game.sound.preloadHaloMusic(BOSS_MUSIC_VARIATION);
  // Seed the PRNG before anything random fires (bassOrder shuffle, wave events,
  //   asteroid hues). Re-arming the lazy hue cursor lets the first nextWaveHue
  //   call after this draw from the seeded RNG, not whichever cursor a previous
  //   run left behind. Replay overrides supply the recorded seed up front so the
  //   downstream shuffle + wave spawn draw the same numbers the recording saw.
  game.runSeed = overrides
    ? overrides.seed
    : (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
  seedRng(game.runSeed);
  resetHuePaletteCursor();
  const tutorial = overrides ? overrides.tutorial : game.tutorialRequested;
  const veteran = overrides ? overrides.veteran : isVeteranPilot();
  // Replay path skips the recorder — playback uses the player, not capture.
  game.recorder = overrides ? null : new ReplayRecorder({
    seed: game.runSeed,
    beatOffset: game.beatOffset,
    w: game.w,
    h: game.h,
    dpr: game.dpr,
    tutorial,
    veteran,
    bindings: getBindings(),
  });
  game.replayPlayer = null;
  game.lastRunReplay = null;
  game.input = game.localInput;
  game.betaMode = false;
  game.state = "playing";
  game.score = 0;
  game.wave = 1;
  game.lives = 3;
  game.nextBonusLifeScore = 50000;
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
  game.firstWaveOnBeatFireCount = 0;
  game.firstWaveOnBeatHitCount = 0;
  emitFirstWaveHintProgress(0);
  emitFirstWaveHintHitProgress(0);
  emitFirstWaveHintRhythmProgress(0);
  beginFirstWaveByTutorialFlag(game, tutorial, veteran);
  game.overlayEl.classList.add("hidden");
  hideScoreEntry(game);
  game.leaderboardEl.classList.add("hidden");
  game.lastRunScore = null;
  game.lastRunScoreId = null;
  syncHud(game);
  emitGameState(game);
};

// run-scoped state only; spawnWave handles per-wave timers separately.
const resetRunTimers = (game: Game) => {
  game.beatTime = 0;
  game.lastBeatResnapAt = game.beatTime;
  game.beatPhaseCorrection = 0;
  game.lastBgBeatIndex = -1;
  game.nextBeatToEvaluate = 0;
  game.beatCombo = 0;
  game.maxCombo = 0;
  game.maxComboThisWave = 0;
  game.driftBonusesThisWave = 0;
  game.hasShownDriftShotLabel = false;
  game.firedOffBeatSinceLastBeat = false;
  game.pendingDriftBonuses = [];
  game.slowMoTimer = 0;
  game.hasLostComboEver = false;
  game.pilotLog1Unlocked = false;
  game.pilotLog3Unlocked = false;
  game.tutorialActive = false;
  game.tutorialHoverDone = false;
  game.tutorialFireHitDone = false;
  game.controlsHintActive = false;
  game.beatIntensityRamp = null;
  game.hasSpawnedFirstLevel = false;
};

// parade + drones from the previous title screen must be torn down before the new run runs.
const resetRunCollections = (game: Game) => {
  game.asteroids = [];
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

// Click-equivalent of pressing Enter on whichever overlay is showing.
export const triggerOverlayStart = (game: Game) => {
  if (game.state === "title") requestStart(game);
  else if (game.state === "paused") leavePause(game);
  else if (game.state === "gameover") {
    if (isScoreEntryBlockingEnter(game)) return;
    stopParade(game);
    game.killedRowEl.classList.add("hidden");
    game.killedSnapshots = [];
    showTitle(game);
  }
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
  game.sound.fadeForPause(0, 0.35);
  game.overlayTitleEl.textContent = "Paused";
  game.overlayStartEl.textContent = "Resume";
  game.overlayStartEl.classList.remove("hidden");
  game.overlayEl.classList.remove("hidden");
  game.overlayEl.classList.add("paused");
  game.overlayEl.classList.remove("gameover-layout");
  hideGameOverIntro();
  game.abortEl.classList.remove("hidden");
  emitGameState(game);
};

const leavePause = (game: Game) => {
  game.state = "playing";
  game.sound.fadeForPause(1, 0.25);
  game.overlayEl.classList.add("hidden");
  game.overlayEl.classList.remove("paused");
  game.abortEl.classList.add("hidden");
  emitGameState(game);
};

// broadcast the game's coarse lifecycle state for UI chrome (pause button visibility,
//   pause-screen controls panel). Cheap, fires only on transition.
export const emitGameState = (game: Game) => {
  window.dispatchEvent(new CustomEvent("game:state", { detail: { state: game.state } }));
};

// Finalise the in-flight replay recorder (live runs only — replay-driven runs
//   already discarded it). Bytes land on game.lastRunReplay asynchronously
//   after gzip; the gameover overlay polls for them before showing the upload
//   button.
export const finalizeRecorder = (game: Game): void => {
  if (!game.recorder) return;
  const r = game.recorder;
  game.recorder = null;
  void r.serialize({
    score: game.score,
    wave: game.wave,
    maxCombo: game.maxCombo,
    killCount: Object.values(game.killTally).reduce((s, n) => s + n, 0),
  }).then((bytes) => { game.lastRunReplay = bytes; });
};

// lets a stuck player exit cleanly via the kill-row screen without having to die out.
export const abortMission = (game: Game) => {
  if (game.state !== "paused") return;
  game.state = "gameover";
  finalizeRecorder(game);
  game.ship.thrustOn = false;
  game.ship.reverseThrustOn = false;
  game.ship.portThrustOn = false;
  game.ship.starboardThrustOn = false;
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopSideThrust();
  stopAllPersistentAudio(game);
  game.sound.fadeForPause(1, 0.1);
  game.lastRunScore = game.score;
  game.lastRunScoreId = null;
  game.abortEl.classList.add("hidden");
  game.overlayTitleEl.textContent = "";
  game.overlayStartEl.classList.add("hidden");
  game.overlayEl.classList.remove("hidden");
  game.overlayEl.classList.add("gameover-layout");
  const shipSnap = snapshotShipKill(game.ship, "death");
  if (shipSnap) game.killedSnapshots.push(shipSnap);
  renderKilledRow(game, "vertical");
  showGameOverIntro(game, "aborted");
  showScoreEntry(game);
  emitGameState(game);
};

// combo grid may have flipped (8ths→quarters if previous life had rapid); rebase the eval index.
export const respawn = (game: Game) => {
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  game.ship.invuln = 2.2;
  game.nextBeatToEvaluate = Math.max(0, Math.floor((game.perceivedBeatTime - beatWindow(game)) / comboGrid(game)) + 1);
  game.state = game.replayPlayer ? "replaying" : "playing";
  syncHud(game);
  emitGameState(game);
};

// death pauses beatTime so a leftover streak would pin the HUD until respawn — drop it now.
export const killShip = (game: Game) => {
  game.lives -= 1;
  game.shake = 1.5;
  game.state = "dying";
  game.dyingTimer = 1.8;
  emitGameState(game);
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

// Start playing a recorded replay. startGame runs with the recorded seed +
//   tutorial/veteran flags supplied up front, so wave-1 spawn and every
//   downstream RNG draw match the original run. The ReplayPlayer's
//   ReplayInput then drives dt + key state from the recorded frames.
export const startReplay = async (game: Game, bytes: Uint8Array): Promise<void> => {
  const payload = await decodeReplay(bytes);
  const player = new ReplayPlayer(payload);
  // install the recording-time bindings *before* startGame, since startGame's
  //   recorder construction reads getBindings() (skipped on the replay path) and
  //   the wave-spawn doesn't need bindings — but every isDown call from frame 1
  //   onward will.
  setReplayBindings(normalizeBindings(payload.header.bindings));
  // Lock the sim to the recording's dimensions before startGame spawns the
  //   ship — ship.pos and edge-wrap depend on game.w/h, and any mismatch
  //   diverges motion from frame 0. resize() reads replayLockedDims to switch
  //   into the locked-canvas + CSS-letterbox rendering mode.
  game.replayLockedDims = { w: payload.header.w, h: payload.header.h, dpr: payload.header.dpr };
  game.resize();
  startGame(game, {
    seed: payload.header.seed,
    tutorial: payload.header.tutorial,
    veteran: payload.header.veteran,
    recorder: false,
  });
  game.replayPlayer = player;
  game.input = player.input;
  game.state = "replaying";
  emitGameState(game);
};
