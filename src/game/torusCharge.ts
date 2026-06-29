import type { Game } from "../Game";
import { shipTouchingTorusThread } from "../Asteroid";
import { emitBurst } from "./particleBursts";
import { ENTITY_CONFIG } from "./entityConfig";
import { isDown } from "./controlBindings";
import { fireSuperLaser } from "./laserShot";

// Steel-cyan, matching the torus ring + its energy threads.
const CHARGE_HUE = ENTITY_CONFIG.torus.hue;

// How fast the charge aura ramps up / decays (exponential approach rate).
const AURA_RATE = 7;

const approach = (current: number, target: number, dt: number): number => {
  const k = 1 - Math.exp(-AURA_RATE * Math.max(0, dt));
  return current + (target - current) * k;
};

// Each frame: if the ship is flying through a torus ring's energy thread, bank a
// super-laser charge (its next shot fires a screen-spanning bolt — see
// fireSuperLaser). Re-touching while already charged just refreshes the aura, so
// the charge can't stack but won't be lost by lingering in the gap. The aura
// glow eases toward "lit while charged" so it builds + fades smoothly.
export const tickTorusCharge = (game: Game, dt: number) => {
  const ship = game.ship;
  if (!ship.alive) {
    ship.superLaserChargeGlow = approach(ship.superLaserChargeGlow, 0, dt);
    return;
  }
  const touching = shipTouchingTorusThread(game.asteroids, ship.pos.x, ship.pos.y, ship.hitRadius);
  if (touching && !ship.superLaserCharged) {
    ship.superLaserCharged = true;
    game.sound.play("powerup", 1, ship.pos);
    // Crackling absorb burst around the hull, in the ring's steel-cyan.
    emitBurst(game.particles, {
      pos: ship.pos,
      count: 26,
      speedRange: [60, 240],
      lifeRange: [0.3, 0.8], maxLife: 0.8,
      sizeRange: [1, 2.6],
      hue: CHARGE_HUE, hueSpread: [-10, 30],
      drag: 1.8,
      angleMode: "uniform", angleJitter: 0.4,
    });
    game.shake = Math.min(game.shake + 0.25, 1.0);
  }
  const target = ship.superLaserCharged ? 1 : 0;
  ship.superLaserChargeGlow = approach(ship.superLaserChargeGlow, target, dt);
};

// Fire the banked super-laser on the next fire press. Owns the fire input while
// a charge is held (the normal bullet path + the held-charge laser path both
// defer to superLaserCharged), so the charged shot lands instead of a bullet.
// Respects the ship's fire cooldown so a held button fires it exactly once, then
// the charge is spent. Call after ship.update (cooldown already decremented).
export const tickSuperLaserFire = (game: Game) => {
  const ship = game.ship;
  if (!ship.alive || !ship.superLaserCharged) return;
  if (!isDown(game.input, "fire")) return;
  if (ship.fireCooldown > 0) return;
  fireSuperLaser(game, ship);
  ship.superLaserCharged = false;
  ship.fireCooldown = ship.fireRate;
};
