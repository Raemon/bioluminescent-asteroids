import type { Ship } from "../Ship";
import { add, mul, fromAngle } from "../vec";
import { Bullet } from "../Bullet";
import { PowerupKind } from "../Canister";
import { BEAT_GRID } from "../game/rhythmConstants";

// each prong upgrade adds one more bullet, every prong 45° from its neighbour, wrapping
// into a full ring at 8 shots (8 × 45° = 360°) and continuing to overlap beyond that.
// Exported so metalChunk can lay two shards on the first-tier prong pair's rays
// (±half a step off the heading) — see Asteroid.split.
export const PRONG_ANGLE_STEP = Math.PI / 4;

// prongCount n yields n+1 shots fanned symmetrically about the heading (centred on the front).
// count 0 → [0]; 1 → ±22.5°; 2 → -45,0,+45; 3 → ±22.5,±67.5; 7 → full ring every 45°.
//
// INVARIANT: a weapon's fire loop and its reticule must iterate the SAME fan —
// every entry fires a shot AND draws an aim glyph. Don't compute a single aim
// point from ship.heading in a sight; expose a fan-shaped aim helper next to
// the fire code and have both consume it (see laserAimFan in laserShot.ts;
// the bullet path fans inside computeReticulePositions).
export const prongOffsets = (prongCount: number): number[] => {
  const shots = prongCount + 1;
  const start = -((shots - 1) / 2) * PRONG_ANGLE_STEP;
  return Array.from({ length: shots }, (_, i) => start + i * PRONG_ANGLE_STEP);
};

// pierce extends bullet lifetime so the punch-through shot also reaches farther,
// making the powerup feel like a true "penetrating" upgrade and not just multi-hit.
const PIERCE_RANGE_MULT = 2;
// longshot extends bullet range 1.5x so a shot reaches further than the 1-beat reticule.
const LONGSHOT_RANGE_MULT = 1.5;

// bullet inherits a fraction of ship velocity so muzzle output reads as physical, not portaled.
// Exported so metalChunk can reproduce the true (velocity-bent) prong ray when it
// lays shards on the prong pair — see Asteroid.split.
export const BULLET_VEL_INHERIT = 0.4;
const launchBullet = (ship: Ship, headingOffset: number, pierce: boolean, longshot: boolean): Bullet => {
  const dir = fromAngle(ship.heading + headingOffset, 1);
  const muzzle = add(ship.pos, mul(dir, ship.radius + 4));
  const vel = add(mul(dir, ship.bulletSpeed), mul(ship.vel, BULLET_VEL_INHERIT));
  let life = ship.bulletLife;
  if (pierce) life *= PIERCE_RANGE_MULT;
  if (longshot) life *= LONGSHOT_RANGE_MULT;
  const bullet = new Bullet(muzzle, vel, life);
  bullet.pierce = pierce;
  // farthest reticule sits at floor(life/BEAT_GRID) beats out; anything past that
  // can't land on a beat, so fade the bullet across the leftover tail to expiry.
  const slotCount = Math.max(1, Math.floor(life / BEAT_GRID));
  bullet.fadeStartLife = Math.max(0, life - slotCount * BEAT_GRID);
  return bullet;
};

// single fire event yields prongCount+1 bullets; prong must share its on-beat flag across all.
export const fireBullets = (ship: Ship, bullets: Bullet[]) => {
  for (const offset of prongOffsets(ship.prongCount)) {
    bullets.push(launchBullet(ship, offset, ship.pierceActive, ship.longshotActive));
  }
};

// powerup flags are simple bool latches; shield is one-shot, the rest persist for the run.
export const applyPowerup = (ship: Ship, kind: PowerupKind) => {
  if (kind === "prong") ship.prongCount += 1;
  else if (kind === "rapid") ship.rapidActive = true;
  else if (kind === "pierce") ship.pierceActive = true;
  else if (kind === "shield") ship.shieldActive = true;
  else if (kind === "radar") ship.radarActive = true;
  else if (kind === "longshot") ship.longshotActive = true;
  else if (kind === "sideEngines") ship.sideEnginesActive = true;
  else if (kind === "lasershot") ship.lasershotActive = true;
};
