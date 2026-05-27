import { Vec, v, add, mul, fromAngle, wrap, rand, TAU } from "./vec";
import { AlienBullet } from "./AlienBullet";
import { Trail } from "./Trail";

// Three sizes, each with its own role in the rhythm:
//   "big"    : 4 HP, fires every other beat (every 2× BEAT_GRID).
//              Uses the same multi-hit pipeline as bassteroids — each hit
//              decrements hp by 1, the killing hit explodes it.
//   "medium" : 2 HP, fires every beat (BEAT_GRID).
//   "small"  : 1 HP, fires every half-beat (BEAT_GRID/2).
//
// Aliens drift across the field on a slow lazy weave. They're not aiming for
// the player directly — they shoot toward the player's current position when
// the beat lands, so the player can dodge by moving.
export type AlienSize = "big" | "medium" | "small";

const SIZE_RADIUS: Record<AlienSize, number> = {
  big: 38,
  medium: 24,
  small: 16,
};

const SIZE_HP: Record<AlienSize, number> = {
  big: 4,
  medium: 2,
  small: 1,
};

const SIZE_SCORE: Record<AlienSize, number> = {
  big: 400,
  medium: 220,
  small: 130,
};

const SIZE_SPEED: Record<AlienSize, [number, number]> = {
  big: [50, 80],
  medium: [70, 110],
  small: [95, 140],
};

const SIZE_BULLET_SPEED: Record<AlienSize, number> = {
  big: 220,
  medium: 280,
  small: 340,
};

const SIZE_HUE: Record<AlienSize, number> = {
  // Greenish for big (heavy), cyan-violet for medium, magenta for small —
  // a cool spectrum that reads as "not asteroid" against the warmer
  // bassteroid palette.
  big: 130,
  medium: 270,
  small: 320,
};

// Per-size firing cadence in BEAT_GRID units. Game multiplies by BEAT_GRID
// to get seconds and aligns to the global beat clock so alien shots fall
// exactly on the rhythm grid the player is already listening to.
export const ALIEN_FIRE_PERIOD_BEATS: Record<AlienSize, number> = {
  big: 2,
  medium: 1,
  small: 0.5,
};

type AlienCrack = {
  pos: Vec;
  angle: number;
  branches: { points: Vec[] }[];
};

const rollAlienCracks = (count: number): AlienCrack[] => {
  const cracks: AlienCrack[] = [];
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU);
    const r = rand(0.18, 0.7);
    const forkCount = 3 + Math.floor(Math.random() * 2);
    const branches: { points: Vec[] }[] = [];
    for (let f = 0; f < forkCount; f++) {
      const baseAngle = (f / forkCount) * TAU + rand(-0.4, 0.4);
      const segments = 3 + Math.floor(Math.random() * 2);
      const points: Vec[] = [v(0, 0)];
      let cx = 0;
      let cy = 0;
      let ang = baseAngle;
      for (let s = 0; s < segments; s++) {
        const len = rand(0.12, 0.22);
        ang += rand(-0.7, 0.7);
        cx += Math.cos(ang) * len;
        cy += Math.sin(ang) * len;
        points.push(v(cx, cy));
      }
      branches.push({ points });
    }
    cracks.push({ pos: v(Math.cos(a) * r, Math.sin(a) * r), angle: rand(0, TAU), branches });
  }
  return cracks;
};

export class Alien {
  pos: Vec;
  vel: Vec;
  size: AlienSize;
  radius: number;
  hue: number;
  hp: number;
  maxHp: number;
  cracks: AlienCrack[];
  // Game-time at which to fire the next bullet. Set on spawn (aligned to the
  // global beat grid) and advanced by the per-size period after each shot.
  nextFireAt = 0;
  // Pulsing tells the player a beat is coming. Set to 1.0 each fire, decays.
  fireFlash = 0;
  flashAmount = 0;
  // Lazy oscillation that gives aliens a hovering "drifting around" feel
  // rather than a straight line.
  weavePhase: number;
  weaveSpeed: number;
  // Slowly rotates the ship-body relative to its travel direction. Purely
  // cosmetic so the silhouette doesn't read as static.
  rotation: number;
  rotSpeed: number;
  // Score awarded on kill.
  scoreValue: number;
  alive = true;
  // Theremin-drone glow trail. Vibrato pulse mode lines up loosely with the
  // alien voice's amplitude LFO. See Trail.ts.
  trail: Trail;

