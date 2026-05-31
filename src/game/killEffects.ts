import type { Game } from "../Game";
import { Asteroid } from "../Asteroid";
import { Alien } from "../Alien";
import { Comet } from "../Comet";
import { Bullet } from "../Bullet";
import { Vec } from "../vec";
import { spawnGoldCrystalAt } from "../GoldCrystal";
import { loseCombo, rebaseBeatEval } from "./rhythmGate";
import { syncComboHud, syncHud, flashScoreGain } from "./hud";
import { markFirstWaveTutorialComplete, setFirstWaveHintStage } from "./lifecycle";
import { tryUnlockPilotLog1, tryUnlockPilotLog3 } from "./pilotLog";
import { popupCombo, popupScore } from "./popups";
import {
  emitExplosion,
  emitCrackParticles,
  emitAlienExplosion,
  emitCometExplosion,
} from "./particleBursts";
import { snapshotAsteroidKill, snapshotAlienKill, snapshotCometKill } from "./killSnapshot";
import { alignBassBeat, alignSplitChildToRhythm, newBeatClaimSet } from "./waveDirector";
import { BASS_KIND_SOUND } from "./bassClock";
import type { KillBucket } from "./killBuckets";

// feeds the leaderboard's per-run breakdown; bucket names stay human-readable for display.
const bumpKill = (game: Game, bucket: KillBucket) => {
  game.killTally[bucket] = (game.killTally[bucket] ?? 0) + 1;
};

const asteroidBucket = (a: Asteroid): KillBucket => {
  if (a.kind === "boss") return "boss";
  if (a.isBass()) return "bassteroid";
  if (a.kind === "chime" || a.kind === "bell" || a.kind === "warble" || a.kind === "tink") return a.kind;
  if (a.kind === "goldCrystal") return "goldCrystal";
  return `asteroid_${a.size}`;
};

// bassteroids run their own bassHit/bassEcho path; this maps the non-bass kinds to sounds.
export const hitSoundFor = (
  a: Asteroid,
): "explosionLarge" | "explosionMedium" | "explosionSmall" | "chime" | "bell" | "warble" | "tink" => {
  if (a.kind === "chime") return "chime";
  if (a.kind === "bell") return "bell";
  if (a.kind === "warble") return "warble";
  if (a.kind === "tink") return "tink";
  return a.size === "large" ? "explosionLarge" : a.size === "medium" ? "explosionMedium" : "explosionSmall";
};

// same combo-update rule for every kill type — one helper means callers don't reimplement.
//   hitPos anchors the "RHYTHM LOST" popup at the target the off-beat shot landed on.
export const applyHitToCombo = (game: Game, isOnBeatHit: boolean, hitPos: Vec) => {
  if (isOnBeatHit && game.beatCombo >= 1) {
    const crossedSparkleThreshold = game.beatCombo === 11;
    game.beatCombo += 1;
    if (game.beatCombo > game.maxCombo) game.maxCombo = game.beatCombo;
    if (game.beatCombo > game.maxComboThisWave) game.maxComboThisWave = game.beatCombo;
    // grid just halved (quarters→eighths) at the 12x sparkle threshold; resync the evaluator
    // so the freshly-uncovered odd eighths don't all close in a burst on the next frame.
    if (crossedSparkleThreshold && !game.ship.rapidActive) rebaseBeatEval(game);
    syncComboHud(game);
    tryUnlockPilotLog1(game);
    tryUnlockPilotLog3(game);
    advanceFirstWaveHintOnCombo(game);
  } else if (!isOnBeatHit && game.beatCombo !== 0) {
    loseCombo(game, hitPos);
  }
};

// 4x rhythm reveals the score-payoff line; 6x marks the tutorial done forever.
const advanceFirstWaveHintOnCombo = (game: Game) => {
  if (game.beatCombo >= 6 && game.firstWaveHintStage !== 0) {
    setFirstWaveHintStage(game, 0);
    markFirstWaveTutorialComplete();
    return;
  }
  if (game.beatCombo >= 4 && (game.firstWaveHintStage === 1 || game.firstWaveHintStage === 2)) {
    setFirstWaveHintStage(game, 3);
  }
};

// multiplier + sparkle + popup are the on-beat reward — one helper guarantees consistency.
//   Returns the points actually added so the parade can flash the same "+N" per kill.
const awardScoreForKill = (game: Game, hitPos: Vec, baseScore: number, isOnBeatHit: boolean): number => {
  let scoreEarned = baseScore;
  if (isOnBeatHit) {
    const multiplier = game.beatCombo;
    scoreEarned = Math.round(scoreEarned * multiplier);
    game.sound.play("comboSparkle", 1, hitPos);
    game.sound.playComboChime(multiplier, hitPos);
    if (multiplier >= 2) game.popups.push(popupCombo(hitPos, multiplier));
  }
  game.score += scoreEarned;
  flashScoreGain(game, scoreEarned);
  return scoreEarned;
};

