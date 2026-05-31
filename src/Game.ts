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
import { GoldCrystal } from "./GoldCrystal";
import { Comet } from "./Comet";
import { Alien, AlienSize } from "./Alien";
import { AlienBullet } from "./AlienBullet";
import { v } from "./vec";
import { Popup } from "./game/popups";
import { KilledSnapshot } from "./game/killSnapshot";
import type { HighscoreRow } from "./game/highscores";
import type { KillBucket } from "./game/killBuckets";
import { ParadeEntry } from "./game/killedParade";
import { WaveEventSchedule, newWaveEventSchedule } from "./game/waveEvents";
import { HudElements, bindHudElements } from "./game/hud";
import { showTitle, toggleMute, applyVolume, abortMission, setFirstWaveHintStage, markFirstWaveTutorialComplete, triggerOverlayStart, startGame, openBeatCalibrator } from "./game/lifecycle";
import { updateGame } from "./game/gameUpdate";
import { renderGame } from "./game/gameRender";
import { loadBeatOffset, applyBeatOffset } from "./game/beatCalibration";

// re-export so existing external imports (Ship.ts) keep working without touching their imports.
export { BEAT_GRID } from "./game/rhythmConstants";

type GameState = "title" | "playing" | "paused" | "dying" | "gameover";

// Game holds the cross-cutting state every helper in src/game/* reads; behavior lives in modules.
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
  // shared bass-beat clock — bass voices, on-beat detection and the visual pulsar all read this one source.
  beatTime = 0;
  // player-measured latency offset (seconds), loaded in the constructor. Raw audio
  //   fires on `beatTime`; everything the player reacts to (scoring window + visual
  //   beat cues) reads `perceivedBeatTime` so it lands on the beat they actually hear.
  beatOffset = 0;
  // latched while the tap-to-beat calibrator overlay is open so the title loop
  //   doesn't keep re-firing the start request behind it.
  calibrating = false;
  // true while the settings dialog is open. Together with `calibrating`, this
  //   freezes the sim during play (see updateGame) so the ship can't drift or
  //   die behind a full-screen menu.
  settingsOpen = false;
  lastBgBeatIndex = -1;
  nextBeatToEvaluate = 0;
  beatCombo = 0;
  // high-water mark of beatCombo during a run — submitted with the score so the leaderboard
  //   can showcase a pilot's best streak, separately from the final score.
  maxCombo = 0;
  // per-wave high-water mark of beatCombo, surfaced in the wave-clear summary panel.
  //   Reset to the current beatCombo at the start of each new wave.
  maxComboThisWave = 0;
  // latched on off-beat fire so the punishment can land at the next beat closure (not retroactive).
  firedOffBeatSinceLastBeat = false;
  // first-ever meaningful combo loss in a run gets a labeled popup so the player learns the mechanic.
  hasLostComboEver = false;
  // combo x6 unlocks the first Pilot's Log vocal — fires once per run, gated by this flag.
  pilotLog1Unlocked = false;
  // combo x12 unlocks Entry 3 — same once-per-run gate, no HUD toast.
  pilotLog3Unlocked = false;
  // beta-test mode disables the random wave director — the run only contains the elements
  //   the player selected in the beta panel; when they're all gone the wave doesn't auto-spawn.
  betaMode = false;
  // latched while the end-of-wave summary is playing (drain + hold + fade)
  //   so the empty-asteroids check in the update loop doesn't keep re-triggering
  //   advanceWave each frame. Cleared when the summary finishes and the next
  //   wave's spawn fires.
  waveTransitioning = false;
  // wave-1 instructional overlay. stage 1 holds until 3 on-beat fires land,
  //   stage 2 holds until 4x rhythm, stage 3 (the score-payoff line) auto-dismisses
  //   after a brief hold. once the player reaches 6x rhythm the tutorial is marked
  //   complete in localStorage and won't show again. React-side <FirstWaveHint>
  //   listens for the "first-wave-hint:stage" CustomEvent and handles the CSS
  //   transition + auto-dismiss, so the game loop only owns the stage number.
  firstWaveHintStage: 0 | 1 | 2 | 3 | 4 = 0;
  firstWaveOnBeatFireCount = 0;
  // stage-2 sub-line ("Use your targeting tools to help") is gated on the
  //   player landing three on-beat hits after stage 2 opens. The diamond
  //   row under stage 2's main line fills one pip per hit, and the sub-line
  //   reveals once all three are lit.
  firstWaveHintSubVisible = false;
  firstWaveOnBeatHitCount = 0;

  canisters: Canister[] = [];
  goldCrystals: GoldCrystal[] = [];
  comets: Comet[] = [];
  aliens: Alien[] = [];
  alienBullets: AlienBullet[] = [];
  alienSpawnSize: AlienSize = "small";
  waveElapsed = 0;
  slowMoTimer = 0;
  // per-game randomised bass-kind intro order so the wave-2/3 picks vary between runs.
  bassOrder: AsteroidKind[] = [];
  // one unified list replaces four parallel `xSpawnAt` fields used to schedule mid-wave events.
  waveEvents: WaveEventSchedule = newWaveEventSchedule();

  scoreEl: HTMLElement;
  scoreFlashEl: HTMLElement;
  comboEl: HTMLElement;
  comboValueEl: HTMLElement;
  waveEl: HTMLElement;
  livesEl: HTMLElement;
  overlayEl: HTMLElement;
  overlayTitleEl: HTMLElement;
  overlayStartEl: HTMLElement;
  volumeEl: HTMLInputElement;
  abortEl: HTMLButtonElement;
  killedRowEl: HTMLCanvasElement;
  scoreEntryFormEl: HTMLFormElement;
  scoreEntryInputEl: HTMLInputElement;
  scoreEntrySubmitEl: HTMLButtonElement;
  scoreEntryStatusEl: HTMLElement;
  leaderboardEl: HTMLElement;
  leaderboardListEl: HTMLOListElement;
  debugOverlayEl: HTMLElement;
  debugFpsEl: HTMLElement;
  // backtick (`) toggles #debug-overlay. FPS readout is always visible (bottom-right).
  debugMode = false;
  // prevents a double-submit if the player mashes Enter while the POST is in flight.
  scoreSubmitState: "idle" | "submitting" | "submitted" = "idle";
  // lets the title screen after a game-over show a score-neighborhood (±5) around the
  //   player's run instead of the global top 10. Cleared when a new run starts.
  lastRunScore: number | null = null;
  lastRunScoreId: number | null = null;
  // up/down on the title + gameover leaderboard moves a yellow selector through
  //   the fetched pilot list (cap of 50). The selector slides toward the centre
  //   slot of the 11-row window first; once centred, further presses scroll the
  //   underlying list. See game/scoreEntry.ts.
  leaderboardRows: HighscoreRow[] = [];
  // Unfiltered top-50 from the server; leaderboardRows is the rendered view
  //   after applying the top-entries-only filter and current sort.
  leaderboardAllRows: HighscoreRow[] = [];
  leaderboardSelection = 0;
  leaderboardActive = false;
  // When true the rendered list dedupes by name, keeping each pilot's best
  //   row only. Persisted across sessions via localStorage.
  leaderboardTopOnly = true;
  // "show more" expands past the 7-row title window to render every loaded row.
  leaderboardExpanded = false;
  // True when the last fetch returned a full page, meaning more rows may exist
  //   on the server. Drives whether "show more" stays visible after expansion.
  leaderboardHasMore = false;
  // True while a "show more" page fetch is in flight; used to debounce clicks
  //   and to swap the button label to "loading…".
  leaderboardLoadingMore = false;
  // clickable column headers re-sort; rhythm is the default with score as
  //   the tiebreaker so the headline streak stat leads the board.
  leaderboardSort: "rhythm" | "score" | "wave" | "name" = "rhythm";

  // post-run trophy lineup; replayed in the end-of-mission parade with original kill sounds.
  killedSnapshots: KilledSnapshot[] = [];
  // per-run kill tally by category — submitted alongside the score on game over.
  killTally: Partial<Record<KillBucket, number>> = {};
  paradeActive = false;
  // parade timing reads game.beatTime (which keeps ticking through gameover) so
  //   sprite-crosses-centre events land on the same beat grid as the bg bass beat.
  paradeStartBeatTime = 0;
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
    this.scoreFlashEl = hud.scoreFlashEl;
    this.comboEl = hud.comboEl;
    this.comboValueEl = hud.comboValueEl;
    this.waveEl = hud.waveEl;
    this.livesEl = hud.livesEl;
    this.overlayEl = hud.overlayEl;
    this.overlayTitleEl = hud.overlayTitleEl;
    this.overlayStartEl = hud.overlayStartEl;
    this.volumeEl = hud.volumeEl;
    this.abortEl = hud.abortEl;
    this.killedRowEl = hud.killedRowEl;
    this.scoreEntryFormEl = hud.scoreEntryFormEl;
    this.scoreEntryInputEl = hud.scoreEntryInputEl;
    this.scoreEntrySubmitEl = hud.scoreEntrySubmitEl;
    this.scoreEntryStatusEl = hud.scoreEntryStatusEl;
    this.leaderboardEl = hud.leaderboardEl;
    this.leaderboardListEl = hud.leaderboardListEl;
    this.debugOverlayEl = hud.debugOverlayEl;
    this.debugFpsEl = hud.debugFpsEl;
    this.debugOverlayEl.classList.toggle("hidden", !this.debugMode);
    this.volumeEl.addEventListener("input", () => {
      applyVolume(this, Number(this.volumeEl.value) / 100);
    });
    // Slider sits at low opacity by default; light it up when the cursor is
    // within 25px of its bounding box so the player can find it without
    // having to land directly on it.
    window.addEventListener("mousemove", (e) => {
      const r = this.volumeEl.getBoundingClientRect();
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
      const near = Math.hypot(dx, dy) <= 25;
      this.volumeEl.classList.toggle("near", near);
    });
    this.beatOffset = loadBeatOffset() ?? 0;
    this.abortEl.addEventListener("click", () => abortMission(this));
    this.overlayStartEl.addEventListener("click", () => triggerOverlayStart(this));
    // <BeatCalibrator> (React) owns the tap-to-beat UI; the game owns the audio
    //   context it schedules clicks on, plus persistence of the result. These
    //   three events are the contract between them.
    window.addEventListener("beat-calibrator:request", () => openBeatCalibrator(this, false));
    window.addEventListener("beat-calibrator:done", (e) => {
      const { offsetSec, startAfter } = (e as CustomEvent).detail;
      applyBeatOffset(this, offsetSec);
      this.calibrating = false;
      if (startAfter) startGame(this);
    });
    window.addEventListener("beat-calibrator:cancel", () => {
      this.calibrating = false;
    });
    // Settings dialog's manual latency slider — applies live (and persists) so a
    //   nudge takes effect immediately, even mid-run.
    window.addEventListener("beat-offset:set", (e) => {
      const { offsetSec } = (e as CustomEvent).detail;
      applyBeatOffset(this, offsetSec);
    });
    window.addEventListener("settings:opened", () => { this.settingsOpen = true; });
    window.addEventListener("settings:closed", () => { this.settingsOpen = false; });
    // <FirstWaveHint> owns its own stage-3 auto-dismiss timer; when it fades
    //   out it asks the game to clear the stage. The tutorial is marked
    //   complete here so future runs skip the overlay entirely.
    window.addEventListener("first-wave-hint:dismiss", () => {
      setFirstWaveHintStage(this, 0);
      markFirstWaveTutorialComplete();
    });
    // stage 3 → stage 4 ("Become one with the Pulsar") closing flourish.
    window.addEventListener("first-wave-hint:advance", () => {
      if (this.firstWaveHintStage === 3) setFirstWaveHintStage(this, 4);
    });
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (k === "m" && this.state !== "title") toggleMute(this);
      if (k === "`") {
        this.debugMode = !this.debugMode;
        this.debugOverlayEl.classList.toggle("hidden", !this.debugMode);
      }
    });
    showTitle(this);
  }

  // DPR-aware resize keeps the canvas crisp; the starfield/pulsar need their own resize too.
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

  // raw audio plays on `beatTime`; scoring + visual beat cues read this shifted
  //   clock so they coincide with the beat the player actually hears (see beatCalibration.ts).
  get perceivedBeatTime(): number { return this.beatTime - this.beatOffset; }

  update(dt: number) { updateGame(this, dt); }
  render() { renderGame(this); }
}