  constructor(pos: Vec, vel: Vec, size: AlienSize) {
    this.pos = pos;
    this.vel = vel;
    this.size = size;
    this.radius = SIZE_RADIUS[size];
    this.hue = SIZE_HUE[size];
    this.maxHp = SIZE_HP[size];
    this.hp = this.maxHp;
    this.cracks = rollAlienCracks(this.maxHp);
    this.weavePhase = rand(0, TAU);
    this.weaveSpeed = rand(0.6, 1.1);
    this.rotation = rand(0, TAU);
    this.rotSpeed = rand(-0.4, 0.4);
    this.scoreValue = SIZE_SCORE[size];
    // Trail tuned per size — bigger aliens have a thicker, slower-pulsing
    // wake; small ones flicker faster, matching their tighter firing rate.
    const trailRadius = this.radius * 0.7;
    const trailRate = size === "big" ? 0.9 : size === "medium" ? 1.2 : 1.5;
    this.trail = new Trail(this.hue, trailRadius, 0.26, "theremin", trailRate);
  }

  update(dt: number, w: number, h: number) {
    this.weavePhase += dt * this.weaveSpeed;
    this.rotation += this.rotSpeed * dt;
    // Sideways weave perpendicular to current heading — gives the alien a
    // saucer-like sway without making it impossible to predict where it's
    // going to be in a couple of seconds.
    const heading = Math.atan2(this.vel.y, this.vel.x);
    const perp = fromAngle(heading + Math.PI / 2, 1);
    const swayMag = Math.sin(this.weavePhase) * 18;
    const drift = mul(perp, swayMag);
    this.pos = wrap(add(add(this.pos, mul(this.vel, dt)), mul(drift, dt)), w, h);
    this.trail.update(dt, this.pos.x, this.pos.y);
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
    if (this.fireFlash > 0) this.fireFlash = Math.max(0, this.fireFlash - dt * 2.4);
  }

  // Decrement HP by 1. Returns whether the alien is now dead. Game uses this
  // for big aliens (multi-hit, same pipeline as bassteroids) and for
  // medium/small to keep the bookkeeping uniform.
  applyDamage(): { killed: boolean } {
    this.hp = Math.max(0, this.hp - 1);
    this.flashAmount = 1;
    if (this.hp <= 0) this.alive = false;
    return { killed: this.hp <= 0 };
  }

  // Fire a bullet aimed at `target`. Returns the new bullet so Game can
  // append it to the alien-bullet list. Sets fireFlash for the visual cue.
  fireAt(target: Vec): AlienBullet {
    this.fireFlash = 1;
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const angle = Math.atan2(dy, dx);
    const speed = SIZE_BULLET_SPEED[this.size];
    const muzzle = add(this.pos, mul(fromAngle(angle, 1), this.radius + 4));
    return new AlienBullet(muzzle, fromAngle(angle, speed), this.size, this.hue);
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    const dx = point.x - this.pos.x;
    const dy = point.y - this.pos.y;
    return Math.hypot(dx, dy) < this.radius * 0.9 + pointRadius;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const r = this.radius;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);
    ctx.globalCompositeOperation = "lighter";

