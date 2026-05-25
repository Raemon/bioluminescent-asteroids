import { Vec, v, add, mul, fromAngle, wrap, TAU } from "./vec";
import { Input } from "./Input";
import { ParticleSystem } from "./Particle";
import { Bullet } from "./Bullet";
import { Sound } from "./Sound";

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
  fireRate = 0.22;
  bulletSpeed = 620;
  bulletLife = 0.85;
  hyperCooldown = 0;

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
      this.fireCooldown = this.fireRate;
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
    const dir = fromAngle(this.heading, 1);
    const muzzle = add(this.pos, mul(dir, this.radius + 4));
    const vel = add(mul(dir, this.bulletSpeed), mul(this.vel, 0.4));
    bullets.push(new Bullet(muzzle, vel, this.bulletLife));
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

  render(ctx: CanvasRenderingContext2D, t: number) {
    if (!this.alive) return;
    const invulnFlicker = this.invuln > 0 ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.025)) : 1;

    const verticesOfShip: Vec[] = [
      fromAngle(this.heading, this.radius * 1.4),
      fromAngle(this.heading + Math.PI * 0.78, this.radius * 1.0),
      fromAngle(this.heading - Math.PI * 0.78, this.radius * 1.0),
    ];

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    ctx.globalCompositeOperation = "lighter";
    const pulse = (0.7 + 0.3 * Math.sin(t * 0.005)) * invulnFlicker;

    ctx.strokeStyle = `hsla(195, 100%, 75%, ${0.95 * pulse})`;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "hsla(195, 100%, 70%, 1)";
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(verticesOfShip[0].x, verticesOfShip[0].y);
    for (const vert of verticesOfShip.slice(1)) ctx.lineTo(vert.x, vert.y);
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = `hsla(195, 100%, 60%, ${0.08 * pulse})`;
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

    ctx.restore();
  }
}
