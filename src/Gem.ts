import { Vec, v, rand, pick, TAU, addScaledMut, scaleMut, sub, mul, len, fromAngle, circleHit, wrapMut } from "./vec";
import { Canister, POWERUP_KINDS } from "./Canister";
import { ENTITY_CONFIG } from "./game/entityConfig";
import { OCTAHEDRON_EDGES, projectOctahedron } from "./octahedron";

// Re-exports so existing imports (collisions.ts, etc.) keep working — the
// authoritative numbers live in entityConfig.
export const GEM_UPGRADE_CHANCE = ENTITY_CONFIG.asteroidWithGem.upgradeChance;
export const GEM_REVEAL_SCORE = ENTITY_CONFIG.asteroidWithGem.revealScore;

// A standalone collectible left behind by a "asteroidWithGem" asteroid's death.
// The asteroid's blurred interior was the visual tease — this is the payoff,
// a sharply-rendered six-sided gold gem that drifts where the rock died until
// the player flies through it. Slow drift inherits a fraction of the parent
// asteroid's velocity so the gem reads as "ejected from the explosion", not
// "teleported in". After a long lifetime it dims and warps out.

export const GEM_SCORE = ENTITY_CONFIG.asteroidWithGem.pickupScore;

const LIFETIME = ENTITY_CONFIG.asteroidWithGem.lifetime;
// final fraction of life spent fading + flickering as a warp-out warning.
const FADE_TAIL = LIFETIME * 0.22;

export class Gem {
  pos: Vec;
  vel: Vec;
  hue: number;
  // Pickup radius. A touch larger than the visible gem so the player doesn't
  // feel cheated when the ship clips a corner.
  radius = ENTITY_CONFIG.asteroidWithGem.radius;
  age = 0;
  alive = true;
  // Fast-flung gems (the fan a burstGem bursts into) keep their launch velocity
  // and wrap at the screen edge instead of decaying to a near-stop, so they read
  // as blades thrown across the field rather than a quietly settling drop.
  fast = false;
  // Optional drift-to-park: rhythm-aligned gems fly from the crystal's death
  // site to a solved spot on the player's one-beat aim ring, arriving exactly
  // when `parkAge` is reached, then freeze. `parkTarget` null = free drift.
  parkTarget: Vec | null = null;
  parkAge = 0;
  private parkOrigin: Vec | null = null;
  // 3D-ish tumble axes mirror the canister so the gem reads as a real
  // rotating object rather than a flat icon.
  rotX: number;
  rotY: number;
  rotZ: number;
  rotSpeedX: number;
  rotSpeedY: number;
  rotSpeedZ: number;

  constructor(pos: Vec, vel: Vec) {
    this.pos = pos;
    this.vel = vel;
    this.hue = 46;
    this.rotX = rand(0, TAU);
    this.rotY = rand(0, TAU);
    this.rotZ = rand(0, TAU);
    this.rotSpeedX = rand(-1.6, 1.6);
    this.rotSpeedY = rand(-1.6, 1.6);
    this.rotSpeedZ = rand(-1.0, 1.0);
  }

  // Glide this gem from its current spot to `target`, arriving at age `arriveAge`
  // and parking there. Used by the rhythm-aligned drop so the gem lands on the
  // player's one-beat aim ring right on the downbeat.
  driftToPark(target: Vec, arriveAge: number) {
    this.parkOrigin = { ...this.pos };
    this.parkTarget = { ...target };
    this.parkAge = arriveAge;
  }

