import { Vec, v, rand, TAU } from "./vec";

// Background pulsar + parallax planets. The pulsar spins continuously (twin
// magnetic-axis beams sweep around the core), pulses softly on every beat,
// and emits a much louder, longer flare on each wave clear, accompanied by
// a deep "brrrmmm" drone. Across waves it grows and drifts toward the screen
// centre, surrounded by a faint pulsar-wind nebula. The two silhouetted
// planets grow much faster than the pulsar (one harder than the other) and
// saturate/darken as they fill more of the frame, selling the "camera is
// approaching the system" feel. All wave-driven values are read from a
// smoothed displayWaveLevel so wave transitions glide rather than snap.

type Vec3 = { x: number; y: number; z: number };

type Planet = {
  // Logical offset from screen center as a fraction of the smaller screen
  // dimension. Drift is applied to angle over time; the radius is what
  // shrinks as waves progress (camera-approach effect).
  baseAngle: number;
  // Radians per second. The two planets have different angular speeds so
  // their silhouettes don't track in lockstep. Kept small so the planets
  // read as distant background drift rather than active orbiters.
  angularSpeed: number;
  // Fractional distance from center (of min(w,h)) at wave 1. Reduced each
  // wave to simulate approach.
  baseRadiusFrac: number;
  // Base on-screen radius (pixels) at approach=0.
  baseSize: number;
  // Per-unit-approach size multiplier. Both planets grow faster than the
  // pulsar; the more prominent planet has a noticeably larger value here so
  // the parallax differential reads.
  growthRate: number;
  // Flat silhouette HSL. Saturation and lightness are recomputed each frame
  // from baseSat/satGrowth/baseLight/lightDrop so the planet darkens and
  // saturates as the camera approaches.
  hue: number;
  baseSat: number;
  satGrowth: number;
  baseLight: number;
  lightDrop: number;
};

export class Pulsar {
  w: number;
  h: number;
  // Position offset from center, in pixels. Starts well off-center so the
  // pulsar feels like a distant landmark; lerps toward (0, 0) as the camera
  // "approaches" across waves.
  baseOffsetX: number;
  baseOffsetY: number;
  // Pulse envelope (0..1). Decays each frame; bumped to a small value on
  // every beat and to 1.0 on each wave clear.
  pulse = 0;
  // Long-form post-wave flare envelope (0..1). Decays slowly over ~20s and
  // drives an additive glow + extra body brightness on top of the regular
  // per-beat pulse.
  flare = 0;
  // Authoritative wave level handed to us by the game. We smoothly lerp
  // displayWaveLevel toward this; all spatial calculations read from
  // displayWaveLevel.
  targetWaveLevel = 1;
  // Smoothed wave level. Lerps toward targetWaveLevel with a ~2s time
  // constant so wave transitions read as a continuous camera drift rather
  // than a snap from one configuration to the next.
  displayWaveLevel = 1;
  // Independent drift time so the planets keep moving even between waves.
  driftT = 0;
  // Continuous rotation phase in radians. Locked to the music via beatTime
  // (one full rotation every 2 beats), so each of the two opposing beams
  // sweeps past any given line of sight once per beat.
  spinAngle = 0;
  // 3D rotation axis of the neutron star, in screen-aligned coordinates
  // (+x right, +y down, +z out of the screen toward the viewer). Chosen to
  // be visibly off-vertical *and* leaning moderately toward the camera, so
  // the cone the magnetic axis sweeps passes through "pointing right at us"
  // and back out to the side — this is what gives the pulsar its 3D /
  // tilted-lighthouse character rather than a flat spinning disc.
  rotAxis: Vec3 = { x: 0.34, y: -0.74, z: 0.57 };
  // Orthonormal basis vectors in the plane perpendicular to rotAxis. Built
  // once in the constructor (rotAxis is fixed) and used to construct the
  // magnetic-axis cone each frame.
  rotAxisU: Vec3 = { x: 1, y: 0, z: 0 };
  rotAxisV: Vec3 = { x: 0, y: 1, z: 0 };
  // Angle between the magnetic axis and the rotation axis. ~60° lets one
  // beam swing all the way from "head-on at the viewer" (mz ≈ 1, bright
  // flash, streak collapses to nothing) round to "partially behind the
  // sphere" (mz < 0, fading out) within a single rotation, with the
  // opposite beam taking over near the back half — i.e. exactly the
  // asymmetric main-pulse / interpulse pattern real pulsars show.
  obliquity = (60 * Math.PI) / 180;
  // Last beat index we've already pulsed for. Tracking this here means the
  // game just hands us `beatTime` and we figure out when to flash without
  // any extra plumbing on the call site.
  lastBeatIndex = -1;
  planets: Planet[];

