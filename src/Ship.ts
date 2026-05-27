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
const RETICULE_LINE_DASH: [number, number] = [4, 4];
// Shared colour for every dashed element in the reticule family (hitbox rings
// + radar circle) so they read as one system. HSL only — opacity is applied
// per-element via the alpha constants below.
const RETICULE_DASH_HSL = "220, 100%, 100%";
// Opacity for the two dashed hitbox rings (off-beat + on-beat). Tuned to sit
// just above the radar circle's visibility — faint but definitely present.
const RETICULE_HITBOX_ALPHA = 0.28;
// Opacity for the outer rhythm-radar circle. Kept barely visible so it hints
// at the rhythm window without competing with gameplay for attention.
const RETICULE_RADAR_ALPHA = 0.2;
// Fire-cooldown dim factor applied to the hitbox rings so the player can read
// at a glance when the next shot is available.
const RETICULE_COOLDOWN_DIM = 0.3;
// Peak opacity for trajectory-preview lines projected from targets inside
// the radar. The line holds this value from its start (just past the
// target's leading edge) up to RETICULE_TRAJECTORY_FADE_START along its
// length, then linearly fades to 0 by the far end at the radar boundary.
// Keeps the near end of the forecast crisp while letting the far end
// dissolve into the radar circle.
const RETICULE_TRAJECTORY_ALPHA = 0.5;
// Fraction along the trajectory line (0 = near end at the target, 1 = far
// end at the radar boundary) where the fade begins. Before this point the
// line is at full alpha; after it, alpha ramps linearly down to 0 at the
// far end.
const RETICULE_TRAJECTORY_FADE_START = 0.3;
// Period of the trajectory-line opacity pulse, expressed as a whole
// number of beats so peaks land on beat boundaries by construction and the
// radar "breathes" with the music. The runtime period in seconds is
// derived per-frame as PULSE_PERIOD_BEATS * beatGrid (passed into
// renderReticules) — we can't multiply by BEAT_GRID at module top-level
// because Ship.ts and Game.ts form a circular import.
const RETICULE_TRAJECTORY_PULSE_PERIOD_BEATS = 4;
// Floor opacity (as a fraction of RETICULE_TRAJECTORY_ALPHA) at the dim end
// of the pulse. 1 disables the pulse; 0 would dip to fully transparent.
const RETICULE_TRAJECTORY_PULSE_MIN_ALPHA = 0.2
// Mirrors Bullet.hitRadius() for an on-beat shot: base radius 1.8 × on-beat
// scale 2.38 × hit multiplier 2.5. Hard-coded here so the reticule preview
// doesn't need a live bullet to size itself.
const BULLET_HIT_RADIUS_ON_BEAT = 1.8 * 2.38 * 2.5;
// Off-beat hit radius: base 1.8 × 1 × 2.5. Shown as the inner reticule ring.
const BULLET_HIT_RADIUS_OFF_BEAT = 1.8 * 2.5;

export class Ship {
  pos: Vec;
  vel: Vec = v(0, 0);
  heading = -Math.PI / 2;
  rotSpeed = 4.6;
  // Ramp-up factor for rotation: starts low when a turn key is first pressed
  // and quickly climbs to 1 (full rotSpeed). Lets the player nudge their
  // heading with a quick tap while still pulling 180s when they hold the key.
  rotRamp = 0;
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
  // Expanding shockwave rings emitted once per beat while a streak is live.
  // age=0 spawns hugging the silhouette, grows outward, dies at 1. Stored as
  // a small ring buffer; capped because at most ~3 rings can be visible at
  // any time given the ringLife / beat rate.
  private comboRings: { age: number; gold: boolean }[] = [];
  // Last beatPulse seen by tickComboHalo, for rising-edge ring emission.
  private prevBeatPulse = 0;
  // beatTime at which each target was first seen inside the rhythm-radar
  // circle. Used to anchor the trajectory-line opacity ramp: each line
  // ramps 0 → 1 from firstSeenBeat to the next beat boundary, then
  // oscillates with period RETICULE_TRAJECTORY_PULSE_PERIOD_BEATS beats
  // whose peaks land on beats. WeakMap so dead targets get GC'd
  // automatically.
  private trajectoryFirstSeen = new WeakMap<object, number>();
  constructor(pos: Vec) {
    this.pos = pos;
  }

