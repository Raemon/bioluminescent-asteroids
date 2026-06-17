import type { Game } from "../Game";
import { dist } from "../vec";
import { Asteroid } from "../Asteroid";
import { Alien, ALIEN_FIRE_PATTERN_BEATS, bigAlienBurstAngleOffset } from "../Alien";
import { AlienBullet } from "../AlienBullet";
import { ENTITY_CONFIG } from "./entityConfig";
import { BEAT_GRID, DEBUG_BEAT_TIMING } from "./rhythmConstants";
import {
  isInBeatWindow,
  logBeatEvent,
  spawnBeatDebugPopup,
  evaluateClosedBeats,
  currentBeatPulse,
  comboGrid,
} from "./rhythmGate";
import { BASS_KIND_SOUND, BASS_SPLIT_PITCH_RATIO, tickBassBeats, tickAuxBeats } from "./bassClock";
import { tickWaveEvents } from "./waveEvents";
import { detonateShockwave } from "./shockwave";
import { spawnWave, isBossWave, updateBgBeatIntensity, spawnTutorialSmall, spawnTutorialBig, rhythmSpeedMul, displayWave } from "./waveDirector";
import { showWaveSummary } from "./waveSummary";
import {
  handleCollisions,
  handleAlienHits,
  handleAlienBulletHits,
  handleCometHits,
  handleCanisterPickups,
  handleCanisterShots,
  handleGoldCrystalPickups,
  expireGoldCrystal,
} from "./collisions";
import { requestStart, showTitle, togglePause, respawn, setFirstWaveHintStage, setFirstWaveHintSubVisible, emitFirstWaveHintProgress, emitFirstWaveHintRhythmProgress, emitTutorialHoverProgress, emitTutorialControls, emitGameState, finalizeRecorder, restartReplayWorld } from "./lifecycle";
import { syncHud, syncPowerupHud, syncComboHud } from "./hud";
import { renderKilledRow, stopParade } from "./killedParade";
import { snapshotShipKill } from "./killSnapshot";
import { updatePopups, popupDriftBonus } from "./popups";
import { updateBassLightnings } from "./bassLightning";
import { tickPendingRhythmBonuses } from "./rhythmBonus";
import { emitExplosion } from "./particleBursts";
import { musicDtForFrame } from "./slowMo";
import { hideScoreEntry, isScoreEntryBlockingEnter, showScoreEntry, tickLeaderboardKeyRepeat } from "./scoreEntry";
import { showGameOverIntro } from "./gameOverIntro";
import { isDown, wasPressed } from "./controlBindings";
import { tickLaserShot, FIRE_FLASH_DECAY } from "./laserShot";
import { fireBossSweepBeam, tickBossBeams } from "./bossBeam";

// single dispatcher means main.ts has one update entry; per-state branches live below.
export const updateGame = (game: Game, dt: number) => {
  // Replay drives the sim from recorded frames rather than live dt. The
  //   scrubber controls how many recorded frames advance per render tick:
  //   paused → 0, 1x → 1, 2x/4x → several. Seeks (rewind/fast-forward to a
  //   target frame) are handled separately by stepping the sim with audio
  //   muted. See runReplay for the speed/seek dispatch.
  if (game.replayPlayer) { runReplay(game); return; }
  advanceFrame(game, dt);
};

// One simulation+input frame. dt is the recorded value during replay (so
//   scale-with-dt physics reproduces) or the live frame dt during normal play.
const advanceFrame = (game: Game, dt: number) => {
  // First-run warm-up: the run has started but the world is held — only the beat
  //   ticks while the player practices the rhythm. The same clock carries into
  //   live play when finishCalibrationIntro fires, so the pulse never restarts.
  if (game.calibrationIntro) { updateCalibration(game, dt); return; }
  // Pilot's-log / "Latency calibrated" intro screens hold the world the same way —
  //   the bgBeat ticks under a black overlay while <IntroSequence> drives its
  //   beat-locked fade-ins.
  if (game.introOverlayActive) { updateCalibration(game, dt); return; }
  // A full-screen menu (settings dialog / standalone recalibrator) is up mid-run —
  //   freeze the sim so the ship can't drift or die behind it. The modal owns the
  //   keys (it stops propagation), so input is already shielded; we just hold the
  //   world until both flags clear, then play resumes exactly where it left off.
  if ((game.settingsOpen || game.calibrating) && (game.state === "playing" || game.state === "dying")) {
    game.input.endFrame();
    return;
  }
  if (wasPressed(game.input, "pause")) togglePause(game);
  else if (game.state === "paused" && pressedStart(game)) togglePause(game);
  if (game.state === "paused") { game.input.endFrame(); return; }
  game.time += dt * 1000;
  // title/gameover/paused freeze beatTime; playing+dying defer pulsar to after tickBassBeats.
  if (game.state !== "playing" && game.state !== "dying" && game.state !== "replaying") game.pulsar.update(dt, game.perceivedBeatTime, BEAT_GRID);
  routeStateUpdate(game, dt);
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 3);
  game.input.endFrame();
};