  // Shockwave state machine. The pulsar occasionally (driven by the game,
  // roughly once every 5 waves) vibrates in place, flashes white-hot, then
  // emits an expanding ring that the game uses as a cue to shatter every
  // asteroid and shudder the ship. Phases:
  //   "idle"       — no shockwave in flight
  //   "vibrating"  — visible jitter ramps up over ~1.2s; nothing else fires
  //   "flashing"   — single-frame trigger: emit the ring, signal callers
  //   "expanding"  — ring grows out to cover the screen, then we go idle
  shockPhase: "idle" | "vibrating" | "flashing" | "expanding" = "idle";
  shockTimer = 0;
  // Extra spin contribution added on top of the music-locked spin during the
  // windup. Integrates an accelerating angular velocity so the pulsar
  // visibly speeds up over several seconds before the drop.
  shockSpinExtra = 0;
  // Where the ring originated (locked when we enter "flashing" so it doesn't
  // drift with pulsar approach mid-expansion). Set on the transition.
  shockOriginX = 0;
  shockOriginY = 0;
  // Pre-computed full-screen radius for the current shockwave so the ring
  // animates at a consistent speed regardless of which corner is farthest.
  shockTargetRadius = 0;
  // Game polls this each frame: true exactly once, on the frame the shock
  // ring is born, so the game can apply impact effects atomically.
  shockJustFired = false;
  // Tuning constants. The long vibrate-then-flash beat is the tension build —
  // the bass-drop white-flash detonation is the payoff.
  static readonly SHOCK_VIBRATE_DURATION = 5.0;
  static readonly SHOCK_FLASH_DURATION = 0.42;
  static readonly SHOCK_EXPAND_DURATION = 1.5;

  // Boss-planet state. planets[0] (the prominent blue one) doubles as the
  // first boss: on the foreshadow wave it swells well past its normal
  // approach curve and grows a cracked, menacing rim so the player reads
  // it as the next threat. On the boss wave itself we hide it entirely —
  // the planetoid has "solidified into the foreground" as the boss asteroid
  // the gameplay system now spawns. After the fight we let it resume its
  // normal drift so subsequent waves don't have a hole in the sky.
  //   "idle"        — normal planet rendering, normal approach
  //   "foreshadow"  — wave just before the boss; planet is closer and ominous
  //   "active"      — boss is in play; planet hidden behind the asteroid
  //   "defeated"    — boss is dead; planet stays hidden until reset
  bossPlanetState: "idle" | "foreshadow" | "active" | "defeated" = "idle";
  // 0..1 envelope for the foreshadow swell. Eases in over a couple of seconds
  // when we enter "foreshadow" so the planet visibly bulges toward the
  // viewer rather than snap-changing on the wave transition.
  bossForeshadow = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    // Place the pulsar off to one side and somewhat above center initially
    // — biased to the upper-third so the ship has clear room mid-screen.
    this.baseOffsetX = -Math.min(w, h) * 0.28;
    this.baseOffsetY = -Math.min(w, h) * 0.18;

    this.planets = [
      // Larger / more prominent planet. Faster size growth and stronger
      // saturation + darkening per unit of approach, so it carries most of
      // the parallax "we're passing close to it" feel.
      {
        baseAngle: rand(0.6, 1.0),
        angularSpeed: 0.0035,
        baseRadiusFrac: 0.38,
        baseSize: 12,
        growthRate: 11,
        hue: 245,
        baseSat: 50,
        satGrowth: 30,
        baseLight: 7,
        lightDrop: 4,
      },
      {
        baseAngle: rand(3.5, 4.2),
        angularSpeed: 0.0072,
        baseRadiusFrac: 0.30,
        baseSize: 8,
        growthRate: 7,
        hue: 20,
        baseSat: 35,
        satGrowth: 15,
        baseLight: 6,
        lightDrop: 2,
      },
    ];

    // Build the (u, v) basis orthogonal to rotAxis. Cross rotAxis with the
    // world-z reference vector; if rotAxis happens to be near-parallel to
    // that (it isn't with the chosen values, but stay defensive in case the
    // axis is ever tweaked) fall back to crossing with world-x instead.
    const ax = this.rotAxis.x;
    const ay = this.rotAxis.y;
    const az = this.rotAxis.z;
    let refX = 0, refY = 0, refZ = 1;
    if (Math.abs(az) > 0.95) { refX = 1; refY = 0; refZ = 0; }
    const ux0 = ay * refZ - az * refY;
    const uy0 = az * refX - ax * refZ;
    const uz0 = ax * refY - ay * refX;
    const ulen = Math.hypot(ux0, uy0, uz0);
    this.rotAxisU = { x: ux0 / ulen, y: uy0 / ulen, z: uz0 / ulen };
    // v = rotAxis × u, already unit length because rotAxis and u are both
    // unit length and perpendicular.
    const ux = this.rotAxisU.x, uy = this.rotAxisU.y, uz = this.rotAxisU.z;
    this.rotAxisV = {
      x: ay * uz - az * uy,
      y: az * ux - ax * uz,
      z: ax * uy - ay * ux,
    };
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  // Per-beat soft pulse. Cheap and gentle — just nudges the envelope up so
  // there's a quiet flicker the player can feel rather than consciously see.
  beat() {
    this.pulse = Math.min(1, this.pulse + 0.35);
  }

