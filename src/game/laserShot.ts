import type { Game } from "../Game";
import type { Ship } from "../Ship";
import type { Asteroid } from "../Asteroid";
import type { Alien } from "../Alien";
import type { Comet } from "../Comet";
import { Vec, v, fromAngle, add, mul } from "../vec";
import { Bullet } from "../Bullet";
import { BEAT_GRID } from "./rhythmConstants";
import { isDown } from "./controlBindings";
import {
  onAsteroidKilledByBullet,
  onAsteroidCrackedByBullet,
  onAlienKilled,
  onAlienCracked,
  onCometKilled,
} from "./killEffects";
import { syncHud } from "./hud";

// Max charge dots (one per beat held). Damage = 1 + numDots, so 0 dots = 1,
// 3 dots = 4 — about a kill-shot on a small asteroid at full charge.
export const LASER_MAX_DOTS = 3;
// Visible beam stays painted for this many seconds after fire — long enough
// to read as a flash, short enough that another shot a beat later doesn't
// overlap the previous trail.
const LASER_BEAM_LIFE = 0.22;
// Beam length matches the farthest reticule slot: bulletSpeed * effectiveBulletLife.
// Mirror the same multipliers shipWeapons uses (pierce/longshot/superBoosted).
const PIERCE_RANGE_MULT = 2;
const LONGSHOT_RANGE_MULT = 1.5;
const SUPERBOOSTED_RANGE_MULT = 1.5;

// A laser beam is a static segment from `origin` extending `length` along
// `heading`. It lives for LASER_BEAM_LIFE seconds purely as a visual; the
// damage pass that spawned it already resolved all hits in one frame.
export class LaserBeam {
  origin: Vec;
  heading: number;
  length: number;
  life: number;
  maxLife: number;
  // Damage that *was* dealt — used for the beam thickness (more dots = thicker).
  damage: number;

  constructor(origin: Vec, heading: number, length: number, damage: number) {
    this.origin = { ...origin };
    this.heading = heading;
    this.length = length;
    this.life = LASER_BEAM_LIFE;
    this.maxLife = LASER_BEAM_LIFE;
    this.damage = damage;
  }

  update(dt: number) {
    this.life -= dt;
  }

  get alive() {
    return this.life > 0;
  }
}

// Number of dots currently charged (0..LASER_MAX_DOTS). One dot ticks in per
// beat held. Public so the renderer can paint the dots in front of the ship.
export const laserDotCount = (ship: Ship, beatTime: number): number => {
  if (!ship.laserChargeActive) return 0;
  const elapsed = Math.max(0, beatTime - ship.laserChargeStartBeatTime);
  return Math.min(LASER_MAX_DOTS, Math.floor(elapsed / BEAT_GRID));
};

export const resetLaserCharge = (ship: Ship) => {
  ship.laserChargeActive = false;
  ship.laserChargeStartBeatTime = 0;
  ship.laserLastDotIndexFired = -1;
};

// Effective bullet life mirrors shipWeapons.launchBullet + reticule render
// so the beam reaches the same farthest on-beat slot the reticule paints.
const effectiveBulletLife = (ship: Ship, superBoosted: boolean): number => {
  let life = ship.bulletLife;
  if (ship.pierceActive) life *= PIERCE_RANGE_MULT;
  if (ship.longshotActive) life *= LONGSHOT_RANGE_MULT;
  if (superBoosted) life *= SUPERBOOSTED_RANGE_MULT;
  return life;
};

const computeBeamLength = (ship: Ship, superBoosted: boolean): number => {
  return ship.bulletSpeed * effectiveBulletLife(ship, superBoosted);
};

// Called each frame after Ship.update. The normal fireBullets path is
// suppressed by lasershotActive inside shipPhysics; this owns fire input
// while the upgrade is active.
export const tickLaserShot = (game: Game) => {
  const ship = game.ship;
  if (!ship.alive) {
    resetLaserCharge(ship);
    return;
  }
  if (!ship.lasershotActive) return;
  const firePressed = isDown(game.input, "fire");

  if (firePressed) {
    if (!ship.laserChargeActive) {
      ship.laserChargeActive = true;
      ship.laserChargeStartBeatTime = game.beatTime;
      ship.laserLastDotIndexFired = -1;
    }
    // Per-dot charge tick — plays a short C-chord pluck on each new dot so the
    // player hears the charge building.
    const dots = laserDotCount(ship, game.beatTime);
    if (dots > ship.laserLastDotIndexFired && dots > 0) {
      ship.laserLastDotIndexFired = dots;
      game.sound.playLaserCharge(dots);
    }
    return;
  }

  // Fire-released: if we were charging, fire the beam.
  if (ship.laserChargeActive) {
    const dots = laserDotCount(ship, game.beatTime);
    fireLaser(game, ship, dots);
    resetLaserCharge(ship);
  }
};

