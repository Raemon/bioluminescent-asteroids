import { Vec, v, add, mul, fromAngle, rand, TAU, wrapMut } from "./vec";
import { AlienBullet } from "./AlienBullet";
import { Trail } from "./Trail";

// Three sizes, each with its own role in the rhythm:
//   "big"    : 4 HP, fires every other beat (every 2× BEAT_GRID).
//              Uses the same multi-hit pipeline as bassteroids — each hit
//              decrements hp by 1, the killing hit explodes it.
//   "medium" : 2 HP, fires every beat (BEAT_GRID).
//   "small"  : 1 HP, fires every beat (BEAT_GRID).
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

// Per-size firing pattern: gaps (in BEAT_GRID units) between consecutive
// shots, cycled forever. Each entry is the wait BEFORE the next shot. Game
// multiplies by BEAT_GRID and aligns to the global beat clock so shots fall
// exactly on the rhythm grid the player is already listening to.
//   small  : shot, shot, shot, REST → 3 hits then 1-beat breather (4-beat cycle)
//   medium : shot, shot, REST, REST → 2 hits then 2-beat breather (4-beat cycle)
//   big    : every beat, no rest    → relentless 1-beat cadence
// The "rest" is encoded as a longer gap before the next shot in the cycle.
export const ALIEN_FIRE_PATTERN_BEATS: Record<AlienSize, number[]> = {
  small: [1, 1, 2],
  medium: [1, 3],
  big: [1],
};

// Hand-built panel for the alien hull. Same idea as bassteroid modules —
// hard-edged plates with bright outlines — but oriented along +X (nose
// forward) so the ship reads as facing the direction it's flying.
type AlienPanel = { vertices: Vec[] };

// Running-light hard-point. Glowing dot painted on top of panels so each size
// has a memorable silhouette even after damage.
type AlienLight = { pos: Vec; size: number };

// Engine nozzle position. Renderer paints a back-facing thrust plume that
// pulses with weave/fire flash so the ship feels alive between shots.
type AlienEngine = { pos: Vec; size: number };

type AlienShip = { panels: AlienPanel[]; lights: AlienLight[]; engines: AlienEngine[] };

const rect = (x1: number, y1: number, x2: number, y2: number): AlienPanel => ({
  vertices: [v(x1, y1), v(x2, y1), v(x2, y2), v(x1, y2)],
});

