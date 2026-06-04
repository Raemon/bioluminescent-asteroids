import type { Game } from "../Game";
import { rng } from "./rng";
import { Asteroid } from "../Asteroid";
import { Alien } from "../Alien";
import { Comet } from "../Comet";
import { Bullet } from "../Bullet";
import { AlienBullet } from "../AlienBullet";
import { Canister } from "../Canister";
import {
  GoldCrystal,
  GOLD_CRYSTAL_UPGRADE_CHANCE,
  GOLD_CRYSTAL_REVEAL_SCORE,
  spawnCanisterFromGoldCrystal,
} from "../GoldCrystal";
import { isInBeatWindow, beatOffsetFor, logBeatEvent, spawnBeatDebugPopup, rebaseBeatEval } from "./rhythmGate";
import { SLOW_MO_DURATION } from "./slowMo";
import { syncHud } from "./hud";
import { emitShieldPop, emitCanisterPickup, emitCanisterPop, emitGoldCrystalPickup } from "./particleBursts";
import { popupPickup, popupScore, popupSideEnginesPickup } from "./popups";
import { checkBonusLife } from "./bonusLife";
import {
  applyHitToCombo,
  onAsteroidKilledByBullet,
  onAsteroidKilledByRam,
  onAsteroidCrackedByBullet,
  onAsteroidCrackedByRam,
  onAlienKilled,
  onAlienCracked,
  onCometKilled,
} from "./killEffects";
import { killShip } from "./lifecycle";

// every bullet-hit handler logs the same fire/impact shape; one helper keeps it uniform.
const logBulletHit = (game: Game, kind: string, b: Bullet) => {
  const fireOffsetMs = (beatOffsetFor(game, b.firedAtBeatTime) * 1000).toFixed(1);
  logBeatEvent(
    game,
    kind,
    game.perceivedBeatTime,
    `firedAt=${b.firedAtBeatTime.toFixed(4)}s fireOffset=${fireOffsetMs}ms bulletOnBeat=${b.onBeat}`,
  );
  spawnBeatDebugPopup(game, b.pos, game.perceivedBeatTime, "HIT");
};

// strict on both ends — a bullet drifting out of the window between fire and hit doesn't count.
//   Judged on perceivedBeatTime (latency-shifted) to match the fire-time classification.
const isHitOnBeat = (game: Game, b: Bullet) => isInBeatWindow(game, game.perceivedBeatTime) && b.onBeat;

// single-hit targets (comets/canisters) share this shape; multi-hit targets bookkeep separately.
type CollidableTarget = { collidesWith: (pos: { x: number; y: number }, r: number) => boolean };
const findFirstHittingBullet = (bullets: Bullet[], target: CollidableTarget): Bullet | null => {
  for (const b of bullets) {
    if (b.life <= 0) continue;
    if (target.collidesWith(b.pos, b.hitRadius())) return b;
  }
  return null;
};

// pierce keeps the bullet alive so a single shot can punch through a row of targets.
const consumeBullet = (b: Bullet) => { if (!b.pierce) b.life = 0; };

// walk every rock so multi-hit HP and on-kill splits both resolve in one collision pass.
const handleBulletAsteroidHits = (game: Game) => {
  const surviving: Asteroid[] = [];
  for (const a of game.asteroids) {
    const survivors = hitAsteroidWithBullets(game, a);
    if (survivors === null) surviving.push(a);
    else for (const c of survivors) surviving.push(c);
  }
  game.asteroids = surviving;
};

// null|children lets the outer loop stay branchless about the survival/kill distinction.
const hitAsteroidWithBullets = (game: Game, a: Asteroid): Asteroid[] | null => {
  for (const b of game.bullets) {
    if (b.life <= 0) continue;
    if (!a.collidesWith(b.pos, b.hitRadius())) continue;
    consumeBullet(b);
    const onBeat = isHitOnBeat(game, b);
    logBulletHit(game, "HIT asteroid", b);
    const isDriftShot = onBeat && b.driftEligibleAtHit();
    const dmg = b.damage() * (isDriftShot ? 4 : 1);
    const { killed } = a.applyDamage(dmg);
    game.shake = Math.min(game.shake + (killed ? 0.4 : 0.2), 1.2);
    applyHitToCombo(game, onBeat, b.pos);
    if (!killed) {
      a.applyKnockback(b.vel.x, b.vel.y, dmg);
      onAsteroidCrackedByBullet(game, a, b, onBeat);
      return null;
    }
    return onAsteroidKilledByBullet(game, a, b, onBeat);
  }
  return null;
};

