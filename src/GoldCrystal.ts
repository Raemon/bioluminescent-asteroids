import { Vec, v, rand, pick, TAU, addScaledMut, scaleMut, sub, mul, len, fromAngle } from "./vec";
import { Canister, POWERUP_KINDS } from "./Canister";
import { ENTITY_CONFIG } from "./game/entityConfig";

// Re-exports so existing imports (collisions.ts, etc.) keep working — the
// authoritative numbers live in entityConfig.
export const GOLD_CRYSTAL_UPGRADE_CHANCE = ENTITY_CONFIG.goldCrystal.upgradeChance;
export const GOLD_CRYSTAL_REVEAL_SCORE = ENTITY_CONFIG.goldCrystal.revealScore;

// A standalone collectible left behind by a "goldCrystal" asteroid's death.
// The asteroid's blurred interior was the visual tease — this is the payoff,
// a sharply-rendered six-sided gold gem that drifts where the rock died until
// the player flies through it. Slow drift inherits a fraction of the parent
// asteroid's velocity so the gem reads as "ejected from the explosion", not
// "teleported in". After a long lifetime it dims and warps out.

export const GOLD_CRYSTAL_SCORE = ENTITY_CONFIG.goldCrystal.pickupScore;

const LIFETIME = ENTITY_CONFIG.goldCrystal.lifetime;
// gem explodes at full brightness when LIFETIME runs out, so no fade tail.
const FADE_TAIL = 0;

export class GoldCrystal {
  pos: Vec;
  vel: Vec;
  hue: number;
  // Pickup radius. A touch larger than the visible gem so the player doesn't
  // feel cheated when the ship clips a corner.
  radius = ENTITY_CONFIG.goldCrystal.radius;
  age = 0;
  alive = true;
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

  update(dt: number, _w: number, _h: number) {
    this.age += dt;
    this.rotX += this.rotSpeedX * dt;
    this.rotY += this.rotSpeedY * dt;
    this.rotZ += this.rotSpeedZ * dt;
    // Gentle drift; the gem isn't supposed to chase or flee, it just floats
    // where the rock died.
    addScaledMut(this.pos, this.vel, dt);
    // Slow the drift over time so it eventually settles near its origin.
    scaleMut(this.vel, Math.max(0, 1 - dt * 0.6));
    if (this.age >= LIFETIME) this.alive = false;
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    const dx = point.x - this.pos.x;
    const dy = point.y - this.pos.y;
    return Math.hypot(dx, dy) < this.radius + pointRadius;
  }

  // Tail-end fade so the player gets a visual warning the gem is about to vanish.
  private fadeAlpha(): number {
    const remaining = LIFETIME - this.age;
    if (remaining >= FADE_TAIL) return 1;
    return Math.max(0, remaining / FADE_TAIL);
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    const time = t * 0.001;
    const fade = this.fadeAlpha();
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
    const verts: [number, number, number][] = [
      [r, 0, 0],
      [-r, 0, 0],
      [0, r, 0],
      [0, -r, 0],
      [0, 0, r],
      [0, 0, -r],
    ];
    const cx = Math.cos(this.rotX), sx = Math.sin(this.rotX);
    const cy = Math.cos(this.rotY), sy = Math.sin(this.rotY);
    const cz = Math.cos(this.rotZ), sz = Math.sin(this.rotZ);
    const projected = verts.map(([x, y, z]) => {
      let y1 = y * cx - z * sx;
      let z1 = y * sx + z * cx;
      let x2 = x * cy + z1 * sy;
      let z2 = -x * sy + z1 * cy;
      let x3 = x2 * cz - y1 * sz;
      let y3 = x2 * sz + y1 * cz;
      return { x: x3, y: y3, z: z2 };
    });

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

    // Wireframe edges — same 12 edges as the canister so the tumble reads
    // consistently across both kinds of pickup.
    const edges: [number, number][] = [
      [0, 2], [0, 3], [0, 4], [0, 5],
      [1, 2], [1, 3], [1, 4], [1, 5],
      [2, 4], [2, 5], [3, 4], [3, 5],
    ];
    ctx.lineWidth = 1.5;
    ctx.shadowColor = `hsla(${this.hue + 18}, 100%, 70%, 1)`;
    ctx.shadowBlur = 10;
    for (const [a, b] of edges) {
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
    ctx.shadowBlur = 0;

    ctx.restore();
  }
}

// Spawn a gold crystal at the dead asteroid's position, inheriting a small
// fraction of its parent velocity so the gem drifts naturally with the burst
// rather than freezing in space.
export const spawnGoldCrystalAt = (pos: Vec, parentVel: Vec): GoldCrystal => {
  // a fraction of parent velocity + small random jitter reads as "the
  // explosion ejected it" without sending it flying out of reach. Jitter is
  // small so the gem stays predictably near the kill site.
  const drift = v(parentVel.x * 0.25 + rand(-18, 18), parentVel.y * 0.25 + rand(-18, 18));
  return new GoldCrystal({ ...pos }, drift);
};

// Spawn a fan of gems aligned to the next N beat-slots from the player's
// vantage. Gem k sits where a bullet fired (k+1) beats from now lands one
// beat later, assuming the player keeps coasting and only rotates to aim.
// Aim circle used by the reticule system: center = shipPos + shipVel*0.4*beat,
// radius = bulletSpeed*beat. k beats of pre-fire drift add shipVel*k*beat,
// so gem k = shipPos + shipVel*(k+1+0.4)*beat + dir_k*bulletSpeed*beat.
// Drift is zero so the gem stays parked at the solved slot.
export const spawnRhythmAlignedGems = (
  shipPos: Vec,
  shipVel: Vec,
  shipHeading: number,
  deathPos: Vec,
  count: number,
  bulletSpeed: number,
  beatGrid: number,
): GoldCrystal[] => {
  const toDeath = sub(deathPos, shipPos);
  const baseDist = len(toDeath);
  // aim outward from the ship toward the kill site; fall back to facing
  // when the rock died on top of the player.
  const baseAngle = baseDist > 1 ? Math.atan2(toDeath.y, toDeath.x) : shipHeading;
  // small fan so gems read as distinct targets, not a single column.
  const SPREAD_PER_GEM = 0.11;
  const startOffset = -((count - 1) * SPREAD_PER_GEM) / 2;
  const aimRadius = bulletSpeed * beatGrid;
  const gems: GoldCrystal[] = [];
  for (let k = 0; k < count; k++) {
    const angle = baseAngle + startOffset + k * SPREAD_PER_GEM;
    const dir = fromAngle(angle);
    const driftBeats = (k + 1 + 0.4) * beatGrid;
    const gemPos = v(
      shipPos.x + shipVel.x * driftBeats + dir.x * aimRadius,
      shipPos.y + shipVel.y * driftBeats + dir.y * aimRadius,
    );
    gems.push(new GoldCrystal(gemPos, v(0, 0)));
  }
  return gems;
};

// Drop a fresh powerup canister where the gem was. Aims at a random point on
// the far side of the playfield and uses the standard canister drift speed so
// the freed canister flies across the screen and eventually warps out just
// like a normally-spawned canister — the player has to chase it.
export const spawnCanisterFromGoldCrystal = (g: GoldCrystal, w: number, h: number): Canister => {
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