    // Soft halo grows with fire-flash so the player can read "this thing is
    // about to fire / just fired" from a distance.
    const haloAlpha = 0.18 + 0.35 * this.fireFlash;
    const haloRadius = r * (2.2 + 0.4 * this.fireFlash);
    const halo = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, haloRadius);
    halo.addColorStop(0, `hsla(${baseHue}, 100%, 70%, ${haloAlpha})`);
    halo.addColorStop(0.6, `hsla(${baseHue + 10}, 100%, 60%, ${haloAlpha * 0.3})`);
    halo.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, TAU);
    ctx.fill();

    // Saucer silhouette: a flattened ellipse hull (the "disc") with a
    // domed cockpit on top. Reads as a classic flying saucer at a glance,
    // distinct from both the lumpy asteroids and the modular bassteroid ships.
    ctx.shadowColor = `hsla(${baseHue + 10}, 100%, 70%, 1)`;
    ctx.shadowBlur = 12;

    // Disc body
    ctx.beginPath();
    ctx.ellipse(0, 0.18 * r, r, r * 0.42, 0, 0, TAU);
    const discFill = ctx.createLinearGradient(0, -0.2 * r, 0, 0.6 * r);
    discFill.addColorStop(0, `hsla(${baseHue + 20}, 85%, 50%, 0.9)`);
    discFill.addColorStop(0.5, `hsla(${baseHue}, 80%, 28%, 0.95)`);
    discFill.addColorStop(1, `hsla(${baseHue - 10}, 80%, 12%, 0.95)`);
    ctx.fillStyle = discFill;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `hsla(${baseHue + 20}, 100%, 80%, 0.95)`;
    ctx.stroke();

    // Dome (cockpit) on top
    ctx.beginPath();
    ctx.ellipse(0, -0.1 * r, r * 0.46, r * 0.4, 0, Math.PI, 0);
    const domeFill = ctx.createLinearGradient(0, -0.4 * r, 0, 0.1 * r);
    domeFill.addColorStop(0, `hsla(${baseHue + 30}, 100%, 78%, 0.9)`);
    domeFill.addColorStop(0.6, `hsla(${baseHue + 10}, 90%, 45%, 0.7)`);
    domeFill.addColorStop(1, `hsla(${baseHue}, 80%, 30%, 0.3)`);
    ctx.fillStyle = domeFill;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 88%, 0.95)`;
    ctx.stroke();

    // Belly stripe across the disc — a thin highlight line that reads as
    // a panel seam.
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, 0.18 * r);
    ctx.lineTo(r * 0.85, 0.18 * r);
    ctx.strokeStyle = `hsla(${baseHue + 40}, 100%, 85%, 0.5)`;
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Running lights along the rim — count varies with size so big aliens
    // read as more elaborate.
    const lightCount = this.size === "big" ? 7 : this.size === "medium" ? 5 : 4;
    const blinkPhase = t * 0.004 + this.weavePhase;
    for (let i = 0; i < lightCount; i++) {
      const u = i / (lightCount - 1);
      const lx = (u - 0.5) * 2 * r * 0.92;
      const ly = 0.32 * r;
      const blink = 0.5 + 0.5 * Math.sin(blinkPhase + i * 0.9);
      const lr = 0.07 * r;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr * 3);
      lg.addColorStop(0, `hsla(${baseHue + 40}, 100%, 96%, ${0.9 * blink})`);
      lg.addColorStop(0.4, `hsla(${baseHue + 10}, 100%, 70%, ${0.5 * blink})`);
      lg.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `hsla(${baseHue + 50}, 100%, 98%, ${blink})`;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 0.55, 0, TAU);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Damage cracks — one per HP lost. Drawn over the body as faint white
    // fracture lines, clipped to the saucer silhouette so they never spill
    // off the disc/dome.
    const cracksToDraw = this.maxHp - this.hp;
    if (cracksToDraw > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0.18 * r, r, r * 0.42, 0, 0, TAU);
      ctx.ellipse(0, -0.1 * r, r * 0.46, r * 0.4, 0, 0, TAU);
      ctx.clip();
      const crackScale = 0.65;
      for (let i = 0; i < cracksToDraw; i++) {
        const crack = this.cracks[i];
        const dx = crack.pos.x * r;
        const dy = crack.pos.y * r;
        ctx.save();
        ctx.translate(dx, dy);
        ctx.rotate(crack.angle);
        ctx.scale(crackScale, crackScale);
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(245,245,250,0.45)";
        ctx.lineWidth = 1.0;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const branch of crack.branches) {
          ctx.beginPath();
          for (let p = 0; p < branch.points.length; p++) {
            const px = branch.points[p].x * r;
            const py = branch.points[p].y * r;
            if (p === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = `rgba(255,255,255,0.28)`;
        ctx.lineWidth = 0.45;
        for (const branch of crack.branches) {
          ctx.beginPath();
          for (let p = 0; p < branch.points.length; p++) {
            const px = branch.points[p].x * r;
            const py = branch.points[p].y * r;
            if (p === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.restore();
    }

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 40}, 100%, 95%, ${this.flashAmount * 0.32})`;
      ctx.beginPath();
      ctx.ellipse(0, 0.18 * r, r * 1.08, r * 0.5, 0, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }
}

export const spawnAlienAtEdge = (w: number, h: number, size: AlienSize): Alien => {
  const edge = Math.floor(Math.random() * 4);
  let pos: Vec;
  if (edge === 0) pos = v(rand(0, w), -40);
  else if (edge === 1) pos = v(w + 40, rand(0, h));
  else if (edge === 2) pos = v(rand(0, w), h + 40);
  else pos = v(-40, rand(0, h));
  // Aim roughly across the field — not straight at the player, since the
  // saucer is meant to drift through and let its bullets do the targeting.
  const target = v(w / 2 + rand(-w * 0.25, w * 0.25), h / 2 + rand(-h * 0.25, h * 0.25));
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const norm = Math.hypot(dx, dy);
  const [smin, smax] = SIZE_SPEED[size];
  const speed = rand(smin, smax);
  return new Alien(pos, v((dx / norm) * speed, (dy / norm) * speed), size);
};