// ramming kill skips score/combo (not a rhythm hit) but still loses shield/life unless invuln.
const handleShipAsteroidCollisions = (game: Game) => {
  if (!game.ship.alive || game.ship.invuln > 0) return;
  for (let i = 0; i < game.asteroids.length; i++) {
    const a = game.asteroids[i];
    if (!shipAsteroidHit(game, a)) continue;
    handleSingleShipAsteroidImpact(game, a, i);
    break;
  }
};

// polygon-accurate test against the visible halo means the outline IS the hitbox.
export const shipAsteroidHit = (game: Game, a: Asteroid): boolean => {
  const dx = a.pos.x - game.ship.pos.x;
  const dy = a.pos.y - game.ship.pos.y;
  const distance = Math.hypot(dx, dy);
  if (distance > a.radius * 1.3 + game.ship.hitRadius) return false;
  const shipReach = game.ship.hitDistanceToward(Math.atan2(dy, dx));
  return a.collidesWith(game.ship.pos, shipReach);
};

// encapsulates the in-place splice when a ram kills, so the outer loop stays a simple sweep.
const handleSingleShipAsteroidImpact = (game: Game, a: Asteroid, asteroidIdx: number) => {
  const ramDamage = 4;
  const { killed } = a.applyDamage(ramDamage);
  if (killed) {
    const children = onAsteroidKilledByRam(game, a, game.ship.vel);
    for (const c of children) game.asteroids.push(c);
    game.asteroids.splice(asteroidIdx, 1);
  } else {
    // ram knockback uses the ship's own speed as the energy budget so a
    // gentle bump barely nudges a rock and a full-speed slam shoves it hard.
    const shipSpeed = Math.hypot(game.ship.vel.x, game.ship.vel.y);
    a.applyKnockback(game.ship.vel.x, game.ship.vel.y, ramDamage, shipSpeed);
    onAsteroidCrackedByRam(game, a);
  }
  if (game.ship.shieldActive) {
    game.ship.shieldActive = false;
    game.ship.invuln = 0.8;
    popShield(game);
  } else {
    killShip(game);
  }
};

// aliens use the bassteroid multi-hit pattern — chips before the kill shot.
export const handleAlienHits = (game: Game) => {
  const surviving: Alien[] = [];
  for (const a of game.aliens) {
    if (!tryKillAlienWithBullets(game, a)) surviving.push(a);
  }
  game.aliens = surviving;
};

// returns "should we drop this alien?" so the outer loop stays declarative.
const tryKillAlienWithBullets = (game: Game, a: Alien): boolean => {
  for (const b of game.bullets) {
    if (b.life <= 0) continue;
    if (!a.collidesWith(b.pos, b.hitRadius())) continue;
    consumeBullet(b);
    const onBeat = isHitOnBeat(game, b);
    logBulletHit(game, "HIT alien", b);
    const { killed } = a.applyDamage();
    applyHitToCombo(game, onBeat, b.pos);
    if (!killed) {
      a.applyKnockback(b.vel.x, b.vel.y, 1);
      onAlienCracked(game, onBeat, a.pos);
      return false;
    }
    onAlienKilled(game, a, b, onBeat);
    return true;
  }
  return false;
};

// only one bullet "lands" per frame; the rest stay alive so they can hit on later frames.
// Alien bullets also chip asteroids they fly into (1 damage), consumed on impact.
export const handleAlienBulletHits = (game: Game) => {
  const remaining: AlienBullet[] = [];
  let shipHit = false;
  const shipVulnerable = game.ship.alive && game.ship.invuln <= 0;
  for (const ab of game.alienBullets) {
    if (alienBulletDamagesAsteroid(game, ab)) continue;
    if (shipVulnerable && !shipHit && alienBulletHitsShip(game, ab)) {
      shipHit = true;
      onShipHitByAlienBullet(game);
      continue;
    }
    remaining.push(ab);
  }
  game.alienBullets = remaining;
};

