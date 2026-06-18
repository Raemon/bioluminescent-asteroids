import type { Game } from "../Game";
import type { Ship } from "../Ship";
import type { Asteroid } from "../Asteroid";
import type { Alien } from "../Alien";
import type { Comet } from "../Comet";
import { Vec, v, fromAngle, add, mul } from "../vec";
import { Bullet } from "../Bullet";
import { BEAT_GRID } from "./rhythmConstants";
import { isDown } from "./controlBindings";
import { isInBeatWindow, loseCombo } from "./rhythmGate";
import { buildJaggedBolt, strokePolyline } from "./bassLightning";
import { drawGlow } from "../glow";
import { rng } from "./rng";
import {
  onAsteroidKilledByBullet,
  onAsteroidCrackedByBullet,
  onAlienKilled,
  onAlienCracked,
  onCometKilled,
} from "./killEffects";
import { explodeCanister, expireGem, crackGemForCanister } from "./collisions";
import type { Gem } from "../Gem";
import type { Canister } from "../Canister";
import { syncHud } from "./hud";

// Absolute charge-dot ceiling (one per beat held). Damage doubles per dot from
// a base of 2, so dots 0..4 deal 2, 4, 8, 16, 32 — a full charge melts large
// rocks and bites deep into a boss core. The dots a player can actually REACH
// is gated by rhythm via maxLaserDots().
export const LASER_MAX_DOTS = 4;

// The rhythm-gated cap on reachable charge dots. Higher combo unlocks deeper
// charge tiers, so a long beam is something rhythm earns.
export const maxLaserDots = (game: Game): number => {
  if (game.beatCombo >= 24) return 4;
  if (game.beatCombo >= 12) return 3;
  if (game.beatCombo >= 4) return 2;
  return 1;
};
// Visible beam stays painted for this many seconds after fire — long enough
// to read as a flash, short enough that another shot a beat later doesn't
// overlap the previous trail.
const LASER_BEAM_LIFE = 0.1;
// The laser deliberately overshoots the reticule slot: bulletSpeed *
// effectiveBulletLife * LASER_BASE_RANGE_MULT, then the pierce/longshot/
// superBoosted multipliers shipWeapons uses stack on top. The base mult is
// further scaled by a per-dot range factor so an uncharged shot is short.
const LASER_BASE_RANGE_MULT = 2;
// Range factor by dot count: a 0-dot shot reaches half the old length, a
// full charge overshoots it.
const LASER_RANGE_BY_DOTS = [0.5, 0.7, 0.85, 1.0, 1.2];
const PIERCE_RANGE_MULT = 2;
const LONGSHOT_RANGE_MULT = 1.5;
const SUPERBOOSTED_RANGE_MULT = 1.5;
// How fast the ambient charge glow eases toward its per-dot target.
const CHARGE_GLOW_RATE = 6;
// Fire flash decays to zero over this many seconds.
export const FIRE_FLASH_DECAY = 0.18;
// Perpendicular jag amplitude (px) for the crackle arcs.
const LASER_JAG_AMPLITUDE = 7;

// Half-width (px) of the beam's hit swath by dot count — a charged beam sweeps
// wider so it catches targets the centre line would miss. The renderer's
// visible core/glow is sized to roughly match this.
const beamHalfWidth = (dots: number): number => dots * 6;

// Flat hit allowance on top of the target surface, mirroring the generosity a
// bullet's hitRadius() gives its collision test. Without it the beam's centre
// line has to thread within a target's nominal radius — small fast targets
// slip clean through the 0-dot beam every time.
const LASER_HIT_PAD = 8;