// Pull the next recorded frame and advance the sim one step. Returns false
//   when the stream is exhausted (the caller decides whether that ends the
//   replay or just stops a seek at the last frame).
const stepReplayFrame = (game: Game): boolean => {
  const replayDt = game.replayPlayer!.nextFrame();
  if (replayDt === null) return false;
  advanceFrame(game, replayDt);
  return true;
};

// Replay dispatch for one render tick. Handles seeking to a target frame
//   (rewind = rebuild the world at frame 0, then fast-forward; both seek
//   directions step with audio muted), then normal speed-scaled playback.
const runReplay = (game: Game) => {
  if (game.replaySeekTarget !== null) {
    seekReplayToTarget(game);
    return;
  }
  // Paused: hold the frame, but keep emitting position so a drag that ends on
  //   the same frame still re-renders. Nothing to step.
  if (game.replaySpeed <= 0) {
    emitReplayProgress(game);
    return;
  }
  // 2x/4x run multiple recorded frames per render tick; fractional speeds
  //   (0.5x) carry the remainder so they don't lose frames over time.
  game.replayStepAccumulator += game.replaySpeed;
  let steps = Math.floor(game.replayStepAccumulator);
  game.replayStepAccumulator -= steps;
  while (steps-- > 0) {
    if (!stepReplayFrame(game)) { finishReplay(game); return; }
  }
  emitReplayProgress(game);
};

// Jump the sim to game.replaySeekTarget. Backward seeks rebuild the world at
//   frame 0 (no state snapshots exist — replay is a pure input re-sim), then
//   both directions fast-step to the target with sound muted so the catch-up
//   doesn't fire a burst of replayed audio.
const seekReplayToTarget = (game: Game) => {
  const target = Math.max(0, Math.min(game.replaySeekTarget!, game.replayPlayer!.total()));
  game.replaySeekTarget = null;
  const muted = game.sound.beginSeekMute();
  if (target < game.replayPlayer!.position()) restartReplayWorld(game);
  while (game.replayPlayer!.position() < target) {
    if (!stepReplayFrame(game)) break;
  }
  game.sound.endSeekMute(muted);
  emitReplayProgress(game);
};

const emitReplayProgress = (game: Game) => {
  if (!game.replayPlayer) return;
  window.dispatchEvent(new CustomEvent("replay:progress", {
    detail: {
      position: game.replayPlayer.position(),
      total: game.replayPlayer.total(),
      speed: game.replaySpeed,
    },
  }));
};

const finishReplay = (game: Game) => {
  game.replayPlayer = null;
  // Unlock canvas dims and resize back to the live window now that the sim
  //   isn't pinned to the recording's resolution anymore.
  game.replayLockedDims = null;
  game.resize();
  // Treat reaching the end of the stream like the player's natural game-over so
  //   the existing gameover overlay + leaderboard view light up unchanged.
  transitionToGameOver(game);
};

const routeStateUpdate = (game: Game, dt: number) => {
  if (game.state === "title") updateTitle(game, dt);
  else if (game.state === "gameover") updateGameOver(game, dt);
  else if (game.state === "dying") updateDying(game, dt);
  else updatePlaying(game, dt);  // "playing" or "replaying"
};

// First-run warm-up tick: advance the beat clock and play the bgBeat (the very
//   same path live play uses) plus the pulsar's visual flash — nothing else. The
//   player taps along behind the calibration overlay; finishCalibrationIntro
//   hands straight over to updatePlaying without resetting beatTime.
const updateCalibration = (game: Game, dt: number) => {
  game.beatTime += dt;
  tickAuxBeats(game);
  game.pulsar.update(dt, game.perceivedBeatTime, BEAT_GRID);
  game.input.endFrame();
};

// Enter/Return/Space all trigger start — covers different keyboards and the arcade reflex.
const pressedStart = (game: Game): boolean =>
  game.input.pressed("enter") || game.input.pressed("return") || game.input.pressed(" ") || game.input.pressed("spacebar");

// title needs cosmetic motion + enter-to-start; nothing else fires here.
const updateTitle = (game: Game, dt: number) => {
  if (pressedStart(game)) requestStart(game);
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
  if (wasPressed(game.input, "pause")) hideScoreEntry(game);
  const enterPressed = pressedStart(game);
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
  finalizeRecorder(game);
  game.sound.stopAllAlienDrones();
  game.sound.stopAllBassteroidDrones();
  game.sound.stopAllWarbleDrones();
  game.sound.stopAllCometShimmers();
  game.sound.stopHaloAmbient();
  game.comets = [];
  game.lastRunScore = game.score;
  game.lastRunScoreId = null;
  game.overlayTitleEl.textContent = "";
  game.overlayStartEl.classList.add("hidden");
  game.overlayEl.classList.remove("hidden");
  game.overlayEl.classList.add("gameover-layout");
  const shipSnap = snapshotShipKill(game.ship, "death");
  if (shipSnap) game.killedSnapshots.push(shipSnap);
  renderKilledRow(game, "vertical");
  showGameOverIntro(game, "gameover");
  showScoreEntry(game);
  emitGameState(game);
};