// returns true if the bullet hit (and was consumed by) an asteroid this frame.
const alienBulletDamagesAsteroid = (game: Game, ab: AlienBullet): boolean => {
  for (let i = 0; i < game.asteroids.length; i++) {
    const a = game.asteroids[i];
    if (!a.collidesWith(ab.pos, ab.radius)) continue;
    const { killed } = a.applyDamage(1);
    game.shake = Math.min(game.shake + (killed ? 0.3 : 0.15), 1.2);
    if (killed) {
      const children = onAsteroidKilledByRam(game, a, ab.vel);
      game.asteroids.splice(i, 1, ...children);
    } else {
      a.applyKnockback(ab.vel.x, ab.vel.y, 1);
      onAsteroidCrackedByRam(game, a);
    }
    return true;
  }
  return false;
};

const alienBulletHitsShip = (game: Game, ab: AlienBullet): boolean => {
  const dx = ab.pos.x - game.ship.pos.x;
  const dy = ab.pos.y - game.ship.pos.y;
  const distance = Math.hypot(dx, dy);
  const shipReach = game.ship.hitDistanceToward(Math.atan2(dy, dx));
  return distance < shipReach + ab.radius;
};

const onShipHitByAlienBullet = (game: Game) => {
  if (game.ship.shieldActive) {
    game.ship.shieldActive = false;
    game.ship.invuln = 0.8;
    popShield(game);
  } else {
    killShip(game);
  }
};

// comets are 1-HP — single-hit kill pattern shared with canisters.
export const handleCometHits = (game: Game) => {
  const surviving: Comet[] = [];
  for (const c of game.comets) {
    if (!tryKillCometWithBullets(game, c)) surviving.push(c);
  }
  game.comets = surviving;
};

const tryKillCometWithBullets = (game: Game, c: Comet): boolean => {
  const b = findFirstHittingBullet(game.bullets, c);
  if (!b) return false;
  consumeBullet(b);
  const onBeat = isHitOnBeat(game, b);
  logBulletHit(game, "HIT comet", b);
  applyHitToCombo(game, onBeat, b.pos);
  onCometKilled(game, c, b, onBeat);
  return true;
};

// pickup-popup labels what was grabbed so the player can read it after the burst clears.
export const handleCanisterPickups = (game: Game) => {
  if (!game.ship.alive) return;
  const remaining: Canister[] = [];
  for (const c of game.canisters) {
    if (c.collidesWith(game.ship.pos, game.ship.radius * 0.9)) collectCanister(game, c);
    else remaining.push(c);
  }
  game.canisters = remaining;
};

// white burst differs from the hue-tinted pickup burst so "wasted pod" reads visibly.
export const handleCanisterShots = (game: Game) => {
  const remaining: Canister[] = [];
  for (const c of game.canisters) {
    const b = findFirstHittingBullet(game.bullets, c);
    if (b) {
      consumeBullet(b);
      explodeCanister(game, c);
    } else remaining.push(c);
  }
  game.canisters = remaining;
};

// one site handles every pickup so HUD label / timer / powerup-apply stay in lockstep.
const collectCanister = (game: Game, c: Canister) => {
  game.sound.play("powerup");
  game.popups.push(c.kind === "sideEngines" ? popupSideEnginesPickup(c.pos) : popupPickup(c.pos, c.kind));
  if (c.kind === "slow") {
    game.slowMoTimer = SLOW_MO_DURATION;
  } else {
    // rapid flips grid quarters→eighths; rebase against the new grid so closures keep
    // marching forward. (skip if combo is already ≥ 16 — grid was already on eighths.)
    const willChangeGrid = c.kind === "rapid" && !game.ship.rapidActive && game.beatCombo < 16;
    game.ship.applyPowerup(c.kind);
    if (willChangeGrid) rebaseBeatEval(game);
  }
  emitCanisterPickup(game.particles, c);
};

// shooting wastes the powerup — neutral sound + white burst contrasts the pickup flavour.
const explodeCanister = (game: Game, c: Canister) => {
  game.sound.play("explosionSmall", 1, c.pos);
  game.sound.play("canisterDestroyed", 1, c.pos);
  game.shake = Math.min(game.shake + 0.25, 1.2);
  emitCanisterPop(game.particles, c);
};