// A laser beam anchored to the firing ship: its origin (muzzle) and heading
// track the ship each frame while it lives, so as the ship turns or drifts the
// beam sweeps and damages anything it crosses. Each target is hit at most once
// per beam, tracked in `alreadyHit`. Lives LASER_BEAM_LIFE seconds.
export class LaserBeam {
  ship: Ship;
  origin: Vec;
  heading: number;
  length: number;
  life: number;
  maxLife: number;
  damage: number;
  // Charge dots 0..LASER_MAX_DOTS — drives the visual tier ramp (thickness,
  // crackle, aura) so the damage tiers read distinctly.
  dots: number;
  // Stable per-sample perpendicular jag for the crackle arc; wobble animates
  // on top. Empty until dots warrant an arc.
  jags: number[];
  seed: number;
  // Targets already damaged so a sweeping beam doesn't re-hit them each frame.
  // Any laser-affectable entity (see laserTargetGroups) regardless of type.
  alreadyHit: Set<object>;
  // Targets that existed when the beam first fired. The sweep only ever damages
  // these, so things spawned mid-beam (kill-spawned children, freshly-warped
  // enemies) can't be hit as the beam ages — only what was there at fire time.
  eligible: Set<object>;

  constructor(ship: Ship, length: number, damage: number, dots: number, game: Game) {
    this.ship = ship;
    this.heading = ship.heading;
    this.origin = muzzleOf(ship);
    this.length = length;
    this.life = LASER_BEAM_LIFE;
    this.maxLife = LASER_BEAM_LIFE;
    this.damage = damage;
    this.dots = dots;
    this.seed = rng() * Math.PI * 2;
    this.jags = [];
    this.alreadyHit = new Set();
    // Eligibility is captured from every laser-affectable group at fire time, so
    // adding a new damageable entity to laserTargetGroups makes the beam hit it
    // automatically — no per-type wiring here.
    this.eligible = new Set();
    for (const group of laserTargetGroups(game)) {
      for (const target of group.list()) this.eligible.add(target);
    }
    if (dots >= 2) {
      const n = 14;
      for (let i = 0; i < n; i++) this.jags.push((rng() * 2 - 1) * LASER_JAG_AMPLITUDE);
    }
  }

  // Re-anchor to the ship, sweep-damage anything newly crossed, then age out.
  update(dt: number, game: Game) {
    this.heading = this.ship.heading;
    this.origin = muzzleOf(this.ship);
    const dir = fromAngle(this.heading, 1);
    applyBeamDamage(game, this, dir);
    this.life -= dt;
  }

  get alive() {
    return this.life > 0;
  }
}

// Beam origin: the ship's muzzle, a touch ahead of the hull.
const muzzleOf = (ship: Ship): Vec => {
  const dir = fromAngle(ship.heading, 1);
  return add(ship.pos, mul(dir, ship.radius + 4));
};

// Number of dots currently charged (0..maxDots). One dot ticks in per beat
// held; maxDots is the rhythm-gated cap (see maxLaserDots). Public so the
// renderer can paint the dots in front of the ship.
export const laserDotCount = (ship: Ship, beatTime: number, maxDots: number): number => {
  if (!ship.laserChargeActive) return 0;
  const elapsed = Math.max(0, beatTime - ship.laserChargeStartBeatTime);
  return Math.min(maxDots, Math.floor(elapsed / BEAT_GRID));
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

const computeBeamLength = (ship: Ship, superBoosted: boolean, dots: number): number => {
  const dotMult = LASER_RANGE_BY_DOTS[Math.min(dots, LASER_MAX_DOTS)];
  return ship.bulletSpeed * effectiveBulletLife(ship, superBoosted) * LASER_BASE_RANGE_MULT * dotMult;
};

// Eases laserChargeGlow toward target with frame-rate-independent decay.
const approachGlow = (current: number, target: number, dt: number): number => {
  const k = 1 - Math.exp(-CHARGE_GLOW_RATE * Math.max(0, dt));
  return current + (target - current) * k;
};

// Called each frame after Ship.update. The normal fireBullets path is
// suppressed by lasershotActive inside shipPhysics; this owns fire input
// while the upgrade is active.
export const tickLaserShot = (game: Game, dt: number) => {
  const ship = game.ship;
  if (!ship.alive) {
    game.sound.stopLaserCharge();
    game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
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
        game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
        return;
      }
      ship.laserChargeActive = true;
      ship.laserChargeStartBeatTime = game.beatTime;
      ship.laserLastDotIndexFired = -1;
      game.sound.startLaserCharge();
    }
    if (!ship.laserChargeActive) {
      game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
      return;
    }
    // Per-dot charge tick — discrete C-chord pluck accent on each new dot, plus
    // a step-up of the sustained crackle/chord bed so the build is felt.
    const dots = laserDotCount(ship, game.beatTime, maxLaserDots(game));
    if (dots > ship.laserLastDotIndexFired && dots > 0) {
      ship.laserLastDotIndexFired = dots;
      game.sound.playLaserCharge(dots);
      game.sound.setLaserChargeTier(dots);
    }
    // Ambient glow ramps toward 1 as more dots arm; faint even at zero dots.
    const target = (dots + 1) / (LASER_MAX_DOTS + 1);
    game.laserChargeGlow = approachGlow(game.laserChargeGlow, target, dt);
    return;
  }

  // Fire-released: if we were charging, fire the beam.
  if (ship.laserChargeActive) {
    const dots = laserDotCount(ship, game.beatTime, maxLaserDots(game));
    fireLaser(game, ship, dots);
  } else {
    game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
  }
  // Always reset on release so a re-press can try the beat window again.
  game.sound.stopLaserCharge();
  resetLaserCharge(ship);
};