  // Combo halo: a soft silhouette-hugging bloom plus thin shockwave rings that
  // emanate outward on each beat and dissolve as they grow. The bloom hugs the
  // hit radius so it never reads as "my hitbox is bigger"; the rings expand
  // and dissolve, so they read as resonance with the beat rather than armor.
  //
  // tier1 (combo 2–3): cyan bloom + cyan shockwave per beat.
  // tier2 (combo ≥ 4): + gold core, gold echo shockwave, star spikes on beat.
  private renderComboHalo(ctx: CanvasRenderingContext2D, beatPulse: number) {
    const i = this.comboHaloIntensity;
    const tier1 = Math.min(1, i);
    const tier2 = Math.max(0, Math.min(1, i - 1));
    const bloomBeat = 0.4 * beatPulse;

    // Cyan bloom hugging the ship's silhouette. Outer radius is just past the
    // visual outline (~1.6× vs the outline at ~1.4×) so the glow looks like
    // it belongs to the ship's body, not a wider boundary.
    const bloomRadius = this.radius * 1.6;
    const cyanGrad = ctx.createRadialGradient(0, 0, this.radius * 0.4, 0, 0, bloomRadius);
    cyanGrad.addColorStop(0, `hsla(195, 100%, 80%, ${(0.18 + bloomBeat * 0.25) * tier1})`);
    cyanGrad.addColorStop(0.55, `hsla(200, 100%, 65%, ${(0.10 + bloomBeat * 0.15) * tier1})`);
    cyanGrad.addColorStop(1, "hsla(200, 100%, 60%, 0)");
    ctx.fillStyle = cyanGrad;
    ctx.beginPath();
    ctx.arc(0, 0, bloomRadius, 0, TAU);
    ctx.fill();

    // Tier-2 gold core nested inside the cyan bloom — reads as "molten" heat
    // at the heart of the ship rather than a second boundary.
    if (tier2 > 0.01) {
      const goldGrad = ctx.createRadialGradient(0, 0, this.radius * 0.2, 0, 0, this.radius * 1.3);
      goldGrad.addColorStop(0, `hsla(45, 100%, 80%, ${(0.18 + bloomBeat * 0.2) * tier2})`);
      goldGrad.addColorStop(0.6, `hsla(45, 100%, 70%, ${(0.08 + bloomBeat * 0.1) * tier2})`);
      goldGrad.addColorStop(1, "hsla(45, 100%, 65%, 0)");
      ctx.fillStyle = goldGrad;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 1.3, 0, TAU);
      ctx.fill();
    }

