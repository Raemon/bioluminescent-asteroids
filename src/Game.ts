import { Ship } from "./Ship";
import { Asteroid, spawnAsteroidAtEdge } from "./Asteroid";
import { Bullet } from "./Bullet";
import { ParticleSystem } from "./Particle";
import { Shard, shatterAsteroid } from "./Shard";
import { Starfield } from "./Starfield";
import { Input } from "./Input";
import { Sound } from "./Sound";
import { v, fromAngle, dist, rand, TAU } from "./vec";

type GameState = "title" | "playing" | "dying" | "gameover";

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

  scoreEl: HTMLElement;
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
    this.overlayTitleEl.textContent = "Bioluminescent Asteroids";
    this.overlayStartEl.innerHTML = 'press <span class="key">enter</span> to begin';
    this.overlayEl.classList.remove("hidden");
    this.asteroids = [];
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
    this.bullets = [];
    this.shards = [];
    this.particles = new ParticleSystem();
    this.ship = new Ship(v(this.w / 2, this.h / 2));
    this.ship.invuln = 2.0;
    this.spawnWave();
    this.overlayEl.classList.add("hidden");
    this.syncHud();
  }

  spawnWave() {
    this.asteroids = [];
    const count = 3 + this.wave;
    const newAsteroidIndices = Array.from({ length: count }, (_, i) => i);
    for (const _ of newAsteroidIndices) {
      let a = spawnAsteroidAtEdge(this.w, this.h);
      while (dist(a.pos, this.ship.pos) < 200) {
        a = spawnAsteroidAtEdge(this.w, this.h);
      }
      this.asteroids.push(a);
    }
  }

  syncHud() {
    this.scoreEl.textContent = String(this.score).padStart(6, "0");
    this.waveEl.textContent = `WAVE ${this.wave}`;
    const lifeSpans: string[] = [];
    for (let i = 0; i < this.lives; i++) lifeSpans.push("<span></span>");
    this.livesEl.innerHTML = lifeSpans.join("");
  }

  update(dt: number) {
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
      this.ship.update(dt, this.input, this.particles, this.bullets, this.w, this.h, this.time, this.sound);
      if (this.ship.invuln > 0 && this.ship.invuln < 0.4) {
        const safeRadius = 130;
        const asteroidsNearShip = this.asteroids.filter((a) => dist(a.pos, this.ship.pos) < safeRadius);
        if (asteroidsNearShip.length > 0) this.ship.invuln = 0.4;
      }
      for (const a of this.asteroids) a.update(dt, this.w, this.h);
      for (const b of this.bullets) b.update(dt, this.w, this.h);
      this.bullets = this.bullets.filter((b) => b.life > 0);
      for (const s of this.shards) s.update(dt);
      this.shards = this.shards.filter((s) => s.life > 0);
      this.particles.update(dt);
      this.handleCollisions();
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

  handleCollisions() {
    const surviving: Asteroid[] = [];
    for (const a of this.asteroids) {
      let killed = false;
      for (const b of this.bullets) {
        if (b.life <= 0) continue;
        if (a.collidesWith(b.pos, b.radius)) {
          b.life = 0;
          this.score += a.scoreValue();
          this.shake = Math.min(this.shake + 0.4, 1.2);
          const explosionSoundBySize = { large: "explosionLarge", medium: "explosionMedium", small: "explosionSmall" } as const;
          this.sound.play(explosionSoundBySize[a.size]);
          this.emitExplosion(a);
          const children = a.split();
          for (const c of children) surviving.push(c);
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
          this.killShip();
          break;
        }
      }
    }
    this.syncHud();
  }

  emitExplosion(a: Asteroid) {
    const newShards = shatterAsteroid(a);
    for (const s of newShards) this.shards.push(s);
    const particleCount = a.size === "large" ? 60 : a.size === "medium" ? 40 : 24;
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
  }

  killShip() {
    this.lives -= 1;
    this.shake = 1.5;
    this.state = "dying";
    this.dyingTimer = 1.8;
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
    for (const b of this.bullets) b.render(ctx);
    this.particles.render(ctx);
    this.ship.render(ctx, this.time);

    ctx.restore();
  }
}
