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
const RETICULE_RADAR_ALPHA = 0.2;
const RETICULE_COOLDOWN_DIM = 0.3;

const RETICULE_HITBOX_PULSE_MAX = 1.0;
const RETICULE_HITBOX_PULSE_MIN = 0.35;
const RETICULE_HITBOX_PULSE_PERIOD_SEC = 2.0;

const RETICULE_RADAR_PULSE_MAX = 1.0;
const RETICULE_RADAR_PULSE_MIN = 0.4;
const RETICULE_RADAR_PULSE_PERIOD_SEC = 3.0;

const RETICULE_TRAJECTORY_ALPHA = 0.5;
const RETICULE_TRAJECTORY_FADE_START = 0.3;
const RETICULE_TRAJECTORY_PULSE_PERIOD_BEATS = 4;
const RETICULE_TRAJECTORY_PULSE_MIN_ALPHA = 0.2

const RADAR_CONE_HALF_ANGLE = 0.60;
const RADAR_CONE_LENGTH = 500;

const BULLET_HIT_RADIUS_ON_BEAT = 1.8 * 2.38 * 2.5;
const BULLET_HIT_RADIUS_OFF_BEAT = 1.8 * 2.5;

export class Ship {
  pos: Vec;
  vel: Vec = v(0, 0);
  heading = -Math.PI / 2;
  rotSpeed = 4.6;
  // Rotation ramp: 0 at tap, climbs to 1 on hold.
  rotRamp = 0;
  thrustPower = 320;
  drag = 0.6;
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
    const dullAlpha = 0.25 * (1 - tier1);
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
    const leftAngle = this.heading - RADAR_CONE_HALF_ANGLE;
    const rightAngle = this.heading + RADAR_CONE_HALF_ANGLE;
    const leftEdgeEnd = add(coneApex, fromAngle(leftAngle, RADAR_CONE_LENGTH));
    const rightEdgeEnd = add(coneApex, fromAngle(rightAngle, RADAR_CONE_LENGTH));
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
    const hitAlpha =
      RETICULE_HITBOX_ALPHA * (onCooldown ? RETICULE_COOLDOWN_DIM : 1) * hitboxPulse;
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

    // Radar cone — two dashed edges emanate from the ship; far edge invisible.
    // Each edge fades from opacity 1 at the ship to 0 at the tip.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.setLineDash(RETICULE_LINE_DASH);
    const coneAlpha = RETICULE_RADAR_ALPHA * radarPulse * 5; // boost: cone is sparser than the old disc
    const coneAlphaClamped = Math.min(1, coneAlpha);
    const drawConeEdge = (endX: number, endY: number) => {
      const grad = ctx.createLinearGradient(coneApex.x, coneApex.y, endX, endY);
      grad.addColorStop(0, `hsla(${RETICULE_DASH_HSL}, ${coneAlphaClamped})`);
      grad.addColorStop(1, `hsla(${RETICULE_DASH_HSL}, 0)`);
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(coneApex.x, coneApex.y);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    };
    drawConeEdge(leftEdgeEnd.x, leftEdgeEnd.y);
    drawConeEdge(rightEdgeEnd.x, rightEdgeEnd.y);
    ctx.restore();

    // Trajectory previews for targets inside the cone.
    if (targets.length > 0) {
      ctx.save();
      ctx.setLineDash(RETICULE_LINE_DASH);
      ctx.lineWidth = 1.5;
      // No shadowBlur: gradient-stroke drop-shadows are slow.
      ctx.shadowBlur = 0;
      const pulsePeriod = RETICULE_TRAJECTORY_PULSE_PERIOD_BEATS * beatGrid;
      // Cone axis (unit) and outward normals of the two side edges (pointing out of the cone).
      const axisX = Math.cos(this.heading);
      const axisY = Math.sin(this.heading);
      // Outward normals of the side edges. Left edge direction is (cos(h-half),
      // sin(h-half)); rotating by -90° gives the outward (cone-left) normal.
      // Right edge direction is (cos(h+half), sin(h+half)); rotating by +90°
      // gives the outward (cone-right) normal.
      const leftNx = Math.sin(this.heading - RADAR_CONE_HALF_ANGLE);
      const leftNy = -Math.cos(this.heading - RADAR_CONE_HALF_ANGLE);
      const rightNx = -Math.sin(this.heading + RADAR_CONE_HALF_ANGLE);
      const rightNy = Math.cos(this.heading + RADAR_CONE_HALF_ANGLE);
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
        if (forward < -tr || forward > RADAR_CONE_LENGTH + tr) {
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
          beatTime < firstPeakBeat ? 0 : RETICULE_TRAJECTORY_PULSE_MIN_ALPHA;
        const pulse = floor + (1 - floor) * pulse01;
        ctx.globalAlpha = RETICULE_TRAJECTORY_ALPHA * pulse;
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
        clip(axisX, axisY, RADAR_CONE_LENGTH);         // forward ≤ length
        clip(leftNx, leftNy, 0);                       // leftSigned ≤ 0
        clip(rightNx, rightNy, 0);                     // rightSigned ≤ 0
        if (sMax <= sMin) continue;
        const startX = rawStartX + ux * sMin;
        const startY = rawStartY + uy * sMin;
        const endX = rawStartX + ux * sMax;
        const endY = rawStartY + uy * sMax;
        // Gradient: opaque, then fade out at far end.
        const grad = ctx.createLinearGradient(startX, startY, endX, endY);
        grad.addColorStop(0, `hsla(${RETICULE_DASH_HSL}, 1)`);
        grad.addColorStop(RETICULE_TRAJECTORY_FADE_START, `hsla(${RETICULE_DASH_HSL}, 1)`);
        grad.addColorStop(1, `hsla(${RETICULE_DASH_HSL}, 0)`);
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }
      ctx.restore();
    }

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