    // Shockwave rings — spawn hugging the silhouette and expand outward with
    // eased radius and fading alpha. Constant outward motion makes them read
    // as a pulse, not a hitbox boundary.
    for (const ring of this.comboRings) {
      if (ring.age < 0) continue;
      const eased = 1 - (1 - ring.age) * (1 - ring.age);
      const startR = this.radius * 1.25;
      const endR = this.radius * 5.0;
      const r = startR + (endR - startR) * eased;
      const alpha = (1 - ring.age) * (1 - ring.age);
      const hue = ring.gold ? 45 : 195;
      const intensityScale = ring.gold ? tier2 : tier1;
      if (intensityScale <= 0.01) continue;
      ctx.strokeStyle = `hsla(${hue}, 100%, 80%, ${0.65 * alpha * intensityScale})`;
      ctx.lineWidth = 1.3 * (0.5 + 0.5 * (1 - ring.age));
      ctx.shadowColor = `hsla(${hue}, 100%, 75%, 1)`;
      ctx.shadowBlur = 12 * alpha * intensityScale;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Tier-2 star spikes — four short rays at the apex / sides that flash
    // on each beat. Oriented to heading so they anchor to the silhouette.
    if (tier2 > 0.01 && beatPulse > 0.05) {
      const spikeAlpha = 0.85 * tier2 * beatPulse;
      const spikeLen = this.radius * (0.7 + 0.5 * beatPulse);
      ctx.strokeStyle = `hsla(45, 100%, 88%, ${spikeAlpha})`;
      ctx.lineWidth = 1.1;
      ctx.shadowColor = "hsla(45, 100%, 75%, 1)";
      ctx.shadowBlur = 10 * beatPulse;
      for (let k = 0; k < 4; k++) {
        const a = this.heading + (k * Math.PI) / 2;
        const inner = this.radius * 1.35;
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(cosA * inner, sinA * inner);
        ctx.lineTo(cosA * (inner + spikeLen), sinA * (inner + spikeLen));
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }

  // Game pushes the current beatCombo here every frame. Maps to halo tiers:
  //   combo < 2 → tier 0 (no halo)
  //   combo 2–3 → tier 1 (cyan bloom + cyan shockwave on beat)
  //   combo ≥ 4 → tier 2 (+ gold core, gold echo shockwave, star spikes)
  setCombo(combo: number) {
    if (combo >= 4) this.comboHaloTier = 2;
    else if (combo >= 2) this.comboHaloTier = 1;
    else this.comboHaloTier = 0;
  }

  // Game calls this once per frame with dt and the rhythm-window pulse
  // (Game.currentBeatPulse). Advances ring ages and emits a fresh ring on the
  // rising edge of beatPulse (window entry — guaranteed to fire once per
  // beat). Kept separate from update() so we don't have to thread beatPulse
  // through input handling.
  tickComboHalo(dt: number, beatPulse: number) {
    // Ring lifetime ~0.55s — long enough for the wave to fully expand before
    // the next beat at the slowest combo rate, short enough that simultaneous
    // rings don't pile into a confusing layered halo.
    for (const ring of this.comboRings) ring.age += dt / 0.55;
    this.comboRings = this.comboRings.filter((r) => r.age < 1);

    if (this.prevBeatPulse <= 0 && beatPulse > 0 && this.comboHaloIntensity > 0.05) {
      this.comboRings.push({ age: 0, gold: false });
      if (this.comboHaloIntensity > 1.0) {
        // Slight negative age so the gold echo trails the cyan ring by ~50ms
        // — reads as a resonant echo rather than a duplicate.
        this.comboRings.push({ age: -0.08, gold: true });
      }
    }
    this.prevBeatPulse = beatPulse;
  }

  update(dt: number, input: Input, particles: ParticleSystem, bullets: Bullet[], w: number, h: number, t: number, sound: Sound) {
    if (!this.alive) return;

    if (this.invuln > 0) this.invuln -= dt;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    // Ease combo halo intensity toward the current tier. Rising (gaining a
    // tier) snaps quickly so the player sees the celebration land on the
    // beat; falling (streak broken) fades over ~0.4s so it doesn't pop out.
    const haloTarget = this.comboHaloTier;
    const rising = haloTarget > this.comboHaloIntensity;
    const rate = rising ? 14 : 2.5;
    this.comboHaloIntensity += (haloTarget - this.comboHaloIntensity) * Math.min(1, rate * dt);

    // Rotation ramp-up: ramp starts at ~0.18 of full speed and climbs to 1
    // within ~0.18s of holding a turn key, so a tap nudges the heading
    // slightly while a hold quickly reaches the full turn rate. Released
    // keys snap the ramp back to 0 immediately.
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
      // Fire sound is played by Game after the on-beat detection runs so
      // we can pick the deeper "fireBeat" voice for rhythm shots and the
      // lighter "fire" voice for plain shots.
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

  // Aim marker at the fixed offset a bullet fired ON a beat would occupy at
  // the next beat. Sits at constant distance ahead of the ship (one beat
  // of travel) so the player can line up an asteroid with the ring rather
  // than chase a sliding target. Uses the same muzzle / velocity formula
  // as `fire` so ship drift is reflected. Dim while on cooldown so the
  // player can read at a glance when the next shot is available.
  //
  // Surrounded by a 150px dotted "rhythm radar" circle. Any object whose
  // centre falls inside that circle gets a short dashed trajectory line
  // projected from its front, teaching the player to read incoming motion
  // and pre-aim for an on-beat kill.
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
    const RADAR_RADIUS = 150;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Two concentric dashed circles at the aim point: inner ring is the
    // off-beat bullet hitbox, outer ring is the larger on-beat hitbox. Same
    // dash pattern and colour as the radar ring so the three circles read as
    // a single family.
    const hitAlpha = RETICULE_HITBOX_ALPHA * (onCooldown ? RETICULE_COOLDOWN_DIM : 1);
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

    // Dotted radar circle — kept barely visible so it hints at the rhythm
    // window without competing with gameplay elements for attention.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.setLineDash(RETICULE_LINE_DASH);
    ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${RETICULE_RADAR_ALPHA})`;
    ctx.beginPath();
    ctx.arc(reticulePos.x, reticulePos.y, RADAR_RADIUS, 0, TAU);
    ctx.stroke();
    ctx.restore();

    // Trajectory previews for anything inside the radar. Extends from the
    // leading edge of the object out to the radar boundary along its
    // velocity vector, dashed so it reads as a forecast rather than a
    // permanent tether. Each line holds full alpha for the first
    // RETICULE_TRAJECTORY_FADE_START fraction of its length, then linearly
    // fades to 0 at the far end — keeps the near forecast crisp while the
    // tip dissolves into the radar boundary.
    if (targets.length > 0) {
      ctx.save();
      ctx.setLineDash(RETICULE_LINE_DASH);
      ctx.lineWidth = 1.5;
      // No shadowBlur here on purpose: canvas drop-shadows on gradient strokes
      // are very expensive, and cost scales with target count. The dashed
      // line + lighter composite already reads as glowing.
      ctx.shadowBlur = 0;
      const radarR2 = RADAR_RADIUS * RADAR_RADIUS;
      const pulsePeriod = RETICULE_TRAJECTORY_PULSE_PERIOD_BEATS * beatGrid;
      for (const t of targets) {
        // Account for screen-wrap: pick whichever toroidal image of the
        // target sits closest to the reticule so objects near a seam still
        // show their trajectory.
        let dx = t.pos.x - reticulePos.x;
        let dy = t.pos.y - reticulePos.y;
        if (dx > w / 2) dx -= w;
        else if (dx < -w / 2) dx += w;
        if (dy > h / 2) dy -= h;
        else if (dy < -h / 2) dy += h;
        // Treat any object whose silhouette overlaps the radar disc as "in
        // range" so large asteroids whose centres sit just outside still get
        // a trajectory preview the moment their edge crosses the ring.
        const tr = t.radius ?? 0;
        const inclusionR = RADAR_RADIUS + tr;
        if (dx * dx + dy * dy > inclusionR * inclusionR) {
          // Out of range — clear the timestamp so a re-entry starts a fresh
          // ramp from 0 rather than picking up where it left off.
          this.trajectoryFirstSeen.delete(t as unknown as object);
          continue;
        }
        let firstSeenBeat = this.trajectoryFirstSeen.get(t as unknown as object);
        if (firstSeenBeat === undefined) {
          firstSeenBeat = beatTime;
          this.trajectoryFirstSeen.set(t as unknown as object, beatTime);
        }
        // Per-target opacity pulse driven by the musical clock. First the
        // line ramps 0 → 1 from when the target appeared up to the next
        // beat boundary, so the very first peak lands ON a beat. After
        // that, it settles into the steady cos pulse between MIN and 1,
        // whose period (RETICULE_TRAJECTORY_PULSE_PERIOD_BEATS beats) is a
        // whole multiple of BEAT_GRID, so subsequent peaks also land on
        // beats.
        const firstPeakBeat =
          Math.ceil((firstSeenBeat + 1e-6) / beatGrid) * beatGrid;
        let pulse01: number;
        if (beatTime < firstPeakBeat) {
          const rampSpan = firstPeakBeat - firstSeenBeat;
          pulse01 = rampSpan > 0 ? (beatTime - firstSeenBeat) / rampSpan : 1;
        } else {
          // cos puts the peak (pulse01 = 1) exactly at firstPeakBeat and at
          // every firstPeakBeat + k*PERIOD after that.
          pulse01 =
            0.5 +
            0.5 *
              Math.cos(((beatTime - firstPeakBeat) / pulsePeriod) * TAU);
        }
        const floor =
          beatTime < firstPeakBeat ? 0 : RETICULE_TRAJECTORY_PULSE_MIN_ALPHA;
        const pulse = floor + (1 - floor) * pulse01;
        ctx.globalAlpha = RETICULE_TRAJECTORY_ALPHA * pulse;
        const cx = reticulePos.x + dx;
        const cy = reticulePos.y + dy;
        const speed = Math.hypot(t.vel.x, t.vel.y);
        if (speed < 1) continue;
        const ux = t.vel.x / speed;
        const uy = t.vel.y / speed;
        // Start the dash just past the leading edge of the object so it
        // visibly emerges from its front, not its centre. For objects whose
        // centre sits outside the radar (only their silhouette overlaps),
        // we'll clip this start forward to wherever the ray enters the disc.
        // The extra pad past `r` keeps the dash from kissing or crossing the
        // silhouette — `r` is a bounding-circle radius and polygonal targets
        // (asteroids) can otherwise nick the line.
        const r = t.radius ?? 0;
        const edgePad = 6;
        const rawStartX = cx + ux * (r + edgePad);
        const rawStartY = cy + uy * (r + edgePad);
        // Solve for the segment of the ray that lies inside the radar disc.
        // |(rawStart + s*u) - reticule|^2 = RADAR_RADIUS^2 → s^2 + 2b s + c = 0.
        const sx = rawStartX - reticulePos.x;
        const sy = rawStartY - reticulePos.y;
        const b = sx * ux + sy * uy;
        const c = sx * sx + sy * sy - radarR2;
        const disc = b * b - c;
        if (disc <= 0) continue;
        const sqrtDisc = Math.sqrt(disc);
        const sExit = -b + sqrtDisc;
        if (sExit <= 0) continue;
        // Clip the start to whichever is further along the ray: the leading
        // edge itself, or the disc-entry point. This handles objects whose
        // centre is outside the radar but body overlaps it — the trajectory
        // is drawn only from the moment it crosses into the circle.
        const sEntry = Math.max(0, -b - sqrtDisc);
        const startX = rawStartX + ux * sEntry;
        const startY = rawStartY + uy * sEntry;
        const endX = rawStartX + ux * sExit;
        const endY = rawStartY + uy * sExit;
        // Linear gradient along the segment: opaque from 0 to
        // RETICULE_TRAJECTORY_FADE_START, then ramps to transparent at the
        // far end so the tip dissolves into the radar boundary.
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
    // Visual scale-up on the beat — purely cosmetic, collision still uses
    // this.radius. Kept small (~8% max) so the silhouette doesn't appear to
    // grow into asteroids during a rhythm window.
    if (beatPulse > 0) {
      const beatScale = 1 + 0.08 * beatPulse;
      ctx.scale(beatScale, beatScale);
    }

    ctx.globalCompositeOperation = "lighter";

    // Combo halo: silhouette-hugging bloom plus expanding shockwave rings.
    // Renders before the ship outline so the ship sits cleanly over the bloom.
    // Intensity is smoothed so the halo fades rather than popping when the
    // streak breaks. Rings are advanced in tickComboHalo, not here.
    if (this.comboHaloIntensity > 0.01 || this.comboRings.length > 0) {
      this.renderComboHalo(ctx, beatPulse);
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
