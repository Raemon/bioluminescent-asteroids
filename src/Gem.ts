import { Vec, v, rand, pick, TAU, addScaledMut, scaleMut, sub, mul, len, fromAngle, circleHit, wrapMut } from "./vec";
import { Canister, POWERUP_KINDS } from "./Canister";
import { ENTITY_CONFIG } from "./game/entityConfig";
import { cosmeticRng } from "./game/rng";

// Sprite-shaping jitter draws from the COSMETIC stream — buildSprite runs lazily
// inside render(), so pulling from the gameplay rng there would desync replays.
const crand = (min: number, max: number) => min + cosmeticRng() * (max - min);

// Re-exports so existing imports (collisions.ts, etc.) keep working — the
// authoritative numbers live in entityConfig.
export const GEM_UPGRADE_CHANCE = ENTITY_CONFIG.asteroidWithGem.upgradeChance;
export const GEM_REVEAL_SCORE = ENTITY_CONFIG.asteroidWithGem.revealScore;

// A standalone target left behind by a "asteroidWithGem" asteroid's death — a
// chunk of gold-bearing ore: a lumpy stone with raw gold veins and nuggets
// shot through it, NOT a clean cut gem you'd obviously scoop up. It's a rhythm
// target (shoot on-beat to crack it open), so it deliberately reads as "rock
// with treasure inside" rather than "free pickup". It drifts where the rock
// died, inheriting a fraction of the parent's velocity so it reads as "ejected
// from the explosion", then dims and warps out after a long lifetime.

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
  // Lazy slow tumble, like an asteroid chunk — the ore body is a prebaked sprite
  // (built once on first render) and this just spins it in 2D.
  rot: number;
  rotSpeed: number;
  // Prebaked ore-rock sprite + its half-extent (radius incl. a little glow pad).
  private sprite: HTMLCanvasElement | null = null;
  private spriteHalf = 0;

  constructor(pos: Vec, vel: Vec) {
    this.pos = pos;
    this.vel = vel;
    this.hue = 46;
    this.rot = crand(0, TAU);
    this.rotSpeed = crand(-0.7, 0.7);
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
    this.rot += this.rotSpeed * dt;
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
    if (!this.sprite) this.buildSprite();
    const time = t * 0.001;
    const fade = this.fadeAlpha(time);
    // gold veins catch the light as the rock turns — a slow, low-contrast
    // glint so the ore reads as "valuable" without flashing like a pickup pod.
    const glint = 0.5 + 0.5 * Math.sin(time * 1.6 + this.age * 0.9);

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rot);

    // The lit ore body (stone + baked gold veins) — solid, not additive.
    ctx.globalAlpha = fade;
    ctx.drawImage(this.sprite!, -this.spriteHalf, -this.spriteHalf);
    ctx.globalAlpha = 1;

    // A faint additive ore-glint over the veins only, keyed to the same baked
    // sprite so the gold seams shimmer in place rather than the whole rock
    // glowing — kept low-alpha so it never reads as a pickup halo.
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.22 * glint * fade;
    ctx.drawImage(this.veinSprite!, -this.spriteHalf, -this.spriteHalf);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // Veins-only sprite (gold seams on transparent), reused as the additive glint
  // overlay so the shimmer lands exactly on the ore and nowhere else.
  private veinSprite: HTMLCanvasElement | null = null;

  // Prebake the ore rock once: a lumpy harmonic-noise stone with an offset
  // upper-left light, a dark/bright two-stroke rim, and raw gold veins + nuggets
  // shot through a clipped interior. Static appearance → drawn once, then just
  // rotated/faded per frame (no per-frame gradients).
  private buildSprite() {
    const H = this.hue;
    const r = this.radius * 1.25; // body extent in the sprite, incl. lumps
    const pad = 4;
    const half = r + pad;
    const size = Math.ceil(half * 2);
    this.spriteHalf = half;

    // Deterministic-enough lumpy outline (sampled at draw time, baked once).
    const harmonics = [
      { freq: 2, amp: crand(0.1, 0.18), phase: crand(0, TAU) },
      { freq: 3, amp: crand(0.06, 0.12), phase: crand(0, TAU) },
      { freq: 5, amp: crand(0.04, 0.08), phase: crand(0, TAU) },
      { freq: 7, amp: crand(0.02, 0.05), phase: crand(0, TAU) },
    ];
    const radiusAt = (ang: number) => {
      let m = 1;
      for (const h of harmonics) m += h.amp * Math.cos(ang * h.freq + h.phase);
      return this.radius * Math.max(0.7, Math.min(1.3, m));
    };
    const SAMPLES = 36;
    const rimPath = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      for (let i = 0; i <= SAMPLES; i++) {
        const ang = (i / SAMPLES) * TAU;
        const rr = radiusAt(ang);
        const x = Math.cos(ang) * rr;
        const y = Math.sin(ang) * rr;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath();
    };

    this.sprite = this.paintBody(size, half, H, rimPath, harmonics);
    this.veinSprite = this.paintVeins(size, half, H, rimPath, harmonics);
  }

  // Stone body + clipped interior detail + gold ore + two-stroke rim.
  private paintBody(
    size: number, half: number, H: number,
    rimPath: (c: CanvasRenderingContext2D) => void,
    harmonics: Array<{ freq: number; amp: number; phase: number }>,
  ): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const c = cv.getContext("2d")!;
    c.translate(half, half);
    const R = this.radius;

    // Stone body: warm golden-tan ore (halfway between a grey rock and a pure
    // gold gem) with an offset upper-left hot-spot and a deep terminator on the
    // lower-right that drifts cool so the lit side reads as bright metal-bearing
    // stone, not flat dirt.
    const body = c.createRadialGradient(-R * 0.4, -R * 0.45, R * 0.1, 0, 0, R * 1.35);
    body.addColorStop(0, "hsl(44, 52%, 56%)");
    body.addColorStop(0.55, "hsl(38, 44%, 34%)");
    body.addColorStop(1, "hsl(30, 30%, 13%)");
    c.fillStyle = body;
    rimPath(c);
    c.fill();

    // Interior detail clipped to the silhouette: mottled grain + a couple of
    // pits (bright up-left lip, dark down-right floor) to sell the stone.
    c.save();
    rimPath(c);
    c.clip();
    for (let i = 0; i < 10; i++) {
      const ang = harmonics[i % harmonics.length].phase + i * 1.7;
      const d = R * (0.15 + 0.6 * ((i * 0.137) % 1));
      const x = Math.cos(ang) * d, y = Math.sin(ang) * d;
      const blotR = R * (0.12 + 0.1 * ((i * 0.31) % 1));
      const dark = i % 2 === 0;
      const g = c.createRadialGradient(x, y, 0, x, y, blotR);
      g.addColorStop(0, dark ? "hsla(34, 30%, 16%, 0.45)" : "hsla(46, 48%, 66%, 0.42)");
      g.addColorStop(1, "hsla(40, 40%, 34%, 0)");
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, blotR, 0, TAU);
      c.fill();
    }
    // Gold ore: a few raw veins (jagged hairlines) + scattered nuggets, lit
    // from the upper-left so the metal reads as embedded, not painted on.
    this.paintOreInto(c, R, H);
    c.restore();

    // Two-stroke rim: dark outer occlusion contact + thin bright inner catch.
    c.globalCompositeOperation = "source-over";
    c.lineJoin = "round";
    c.lineWidth = 3;
    c.strokeStyle = "hsla(34, 35%, 6%, 0.9)";
    rimPath(c);
    c.stroke();
    c.lineWidth = 1.2;
    c.strokeStyle = "hsla(45, 55%, 70%, 0.75)";
    rimPath(c);
    c.stroke();
    return cv;
  }

  // Paint the gold ore (veins + nuggets) into an already-clipped context.
  // Shared by the body bake and the veins-only glint sprite so they line up.
  private paintOreInto(c: CanvasRenderingContext2D, R: number, H: number) {
    // Veins: jagged seams crossing the rock, each a bright gold core over a
    // slightly darker, wider underlay so the seam has body. A few extra seams
    // (over the original grey-ore look) push it back toward the pure-gem feel
    // it grew out of.
    const veinCount = 4;
    for (let i = 0; i < veinCount; i++) {
      const baseAng = (i / veinCount) * TAU + (i * 0.9);
      const steps = 5;
      const pts: Array<[number, number]> = [];
      let px = Math.cos(baseAng) * R * 0.9;
      let py = Math.sin(baseAng) * R * 0.9;
      const dir = baseAng + Math.PI + ((i % 2) ? 0.5 : -0.5);
      for (let s = 0; s <= steps; s++) {
        pts.push([px, py]);
        const jitter = (s % 2 ? 0.6 : -0.5) * 0.7;
        const a = dir + jitter;
        const step = R * 0.42;
        px += Math.cos(a) * step;
        py += Math.sin(a) * step;
      }
      const drawSeam = (w: number, color: string) => {
        c.lineWidth = w;
        c.lineCap = "round";
        c.lineJoin = "round";
        c.strokeStyle = color;
        c.beginPath();
        for (let s = 0; s < pts.length; s++) {
          if (s === 0) c.moveTo(pts[s][0], pts[s][1]);
          else c.lineTo(pts[s][0], pts[s][1]);
        }
        c.stroke();
      };
      drawSeam(R * 0.26, `hsla(${H - 6}, 80%, 34%, 0.85)`);
      drawSeam(R * 0.13, `hsla(${H + 4}, 98%, 62%, 0.96)`);
      drawSeam(R * 0.05, `hsla(${H + 14}, 100%, 85%, 0.97)`);
    }
    // Nuggets: small gold blobs with an upper-left specular and a darker base.
    const nuggetCount = 7;
    for (let i = 0; i < nuggetCount; i++) {
      const ang = i * 2.3 + 0.6;
      const d = R * (0.2 + 0.55 * ((i * 0.27) % 1));
      const x = Math.cos(ang) * d, y = Math.sin(ang) * d;
      const nr = R * (0.1 + 0.08 * ((i * 0.41) % 1));
      const g = c.createRadialGradient(x - nr * 0.4, y - nr * 0.4, 0, x, y, nr);
      g.addColorStop(0, `hsla(${H + 16}, 100%, 85%, 0.98)`);
      g.addColorStop(0.5, `hsla(${H + 2}, 95%, 58%, 0.95)`);
      g.addColorStop(1, `hsla(${H - 12}, 80%, 30%, 0.9)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, nr, 0, TAU);
      c.fill();
    }
  }

  // Veins-only sprite: same ore on transparent, clipped to the body, used as
  // the subtle additive glint overlay.
  private paintVeins(
    size: number, half: number, H: number,
    rimPath: (c: CanvasRenderingContext2D) => void,
    _harmonics: Array<{ freq: number; amp: number; phase: number }>,
  ): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const c = cv.getContext("2d")!;
    c.translate(half, half);
    c.save();
    rimPath(c);
    c.clip();
    this.paintOreInto(c, this.radius, H);
    c.restore();
    return cv;
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
