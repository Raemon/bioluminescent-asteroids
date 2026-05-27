import { Ship } from "./Ship";
import { Asteroid, AsteroidKind } from "./Asteroid";
import { Bullet } from "./Bullet";
import { ParticleSystem } from "./Particle";
import { Shard } from "./Shard";
import { Starfield } from "./Starfield";
import { Pulsar } from "./Pulsar";
import { Input } from "./Input";
import { Sound } from "./Sound";
import { Canister } from "./Canister";
import { Comet } from "./Comet";
import { Alien, AlienSize } from "./Alien";
import { AlienBullet } from "./AlienBullet";
import { v } from "./vec";
import { Popup } from "./game/popups";
import { KilledSnapshot } from "./game/killSnapshot";
import { ParadeEntry } from "./game/killedParade";
import { WaveEventSchedule, newWaveEventSchedule } from "./game/waveEvents";
import { HudElements, bindHudElements } from "./game/hud";
import { showTitle, toggleMute, abortMission } from "./game/lifecycle";
import { updateGame } from "./game/gameUpdate";
import { renderGame } from "./game/gameRender";

// Why: re-export so existing external imports (Ship.ts) keep working without touching their imports.
export { BEAT_GRID } from "./game/rhythmConstants";

type GameState = "title" | "playing" | "paused" | "dying" | "gameover";

// Why: Game holds the cross-cutting state every helper in src/game/* reads; behavior lives in modules.
export class Game implements HudElements {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  input: Input;
  sound: Sound;
  starfield: Starfield;
  pulsar: Pulsar;
  particles = new ParticleSystem();
  shards: Shard[] = [];
  ship: Ship;
  asteroids: Asteroid[] = [];
  bullets: Bullet[] = [];
  popups: Popup[] = [];
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
  // Why: shared bass-beat clock — bass voices, on-beat detection and the visual pulsar all read this one source.
  beatTime = 0;
  lastBgBeatIndex = -1;
  nextBeatToEvaluate = 0;
  beatCombo = 0;
  // Why: latched on off-beat fire so the punishment can land at the next beat closure (not retroactive).
  firedOffBeatSinceLastBeat = false;

  canisters: Canister[] = [];
  comets: Comet[] = [];
  aliens: Alien[] = [];
  alienBullets: AlienBullet[] = [];
  alienSpawnSize: AlienSize = "small";
  waveElapsed = 0;
  slowMoTimer = 0;
  // Why: per-game randomised bass-kind intro order so the wave-2/3 picks vary between runs.
  bassOrder: AsteroidKind[] = [];
  // Why: one unified list replaces four parallel `xSpawnAt` fields used to schedule mid-wave events.
  waveEvents: WaveEventSchedule = newWaveEventSchedule();

  scoreEl: HTMLElement;
  comboEl: HTMLElement;
  comboValueEl: HTMLElement;
  waveEl: HTMLElement;
  livesEl: HTMLElement;
  overlayEl: HTMLElement;
  overlayTitleEl: HTMLElement;
  overlayStartEl: HTMLElement;
  muteEl: HTMLButtonElement;
  abortEl: HTMLButtonElement;
  killedRowEl: HTMLCanvasElement;

  // Why: post-run trophy lineup; replayed in the end-of-mission parade with original kill sounds.
  killedSnapshots: KilledSnapshot[] = [];
  paradeActive = false;
  paradeStartTime = 0;
  paradeRafId: number | null = null;
  paradeEntries: ParadeEntry[] = [];
  paradeTotalBeats = 0;
  paradeCanvasW = 0;
  paradeCanvasH = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.input = new Input();
    this.sound = new Sound();
    this.resize();
    this.starfield = new Starfield(this.w, this.h);
    this.pulsar = new Pulsar(this.w, this.h);
    this.ship = new Ship(v(this.w / 2, this.h / 2));
    window.addEventListener("resize", () => this.resize());
    const hud = bindHudElements();
    this.scoreEl = hud.scoreEl;
    this.comboEl = hud.comboEl;
    this.comboValueEl = hud.comboValueEl;
    this.waveEl = hud.waveEl;
    this.livesEl = hud.livesEl;
    this.overlayEl = hud.overlayEl;
    this.overlayTitleEl = hud.overlayTitleEl;
    this.overlayStartEl = hud.overlayStartEl;
    this.muteEl = hud.muteEl;
    this.abortEl = hud.abortEl;
    this.killedRowEl = hud.killedRowEl;
    this.muteEl.addEventListener("click", () => toggleMute(this));
    this.abortEl.addEventListener("click", () => abortMission(this));
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (k === "m" && this.state !== "title") toggleMute(this);
    });
    showTitle(this);
  }

  // Why: DPR-aware resize keeps the canvas crisp; the starfield/pulsar need their own resize too.
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
    if (this.pulsar) this.pulsar.resize(this.w, this.h);
  }

  update(dt: number) { updateGame(this, dt); }
  render() { renderGame(this); }
}