const fireLaser = (game: Game, ship: Ship, dots: number) => {
  const damage = 2 << dots;
  const superBoosted = game.beatCombo >= 12;
  const length = computeBeamLength(ship, superBoosted, dots);
  // A clean on-beat release earns rhythm; an off-beat release spends it. The
  // beam's sweep damage is owned by its per-frame update, not this fire event.
  if (isInBeatWindow(game, game.perceivedBeatTime)) {
    game.beatCombo += 1;
    if (game.beatCombo > game.maxCombo) game.maxCombo = game.beatCombo;
    if (game.beatCombo > game.maxComboThisWave) game.maxComboThisWave = game.beatCombo;
    syncHud(game);
  } else {
    loseCombo(game, ship.pos);
  }
  const beam = new LaserBeam(ship, length, damage, dots, game);
  game.lasers.push(beam);
  game.sound.playLaserShot(damage, dots);
  game.shake = Math.min(game.shake + 0.12 + dots * 0.12, 1.4);
  // Big white pop on release, scaled by charge; the buildup glow ends here.
  game.laserFireFlash = Math.min(1, 0.4 + dots * 0.2);
  game.laserChargeGlow = 0;
};

// A laser-affectable entity. Every damageable/shootable body in the game already
// exposes collidesWith(pos, radius) for the bullet path; the beam swath reuses it
// so the laser hits exactly what a bullet hits, with no per-type collision math.
type LaserTarget = { pos: Vec; collidesWith: (p: Vec, r: number) => boolean };

// One group per laser-affectable entity array. Each owns: the live array (read +
// written through get/set so kill-spawned children replace the original), and an
// onHit that routes a beam strike through the SAME kill-effect pipeline a bullet
// uses. To make the laser hit a new entity type, add a group here — nothing else
// in the sweep changes. This is the single source of truth for "what a laser can
// hit", mirroring how bullets dispatch per-type kill handlers in collisions.ts.
type LaserTargetGroup = {
  list: () => LaserTarget[];
  // Apply one beam strike to `target`. Returns the bodies that should remain in
  // the array afterwards (the target itself if it survived, kill-spawned
  // children if it died and split, or nothing).
  onHit: (game: Game, target: LaserTarget, beam: LaserBeam, dir: Vec, fakeBullet: Bullet) => LaserTarget[];
  set: (game: Game, surviving: LaserTarget[]) => void;
};

