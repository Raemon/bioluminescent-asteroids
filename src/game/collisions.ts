import type { Game } from "../Game";
import { Asteroid } from "../Asteroid";
import { Alien } from "../Alien";
import { Comet } from "../Comet";
import { Bullet } from "../Bullet";
import { AlienBullet } from "../AlienBullet";
import { Canister } from "../Canister";
import { isInBeatWindow, beatOffsetFor, logBeatEvent, spawnBeatDebugPopup } from "./rhythmGate";
import { SLOW_MO_DURATION } from "./slowMo";
import { syncHud } from "./hud";
import { emitShieldPop, emitCanisterPickup, emitCanisterPop } from "./particleBursts";
import { popupPickup } from "./popups";
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
import { BEAT_GRID, BEAT_WINDOW } from "./rhythmConstants";

// Why: every bullet-hit handler logs the same fire/impact shape; one helper keeps it uniform.
const logBulletHit = (game: Game, kind: string, b: Bullet) => {
  const fireOffsetMs = (beatOffsetFor(game, b.firedAtBeatTime) * 1000).toFixed(1);
  logBeatEvent(
    game,
    kind,
    game.beatTime,
    `firedAt=${b.firedAtBeatTime.toFixed(4)}s fireOffset=${fireOffsetMs}ms bulletOnBeat=${b.onBeat}`,
  );
  spawnBeatDebugPopup(game, b.pos, game.beatTime, "HIT");
};

// Why: strict on both ends — a bullet drifting out of the window between fire and hit doesn't count.
const isHitOnBeat = (game: Game, b: Bullet) => isInBeatWindow(game, game.beatTime) && b.onBeat;

// Why: single-hit targets (comets/canisters) share this shape; multi-hit targets bookkeep separately.
type CollidableTarget = { collidesWith: (pos: { x: number; y: number }, r: number) => boolean };
const findFirstHittingBullet = (bullets: Bullet[], target: CollidableTarget): Bullet | null => {
  for (const b of bullets) {
    if (b.life <= 0) continue;
    if (target.collidesWith(b.pos, b.hitRadius())) return b;
  }
  return null;
};

// Why: pierce keeps the bullet alive so a single shot can punch through a row of targets.
const consumeBullet = (b: Bullet) => { if (!b.pierce) b.life = 0; };

// Why: walk every rock so multi-hit HP and on-kill splits both resolve in one collision pass.
const handleBulletAsteroidHits = (game: Game) => {
  const surviving: Asteroid[] = [];
  for (const a of game.asteroids) {
    const survivors = hitAsteroidWithBullets(game, a);
    if (survivors === null) surviving.push(a);
    else for (const c of survivors) surviving.push(c);
  }
  game.asteroids = surviving;
};

