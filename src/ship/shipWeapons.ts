import type { Ship } from "../Ship";
import { add, mul, fromAngle } from "../vec";
import { Bullet } from "../Bullet";
import { PowerupKind } from "../Canister";

// trident sprays a symmetric pair per shot at a fixed spread; centred single shot otherwise.
const TRIDENT_SPREAD = 0.21;

// pierce extends bullet lifetime so the punch-through shot also reaches farther,
// making the powerup feel like a true "penetrating" upgrade and not just multi-hit.
const PIERCE_RANGE_MULT = 2;
// longshot doubles bullet range so a shot reaches the 2-beat reticule instead of the 1-beat one.
const LONGSHOT_RANGE_MULT = 2;

// bullet inherits a fraction of ship velocity so muzzle output reads as physical, not portaled.
const launchBullet = (ship: Ship, headingOffset: number, pierce: boolean, longshot: boolean): Bullet => {
  const dir = fromAngle(ship.heading + headingOffset, 1);
  const muzzle = add(ship.pos, mul(dir, ship.radius + 4));
  const vel = add(mul(dir, ship.bulletSpeed), mul(ship.vel, 0.4));
  let life = ship.bulletLife;
  if (pierce) life *= PIERCE_RANGE_MULT;
  if (longshot) life *= LONGSHOT_RANGE_MULT;
  const bullet = new Bullet(muzzle, vel, life);
  bullet.pierce = pierce;
  return bullet;
};

// single fire event yields 1 or 2 bullets; trident must share its on-beat flag across both.
export const fireBullets = (ship: Ship, bullets: Bullet[]) => {
  const offsets = ship.tridentActive ? [-TRIDENT_SPREAD, TRIDENT_SPREAD] : [0];
  for (const offset of offsets) bullets.push(launchBullet(ship, offset, ship.pierceActive, ship.longshotActive));
};

// powerup flags are simple bool latches; shield is one-shot, the rest persist for the run.
export const applyPowerup = (ship: Ship, kind: PowerupKind) => {
  if (kind === "trident") ship.tridentActive = true;
  else if (kind === "rapid") ship.rapidActive = true;
  else if (kind === "pierce") ship.pierceActive = true;
  else if (kind === "shield") ship.shieldActive = true;
  else if (kind === "radar") ship.radarActive = true;
  else if (kind === "longshot") ship.longshotActive = true;
  else if (kind === "sideEngines") ship.sideEnginesActive = true;
};