  update(dt: number, w: number, h: number) {
    this.age += dt;
    this.rotX += this.rotSpeedX * dt;
    this.rotY += this.rotSpeedY * dt;
    this.rotZ += this.rotSpeedZ * dt;
    if (this.parkTarget && this.parkOrigin) {
      // Smoothstep glide from the death site to the solved aim-ring spot over
      // one beat, then hold. Eased so the gem decelerates into its park.
      const t = this.parkAge > 0 ? Math.min(1, this.age / this.parkAge) : 1;
      const e = t * t * (3 - 2 * t);
      this.pos.x = this.parkOrigin.x + (this.parkTarget.x - this.parkOrigin.x) * e;
      this.pos.y = this.parkOrigin.y + (this.parkTarget.y - this.parkOrigin.y) * e;
    } else if (this.fast) {
      // Flung blade: hold velocity and wrap, so the gem keeps crossing the
      // field as a live rhythm target until its lifetime expires.
      addScaledMut(this.pos, this.vel, dt);
      wrapMut(this.pos, w, h);
    } else {
      // Gentle drift; the gem isn't supposed to chase or flee, it just floats
      // where the rock died.
      addScaledMut(this.pos, this.vel, dt);
      // Slow the drift over time so it eventually settles near its origin.
      scaleMut(this.vel, Math.max(0, 1 - dt * 0.6));
    }
    if (this.age >= LIFETIME) this.alive = false;
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    return circleHit(this.pos, this.radius, point, pointRadius);
  }

