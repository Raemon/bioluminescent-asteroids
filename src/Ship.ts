import { Vec, v, add, mul, fromAngle, wrap, TAU } from "./vec";
import { Input } from "./Input";
import { ParticleSystem } from "./Particle";
import { Bullet } from "./Bullet";
import { Sound } from "./Sound";
import { PowerupKind, POWERUP_HUE } from "./Canister";
import { BEAT_GRID } from "./Game";

const RAPID_FIRE_RATE_MULTIPLIER = 0.4;
const TRIDENT_SPREAD = 0.21;

export class Ship {
  pos: Vec;
  vel: Vec = v(0, 0);
  heading = -Math.PI / 2;
  rotSpeed = 3.4;
  thrustPower = 320;
  drag = 0.6;
  maxSpeed = 460;
  radius = 14;
  alive = true;
  invuln = 2.0;
  thrustOn = false;
  fireCooldown = 0;
  // One beat per shot: held-fire matches the beat clock, a single tap locks
  // the trigger for one beat. A reticule in front of the ship previews where
  // a beat-timed bullet will be at the next beat so the player can line up
  // an on-beat impact rather than chase a sliding target.
  fireRate = BEAT_GRID;
  bulletSpeed = 620;
  bulletLife = 0.85;
  hyperCooldown = 0;
  // Active powerup state. Trident/rapid/pierce are persistent flags that
  // last until the ship dies — a fresh Ship is constructed on respawn, so
  // these naturally clear with the life. The shield is a one-shot flag
  // consumed on the next hit. Game.collectCanister sets these.
  tridentActive = false;
  rapidActive = false;
  pierceActive = false;
  shieldActive = false;

  constructor(pos: Vec) {
    this.pos = pos;
  }

  update(dt: number, input: Input, particles: ParticleSystem, bullets: Bullet[], w: number, h: number, t: number, sound: Sound) {
    if (!this.alive) return;

    if (this.invuln > 0) this.invuln -= dt;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.hyperCooldown > 0) this.hyperCooldown -= dt;

    if (input.down("arrowleft") || input.down("a")) this.heading -= this.rotSpeed * dt;
    if (input.down("arrowright") || input.down("d")) this.heading += this.rotSpeed * dt;

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
      sound.play("fire");
    }

    if (input.pressed("h") && this.hyperCooldown <= 0) {
      this.hyperspace(particles, w, h);
      sound.play("hyperspace");
    }

    this.vel = mul(this.vel, 1 - this.drag * dt);
    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > this.maxSpeed) this.vel = mul(this.vel, this.maxSpeed / speed);
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
  }

  hyperspace(particles: ParticleSystem, w: number, h: number) {
    this.emitHyperFlash(particles);
    this.pos = v(Math.random() * w, Math.random() * h);
    this.vel = v(0, 0);
    this.invuln = 0.6;
    this.hyperCooldown = 2.5;
    this.emitHyperFlash(particles);
  }

  emitHyperFlash(particles: ParticleSystem) {
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * TAU;
      particles.emit({
        pos: { ...this.pos },
        vel: fromAngle(a, 120 + Math.random() * 80),
        life: 0.5,
        maxLife: 0.5,
        size: 1.5,
        hue: 280 + Math.random() * 40,
        shrink: 1,
        drag: 1.4,
      });
    }
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

  // Aim marker at the fixed offset a bullet fired ON a beat would occupy at
  // the next beat. Sits at constant distance ahead of the ship (one beat
  // of travel) so the player can line up an asteroid with the ring rather
  // than chase a sliding target. Uses the same muzzle / velocity formula
  // as `fire` so ship drift is reflected. Dim while on cooldown so the
  // player can read at a glance when the next shot is available.
  renderReticules(ctx: CanvasRenderingContext2D, beatGrid: number, w: number, h: number) {
    if (!this.alive) return;
    const dir = fromAngle(this.heading, 1);
    const muzzle = add(this.pos, mul(dir, this.radius + 4));
    const bulletVel = add(mul(dir, this.bulletSpeed), mul(this.vel, 0.4));
    const reticulePos = wrap(add(muzzle, mul(bulletVel, beatGrid)), w, h);
    const onCooldown = this.fireCooldown > 0;
    const alpha = onCooldown ? 0.75 * 0.3 : 0.75;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(50, 100%, 78%, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.shadowColor = `hsla(50, 100%, 70%, ${alpha})`;
    ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.arc(reticulePos.x, reticulePos.y, 4.5, 0, TAU);
    ctx.stroke();
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
    // Visual scale-up on the beat — purely cosmetic, collision still uses
    // this.radius. Kept small (~8% max) so the silhouette doesn't appear to
    // grow into asteroids during a rhythm window.
    if (beatPulse > 0) {
      const beatScale = 1 + 0.08 * beatPulse;
      ctx.scale(beatScale, beatScale);
    }

    ctx.globalCompositeOperation = "lighter";
    // Beat pulse rides on top of the slow breathing pulse and gets clamped
    // so alpha never overflows. Outside the rhythm window beatPulse is 0,
    // so the ship looks exactly as it did before.
    const breathPulse = 0.7 + 0.3 * Math.sin(t * 0.005);
    const pulse = Math.min(1, breathPulse + 0.7 * beatPulse) * invulnFlicker;

    ctx.strokeStyle = `hsla(195, 100%, 75%, ${0.95 * pulse})`;
    ctx.lineWidth = 1.5 + 0.8 * beatPulse;
    ctx.shadowColor = "hsla(195, 100%, 70%, 1)";
    ctx.shadowBlur = 18 + 18 * beatPulse;
    ctx.beginPath();
    ctx.moveTo(verticesOfShip[0].x, verticesOfShip[0].y);
    for (const vert of verticesOfShip.slice(1)) ctx.lineTo(vert.x, vert.y);
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = `hsla(195, 100%, 60%, ${(0.08 + 0.22 * beatPulse) * pulse})`;
    ctx.fill();

    ctx.shadowBlur = 12;
    for (const vert of verticesOfShip) {
      const grad = ctx.createRadialGradient(vert.x, vert.y, 0, vert.x, vert.y, 8);
      grad.addColorStop(0, "hsla(195, 100%, 95%, 1)");
      grad.addColorStop(0.4, "hsla(195, 100%, 70%, 0.7)");
      grad.addColorStop(1, "hsla(195, 100%, 60%, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(vert.x, vert.y, 8, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "hsla(195, 100%, 98%, 1)";
      ctx.beginPath();
      ctx.arc(vert.x, vert.y, 1.6, 0, TAU);
      ctx.fill();
    }

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