import { BOSS_MUSIC_VARIATION, HALO_MUSIC_POOL, PLAY_COMBO_MUSIC, pickHaloMusicVariation, pickHaloMusicVariationExcluding } from "./haloMusicConfig";
import { BASS_MEASURE_LENGTH } from "../Asteroid";

// Only true comets carry the phrygian shimmer the comet-mode pad voices around;
// meteors are silent flock members, so they must not flip the halo pad.
const hasMusicalComet = (game: Game): boolean => game.comets.some((c) => !c.isMeteor);

// yellow-halo (combo ≥ 4) opens the ambient pad; combo ≥ 6 adds the
//   melodic layer; combo ≥ 12 adds layer 3 (a single new musical element per
//   variation — lonely violin / felt glockenspiel / synth-bass arp / chime
//   counter-melody); combo ≥ 24 crossfades to a fresh random variation as
//   the climax tier; white-bullet tier (≥ 8) thickens the legacy synth pad
//   with an octave-up sparkle layer. Comet presence slides the colour-third
//   from E→Eb so the pad stays consonant with the comet's phrygian shimmer
//   instead of fighting it.
//
//   Music variation: each time combo crosses 4 from below, we pick a fresh
//   random variation from HALO_MUSIC_POOL — so successive combo runs in the
//   same wave don't always sound the same. The chosen variation persists on
//   game.sound.haloMusic.variation, so the 6x melodic-layer and 12x layer-3
//   toggles use the same variation's stems (no half-EL/half-self-built
//   mash-ups). At 24x we pick a *second* variation (excluding the current)
//   and crossfade — that swap sticks until the next combo break, so
//   dropping back below 24x but staying ≥ 4 doesn't bounce back.
const syncHaloAmbient = (game: Game) => {
  const hasYellowHalo = game.beatCombo >= 4;
  const hasMelodic = game.beatCombo >= 6;
  const hasWhiteBullets = game.beatCombo >= 12;
  const hasLayer3 = game.beatCombo >= 12;
  // 24x climax: crossfade to a fresh random variation. Sticks for the rest
  // of the halo's life (no fallback if combo drops below 24x but stays ≥ 4).
  const hasClimax = game.beatCombo >= 24;

  if (!PLAY_COMBO_MUSIC) {
    if (game.sound.haloMusic) game.sound.stopHaloMusic();
    if (game.sound.haloAmbient) game.sound.stopHaloAmbient();
    game.sound.setHaloAmbientCometMode(hasMusicalComet(game));
    return;
  }

  if (HALO_MUSIC_POOL.length > 0) {
    // Pre-rendered music path. Three layers: ambient (4x) + melodic (6x) + layer3 (12x).
    // On boss waves, force the dedicated climactic variation. The boss
    // theme replaces the random halo pick AND blocks the 24x climax swap so
    // the boss-fight track plays for the entire engagement.
    const bossWave = isBossWave(game.wave);
    if (hasYellowHalo) {
      if (!game.sound.haloMusic) {
        const variation = bossWave ? BOSS_MUSIC_VARIATION : pickHaloMusicVariation(game.wave);
        // Schedule the music's downbeat on the next bass-measure boundary
        // so the loop's chord changes align with the bass field's measure
        // clock. Worst-case wait is BASS_MEASURE_LENGTH (2 s); typical is
        // ~1 s. The 4x-combo halo "ignites" on the next downbeat rather
        // than mid-bar.
        const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
        const measureAlignDelay = nextDownbeat - game.beatTime;
        game.beatPhaseCorrection = 0;
        void game.sound.startHaloMusic(variation, hasMelodic, measureAlignDelay, game.beatTime, hasLayer3);
      } else {
        game.sound.setHaloMusicMelodicLayer(hasMelodic);
        game.sound.setHaloMusicLayer3(hasLayer3);
        // Entered the boss wave holding a halo from the prior wave: the random
        // track is still playing and the !haloMusic branch above never ran, so
        // force a swap to the boss theme. climaxActive doubles as the swap-in-
        // flight guard so a frame's worth of re-entry can't stack crossfades.
        if (bossWave && game.sound.haloMusic.variation !== BOSS_MUSIC_VARIATION && !game.sound.haloMusic.climaxActive) {
          const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
          const measureAlignDelay = nextDownbeat - game.beatTime;
          game.beatPhaseCorrection = 0;
          void game.sound.crossfadeHaloMusic(BOSS_MUSIC_VARIATION, measureAlignDelay, game.beatTime);
        }
        if (hasClimax && !game.sound.haloMusic.climaxActive && !bossWave) {
          const next = pickHaloMusicVariationExcluding(game.sound.haloMusic.variation, game.wave);
          const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
          const measureAlignDelay = nextDownbeat - game.beatTime;
          game.beatPhaseCorrection = 0;
          void game.sound.crossfadeHaloMusic(next, measureAlignDelay, game.beatTime);
        }
      }
    } else if (game.sound.haloMusic) {
      game.sound.stopHaloMusic();
    }
  } else {
    // Legacy synthesized pad. 4x opens, 12x adds octave-up sparkle.
    if (hasYellowHalo) {
      if (!game.sound.haloAmbient) game.sound.startHaloAmbient(hasWhiteBullets ? 2 : 1);
      else game.sound.setHaloAmbientTier(hasWhiteBullets ? 2 : 1);
    } else if (game.sound.haloAmbient) {
      game.sound.stopHaloAmbient();
    }
  }
  game.sound.setHaloAmbientCometMode(game.comets.length > 0);
};