  // Big visible+audible pulse at wave clear. Sets the long flare envelope to
  // 1; the renderer reads it as additive glow and extra size.
  waveClear() {
    this.pulse = 1;
    this.flare = 1;
  }

  // Begin a shockwave sequence: vibrate → flash → expanding ring. Idempotent:
  // calling it again while one is in flight is ignored so the game can
  // schedule freely without tracking state itself.
  triggerShockwave() {
    if (this.shockPhase !== "idle") return;
    this.shockPhase = "vibrating";
    this.shockTimer = 0;
    this.shockSpinExtra = 0;
  }

  // True iff the shockwave has reached its flash apex — game uses this to
  // gate other behaviours (e.g. additive screen brightness).
  shockwaveActive(): boolean {
    return this.shockPhase !== "idle";
  }

  // Sets the target wave level for size/position. Going forward by one wave
  // triggers a smooth animated transition. Restarts (target lower than what
  // we're showing) and large jumps snap immediately so the player never sees
  // a several-second rewind of the scene.
  setWaveLevel(wave: number) {
    if (wave < this.targetWaveLevel || wave - this.displayWaveLevel > 1.5) {
      this.displayWaveLevel = wave;
    }
    this.targetWaveLevel = wave;
  }

  update(dt: number, beatTime: number, beatGrid: number) {
    this.driftT += dt;
    // Beat pulse decays quickly (sub-second), so it reads as a heartbeat,
    // not a sustain.
    this.pulse = Math.max(0, this.pulse - dt * 3.0);
    // Wave-clear flare lasts ~20s. Linear decay so the long drone has a
    // visible counterpart for its full duration.
    this.flare = Math.max(0, this.flare - dt / 20);

    this.shockJustFired = false;
    if (this.shockPhase !== "idle") {
      this.shockTimer += dt;
      // Spin-up: integrate an accelerating angular velocity so the pulsar
      // visibly winds itself up over the vibrate window. Quadratic in t
      // means the player reads "it's spinning faster" rather than a constant
      // fast spin. Frozen at the apex while flashing so the moment of impact
      // isn't a blur.
      if (this.shockPhase === "vibrating") {
        const t = Math.min(1, this.shockTimer / Pulsar.SHOCK_VIBRATE_DURATION);
        const omega = TAU * 0.5 + TAU * 18 * t * t;
        this.shockSpinExtra += omega * dt;
      }
      if (this.shockPhase === "vibrating" && this.shockTimer >= Pulsar.SHOCK_VIBRATE_DURATION) {
        const { x, y } = this.pulsarPos();
        this.shockOriginX = x;
        this.shockOriginY = y;
        const corners = [
          Math.hypot(x, y),
          Math.hypot(this.w - x, y),
          Math.hypot(x, this.h - y),
          Math.hypot(this.w - x, this.h - y),
        ];
        this.shockTargetRadius = Math.max(...corners) * 1.05;
        this.shockPhase = "flashing";
        this.shockTimer = 0;
        this.shockJustFired = true;
        // Detonation also retriggers the long flare so the body of the
        // pulsar reads as freshly-energised, not just the ring.
        this.flare = 1;
        this.pulse = 1;
      } else if (this.shockPhase === "flashing" && this.shockTimer >= Pulsar.SHOCK_FLASH_DURATION) {
        this.shockPhase = "expanding";
        this.shockTimer = 0;
      } else if (this.shockPhase === "expanding" && this.shockTimer >= Pulsar.SHOCK_EXPAND_DURATION) {
        this.shockPhase = "idle";
        this.shockTimer = 0;
        this.shockSpinExtra = 0;
      }
    }

    // Smooth wave-level lerp. dt/2.0 gives roughly a 2-second perceptual
    // time constant — visible drift, but settles well before the next wave
    // clear. Clamped at 1 so a frame stall doesn't overshoot.
    const lerpRate = Math.min(1, dt / 2.0);
    this.displayWaveLevel += (this.targetWaveLevel - this.displayWaveLevel) * lerpRate;

    // Boss foreshadow envelope. Ramps to 1 while we're in the foreshadow
    // wave so the planet swells smoothly toward the viewer; decays once we
    // leave that state (boss spawns or the player aborts). About a 3s time
    // constant — slow enough that the player notices the change.
    const foreshadowTarget = this.bossPlanetState === "foreshadow" ? 1 : 0;
    this.bossForeshadow += (foreshadowTarget - this.bossForeshadow) * Math.min(1, dt / 3.0);

    // Spin phase derived directly from beatTime so it stays phase-locked to
    // the music regardless of slow-mo or frame stutter. Period = 2 beats
    // means each of the two opposing beams crosses any given line of sight
    // once per beat (alternating), naturally producing a main-pulse +
    // inter-pulse rhythm at the beat level. shockSpinExtra is added on top
    // during a big windup so the pulsar visibly accelerates past its normal
    // music-locked rotation.
    this.spinAngle = (beatTime / (beatGrid * 2)) * TAU + this.shockSpinExtra;

    // Trigger a soft pulse on each beat tick. Using floor(beatTime / grid)
    // means we'll catch up if multiple beats elapse in a single frame, and
    // it's resilient to slow-mo (caller passes the music-rate beatTime).
    // If beatTime moved backwards (new game reset it to 0 while we were
    // still tracking an older index), rebase so the next beat fires
    // promptly instead of waiting for the clock to catch up.
    const idx = Math.floor(beatTime / beatGrid);
    if (idx < this.lastBeatIndex) this.lastBeatIndex = idx - 1;
    if (idx > this.lastBeatIndex) {
      this.lastBeatIndex = idx;
      this.beat();
    }
  }

