import type { Ship } from "../Ship";
import { addScaledMut, scaleMut, wrapMut } from "../vec";
import { IInput } from "../Input";
import { ParticleSystem } from "../Particle";
import { Bullet } from "../Bullet";
import { Sound } from "../Sound";
import { emitThrust, emitReverseThrust, emitSideThrust } from "./shipParticles";
import { fireBullets } from "./shipWeapons";
import { isDown } from "../game/controlBindings";

const ENGINE_SOUNDS_ENABLED = false;

// Flip to true to give every ship side thrust from the start, ignoring the
// sideEngines powerup gate. Flip back to false to return it to an upgrade.
// Same flag also pulls the sideEngines powerup from the drop pool (see
// Canister.POWERUP_KINDS) so the two never disagree.
export const SIDE_THRUST_ALWAYS_ON = true;

// Drift-aim fine-control: hovering a Next Beat Target slows both rotation AND thrust so the player
// can hold the lock and build drift tier. The slow deepens with the three nested hover zones (set
// by the sim's hover-lock tick on slot 0): nearby approach ring (zoneEnterBeatTime) → central
// target circle (hoverStartBeatTime) → first drift reward / 0.5s lock (completionBeatTime).
// Rotation and thrust each have their own [nearby, center, locked] multiplier set so they can be
// tuned apart.
type DriftAimMults = { nearby: number; center: number; locked: number };
const DRIFT_AIM_ROT_MULTS: DriftAimMults = { nearby: 1, center: 0.25, locked: 0.25 };
const DRIFT_AIM_THRUST_MULTS: DriftAimMults = { nearby: 1, center: 0.25, locked: 0.25 };
// ease toward the zone's target multiplier so crossing a boundary doesn't snap velocity.
const DRIFT_AIM_EASE_SEC = 0.15;

// deepest zone the slot-0 ring reports → its multiplier from the given set (1 when off-target
// entirely). Zones nest, so check inner-first.
const driftAimTargetMult = (ship: Ship, mults: DriftAimMults) => {
  const ring = ship.hoverDotRingState;
  if (ring.completionBeatTime !== null) return mults.locked;
  if (ring.hoverStartBeatTime !== null) return mults.center;
  if (ring.zoneEnterBeatTime !== null) return mults.nearby;
  return 1;
};

// resolve this frame's eased multiplier for rotation / thrust respectively.
const driftAimRotMult = (ship: Ship) => ship.driftAimRotMultEased;
const driftAimThrustMult = (ship: Ship) => ship.driftAimThrustMultEased;

// ease one value toward its target so feel stays smooth across boundaries.
const easeDriftAim = (current: number, target: number, dt: number) =>
  current + (target - current) * Math.min(1, dt / DRIFT_AIM_EASE_SEC);

// step both eased multipliers once per frame from the current hover zone.
const updateDriftAimSlow = (ship: Ship, dt: number) => {
  ship.driftAimRotMultEased = easeDriftAim(ship.driftAimRotMultEased, driftAimTargetMult(ship, DRIFT_AIM_ROT_MULTS), dt);
  ship.driftAimThrustMultEased = easeDriftAim(ship.driftAimThrustMultEased, driftAimTargetMult(ship, DRIFT_AIM_THRUST_MULTS), dt);
};

// Two-regime turning: inside the tap window the ship turns at a slow,
// constant nudge rate, then the rate blends quickly up to the full turn
// rate and holds steady there. With rotInertia the spin coasts on key
// release and must be countered; without it the spin stops instantly.
const updateTurning = (ship: Ship, input: IInput, dt: number) => {
  const dir = (isDown(input, "rotateRight") ? 1 : 0) - (isDown(input, "rotateLeft") ? 1 : 0);
  const precision = isDown(input, "precisionTurn") ? 0.2 : 1;
  updateDriftAimSlow(ship, dt);
  const driftAim = driftAimRotMult(ship);
  if (dir !== 0) {
    if (dir !== ship.rotHeldDir) ship.rotHoldTime = 0;
    ship.rotHoldTime += dt;
    const past = ship.rotHoldTime - ship.rotTapHoldTime;
    const blend = Math.min(1, Math.max(0, past / ship.rotRampTime));
    const rate = ship.rotTapRate + (ship.rotMaxSpeed - ship.rotTapRate) * blend;
    ship.rotVel = dir * rate * precision * driftAim;
  } else {
    ship.rotHoldTime = 0;
    if (!ship.rotInertia) ship.rotVel = 0;
  }
  ship.rotHeldDir = dir;
  ship.heading += ship.rotVel * dt;
};