// seconds the reticule must rest on a first-beat dot to clear the hover gate.
const TUTORIAL_HOVER_SEC = 1.0;

// Guided-tutorial spawn machine. Holds exactly one small practice rock (respawns
//   when killed) and watches the two gates: hover a first-beat dot for 1s, then
//   land one on-beat hit (set in killEffects). Clearing both graduates to the
//   big-asteroid phase: one large rock at a time, respawning on clear, until
//   the hint progression finishes (stage 0). The hover gate reads the ship's
//   hover-ring timer.
const tickTutorialSpawn = (game: Game) => {
  if (!game.tutorialActive) return;
  if (game.tutorialFireHitDone) {
    // big phase. Once the hint progression finishes (stage 0), the next time
    //   the field empties we kick off the real Wave 1 — fresh spawn + the
    //   standard "Wave 1" title flash, as if the tutorial were a warm-up.
    if (game.asteroids.length === 0) {
      if (game.firstWaveHintStage === 0) {
        game.tutorialActive = false;
        spawnWave(game);
        showWaveAnnounce(game);
      } else {
        spawnTutorialBig(game);
      }
    }
    return;
  }
  if (game.firstWaveHintStage === 1) {
    tickControlsGate(game);
  } else if (game.firstWaveHintStage === 3) {
    // drift/hold gate: reticule rested on a first-beat dot for a full second.
    const hoverStart = game.ship.hoverDotRingState.hoverStartBeatTime;
    const elapsed = hoverStart === null ? 0 : game.perceivedBeatTime - hoverStart;
    emitTutorialHoverProgress(Math.max(0, Math.min(1, elapsed / TUTORIAL_HOVER_SEC)));
    if (elapsed >= TUTORIAL_HOVER_SEC) setFirstWaveHintStage(game, 4);
  }
  if (game.asteroids.length === 0) spawnTutorialSmall(game);
};

// controls gate: tracks rotate/thrust/reverse/fire usage so the keys fade individually
//   in the hint. Tutorial mode (stage 1) advances to stage 2 once all four are
//   used; normal mode just dismisses the start-of-run hint.
const tickControlsGate = (game: Game) => {
  const used = game.tutorialControlsUsed;
  let changed = false;
  if (!used.rotate && (isDown(game.input, "rotateLeft") || isDown(game.input, "rotateRight"))) { used.rotate = true; changed = true; }
  if (!used.thrust && isDown(game.input, "thrust")) { used.thrust = true; changed = true; }
  if (!used.back && isDown(game.input, "reverse")) { used.back = true; changed = true; }
  if (!used.fire && isDown(game.input, "fire")) { used.fire = true; changed = true; }
  if (changed) emitTutorialControls(used.rotate, used.thrust, used.back, used.side, used.fire);
  if (used.rotate && used.thrust && used.back && used.fire) {
    if (game.tutorialActive && game.firstWaveHintStage === 1) {
      setFirstWaveHintStage(game, 2);
    } else if (game.controlsHintActive) {
      game.controlsHintActive = false;
      window.dispatchEvent(new CustomEvent("controls-hint:dismiss"));
    }
  }
};

// ease bgBeat from practice level to wave level across calibration→play
const tickBeatIntensityRamp = (game: Game, dt: number) => {
  const r = game.beatIntensityRamp;
  if (!r) return;
  r.t += dt;
  const f = Math.min(1, r.t / r.dur);
  game.sound.bgBeatIntensity = r.from + (r.to - r.from) * f;
  if (f >= 1) game.beatIntensityRamp = null;
};

// tracked across frames so we only push a new playbackRate when it changes
// meaningfully — avoids hammering AudioParam every frame at the same rate.
let lastCommandedPlaybackRate = 1;

const BEAT_RESNAP_INTERVAL = BASS_MEASURE_LENGTH;
const BEAT_RESNAP_THRESHOLD = 0.030;
// above this we assume a real stall (tab suspend, GC pause, debugger) rather
// than gradual drift — bleeding it off as a tempo nudge would take many
// seconds of audibly-wrong cadence, so we accept a one-shot skip instead.
const BEAT_RESNAP_HARD_SNAP = 0.5;
// fraction of dt that any single frame's correction is allowed to consume,
// so corrections sound like a subtle breath rather than a tempo shift.
const PHASE_CORRECTION_RATE = 0.25;