// Two ways to resolve a gold gem on the field:
//   1) Shoot it. Strictly rhythm-gated: only an on-beat shot dealing ≥ 4
//      damage cracks it — that path may reveal an upgrade or pay out reveal
//      score (see crackGoldCrystalForCanister). Any weaker / off-beat shot
//      wastes it: no score, no popup, same sad sound + white burst a wasted
//      canister gets, so the player reads "wrong tool" the same way.
//   2) Fly through it. The gem shatters on contact and the ship takes the
//      hit — shield pops if up, otherwise killShip. No score: the gem is a
//      rhythm target, never a freebie pickup.
// Shoot pass runs first so a bullet at the gem this frame can't be
// pre-empted by a same-frame ship overlap.
export const handleGoldCrystalPickups = (game: Game) => {
  const remaining: GoldCrystal[] = [];
  for (const g of game.goldCrystals) {
    const b = findFirstHittingBullet(game.bullets, g);
    if (b) {
      consumeBullet(b);
      const onBeat = isHitOnBeat(game, b);
      const dmg = b.damage();
      applyHitToCombo(game, onBeat, b.pos);
      if (onBeat && dmg >= 4) crackGoldCrystalForCanister(game, g);
      else wasteGoldCrystal(game, g);
      continue;
    }
    if (game.ship.alive && game.ship.invuln <= 0 && g.collidesWith(game.ship.pos, game.ship.radius * 0.9)) {
      shatterGoldCrystalOnShip(game, g);
      continue;
    }
    remaining.push(g);
  }
  game.goldCrystals = remaining;
};

// Ship touched the gem: same sad crystal-break flavour as a solid-crystal
// asteroid shatter, and the ship eats the impact (shield first, then kill).
const shatterGoldCrystalOnShip = (game: Game, g: GoldCrystal) => {
  game.sound.play("crystalShatterSmall", 1, g.pos);
  game.shake = Math.min(game.shake + 0.3, 1.2);
  emitGoldCrystalPickup(game.particles, g);
  if (game.ship.shieldActive) {
    game.ship.shieldActive = false;
    game.ship.invuln = 0.8;
    popShield(game);
  } else {
    killShip(game);
  }
};

// Rhythm-cracked: 40% of the time the gem yields its embedded canister, the
// rest of the time it pays out GOLD_CRYSTAL_REVEAL_SCORE with a comet-style
// score popup so the reveal still feels like a payoff.
const crackGoldCrystalForCanister = (game: Game, g: GoldCrystal) => {
  game.sound.play("tink", 1, g.pos);
  game.shake = Math.min(game.shake + 0.25, 1.2);
  emitGoldCrystalPickup(game.particles, g);
  if (rng() < GOLD_CRYSTAL_UPGRADE_CHANCE) {
    const canister = spawnCanisterFromGoldCrystal(g, game.w, game.h);
    game.canisters.push(canister);
    game.sound.play("canisterAppear", 1, g.pos);
  } else {
    game.score += GOLD_CRYSTAL_REVEAL_SCORE;
    game.popups.push(popupScore(g.pos, GOLD_CRYSTAL_REVEAL_SCORE));
  }
  syncHud(game);
  checkBonusLife(game);
};

// Off-beat / weak shot: same "wasted upgrade" feedback as shooting a canister
// — no score, no popup, just the sad destroyed sound + white burst. Teaches
// the player the gem is strictly a rhythm target.
const wasteGoldCrystal = (game: Game, g: GoldCrystal) => {
  game.sound.play("explosionSmall", 1, g.pos);
  game.sound.play("canisterDestroyed", 1, g.pos);
  game.shake = Math.min(game.shake + 0.25, 1.2);
  emitCanisterPop(game.particles, g);
};

// Lifetime ran out before the player grabbed or shot the gem. Same
// "lost upgrade" feedback as a wasted shot so an unattended gem doesn't
// just silently vanish — the bang nudges the player to notice next time.
export const expireGoldCrystal = (game: Game, g: GoldCrystal) => {
  game.sound.play("explosionSmall", 1, g.pos);
  game.sound.play("canisterDestroyed", 1, g.pos);
  game.shake = Math.min(game.shake + 0.25, 1.2);
  emitCanisterPop(game.particles, g);
};

// deflection burst differs from kill bursts so the player feels the shield saved them.
export const popShield = (game: Game) => {
  game.sound.play("shieldPop");
  game.shake = Math.min(game.shake + 0.2, 1.2);
  emitShieldPop(game.particles, game.ship.pos);
};

// rolls bullet-vs-rocks + ship-vs-rocks into one entry; update() reads as one step.
export const handleCollisions = (game: Game) => {
  handleBulletAsteroidHits(game);
  handleShipAsteroidCollisions(game);
  syncHud(game);
};