// tap-to-nudge feel; thrust ramps in over ~0.15s so a tap barely budges and a hold accelerates fully.
const updateThrustRamp = (ship: Ship, input: IInput, dt: number) => {
  const active = isDown(input, "thrust") || isDown(input, "reverse");
  if (active) ship.thrustRamp = Math.min(1, ship.thrustRamp + dt / 0.15);
  else ship.thrustRamp = 0;
};
const thrustScale = (ship: Ship) => 0.02 + 0.98 * ship.thrustRamp;

// Single acceleration path for every engine — push velocity along (heading + offset) with the
// drift-aim slow baked in, so all movement honours the hover-zone multiplier identically. `ramped`
// applies the forward/reverse tap-ramp; side thrust passes false to keep its instant full power.
const applyThrust = (ship: Ship, headingOffset: number, ramped: boolean, dt: number, t: number) => {
  const a = ship.thrustPower * (ramped ? thrustScale(ship) : 1) * driftAimThrustMult(ship) * dt;
  const h = ship.heading + headingOffset;
  ship.vel.x += Math.cos(h) * a;
  ship.vel.y += Math.sin(h) * a;
  ship.lastThrustActiveAt = t / 1000;
};

// thruster has to gate sound start/stop on the edge so the loop doesn't restart every frame.
const updateForwardThrust = (ship: Ship, input: IInput, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasThrusting = ship.thrustOn;
  ship.thrustOn = isDown(input, "thrust");
  if (ship.thrustOn) {
    applyThrust(ship, 0, true, dt, t);
    emitThrust(ship, particles, t);
    if (ENGINE_SOUNDS_ENABLED && !wasThrusting) sound.play("thrust");
  } else if (wasThrusting) sound.stopThrust();
};

// retro-thrust mirrors forward thrust with its own audio loop and front-vented jet flames.
const updateReverseThrust = (ship: Ship, input: IInput, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasReversing = ship.reverseThrustOn;
  ship.reverseThrustOn = isDown(input, "reverse");
  if (ship.reverseThrustOn) {
    applyThrust(ship, Math.PI, true, dt, t);
    emitReverseThrust(ship, particles, t);
    if (ENGINE_SOUNDS_ENABLED && !wasReversing) sound.play("reverseThrust");
  } else if (wasReversing) sound.stopReverseThrust();
};

// Lateral thrust — port pushes left of heading, starboard pushes right.
// Gated on the sideEngines powerup (unless SIDE_THRUST_ALWAYS_ON); bound to
// z/x by default. Shares one audio loop that runs while either key is held.
const updateSideThrust = (ship: Ship, input: IInput, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const enabled = ship.sideEnginesActive || SIDE_THRUST_ALWAYS_ON;
  const wasActive = ship.portThrustOn || ship.starboardThrustOn;
  ship.portThrustOn = enabled && isDown(input, "sidePort");
  ship.starboardThrustOn = enabled && isDown(input, "sideStarboard");
  if (ship.portThrustOn) {
    applyThrust(ship, -Math.PI / 2, false, dt, t);
    emitSideThrust(ship, particles, t, "port");
  }
  if (ship.starboardThrustOn) {
    applyThrust(ship, Math.PI / 2, false, dt, t);
    emitSideThrust(ship, particles, t, "starboard");
  }
  const isActive = ship.portThrustOn || ship.starboardThrustOn;
  if (ENGINE_SOUNDS_ENABLED && isActive && !wasActive) sound.play("sideThrust");
  else if (!isActive && wasActive) sound.stopSideThrust();
};

// rapid powerup halves the cooldown; both states use the same trigger gate.
// lasershot replaces the per-press bullet emit with hold-to-charge / release-to-fire
// driven by game/laserShot.ts.tickLaserShot — gate the bullet path off entirely here.
const updateFireTrigger = (ship: Ship, input: IInput, bullets: Bullet[]) => {
  if (ship.lasershotActive) return;
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
  ship: Ship, dt: number, input: IInput,
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