// Watchdog: once a measure, compare beatTime to the music's actual playback
// position. Small errors get bled off over many frames via beatPhaseCorrection;
// huge errors (post-stall) hard-snap and re-sync the bgBeat index.
const tickBeatResnap = (game: Game) => {
  if (game.slowMoTimer > 0) return;
  if (game.beatTime - game.lastBeatResnapAt < BEAT_RESNAP_INTERVAL) return;
  game.lastBeatResnapAt = game.beatTime;
  const expected = game.sound.audioBeatTimeFromMusic();
  if (expected === null) return;
  const error = expected - game.beatTime;
  if (Math.abs(error) < BEAT_RESNAP_THRESHOLD) return;
  if (Math.abs(error) >= BEAT_RESNAP_HARD_SNAP) {
    const EIGHTH_GRID = BEAT_GRID / 2;
    game.beatTime = expected;
    game.lastBgBeatIndex = Math.floor(expected / EIGHTH_GRID);
    game.lastBeatResnapAt = expected;
    game.beatPhaseCorrection = 0;
    if (DEBUG_BEAT_TIMING) {
      console.log(`[beat-resnap] error=${(error * 1000).toFixed(1)}ms  hard-snapped`);
    }
    return;
  }
  game.beatPhaseCorrection = error;
  if (DEBUG_BEAT_TIMING) {
    console.log(`[beat-resnap] error=${(error * 1000).toFixed(1)}ms  bleeding`);
  }
};

// Bleeds beatPhaseCorrection into musicDt so tickBassBeats advances beatTime
// by a fraction of the pending error each frame — corrections never skip or
// duplicate an eighth-note slot, just gently warp tempo until phase aligns.
const applyBeatPhaseCorrection = (game: Game, musicDt: number): number => {
  if (game.beatPhaseCorrection === 0) return musicDt;
  const cap = musicDt * PHASE_CORRECTION_RATE;
  const delta = Math.max(-cap, Math.min(cap, game.beatPhaseCorrection));
  game.beatPhaseCorrection -= delta;
  return musicDt + delta;
};

// ordered phases (ship → bass → world → collisions) so cause-and-effect reads top-down.
const updatePlaying = (game: Game, dt: number) => {
  game.recorder?.captureFrame(dt, game.input);
  tickBeatIntensityRamp(game, dt);
  tickTutorialSpawn(game);
  if (game.controlsHintActive) tickControlsGate(game);
  const bulletsBeforeShipUpdate = game.bullets.length;
  game.ship.setCombo(game.beatCombo);
  syncHaloAmbient(game);
  game.ship.update(dt, game.input, game.particles, game.bullets, game.w, game.h, game.time, game.sound);
  // Debug instrumentation: capture ship state right after physics tick so the
  //   recorded snapshot reflects the exact state the replay should reproduce.
  //   Replay-side compares to the same snapshot and logs the first divergence.
  game.recorder?.captureShip(game.ship, game.input);
  game.replayPlayer?.checkShipAgainstRecording(game.ship);
  tickLaserShot(game, dt);
  const rawMusicDt = tickSlowMoTimer(game, dt);
  // music slows with gameplay so beat+music stay locked through slow-mo.
  if (dt > 0) {
    const slowMoFactor = rawMusicDt / dt;
    if (Math.abs(slowMoFactor - lastCommandedPlaybackRate) > 0.001) {
      game.sound.setHaloMusicPlaybackRate(slowMoFactor, 0);
      lastCommandedPlaybackRate = slowMoFactor;
    }
  }
  tickBeatResnap(game);
  const musicDt = applyBeatPhaseCorrection(game, rawMusicDt);
  // playbackRate maps beatTime → audio-clock seconds for the lookahead pulse
  // scheduler; under slow-mo musicDt < dt so beats are scheduled further out.
  const beatPlaybackRate = dt > 0 ? rawMusicDt / dt : 1;
  tickBassBeats(game, musicDt, beatPlaybackRate);
  // pulsar runs against perceivedBeatTime so its flash lands with the *heard* bass voices.
  game.pulsar.update(dt, game.perceivedBeatTime, BEAT_GRID);
  game.ship.tickComboHalo(musicDt, currentBeatPulse(game));
  if (game.bullets.length > bulletsBeforeShipUpdate) classifyNewBullets(game, bulletsBeforeShipUpdate);
  graceFrameNearAsteroids(game);
  tickWavePhase(game, dt, musicDt);
  tickWorldEntities(game, dt, musicDt);
  game.particles.update(musicDt);
  game.popups = updatePopups(game.popups, dt);
  game.bassLightnings = updateBassLightnings(game.bassLightnings, dt);
  tickPendingDriftBonuses(game);
  tickPendingRhythmBonuses(game);
  runCollisionPasses(game);
  evaluateClosedBeats(game);
  syncPowerupHud(game);
  if (game.asteroids.length === 0 && !game.betaMode && !game.waveTransitioning && !game.tutorialActive) advanceWave(game);
};