const fireLaser = (game: Game, ship: Ship, dots: number) => {
  const damage = 1 + dots;
  const superBoosted = game.beatCombo >= 12;
  const length = computeBeamLength(ship, superBoosted);
  const dir = fromAngle(ship.heading, 1);
  const origin = add(ship.pos, mul(dir, ship.radius + 4));
  const beam = new LaserBeam(origin, ship.heading, length, damage);
  game.lasers.push(beam);
  game.sound.playLaserShot(damage);
  game.shake = Math.min(game.shake + 0.12 + dots * 0.06, 1.2);
  applyBeamDamage(game, origin, dir, length, damage);
};

// Walks every target whose centre falls within `length` of the beam segment.
// Each target is hit at most once per beam. Asteroids/aliens use the same
// kill-effect helpers a real bullet would, with a synthetic Bullet feeding
// the impact position into the existing pipeline.
const applyBeamDamage = (game: Game, origin: Vec, dir: Vec, length: number, damage: number) => {
  applyBeamToAsteroids(game, origin, dir, length, damage);
  applyBeamToAliens(game, origin, dir, length, damage);
  applyBeamToComets(game, origin, dir, length, damage);
  syncHud(game);
};

// Distance from `pos` to the beam segment [origin, origin + dir*length],
// plus the t-parameter along the beam (clamped to [0, length]) where the
// closest approach lands — used as the visual impact position.
const distanceToBeam = (
  origin: Vec, dir: Vec, length: number, pos: Vec,
): { distance: number; t: number } => {
  const dx = pos.x - origin.x;
  const dy = pos.y - origin.y;
  const tRaw = dx * dir.x + dy * dir.y;
  const t = Math.max(0, Math.min(length, tRaw));
  const px = origin.x + dir.x * t;
  const py = origin.y + dir.y * t;
  return { distance: Math.hypot(pos.x - px, pos.y - py), t };
};

const applyBeamToAsteroids = (game: Game, origin: Vec, dir: Vec, length: number, damage: number) => {
  const surviving: Asteroid[] = [];
  for (const a of game.asteroids) {
    const { distance, t } = distanceToBeam(origin, dir, length, a.pos);
    if (distance > a.radius) { surviving.push(a); continue; }
    const hitPos = v(origin.x + dir.x * t, origin.y + dir.y * t);
    const fakeBullet = makeFakeBullet(hitPos, dir);
    const { killed } = a.applyDamage(damage);
    game.shake = Math.min(game.shake + (killed ? 0.3 : 0.15), 1.2);
    if (!killed) {
      a.applyKnockback(dir.x, dir.y, damage);
      onAsteroidCrackedByBullet(game, a, fakeBullet, false);
      surviving.push(a);
    } else {
      const children = onAsteroidKilledByBullet(game, a, fakeBullet, false);
      for (const c of children) surviving.push(c);
    }
  }
  game.asteroids = surviving;
};

const applyBeamToAliens = (game: Game, origin: Vec, dir: Vec, length: number, damage: number) => {
  const surviving: Alien[] = [];
  for (const al of game.aliens) {
    const { distance, t } = distanceToBeam(origin, dir, length, al.pos);
    if (distance > al.radius) { surviving.push(al); continue; }
    const hitPos = v(origin.x + dir.x * t, origin.y + dir.y * t);
    const fakeBullet = makeFakeBullet(hitPos, dir);
    // Aliens take 1 hp per applyDamage; loop so charge tiers chew through HP
    // in a single beam pass instead of needing N separate shots.
    let killed = false;
    for (let i = 0; i < damage; i++) {
      const r = al.applyDamage();
      if (r.killed) { killed = true; break; }
    }
    if (killed) {
      onAlienKilled(game, al, fakeBullet, false);
    } else {
      al.applyKnockback(dir.x, dir.y, damage);
      onAlienCracked(game, false, al.pos);
      surviving.push(al);
    }
  }
  game.aliens = surviving;
};