// All coords in radius-units (renderer scales by this.radius). +X = nose
// forward, +Y = "down" relative to the hull. Each size has its own silhouette
// tuned so the three sizes are distinct at a glance.
//   small : interceptor — narrow nose, tight body, twin micro-engines
//   medium: fighter      — pointed nose, swept wings, twin engines
//   big   : gunship      — blunt cockpit, broad hull, side cannon pods, twin big engines
const buildAlienShape = (size: AlienSize): AlienShip => {
  if (size === "small") {
    return {
      panels: [
        // nose spike
        { vertices: [v(0.95, 0), v(0.25, -0.22), v(0.25, 0.22)] },
        // main hull plate
        rect(-0.55, -0.26, 0.25, 0.26),
        // dorsal cockpit blister
        { vertices: [v(-0.05, -0.18), v(0.2, -0.32), v(0.2, 0.32), v(-0.05, 0.18)] },
        // engine block at the back
        rect(-0.78, -0.22, -0.55, 0.22),
      ],
      lights: [
        { pos: v(0.55, 0), size: 0.07 },
        { pos: v(0.1, 0), size: 0.06 },
        { pos: v(-0.45, -0.18), size: 0.05 },
        { pos: v(-0.45, 0.18), size: 0.05 },
      ],
      engines: [
        { pos: v(-0.78, -0.12), size: 0.13 },
        { pos: v(-0.78, 0.12), size: 0.13 },
      ],
    };
  }
  if (size === "medium") {
    return {
      panels: [
        // pointed nose
        { vertices: [v(1.0, 0), v(0.35, -0.28), v(0.35, 0.28)] },
        // forward hull
        rect(-0.2, -0.32, 0.35, 0.32),
        // cockpit hex
        { vertices: [v(0.05, -0.18), v(0.3, -0.1), v(0.3, 0.1), v(0.05, 0.18), v(-0.1, 0.1), v(-0.1, -0.1)] },
        // swept wings — top and bottom
        { vertices: [v(-0.05, -0.32), v(-0.55, -0.85), v(-0.7, -0.6), v(-0.35, -0.32)] },
        { vertices: [v(-0.05, 0.32), v(-0.55, 0.85), v(-0.7, 0.6), v(-0.35, 0.32)] },
        // rear engine block
        rect(-0.75, -0.28, -0.2, 0.28),
      ],
      lights: [
        { pos: v(0.7, 0), size: 0.07 },
        { pos: v(0.12, 0), size: 0.06 },
        { pos: v(-0.55, -0.72), size: 0.06 },
        { pos: v(-0.55, 0.72), size: 0.06 },
        { pos: v(-0.45, 0), size: 0.05 },
      ],
      engines: [
        { pos: v(-0.75, -0.16), size: 0.16 },
        { pos: v(-0.75, 0.16), size: 0.16 },
      ],
    };
  }
  // big — heavy gunship: blunt nose, broad mid-hull, side cannon pods, twin big engines
  return {
    panels: [
      // blunt nose — short triangle/trapezoid
      { vertices: [v(0.92, -0.18), v(0.92, 0.18), v(0.55, 0.4), v(0.25, 0.4), v(0.25, -0.4), v(0.55, -0.4)] },
      // broad main hull
      rect(-0.45, -0.5, 0.4, 0.5),
      // cockpit dome (front-top)
      { vertices: [v(0.18, -0.14), v(0.5, -0.22), v(0.5, 0.22), v(0.18, 0.14)] },
      // side cannon pods (top & bottom)
      rect(-0.25, -0.85, 0.2, -0.5),
      rect(-0.25, 0.5, 0.2, 0.85),
      // cannon barrels sticking forward from the pods
      rect(0.18, -0.78, 0.55, -0.58),
      rect(0.18, 0.58, 0.55, 0.78),
      // rear engine block
      rect(-0.78, -0.42, -0.45, 0.42),
      // wing-tip stabilizers
      { vertices: [v(-0.45, -0.5), v(-0.78, -0.62), v(-0.78, -0.42)] },
      { vertices: [v(-0.45, 0.5), v(-0.78, 0.62), v(-0.78, 0.42)] },
    ],
    lights: [
      { pos: v(0.7, 0), size: 0.07 },
      { pos: v(0.5, -0.7), size: 0.06 },
      { pos: v(0.5, 0.7), size: 0.06 },
      { pos: v(-0.05, 0), size: 0.07 },
      { pos: v(-0.6, -0.3), size: 0.05 },
      { pos: v(-0.6, 0.3), size: 0.05 },
      { pos: v(-0.3, -0.7), size: 0.05 },
      { pos: v(-0.3, 0.7), size: 0.05 },
    ],
    engines: [
      { pos: v(-0.78, -0.25), size: 0.2 },
      { pos: v(-0.78, 0.25), size: 0.2 },
    ],
  };
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
  // global beat grid) and advanced after each shot by the next gap in the
  // size's fire pattern.
  nextFireAt = 0;
  // Index into ALIEN_FIRE_PATTERN_BEATS[size] — advances each shot, wraps.
  firePatternIndex = 0;
  // Pulsing tells the player a beat is coming. Set to 1.0 each fire, decays.
  fireFlash = 0;
  flashAmount = 0;
  // Lazy oscillation that gives aliens a hovering "drifting around" feel
  // rather than a straight line.
  weavePhase: number;
  weaveSpeed: number;
  // Rotation follows the heading (so the nose points along velocity), with
  // a small sway added in render() for life.
  rotation: number;
  // Hand-built ship silhouette (panels + lights + engines). Built once at
  // spawn and reused for both the body draw and the damage-crack clip mask.
  ship: AlienShip;
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
    this.rotation = Math.atan2(vel.y, vel.x);
    this.ship = buildAlienShape(size);
    this.scoreValue = SIZE_SCORE[size];
    // Trail tuned per size — bigger aliens have a thicker, slower-pulsing
    // wake; small ones flicker faster, matching their tighter firing rate.
    const trailRadius = this.radius * 0.7;
    const trailRate = size === "big" ? 0.9 : size === "medium" ? 1.2 : 1.5;
    this.trail = new Trail(this.hue, trailRadius, 0.26, "theremin", trailRate);
  }

  update(dt: number, w: number, h: number) {
    this.weavePhase += dt * this.weaveSpeed;
    // Sideways weave perpendicular to current heading — gives the alien a
    // saucer-like sway without making it impossible to predict where it's
    // going to be in a couple of seconds.
    const heading = Math.atan2(this.vel.y, this.vel.x);
    // perp = unit vector perpendicular to heading (rotated +π/2): (-sin, cos).
    const perpX = -Math.sin(heading);
    const perpY =  Math.cos(heading);
    const swayMag = Math.sin(this.weavePhase) * 18;
    this.pos.x += (this.vel.x + perpX * swayMag) * dt;
    this.pos.y += (this.vel.y + perpY * swayMag) * dt;
    wrapMut(this.pos, w, h);
    // Nose follows the direction of travel, with a tiny weave-driven sway so
    // the silhouette breathes instead of locking rigidly to the velocity.
    this.rotation = heading + Math.sin(this.weavePhase) * 0.12;
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

  // same hp-as-momentum proxy as asteroids — a chip hit shoves a small
  // alien noticeably, barely budges a big one.
  applyKnockback(dirX: number, dirY: number, amount: number, referenceSpeed: number = 120) {
    const len = Math.hypot(dirX, dirY);
    if (len === 0) return;
    const fraction = Math.min(1, amount / Math.max(1, this.maxHp));
    const dv = fraction * referenceSpeed;
    this.vel.x += (dirX / len) * dv;
    this.vel.y += (dirY / len) * dv;
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
    const ship = this.ship;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);
    ctx.globalCompositeOperation = "lighter";

    // Soft halo grows with fire-flash so "about to fire / just fired" reads
    // from a distance.
    const haloAlpha = 0.16 + 0.32 * this.fireFlash;
    const haloRadius = r * (2.0 + 0.4 * this.fireFlash);
    const halo = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, haloRadius);
    halo.addColorStop(0, `hsla(${baseHue}, 100%, 65%, ${haloAlpha})`);
    halo.addColorStop(0.6, `hsla(${baseHue + 12}, 100%, 55%, ${haloAlpha * 0.3})`);
    halo.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, TAU);
    ctx.fill();

    // Engine plumes — back-facing thrust glow at each nozzle. Pulses with the
    // weave so the ship feels alive between shots.
    const plumePulse = 0.7 + 0.3 * Math.sin(this.weavePhase * 3.5);
    for (const eng of ship.engines) {
      const ex = eng.pos.x * r;
      const ey = eng.pos.y * r;
      const plumeLen = r * (0.55 + 0.18 * plumePulse);
      const plumeRad = eng.size * r * 1.6;
      const pg = ctx.createRadialGradient(ex - plumeLen * 0.3, ey, 0, ex - plumeLen * 0.3, ey, plumeLen);
      pg.addColorStop(0, `hsla(${baseHue + 30}, 100%, 80%, ${0.7 * plumePulse})`);
      pg.addColorStop(0.5, `hsla(${baseHue + 10}, 100%, 60%, ${0.3 * plumePulse})`);
      pg.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.ellipse(ex - plumeLen * 0.4, ey, plumeLen, plumeRad, 0, 0, TAU);
      ctx.fill();
    }

    const tracePanel = (panel: AlienPanel) => {
      ctx.beginPath();
      for (let i = 0; i < panel.vertices.length; i++) {
        const x = panel.vertices[i].x * r;
        const y = panel.vertices[i].y * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    // Panelled hull — hard edges with a bright outline, like bassteroid plates.
    ctx.shadowColor = `hsla(${baseHue + 10}, 100%, 70%, 1)`;
    for (const panel of ship.panels) {
      tracePanel(panel);
      const fill = ctx.createLinearGradient(-r, -r, r, r);
      fill.addColorStop(0, `hsla(${baseHue}, 70%, 22%, 0.9)`);
      fill.addColorStop(0.5, `hsla(${baseHue + 8}, 65%, 32%, 0.9)`);
      fill.addColorStop(1, `hsla(${baseHue - 5}, 75%, 14%, 0.9)`);
      ctx.fillStyle = fill;
      ctx.shadowBlur = 0;
      ctx.fill();
      ctx.shadowBlur = 10;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = `hsla(${baseHue + 14}, 100%, 80%, 0.95)`;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Thin centre-stripe inside each panel — plated-metal seam, same trick
    // as the bassteroid renderer uses.
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 85%, 0.45)`;
    for (const panel of ship.panels) {
      ctx.save();
      tracePanel(panel);
      ctx.clip();
      let cx = 0;
      let cy = 0;
      for (const p of panel.vertices) {
        cx += p.x;
        cy += p.y;
      }
      cx = (cx / panel.vertices.length) * r;
      cy = (cy / panel.vertices.length) * r;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.3, cy);
      ctx.lineTo(cx + r * 0.3, cy);
      ctx.stroke();
      ctx.restore();
    }

    // Running lights — each blinks on its own phase. Fire-flash boosts every
    // light so the moment of firing reads as a coordinated pulse.
    const blinkPhase = t * 0.004 + this.weavePhase;
    for (let i = 0; i < ship.lights.length; i++) {
      const light = ship.lights[i];
      const lx = light.pos.x * r;
      const ly = light.pos.y * r;
      const blink = 0.45 + 0.4 * Math.sin(blinkPhase + i * 0.9) + 0.4 * this.fireFlash;
      const lr = light.size * r * 1.2;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr * 3);
      lg.addColorStop(0, `hsla(${baseHue + 40}, 100%, 96%, ${Math.min(1, 0.9 * blink)})`);
      lg.addColorStop(0.35, `hsla(${baseHue + 10}, 100%, 72%, ${Math.min(1, 0.55 * blink)})`);
      lg.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `hsla(${baseHue + 50}, 100%, 98%, ${Math.min(1, blink)})`;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 0.55, 0, TAU);
      ctx.fill();
    }

    // Damage cracks — one per HP lost. Clipped to the union of panels so
    // they only show where there's actual hull underneath.
    const cracksToDraw = this.maxHp - this.hp;
    if (cracksToDraw > 0) {
      ctx.save();
      ctx.beginPath();
      for (const panel of ship.panels) {
        for (let i = 0; i < panel.vertices.length; i++) {
          const x = panel.vertices[i].x * r;
          const y = panel.vertices[i].y * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.clip();
      const crackScale = 0.6;
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

    // Hit-flash — pale overlay across all panels.
    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 40}, 100%, 95%, ${this.flashAmount * 0.32})`;
      for (const panel of ship.panels) {
        tracePanel(panel);
        ctx.fill();
      }
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