// Drift Shot queue: on-beat hits made under a fully-locked first-dot hover ring
//   schedule a +1-rhythm reward for 1 beat later. If the streak broke before the
//   moment arrives, drop the entry — the bonus is tied to a live streak.
const tickPendingDriftBonuses = (game: Game) => {
  if (game.pendingDriftBonuses.length === 0) return;
  const keep: typeof game.pendingDriftBonuses = [];
  for (const entry of game.pendingDriftBonuses) {
    if (game.perceivedBeatTime < entry.fireAt) { keep.push(entry); continue; }
    if (game.beatCombo === 0) continue;
    game.beatCombo += 1;
    if (game.beatCombo > game.maxCombo) game.maxCombo = game.beatCombo;
    if (game.beatCombo > game.maxComboThisWave) game.maxComboThisWave = game.beatCombo;
    game.driftBonusesThisWave += 1;
    syncComboHud(game);
    game.sound.playComboChime(game.beatCombo, entry.pos);
    const firstOfRun = !game.hasShownDriftShotLabel;
    game.popups.push(popupDriftBonus(entry.pos, firstOfRun));
    if (firstOfRun) game.hasShownDriftShotLabel = true;
  }
  game.pendingDriftBonuses = keep;
};

// slow-mo timer ticks in wall-clock so its lifespan isn't extended by its own effect.
const tickSlowMoTimer = (game: Game, dt: number): number => {
  if (game.slowMoTimer > 0) game.slowMoTimer = Math.max(0, game.slowMoTimer - dt);
  return musicDtForFrame(dt, game.slowMoTimer);
};

// ≤1 fire event per frame, but prong emits multiple bullets — they all share one beat flag.
const classifyNewBullets = (game: Game, firstNewIndex: number) => {
  // perceivedBeatTime = beatTime shifted by the player's calibrated latency, so a
  //   press timed to the heard beat scores even when output latency makes it land
  //   late on the raw audio grid.
  const firedOnBeat = isInBeatWindow(game, game.perceivedBeatTime);
  const count = game.bullets.length - firstNewIndex;
  const lockedSlots = game.ship.hoverDotRingStates.map(r => r.completionBeatTime !== null);
  for (let i = firstNewIndex; i < game.bullets.length; i++) {
    game.bullets[i].firedAtBeatTime = game.perceivedBeatTime;
    game.bullets[i].driftLockedSlots = lockedSlots;
  }
  logBeatEvent(game, "FIRE", game.perceivedBeatTime, `bullets=${count}`);
  spawnBeatDebugPopup(game, game.ship.pos, game.perceivedBeatTime, "FIRE");
  if (firedOnBeat) handleOnBeatFire(game, firstNewIndex);
  else handleOffBeatFire(game);
  // deeper fireBeat pluck reinforces "you nailed the beat"; ship no longer plays its own.
  game.sound.play(firedOnBeat ? "fireBeat" : "fire");
};