// only medium/small children carry drones (large bass has its own continuous low end).
const restartChildBassDrones = (game: Game, children: Asteroid[]) => {
  for (const c of children) {
    alignBassBeat(game, c);
    if (c.size === "medium" || c.size === "small") {
      game.sound.startBassteroidDrone(c, c.kind as "bassA" | "bassB" | "bassC" | "bassD", c.size, c.pos);
    }
  }
};

// audio-free core lets bullet vs ram paths stage their own kill-sound order independently.
//   scoreEarned is captured into the snapshot so the parade can flash "+N" beneath each sprite.
//   impactPos is the bullet position at the moment of the kill (or undefined for ram kills);
//   it lets split() classify center vs glancing hits for the asymmetric breakup patterns.
//   comboAtKill is the multiplier that drove the chime pitch; 0 for ram/off-beat kills.
const finishAsteroidKillCore = (
  game: Game,
  a: Asteroid,
  killerVel: Vec,
  isOnBeatHit: boolean,
  scoreEarned: number,
  comboAtKill: number,
  impactPos?: Vec,
): Asteroid[] => {
  emitExplosion(game.particles, game.shards, a, isOnBeatHit);
  if (a.isBass()) game.sound.stopBassteroidDrone(a);
  const asteroidHit = hitSoundFor(a);
  // parade replays the bassteroid's *beat* voice (kick/pluck/boom/snap) rather than the
  //   death-only bassEcho, so the trophy row plays "the sound this rock made", not how it died.
  const paradeSound = a.isBass()
    ? BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"]
    : asteroidHit;
  const snap = snapshotAsteroidKill(a, paradeSound, scoreEarned);
  if (snap) {
    // only medium/small bass have drones (large bass relies on its split children), so
    //   the parade only revives the drone bed for snapshots that had one in play.
    if (a.isBass() && (a.size === "medium" || a.size === "small")) {
      snap.bassDrone = { kind: a.kind as "bassA" | "bassB" | "bassC" | "bassD", size: a.size };
    }
    if (isOnBeatHit && comboAtKill >= 1) snap.rhythmHit = { combo: comboAtKill };
    game.killedSnapshots.push(snap);
  }
  bumpKill(game, asteroidBucket(a));
  if (a.kind === "goldCrystal") {
    // Eject the embedded crystal at the dead rock's position; the fragment
    // recipe (handled inside split() below) takes care of the rubble cloud
    // flying in other directions.
    game.goldCrystals.push(spawnGoldCrystalAt(a.pos, a.vel));
  }
  const children = a.split({
    impactDir: killerVel,
    impactPos,
    combo: game.beatCombo,
    onBeat: isOnBeatHit,
  });
  // sibling fragments share one beat-claim set so the two pieces target
  //   *different* beats — otherwise the player can only combo one of them
  //   before the second drifts past the engagement ring on the same tick.
  const claimed = newBeatClaimSet();
  for (const c of children) alignSplitChildToRhythm(game, c, claimed);
  if (a.isBass()) restartChildBassDrones(game, children);
  return children;
};

// bassEcho → asteroidHit order matches the original handleCollisions bullet branch.
export const onAsteroidKilledByBullet = (
  game: Game,
  a: Asteroid,
  b: Bullet,
  isOnBeatHit: boolean,
): Asteroid[] => {
  const scoreEarned = awardScoreForKill(game, b.pos, a.scoreValue(), isOnBeatHit);
  const comboAtKill = isOnBeatHit ? game.beatCombo : 0;
  if (a.isBass()) game.sound.play("bassEcho", 1, a.pos);
  // On-beat plain asteroid kills get the taiko boom in place of the noise
  // explosion — replacing rather than layering so the acoustic drum isn't
  // masked by the broadband crash.
  const useTaiko = isOnBeatHit && a.kind === "normal";
  game.sound.play(useTaiko ? "asteroidBoomBeat" : hitSoundFor(a), 1, a.pos);
  return finishAsteroidKillCore(game, a, b.vel, isOnBeatHit, scoreEarned, comboAtKill, b.pos);
};