const applyBeamToComets = (game: Game, origin: Vec, dir: Vec, length: number, damage: number) => {
  const surviving: Comet[] = [];
  for (const c of game.comets) {
    const { distance, t } = distanceToBeam(origin, dir, length, c.pos);
    if (distance > c.radius) { surviving.push(c); continue; }
    const hitPos = v(origin.x + dir.x * t, origin.y + dir.y * t);
    const fakeBullet = makeFakeBullet(hitPos, dir);
    onCometKilled(game, c, fakeBullet, false);
    // Comet is single-hit — drop it regardless of `damage`.
    void damage;
  }
  game.comets = surviving;
};

// Synthesises a Bullet just so the existing kill-effect helpers can read
// .pos / .vel / .driftEligibleAtHit() without us re-wiring the whole kill
// pipeline. The fake bullet is never added to game.bullets so it never
// updates or renders.
const makeFakeBullet = (pos: Vec, dir: Vec): Bullet => {
  const b = new Bullet({ x: pos.x, y: pos.y }, { x: dir.x, y: dir.y }, 0.01);
  b.onBeat = false;
  b.boosted = false;
  b.superBoosted = false;
  b.pierce = false;
  b.driftLockedSlots = [];
  return b;
};

// Charge dots float in front of the ship — one per beat charged. Each dot
// pulses on its own beat slot so a freshly-armed dot reads as "just landed".
export const renderLaserChargeDots = (
  ctx: CanvasRenderingContext2D, ship: Ship, beatTime: number,
) => {
  if (!ship.lasershotActive) return;
  if (!ship.laserChargeActive) return;
  const dots = laserDotCount(ship, beatTime);
  if (dots <= 0) return;
  const dir = fromAngle(ship.heading, 1);
  // First dot sits a bit past the muzzle; subsequent dots step outward.
  const baseOffset = ship.radius + 14;
  const dotGap = 12;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < dots; i++) {
    const px = ship.pos.x + dir.x * (baseOffset + i * dotGap);
    const py = ship.pos.y + dir.y * (baseOffset + i * dotGap);
    // Per-dot age in seconds since this dot first appeared. The dot at index
    // i appeared at startBeatTime + (i+1)*BEAT_GRID.
    const dotAgeSec = Math.max(0, beatTime - (ship.laserChargeStartBeatTime + (i + 1) * BEAT_GRID));
    // Birth-pop: bright burst on the first ~0.15s, settles to steady pulse.
    const popT = Math.min(1, dotAgeSec / 0.15);
    const popBoost = 1 + (1 - popT) * 1.5;
    const pulse = 0.65 + 0.35 * Math.sin(beatTime * 6 + i * 1.7);
    const r = 3.2 * popBoost;
    // Soft halo
    const halo = ctx.createRadialGradient(px, py, 0, px, py, r * 3.2);
    halo.addColorStop(0, `rgba(140, 230, 255, ${(0.6 * pulse).toFixed(3)})`);
    halo.addColorStop(0.5, `rgba(100, 200, 255, ${(0.3 * pulse).toFixed(3)})`);
    halo.addColorStop(1, "rgba(80, 180, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(px, py, r * 3.2, 0, Math.PI * 2);
    ctx.fill();
    // Bright core
    ctx.fillStyle = `rgba(240, 250, 255, ${(0.95 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};

export const renderLasers = (ctx: CanvasRenderingContext2D, lasers: LaserBeam[]) => {
  if (lasers.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const beam of lasers) {
    const t = beam.life / beam.maxLife;
    // Fast attack, slow tail — beam stamps fully bright then fades.
    const alpha = t > 0.85 ? (1 - t) / 0.15 : t / 0.85;
    const ex = beam.origin.x + Math.cos(beam.heading) * beam.length;
    const ey = beam.origin.y + Math.sin(beam.heading) * beam.length;
    // Outer glow — wide, soft, cyan-tinged.
    const glowW = 14 + beam.damage * 3;
    ctx.strokeStyle = `rgba(120, 220, 255, ${(0.25 * alpha).toFixed(3)})`;
    ctx.lineWidth = glowW;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Mid layer — brighter, narrower.
    ctx.strokeStyle = `rgba(180, 240, 255, ${(0.5 * alpha).toFixed(3)})`;
    ctx.lineWidth = 6 + beam.damage * 1.5;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Core — near-white, hot.
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
    ctx.lineWidth = 2 + beam.damage * 0.4;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  ctx.restore();
};