// 0→1 priming step; above 1 only on-beat hits + beat closures bump combo, not consecutive fires.
const handleOnBeatFire = (game: Game, firstNewIndex: number) => {
  // boosted bullets fly while the yellow halo (combo ≥ 4, tier 2) is up.
  const boosted = game.ship.comboHaloTier >= 2;
  // combo ≥ 12 promotes to the white "super-boosted" tier — sharper look and
  // 1.5× range; same hitbox as yellow so the reward is reach, not sweep.
  const superBoosted = game.beatCombo >= 12;
  for (let i = firstNewIndex; i < game.bullets.length; i++) {
    const newBullet = game.bullets[i];
    newBullet.onBeat = true;
    newBullet.boosted = boosted;
    newBullet.superBoosted = superBoosted;
    if (superBoosted) {
      newBullet.life *= 1.5;
      newBullet.maxLife *= 1.5;
      const slotCount = Math.max(1, Math.floor(newBullet.maxLife / BEAT_GRID));
      newBullet.fadeStartLife = Math.max(0, newBullet.maxLife - slotCount * BEAT_GRID);
    }
  }
  game.sound.play("comboTick");
  if (game.beatCombo === 0) {
    game.beatCombo = 1;
    if (game.maxCombo < 1) game.maxCombo = 1;
    syncHud(game);
  }
  if (game.firstWaveHintStage === 2) {
    // fire-on-the-beat stage: 3 on-beat fires → advance to drift/hover (stage 3).
    game.firstWaveOnBeatFireCount += 1;
    emitFirstWaveHintProgress(game.firstWaveOnBeatFireCount);
    if (game.firstWaveOnBeatFireCount >= 3) setFirstWaveHintStage(game, 3);
  } else if (game.firstWaveHintStage === 4 && !game.firstWaveHintSubVisible) {
    // fire-and-hit stage: first on-beat *fire* (hit or not) reveals the targeting
    //   sub-line; the three diamonds are independently gated on on-beat *hits*.
    setFirstWaveHintSubVisible(game, true);
  } else if (game.firstWaveHintStage === 5) {
    // build-to-4x stage. 0→1 priming step mirrors into the row. Diamonds start at
    //   2x (diamond N = rhythm N+1), so priming alone leaves the row at 0.
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

// reticules sit at integer multiples of the rhythm grid out from the muzzle, so a bullet
// "crosses" its Nth reticule when its age passes N * grid. Each unseen crossing samples the
// beat window — if on-beat, flash white. Crossings are tracked per-bullet so a flash only
// triggers once per slot, and we count up to whatever the bullet's age has reached.
const FLASH_DURATION_SEC = 0.12;
const tickBulletReticuleCrossings = (game: Game) => {
  const grid = comboGrid(game);
  if (grid <= 0) return;
  for (const b of game.bullets) {
    const age = b.maxLife - b.life;
    const expected = Math.floor(age / grid);
    if (expected > b.reticuleCrossings) {
      // grid can halve mid-flight (combo crossing 16); snap to the new count without
      // firing a burst of phantom flashes for the past.
      b.reticuleCrossings = expected;
      const crossingTime = b.firedAtBeatTime + expected * grid;
      if (isInBeatWindow(game, crossingTime)) b.flashTimer = FLASH_DURATION_SEC;
    }
  }
};

// slow-mo slows the whole world via musicDt — asteroids, comets, aliens, bullets, shards, canisters.
//   Ship stays on wall-clock dt (updated earlier) so player reactions feel responsive.
const tickWorldEntities = (game: Game, _dt: number, musicDt: number) => {
  for (const c of game.comets) c.update(musicDt, game.w, game.h);
  pruneDeadComets(game);
  for (const a of game.asteroids) a.update(musicDt, game.w, game.h);
  // prune goldDiamonds that flew fully offscreen; no other kind clears alive.
  compactInPlace(game.asteroids, (a) => a.alive);
  for (const al of game.aliens) al.update(musicDt, game.w, game.h);
  pruneOffscreenAliens(game);
  tickAlienFire(game);
  tickBossRhythm(game);
  tickWraiths(game, musicDt);
  for (const b of game.bullets) b.update(musicDt, game.w, game.h);
  tickBulletReticuleCrossings(game);
  compactInPlace(game.bullets, (b) => b.life > 0);
  for (const l of game.lasers) l.update(musicDt, game);
  compactInPlace(game.lasers, (l) => l.alive);
  if (game.laserFireFlash > 0) {
    game.laserFireFlash = Math.max(0, game.laserFireFlash - musicDt / FIRE_FLASH_DECAY);
  }
  for (const ab of game.alienBullets) ab.update(musicDt, game.w, game.h);
  compactInPlace(game.alienBullets, (ab) => ab.life > 0);
  tickBossBeams(game, musicDt);
  for (const s of game.shards) s.update(musicDt);
  compactInPlace(game.shards, (s) => s.life > 0);
  for (const c of game.canisters) {
    const wasWarping = c.warping;
    c.update(musicDt, game.w, game.h);
    if (!wasWarping && c.warping) game.sound.play("canisterAppear", 1, c.pos);
  }
  compactInPlace(game.canisters, (c) => c.alive);
  for (const g of game.goldCrystals) {
    const wasAlive = g.alive;
    g.update(musicDt, game.w, game.h);
    // collect/waste paths remove gems via handleGoldCrystalPickups without
    // touching alive, so any alive→dead transition here is a lifetime expiry.
    if (wasAlive && !g.alive) expireGoldCrystal(game, g);
  }
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
    if (a.kind === "warble") {
      // Lazily open the voice (guards against dupes) and ride the phase morph:
      // ghost = 1 - opacity, so the hum warbles harder as the rock fades out.
      game.sound.startWarbleDrone(a, a.pos);
      game.sound.updateWarbleDrone(a, a.pos);
      game.sound.setWarbleDronePhase(a, 1 - a.warbleOpacity);
    }
  }
  for (const al of game.aliens) game.sound.updateAlienDrone(al, al.pos);
  for (const c of game.comets) if (!c.isMeteor) game.sound.updateCometShimmer(c, c.pos);
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

// Aliens fly across the field on an arc and despawn once they drift past the
// far side. They mark themselves !alive in update(); we drop them here and
// release their drone so the chord doesn't keep humming after they're gone.
const pruneOffscreenAliens = (game: Game) => {
  const surviving: typeof game.aliens = [];
  for (const a of game.aliens) {
    if (a.alive) surviving.push(a);
    else game.sound.stopAlienDrone(a);
  }
  game.aliens = surviving;
};

// shots aim at the player's pos at fire-time — dodging works by moving between beats.
const tickAlienFire = (game: Game) => {
  if (game.aliens.length === 0) return;
  for (const a of game.aliens) {
    while (game.beatTime >= a.nextFireAt) fireOneAlienShot(game, a);
  }
};

// Boss 8-beat rhythm. Every 4s cycle drives top/bottom hemisphere flashes,
// iris flash, pupil double-pulse, and the charged laser shot — all snapped
// to game.beatTime so the boss "plays along" with the music. Post-break the
// hemispheres each fire a slow plasma ball on their flash slot.
const tickBossRhythm = (game: Game) => {
  for (const a of game.asteroids) {
    if (!a.isBoss() && a.kind !== "bossEye" && a.kind !== "bossHemisphere") continue;
    // Boss-eye-open edge: the dormant→live transition just fired this tick.
    // Play the dissonant stinger and wipe the player's combo — the boss
    // arriving is a "wrong-note" moment, the music's tonal centre is broken.
    // Skip loseCombo() because its "wrrr" SFX would step on the stinger and
    // because the boss reset is a HARD wipe (a normal off-beat at 32x drops
    // to 4x; here the player drops to 0 regardless).
    if (a.bossJustOpenedEye) {
      a.bossJustOpenedEye = false;
      game.sound.play("bossEyeOpenStinger", 1.0, a.pos);
      if (game.beatCombo > 0) {
        game.beatCombo = 0;
        game.ship.comboLossFlash = 1;
        syncComboHud(game);
      }
    }
    a.trackPlayer(game.ship.pos.x, game.ship.pos.y);
    const ev = a.tickBossRhythm(game.beatTime);
    if (ev.topFlash || ev.bottomFlash || ev.irisFlash) game.sound.play("bossPulse", 0.9, a.pos);
    if (ev.pupilFlash) game.sound.play("bossPulse", 1.0, a.pos);
    if (ev.firePlasma) fireBossHemispherePlasma(game, a);
    if (ev.fireLaser) fireBossEyeBolt(game, a);
  }
};

const tickWraiths = (game: Game, dt: number) => {
  for (const a of game.asteroids) {
    if (a.kind !== "wraith") continue;
    const didLunge = a.tickWraith(dt, game.ship.pos.x, game.ship.pos.y, game.beatTime);
    if (didLunge) game.sound.play("wraithLunge", 1, a.pos);
  }
};

const fireBossEyeBolt = (game: Game, a: Asteroid) => {
  // Emit a sustained beam that sweeps across the locked aim direction (the
  // line re-aimed at the player on each windup beat and locked on beat 7 —
  // see Asteroid.tickLaserAim). The beam enters from one side, slashes
  // through where the player was, and exits the far side, so juking out of
  // the sweep's arc dodges it.
  const angle = a.eyeAimAngle();
  fireBossSweepBeam(game, a, angle);
  game.sound.play("alienFireBig", 1.0, a.pos);
  game.sound.play("bossPulse", 1.0, a.pos);
};

// Post-break, top/bottom hemispheres each launch one heavy plasma ball
// per cycle on their own flash beat. The ball lives exactly 4 beats and
// fades over the 5th — a sustained dodge window per shot.
const fireBossHemispherePlasma = (game: Game, a: Asteroid) => {
  const angle = Math.atan2(game.ship.pos.y - a.pos.y, game.ship.pos.x - a.pos.x);
  const speed = ENTITY_CONFIG.boss.eyeBulletSpeed * 0.85;
  const muzzleDist = a.radius * 0.95;
  const muzzleX = a.pos.x + Math.cos(angle) * muzzleDist;
  const muzzleY = a.pos.y + Math.sin(angle) * muzzleDist;
  const bullet = new AlienBullet(
    { x: muzzleX, y: muzzleY },
    { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    "big",
    a.hue,
    true,
  );
  bullet.isBossHemiPlasma = true;
  bullet.maxLife = BEAT_GRID * 5;
  bullet.fadeStartLife = BEAT_GRID * 1;
  bullet.life = bullet.maxLife;
  game.alienBullets.push(bullet);
  game.sound.play("alienFireBig", 0.8, a.pos);
};

const fireOneAlienShot = (game: Game, a: Alien) => {
  if (game.ship.alive) {
    const angleOffset = a.size === "big" ? bigAlienBurstAngleOffset(a.firePatternIndex) : 0;
    const bullet = a.fireAt(game.ship.pos, angleOffset);
    if (a.size === "small") {
      const k = rhythmSpeedMul(game);
      bullet.vel.x *= k;
      bullet.vel.y *= k;
    }
    game.alienBullets.push(bullet);
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
  inner.textContent = `Wave ${displayWave(game.wave)}`;
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
  const driftBonuses = game.driftBonusesThisWave;
  const nextWave = completedWave + 1;
  game.sound.play("waveClear");
  game.sound.play("pulsarHum");
  game.pulsar.waveClear();
  if (wasBossWave) game.pulsar.setBossPlanetState("defeated");
  game.waveTransitioning = true;
  showWaveSummary(game, displayWave(completedWave), maxRhythm, finalRhythm, driftBonuses, () => {
    game.wave = nextWave;
    // opening rocks' speed keys off the peak combo of the wave just cleared, not
    //   the live combo at spawn (which a death or whiff may have already reset).
    game.waveStartRhythm = game.maxComboThisWave;
    game.maxComboThisWave = game.beatCombo;
    game.driftBonusesThisWave = 0;
    game.pulsar.setWaveLevel(game.wave);
    updateBgBeatIntensity(game);
    spawnWave(game);
    showWaveAnnounce(game);
    syncHud(game);
    game.waveTransitioning = false;
  });
  syncHud(game);
};