// asteroidHit → bassEcho (reverse of bullet path) preserves the original ram-branch order.
// ram kills award no points — pass 0 so the parade flash reflects the actual payout.
export const onAsteroidKilledByRam = (game: Game, a: Asteroid, shipVel: Vec): Asteroid[] => {
  if (a.isBass()) game.sound.play("bassHit", 1, a.pos);
  game.sound.play(hitSoundFor(a), 1, a.pos);
  if (a.isBass()) game.sound.play("bassEcho", 1, a.pos);
  return finishAsteroidKillCore(game, a, shipVel, false, 0, 0);
};

// bassteroids take multiple hits to kill; chip points keep the player rewarded for
// every rhythm-good hit along the way, not just the kill shot.
const bassChipScore = (a: Asteroid): number => Math.max(1, Math.round(a.scoreValue() / 4));

// bullet crack — bassHit announces the chip; sparkle layers on if it was on-beat.
// Bassteroid chips also pay out (small) points + combo popup so multi-hit kills feel rewarding.
export const onAsteroidCrackedByBullet = (game: Game, a: Asteroid, b: Bullet, isOnBeatHit: boolean) => {
  if (a.isBass()) game.sound.play("bassHit", 1, a.pos);
  emitCrackParticles(game.particles, a, isOnBeatHit);
  if (isOnBeatHit) game.sound.play("comboSparkle", 1, b.pos);
  if (a.isBass()) awardScoreForKill(game, b.pos, bassChipScore(a), isOnBeatHit);
};

// ram crack uses asteroidHit (not bassHit) so the impact reads as a kick, not a chip.
export const onAsteroidCrackedByRam = (game: Game, a: Asteroid) => {
  game.sound.play(a.isBass() ? "bassHit" : hitSoundFor(a), 1, a.pos);
  emitCrackParticles(game.particles, a, false);
};

// no split path here — alien deaths fall into the "single body, fixed sound" pattern.
export const onAlienKilled = (game: Game, al: Alien, b: Bullet, isOnBeatHit: boolean) => {
  const scoreEarned = awardScoreForKill(game, b.pos, al.scoreValue, isOnBeatHit);
  const comboAtKill = isOnBeatHit ? game.beatCombo : 0;
  game.shake = Math.min(game.shake + 0.5, 1.4);
  game.sound.play("alienExplode", 1, al.pos);
  game.sound.stopAlienDrone(al);
  emitAlienExplosion(game.particles, al);
  const snap = snapshotAlienKill(al, "alienExplode", scoreEarned);
  if (snap) {
    if (isOnBeatHit && comboAtKill >= 1) snap.rhythmHit = { combo: comboAtKill };
    game.killedSnapshots.push(snap);
  }
  bumpKill(game, `alien_${al.size}`);
};

// shared cracked-alien feedback for medium/big saucers since the killing-hit path differs.
export const onAlienCracked = (game: Game, isOnBeatHit: boolean, pos: Vec) => {
  game.sound.play("alienHit", 1, pos);
  game.shake = Math.min(game.shake + 0.18, 1.2);
  if (isOnBeatHit) game.sound.play("comboSparkle", 1, pos);
};

// Off-rhythm kills pay a flat 500 — present but unsatisfying. An on-beat kill pays
// 1000 × beatCombo, so the comet rewards rhythm hard (a 6× halo lands 6000+).
// Off-rhythm hits also get a sadder explosion variant so the audio tells the
// player they wasted the celestial visitor.
export const onCometKilled = (game: Game, c: Comet, b: Bullet, isOnBeatHit: boolean) => {
  const scoreEarned = isOnBeatHit ? Math.round(1000 * game.beatCombo) : 500;
  game.score += scoreEarned;
  flashScoreGain(game, scoreEarned);
  game.popups.push(popupScore(b.pos, scoreEarned));
  if (isOnBeatHit) {
    game.sound.play("comboSparkle", 1, b.pos);
    if (game.beatCombo >= 2) game.popups.push(popupCombo(b.pos, game.beatCombo));
  }
  game.shake = Math.min(game.shake + 0.6, 1.6);
  const deathSound = isOnBeatHit ? "cometDestroyed" : "cometDestroyedSad";
  game.sound.play(deathSound, 1, c.pos);
  game.sound.stopCometShimmer(c);
  emitCometExplosion(game.particles, c);
  const snap = snapshotCometKill(c, deathSound, scoreEarned);
  if (snap) {
    if (isOnBeatHit && game.beatCombo >= 1) snap.rhythmHit = { combo: game.beatCombo };
    game.killedSnapshots.push(snap);
  }
  bumpKill(game, "comet");
  syncHud(game);
};