  // Tail-end fade + quickening flicker warning the gem is about to warp out.
  private fadeAlpha(time: number): number {
    const remaining = LIFETIME - this.age;
    if (remaining >= FADE_TAIL) return 1;
    const tail = Math.max(0, remaining / FADE_TAIL);
    // flicker speeds up as tail → 0 so the urgency reads even while still bright.
    const flicker = 0.7 + 0.3 * Math.sin(time * (8 + (1 - tail) * 22));
    return tail * flicker;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    const time = t * 0.001;
    const fade = this.fadeAlpha(time);
    const pulse = 0.78 + 0.22 * Math.sin(time * 2.4 + this.age * 1.7);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Soft halo so the gem reads from a distance without overwhelming the
    // playfield. Wider than the gem itself so the eye picks it up in
    // peripheral vision.
    const haloRadius = this.radius * 3.4;
    const halo = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, haloRadius);
    halo.addColorStop(0, `hsla(${this.hue}, 95%, 65%, ${0.45 * pulse * fade})`);
    halo.addColorStop(0.5, `hsla(${this.hue - 6}, 90%, 55%, ${0.15 * pulse * fade})`);
    halo.addColorStop(1, `hsla(${this.hue}, 90%, 55%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, haloRadius, 0, TAU);
    ctx.fill();

    // 3D octahedron wireframe matching the canister approach (familiar
    // structure for the player's eye) but tinted gold and slightly larger
    // so the gem reads as "more important than a pod".
    const r = this.radius * 1.15;
    const projected = projectOctahedron(this.rotX, this.rotY, this.rotZ, r);

    ctx.translate(this.pos.x, this.pos.y);

    // Solid gold facets first (filled triangles from each pole to each
    // equator vertex), then bright wireframe over the top. Filling the
    // facets is what makes the gem read as a *gem* and not a wireframe pod.
    const equator = [2, 3, 4, 5];
    const poles = [0, 1];
    const facetFill = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.1);
    facetFill.addColorStop(0, `hsla(${this.hue + 10}, 100%, 78%, ${0.55 * fade})`);
    facetFill.addColorStop(0.6, `hsla(${this.hue}, 95%, 55%, ${0.4 * fade})`);
    facetFill.addColorStop(1, `hsla(${this.hue - 10}, 90%, 40%, ${0.18 * fade})`);
    ctx.fillStyle = facetFill;
    for (const poleIdx of poles) {
      for (let e = 0; e < equator.length; e++) {
        const a = projected[poleIdx];
        const b = projected[equator[e]];
        const c = projected[equator[(e + 1) % equator.length]];
        // Backface cull via average z: facets facing away dim.
        const avgZ = (a.z + b.z + c.z) / 3;
        if (avgZ < -r * 0.4) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Wireframe edges over the facets — same octahedron as the canister so
    // the tumble reads consistently across both kinds of pickup.
    ctx.lineWidth = 1.5;
    for (const [a, b] of OCTAHEDRON_EDGES) {
      const va = projected[a];
      const vb = projected[b];
      const depth = (va.z + vb.z) * 0.5;
      const depthAlpha = 0.55 + 0.45 * ((depth + r) / (2 * r));
      ctx.strokeStyle = `hsla(${this.hue + 20}, 100%, 82%, ${(0.95 * pulse * depthAlpha * fade).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(va.x, va.y);
      ctx.lineTo(vb.x, vb.y);
      ctx.stroke();
    }

    ctx.restore();
  }
}

// Spawn a gold crystal at the dead asteroid's position, inheriting a small
// fraction of its parent velocity so the gem drifts naturally with the burst
// rather than freezing in space.
export const spawnGemAt = (pos: Vec, parentVel: Vec): Gem => {
  // a fraction of parent velocity + small random jitter reads as "the
  // explosion ejected it" without sending it flying out of reach. Jitter is
  // small so the gem stays predictably near the kill site.
  const drift = v(parentVel.x * 0.25 + rand(-18, 18), parentVel.y * 0.25 + rand(-18, 18));
  return new Gem({ ...pos }, drift);
};

// A burstGem's death: fan `count` fast-flying gems out in an even ring, rotated
// half a step off the killing-shot axis so none flies straight back down the
// return line (the bullet came IN along impactDir). Each is a real Gem — fly
// into one and you die, shoot it on-beat for points/an upgrade — that simply
// keeps its launch speed and wraps the field instead of settling in place.
export const spawnBurstGemFan = (
  deathPos: Vec,
  parentVel: Vec,
  impactDir: Vec | null,
  count: number,
  speed: number,
  ejectDist: number,
): Gem[] => {
  const baseAngle = impactDir
    ? Math.atan2(impactDir.y, impactDir.x)
    : Math.atan2(parentVel.y, parentVel.x);
  const fan: Gem[] = [];
  for (let i = 0; i < count; i++) {
    const angle = baseAngle + Math.PI / count + (i / count) * TAU;
    const dir = fromAngle(angle);
    const pos = v(deathPos.x + dir.x * ejectDist, deathPos.y + dir.y * ejectDist);
    // Inherit a touch of the gem's drift so the fan travels with it rather than
    // expanding from a dead-still centre.
    const vel = v(parentVel.x * 0.3 + dir.x * speed, parentVel.y * 0.3 + dir.y * speed);
    const gem = new Gem(pos, vel);
    gem.fast = true;
    fan.push(gem);
  }
  return fan;
};

// A gem swarm: a flock of bare gems streaking across the field the same way a
// meteor shower does — shared heading, spread across the entry edge, staggered
// diagonally so they trail rather than arrive as a wall. Each is a live rhythm
// target (fly in → die; shoot on-beat → points or an upgrade): a brief, dense
// "comb through them" window. They fly fast and wrap, so they keep crossing
// until shot or expired. Velocities are aligned to the beat by the caller.
const GEM_SWARM_SPEED = 165; // brisk single-screen-width sweep, pre-rhythm-mul
export const spawnGemSwarm = (w: number, h: number, count: number): Gem[] => {
  const edge = Math.floor(rand(0, 4));
  const offset = 120;
  let origin: Vec;
  if (edge === 0) origin = v(-offset, rand(h * 0.15, h * 0.85));
  else if (edge === 1) origin = v(w + offset, rand(h * 0.15, h * 0.85));
  else if (edge === 2) origin = v(rand(w * 0.15, w * 0.85), -offset);
  else origin = v(rand(w * 0.15, w * 0.85), h + offset);

  const target = v(rand(w * 0.3, w * 0.7), rand(h * 0.3, h * 0.7));
  const angle = Math.atan2(target.y - origin.y, target.x - origin.x);
  const along = fromAngle(angle, 1);
  const perp = v(-along.y, along.x);

  const gems: Gem[] = [];
  for (let i = 0; i < count; i++) {
    // Spread across the perpendicular (centred on origin) and stagger back
    // along the heading so later gems trail the leaders.
    const spread = (i - (count - 1) / 2) * rand(48, 78);
    const lag = i * rand(50, 110);
    const pos = v(
      origin.x + perp.x * spread - along.x * lag,
      origin.y + perp.y * spread - along.y * lag,
    );
    const gem = new Gem(pos, fromAngle(angle, GEM_SWARM_SPEED));
    gem.fast = true;
    gems.push(gem);
  }
  return gems;
};

// Drop a fan of gems at the crystal's death site, then drift each one out to a
// solved spot on the player's one-beat aim ring so that — if the pilot keeps
// coasting and just rotates — the reticule lines up on one of them exactly one
// beat from now. The lead gem sits on the radial line from the player through
// the death site (so it reads as drifting straight toward or away from the
// ship); the rest fan slightly around it as nearby alternates.
//
// Geometry mirrors computeAimCircle evaluated one beat in the future, when the
// coasting ship sits at shipPos + shipVel*beat:
//   center = shipPos + shipVel*beat + shipVel*0.4*beat = shipPos + shipVel*1.4*beat
//   radius = shipRadius + 4 + bulletSpeed*beat
// A gem placed on that circle is reachable by a one-beat shot from the ship's
// future pose, so rotating to aim drops the reticule right onto it.
export const spawnRhythmAlignedGems = (
  shipPos: Vec,
  shipVel: Vec,
  shipHeading: number,
  deathPos: Vec,
  count: number,
  bulletSpeed: number,
  beatGrid: number,
  shipRadius: number,
): Gem[] => {
  const center = v(
    shipPos.x + shipVel.x * 1.4 * beatGrid,
    shipPos.y + shipVel.y * 1.4 * beatGrid,
  );
  const aimRadius = shipRadius + 4 + bulletSpeed * beatGrid;
  // aim outward from the future aim-circle center toward the kill site so the
  // lead gem drifts along the player→death line; fall back to ship facing when
  // the rock died on top of that center.
  const toDeath = sub(deathPos, center);
  const baseDist = len(toDeath);
  const baseAngle = baseDist > 1 ? Math.atan2(toDeath.y, toDeath.x) : shipHeading;
  // small fan so gems read as distinct targets, not a single column.
  const SPREAD_PER_GEM = 0.11;
  const startOffset = -((count - 1) * SPREAD_PER_GEM) / 2;
  const gems: Gem[] = [];
  for (let k = 0; k < count; k++) {
    const angle = baseAngle + startOffset + k * SPREAD_PER_GEM;
    const dir = fromAngle(angle);
    const target = v(center.x + dir.x * aimRadius, center.y + dir.y * aimRadius);
    const gem = new Gem({ ...deathPos }, v(0, 0));
    gem.driftToPark(target, beatGrid);
    gems.push(gem);
  }
  return gems;
};

// Drop a fresh powerup canister where the gem was. Aims at a random point on
// the far side of the playfield and uses the standard canister drift speed so
// the freed canister flies across the screen and eventually warps out just
// like a normally-spawned canister — the player has to chase it.
export const spawnCanisterFromGem = (g: Gem, w: number, h: number): Canister => {
  const kind = pick(POWERUP_KINDS);
  const aim = v(rand(80, w - 80), rand(80, h - 80));
  const delta = sub(aim, g.pos);
  const fullDist = len(delta) || 1;
  const dir = mul(delta, 1 / fullDist);
  // Slower drift + longer path budget than a standard canister so freed
  // upgrades hang around long enough for the player to actually chase them
  // down — the gem already cost work to crack, so the reward shouldn't warp
  // out before they can react.
  const driftSpeed = rand(45, 80);
  const pathLength = fullDist * rand(1.1, 1.5);
  return new Canister({ ...g.pos }, mul(dir, driftSpeed), kind, pathLength);
};