  // Camera-approach factor. At wave 1 the pulsar+planets sit at their base
  // distance; each wave brings them closer. Capped so deep runs don't
  // overshoot the screen center.
  private approach(): number {
    return Math.min(0.78, (this.displayWaveLevel - 1) * 0.06);
  }

  // Current pulsar size in pixels. Grows linearly with the approach factor;
  // the per-frame pulse adds a small further bump.
  private currentRadius(): number {
    const approach = this.approach();
    const base = 4 + approach * 26;
    return base * (1 + 0.18 * this.pulse + 0.55 * this.flare);
  }

  private pulsarPos(): { x: number; y: number } {
    const approach = this.approach();
    const cx = this.w / 2;
    const cy = this.h / 2;
    // Lerp base offset toward (0,0) as approach grows. (1 - approach) means
    // wave 1 → full offset; high wave → near center.
    let x = cx + this.baseOffsetX * (1 - approach);
    let y = cy + this.baseOffsetY * (1 - approach);
    // Pre-shockwave vibration: while warming up, jitter the rendered
    // position by an amount that ramps from 0 to ~12px so the player sees
    // a visible "this thing is about to do something" tell. Once we cross
    // into "flashing" the ring is locked to the un-jittered origin captured
    // at the transition (see update), so render-time jitter is gated to the
    // vibrating phase only.
    if (this.shockPhase === "vibrating") {
      const t = Math.min(1, this.shockTimer / Pulsar.SHOCK_VIBRATE_DURATION);
      // Peaks heavy at the apex so the visual tension matches the audio
      // rising into the bass drop.
      const intensity = t * t * 22;
      x += (Math.random() - 0.5) * 2 * intensity;
      y += (Math.random() - 0.5) * 2 * intensity;
    }
    return { x, y };
  }

