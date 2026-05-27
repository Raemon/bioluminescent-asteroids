import type { Game } from "../Game";
import { Asteroid } from "../Asteroid";
import { Alien } from "../Alien";
import { Comet } from "../Comet";
import { Bullet } from "../Bullet";
import { Vec } from "../vec";
import { COMBO_MULTIPLIER_MAX } from "./rhythmConstants";
import { loseCombo } from "./rhythmGate";
import { syncComboHud, syncHud } from "./hud";
import { popupCombo, popupScore } from "./popups";
import {
  emitExplosion,
  emitCrackParticles,
  emitAlienExplosion,
  emitCometExplosion,
} from "./particleBursts";
import { snapshotAsteroidKill, snapshotAlienKill, snapshotCometKill } from "./killSnapshot";
import { alignBassBeat } from "./waveDirector";

// Why: bassteroids run their own bassHit/bassEcho path; this maps the non-bass kinds to sounds.
export const hitSoundFor = (
  a: Asteroid,
): "explosionLarge" | "explosionMedium" | "explosionSmall" | "chime" | "bell" | "warble" | "tink" => {
  if (a.kind === "chime") return "chime";
  if (a.kind === "bell") return "bell";
  if (a.kind === "warble") return "warble";
  if (a.kind === "tink") return "tink";
  return a.size === "large" ? "explosionLarge" : a.size === "medium" ? "explosionMedium" : "explosionSmall";
};

// Why: same combo-update rule for every kill type — one helper means callers don't reimplement.
//   hitPos anchors the "COMBO LOST" popup at the target the off-beat shot landed on.
export const applyHitToCombo = (game: Game, isOnBeatHit: boolean, hitPos: Vec) => {
  if (isOnBeatHit && game.beatCombo >= 1) {
    game.beatCombo = Math.min(game.beatCombo + 1, COMBO_MULTIPLIER_MAX);
    syncComboHud(game);
  } else if (!isOnBeatHit && game.beatCombo !== 0) {
    loseCombo(game, hitPos);
  }
};

// Why: multiplier + sparkle + popup are the on-beat reward — one helper guarantees consistency.
//   Returns the points actually added so the parade can flash the same "+N" per kill.
const awardScoreForKill = (game: Game, hitPos: Vec, baseScore: number, isOnBeatHit: boolean): number => {
  let scoreEarned = baseScore;
  if (isOnBeatHit) {
    const multiplier = game.beatCombo;
    scoreEarned = Math.round(scoreEarned * multiplier);
    game.sound.play("comboSparkle");
    if (multiplier >= 2) game.popups.push(popupCombo(hitPos, multiplier));
  }
  game.score += scoreEarned;
  return scoreEarned;
};

// Why: only medium/small children carry drones (large bass has its own continuous low end).
const restartChildBassDrones = (game: Game, children: Asteroid[]) => {
  for (const c of children) {
    alignBassBeat(game, c);
    if (c.size === "medium" || c.size === "small") {
      game.sound.startBassteroidDrone(c, c.kind as "bassA" | "bassB" | "bassC" | "bassD", c.size);
    }
  }
};

// Why: audio-free core lets bullet vs ram paths stage their own kill-sound order independently.
//   scoreEarned is captured into the snapshot so the parade can flash "+N" beneath each sprite.
const finishAsteroidKillCore = (
  game: Game,
  a: Asteroid,
  killerVel: Vec,
  isOnBeatHit: boolean,
  scoreEarned: number,
): Asteroid[] => {
  emitExplosion(game.particles, game.shards, a, isOnBeatHit);
  if (a.isBass()) game.sound.stopBassteroidDrone(a);
  const asteroidHit = hitSoundFor(a);
  const snap = snapshotAsteroidKill(a, a.isBass() ? "bassEcho" : asteroidHit, scoreEarned);
  if (snap) game.killedSnapshots.push(snap);
  const children = a.split(killerVel);
  if (a.isBass()) restartChildBassDrones(game, children);
  return children;
};

