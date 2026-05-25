import { Ship } from "./Ship";
import { Asteroid, AsteroidKind, BASS_BEAT_INTERVAL, BASS_PHASE_OFFSET, spawnAsteroidAtEdge } from "./Asteroid";
import { Bullet } from "./Bullet";
import { ParticleSystem } from "./Particle";
import { Shard, shatterAsteroid } from "./Shard";
import { Starfield } from "./Starfield";
import { Input } from "./Input";
import { Sound } from "./Sound";
import { Canister, spawnCanister } from "./Canister";
import { v, fromAngle, dist, rand, TAU } from "./vec";

type GameState = "title" | "playing" | "paused" | "dying" | "gameover";

// Combo grid is half the bass interval so it lines up with the interlocked
// bassA/bassB hits the player actually hears (bassA on whole seconds, bassB
// on half-seconds). Window is ±150ms — wide enough to absorb the 50ms dt cap
// in main.ts plus normal human timing slop, narrow enough that random
// spam-firing only marks ~half of beats.
const BEAT_GRID = 0.5;
const BEAT_WINDOW = 0.15;
// Each successive on-beat step adds +0.5 to the kill multiplier, capped so a
// long streak doesn't trivialise high-wave scoring.
const COMBO_MULTIPLIER_STEP = 0.5;
const COMBO_MULTIPLIER_MAX = 5;

// Powerup canister spawn rules. We roll once per wave; if it lands, we
// schedule the canister somewhere mid-wave so it can't appear right at the
// start (player still warming up) or right at the end (player already
// closing out the wave). Slow-mo affects asteroid update dt only — the
// player and bullets keep their normal speed so it feels like a "bullet
// time" advantage rather than a global pause.
const CANISTER_CHANCE_PER_WAVE = 1 / 3;
const CANISTER_SPAWN_WINDOW: [number, number] = [8, 24];
const SLOW_MO_DURATION = 8;
const SLOW_MO_FACTOR = 0.45;

// Rare crystal "tink" asteroid: rolled once per wave starting at wave 3.
// Single small one-shot that emits the sharp glassy tink on destruction.
// Kept off the standard specialUnlockOrder so its appearance feels like a
// treat rather than a guaranteed wave fixture.
const TINK_FIRST_WAVE = 3;
const TINK_CHANCE_PER_WAVE = 1 / 3;

export class Game {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  input: Input;
  sound: Sound;
  starfield: Starfield;
  particles = new ParticleSystem();
  shards: Shard[] = [];
  ship: Ship;
  asteroids: Asteroid[] = [];
  bullets: Bullet[] = [];
  score = 0;
  wave = 1;
  lives = 3;
  state: GameState = "title";
  dyingTimer = 0;
  shake = 0;
  shakeSeed = 0;
  w = 0;
  h = 0;
  dpr = 1;
  time = 0;
  // Shared bass-beat clock (seconds). All bass asteroids align to this grid
  // so their kicks and plucks interlock musically. Also serves as the source
  // of truth for on-beat detection — using the same clock the audio fires
  // from means a frame stutter slows beat audio and combo tracking together,
  // so they stay in lockstep.
  beatTime = 0;
  // Index of the most recent beat the player marked with a fire or kill.
  // Marks arrive in increasing index order because BEAT_WINDOW < BEAT_GRID/2,
  // so consecutive windows never overlap.
  lastMarkedBeatIndex = -1;
  // Next beat index whose closing-window time we haven't yet checked. Beats
  // are evaluated in order; an unmarked beat that closes resets the combo.
  nextBeatToEvaluate = 0;
  beatCombo = 0;

  canisters: Canister[] = [];
  // null when this wave didn't roll a canister or the canister has already
  // been spawned. When non-null it's the in-wave time (seconds) at which to
  // spawn. Set in spawnWave; cleared the moment the canister appears.
  canisterSpawnAt: number | null = null;
  waveElapsed = 0;
  slowMoTimer = 0;