const laserTargetGroups = (game: Game): LaserTargetGroup[] => [
  {
    list: () => game.asteroids,
    onHit: (game, target, beam, dir, fakeBullet) => {
      const a = target as Asteroid;
      // The laser is a charged shot — give the boss family the meaty armored
      // impact every time it connects (the fake bullet is deliberately flagless,
      // so the bossHit gate in killEffects won't catch it).
      if (a.isBossFamily()) game.sound.play("bossHit", 1, a.pos);
      const { killed } = a.applyDamage(beam.damage);
      game.shake = Math.min(game.shake + (killed ? 0.3 : 0.15), 1.2);
      if (!killed) {
        a.applyKnockback(dir.x, dir.y, beam.damage);
        onAsteroidCrackedByBullet(game, a, fakeBullet, false);
        return [a];
      }
      return onAsteroidKilledByBullet(game, a, fakeBullet, false);
    },
    set: (game, surviving) => { game.asteroids = surviving as Asteroid[]; },
  },
  {
    list: () => game.aliens,
    onHit: (game, target, beam, dir, fakeBullet) => {
      const al = target as Alien;
      // Aliens take 1 hp per applyDamage; loop so charge tiers chew through HP
      // in a single beam pass instead of needing N separate shots.
      let killed = false;
      for (let i = 0; i < beam.damage; i++) {
        if (al.applyDamage().killed) { killed = true; break; }
      }
      if (killed) {
        onAlienKilled(game, al, fakeBullet, false);
        return [];
      }
      al.applyKnockback(dir.x, dir.y, beam.damage);
      onAlienCracked(game, false, al.pos);
      return [al];
    },
    set: (game, surviving) => { game.aliens = surviving as Alien[]; },
  },
  {
    list: () => game.comets,
    onHit: (game, target, _beam, _dir, fakeBullet) => {
      onCometKilled(game, target as Comet, fakeBullet, false);
      return [];
    },
    set: (game, surviving) => { game.comets = surviving as Comet[]; },
  },
  {
    // Gems crack (yield canister/score) only for a ≥4-damage hit, else they're
    // wasted — same threshold the bullet path applies. The beam already earned
    // its rhythm at charge time, so a charged shot (1+ dots = ≥4 dmg) cracks; a
    // bare 0-dot shot wastes, mirroring an off-beat bullet.
    list: () => game.gems,
    onHit: (game, target, beam) => {
      const g = target as Gem;
      if (beam.damage >= 4) crackGemForCanister(game, g);
      else expireGem(game, g); // wasted-gem feedback, same as an off-beat bullet
      return [];
    },
    set: (game, surviving) => { game.gems = surviving as Gem[]; },
  },
  {
    // Shooting a canister wastes the powerup (white pop), same as a bullet.
    list: () => game.canisters,
    onHit: (game, target) => {
      explodeCanister(game, target as Canister);
      return [];
    },
    set: (game, surviving) => { game.canisters = surviving as Canister[]; },
  },
];

// Sweep-damages every target the beam segment crosses this frame, skipping any
// already hit by this beam. The swath widens with charge (beamHalfWidth). Every
// group routes through the same kill-effect helpers a real bullet would, with a
// synthetic Bullet feeding the impact position into the existing pipeline.
const applyBeamDamage = (game: Game, beam: LaserBeam, dir: Vec) => {
  for (const group of laserTargetGroups(game)) applyBeamToGroup(game, beam, dir, group);
  syncHud(game);
};

// The beam's hit swath: a point is struck if it's within halfWidth + pad of the
// beam segment. We pose that as a circle of that radius riding the beam's closest
// approach to the target, then let the target's own collidesWith decide — so the
// test honours each entity's real hitbox (faceted asteroid surface, tight alien
// body, gem/comet/canister circles) exactly as the bullet path does.
const applyBeamToGroup = (game: Game, beam: LaserBeam, dir: Vec, group: LaserTargetGroup) => {
  const { origin, length } = beam;
  const swathR = beamHalfWidth(beam.dots) + LASER_HIT_PAD;
  const surviving: LaserTarget[] = [];
  for (const target of group.list()) {
    if (beam.alreadyHit.has(target) || !beam.eligible.has(target)) {
      surviving.push(target); continue;
    }
    const t = closestApproach(origin, dir, length, target.pos);
    const closest = v(origin.x + dir.x * t, origin.y + dir.y * t);
    if (!target.collidesWith(closest, swathR)) {
      surviving.push(target); continue;
    }
    beam.alreadyHit.add(target);
    const fakeBullet = makeFakeBullet(closest, dir);
    for (const remaining of group.onHit(game, target, beam, dir, fakeBullet)) {
      surviving.push(remaining);
    }
  }
  group.set(game, surviving);
};