// Why: bassEcho → asteroidHit order matches the original handleCollisions bullet branch.
export const onAsteroidKilledByBullet = (
  game: Game,
  a: Asteroid,
  b: Bullet,
  isOnBeatHit: boolean,
): Asteroid[] => {
  const scoreEarned = awardScoreForKill(game, b.pos, a.scoreValue(), isOnBeatHit);
  if (a.isBass()) game.sound.play("bassEcho");
  game.sound.play(hitSoundFor(a));
  return finishAsteroidKillCore(game, a, b.vel, isOnBeatHit, scoreEarned);
};

// Why: asteroidHit → bassEcho (reverse of bullet path) preserves the original ram-branch order.
// Why: ram kills award no points — pass 0 so the parade flash reflects the actual payout.
export const onAsteroidKilledByRam = (game: Game, a: Asteroid, shipVel: Vec): Asteroid[] => {
  if (a.isBass()) game.sound.play("bassHit");
  game.sound.play(hitSoundFor(a));
  if (a.isBass()) game.sound.play("bassEcho");
  return finishAsteroidKillCore(game, a, shipVel, false, 0);
};

// Why: bassteroids take multiple hits to kill; chip points keep the player rewarded for
// every rhythm-good hit along the way, not just the kill shot.
const bassChipScore = (a: Asteroid): number => Math.max(1, Math.round(a.scoreValue() / 4));

// Why: bullet crack — bassHit announces the chip; sparkle layers on if it was on-beat.
// Bassteroid chips also pay out (small) points + combo popup so multi-hit kills feel rewarding.
export const onAsteroidCrackedByBullet = (game: Game, a: Asteroid, b: Bullet, isOnBeatHit: boolean) => {
  if (a.isBass()) game.sound.play("bassHit");
  emitCrackParticles(game.particles, a, isOnBeatHit);
  if (isOnBeatHit) game.sound.play("comboSparkle");
  if (a.isBass()) awardScoreForKill(game, b.pos, bassChipScore(a), isOnBeatHit);
};

// Why: ram crack uses asteroidHit (not bassHit) so the impact reads as a kick, not a chip.
export const onAsteroidCrackedByRam = (game: Game, a: Asteroid) => {
  game.sound.play(a.isBass() ? "bassHit" : hitSoundFor(a));
  emitCrackParticles(game.particles, a, false);
};

// Why: no split path here — alien deaths fall into the "single body, fixed sound" pattern.
export const onAlienKilled = (game: Game, al: Alien, b: Bullet, isOnBeatHit: boolean) => {
  const scoreEarned = awardScoreForKill(game, b.pos, al.scoreValue, isOnBeatHit);
  game.shake = Math.min(game.shake + 0.5, 1.4);
  game.sound.play("alienExplode");
  game.sound.stopAlienDrone(al);
  emitAlienExplosion(game.particles, al);
  const snap = snapshotAlienKill(al, "alienExplode", scoreEarned);
  if (snap) game.killedSnapshots.push(snap);
};

// Why: shared cracked-alien feedback for medium/big saucers since the killing-hit path differs.
export const onAlienCracked = (game: Game, isOnBeatHit: boolean) => {
  game.sound.play("alienHit");
  game.shake = Math.min(game.shake + 0.18, 1.2);
  if (isOnBeatHit) game.sound.play("comboSparkle");
};

// Why: comets pay a flat 5000 base; combo multiplier and a "+N" readout match the rest of the
// scoring system so the player sees the payout and any rhythm bonus at the kill site.
export const onCometKilled = (game: Game, c: Comet, b: Bullet, isOnBeatHit: boolean) => {
  const baseScore = 5000;
  const scoreEarned = isOnBeatHit ? Math.round(baseScore * game.beatCombo) : baseScore;
  game.score += scoreEarned;
  game.popups.push(popupScore(b.pos, scoreEarned));
  if (isOnBeatHit) {
    game.sound.play("comboSparkle");
    if (game.beatCombo >= 2) game.popups.push(popupCombo(b.pos, game.beatCombo));
  }
  game.shake = Math.min(game.shake + 0.6, 1.6);
  game.sound.play("cometDestroyed");
  game.sound.stopCometShimmer(c);
  emitCometExplosion(game.particles, c);
  const snap = snapshotCometKill(c, "cometDestroyed", scoreEarned);
  if (snap) game.killedSnapshots.push(snap);
  syncHud(game);
};
