import type { Game } from "../Game";
import type { Asteroid } from "../Asteroid";
import { BOSS_SWEEP_HALF } from "../Asteroid";
import { killShip } from "./lifecycle";
import { popShield } from "./collisions";
import { BEAT_GRID } from "./rhythmConstants";

// The boss eye's primary weapon. Rather than a point bolt, the eye emits a
// sustained energy beam that SWEEPS: it starts aimed off to one side, then
// rotates across the arena, crossing the player's locked aim direction
// partway through the sweep. The player dodges by clearing the rotating
// beam's path. The beam is a rotating ray from the eye outward; the ship is
// hit on any frame its hitbox straddles the ray.

// How far the beam reaches. Long enough to always cross the whole screen
// from a centre-ish eye.
const BEAM_LENGTH = 1800;
// The sweep spans ±BOSS_SWEEP_HALF, centred on the locked aim. The beam
// enters before the aim and exits past it, so the player's locked position
// sits dead centre of the traversal. Shared with the telegraph wedge.
const SWEEP_HALF = BOSS_SWEEP_HALF;
// Sweep takes two beats: a beat of travel into the player, a beat out the
// far side. Slow enough to read and dodge, fast enough to feel like a slash.
const SWEEP_DURATION = BEAT_GRID * 2;
// Brief charge flash before the beam is "live" (deals damage) — the bar of
// light snaps to full width before it begins to rotate.
const IGNITE_TIME = 0.08;
// The beam lingers a moment at the end of its arc before fading.
const HOLD_TIME = BEAT_GRID * 0.5;
const FADE_TIME = 0.18;
// Hot core half-width; the ship is burned if its hull crosses this.
const BEAM_HALF_WIDTH = 7;

export class BossBeam {
  owner: Asteroid;
  // Origin is refreshed from the owner each frame while it's still alive
  // (see tickBossBeams); cached here so the beam finishes its sweep from the
  // last known origin if the eye is destroyed mid-slash.
  originX: number;
  originY: number;
  // Sweep endpoints + current angle. `angle` eases start→end over the sweep.
  startAngle: number;
  endAngle: number;
  angle: number;
  hue: number;
  // Total age; phases are ignite → sweep → hold → fade.
  age = 0;
  dead = false;

  constructor(owner: Asteroid, aimAngle: number, hue: number) {
    this.owner = owner;
    this.originX = owner.pos.x;
    this.originY = owner.pos.y;
    this.hue = hue;
    // Enter the sweep from whichever side the player is NOT, so the beam
    // travels toward the player rather than away. Sign is arbitrary-stable:
    // sweep clockwise unless that would start behind the eye's body facing.
    const dir = aimAngle >= 0 ? 1 : -1;
    this.startAngle = aimAngle - dir * SWEEP_HALF;
    this.endAngle = aimAngle + dir * SWEEP_HALF;
    this.angle = this.startAngle;
  }

  // Fraction through the rotating portion of the sweep, 0..1. 0 during the
  // ignite flash, 1 once the beam has reached the far end.
  private sweepFrac(): number {
    const t = (this.age - IGNITE_TIME) / SWEEP_DURATION;
    return Math.max(0, Math.min(1, t));
  }

  // Overall brightness envelope, 0..1.
  intensity(): number {
    if (this.age < IGNITE_TIME) return this.age / IGNITE_TIME;
    const fadeStart = IGNITE_TIME + SWEEP_DURATION + HOLD_TIME;
    if (this.age < fadeStart) return 1;
    return Math.max(0, 1 - (this.age - fadeStart) / FADE_TIME);
  }

  // True once the rotating beam is live and able to burn the ship — i.e.
  // after the ignite flash and until the fade begins.
  private damaging(): boolean {
    const fadeStart = IGNITE_TIME + SWEEP_DURATION + HOLD_TIME;
    return this.age >= IGNITE_TIME && this.age < fadeStart;
  }

  update(dt: number) {
    this.age += dt;
    // Ease-in-out so the slash accelerates through the middle (where the
    // player is) rather than crawling past at constant speed.
    const f = this.sweepFrac();
    const eased = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    this.angle = this.startAngle + (this.endAngle - this.startAngle) * eased;
    if (this.age >= IGNITE_TIME + SWEEP_DURATION + HOLD_TIME + FADE_TIME) {
      this.dead = true;
    }
  }

