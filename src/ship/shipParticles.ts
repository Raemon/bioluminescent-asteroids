import type { Ship } from "../Ship";
import { add, mul, fromAngle } from "../vec";
import { ParticleSystem } from "../Particle";

// continuous tail-flicker per frame sells the ship as combusting, not just translating.
export const emitThrust = (ship: Ship, particles: ParticleSystem, t: number) => {
  const back = fromAngle(ship.heading + Math.PI, 1);
  const tail = add(ship.pos, mul(back, ship.radius * 0.9));
  const jitter = (Math.random() - 0.5) * 0.6;
  const spread = fromAngle(ship.heading + Math.PI + jitter, 1);
  const flicker = 0.6 + 0.4 * Math.sin(t * 0.04);
  particles.emit({
    pos: tail,
    vel: add(mul(spread, 180 + Math.random() * 120), mul(ship.vel, 0.3)),
    life: 0.4 + Math.random() * 0.2, maxLife: 0.6,
    size: 1.4 * flicker, hue: 190 + Math.random() * 40,
    shrink: 1, drag: 1.8,
  });
};

// retro reads as a punchy braking blast — bright hot core, cool halo, occasional spark pop.
const emitReverseCore = (ship: Ship, particles: ParticleSystem, muzzle: { x: number; y: number }, flicker: number) => {
  for (let i = 0; i < 2; i++) {
    const jitter = (Math.random() - 0.5) * 0.35;
    const spread = fromAngle(ship.heading + jitter, 1);
    particles.emit({
      pos: muzzle,
      vel: add(mul(spread, 220 + Math.random() * 140), mul(ship.vel, 0.3)),
      life: 0.18 + Math.random() * 0.12, maxLife: 0.3,
      size: 1.6 * flicker, hue: 195 + Math.random() * 25,
      shrink: 1, drag: 2.4,
    });
  }
};

// slower, wider, longer-lived puff that gives the retro flame visible thickness.
const emitReverseHalo = (ship: Ship, particles: ParticleSystem, muzzle: { x: number; y: number }, flicker: number) => {
  const haloJitter = (Math.random() - 0.5) * 0.8;
  const haloSpread = fromAngle(ship.heading + haloJitter, 1);
  particles.emit({
    pos: muzzle,
    vel: add(mul(haloSpread, 90 + Math.random() * 80), mul(ship.vel, 0.25)),
    life: 0.35 + Math.random() * 0.2, maxLife: 0.55,
    size: 2.2 * flicker, hue: 210 + Math.random() * 20,
    shrink: 1, drag: 1.6,
  });
};

// intermittent bright spark gives the retro a "flashy jet" feel rather than a steady plume.
const emitReverseSpark = (ship: Ship, particles: ParticleSystem, muzzle: { x: number; y: number }) => {
  if (Math.random() >= 0.5) return;
  const sparkJitter = (Math.random() - 0.5) * 0.5;
  const sparkDir = fromAngle(ship.heading + sparkJitter, 1);
  particles.emit({
    pos: muzzle,
    vel: add(mul(sparkDir, 320 + Math.random() * 160), mul(ship.vel, 0.2)),
    life: 0.12 + Math.random() * 0.08, maxLife: 0.2,
    size: 1.0, hue: 50 + Math.random() * 30,
    shrink: 1, drag: 3.0,
  });
};

// twin front-corner jets sell the retro as venting forward to brake, not as backward thrust.
export const emitReverseThrust = (ship: Ship, particles: ParticleSystem, t: number) => {
  const flicker = 0.7 + 0.3 * Math.sin(t * 0.06);
  for (const cornerOffset of [Math.PI * 0.78, -Math.PI * 0.78]) {
    const corner = fromAngle(ship.heading + cornerOffset, ship.radius * 1.0);
    const muzzle = add(ship.pos, corner);
    emitReverseCore(ship, particles, muzzle, flicker);
    emitReverseHalo(ship, particles, muzzle, flicker);
    emitReverseSpark(ship, particles, muzzle);
  }
};
