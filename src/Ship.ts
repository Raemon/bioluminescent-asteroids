import { Vec, v, add, mul, fromAngle, wrap, TAU } from "./vec";
import { Input } from "./Input";
import { ParticleSystem } from "./Particle";
import { Bullet } from "./Bullet";
import { Sound } from "./Sound";
import { PowerupKind, POWERUP_HUE } from "./Canister";
import { BEAT_GRID } from "./Game";

// Rapid fires at 8th notes (half the base BEAT_GRID quarter-note cadence),
// which is the grid the combo evaluator switches to while rapid is active —
// see Game.comboGrid.
const RAPID_FIRE_RATE_MULTIPLIER = 0.5;
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

  // Combo halo state. `comboHaloTier` is the target tier (0/1/2) derived from
  // the current beatCombo: tier 0 = no streak, tier 1 = combo 2-3, tier 2 =
  // combo >= 4. `comboHaloIntensity` smoothly eases toward the target tier so
  // the halo fades in/out cleanly on streak break, rather than popping.
  comboHaloTier = 0;
  comboHaloIntensity = 0;

  constructor(pos: Vec) {
    this.pos = pos;
  }

  // Builds the same vertex pattern as the inner ship but at a given scale.
  // Pulled out so the halo and ship outline stay congruent if the silhouette
  // ever changes.
  private comboHaloVertices(scale: number): Vec[] {
    return [
      fromAngle(this.heading, this.radius * 1.4 * scale),
      fromAngle(this.heading + Math.PI * 0.78, this.radius * 1.0 * scale),
      fromAngle(this.heading - Math.PI * 0.78, this.radius * 1.0 * scale),
    ];
  }

  private renderComboHalo(ctx: CanvasRenderingContext2D, t: number) {
    const i = this.comboHaloIntensity;
    // Tier 1 contribution rises 0→1 as intensity crosses 0→1; tier 2 rises
    // 0→1 as intensity crosses 1→2. Both layers can be active simultaneously
    // during the climb from tier 1 to tier 2.
    const tier1 = Math.min(1, i);
    const tier2 = Math.max(0, Math.min(1, i - 1));

    // Slow sine pulse for the faint outer ring (tier 1). 1.3 Hz keeps it
    // breathing without feeling jittery.
    const slowPulse = 0.55 + 0.45 * Math.sin(t * 0.004);
    if (tier1 > 0.01) {
      const verts = this.comboHaloVertices(1.8);
      ctx.strokeStyle = `hsla(195, 100%, 75%, ${0.32 * tier1 * slowPulse})`;
      ctx.lineWidth = 1.2;
      ctx.shadowColor = "hsla(195, 100%, 70%, 1)";
      ctx.shadowBlur = 10 * tier1;
      ctx.beginPath();
      ctx.moveTo(verts[0].x, verts[0].y);
      for (const vert of verts.slice(1)) ctx.lineTo(vert.x, vert.y);
      ctx.closePath();
      ctx.stroke();
    }

    // Tier 2: a brighter, gold-cyan double-line at a wider radius, with a
    // faster pulse. The mid-ring sits between the tier-1 outline and the
    // outer flare so the layers read as a coherent halo rather than two
    // unrelated rings. Also adds short radial spokes from each vertex for
    // the "fancier" read.
    if (tier2 > 0.01) {
      const fastPulse = 0.55 + 0.45 * Math.sin(t * 0.009);
      const goldPulse = 0.7 + 0.3 * Math.sin(t * 0.007 + 1.3);

      const midVerts = this.comboHaloVertices(2.1);
      ctx.strokeStyle = `hsla(195, 100%, 85%, ${0.55 * tier2 * fastPulse})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "hsla(195, 100%, 80%, 1)";
      ctx.shadowBlur = 16 * tier2;
      ctx.beginPath();
      ctx.moveTo(midVerts[0].x, midVerts[0].y);
      for (const vert of midVerts.slice(1)) ctx.lineTo(vert.x, vert.y);
      ctx.closePath();
      ctx.stroke();

      const outerVerts = this.comboHaloVertices(2.5);
      ctx.strokeStyle = `hsla(45, 100%, 70%, ${0.55 * tier2 * goldPulse})`;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = "hsla(45, 100%, 65%, 1)";
      ctx.shadowBlur = 18 * tier2;
      ctx.beginPath();
      ctx.moveTo(outerVerts[0].x, outerVerts[0].y);
      for (const vert of outerVerts.slice(1)) ctx.lineTo(vert.x, vert.y);
      ctx.closePath();
      ctx.stroke();

      // Radiating spokes from each outer vertex — short, gold, pulsing.
      // Gives the tier-2 halo a "charged" feel without adding particles.
      ctx.strokeStyle = `hsla(45, 100%, 75%, ${0.7 * tier2 * goldPulse})`;
      ctx.lineWidth = 1.2;
      ctx.shadowBlur = 10 * tier2;
      const spokeLen = this.radius * 0.55 * (0.8 + 0.4 * goldPulse);
      for (const vert of outerVerts) {
        const mag = Math.hypot(vert.x, vert.y);
        const ux = vert.x / mag;
        const uy = vert.y / mag;
        ctx.beginPath();
        ctx.moveTo(vert.x + ux * 2, vert.y + uy * 2);
        ctx.lineTo(vert.x + ux * (2 + spokeLen), vert.y + uy * (2 + spokeLen));
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
  }

  // Game pushes the current beatCombo here every frame. Maps to halo tiers:
  //   combo < 2 → tier 0 (no halo)
  //   combo 2–3 → tier 1 (faint pulsing outline)
  //   combo ≥ 4 → tier 2 (bright, two-layer halo with gold accent)
  setCombo(combo: number) {
    if (combo >= 4) this.comboHaloTier = 2;
    else if (combo >= 2) this.comboHaloTier = 1;
    else this.comboHaloTier = 0;
  }

  update(dt: number, input: Input, particles: ParticleSystem, bullets: Bullet[], w: number, h: number, t: number, sound: Sound) {
    if (!this.alive) return;

    if (this.invuln > 0) this.invuln -= dt;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.hyperCooldown > 0) this.hyperCooldown -= dt;

    // Ease combo halo intensity toward the current tier. Rising (gaining a
    // tier) snaps quickly so the player sees the celebration land on the
    // beat; falling (streak broken) fades over ~0.4s so it doesn't pop out.
    const haloTarget = this.comboHaloTier;
    const rising = haloTarget > this.comboHaloIntensity;
    const rate = rising ? 14 : 2.5;
    this.comboHaloIntensity += (haloTarget - this.comboHaloIntensity) * Math.min(1, rate * dt);

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
      // Fire sound is played by Game after the on-beat detection runs so
      // we can pick the deeper "fireBeat" voice for rhythm shots and the
      // lighter "fire" voice for plain shots.
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
    // Dark-blue ring — matches the rhythm-bullet colour so the player reads
    // "this is where my next rhythm shot would land" without needing a
    // legend.
    ctx.strokeStyle = `hsla(220, 100%, 78%, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.shadowColor = `hsla(220, 100%, 70%, ${alpha})`;
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

    // Combo halo: faint outer triangle outline that appears once a streak
    // begins (tier 1 at combo 2-3) and intensifies at combo ≥ 4 (tier 2).
    // Renders BEFORE the inner ship so the ship silhouette sits over it.
    // Intensity is a smoothed value so the halo fades cleanly when the
    // streak breaks rather than popping out.
    if (this.comboHaloIntensity > 0.01) {
      this.renderComboHalo(ctx, t);
    }

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
      const grad = ctx.createRadialGradient(vert.x, vert.y, 0, vert.x, vert.y, 4);
      grad.addColorStop(0, "hsla(195, 100%, 95%, 1)");
      grad.addColorStop(0.4, "hsla(195, 100%, 70%, 0.7)");
      grad.addColorStop(1, "hsla(195, 100%, 60%, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(vert.x, vert.y, 4, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "hsla(195, 100%, 98%, 1)";
      ctx.beginPath();
      ctx.arc(vert.x, vert.y, 0.6, 0, TAU);
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