  scoreEl: HTMLElement;
  comboEl: HTMLElement;
  comboValueEl: HTMLElement;
  waveEl: HTMLElement;
  livesEl: HTMLElement;
  overlayEl: HTMLElement;
  overlayTitleEl: HTMLElement;
  overlayStartEl: HTMLElement;
  muteEl: HTMLButtonElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.input = new Input();
    this.sound = new Sound();
    this.resize();
    this.starfield = new Starfield(this.w, this.h);
    this.ship = new Ship(v(this.w / 2, this.h / 2));
    window.addEventListener("resize", () => this.resize());

    this.scoreEl = document.getElementById("score")!;
    this.comboEl = document.getElementById("combo")!;
    this.comboValueEl = document.getElementById("combo-value")!;
    this.waveEl = document.getElementById("wave")!;
    this.livesEl = document.getElementById("lives")!;
    this.overlayEl = document.getElementById("overlay")!;
    this.overlayTitleEl = document.getElementById("overlay-title")!;
    this.overlayStartEl = document.getElementById("overlay-start")!;
    this.muteEl = document.getElementById("mute") as HTMLButtonElement;
    this.muteEl.addEventListener("click", () => this.toggleMute());
    window.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "m" && this.state !== "title") this.toggleMute();
    });
    this.showTitle();
  }

  toggleMute() {
    this.sound.setEnabled(!this.sound.enabled);
    this.muteEl.classList.toggle("muted", !this.sound.enabled);
    this.muteEl.textContent = this.sound.enabled ? "♪" : "✕";
  }

  togglePause() {
    if (this.state === "playing") {
      this.state = "paused";
      this.ship.thrustOn = false;
      this.sound.stopThrust();
      this.overlayTitleEl.textContent = "Paused";
      this.overlayStartEl.innerHTML = 'press <span class="key">esc</span> to resume';
      this.overlayEl.classList.remove("hidden");
    } else if (this.state === "paused") {
      this.state = "playing";
      this.overlayEl.classList.add("hidden");
    }
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.starfield) this.starfield.resize(this.w, this.h);
  }

  showTitle() {
    this.state = "title";
    this.overlayTitleEl.textContent = "Pulsar";
    this.overlayStartEl.innerHTML = 'press <span class="key">enter</span> to begin';
    this.overlayEl.classList.remove("hidden");
    this.beatCombo = 0;
    this.syncComboHud();
    this.asteroids = [];
    this.canisters = [];
    this.canisterSpawnAt = null;
    this.slowMoTimer = 0;
    const decorativeAsteroidIndices = [0, 1, 2, 3, 4];
    for (const _ of decorativeAsteroidIndices) {
      this.asteroids.push(spawnAsteroidAtEdge(this.w, this.h));
    }
  }

  startGame() {
    this.sound.resume();
    this.state = "playing";
    this.score = 0;
    this.wave = 1;
    this.lives = 3;
    this.beatTime = 0;
    this.lastMarkedBeatIndex = -1;
    this.nextBeatToEvaluate = 0;
    this.beatCombo = 0;
    this.bullets = [];
    this.shards = [];
    this.canisters = [];
    this.slowMoTimer = 0;
    this.particles = new ParticleSystem();
    this.ship = new Ship(v(this.w / 2, this.h / 2));
    this.ship.invuln = 2.0;
    this.spawnWave();
    this.overlayEl.classList.add("hidden");
    this.syncHud();
  }

  // Snap an asteroid's next beat to the global grid for its kind, accounting
  // for its current tempoMultiplier. Called when spawning bass asteroids or
  // when bass parents split into doubled-tempo children.
  alignBassBeat(asteroid: Asteroid) {
    if (asteroid.kind !== "bassA" && asteroid.kind !== "bassB") return;
    const interval = BASS_BEAT_INTERVAL / asteroid.tempoMultiplier;
    const offset = BASS_PHASE_OFFSET[asteroid.kind] / asteroid.tempoMultiplier;
    const k = Math.ceil((this.beatTime - offset - 1e-6) / interval);
    asteroid.nextBeatAt = k * interval + offset;
  }

  spawnSpecial(kind: AsteroidKind): Asteroid {
    let a = spawnAsteroidAtEdge(this.w, this.h, undefined, kind);
    while (dist(a.pos, this.ship.pos) < 220) {
      a = spawnAsteroidAtEdge(this.w, this.h, undefined, kind);
    }
    this.alignBassBeat(a);
    return a;
  }

  spawnWave() {
    this.asteroids = [];
    this.canisters = [];
    this.waveElapsed = 0;
    // Roll once per wave. Any canister still on screen from a previous wave
    // is wiped above so the player never sees two at once.
    if (Math.random() < CANISTER_CHANCE_PER_WAVE) {
      this.canisterSpawnAt = rand(CANISTER_SPAWN_WINDOW[0], CANISTER_SPAWN_WINDOW[1]);
    } else {
      this.canisterSpawnAt = null;
    }
    const wave = this.wave;
    // Total asteroid count grows by 1 every other wave: 4, 4, 5, 5, 6, 6, ...
    const totalCount = 4 + Math.floor((wave - 1) / 2);

    // Special types unlock one at a time, every other wave, alternating bass
    // and decorative so the soundscape layers in gradually. Caps at 5 so the
    // field never tips over into all-specials.
    const specialUnlockOrder: AsteroidKind[] = ["bassA", "chime", "bassB", "bell", "warble"];
    const activeSpecials = specialUnlockOrder.slice(0, Math.min(specialUnlockOrder.length, Math.floor(wave / 2)));
    const normalCount = Math.max(0, totalCount - activeSpecials.length);

    const newAsteroidIndices = Array.from({ length: normalCount }, (_, i) => i);
    for (const _ of newAsteroidIndices) {
      let a = spawnAsteroidAtEdge(this.w, this.h);
      while (dist(a.pos, this.ship.pos) < 200) {
        a = spawnAsteroidAtEdge(this.w, this.h);
      }
      this.asteroids.push(a);
    }

    for (const kind of activeSpecials) {
      this.asteroids.push(this.spawnSpecial(kind));
    }

    if (wave >= TINK_FIRST_WAVE && Math.random() < TINK_CHANCE_PER_WAVE) {
      this.asteroids.push(this.spawnTink());
    }
  }

  spawnTink(): Asteroid {
    let a = spawnAsteroidAtEdge(this.w, this.h, undefined, "tink", "small");
    while (dist(a.pos, this.ship.pos) < 200) {
      a = spawnAsteroidAtEdge(this.w, this.h, undefined, "tink", "small");
    }
    return a;
  }

  syncHud() {
    this.scoreEl.textContent = String(this.score).padStart(6, "0");
    this.waveEl.textContent = `WAVE ${this.wave}`;
    const lifeSpans: string[] = [];
    for (let i = 0; i < this.lives; i++) lifeSpans.push("<span></span>");
    this.livesEl.innerHTML = lifeSpans.join("");
    this.syncComboHud();
  }

  syncComboHud() {
    if (this.beatCombo >= 2) {
      this.comboEl.classList.remove("hidden");
      this.comboValueEl.textContent = String(this.beatCombo);
    } else {
      this.comboEl.classList.add("hidden");
    }
  }

  // Re-trigger the combo CSS keyframe by toggling the class. Reading
  // offsetWidth forces a synchronous reflow between remove and add, which is
  // the standard idiom for restarting a CSS animation on demand.
  pulseComboHud() {
    this.syncComboHud();
    if (this.comboEl.classList.contains("hidden")) return;
    this.comboEl.classList.remove("beat-pulse");
    void this.comboEl.offsetWidth;
    this.comboEl.classList.add("beat-pulse");
  }

  // Visual metronome strength at the current beatTime: 1 at a beat center,
  // falling linearly to 0 at the edge of the same ±BEAT_WINDOW used by
  // markBeat. Returning >0 here is exactly the condition under which a shot
  // fired this frame would be counted as a rhythm-shot, so the ship's pulse
  // is a literal preview of the rhythm window. Zero on title/pause/gameover
  // because beatTime isn't advancing there and we don't want a frozen flash.
  currentBeatPulse(): number {
    if (this.state !== "playing" && this.state !== "dying") return 0;
    const beatPhase = this.beatTime / BEAT_GRID;
    const beatsFromNearestBeat = Math.abs(beatPhase - Math.round(beatPhase));
    const windowFractionOfGrid = BEAT_WINDOW / BEAT_GRID;
    return Math.max(0, 1 - beatsFromNearestBeat / windowFractionOfGrid);
  }

  // Try to associate `time` with the nearest beat on the global 0.5s grid.
  // Returns true iff this call is the first activity inside that beat's
  // window — that's the signal we use to decide whether to play the on-beat
  // tick / sparkle and to count the beat for combo display purposes.
  markBeat(time: number): boolean {
    const beatIndex = Math.round(time / BEAT_GRID);
    const beatCenter = beatIndex * BEAT_GRID;
    if (Math.abs(time - beatCenter) > BEAT_WINDOW) return false;
    if (beatIndex < this.nextBeatToEvaluate) return false;
    if (beatIndex === this.lastMarkedBeatIndex) return false;
    if (beatIndex === this.lastMarkedBeatIndex + 1) {
      this.beatCombo += 1;
    } else {
      // A gap means at least one beat between the previous mark and now
      // closed unmarked; the evaluator will already have reset combo to 0
      // when that closure was processed, so we restart the streak at 1.
      this.beatCombo = 1;
    }
    this.lastMarkedBeatIndex = beatIndex;
    return true;
  }

  // Walk through every beat whose closing edge has passed beatTime. Marked
  // beats are no-ops (combo was already incremented in markBeat); unmarked
  // beats reset the combo. The while-loop catches up cleanly even if a
  // future change to main.ts's dt cap lets multiple beats close in a single
  // frame.
  evaluateClosedBeats() {
    while (this.nextBeatToEvaluate * BEAT_GRID + BEAT_WINDOW <= this.beatTime) {
      if (this.lastMarkedBeatIndex < this.nextBeatToEvaluate) {
        if (this.beatCombo !== 0) {
          this.beatCombo = 0;
          this.syncComboHud();
        }
      }
      this.nextBeatToEvaluate += 1;
    }
  }

  update(dt: number) {
    if (this.input.pressed("escape") || this.input.pressed("esc")) this.togglePause();
    if (this.state === "paused") {
      this.input.endFrame();
      return;
    }

    this.time += dt * 1000;

    if (this.state === "title") {
      if (this.input.pressed("enter") || this.input.pressed("return")) {
        this.startGame();
      }
      for (const a of this.asteroids) a.update(dt, this.w, this.h);
      this.particles.update(dt);
    } else if (this.state === "gameover") {
      if (this.input.pressed("enter") || this.input.pressed("return")) {
        this.showTitle();
      }
      for (const a of this.asteroids) a.update(dt, this.w, this.h);
      for (const s of this.shards) s.update(dt);
      this.shards = this.shards.filter((s) => s.life > 0);
      this.particles.update(dt);
    } else if (this.state === "dying") {
      this.dyingTimer -= dt;
      for (const a of this.asteroids) a.update(dt, this.w, this.h);
      for (const b of this.bullets) b.update(dt, this.w, this.h);
      this.bullets = this.bullets.filter((b) => b.life > 0);
      for (const s of this.shards) s.update(dt);
      this.shards = this.shards.filter((s) => s.life > 0);
      this.particles.update(dt);
      if (this.dyingTimer <= 0) {
        if (this.lives <= 0) {
          this.state = "gameover";
          this.overlayTitleEl.textContent = "Game Over";
          this.overlayStartEl.innerHTML = `score <strong>${String(this.score).padStart(6, "0")}</strong> &nbsp;·&nbsp; press <span class="key">enter</span> to restart`;
          this.overlayEl.classList.remove("hidden");
        } else {
          this.respawn();
        }
      }
    } else {
      const bulletsBeforeShipUpdate = this.bullets.length;
      this.ship.update(dt, this.input, this.particles, this.bullets, this.w, this.h, this.time, this.sound);
      // tickBassBeats advances beatTime; we need that advance to land before
      // we time-stamp any shot fired this frame, so on-beat detection lines
      // up with the same beatTime that any bass audio on this frame fired at.
      this.tickBassBeats(dt);
      if (this.bullets.length > bulletsBeforeShipUpdate) {
        // Ship's fireRate (0.22s base, 0.088s under rapid) exceeds the dt cap
        // (0.05s) so at most ONE fire event lands per frame — but trident
        // emits 3 bullets per fire event, so the slice length can be >1.
        // They all share the same beat flag because they're one shot.
        const newBullets = this.bullets.slice(bulletsBeforeShipUpdate);
        if (this.markBeat(this.beatTime)) {
          for (const newBullet of newBullets) newBullet.onBeat = true;
          this.sound.play("comboTick");
          this.pulseComboHud();
        }
      }
      if (this.ship.invuln > 0 && this.ship.invuln < 0.4) {
        const safeRadius = 130;
        const asteroidsNearShip = this.asteroids.filter((a) => dist(a.pos, this.ship.pos) < safeRadius);
        if (asteroidsNearShip.length > 0) this.ship.invuln = 0.4;
      }
      this.waveElapsed += dt;
      if (this.canisterSpawnAt !== null && this.waveElapsed >= this.canisterSpawnAt) {
        this.canisters.push(spawnCanister(this.w, this.h, this.ship.pos));
        this.canisterSpawnAt = null;
      }
      if (this.slowMoTimer > 0) this.slowMoTimer = Math.max(0, this.slowMoTimer - dt);
      const asteroidDt = this.slowMoTimer > 0 ? dt * SLOW_MO_FACTOR : dt;
      for (const a of this.asteroids) a.update(asteroidDt, this.w, this.h);
      for (const b of this.bullets) b.update(dt, this.w, this.h);
      this.bullets = this.bullets.filter((b) => b.life > 0);
      for (const s of this.shards) s.update(dt);
      this.shards = this.shards.filter((s) => s.life > 0);
      for (const c of this.canisters) c.update(dt, this.w, this.h);
      this.particles.update(dt);
      this.handleCollisions();
      this.handleCanisterPickups();
      // Run after collisions so any beat marked by a kill this frame is
      // visible to the evaluator if its window happens to close on the same
      // frame (rare, but possible at the trailing edge).
      this.evaluateClosedBeats();
      if (this.asteroids.length === 0) {
        this.wave += 1;
        this.sound.play("waveClear");
        this.spawnWave();
        this.syncHud();
      }
    }

    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3);
    this.input.endFrame();
  }

  respawn() {
    this.ship = new Ship(v(this.w / 2, this.h / 2));
    this.ship.invuln = 2.2;
    this.state = "playing";
    this.syncHud();
  }

  tickBassBeats(dt: number) {
    this.beatTime += dt;
    for (const a of this.asteroids) {
      if (a.kind !== "bassA" && a.kind !== "bassB") continue;
      const interval = BASS_BEAT_INTERVAL / a.tempoMultiplier;
      // Fire any beats that have elapsed since the last frame (typically one,
      // but defensively handle multi-step in case dt spiked).
      while (this.beatTime >= a.nextBeatAt) {
        this.sound.play(a.kind === "bassA" ? "bassKick" : "bassPluck");
        a.flashAmount = 1.0;
        a.nextBeatAt += interval;
      }
    }
  }

  handleCollisions() {
    const surviving: Asteroid[] = [];
    for (const a of this.asteroids) {
      let killed = false;
      for (const b of this.bullets) {
        if (b.life <= 0) continue;
        if (a.collidesWith(b.pos, b.radius)) {
          // Pierce bullets stay alive after a kill so a single shot can punch
          // through a row of asteroids. Their `life` timer still expires
          // normally, so they don't last forever.
          if (!b.pierce) b.life = 0;
          // A kill counts as on-beat if EITHER the bullet was fired on the
          // beat OR the impact itself lands in a beat window. The fire-time
          // case keeps long-range shots fair (a timed shot that drifts to a
          // far asteroid still earns its bonus), and the impact-time case
          // covers point-blank kills where the player times the destruction
          // rather than the trigger pull.
          const killMarkedBeat = this.markBeat(this.beatTime);
          const isOnBeatKill = killMarkedBeat || b.onBeat;
          let scoreEarned = a.scoreValue();
          if (isOnBeatKill) {
            const multiplier = Math.min(1 + this.beatCombo * COMBO_MULTIPLIER_STEP, COMBO_MULTIPLIER_MAX);
            scoreEarned = Math.round(scoreEarned * multiplier);
            this.sound.play("comboSparkle");
            if (killMarkedBeat) this.pulseComboHud();
          }
          this.score += scoreEarned;
          this.shake = Math.min(this.shake + 0.4, 1.2);
          this.sound.play(this.hitSoundFor(a));
          this.emitExplosion(a, isOnBeatKill);
          const children = a.split();
          for (const c of children) {
            this.alignBassBeat(c);
            surviving.push(c);
          }
          killed = true;
          break;
        }
      }
      if (!killed) surviving.push(a);
    }
    this.asteroids = surviving;

    if (this.ship.alive && this.ship.invuln <= 0) {
      for (const a of this.asteroids) {
        if (a.collidesWith(this.ship.pos, this.ship.radius * 0.6)) {
          if (this.ship.shieldActive) {
            this.ship.shieldActive = false;
            this.ship.invuln = 0.8;
            this.popShield();
          } else {
            this.killShip();
          }
          break;
        }
      }
    }
    this.syncHud();
  }

  popShield() {
    this.sound.play("shieldPop");
    this.shake = Math.min(this.shake + 0.2, 1.2);
    const ringIndices = Array.from({ length: 28 }, (_, i) => i);
    for (const i of ringIndices) {
      const angle = (i / ringIndices.length) * TAU;
      const speed = rand(180, 260);
      this.particles.emit({
        pos: { ...this.ship.pos },
        vel: fromAngle(angle, speed),
        life: rand(0.35, 0.65),
        maxLife: 0.65,
        size: rand(1.6, 2.4),
        hue: 200 + rand(-8, 12),
        shrink: 1,
        drag: 1.8,
      });
    }
  }

  handleCanisterPickups() {
    if (!this.ship.alive) return;
    const remaining: Canister[] = [];
    for (const c of this.canisters) {
      if (c.collidesWith(this.ship.pos, this.ship.radius * 0.9)) {
        this.collectCanister(c);
      } else {
        remaining.push(c);
      }
    }
    this.canisters = remaining;
  }

  collectCanister(c: Canister) {
    this.sound.play("powerup");
    if (c.kind === "slow") {
      this.slowMoTimer = SLOW_MO_DURATION;
    } else {
      this.ship.applyPowerup(c.kind);
    }
    const burstIndices = Array.from({ length: 36 }, (_, i) => i);
    for (const _ of burstIndices) {
      const angle = rand(0, TAU);
      const speed = rand(80, 260);
      this.particles.emit({
        pos: { ...c.pos },
        vel: fromAngle(angle, speed),
        life: rand(0.5, 1.0),
        maxLife: 1.0,
        size: rand(1.4, 2.6),
        hue: c.hue + rand(-10, 20),
        shrink: 1,
        drag: 1.6,
      });
    }
  }

  hitSoundFor(a: Asteroid): "explosionLarge" | "explosionMedium" | "explosionSmall" | "bassHit" | "chime" | "bell" | "warble" | "tink" {
    // Bass-large emits the "cool initial noise" announcing the doubled-tempo
    // split; the medium pieces fall back to a regular explosion thud.
    if (a.isBass()) {
      return a.size === "large" ? "bassHit" : "explosionMedium";
    }
    if (a.kind === "chime") return "chime";
    if (a.kind === "bell") return "bell";
    if (a.kind === "warble") return "warble";
    if (a.kind === "tink") return "tink";
    return a.size === "large" ? "explosionLarge" : a.size === "medium" ? "explosionMedium" : "explosionSmall";
  }

  emitExplosion(a: Asteroid, onBeat: boolean) {
    const newShards = shatterAsteroid(a);
    for (const s of newShards) this.shards.push(s);
    const baseCount = a.size === "large" ? 60 : a.size === "medium" ? 40 : 24;
    const particleCount = onBeat ? Math.round(baseCount * 1.6) : baseCount;
    const explosionParticleIndices = Array.from({ length: particleCount }, (_, i) => i);
    for (const _ of explosionParticleIndices) {
      const angle = rand(0, TAU);
      const speed = rand(80, 320);
      this.particles.emit({
        pos: { ...a.pos },
        vel: fromAngle(angle, speed),
        life: rand(0.5, 1.4),
        maxLife: 1.4,
        size: rand(1, 2.6),
        hue: a.hue + rand(-15, 25),
        shrink: 1,
        drag: 1.5,
      });
    }
    if (onBeat) {
      // Gold sparkle ring at the impact site so beat-kills read instantly,
      // even when the underlying asteroid's hue is similar to the explosion.
      const sparkleIndices = Array.from({ length: 18 }, (_, i) => i);
      for (const i of sparkleIndices) {
        const angle = (i / sparkleIndices.length) * TAU + rand(-0.05, 0.05);
        const speed = rand(220, 360);
        this.particles.emit({
          pos: { ...a.pos },
          vel: fromAngle(angle, speed),
          life: rand(0.35, 0.7),
          maxLife: 0.7,
          size: rand(1.6, 2.4),
          hue: 48 + rand(-6, 12),
          shrink: 1,
          drag: 1.8,
        });
      }
    }
  }

  killShip() {
    this.lives -= 1;
    this.shake = 1.5;
    this.state = "dying";
    this.dyingTimer = 1.8;
    // Death pauses beatTime (no tickBassBeats in the dying branch), so any
    // current streak would otherwise stay pinned on the HUD until respawn.
    // Drop it now: the player wasn't shooting on beats while dying.
    this.beatCombo = 0;
    this.lastMarkedBeatIndex = -1;
    this.syncComboHud();
    this.sound.stopThrust();
    this.sound.play("death");
    const debrisParticleIndices = Array.from({ length: 70 }, (_, i) => i);
    for (const _ of debrisParticleIndices) {
      const angle = rand(0, TAU);
      const speed = rand(60, 280);
      this.particles.emit({
        pos: { ...this.ship.pos },
        vel: fromAngle(angle, speed),
        life: rand(0.7, 1.6),
        maxLife: 1.6,
        size: rand(1.2, 2.6),
        hue: 195 + rand(-10, 30),
        shrink: 1,
        drag: 1.2,
      });
    }
    this.ship.alive = false;
  }

  render() {
    const { ctx, w, h } = this;
    let shakeX = 0;
    let shakeY = 0;
    if (this.shake > 0) {
      this.shakeSeed += 1;
      shakeX = (Math.random() - 0.5) * this.shake * 10;
      shakeY = (Math.random() - 0.5) * this.shake * 10;
    }

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#02030a";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(shakeX, shakeY);

    this.starfield.render(ctx, this.time);

    for (const s of this.shards) s.render(ctx);
    for (const a of this.asteroids) a.render(ctx, this.time);
    for (const c of this.canisters) c.render(ctx, this.time);
    for (const b of this.bullets) b.render(ctx);
    this.particles.render(ctx);
    this.ship.render(ctx, this.time, this.currentBeatPulse());

    ctx.restore();
  }
}
