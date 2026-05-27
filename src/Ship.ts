import { Vec, v, add, mul, fromAngle, wrap, TAU } from "./vec";
import { Input } from "./Input";
import { ParticleSystem } from "./Particle";
import { Bullet } from "./Bullet";
import { Sound } from "./Sound";
import { PowerupKind, POWERUP_HUE } from "./Canister";
import { BEAT_GRID } from "./Game";

// Rapid = 8th notes; matches Game.comboGrid while active.
const RAPID_FIRE_RATE_MULTIPLIER = 0.5;
const TRIDENT_SPREAD = 0.21;

const RETICULE_LINE_DASH: [number, number] = [4, 4];
const RETICULE_DASH_HSL = "220, 100%, 100%";
const RETICULE_HITBOX_ALPHA = 0.28;
const RETICULE_COOLDOWN_DIM = 0.3;
// Brightness multiplier when the aim disc overlaps a target or its trajectory.
const RETICULE_OVERLAP_BRIGHTNESS = 3;

const RETICULE_HITBOX_PULSE_MAX = 1.0;
const RETICULE_HITBOX_PULSE_MIN = .75;
const RETICULE_HITBOX_PULSE_PERIOD_SEC = 2.0;

const RETICULE_RADAR_PULSE_MAX = 1;
const RETICULE_RADAR_PULSE_MIN = 0.4;
const RETICULE_RADAR_PULSE_PERIOD_SEC = 3.0;

const TRAJECTORY_ALPHA = 1;
const TRAJECTORY_PULSE_PERIOD_BEATS = 4;
const TRAJECTORY_PULSE_MIN_ALPHA = 1
const TRAJECTORY_BEAT_DOT_RADIUS = 1;
const TRAJECTORY_BEAT_DOT_ALPHA = .25;
const TRAJECTORY_FIRST_BEAT_DOT_RADIUS = 8;
const TRAJECTORY_FIRST_BEAT_DOT_ALPHA = .25;
const TRAJECTORY_FIRST_BEAT_DOT_LINE_WIDTH = 1;
const TRAJECTORY_FIRST_BEAT_DOT_DASH: number[] = [2, 2];
const TRAJECTORY_FIRST_BEAT_DOT_DASH_OFFSET = 0;

const RADAR_HALF_ANGLE = 0.60;
const RADAR_LENGTH = 800;
const RADAR_FRACTIONS: number[] = [0.33, 0.66, 1.0];
const RADAR_ALPHA = 0;
const RADAR_PULSE_AMOUNT = 0.1;
const RADAR_LINE_WIDTH = 1;
const RADAR_SWEEP_PHASE_OFFSET_SEC = 0.6;
const RADAR_SWEEP_DEPTH = 0.7;
const RADAR_SWEEP_PERIOD_SEC = 2.4;

// Background gradient + travelling pulse inside the radar cone.
const RADAR_BG_INNER_ALPHA = 0.02
const RADAR_BG_OUTER_ALPHA = 0.0;
const RADAR_PULSE_PERIOD_BEATS = 4;
// Pulse band thickness as a fraction of RADAR_LENGTH.
const RADAR_PULSE_WIDTH = 0.03;
const RADAR_PULSE_BAND_ALPHA = 0.02;

const BULLET_HIT_RADIUS_ON_BEAT = 1.8 * 2.38 * 2.5;
const BULLET_HIT_RADIUS_OFF_BEAT = 1.8 * 2.5;

export class Ship {
  pos: Vec;
  vel: Vec = v(0, 0);
  heading = -Math.PI / 2;
  rotSpeed = 4.6;
  // Rotation ramp: 0 at tap, climbs to 1 on hold.
  rotRamp = 0;
  thrustPower = 420;
  // Newtonian space drift: thrust and retro-thrust set velocity; nothing
  // slows the ship by itself.
  drag = 0;
  maxSpeed = 460;
  radius = 14;
  // Outer outline sits ~haloOffset past the hull; this is what collisions use.
  haloOffset = 8;
  // Collision-only inflation: pushes the hit silhouette out past the visible
  // halo without affecting rendering. `hitPad` is uniform; `hitFrontBonus`
  // adds extra reach near the forward heading, falling off to 0 at the rear.
  hitPad = 4;
  hitFrontBonus = 6;
  // Conservative bounding radius — circumscribes the outer (halo) triangle's
  // forward tip. Use for broad-phase checks; for accurate collisions against
  // an asteroid call `hitDistanceToward(worldAngle)` which returns the actual
  // silhouette distance and matches what the player sees.
  get hitRadius() { return this.radius * 1.4 + this.haloOffset + this.hitPad + this.hitFrontBonus; }
  alive = true;
  invuln = 2.0;
  thrustOn = false;
  reverseThrustOn = false;
  fireCooldown = 0;
  // One beat per shot; reticule previews next-beat impact.
  fireRate = BEAT_GRID;
  bulletSpeed = 620;
  bulletLife = 0.85;
  // Trident/rapid/pierce persist; shield is one-shot.
  tridentActive = false;
  rapidActive = false;
  pierceActive = false;
  shieldActive = false;

