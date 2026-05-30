import type { Ship } from "../Ship";
import { add, mul, fromAngle, wrap } from "../vec";
import { Input } from "../Input";
import { ParticleSystem } from "../Particle";
import { Bullet } from "../Bullet";
import { Sound } from "../Sound";
import { emitThrust, emitReverseThrust } from "./shipParticles";
import { fireBullets } from "./shipWeapons";
import { BEAT_GRID } from "../game/rhythmConstants";
import { ReticuleTarget } from "./reticule/trajectoryPreview";
import { resolveHeadingWithLock } from "./reticule/headingLockOn";

// Why: tap-to-nudge feel; rotation ramps in over ~0.35s so a tap turns finely and a hold turns fast.
// Visible trajectory lines exert a soft snap on the heading — see resolveHeadingWithLock.
const updateTurning = (
  ship: Ship, input: Input, dt: number, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>,
) => {
  const turnLeft = input.down("arrowleft") || input.down("a");
  const turnRight = input.down("arrowright") || input.down("d");
  if (turnLeft || turnRight) ship.rotRamp = Math.min(1, ship.rotRamp + dt / 0.35);
  else ship.rotRamp = 0;
  const turnScale = 0.08 + 0.92 * ship.rotRamp;
  let intendedDelta = 0;
  if (turnLeft) intendedDelta -= ship.rotSpeed * turnScale * dt;
  if (turnRight) intendedDelta += ship.rotSpeed * turnScale * dt;
  // No rotation input → drop any active lock so the next press starts fresh.
  if (intendedDelta === 0) { ship.headingLock = null; return; }
  const result = resolveHeadingWithLock(ship, intendedDelta, BEAT_GRID, w, h, targets, ship.headingLock);
  ship.heading = result.heading;
  ship.headingLock = result.lock;
};

// Why: thruster has to gate sound start/stop on the edge so the loop doesn't restart every frame.
const updateForwardThrust = (ship: Ship, input: Input, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasThrusting = ship.thrustOn;
  ship.thrustOn = input.down("arrowup") || input.down("w");
  if (ship.thrustOn) {
    ship.vel = add(ship.vel, mul(fromAngle(ship.heading, ship.thrustPower), dt));
    emitThrust(ship, particles, t);
    ship.lastThrustActiveAt = t / 1000;
    if (!wasThrusting) sound.play("thrust");
  } else if (wasThrusting) sound.stopThrust();
};

// Why: retro-thrust mirrors forward thrust with its own audio loop and front-vented jet flames.
const updateReverseThrust = (ship: Ship, input: Input, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasReversing = ship.reverseThrustOn;
  ship.reverseThrustOn = input.down("arrowdown") || input.down("s");
  if (ship.reverseThrustOn) {
    ship.vel = add(ship.vel, mul(fromAngle(ship.heading + Math.PI, ship.thrustPower), dt));
    emitReverseThrust(ship, particles, t);
    ship.lastThrustActiveAt = t / 1000;
    if (!wasReversing) sound.play("reverseThrust");
  } else if (wasReversing) sound.stopReverseThrust();
};

// Why: rapid powerup halves the cooldown; both states use the same trigger gate.
const updateFireTrigger = (ship: Ship, input: Input, bullets: Bullet[]) => {
  if (!(input.down(" ") || input.down("spacebar"))) return;
  if (ship.fireCooldown > 0) return;
  fireBullets(ship, bullets);
  const RAPID_FIRE_RATE_MULTIPLIER = 0.5;
  ship.fireCooldown = ship.rapidActive ? ship.fireRate * RAPID_FIRE_RATE_MULTIPLIER : ship.fireRate;
};

// Why: easing the halo intensity smooths the visual response — snap up on combo gain, slow fade on loss.
const easeComboHaloIntensity = (ship: Ship, dt: number) => {
  const haloTarget = ship.comboHaloTier;
  const rising = haloTarget > ship.comboHaloIntensity;
  const rate = rising ? 14 : 2.5;
  ship.comboHaloIntensity += (haloTarget - ship.comboHaloIntensity) * Math.min(1, rate * dt);
  if (ship.comboLossFlash > 0) ship.comboLossFlash = Math.max(0, ship.comboLossFlash - dt / 0.7);
};

// Why: velocity cap + screen wrap keep the ship in bounds; drag is 0 so Newtonian drift dominates.
const integrateMotion = (ship: Ship, dt: number, w: number, h: number) => {
  ship.vel = mul(ship.vel, 1 - ship.drag * dt);
  const speed = Math.hypot(ship.vel.x, ship.vel.y);
  if (speed > ship.maxSpeed) ship.vel = mul(ship.vel, ship.maxSpeed / speed);
  ship.pos = wrap(add(ship.pos, mul(ship.vel, dt)), w, h);
};

// Why: one frame's worth of player control, audio, and motion — keeps Ship.update one-line readable.
export const tickShip = (
  ship: Ship, dt: number, input: Input,
  particles: ParticleSystem, bullets: Bullet[],
  w: number, h: number, t: number, sound: Sound,
  targets: ReadonlyArray<ReticuleTarget>,
) => {
  if (!ship.alive) return;
  if (ship.invuln > 0) ship.invuln -= dt;
  if (ship.fireCooldown > 0) ship.fireCooldown -= dt;
  easeComboHaloIntensity(ship, dt);
  updateTurning(ship, input, dt, w, h, targets);
  updateForwardThrust(ship, input, particles, sound, dt, t);
  updateReverseThrust(ship, input, particles, sound, dt, t);
  updateFireTrigger(ship, input, bullets);
  integrateMotion(ship, dt, w, h);
};
