import type { Game } from "../Game";
import type { Ship } from "../Ship";
import type { Asteroid } from "../Asteroid";
import type { Alien } from "../Alien";
import type { Comet } from "../Comet";
import { Vec, v, fromAngle, add, mul } from "../vec";
import { Bullet } from "../Bullet";
import { BEAT_GRID } from "./rhythmConstants";
import { isDown } from "./controlBindings";
import { isInBeatWindow } from "./rhythmGate";
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
  ship.laserChargeFailedThisHold = false;
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
    if (!ship.laserChargeActive && !ship.laserChargeFailedThisHold) {
      // Charge must START on-beat. The release can land anywhere — that's just
      // how many dots you held for. Rejecting only the start gives the player
      // a clear, learnable rule without making release timing punishing.
      if (!isInBeatWindow(game, game.perceivedBeatTime)) {
        ship.laserChargeFailedThisHold = true;
        game.sound.playLaserChargeFail();
        return;
      }
      ship.laserChargeActive = true;
      ship.laserChargeStartBeatTime = game.beatTime;
      ship.laserLastDotIndexFired = -1;
    }
    if (!ship.laserChargeActive) return;
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
  }
  // Always reset on release so a re-press can try the beat window again.
  resetLaserCharge(ship);
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
    // The laser is a charged shot — give the boss family the meaty armored
    // impact every time it connects (the fake bullet is deliberately flagless,
    // so the bossHit gate in killEffects won't catch it).
    if (a.isBossFamily()) game.sound.play("bossHit", 1, a.pos);
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
// Higher-tier dots get extra orbiting sparks + an energy thread connecting
// back to the ship so a full charge reads as visibly "loaded up".
export const renderLaserChargeDots = (
  ctx: CanvasRenderingContext2D, ship: Ship, beatTime: number,
) => {
  if (!ship.lasershotActive) return;
  if (!ship.laserChargeActive) return;
  const dots = laserDotCount(ship, beatTime);
  if (dots <= 0) return;
  const dir = fromAngle(ship.heading, 1);
  const perp = { x: -dir.y, y: dir.x };
  // First dot sits a bit past the muzzle; subsequent dots step outward.
  const baseOffset = ship.radius + 14;
  const dotGap = 14;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // Connecting thread — a wobbling line from the muzzle through every armed dot.
  // Reads as "energy being routed forward". Brighter as more dots accumulate.
  const muzzleX = ship.pos.x + dir.x * (ship.radius + 4);
  const muzzleY = ship.pos.y + dir.y * (ship.radius + 4);
  const threadEndX = ship.pos.x + dir.x * (baseOffset + (dots - 1) * dotGap);
  const threadEndY = ship.pos.y + dir.y * (baseOffset + (dots - 1) * dotGap);
  const threadPulse = 0.55 + 0.45 * Math.sin(beatTime * 14);
  ctx.strokeStyle = `rgba(150, 230, 255, ${(0.18 * dots * threadPulse).toFixed(3)})`;
  ctx.lineWidth = 1.4 + dots * 0.4;
  ctx.beginPath();
  ctx.moveTo(muzzleX, muzzleY);
  // Mid wobble point so the thread squirms instead of being a straight line.
  const midX = (muzzleX + threadEndX) * 0.5 + perp.x * Math.sin(beatTime * 9) * 2;
  const midY = (muzzleY + threadEndY) * 0.5 + perp.y * Math.sin(beatTime * 9) * 2;
  ctx.quadraticCurveTo(midX, midY, threadEndX, threadEndY);
  ctx.stroke();

  for (let i = 0; i < dots; i++) {
    const px = ship.pos.x + dir.x * (baseOffset + i * dotGap);
    const py = ship.pos.y + dir.y * (baseOffset + i * dotGap);
    // Per-dot age in seconds since this dot first appeared. The dot at index
    // i appeared at startBeatTime + (i+1)*BEAT_GRID.
    const dotAgeSec = Math.max(0, beatTime - (ship.laserChargeStartBeatTime + (i + 1) * BEAT_GRID));
    // Birth-pop: huge burst on the first ~0.18s — settles to steady pulse.
    const popT = Math.min(1, dotAgeSec / 0.18);
    const popBoost = 1 + (1 - popT) * 2.4;
    // Per-tier brightness: higher-index dots glow brighter on top of pulse.
    const tierBoost = 1 + i * 0.22;
    const pulse = (0.7 + 0.3 * Math.sin(beatTime * 7 + i * 1.7)) * tierBoost;
    const r = 3.6 * popBoost;

    // Outer wide halo — soft cyan, fades quickly to transparent.
    const wideHalo = ctx.createRadialGradient(px, py, 0, px, py, r * 4.5);
    wideHalo.addColorStop(0, `rgba(160, 235, 255, ${(0.5 * pulse).toFixed(3)})`);
    wideHalo.addColorStop(0.4, `rgba(120, 210, 255, ${(0.28 * pulse).toFixed(3)})`);
    wideHalo.addColorStop(1, "rgba(80, 180, 255, 0)");
    ctx.fillStyle = wideHalo;
    ctx.beginPath();
    ctx.arc(px, py, r * 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Inner halo
    const halo = ctx.createRadialGradient(px, py, 0, px, py, r * 2.4);
    halo.addColorStop(0, `rgba(230, 250, 255, ${(0.85 * pulse).toFixed(3)})`);
    halo.addColorStop(1, "rgba(140, 220, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(px, py, r * 2.4, 0, Math.PI * 2);
    ctx.fill();

    // Bright white core
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, 0.95 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, r * 0.85, 0, Math.PI * 2);
    ctx.fill();

    // Rotating sparkle ring — three orbiting micro-dots around each charge dot.
    // Higher-tier dots spin faster so the energy reads as building.
    const ringR = r * 1.8;
    const spinRate = 4 + i * 1.8;
    const sparkCount = 3 + i;
    for (let s = 0; s < sparkCount; s++) {
      const ang = beatTime * spinRate + (s * (Math.PI * 2)) / sparkCount + i * 0.6;
      const sx = px + Math.cos(ang) * ringR;
      const sy = py + Math.sin(ang) * ringR;
      const sparkAlpha = (0.55 + 0.35 * Math.sin(beatTime * 11 + s * 1.3)) * tierBoost;
      ctx.fillStyle = `rgba(220, 245, 255, ${Math.min(1, sparkAlpha * 0.7).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.2 + 0.4 * Math.sin(beatTime * 13 + s), 0, Math.PI * 2);
      ctx.fill();
    }

    // Birth-pop ring — a quickly-expanding hollow ring on dot arrival, fades fast.
    if (popT < 1) {
      const ringRadius = r * (1.5 + popT * 3);
      const ringAlpha = (1 - popT) * 0.7;
      ctx.strokeStyle = `rgba(200, 240, 255, ${ringAlpha.toFixed(3)})`;
      ctx.lineWidth = 2 * (1 - popT) + 0.5;
      ctx.beginPath();
      ctx.arc(px, py, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
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
    const ageFrac = 1 - t; // 0 → freshly fired, 1 → about to vanish
    const cosH = Math.cos(beam.heading);
    const sinH = Math.sin(beam.heading);
    const ex = beam.origin.x + cosH * beam.length;
    const ey = beam.origin.y + sinH * beam.length;
    // Damage tier read as a 0..1 intensity ramp (damage 1 → 0, damage 4 → 1).
    const tier = Math.min(1, Math.max(0, (beam.damage - 1) / 3));

    // Outermost diffuse aura — very wide, very soft. Only meaningful at higher
    // damage; gives a charged shot a "this beam is bending the air" presence.
    if (beam.damage >= 2) {
      const auraW = 26 + beam.damage * 6;
      ctx.strokeStyle = `rgba(140, 200, 255, ${(0.12 * alpha * tier).toFixed(3)})`;
      ctx.lineWidth = auraW;
      ctx.beginPath();
      ctx.moveTo(beam.origin.x, beam.origin.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
    // Outer glow — wide, soft, cyan-tinged. Wider at higher damage.
    const glowW = 14 + beam.damage * 4;
    ctx.strokeStyle = `rgba(120, 220, 255, ${(0.28 * alpha).toFixed(3)})`;
    ctx.lineWidth = glowW;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Mid layer — brighter, narrower.
    ctx.strokeStyle = `rgba(180, 240, 255, ${(0.55 * alpha).toFixed(3)})`;
    ctx.lineWidth = 6 + beam.damage * 1.8;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Core — near-white, hot.
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
    ctx.lineWidth = 2.4 + beam.damage * 0.7;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Hot white-blue inner sliver — only on high-charge shots, sells the heat.
    if (beam.damage >= 3) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.85).toFixed(3)})`;
      ctx.lineWidth = 1 + tier * 1.2;
      ctx.beginPath();
      ctx.moveTo(beam.origin.x, beam.origin.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }

    // Muzzle burst — bright circular flash at the origin, dims fast over life.
    const burstAlpha = (1 - ageFrac) * alpha;
    const burstR = (8 + beam.damage * 5) * (0.6 + (1 - ageFrac) * 0.8);
    const burstGrad = ctx.createRadialGradient(
      beam.origin.x, beam.origin.y, 0,
      beam.origin.x, beam.origin.y, burstR,
    );
    burstGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.85 * burstAlpha).toFixed(3)})`);
    burstGrad.addColorStop(0.4, `rgba(180, 240, 255, ${(0.45 * burstAlpha).toFixed(3)})`);
    burstGrad.addColorStop(1, "rgba(120, 200, 255, 0)");
    ctx.fillStyle = burstGrad;
    ctx.beginPath();
    ctx.arc(beam.origin.x, beam.origin.y, burstR, 0, Math.PI * 2);
    ctx.fill();

    // Traveling sparks — small bright pips evenly spaced along the beam, drifting
    // forward over the beam's life. Density + size scale with damage.
    if (beam.damage >= 2) {
      const sparkCount = 4 + beam.damage * 3;
      const driftPhase = (1 - t); // 0..1 across beam lifetime
      const perpX = -sinH;
      const perpY = cosH;
      for (let s = 0; s < sparkCount; s++) {
        const baseFrac = (s + 0.5) / sparkCount;
        const frac = (baseFrac + driftPhase * 0.25) % 1;
        const sx = beam.origin.x + cosH * beam.length * frac;
        const sy = beam.origin.y + sinH * beam.length * frac;
        // Small lateral jitter so sparks don't sit perfectly on the centre line.
        const jitter = Math.sin(s * 12.3 + beam.maxLife * 31) * (1 + tier * 1.5);
        const jx = sx + perpX * jitter;
        const jy = sy + perpY * jitter;
        const sparkR = 1.2 + tier * 1.6 + Math.sin(s * 7 + driftPhase * 9) * 0.4;
        const sparkAlpha = alpha * (0.55 + 0.35 * Math.sin(s * 3.1 + driftPhase * 11));
        ctx.fillStyle = `rgba(255, 255, 255, ${sparkAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(jx, jy, sparkR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Endpoint flash — far tip of the beam blooms outward, strongest on big shots.
    if (beam.damage >= 2) {
      const tipR = (6 + beam.damage * 4) * (0.6 + (1 - ageFrac) * 0.7);
      const tipGrad = ctx.createRadialGradient(ex, ey, 0, ex, ey, tipR);
      tipGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.6 * alpha * tier).toFixed(3)})`);
      tipGrad.addColorStop(1, "rgba(140, 220, 255, 0)");
      ctx.fillStyle = tipGrad;
      ctx.beginPath();
      ctx.arc(ex, ey, tipR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
};