  // Target tier (0/1/2); intensity eases toward it.
  comboHaloTier = 0;
  comboHaloIntensity = 0;
  // 0..1 — set to 1 by Game when a real combo (≥2) is lost; decays in update.
  // Drives a red flash on the halo so the loss is felt visually as well as audibly.
  comboLossFlash = 0;
  // beatTime each target first entered the radar disc.
  private trajectoryFirstSeen = new WeakMap<object, number>();
  constructor(pos: Vec) {
    this.pos = pos;
  }

  // Combo halo: a single ship-shaped outline offset ~haloOffset from the hull, pulsing with the beat.
  // When intensity is 0, renders a dull static outline so the halo position is always visible.
  private renderComboHalo(ctx: CanvasRenderingContext2D, beatPulse: number) {
    const i = this.comboHaloIntensity;
    const tier1 = Math.min(1, i);
    const tier2 = Math.max(0, Math.min(1, i - 1));

    // Halo polygon is the ship's actual collision silhouette (see haloVertices).
    const halo = this.haloVertices();

    ctx.beginPath();
    ctx.moveTo(halo[0][0], halo[0][1]);
    ctx.lineTo(halo[1][0], halo[1][1]);
    ctx.lineTo(halo[2][0], halo[2][1]);
    ctx.closePath();

    // Dull static outline (visible when there's no rhythm), fades out as the active halo takes over.
    const dullAlpha = 0.4 * (1 - tier1);
    if (dullAlpha > 0.001) {
      ctx.strokeStyle = `hsla(210, 30%, 70%, ${dullAlpha})`;
      ctx.lineWidth = 1.2;
      ctx.shadowBlur = 0;
      ctx.stroke();
    }

    // Active combo halo: color shifts cyan -> gold as we cross into tier 2.
    if (tier1 > 0.001) {
      const hue = 195 + (45 - 195) * tier2; // 195 cyan, 45 gold
      const alpha = (0.45 + 0.35 * beatPulse) * tier1;
      ctx.strokeStyle = `hsla(${hue}, 100%, 78%, ${alpha})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = `hsla(${hue}, 100%, 70%, 1)`;
      ctx.shadowBlur = 10 + 6 * beatPulse;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Combo-loss flash: a red wash painted on top of whatever halo state was
    // last visible. Fires the instant the combo dies (tier hasn't fully eased
    // down yet), so the eye catches a red flicker exactly where the cyan/gold
    // halo just was, then fades to nothing.
    const lossFlash = this.comboLossFlash;
    if (lossFlash > 0.001) {
      const alpha = 0.85 * lossFlash;
      ctx.strokeStyle = `hsla(0, 95%, 62%, ${alpha})`;
      ctx.lineWidth = 1.8;
      ctx.shadowColor = `hsla(0, 100%, 55%, 1)`;
      ctx.shadowBlur = 12 * lossFlash;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  // World-space vertices of the outer (halo) triangle — the visible outline
  // that defines the ship's hitbox. Hull vertices are at radii [1.4r, 1.0r, 1.0r],
  // then each is pushed outward along its angle bisector so the polygon edges
  // sit `haloOffset` perpendicular to the hull edges.
  haloVertices(): Array<[number, number]> {
    const hull: Array<[number, number]> = [
      [Math.cos(this.heading) * this.radius * 1.4, Math.sin(this.heading) * this.radius * 1.4],
      [Math.cos(this.heading + Math.PI * 0.78) * this.radius * 1.0, Math.sin(this.heading + Math.PI * 0.78) * this.radius * 1.0],
      [Math.cos(this.heading - Math.PI * 0.78) * this.radius * 1.0, Math.sin(this.heading - Math.PI * 0.78) * this.radius * 1.0],
    ];
    const cross =
      (hull[1][0] - hull[0][0]) * (hull[2][1] - hull[0][1]) -
      (hull[1][1] - hull[0][1]) * (hull[2][0] - hull[0][0]);
    const s = cross < 0 ? 1 : -1;
    const offset = this.haloOffset;
    const halo: Array<[number, number]> = [];
    for (let k = 0; k < 3; k++) {
      const prev = hull[(k + 2) % 3];
      const curr = hull[k];
      const next = hull[(k + 1) % 3];
      const e1x = curr[0] - prev[0], e1y = curr[1] - prev[1];
      const e2x = next[0] - curr[0], e2y = next[1] - curr[1];
      let n1x = s * -e1y, n1y = s * e1x;
      let n2x = s * -e2y, n2y = s * e2x;
      const l1 = Math.hypot(n1x, n1y) || 1;
      const l2 = Math.hypot(n2x, n2y) || 1;
      n1x /= l1; n1y /= l1;
      n2x /= l2; n2y /= l2;
      let bx = n1x + n2x, by = n1y + n2y;
      const bl = Math.hypot(bx, by) || 1;
      bx /= bl; by /= bl;
      const dot = bx * n1x + by * n1y;
      const miter = offset / Math.max(0.2, dot);
      halo.push([curr[0] + bx * miter, curr[1] + by * miter]);
    }
    return halo;
  }

  // Distance from ship center to the outer triangle silhouette along world
  // ray angle `theta`. Returns the ray's intersection with the closest halo
  // edge — exactly what the player sees as the ship's outline in that
  // direction.
  hitDistanceToward(theta: number): number {
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const halo = this.haloVertices();
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = halo[k];
      const b = halo[(k + 1) % 3];
      // Solve t*(dx,dy) = a + u*(b-a) with t>=0 and u in [0,1].
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-9) continue;
      const t = (a[0] * ey - a[1] * ex) / denom;
      const u = (a[0] * dy - a[1] * dx) / denom;
      if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
    }
    if (!Number.isFinite(best)) return this.hitRadius;
    // Collision-only padding: uniform pad + extra reach toward the heading.
    const forward = Math.max(0, Math.cos(theta - this.heading));
    return best + this.hitPad + this.hitFrontBonus * forward;
  }

  // Map beatCombo to halo tier (<2: 0, 2-3: 1, >=4: 2).
  setCombo(combo: number) {
    if (combo >= 4) this.comboHaloTier = 2;
    else if (combo >= 2) this.comboHaloTier = 1;
    else this.comboHaloTier = 0;
  }

  // Kept for callsite compatibility; the simplified halo has no per-beat state to advance.
  tickComboHalo(_dt: number, _beatPulse: number) {}

  update(dt: number, input: Input, particles: ParticleSystem, bullets: Bullet[], w: number, h: number, t: number, sound: Sound) {
    if (!this.alive) return;

    if (this.invuln > 0) this.invuln -= dt;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    // Ease halo intensity: snap up fast, fade down slow.
    const haloTarget = this.comboHaloTier;
    const rising = haloTarget > this.comboHaloIntensity;
    const rate = rising ? 14 : 2.5;
    this.comboHaloIntensity += (haloTarget - this.comboHaloIntensity) * Math.min(1, rate * dt);
    // Combo-loss flash: decay linearly so the red is visible for ~0.7s then gone.
    if (this.comboLossFlash > 0) {
      this.comboLossFlash = Math.max(0, this.comboLossFlash - dt / 0.7);
    }

    // Turn rate ramps from 0.18 to 1 over ~0.18s of hold.
    const turnLeft = input.down("arrowleft") || input.down("a");
    const turnRight = input.down("arrowright") || input.down("d");
    if (turnLeft || turnRight) {
      this.rotRamp = Math.min(1, this.rotRamp + dt / 0.18);
    } else {
      this.rotRamp = 0;
    }
    const turnScale = 0.18 + 0.82 * this.rotRamp;
    if (turnLeft) this.heading -= this.rotSpeed * turnScale * dt;
    if (turnRight) this.heading += this.rotSpeed * turnScale * dt;

    const wasThrusting = this.thrustOn;
    this.thrustOn = input.down("arrowup") || input.down("w");
    if (this.thrustOn) {
      const accel = fromAngle(this.heading, this.thrustPower);
      this.vel = add(this.vel, mul(accel, dt));
      this.emitThrust(particles, t);
      if (!wasThrusting) sound.play("thrust");
    } else if (wasThrusting) {
      sound.stopThrust();
    }

    // Retro-thrust: same magnitude as forward thrust, opposite direction.
    // Two small jets vent forward from the front corners of the hull.
    const wasReversing = this.reverseThrustOn;
    this.reverseThrustOn = input.down("arrowdown") || input.down("s");
    if (this.reverseThrustOn) {
      const accel = fromAngle(this.heading + Math.PI, this.thrustPower);
      this.vel = add(this.vel, mul(accel, dt));
      this.emitReverseThrust(particles, t);
      if (!wasReversing) sound.play("reverseThrust");
    } else if (wasReversing) {
      sound.stopReverseThrust();
    }

    if ((input.down(" ") || input.down("spacebar")) && this.fireCooldown <= 0) {
      this.fire(bullets);
      const effectiveFireRate = this.rapidActive ? this.fireRate * RAPID_FIRE_RATE_MULTIPLIER : this.fireRate;
      this.fireCooldown = effectiveFireRate;
      // Fire sound is played by Game after on-beat check.
    }

    this.vel = mul(this.vel, 1 - this.drag * dt);
    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > this.maxSpeed) this.vel = mul(this.vel, this.maxSpeed / speed);
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
  }

  fire(bullets: Bullet[]) {
    const trident = this.tridentActive;
    const pierce = this.pierceActive;
    const bulletHeadingOffsets = trident ? [-TRIDENT_SPREAD, 0, TRIDENT_SPREAD] : [0];
    for (const offset of bulletHeadingOffsets) {
      const dir = fromAngle(this.heading + offset, 1);
      const muzzle = add(this.pos, mul(dir, this.radius + 4));
      const vel = add(mul(dir, this.bulletSpeed), mul(this.vel, 0.4));
      const bullet = new Bullet(muzzle, vel, this.bulletLife);
      bullet.pierce = pierce;
      bullets.push(bullet);
    }
  }

  applyPowerup(kind: PowerupKind) {
    if (kind === "trident") this.tridentActive = true;
    else if (kind === "rapid") this.rapidActive = true;
    else if (kind === "pierce") this.pierceActive = true;
    else if (kind === "shield") this.shieldActive = true;
  }

  emitThrust(particles: ParticleSystem, t: number) {
    const back = fromAngle(this.heading + Math.PI, 1);
    const tail = add(this.pos, mul(back, this.radius * 0.9));
    const jitter = (Math.random() - 0.5) * 0.6;
    const spread = fromAngle(this.heading + Math.PI + jitter, 1);
    const flicker = 0.6 + 0.4 * Math.sin(t * 0.04);
    particles.emit({
      pos: tail,
      vel: add(mul(spread, 180 + Math.random() * 120), mul(this.vel, 0.3)),
      life: 0.4 + Math.random() * 0.2,
      maxLife: 0.6,
      size: 1.4 * flicker,
      hue: 190 + Math.random() * 40,
      shrink: 1,
      drag: 1.8,
    });
  }

  // Two jets venting forward from the hull's rear corners. Punchier than the
  // main thruster: per-frame burst of bright hot-core particles + cooler
  // outer halo, plus a brief spark fan so the retro-fire reads as a sharp
  // braking blast rather than a steady plume.
  emitReverseThrust(particles: ParticleSystem, t: number) {
    const flicker = 0.7 + 0.3 * Math.sin(t * 0.06);
    for (const cornerOffset of [Math.PI * 0.78, -Math.PI * 0.78]) {
      const corner = fromAngle(this.heading + cornerOffset, this.radius * 1.0);
      const muzzle = add(this.pos, corner);
      // Hot white-blue core: a few fast, bright pixels per frame.
      for (let i = 0; i < 2; i++) {
        const jitter = (Math.random() - 0.5) * 0.35;
        const spread = fromAngle(this.heading + jitter, 1);
        particles.emit({
          pos: muzzle,
          vel: add(mul(spread, 220 + Math.random() * 140), mul(this.vel, 0.3)),
          life: 0.18 + Math.random() * 0.12,
          maxLife: 0.3,
          size: 1.6 * flicker,
          hue: 195 + Math.random() * 25,
          shrink: 1,
          drag: 2.4,
        });
      }
      // Cooler outer puff: slower, wider, longer-lived halo.
      const haloJitter = (Math.random() - 0.5) * 0.8;
      const haloSpread = fromAngle(this.heading + haloJitter, 1);
      particles.emit({
        pos: muzzle,
        vel: add(mul(haloSpread, 90 + Math.random() * 80), mul(this.vel, 0.25)),
        life: 0.35 + Math.random() * 0.2,
        maxLife: 0.55,
        size: 2.2 * flicker,
        hue: 210 + Math.random() * 20,
        shrink: 1,
        drag: 1.6,
      });
      // Occasional bright spark for that "flashy" jet pop.
      if (Math.random() < 0.5) {
        const sparkJitter = (Math.random() - 0.5) * 0.5;
        const sparkDir = fromAngle(this.heading + sparkJitter, 1);
        particles.emit({
          pos: muzzle,
          vel: add(mul(sparkDir, 320 + Math.random() * 160), mul(this.vel, 0.2)),
          life: 0.12 + Math.random() * 0.08,
          maxLife: 0.2,
          size: 1.0,
          hue: 50 + Math.random() * 30,
          shrink: 1,
          drag: 3.0,
        });
      }
    }
  }

  // Aim ring at next-beat bullet pos + radar trajectories.
  renderReticules(
    ctx: CanvasRenderingContext2D,
    beatGrid: number,
    w: number,
    h: number,
    targets: ReadonlyArray<{ pos: Vec; vel: Vec; radius?: number }> = [],
    beatTime: number = 0
  ) {
    if (!this.alive) return;
    const dir = fromAngle(this.heading, 1);
    const muzzle = add(this.pos, mul(dir, this.radius + 4));
    const bulletVel = add(mul(dir, this.bulletSpeed), mul(this.vel, 0.4));
    const reticulePos = wrap(add(muzzle, mul(bulletVel, beatGrid)), w, h);
    const onCooldown = this.fireCooldown > 0;
    // Cone apex sits at the ship; edges fan forward from the hull.
    const coneApex = this.pos;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Sinusoidal pulse helpers (use beatTime so the pulse pauses with the music).
    const hitboxPulse01 =
      0.5 + 0.5 * Math.cos((beatTime / RETICULE_HITBOX_PULSE_PERIOD_SEC) * TAU);
    const hitboxPulse =
      RETICULE_HITBOX_PULSE_MIN +
      (RETICULE_HITBOX_PULSE_MAX - RETICULE_HITBOX_PULSE_MIN) * hitboxPulse01;
    const radarPulse01 =
      0.5 + 0.5 * Math.cos((beatTime / RETICULE_RADAR_PULSE_PERIOD_SEC) * TAU);
    const radarPulse =
      RETICULE_RADAR_PULSE_MIN +
      (RETICULE_RADAR_PULSE_MAX - RETICULE_RADAR_PULSE_MIN) * radarPulse01;

    // Inner = off-beat hitbox, outer = on-beat hitbox.
    // Hitbox is drawn AFTER trajectory previews so we can boost brightness
    // when the disc overlaps a target or one of the previewed trajectory lines.
    const baseHitAlpha =
      RETICULE_HITBOX_ALPHA * (onCooldown ? RETICULE_COOLDOWN_DIM : 1) * hitboxPulse;
    // Pre-check: does the on-beat disc overlap any target's silhouette? Uses
    // toroidal distance so the test works across screen wrap.
    let overlapsTarget = false;
    for (const t of targets) {
      let dx = reticulePos.x - t.pos.x;
      let dy = reticulePos.y - t.pos.y;
      if (dx > w / 2) dx -= w;
      else if (dx < -w / 2) dx += w;
      if (dy > h / 2) dy -= h;
      else if (dy < -h / 2) dy += h;
      const rSum = (t.radius ?? 0) + BULLET_HIT_RADIUS_ON_BEAT;
      if (dx * dx + dy * dy <= rSum * rSum) {
        overlapsTarget = true;
        break;
      }
    }

    // Background gradient + travelling pulse inside the radar cone wedge.
    // Drawn first so range arcs and trajectory previews overlay cleanly.
    // The pulse band's centre travels apex->tip every `pulsePeriodBeats`.
    {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      const wedgeStart = this.heading - RADAR_HALF_ANGLE;
      const wedgeEnd = this.heading + RADAR_HALF_ANGLE;
      ctx.beginPath();
      ctx.moveTo(coneApex.x, coneApex.y);
      ctx.arc(coneApex.x, coneApex.y, RADAR_LENGTH, wedgeStart, wedgeEnd);
      ctx.closePath();
      const bg = ctx.createRadialGradient(
        coneApex.x, coneApex.y, 0,
        coneApex.x, coneApex.y, RADAR_LENGTH
      );
      bg.addColorStop(0, `hsla(${RETICULE_DASH_HSL}, ${RADAR_BG_INNER_ALPHA})`);
      bg.addColorStop(1, `hsla(${RETICULE_DASH_HSL}, ${RADAR_BG_OUTER_ALPHA})`);
      ctx.fillStyle = bg;
      ctx.fill();
      const periodSec = Math.max(1e-3, RADAR_PULSE_PERIOD_BEATS * beatGrid);
      const phase = ((beatTime % periodSec) + periodSec) % periodSec;
      const pulseR = (phase / periodSec) * RADAR_LENGTH;
      const halfW = Math.max(1e-3, RADAR_PULSE_WIDTH) * RADAR_LENGTH * 0.5;
      const r0 = Math.max(0, pulseR - halfW);
      const r1 = Math.min(RADAR_LENGTH, pulseR + halfW);
      if (r1 > r0 && RADAR_PULSE_BAND_ALPHA > 0.001) {
        const pulseGrad = ctx.createRadialGradient(
          coneApex.x, coneApex.y, r0,
          coneApex.x, coneApex.y, r1
        );
        const peakT = (pulseR - r0) / (r1 - r0);
        pulseGrad.addColorStop(0, `hsla(${RETICULE_DASH_HSL}, 0)`);
        pulseGrad.addColorStop(Math.min(0.999, Math.max(0.001, peakT)), `hsla(${RETICULE_DASH_HSL}, ${RADAR_PULSE_BAND_ALPHA})`);
        pulseGrad.addColorStop(1, `hsla(${RETICULE_DASH_HSL}, 0)`);
        ctx.fillStyle = pulseGrad;
        ctx.fill();
      }
      ctx.restore();
    }

    // Radar cone — faint stationary range arcs spanning the wedge. Curved
    // strokes read as "sensor HUD" and stay visually distinct from the
    // straight trajectory dashes. Arcs farther from the ship fade toward 0.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    ctx.lineWidth = RADAR_LINE_WIDTH;
    const pulseMix = 1 - RADAR_PULSE_AMOUNT + RADAR_PULSE_AMOUNT * radarPulse;
    const arcStart = this.heading - RADAR_HALF_ANGLE;
    const arcEnd = this.heading + RADAR_HALF_ANGLE;
    for (let i = 0; i < RADAR_FRACTIONS.length; i++) {
      const frac = RADAR_FRACTIONS[i];
      const radius = RADAR_LENGTH * frac;
      // Linear falloff: closest arc full, farthest arc 0.
      const distanceFade = 1 - frac;
      // Sweep shimmer: each arc's pulse is phase-shifted so brightness travels
      // apex → tip without anything actually moving.
      const sweep01 =
        0.5 +
        0.5 *
          Math.cos(
            ((beatTime - i * RADAR_SWEEP_PHASE_OFFSET_SEC) /
              RADAR_SWEEP_PERIOD_SEC) *
              TAU
          );
      const sweepMul = 1 - RADAR_SWEEP_DEPTH + RADAR_SWEEP_DEPTH * sweep01;
      const a = Math.min(1, RADAR_ALPHA * pulseMix * distanceFade * sweepMul);
      if (a <= 0.001) continue;
      ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${a})`;
      ctx.beginPath();
      ctx.arc(coneApex.x, coneApex.y, radius, arcStart, arcEnd);
      ctx.stroke();
    }
    ctx.restore();

    // Trajectory previews for targets inside the cone.
    if (targets.length > 0) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5;
      // No shadowBlur: gradient-stroke drop-shadows are slow.
      ctx.shadowBlur = 0;
      const pulsePeriod = TRAJECTORY_PULSE_PERIOD_BEATS * beatGrid;
      // Cone axis (unit) and outward normals of the two side edges (pointing out of the cone).
      const axisX = Math.cos(this.heading);
      const axisY = Math.sin(this.heading);
      // Outward normals of the side edges. Left edge direction is (cos(h-half),
      // sin(h-half)); rotating by -90° gives the outward (cone-left) normal.
      // Right edge direction is (cos(h+half), sin(h+half)); rotating by +90°
      // gives the outward (cone-right) normal.
      const leftNx = Math.sin(this.heading - RADAR_HALF_ANGLE);
      const leftNy = -Math.cos(this.heading - RADAR_HALF_ANGLE);
      const rightNx = -Math.sin(this.heading + RADAR_HALF_ANGLE);
      const rightNy = Math.cos(this.heading + RADAR_HALF_ANGLE);
      // Inside the cone, the dot product of (point - apex) with each outward normal is ≤ 0.
      for (const t of targets) {
        // Pick nearest toroidal image for screen-wrap, relative to the cone apex (ship).
        let dx = t.pos.x - coneApex.x;
        let dy = t.pos.y - coneApex.y;
        if (dx > w / 2) dx -= w;
        else if (dx < -w / 2) dx += w;
        if (dy > h / 2) dy -= h;
        else if (dy < -h / 2) dy += h;
        const tr = t.radius ?? 0;
        // In range if silhouette overlaps the cone: forward distance within length+r and
        // perpendicular distance to either edge within r (i.e., the target's circle bulges
        // into the cone). Use signed distances against side-edge outward normals.
        const forward = dx * axisX + dy * axisY;
        if (forward < -tr || forward > RADAR_LENGTH + tr) {
          this.trajectoryFirstSeen.delete(t as unknown as object);
          continue;
        }
        const leftSigned = dx * leftNx + dy * leftNy;
        const rightSigned = dx * rightNx + dy * rightNy;
        if (leftSigned > tr || rightSigned > tr) {
          this.trajectoryFirstSeen.delete(t as unknown as object);
          continue;
        }
        let firstSeenBeat = this.trajectoryFirstSeen.get(t as unknown as object);
        if (firstSeenBeat === undefined) {
          firstSeenBeat = beatTime;
          this.trajectoryFirstSeen.set(t as unknown as object, beatTime);
        }
        // Pulse ramps 0->1 to next beat, then cos oscillates.
        const firstPeakBeat =
          Math.ceil((firstSeenBeat + 1e-6) / beatGrid) * beatGrid;
        let pulse01: number;
        if (beatTime < firstPeakBeat) {
          const rampSpan = firstPeakBeat - firstSeenBeat;
          pulse01 = rampSpan > 0 ? (beatTime - firstSeenBeat) / rampSpan : 1;
        } else {
          // cos peak at firstPeakBeat + k*PERIOD.
          pulse01 =
            0.5 +
            0.5 *
              Math.cos(((beatTime - firstPeakBeat) / pulsePeriod) * TAU);
        }
        const floor =
          beatTime < firstPeakBeat ? 0 : TRAJECTORY_PULSE_MIN_ALPHA;
        const pulse = floor + (1 - floor) * pulse01;
        ctx.globalAlpha = TRAJECTORY_ALPHA * pulse;
        const cx = coneApex.x + dx;
        const cy = coneApex.y + dy;
        const speed = Math.hypot(t.vel.x, t.vel.y);
        if (speed < 1) continue;
        const ux = t.vel.x / speed;
        const uy = t.vel.y / speed;
        // Start past leading edge; pad clears polygon corners.
        const r = t.radius ?? 0;
        const edgePad = 6;
        const rawStartX = cx + ux * (r + edgePad);
        const rawStartY = cy + uy * (r + edgePad);
        // Clip ray (rawStart + s * u) to the cone half-plane intersection
        // (forward ≥ 0, forward ≤ length, leftSigned ≤ 0, rightSigned ≤ 0).
        // For each half-plane n·(P-apex) ≤ d: solving for s gives a 1-sided constraint.
        const rsx = rawStartX - coneApex.x;
        const rsy = rawStartY - coneApex.y;
        let sMin = 0;
        let sMax = Infinity;
        const clip = (nx: number, ny: number, d: number) => {
          // n·(rawStart - apex) + s * (n·u) ≤ d
          const num = d - (nx * rsx + ny * rsy);
          const den = nx * ux + ny * uy;
          if (Math.abs(den) < 1e-9) {
            // Ray parallel to plane; if start violates, no intersection.
            if (num < 0) sMax = -1;
            return;
          }
          const sBound = num / den;
          if (den > 0) {
            // Ray moves into violation past sBound: upper bound.
            if (sBound < sMax) sMax = sBound;
          } else {
            // Ray was violating, becomes valid after sBound: lower bound.
            if (sBound > sMin) sMin = sBound;
          }
        };
        clip(-axisX, -axisY, 0);                       // forward ≥ 0
        clip(axisX, axisY, RADAR_LENGTH);         // forward ≤ length
        clip(leftNx, leftNy, 0);                       // leftSigned ≤ 0
        clip(rightNx, rightNy, 0);                     // rightSigned ≤ 0
        if (sMax <= sMin) continue;
        // Per-beat dots: object's position at beatTime + k*beatGrid for k=1,2,...
        // The ray param s is measured from rawStart = cx + u*(r+edgePad), so the
        // s value for beat k is speed*beatGrid*k - (r+edgePad). Skip dots outside
        // the visible clip [sMin, sMax].
        const dotStep = speed * beatGrid;
        const dotOffset = -(r + edgePad);
        // Reticule position remapped to this target's toroidal image, for
        // detecting beat-dots that fall inside the hitbox disc.
        let retDx = reticulePos.x - coneApex.x;
        let retDy = reticulePos.y - coneApex.y;
        if (retDx > w / 2) retDx -= w;
        else if (retDx < -w / 2) retDx += w;
        if (retDy > h / 2) retDy -= h;
        else if (retDy < -h / 2) retDy += h;
        const retX = coneApex.x + retDx;
        const retY = coneApex.y + retDy;
        const R = BULLET_HIT_RADIUS_ON_BEAT;
        ctx.save();
        ctx.setLineDash([]);
        let drawnDots = 0;
        for (let k = 1; ; k++) {
          const sK = dotOffset + dotStep * k;
          if (sK > sMax) break;
          if (sK < sMin) continue;
          const px = rawStartX + ux * sK;
          const py = rawStartY + uy * sK;
          const isFirst = drawnDots === 0;
          const dotRadius = isFirst ? TRAJECTORY_FIRST_BEAT_DOT_RADIUS : TRAJECTORY_BEAT_DOT_RADIUS;
          const dotAlpha = isFirst ? TRAJECTORY_FIRST_BEAT_DOT_ALPHA : TRAJECTORY_BEAT_DOT_ALPHA;
          ctx.globalAlpha = TRAJECTORY_ALPHA * pulse;
          ctx.beginPath();
          ctx.arc(px, py, dotRadius, 0, TAU);
          if (isFirst) {
            ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${dotAlpha})`;
            ctx.lineWidth = TRAJECTORY_FIRST_BEAT_DOT_LINE_WIDTH;
            ctx.setLineDash(TRAJECTORY_FIRST_BEAT_DOT_DASH);
            ctx.lineDashOffset = TRAJECTORY_FIRST_BEAT_DOT_DASH_OFFSET;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineDashOffset = 0;
          } else {
            ctx.fillStyle = `hsla(${RETICULE_DASH_HSL}, ${dotAlpha})`;
            ctx.fill();
          }
          if (isFirst) {
            const ddx = px - retX;
            const ddy = py - retY;
            if (ddx * ddx + ddy * ddy <= (R + dotRadius) * (R + dotRadius)) {
              overlapsTarget = true;
            }
          }
          drawnDots++;
        }
        ctx.restore();
      }
      ctx.restore();
    }

    // Hitbox arcs (drawn last so the brightness boost stacks above the
    // trajectory lines via "lighter" compositing).
    const hitAlpha = baseHitAlpha * (overlapsTarget ? RETICULE_OVERLAP_BRIGHTNESS : 1);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${hitAlpha})`;
    ctx.lineWidth = 1;
    ctx.setLineDash(RETICULE_LINE_DASH);
    ctx.beginPath();
    ctx.arc(reticulePos.x, reticulePos.y, BULLET_HIT_RADIUS_OFF_BEAT, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(reticulePos.x, reticulePos.y, BULLET_HIT_RADIUS_ON_BEAT, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  render(ctx: CanvasRenderingContext2D, t: number, beatPulse: number = 0) {
    if (!this.alive) return;
    const invulnFlicker = this.invuln > 0 ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.025)) : 1;

    const verticesOfShip: Vec[] = [
      fromAngle(this.heading, this.radius * 1.4),
      fromAngle(this.heading + Math.PI * 0.78, this.radius * 1.0),
      fromAngle(this.heading - Math.PI * 0.78, this.radius * 1.0),
    ];

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    // Cosmetic beat scale-up (~8%); collision unchanged.
    if (beatPulse > 0) {
      const beatScale = 1 + 0.08 * beatPulse;
      ctx.scale(beatScale, beatScale);
    }

    ctx.globalCompositeOperation = "lighter";

    // Combo halo renders behind the ship outline (dull static outline when there's no rhythm).
    this.renderComboHalo(ctx, beatPulse);

    const breathPulse = 0.7 + 0.3 * Math.sin(t * 0.005);

    ctx.strokeStyle = `hsla(195, 100%, 75%, ${0.95 * breathPulse * invulnFlicker})`;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "hsla(195, 100%, 70%, 1)";
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(verticesOfShip[0].x, verticesOfShip[0].y);
    for (const vert of verticesOfShip.slice(1)) ctx.lineTo(vert.x, vert.y);
    ctx.closePath();
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = `hsla(195, 100%, 60%, ${0.12 * invulnFlicker})`;
    ctx.fill();

    if (this.thrustOn) {
      const back = fromAngle(this.heading + Math.PI, this.radius * 1.8 + Math.random() * 4);
      const grad = ctx.createRadialGradient(back.x, back.y, 0, back.x, back.y, 18);
      grad.addColorStop(0, "hsla(200, 100%, 80%, 0.9)");
      grad.addColorStop(0.5, "hsla(200, 100%, 60%, 0.3)");
      grad.addColorStop(1, "hsla(200, 100%, 60%, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(back.x, back.y, 18, 0, TAU);
      ctx.fill();
    }

    if (this.reverseThrustOn) {
      // Twin radial flares venting forward from each rear corner. Hot white
      // core with a cyan halo and a fine outer ring of glow that flickers
      // per frame.
      const flarePulse = 0.85 + Math.random() * 0.3;
      for (const cornerOffset of [Math.PI * 0.78, -Math.PI * 0.78]) {
        const corner = fromAngle(this.heading + cornerOffset, this.radius * 1.0);
        const tip = add(corner, fromAngle(this.heading, this.radius * 0.55 + Math.random() * 3));
        const flareR = 12 * flarePulse;
        const grad = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, flareR);
        grad.addColorStop(0, "hsla(200, 100%, 92%, 1.0)");
        grad.addColorStop(0.35, "hsla(200, 100%, 70%, 0.55)");
        grad.addColorStop(1, "hsla(200, 100%, 60%, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, flareR, 0, TAU);
        ctx.fill();
        // Bright hot pinpoint inside the flare for that arc-light look.
        ctx.fillStyle = `hsla(50, 100%, 92%, ${0.85 * flarePulse})`;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 1.6, 0, TAU);
        ctx.fill();
      }
    }

    if (this.shieldActive) {
      const shieldRadius = this.radius * 1.9;
      const shieldPulse = 0.6 + 0.4 * Math.sin(t * 0.006);
      const shieldHue = POWERUP_HUE.shield;
      ctx.strokeStyle = `hsla(${shieldHue}, 100%, 80%, ${0.75 * shieldPulse})`;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = `hsla(${shieldHue}, 100%, 70%, 1)`;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(0, 0, shieldRadius, 0, TAU);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }
}