  // Outward jitter direction the game applies to objects on the frame of
  // the flash. Vector from the shock origin toward the supplied point,
  // normalised; falls back to a random angle for points coincident with
  // the origin so the ship/asteroids always pick up *some* impulse.
  shockwaveImpulseAt(point: Vec): Vec {
    const dx = point.x - this.shockOriginX;
    const dy = point.y - this.shockOriginY;
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) {
      const a = Math.random() * TAU;
      return v(Math.cos(a), Math.sin(a));
    }
    return v(dx / d, dy / d);
  }

  render(ctx: CanvasRenderingContext2D) {
    const approach = this.approach();
    const cx = this.w / 2;
    const cy = this.h / 2;
    const minDim = Math.min(this.w, this.h);
    const { x: ppx, y: ppy } = this.pulsarPos();
    const r = this.currentRadius();
    const beat = this.pulse;
    const flare = this.flare;

    // Pulsar wind nebula — a soft violet/blue wash centred on the pulsar.
    // Drawn *underneath* the planets so their silhouettes occlude it, the
    // way the Crab pulsar sits inside its glowing remnant. Grows with the
    // approach factor and brightens during a wave-clear flare.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const nebulaRadius = r * 14 + minDim * 0.10;
    const nebulaAlpha = 0.06 + 0.08 * approach + 0.10 * flare;
    const nebula = ctx.createRadialGradient(ppx, ppy, 0, ppx, ppy, nebulaRadius);
    nebula.addColorStop(0, `hsla(265, 80%, 55%, ${nebulaAlpha})`);
    nebula.addColorStop(0.4, `hsla(220, 90%, 50%, ${nebulaAlpha * 0.5})`);
    nebula.addColorStop(1, `hsla(220, 90%, 50%, 0)`);
    ctx.fillStyle = nebula;
    ctx.beginPath();
    ctx.arc(ppx, ppy, nebulaRadius, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Planets — flat silhouettes occluding the nebula behind them. Saturation
    // climbs and lightness drops as we approach, so what reads as a faint
    // tinted disc at wave 1 becomes a deep, near-black silhouette with a
    // strong colour cast late game. The "prominent" planet (planets[0]) has
    // larger growthRate / satGrowth / lightDrop than the secondary one.
    // planets[0] also doubles as the first boss; while the boss is active
    // (or defeated and the run is still going) we skip its draw entirely so
    // the boss-asteroid in the foreground is the only thing the player
    // sees from that hue. During the foreshadow wave we paint it much
    // larger and more menacing.
    for (let pi = 0; pi < this.planets.length; pi++) {
      const planet = this.planets[pi];
      const isBossPlanet = pi === 0;
      if (isBossPlanet && (this.bossPlanetState === "active" || this.bossPlanetState === "defeated")) continue;

      const foreshadow = isBossPlanet ? this.bossForeshadow : 0;
      const radiusFrac = planet.baseRadiusFrac * (1 - approach * 0.55) * (1 - foreshadow * 0.4);
      const angle = planet.baseAngle + this.driftT * planet.angularSpeed;
      const px = cx + Math.cos(angle) * radiusFrac * minDim;
      const py = cy + Math.sin(angle) * radiusFrac * minDim * 0.6;
      // Foreshadow nearly doubles the apparent size of the boss planet so it
      // genuinely looms in the wave-9 sky. 2.0× was settled on after smaller
      // values failed to read as "much closer" against the existing approach.
      const size = planet.baseSize * (1 + approach * planet.growthRate) * (1 + foreshadow * 2.0);
      const sat = planet.baseSat + approach * planet.satGrowth;
      const light = Math.max(2, planet.baseLight - approach * planet.lightDrop);

      ctx.fillStyle = `hsl(${planet.hue}, ${sat}%, ${light}%)`;
      ctx.beginPath();
      ctx.arc(px, py, size, 0, TAU);
      ctx.fill();

      if (isBossPlanet && foreshadow > 0.02) this.renderBossPlanetMenace(ctx, px, py, size, foreshadow, planet.hue);
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Outer flare ring — big and faint, only really visible during a wave
    // clear when `flare` is high.
    if (flare > 0.01) {
      const flareRadius = r * (6 + flare * 8);
      const flareGrad = ctx.createRadialGradient(ppx, ppy, 0, ppx, ppy, flareRadius);
      flareGrad.addColorStop(0, `hsla(190, 100%, 80%, ${0.18 * flare})`);
      flareGrad.addColorStop(0.4, `hsla(220, 100%, 70%, ${0.08 * flare})`);
      flareGrad.addColorStop(1, `hsla(220, 100%, 70%, 0)`);
      ctx.fillStyle = flareGrad;
      ctx.beginPath();
      ctx.arc(ppx, ppy, flareRadius, 0, TAU);
      ctx.fill();
    }

    // Medium glow — driven mostly by the per-beat pulse so the heartbeat is
    // visible even between waves.
    const glowRadius = r * (3.2 + beat * 1.5 + flare * 2.0);
    const glow = ctx.createRadialGradient(ppx, ppy, 0, ppx, ppy, glowRadius);
    const glowAlpha = 0.22 + 0.35 * beat + 0.25 * flare;
    glow.addColorStop(0, `hsla(195, 100%, 88%, ${glowAlpha})`);
    glow.addColorStop(0.5, `hsla(210, 100%, 70%, ${glowAlpha * 0.35})`);
    glow.addColorStop(1, `hsla(220, 100%, 60%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(ppx, ppy, glowRadius, 0, TAU);
    ctx.fill();

    // Build the magnetic-axis 3D direction for the current spin phase. The
    // magnetic axis sits at `obliquity` radians off the rotation axis and
    // sweeps around it as spinAngle advances; the opposite end gives the
    // second beam. We render them separately because, with a tilted axis,
    // the two beams have asymmetric visibility — one can be flashing right
    // at us while the other is hidden behind the sphere.
    const cosOb = Math.cos(this.obliquity);
    const sinOb = Math.sin(this.obliquity);
    const cs = Math.cos(this.spinAngle);
    const ss = Math.sin(this.spinAngle);
    const mx = cosOb * this.rotAxis.x + sinOb * (cs * this.rotAxisU.x + ss * this.rotAxisV.x);
    const my = cosOb * this.rotAxis.y + sinOb * (cs * this.rotAxisU.y + ss * this.rotAxisV.y);
    const mz = cosOb * this.rotAxis.z + sinOb * (cs * this.rotAxisU.z + ss * this.rotAxisV.z);
    const beamDirections: Vec3[] = [
      { x: mx, y: my, z: mz },
      { x: -mx, y: -my, z: -mz },
    ];

    // Overall amplitude of the 3D-specific overlays (beam streaks, head-on
    // flash, hot spots). Ramps with approach so early waves read as "barely
    // a hint of rotation on a distant point of light" and the full tilted-
    // lighthouse character only emerges as the camera closes in. Without
    // this every wave reads as equally cinematic and the progression flat-
    // tens out.
    const lighthouseIntensity = 0.15 + 0.85 * approach;

    // Per-beam render: foreshortened streak from the polar cap outward, plus
    // an additive head-on bloom centred on the projected cap when the beam
    // points at the camera. Visibility ramps from 0 at bz ≈ -0.3 (beam tips
    // behind the sphere) to 1 at bz ≥ 0.3 (beam clearly facing us); the
    // streak length is proportional to sqrt(1 - bz²) so it naturally
    // collapses to nothing at head-on while the bloom takes over.
    for (const beamDir of beamDirections) {
      const bx = beamDir.x;
      const by = beamDir.y;
      const bz = beamDir.z;
      const visibility = Math.max(0, Math.min(1, (bz + 0.3) / 0.6));
      if (visibility < 0.02) continue;

      const screenMag = Math.sqrt(Math.max(0, 1 - bz * bz));

      if (screenMag > 0.05) {
        const beamLen3D = r * (5 + flare * 3);
        const beamLenScreen = beamLen3D * screenMag;
        const beamWid = r * 0.45;
        const capX = ppx + bx * r;
        const capY = ppy + by * r;
        ctx.save();
        ctx.translate(capX, capY);
        ctx.rotate(Math.atan2(by, bx));
        const sgrad = ctx.createLinearGradient(0, 0, beamLenScreen, 0);
        const sa = (0.4 + 0.25 * beat + 0.3 * flare) * visibility * lighthouseIntensity;
        sgrad.addColorStop(0, `hsla(190, 100%, 95%, ${sa * 0.7})`);
        sgrad.addColorStop(0.15, `hsla(190, 100%, 95%, ${sa})`);
        sgrad.addColorStop(0.55, `hsla(200, 100%, 85%, ${sa * 0.35})`);
        sgrad.addColorStop(1, `hsla(220, 100%, 70%, 0)`);
        ctx.fillStyle = sgrad;
        ctx.beginPath();
        // Narrow at the cap (apex), widening toward the tip — the beam is a
        // cone of light leaving the surface.
        ctx.moveTo(0, -beamWid * 0.25);
        ctx.lineTo(beamLenScreen, -beamWid * 0.95);
        ctx.lineTo(beamLenScreen, beamWid * 0.95);
        ctx.lineTo(0, beamWid * 0.25);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // Head-on flash. Gated to a relatively narrow window near bz=1 (only
      // when the beam is genuinely close to pointing at us) so it reads as
      // a deliberate "the lighthouse just swept us" moment rather than a
      // continuous beacon. Centred on the projected polar cap, which sits
      // near (but not at) the disc centre when the beam is roughly head-on
      // — that off-centre wander is what sells the "tilted lighthouse"
      // feeling.
      if (bz > 0.55) {
        const headOn = (bz - 0.55) / 0.45;
        const flashX = ppx + bx * r * 0.9;
        const flashY = ppy + by * r * 0.9;
        const flashR = r * (1.2 + 1.6 * headOn);
        const flashA = 0.35 * headOn * (0.6 + 0.4 * beat + 0.3 * flare) * lighthouseIntensity;
        const fgrad = ctx.createRadialGradient(flashX, flashY, 0, flashX, flashY, flashR);
        fgrad.addColorStop(0, `hsla(190, 100%, 98%, ${flashA})`);
        fgrad.addColorStop(0.4, `hsla(200, 100%, 90%, ${flashA * 0.45})`);
        fgrad.addColorStop(1, `hsla(220, 100%, 80%, 0)`);
        ctx.fillStyle = fgrad;
        ctx.beginPath();
        ctx.arc(flashX, flashY, flashR, 0, TAU);
        ctx.fill();
      }
    }

    // Core dot — small, bright, nearly white. This is the actual "star".
    const coreAlpha = 0.7 + 0.3 * beat + 0.3 * flare;
    ctx.fillStyle = `hsla(190, 100%, 96%, ${Math.min(1, coreAlpha)})`;
    ctx.beginPath();
    ctx.arc(ppx, ppy, Math.max(1.2, r * 0.55), 0, TAU);
    ctx.fill();

    // Polar hot spots. Each one sits on the surface at the magnetic pole;
    // in 3D that's at position (±m) * r. The screen projection is just
    // (±mx*r, ±my*r), and we fade them out as their z-component tips behind
    // the sphere so they disappear smoothly at the limb instead of popping.
    // Because the rotation axis is tilted, the two spots trace tilted
    // ellipses on the disc — this is the strongest single cue that the
    // pulsar has a 3D orientation rather than being a flat spinner.
    const hotSpotR = Math.max(0.7, r * 0.15);
    const hotSpotBaseAlpha = Math.min(1, (0.55 + beat * 0.3 + flare * 0.3) * lighthouseIntensity);
    const polarSpotPositions: Vec3[] = [
      { x: mx, y: my, z: mz },
      { x: -mx, y: -my, z: -mz },
    ];
    for (const spot of polarSpotPositions) {
      const spotFade = Math.max(0, Math.min(1, (spot.z + 0.1) / 0.4));
      if (spotFade <= 0) continue;
      const sx = ppx + spot.x * r * 0.85;
      const sy = ppy + spot.y * r * 0.85;
      ctx.fillStyle = `hsla(0, 0%, 100%, ${hotSpotBaseAlpha * spotFade})`;
      ctx.beginPath();
      ctx.arc(sx, sy, hotSpotR, 0, TAU);
      ctx.fill();
    }

    // Hot center pinprick for that pulsar "lighthouse beam" feel.
    ctx.fillStyle = `hsla(0, 0%, 100%, ${Math.min(1, 0.5 + beat * 0.5 + flare * 0.5)})`;
    ctx.beginPath();
    ctx.arc(ppx, ppy, Math.max(0.6, r * 0.22), 0, TAU);
    ctx.fill();

    ctx.restore();

    this.renderShockwave(ctx);
  }

  // Bright flash + expanding ring overlay drawn after the rest of the
  // pulsar so it always sits on top. Separate from the main render path so
  // the regular per-frame draw stays readable.
  private renderShockwave(ctx: CanvasRenderingContext2D) {
    if (this.shockPhase === "idle" || this.shockPhase === "vibrating") return;
    const ox = this.shockOriginX;
    const oy = this.shockOriginY;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    if (this.shockPhase === "flashing") {
      // Blue-tinted bloom centred on the origin, drawn underneath the entity
      // layers. The pure-white wash that actually covers the screen on the
      // bass drop is rendered separately by renderShockwaveOverlay() so it
      // sits above everything else.
      const t = this.shockTimer / Pulsar.SHOCK_FLASH_DURATION;
      const env = Math.sin(Math.min(1, t) * Math.PI);
      const flashRadius = Math.max(this.w, this.h);
      const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, flashRadius * 0.8);
      grad.addColorStop(0, `hsla(195, 100%, 98%, ${0.85 * env})`);
      grad.addColorStop(0.25, `hsla(200, 100%, 80%, ${0.45 * env})`);
      grad.addColorStop(1, `hsla(220, 100%, 60%, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    if (this.shockPhase === "expanding") {
      const t = this.shockTimer / Pulsar.SHOCK_EXPAND_DURATION;
      // Ease-out so the ring lunges outward fast at first and trails into
      // the corners — feels more like a wavefront than a linear sweep.
      const eased = 1 - Math.pow(1 - t, 2);
      const ringRadius = eased * this.shockTargetRadius;
      const alpha = Math.max(0, 1 - t);
      const thickness = 14 + 38 * (1 - t);
      // Outer feathered ring — additive bloom hugging the leading edge.
      const ringGrad = ctx.createRadialGradient(ox, oy, Math.max(0, ringRadius - thickness), ox, oy, ringRadius + thickness * 0.3);
      ringGrad.addColorStop(0, `hsla(210, 100%, 70%, 0)`);
      ringGrad.addColorStop(0.7, `hsla(200, 100%, 80%, ${0.55 * alpha})`);
      ringGrad.addColorStop(1, `hsla(195, 100%, 95%, ${0.9 * alpha})`);
      ctx.fillStyle = ringGrad;
      ctx.beginPath();
      ctx.arc(ox, oy, ringRadius + thickness * 0.3, 0, TAU);
      ctx.arc(ox, oy, Math.max(0, ringRadius - thickness), 0, TAU, true);
      ctx.fill();
      // Crisp bright leading edge so the ring reads even on busy frames.
      ctx.strokeStyle = `hsla(195, 100%, 98%, ${alpha})`;
      ctx.lineWidth = 2.4;
      ctx.shadowColor = `hsla(195, 100%, 80%, 1)`;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(ox, oy, ringRadius, 0, TAU);
      ctx.stroke();
    }

    ctx.restore();
  }

  // Full-screen overlay drawn AFTER all entities so it actually covers the
  // scene — slams the whole frame white on the bass drop. The tinted radial
  // in renderShockwave() stays underneath the entity layers as a coloured
  // backdrop; this is the wash that actually whites out the view.
  renderShockwaveOverlay(ctx: CanvasRenderingContext2D) {
    if (this.shockPhase !== "flashing") return;
    const t = this.shockTimer / Pulsar.SHOCK_FLASH_DURATION;
    // Hold pure white for the first ~30% of the flash window so the moment
    // of impact is unambiguous, then fade linearly back to clear over the
    // remainder — feels like an overload recovering, not a single frame.
    const whiteAlpha = t < 0.3 ? 1 : Math.max(0, 1 - (t - 0.3) / 0.7);
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${whiteAlpha})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }

  // Game tells us where the boss-planet life-cycle sits. Idle is the default;
  // foreshadow runs the wave before the boss spawns so the player has visual
  // warning; active hides the planet entirely while the boss is on the field;
  // defeated locks it hidden so the planetoid that was just shattered doesn't
  // pop back into the sky.
  setBossPlanetState(state: "idle" | "foreshadow" | "active" | "defeated") {
    this.bossPlanetState = state;
  }

  // Current on-screen position of the boss planet (planets[0]). Used by Game
  // to spawn the boss asteroid where the looming planetoid was drifting,
  // so the transition reads as the planet itself solidifying into play
  // rather than a fresh object teleporting in.
  bossPlanetPos(): { x: number; y: number } {
    const planet = this.planets[0];
    const approach = this.approach();
    const foreshadow = this.bossForeshadow;
    const radiusFrac = planet.baseRadiusFrac * (1 - approach * 0.55) * (1 - foreshadow * 0.4);
    const angle = planet.baseAngle + this.driftT * planet.angularSpeed;
    const minDim = Math.min(this.w, this.h);
    return {
      x: this.w / 2 + Math.cos(angle) * radiusFrac * minDim,
      y: this.h / 2 + Math.sin(angle) * radiusFrac * minDim * 0.6,
    };
  }

  // Ominous overlay for the boss planet during its foreshadow wave: faint
  // crimson rim glow, dark surface bands (suggested cracks/craters), and a
  // bright pinprick of "core energy" that pulses with the beat. Drawn after
  // the flat planet silhouette so all of this sits on top of the disc.
  private renderBossPlanetMenace(ctx: CanvasRenderingContext2D, px: number, py: number, size: number, foreshadow: number, hue: number) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Crimson menace rim — a fat ring of glow hugging the silhouette so the
    // planet reads as "lit from within / about to break open". Hue shifts
    // toward red (0..20) so the boss has a distinct colour signature from
    // the cool blue base.
    const rimRadius = size * (1.15 + 0.08 * foreshadow);
    const rim = ctx.createRadialGradient(px, py, size * 0.85, px, py, rimRadius * 1.4);
    rim.addColorStop(0, `hsla(${hue}, 70%, 30%, 0)`);
    rim.addColorStop(0.45, `hsla(15, 95%, 50%, ${0.35 * foreshadow})`);
    rim.addColorStop(0.75, `hsla(0, 100%, 55%, ${0.22 * foreshadow})`);
    rim.addColorStop(1, `hsla(0, 100%, 55%, 0)`);
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(px, py, rimRadius * 1.4, 0, TAU);
    ctx.fill();

    // Pulsing core — beat/flare modulated so the planet visibly throbs in
    // time with the music while it's looming. Sits behind the dark bands so
    // the bands read as fractures backlit by molten core light.
    const coreAlpha = foreshadow * (0.18 + 0.45 * this.pulse + 0.25 * this.flare);
    const coreRadius = size * (0.38 + 0.08 * this.pulse);
    const core = ctx.createRadialGradient(px, py, 0, px, py, coreRadius);
    core.addColorStop(0, `hsla(25, 100%, 75%, ${coreAlpha})`);
    core.addColorStop(0.55, `hsla(10, 100%, 50%, ${coreAlpha * 0.6})`);
    core.addColorStop(1, `hsla(0, 100%, 40%, 0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(px, py, coreRadius, 0, TAU);
    ctx.fill();

    // Dark fracture bands across the disc — sit on top of the menace glow as
    // source-over so they read as deep shadow lines on the surface. Fixed
    // angles per planet would be nice but Planet doesn't carry that state,
    // so we derive a stable per-planet seed from the hue.
    ctx.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.translate(px, py);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.98, 0, TAU);
    ctx.clip();
    ctx.strokeStyle = `rgba(8, 2, 2, ${0.55 * foreshadow})`;
    ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      const seed = hue * 13.7 + i * 41;
      const ang = (seed * 0.013) % TAU;
      const offset = ((seed * 7.3) % 1 - 0.5) * size * 1.1;
      ctx.lineWidth = 1.4 + (i % 2) * 1.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * -size * 1.4 + Math.cos(ang + Math.PI / 2) * offset,
                 Math.sin(ang) * -size * 1.4 + Math.sin(ang + Math.PI / 2) * offset);
      // Jagged 3-segment path so the bands feel like fault lines, not stripes.
      for (let s = -1; s <= 1; s++) {
        const t = s * size * 0.7;
        const jx = Math.cos(ang) * t + Math.cos(ang + Math.PI / 2) * (offset + ((seed * (s + 2)) % 1 - 0.5) * size * 0.18);
        const jy = Math.sin(ang) * t + Math.sin(ang + Math.PI / 2) * (offset + ((seed * (s + 2)) % 1 - 0.5) * size * 0.18);
        ctx.lineTo(jx, jy);
      }
      ctx.lineTo(Math.cos(ang) * size * 1.4 + Math.cos(ang + Math.PI / 2) * offset,
                 Math.sin(ang) * size * 1.4 + Math.sin(ang + Math.PI / 2) * offset);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
  }
}