// The t-parameter along the beam (clamped to [0, length]) where the beam passes
// closest to `pos` — the point we test the swath against and use as the impact
// position for kill effects.
const closestApproach = (origin: Vec, dir: Vec, length: number, pos: Vec): number => {
  const tRaw = (pos.x - origin.x) * dir.x + (pos.y - origin.y) * dir.y;
  return Math.max(0, Math.min(length, tRaw));
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

// Small deterministic jag array for a charge crackle arc. Reseeds ~8x/sec via
// a coarse time bucket so the bolt flickers without per-frame randomness.
const CHARGE_ARC_SAMPLES = 8;
const chargeArcJags = (index: number, beatTime: number): number[] => {
  const bucket = Math.floor(beatTime * 8);
  const jags: number[] = [];
  for (let i = 0; i < CHARGE_ARC_SAMPLES; i++) {
    const s = Math.sin((bucket + 1) * 12.9898 + index * 7.13 + i * 78.233) * 43758.5453;
    jags.push(((s - Math.floor(s)) * 2 - 1) * (LASER_JAG_AMPLITUDE * 0.7));
  }
  return jags;
};

// Charge dots float in front of the ship — one per beat charged. Each dot
// pulses on its own beat slot so a freshly-armed dot reads as "just landed".
// Higher-tier dots get extra orbiting sparks + an energy thread connecting
// back to the ship so a full charge reads as visibly "loaded up".
export const renderLaserChargeDots = (
  ctx: CanvasRenderingContext2D, game: Game, beatTime: number,
) => {
  const ship = game.ship;
  if (!ship.lasershotActive) return;
  if (!ship.laserChargeActive) return;
  const dots = laserDotCount(ship, beatTime, maxLaserDots(game));
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

    // Crackle arc — a jagged bolt leaping back from this dot to the previous
    // one (or the muzzle for the first dot), in the bass-lightning dialect.
    // Higher tiers crackle harder; the jag reseeds a few times a second so it
    // flickers without allocating fresh randomness every frame.
    if (i >= 1) {
      const fromX = ship.pos.x + dir.x * (baseOffset + (i - 1) * dotGap);
      const fromY = ship.pos.y + dir.y * (baseOffset + (i - 1) * dotGap);
      const jags = chargeArcJags(i, beatTime);
      const tSec = beatTime * 6;
      const pts = buildJaggedBolt(fromX, fromY, px, py, jags, i * 1.7, tSec, 0);
      const arcA = (0.4 + 0.3 * Math.sin(beatTime * 17 + i)) * tierBoost;
      strokePolyline(ctx, pts, 2.4, `rgba(150, 230, 255, ${(0.22 * arcA).toFixed(3)})`);
      strokePolyline(ctx, pts, 1, `rgba(235, 250, 255, ${(0.6 * arcA).toFixed(3)})`);
      drawGlow(ctx, px, py, r * 1.4, 195, 0.35 * arcA);
      ctx.globalAlpha = 1;
    }

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
    // Charge tier as a 0..1 ramp off the dot count — the damage tiers map to
    // evenly-spaced thickness/effect steps rather than the raw damage, which
    // would saturate and render the top tiers identically.
    const tier = beam.dots / LASER_MAX_DOTS;
    // Width driver scaled so the visible beam roughly fills its hit swath: the
    // gameplay half-width sets the floor, charge thickens it further.
    const w = 1 + beam.dots + beamHalfWidth(beam.dots) * 0.4;

    // A stroke that tapers to nothing over the far end of the beam, so the tip
    // dissolves instead of stopping flat.
    const fadingStroke = (rgb: string, peak: number, width: number) => {
      const grad = ctx.createLinearGradient(beam.origin.x, beam.origin.y, ex, ey);
      grad.addColorStop(0, `rgba(${rgb}, ${peak.toFixed(3)})`);
      grad.addColorStop(0.6, `rgba(${rgb}, ${(peak * 0.7).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(beam.origin.x, beam.origin.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    };

    // Outermost diffuse aura — very wide, very soft. Only meaningful at higher
    // tiers; gives a charged shot a "this beam is bending the air" presence.
    if (beam.dots >= 1) {
      fadingStroke("140, 200, 255", 0.12 * alpha * tier, 22 + w * 7);
    }
    // Outer glow — wide, soft, cyan-tinged. Wider at higher tiers.
    fadingStroke("120, 220, 255", 0.28 * alpha, 12 + w * 4);
    // Mid layer — brighter, narrower.
    fadingStroke("180, 240, 255", 0.55 * alpha, 5 + w * 1.8);
    // Core — near-white, hot.
    fadingStroke("255, 255, 255", alpha, 2.2 + w * 0.7);
    // Hot white-blue inner sliver — only on high-charge shots, sells the heat.
    if (beam.dots >= 2) {
      fadingStroke("255, 255, 255", alpha * 0.85, 1 + tier * 1.2);
    }

    // Crackle arcs — jagged offshoots branching off the core, in the same
    // oscilloscope dialect as bass lightning. Only on high-charge shots.
    if (beam.dots >= 2 && beam.jags.length > 0) {
      const tSec = (1 - t) * 6 + beam.seed;
      const pts = buildJaggedBolt(
        beam.origin.x, beam.origin.y, ex, ey, beam.jags, beam.seed, tSec, 6,
      );
      strokePolyline(ctx, pts, 3 + tier * 2, `rgba(150, 230, 255, ${(0.18 * alpha).toFixed(3)})`);
      strokePolyline(ctx, pts, 1.2, `rgba(230, 250, 255, ${(0.6 * alpha).toFixed(3)})`);
    }

    // Muzzle burst — bright circular flash at the origin, dims fast over life.
    const burstAlpha = (1 - ageFrac) * alpha;
    const burstR = (8 + w * 5) * (0.6 + (1 - ageFrac) * 0.8);
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
    // forward over the beam's life. Density + size scale with tier.
    if (beam.dots >= 1) {
      const sparkCount = 4 + beam.dots * 4;
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

    // Endpoint glow — far tip dissolves rather than blooming, so the faded
    // beam end doesn't pick up a hard bright cap.
    if (beam.dots >= 1) {
      const tipR = (6 + w * 4) * (0.6 + (1 - ageFrac) * 0.7);
      const tipGrad = ctx.createRadialGradient(ex, ey, 0, ex, ey, tipR);
      tipGrad.addColorStop(0, `rgba(200, 240, 255, ${(0.22 * alpha * tier).toFixed(3)})`);
      tipGrad.addColorStop(1, "rgba(140, 220, 255, 0)");
      ctx.fillStyle = tipGrad;
      ctx.beginPath();
      ctx.arc(ex, ey, tipR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
};

// Full-screen additive wash — the room lighting up from the beam. Charge
// buildup adds a faint cyan glow that grows while holding; the fire flash
// pops bright on release and decays fast. Drawn above the entity layers.
export const renderLaserAmbientFlash = (ctx: CanvasRenderingContext2D, game: Game) => {
  const a = game.laserChargeGlow * 0.06 + game.laserFireFlash * 0.22;
  if (a <= 0.001) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = `rgba(150, 220, 255, ${a.toFixed(3)})`;
  ctx.fillRect(0, 0, game.w, game.h);
  ctx.restore();
};
