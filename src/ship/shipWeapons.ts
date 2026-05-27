import type { Ship } from "../Ship";
import { add, mul, fromAngle } from "../vec";
import { Bullet } from "../Bullet";
import { PowerupKind } from "../Canister";

// Why: trident sprays three bullets per shot at a fixed spread; centred single shot otherwise.
const TRIDENT_SPREAD = 0.21;

// Why: pierce extends bullet lifetime so the punch-through shot also reaches farther,
// making the powerup feel like a true "penetrating" upgrade and not just multi-hit.
const PIERCE_RANGE_MULT = 3;

// Why: bullet inherits a fraction of ship velocity so muzzle output reads as physical, not portaled.
const launchBullet = (ship: Ship, headingOffset: number, pierce: boolean): Bullet => {
  const dir = fromAngle(ship.heading + headingOffset, 1);
  const muzzle = add(ship.pos, mul(dir, ship.radius + 4));
  const vel = add(mul(dir, ship.bulletSpeed), mul(ship.vel, 0.4));
  const life = pierce ? ship.bulletLife * PIERCE_RANGE_MULT : ship.bulletLife;
  const bullet = new Bullet(muzzle, vel, life);
  bullet.pierce = pierce;
  return bullet;
};

// Why: single fire event yields 1 or 3 bullets; trident must share its on-beat flag across all three.
export const fireBullets = (ship: Ship, bullets: Bullet[]) => {
  const offsets = ship.tridentActive ? [-TRIDENT_SPREAD, 0, TRIDENT_SPREAD] : [0];
  for (const offset of offsets) bullets.push(launchBullet(ship, offset, ship.pierceActive));
};

// Why: powerup flags are simple bool latches; shield is one-shot, the rest persist for the run.
export const applyPowerup = (ship: Ship, kind: PowerupKind) => {
  if (kind === "trident") ship.tridentActive = true;
  else if (kind === "rapid") ship.rapidActive = true;
  else if (kind === "pierce") ship.pierceActive = true;
  else if (kind === "shield") ship.shieldActive = true;
};