// Why: null|children lets the outer loop stay branchless about the survival/kill distinction.
const hitAsteroidWithBullets = (game: Game, a: Asteroid): Asteroid[] | null => {
  for (const b of game.bullets) {
    if (b.life <= 0) continue;
    if (!a.collidesWith(b.pos, b.hitRadius())) continue;
    consumeBullet(b);
    const onBeat = isHitOnBeat(game, b);
    logBulletHit(game, "HIT asteroid", b);
    const dmg = b.damage();
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

// Why: ramming kill skips score/combo (not a rhythm hit) but still loses shield/life unless invuln.
const handleShipAsteroidCollisions = (game: Game) => {
  if (!game.ship.alive || game.ship.invuln > 0) return;
  for (let i = 0; i < game.asteroids.length; i++) {
    const a = game.asteroids[i];
    if (!shipAsteroidHit(game, a)) continue;
    handleSingleShipAsteroidImpact(game, a, i);
    break;
  }
};

// Why: polygon-accurate test against the visible halo means the outline IS the hitbox.
export const shipAsteroidHit = (game: Game, a: Asteroid): boolean => {
  const dx = a.pos.x - game.ship.pos.x;
  const dy = a.pos.y - game.ship.pos.y;
  const distance = Math.hypot(dx, dy);
  if (distance > a.radius * 1.3 + game.ship.hitRadius) return false;
  const shipReach = game.ship.hitDistanceToward(Math.atan2(dy, dx));
  return a.collidesWith(game.ship.pos, shipReach);
};

// Why: encapsulates the in-place splice when a ram kills, so the outer loop stays a simple sweep.
const handleSingleShipAsteroidImpact = (game: Game, a: Asteroid, asteroidIdx: number) => {
  const ramDamage = 4;
  const { killed } = a.applyDamage(ramDamage);
  if (killed) {
    const children = onAsteroidKilledByRam(game, a, game.ship.vel);
    for (const c of children) game.asteroids.push(c);
    game.asteroids.splice(asteroidIdx, 1);
  } else {
    // Why: ram knockback uses the ship's own speed as the energy budget so a
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

// Why: aliens use the bassteroid multi-hit pattern — chips before the kill shot.
export const handleAlienHits = (game: Game) => {
  const surviving: Alien[] = [];
  for (const a of game.aliens) {
    if (!tryKillAlienWithBullets(game, a)) surviving.push(a);
  }
  game.aliens = surviving;
};

// Why: returns "should we drop this alien?" so the outer loop stays declarative.
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

// Why: only one bullet "lands" per frame; the rest stay alive so they can hit on later frames.
export const handleAlienBulletHits = (game: Game) => {
  if (!game.ship.alive || game.ship.invuln > 0) return;
  const remaining: AlienBullet[] = [];
  let hit = false;
  for (const ab of game.alienBullets) {
    if (!hit && alienBulletHitsShip(game, ab)) {
      hit = true;
      onShipHitByAlienBullet(game);
      continue;
    }
    remaining.push(ab);
  }
  game.alienBullets = remaining;
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

// Why: comets are 1-HP — single-hit kill pattern shared with canisters.
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

// Why: pickup-popup labels what was grabbed so the player can read it after the burst clears.
export const handleCanisterPickups = (game: Game) => {
  if (!game.ship.alive) return;
  const remaining: Canister[] = [];
  for (const c of game.canisters) {
    if (c.collidesWith(game.ship.pos, game.ship.radius * 0.9)) collectCanister(game, c);
    else remaining.push(c);
  }
  game.canisters = remaining;
};

// Why: white burst differs from the hue-tinted pickup burst so "wasted pod" reads visibly.
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

// Why: rapid flips grid 4→8ths; rebase nextBeatToEvaluate so closures keep marching forward.
const rebaseBeatEvalForRapid = (game: Game) => {
  const eighth = BEAT_GRID / 2;
  game.nextBeatToEvaluate = Math.max(0, Math.floor((game.beatTime - BEAT_WINDOW) / eighth) + 1);
};

// Why: one site handles every pickup so HUD label / timer / powerup-apply stay in lockstep.
const collectCanister = (game: Game, c: Canister) => {
  game.sound.play("powerup");
  game.popups.push(popupPickup(c.pos, c.kind));
  if (c.kind === "slow") {
    game.slowMoTimer = SLOW_MO_DURATION;
  } else {
    if (c.kind === "rapid" && !game.ship.rapidActive) rebaseBeatEvalForRapid(game);
    game.ship.applyPowerup(c.kind);
  }
  emitCanisterPickup(game.particles, c);
};

// Why: shooting wastes the powerup — neutral sound + white burst contrasts the pickup flavour.
const explodeCanister = (game: Game, c: Canister) => {
  game.sound.play("explosionSmall", 1, c.pos);
  game.sound.play("canisterDestroyed", 1, c.pos);
  game.shake = Math.min(game.shake + 0.25, 1.2);
  emitCanisterPop(game.particles, c);
};

// Why: deflection burst differs from kill bursts so the player feels the shield saved them.
export const popShield = (game: Game) => {
  game.sound.play("shieldPop");
  game.shake = Math.min(game.shake + 0.2, 1.2);
  emitShieldPop(game.particles, game.ship.pos);
};

// Why: rolls bullet-vs-rocks + ship-vs-rocks into one entry; update() reads as one step.
export const handleCollisions = (game: Game) => {
  handleBulletAsteroidHits(game);
  handleShipAsteroidCollisions(game);
  syncHud(game);
};