  get alive() {
    return !this.dead;
  }

  // Shortest distance from the ship centre to the beam ray, used both for
  // the hit test and to know when the ship is grazing it.
  distanceToShip(sx: number, sy: number): number {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const dx = sx - this.originX;
    const dy = sy - this.originY;
    const along = dx * cos + dy * sin;
    const t = Math.max(0, Math.min(BEAM_LENGTH, along));
    const px = this.originX + cos * t;
    const py = this.originY + sin * t;
    return Math.hypot(sx - px, sy - py);
  }

  hitsShip(game: Game): boolean {
    if (!this.damaging()) return false;
    const ship = game.ship;
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const dx = ship.pos.x - this.originX;
    const dy = ship.pos.y - this.originY;
    // The ship hitbox reach varies with facing; sample it toward the beam's
    // nearest point so a grazing pass reads fairly.
    const reach = ship.hitDistanceToward(Math.atan2(-dy, -dx));
    const along = dx * cos + dy * sin;
    if (along < -reach) return false;
    return this.distanceToShip(ship.pos.x, ship.pos.y) < reach + BEAM_HALF_WIDTH;
  }
}

export const fireBossSweepBeam = (game: Game, a: Asteroid, aimAngle: number) => {
  game.bossBeams.push(new BossBeam(a, aimAngle, a.hue));
};

export const tickBossBeams = (game: Game, dt: number) => {
  for (const beam of game.bossBeams) {
    // Follow the owning eye while it's still on the field; once it's gone the
    // beam keeps sweeping from its last origin.
    if (game.asteroids.includes(beam.owner)) {
      beam.originX = beam.owner.pos.x;
      beam.originY = beam.owner.pos.y;
    }
    beam.update(dt);
  }
  let shipHit = false;
  const vulnerable = game.ship.alive && game.ship.invuln <= 0;
  for (const beam of game.bossBeams) {
    if (vulnerable && !shipHit && beam.hitsShip(game)) {
      shipHit = true;
      if (game.ship.shieldActive) {
        game.ship.shieldActive = false;
        game.ship.invuln = 0.8;
        popShield(game);
      } else {
        killShip(game);
      }
    }
  }
  game.bossBeams = game.bossBeams.filter((b) => b.alive);
};

export const renderBossBeams = (ctx: CanvasRenderingContext2D, beams: BossBeam[]) => {
  if (beams.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const beam of beams) {
    const intensity = beam.intensity();
    if (intensity <= 0.01) continue;
    const cos = Math.cos(beam.angle);
    const sin = Math.sin(beam.angle);
    const ox = beam.originX;
    const oy = beam.originY;
    const ex = ox + cos * BEAM_LENGTH;
    const ey = oy + sin * BEAM_LENGTH;
    const hue = beam.hue;

    // Wide diffuse aura.
    ctx.strokeStyle = `hsla(${hue + 6}, 100%, 60%, ${(0.14 * intensity).toFixed(3)})`;
    ctx.lineWidth = 34;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Mid glow.
    ctx.strokeStyle = `hsla(${hue + 12}, 100%, 65%, ${(0.4 * intensity).toFixed(3)})`;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Hot core.
    ctx.strokeStyle = `hsla(${hue + 30}, 100%, 85%, ${(0.85 * intensity).toFixed(3)})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // White-hot centre line.
    ctx.strokeStyle = `hsla(48, 100%, 98%, ${(intensity).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Muzzle bloom at the eye.
    const muzzleR = 26 * intensity;
    const muzzle = ctx.createRadialGradient(ox, oy, 0, ox, oy, muzzleR);
    muzzle.addColorStop(0, `hsla(48, 100%, 98%, ${(0.9 * intensity).toFixed(3)})`);
    muzzle.addColorStop(0.4, `hsla(${hue + 25}, 100%, 75%, ${(0.5 * intensity).toFixed(3)})`);
    muzzle.addColorStop(1, `hsla(${hue}, 100%, 55%, 0)`);
    ctx.fillStyle = muzzle;
    ctx.beginPath();
    ctx.arc(ox, oy, muzzleR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};
