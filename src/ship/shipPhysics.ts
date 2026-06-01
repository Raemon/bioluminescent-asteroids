import type { Ship } from "../Ship";
import { addScaledMut, scaleMut, wrapMut } from "../vec";
import { Input } from "../Input";
import { ParticleSystem } from "../Particle";
import { Bullet } from "../Bullet";
import { Sound } from "../Sound";
import { emitThrust, emitReverseThrust, emitSideThrust } from "./shipParticles";
import { fireBullets } from "./shipWeapons";
import { isDown } from "../game/controlBindings";

// initial 1/4 speed nudge, then hold for TURN_RAMP_DELAY before ramping to full over ~0.15s.
const TURN_RAMP_DELAY = 0;
const TURN_INITIAL_SCALE = 0.01;
const updateTurning = (ship: Ship, input: Input, dt: number) => {
  const turnLeft = isDown(input, "rotateLeft");
  const turnRight = isDown(input, "rotateRight");
  if (turnLeft || turnRight) {
    ship.rotHoldTime += dt;
    if (ship.rotHoldTime > TURN_RAMP_DELAY) ship.rotRamp = Math.min(1, ship.rotRamp + dt / 0.15);
  } else {
    ship.rotRamp = 0;
    ship.rotHoldTime = 0;
  }
  const turnScale = TURN_INITIAL_SCALE + (1 - TURN_INITIAL_SCALE) * ship.rotRamp;
  const precision = isDown(input, "precisionTurn") ? 0.2 : 1;
  if (turnLeft) ship.heading -= ship.rotSpeed * turnScale * precision * dt;
  if (turnRight) ship.heading += ship.rotSpeed * turnScale * precision * dt;
};

// tap-to-nudge feel; thrust ramps in over ~0.15s so a tap barely budges and a hold accelerates fully.
const updateThrustRamp = (ship: Ship, input: Input, dt: number) => {
  const active = isDown(input, "thrust") || isDown(input, "reverse");
  if (active) ship.thrustRamp = Math.min(1, ship.thrustRamp + dt / 0.15);
  else ship.thrustRamp = 0;
};
const thrustScale = (ship: Ship) => 0.02 + 0.98 * ship.thrustRamp;

// thruster has to gate sound start/stop on the edge so the loop doesn't restart every frame.
const updateForwardThrust = (ship: Ship, input: Input, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasThrusting = ship.thrustOn;
  ship.thrustOn = isDown(input, "thrust");
  if (ship.thrustOn) {
    const a = ship.thrustPower * thrustScale(ship) * dt;
    ship.vel.x += Math.cos(ship.heading) * a;
    ship.vel.y += Math.sin(ship.heading) * a;
    emitThrust(ship, particles, t);
    ship.lastThrustActiveAt = t / 1000;
    if (!wasThrusting) sound.play("thrust");
  } else if (wasThrusting) sound.stopThrust();
};

// retro-thrust mirrors forward thrust with its own audio loop and front-vented jet flames.
const updateReverseThrust = (ship: Ship, input: Input, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasReversing = ship.reverseThrustOn;
  ship.reverseThrustOn = isDown(input, "reverse");
  if (ship.reverseThrustOn) {
    const a = ship.thrustPower * thrustScale(ship) * dt;
    const h = ship.heading + Math.PI;
    ship.vel.x += Math.cos(h) * a;
    ship.vel.y += Math.sin(h) * a;
    emitReverseThrust(ship, particles, t);
    ship.lastThrustActiveAt = t / 1000;
    if (!wasReversing) sound.play("reverseThrust");
  } else if (wasReversing) sound.stopReverseThrust();
};

// z/x lateral thrust — Z pushes port (left of heading), X pushes starboard.
// Shares one audio loop that runs while either key is held.
const updateSideThrust = (ship: Ship, input: Input, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasActive = ship.portThrustOn || ship.starboardThrustOn;
  ship.portThrustOn = isDown(input, "sidePort");
  ship.starboardThrustOn = isDown(input, "sideStarboard");
  if (ship.portThrustOn) {
    const a = ship.thrustPower * dt;
    const h = ship.heading - Math.PI / 2;
    ship.vel.x += Math.cos(h) * a;
    ship.vel.y += Math.sin(h) * a;
    emitSideThrust(ship, particles, t, "port");
    ship.lastThrustActiveAt = t / 1000;
  }
  if (ship.starboardThrustOn) {
    const a = ship.thrustPower * dt;
    const h = ship.heading + Math.PI / 2;
    ship.vel.x += Math.cos(h) * a;
    ship.vel.y += Math.sin(h) * a;
    emitSideThrust(ship, particles, t, "starboard");
    ship.lastThrustActiveAt = t / 1000;
  }
  const isActive = ship.portThrustOn || ship.starboardThrustOn;
  if (isActive && !wasActive) sound.play("sideThrust");
  else if (!isActive && wasActive) sound.stopSideThrust();
};

// rapid powerup halves the cooldown; both states use the same trigger gate.
const updateFireTrigger = (ship: Ship, input: Input, bullets: Bullet[]) => {
  if (!isDown(input, "fire")) return;
  if (ship.fireCooldown > 0) return;
  fireBullets(ship, bullets);
  const RAPID_FIRE_RATE_MULTIPLIER = 0.5;
  ship.fireCooldown = ship.rapidActive ? ship.fireRate * RAPID_FIRE_RATE_MULTIPLIER : ship.fireRate;
};

// easing the halo intensity smooths the visual response — snap up on combo gain, slow fade on loss.
const easeComboHaloIntensity = (ship: Ship, dt: number) => {
  const haloTarget = ship.comboHaloTier;
  const rising = haloTarget > ship.comboHaloIntensity;
  const rate = rising ? 14 : 2.5;
  ship.comboHaloIntensity += (haloTarget - ship.comboHaloIntensity) * Math.min(1, rate * dt);
  if (ship.comboLossFlash > 0) ship.comboLossFlash = Math.max(0, ship.comboLossFlash - dt / 0.7);
};

// velocity cap + screen wrap keep the ship in bounds; drag is 0 so Newtonian drift dominates.
const integrateMotion = (ship: Ship, dt: number, w: number, h: number) => {
  scaleMut(ship.vel, 1 - ship.drag * dt);
  const speed = Math.hypot(ship.vel.x, ship.vel.y);
  if (speed > ship.maxSpeed) scaleMut(ship.vel, ship.maxSpeed / speed);
  addScaledMut(ship.pos, ship.vel, dt);
  wrapMut(ship.pos, w, h);
};

// one frame's worth of player control, audio, and motion — keeps Ship.update one-line readable.
export const tickShip = (
  ship: Ship, dt: number, input: Input,
  particles: ParticleSystem, bullets: Bullet[],
  w: number, h: number, t: number, sound: Sound,
) => {
  if (!ship.alive) return;
  if (ship.invuln > 0) ship.invuln -= dt;
  if (ship.fireCooldown > 0) ship.fireCooldown -= dt;
  easeComboHaloIntensity(ship, dt);
  updateTurning(ship, input, dt);
  updateThrustRamp(ship, input, dt);
  updateForwardThrust(ship, input, particles, sound, dt, t);
  updateReverseThrust(ship, input, particles, sound, dt, t);
  updateSideThrust(ship, input, particles, sound, dt, t);
  updateFireTrigger(ship, input, bullets);
  integrateMotion(ship, dt, w, h);
};
