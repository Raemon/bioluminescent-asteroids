import { Ship } from "./Ship";
import { Asteroid, AsteroidKind, BASS_KINDS, BASS_MEASURE_LENGTH, spawnAsteroidAtEdge, spawnBossAt } from "./Asteroid";
import { Bullet } from "./Bullet";
import { ParticleSystem } from "./Particle";
import { Shard, shatterAsteroid } from "./Shard";
import { Starfield } from "./Starfield";
import { Pulsar } from "./Pulsar";
import { Input } from "./Input";
import { Sound } from "./Sound";
import { Canister, spawnCanister } from "./Canister";
import { Alien, AlienSize, ALIEN_FIRE_PERIOD_BEATS, spawnAlienAtEdge } from "./Alien";
import { AlienBullet } from "./AlienBullet";
import { v, fromAngle, dist, rand, TAU } from "./vec";

type GameState = "title" | "playing" | "paused" | "dying" | "gameover";

// Combo grid is one quarter-note (0.5s = 120 BPM quarter), the smallest
// beat slot any bassteroid can occupy after two splits. That keeps the
// rhythm gate aligned with every potential bass hit the player can hear.
// Window is ±150ms — wide enough to absorb the 50ms dt cap in main.ts plus
// normal human timing slop, narrow enough that random spam-firing only
// marks ~half of beats.
export const BEAT_GRID = 0.5;
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

// Alien saucer event: every few waves a saucer drops in mid-wave and starts
// firing musical bullets at the player. Eligibility starts at wave 3 and
// triggers ~every 3 waves on average; when it lands we pick a random size
// (weighted toward smaller saucers early on, bigger ones later) and
// schedule it somewhere in the wave's middle so it can't appear at the
// very start or the very end.
const ALIEN_FIRST_WAVE = 3;
const ALIEN_CHANCE_PER_WAVE = 1 / 3;
const ALIEN_SPAWN_WINDOW: [number, number] = [5, 22];

// Rare crystal "tink" asteroid: rolled once per wave starting at wave 3.
// Single small one-shot that emits the sharp glassy tink on destruction.
// Kept off the standard specialUnlockOrder so its appearance feels like a
// treat rather than a guaranteed wave fixture.
const TINK_FIRST_WAVE = 3;
const TINK_CHANCE_PER_WAVE = 1 / 3;

// Boss-wave plumbing. The first boss is a planetoid that's been creeping
// forward in the background since wave 1 (planets[0] on Pulsar). On the
// foreshadow wave, Pulsar swells that planet so it visibly looms; on the
// boss wave itself we hide the planet and spawn a boss asteroid in the
// foreground at the same screen position, completing the "planetoid
// solidifies into play" handoff.
const BOSS_WAVES = [10] as const;
const BOSS_FORESHADOW_WAVES = [9] as const;

// Pulsar shockwave: occasional mid-wave event where the pulsar vibrates and
// flashes, releasing a ring that shatters every asteroid and jiggles the
// ship. Rolled once per wave for an average of one shockwave per 5 waves.
// When it lands, the actual detonation is scheduled at a random mid-wave
// time so it doesn't always punctuate the wave's opening or closing seconds.
// Gated to wave 3+ so the early game stays focused on learning the core
// mechanics before the world starts rearranging itself.
const SHOCKWAVE_FIRST_WAVE = 3;
const SHOCKWAVE_CHANCE_PER_WAVE = 1 / 5;
const SHOCKWAVE_SPAWN_WINDOW: [number, number] = [6, 22];
// Velocity kick (px/s, modulated by distance falloff) applied to the ship on
// the flash. Strong enough to noticeably redirect the player without
// launching them into a hard-to-recover spin.
const SHOCKWAVE_SHIP_IMPULSE = 320;

// Tiny Fisher-Yates so the per-game bass intro order is properly random.
// Returns a fresh array, leaving the input untouched.
const shuffled = <T,>(arr: ReadonlyArray<T>): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// One percussive voice per bass kind. The four sounds are tuned to harmonise
// when stacked: kick (C2 root), pluck (G2 fifth), boom (F2 fourth), snap
// (C3-area percussive accent), so I-IV-V-percussion is the worst case even
// when split children spread voices across every beat of the measure.
const BASS_KIND_SOUND: Record<"bassA" | "bassB" | "bassC" | "bassD", "bassKick" | "bassPluck" | "bassBoom" | "bassSnap"> = {
  bassA: "bassKick",
  bassB: "bassPluck",
  bassC: "bassBoom",
  bassD: "bassSnap",
};

// Pitch factor applied to a bass voice based on the asteroid's split level.
// Gen-0 large and gen-1 medium keep the parent pitch so the established
// pattern stays familiar across the first split. Gen-2 small (the terminal
// pieces) drops a minor third (≈ -3 semitones, 0.8409): every voice lands
// on another note of the C major scale, so the whole field stays diatonic
// but the terminal quarter-note subdivisions sit in a deeper register than
// the parent voice. Resulting smalls — kick C2→A1, pluck G2→E2, boom F2→D2,
// snap C3→A2 — give I/vi/V/ii flavor (relative minor + supertonic), which
// pairs naturally with the C-F-G groundwork without sounding "wrong" when
// stacked with siblings still at gen-0 or gen-1 pitch.
const BASS_SPLIT_PITCH_RATIO = [1, 1, 0.8409] as const;

export class Game {
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
  // Shared bass-beat clock (seconds). All bassteroids align to this grid
  // so their kicks and plucks interlock musically. Also serves as the source
  // of truth for on-beat detection — using the same clock the audio fires
  // from means a frame stutter slows beat audio and combo tracking together,
  // so they stay in lockstep.
  beatTime = 0;
  // Last BEAT_GRID index we've already fired the background pulsar-approach
  // beat for. Tracked separately from lastMarkedBeatIndex (which is the
  // player's on-beat combo state) because the background beat fires every
  // tick regardless of input.
  lastBgBeatIndex = -1;
  // Index of the most recent beat the player marked with a fire or kill.
  // Marks arrive in increasing index order because BEAT_WINDOW < BEAT_GRID/2,
  // so consecutive windows never overlap.
  lastMarkedBeatIndex = -1;
  // Next beat index whose closing-window time we haven't yet checked. Beats
  // are evaluated in order; an unmarked beat that closes resets the combo.
  nextBeatToEvaluate = 0;
  beatCombo = 0;

  canisters: Canister[] = [];
  aliens: Alien[] = [];
  alienBullets: AlienBullet[] = [];
  // null when this wave didn't roll an alien or the alien has already been
  // spawned. When non-null it's the in-wave time (seconds) at which to
  // spawn, paired with the chosen size. Cleared the moment the saucer
  // appears (Game.update).
  alienSpawnAt: number | null = null;
  alienSpawnSize: AlienSize = "small";
  // null when this wave didn't roll a canister or the canister has already
  // been spawned. When non-null it's the in-wave time (seconds) at which to
  // spawn. Set in spawnWave; cleared the moment the canister appears.
  canisterSpawnAt: number | null = null;
  // Same shape as canisterSpawnAt, for the pulsar shockwave event. Rolled
  // in spawnWave; cleared the moment we kick off the vibrate sequence on
  // the Pulsar.
  shockwaveTriggerAt: number | null = null;
  waveElapsed = 0;
  slowMoTimer = 0;
  // Per-game randomised intro order for the four bass kinds. Set in
  // startGame so the wave-2/3 pick (and the wave-4 "both previous" rule)
  // varies between runs. Index 0 = wave-2 unlock, index 1 = wave-3 unlock,
  // index 2/3 = remaining kinds revealed later (see activeSpecialsForWave).
  bassOrder: AsteroidKind[] = [];

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
    this.pulsar = new Pulsar(this.w, this.h);
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
    if (this.pulsar) this.pulsar.resize(this.w, this.h);
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
    this.sound.stopAllAlienDrones();
    this.aliens = [];
    this.alienBullets = [];
    this.alienSpawnAt = null;
    this.canisterSpawnAt = null;
    this.shockwaveTriggerAt = null;
    this.slowMoTimer = 0;
    this.sound.bgBeatIntensity = 0;
    this.pulsar.setBossPlanetState("idle");
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
    this.lastBgBeatIndex = -1;
    this.lastMarkedBeatIndex = -1;
    this.nextBeatToEvaluate = 0;
    this.beatCombo = 0;
    this.bullets = [];
    this.shards = [];
    this.canisters = [];
    this.sound.stopAllAlienDrones();
    this.aliens = [];
    this.alienBullets = [];
    this.alienSpawnAt = null;
    this.slowMoTimer = 0;
    this.bassOrder = shuffled(BASS_KINDS);
    this.particles = new ParticleSystem();
    this.ship = new Ship(v(this.w / 2, this.h / 2));
    this.ship.invuln = 2.0;
    this.pulsar.setBossPlanetState("idle");
    this.pulsar.setWaveLevel(this.wave);
    this.updateBgBeatIntensity();
    this.spawnWave();
    this.overlayEl.classList.add("hidden");
    this.syncHud();
  }

  // Ramp from wave 1 (faint but audible) to wave 30 (full ominous rumble).
  // We reach the pulsar at wave 30, so the beat should feel maxed out by
  // then; beyond that we hold at 1.0 in case the player overshoots. Floor
  // is 0.08 so the very first beat is still perceptible — fainter than any
  // other sound, but not silent. Sound reads bgBeatIntensity each time a
  // beat fires, so just writing it here is enough.
  updateBgBeatIntensity() {
    const ramp = Math.max(0, Math.min(1, (this.wave - 1) / 29));
    this.sound.bgBeatIntensity = 0.08 + ramp * 0.92;
  }

  // Snap an asteroid's next beat to its assigned within-measure slot on the
  // global beat clock. The asteroid's `measureOffset` is set in the
  // constructor (gen-0) or carried over by `split()` (children inherit the
  // parent's slot), so all this has to do is find the next future measure
  // boundary that aligns with that offset.
  isBossWave(wave: number): boolean {
    return (BOSS_WAVES as readonly number[]).includes(wave);
  }

  isBossForeshadowWave(wave: number): boolean {
    return (BOSS_FORESHADOW_WAVES as readonly number[]).includes(wave);
  }

  // Snap an asteroid's next-beat clock to the next within-measure slot that
  // also lands on the central pulsar's BEAT_GRID. The base offsets and split
  // deltas are already grid-multiples by construction, but we round both
  // `measureOffset` and the final `nextBeatAt` to the grid anyway so the
  // invariant "every bassteroid fires on a pulsar beat" survives float drift,
  // future tuning changes, or any spawn path that bypasses BASS_KIND_BASE_OFFSET.
  alignBassBeat(asteroid: Asteroid) {
    if (!asteroid.isBass()) return;
    const gridSnappedOffset = Math.round(asteroid.measureOffset / BEAT_GRID) * BEAT_GRID;
    asteroid.measureOffset = gridSnappedOffset;
    const k = Math.ceil((this.beatTime - gridSnappedOffset - 1e-6) / BASS_MEASURE_LENGTH);
    const raw = k * BASS_MEASURE_LENGTH + gridSnappedOffset;
    asteroid.nextBeatAt = Math.round(raw / BEAT_GRID) * BEAT_GRID;
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
    // Aliens persist across wave-clears only if still alive when the field
    // empties — but spawnWave currently fires after the kill, so this just
    // hard-resets any pending alien spawns to "none for this wave". The
    // alien-bullet list is left alone so airborne shots aren't deleted out
    // from under the player at the wave transition.
    this.alienSpawnAt = null;
    this.waveElapsed = 0;

    // Boss-wave branch: skip the normal asteroid / specials / events
    // pipeline and just spawn the boss at the looming planet's current
    // screen position. No canister, no shockwave, no alien — the fight is
    // the wave. Also flip pulsar into "active" so the foreshadowing planet
    // disappears the moment the boss materialises.
    if (this.isBossWave(this.wave)) {
      // Capture the looming planet's current position *before* flipping the
      // pulsar state — once we hide the planet we still want the boss to
      // materialise where the player last saw it, not where its base
      // (non-foreshadowed) orbit would put it.
      const pos = this.pulsar.bossPlanetPos();
      this.pulsar.setBossPlanetState("active");
      this.asteroids.push(spawnBossAt(pos, this.w, this.h));
      this.canisterSpawnAt = null;
      this.shockwaveTriggerAt = null;
      return;
    }

    // Foreshadow wave: regular wave, but pulsar swells planets[0] so the
    // player sees the boss looming. We otherwise let everything else
    // proceed normally — this is the "still obviously not in play" beat.
    if (this.isBossForeshadowWave(this.wave)) {
      this.pulsar.setBossPlanetState("foreshadow");
    } else if (this.pulsar.bossPlanetState === "foreshadow") {
      // Defensive: leaving the foreshadow window without entering the boss
      // wave (e.g. via state restart) — drop back to idle so the planet
      // resumes its normal drift.
      this.pulsar.setBossPlanetState("idle");
    }

    // Roll once per wave. Any canister still on screen from a previous wave
    // is wiped above so the player never sees two at once.
    if (Math.random() < CANISTER_CHANCE_PER_WAVE) {
      this.canisterSpawnAt = rand(CANISTER_SPAWN_WINDOW[0], CANISTER_SPAWN_WINDOW[1]);
    } else {
      this.canisterSpawnAt = null;
    }
    if (this.wave >= SHOCKWAVE_FIRST_WAVE && Math.random() < SHOCKWAVE_CHANCE_PER_WAVE) {
      this.shockwaveTriggerAt = rand(SHOCKWAVE_SPAWN_WINDOW[0], SHOCKWAVE_SPAWN_WINDOW[1]);
    } else {
      this.shockwaveTriggerAt = null;
    }
    const wave = this.wave;
    // Total asteroid count grows by 1 every other wave: 4, 4, 5, 5, 6, 6, ...
    const totalCount = 4 + Math.floor((wave - 1) / 2);

    const activeSpecials = this.activeSpecialsForWave(wave);
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

    if (wave >= ALIEN_FIRST_WAVE && Math.random() < ALIEN_CHANCE_PER_WAVE) {
      this.alienSpawnAt = rand(ALIEN_SPAWN_WINDOW[0], ALIEN_SPAWN_WINDOW[1]);
      this.alienSpawnSize = this.rollAlienSize(wave);
    }
  }

  // Earlier waves favour small/medium saucers; bigger ones become more common
  // as runs go deep. Avoids the player getting hit with a 4-HP saucer on its
  // first appearance.
  rollAlienSize(wave: number): AlienSize {
    if (wave < 5) return Math.random() < 0.7 ? "small" : "medium";
    if (wave < 9) {
      const r = Math.random();
      if (r < 0.45) return "small";
      if (r < 0.85) return "medium";
      return "big";
    }
    const r = Math.random();
    if (r < 0.3) return "small";
    if (r < 0.65) return "medium";
    return "big";
  }

  // Specials present in a given wave. The bass intro is special-cased per
  // the new design:
  //   wave 2: bassOrder[0]   — one random bass kind
  //   wave 3: bassOrder[1]   — a different random bass kind
  //   wave 4+: bassOrder[0] + bassOrder[1] (both previous kinds permanent)
  // From wave 6 on we resume the every-other-wave unlock cadence with the
  // decorators (chime/bell/warble) and finally the two remaining bass
  // kinds, so the audio bed keeps thickening as runs go deep.
  activeSpecialsForWave(wave: number): AsteroidKind[] {
    if (wave < 2) return [];
    if (wave === 2) return [this.bassOrder[0]];
    if (wave === 3) return [this.bassOrder[1]];
    const specials: AsteroidKind[] = [this.bassOrder[0], this.bassOrder[1]];
    const lateUnlockOrder: AsteroidKind[] = ["chime", "bell", "warble", this.bassOrder[2], this.bassOrder[3]];
    // wave 4 → 0 late unlocks, wave 6 → 1, wave 8 → 2, etc. Pairs of waves
    // hold steady so the player has time to learn each new sound.
    const lateCount = Math.max(0, Math.min(lateUnlockOrder.length, Math.floor((wave - 4) / 2)));
    for (let i = 0; i < lateCount; i++) specials.push(lateUnlockOrder[i]);
    return specials;
  }

  spawnTink(): Asteroid {
    let a = spawnAsteroidAtEdge(this.w, this.h, undefined, "tink", "small");
    while (dist(a.pos, this.ship.pos) < 200) {
      a = spawnAsteroidAtEdge(this.w, this.h, undefined, "tink", "small");
    }
    return a;
  }

  // Spawn a single saucer of the chosen size at a screen edge. Aligns the
  // first fire to the next beat boundary on the global clock so its shots
  // sync to the rhythm the player is already locked into. Starts the
  // alien's continuous drone so it has an audible signature the moment it
  // appears on screen.
  spawnAlien(size: AlienSize) {
    let a = spawnAlienAtEdge(this.w, this.h, size);
    let attempts = 0;
    while (dist(a.pos, this.ship.pos) < 260 && attempts < 6) {
      a = spawnAlienAtEdge(this.w, this.h, size);
      attempts += 1;
    }
    const period = ALIEN_FIRE_PERIOD_BEATS[size] * BEAT_GRID;
    a.nextFireAt = Math.ceil((this.beatTime + 0.5) / period) * period;
    this.aliens.push(a);
    this.sound.startAlienDrone(a, size);
  }

  // Walk every alien and emit a bullet for any fire-time that's now in the
  // past. Each shot is aimed at the player's current position at the moment
  // it leaves the gun, so dodging works by moving between beats.
  tickAlienFire() {
    if (this.aliens.length === 0) return;
    const period = (size: AlienSize) => ALIEN_FIRE_PERIOD_BEATS[size] * BEAT_GRID;
    for (const a of this.aliens) {
      while (this.beatTime >= a.nextFireAt) {
        if (this.ship.alive) {
          this.alienBullets.push(a.fireAt(this.ship.pos));
          const fireSound = a.size === "big" ? "alienFireBig" : a.size === "medium" ? "alienFireMedium" : "alienFireSmall";
          this.sound.play(fireSound);
        } else {
          a.fireFlash = 1;
        }
        a.nextFireAt += period(a.size);
      }
    }
  }

  // Player bullets hitting aliens. Big aliens reuse the same multi-hit /
  // crack pipeline as bassteroids (4 HP, each hit shows another fracture);
  // medium/small use the same Alien.applyDamage path so the bookkeeping is
  // uniform. Killing hit awards score (combo-multiplied on on-beat) and
  // ends the alien's drone.
  handleAlienHits() {
    const surviving: Alien[] = [];
    for (const a of this.aliens) {
      let killed = false;
      for (const b of this.bullets) {
        if (b.life <= 0) continue;
        if (!a.collidesWith(b.pos, b.effectiveRadius())) continue;
        if (!b.pierce) b.life = 0;
        this.ship.fireCooldown = 0;
        const hitMarkedBeat = this.markBeat(this.beatTime);
        const isOnBeatHit = hitMarkedBeat || b.onBeat;
        const { killed: alienKilled } = a.applyDamage();
        if (!alienKilled) {
          this.sound.play("alienHit");
          this.shake = Math.min(this.shake + 0.18, 1.2);
          if (isOnBeatHit) {
            this.sound.play("comboSparkle");
            if (hitMarkedBeat) this.pulseComboHud();
          }
          break;
        }
        let scoreEarned = a.scoreValue;
        if (isOnBeatHit) {
          const multiplier = Math.min(1 + this.beatCombo * COMBO_MULTIPLIER_STEP, COMBO_MULTIPLIER_MAX);
          scoreEarned = Math.round(scoreEarned * multiplier);
          this.sound.play("comboSparkle");
          if (hitMarkedBeat) this.pulseComboHud();
        }
        this.score += scoreEarned;
        this.shake = Math.min(this.shake + 0.5, 1.4);
        this.sound.play("alienExplode");
        this.sound.stopAlienDrone(a);
        this.emitAlienExplosion(a);
        killed = true;
        break;
      }
      if (!killed) surviving.push(a);
    }
    this.aliens = surviving;
  }

  // Alien bullets hitting the player. Shield absorbs one; otherwise the
  // ship dies like any other collision.
  handleAlienBulletHits() {
    if (!this.ship.alive || this.ship.invuln > 0) return;
    const remaining: AlienBullet[] = [];
    let hit = false;
    for (const ab of this.alienBullets) {
      if (!hit && Math.hypot(ab.pos.x - this.ship.pos.x, ab.pos.y - this.ship.pos.y) < this.ship.radius * 0.7 + ab.radius) {
        hit = true;
        if (this.ship.shieldActive) {
          this.ship.shieldActive = false;
          this.ship.invuln = 0.8;
          this.popShield();
        } else {
          this.killShip();
        }
        continue;
      }
      remaining.push(ab);
    }
    this.alienBullets = remaining;
  }

  emitAlienExplosion(a: Alien) {
    const burstIndices = Array.from({ length: a.size === "big" ? 70 : a.size === "medium" ? 48 : 30 }, (_, i) => i);
    for (const _ of burstIndices) {
      const angle = rand(0, TAU);
      const speed = rand(80, 340);
      this.particles.emit({
        pos: { ...a.pos },
        vel: fromAngle(angle, speed),
        life: rand(0.5, 1.2),
        maxLife: 1.2,
        size: rand(1, 2.6),
        hue: a.hue + rand(-15, 25),
        shrink: 1,
        drag: 1.4,
      });
    }
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

  // The grid the rhythm gate runs on. Quarter notes (BEAT_GRID) normally;
  // 8th notes (BEAT_GRID/2) while the player has rapid fire, so a rapid
  // held-fire shot lands a beat every trigger pull. Stored beat indices
  // in lastMarkedBeatIndex / nextBeatToEvaluate are always in the current
  // grid — collectCanister and respawn rebase them on grid transitions.
  comboGrid(): number {
    return this.ship.rapidActive ? BEAT_GRID / 2 : BEAT_GRID;
  }

  // Visual metronome strength at the current beatTime: 1 at a beat center,
  // falling linearly to 0 at the edge of the same ±BEAT_WINDOW used by
  // markBeat. Returning >0 here is exactly the condition under which a shot
  // fired this frame would be counted as a rhythm-shot, so the ship's pulse
  // is a literal preview of the rhythm window. Zero on title/pause/gameover
  // because beatTime isn't advancing there and we don't want a frozen flash.
  currentBeatPulse(): number {
    if (this.state !== "playing" && this.state !== "dying") return 0;
    const grid = this.comboGrid();
    const beatPhase = this.beatTime / grid;
    const signedBeatsFromNearestBeat = beatPhase - Math.round(beatPhase);
    const windowFractionOfGrid = BEAT_WINDOW / grid;
    const normalized = signedBeatsFromNearestBeat / windowFractionOfGrid;
    if (normalized < -1 || normalized > 1) return 0;
    // Asymmetric envelope: snap up to full brightness on the approach (steep
    // attack), then linger with a slow squared falloff after the beat passes.
    return normalized <= 0
      ? Math.sqrt(1 + normalized)
      : (1 - normalized) * (1 - normalized);
  }

  // Try to associate `time` with the nearest beat on the combo grid (8ths
  // under rapid, quarters otherwise). Returns true iff this call is the
  // first activity inside that beat's window — that's the signal we use to
  // decide whether to play the on-beat tick / sparkle and to count the
  // beat for combo display purposes.
  markBeat(time: number): boolean {
    const grid = this.comboGrid();
    const beatIndex = Math.round(time / grid);
    const beatCenter = beatIndex * grid;
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
    const grid = this.comboGrid();
    while (this.nextBeatToEvaluate * grid + BEAT_WINDOW <= this.beatTime) {
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
    // Pulsar.update fires the pulsar's per-beat pulse off the SAME beatTime
    // that tickBassBeats reads. To keep the visual pulsar beat and the bass
    // voices firing on the same frame (instead of the pulsar trailing by one
    // frame because we called update before advancing the clock), we defer
    // the pulsar update inside the "playing" branch until after tickBassBeats.
    // In all other states beatTime is frozen, so we can update the pulsar
    // here against the current value.
    if (this.state !== "playing") {
      this.pulsar.update(dt, this.beatTime, BEAT_GRID);
    }

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
          this.sound.stopAllAlienDrones();
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
      // Slow-mo slows the music side of the clock: beatTime, bass beats,
      // and asteroid motion all step at musicDt while the player, bullets,
      // and fire cooldown keep real-time speed. The slow-mo timer itself
      // decrements in wall-clock so its lifespan isn't extended by its own
      // effect.
      if (this.slowMoTimer > 0) this.slowMoTimer = Math.max(0, this.slowMoTimer - dt);
      const musicDt = this.slowMoTimer > 0 ? dt * SLOW_MO_FACTOR : dt;
      // tickBassBeats advances beatTime; we need that advance to land before
      // we time-stamp any shot fired this frame, so on-beat detection lines
      // up with the same beatTime that any bass audio on this frame fired at.
      this.tickBassBeats(musicDt);
      // Run the pulsar against the freshly-advanced beatTime so its per-beat
      // flash lands on the same frame as the bassteroid voices that share
      // the beat, instead of one frame later.
      this.pulsar.update(dt, this.beatTime, BEAT_GRID);
      if (this.bullets.length > bulletsBeforeShipUpdate) {
        // Ship's fireRate (0.5s base, 0.25s under rapid) exceeds the dt cap
        // (0.05s) so at most ONE fire event lands per frame — but trident
        // emits 3 bullets per fire event, so the slice length can be >1.
        // They all share the same beat flag because they're one shot.
        const newBullets = this.bullets.slice(bulletsBeforeShipUpdate);
        const firedOnBeat = this.markBeat(this.beatTime);
        if (firedOnBeat) {
          for (const newBullet of newBullets) newBullet.onBeat = true;
          this.sound.play("comboTick");
          this.pulseComboHud();
        }
        // Fire sound picked based on whether the shot landed in a beat
        // window. Deeper "fireBeat" pluck for rhythm shots; lighter "fire"
        // pluck otherwise. Ship no longer plays the fire sound itself.
        this.sound.play(firedOnBeat ? "fireBeat" : "fire");
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
      if (this.shockwaveTriggerAt !== null && this.waveElapsed >= this.shockwaveTriggerAt) {
        this.pulsar.triggerShockwave();
        this.sound.play("shockwaveCharge");
        this.shockwaveTriggerAt = null;
      }
      if (this.pulsar.shockJustFired) this.detonateShockwave();
      if (this.alienSpawnAt !== null && this.waveElapsed >= this.alienSpawnAt) {
        this.spawnAlien(this.alienSpawnSize);
        this.alienSpawnAt = null;
      }
      for (const a of this.asteroids) a.update(musicDt, this.w, this.h);
      for (const al of this.aliens) al.update(dt, this.w, this.h);
      this.tickAlienFire();
      for (const b of this.bullets) b.update(dt, this.w, this.h);
      this.bullets = this.bullets.filter((b) => b.life > 0);
      for (const ab of this.alienBullets) ab.update(dt, this.w, this.h);
      this.alienBullets = this.alienBullets.filter((ab) => ab.life > 0);
      for (const s of this.shards) s.update(dt);
      this.shards = this.shards.filter((s) => s.life > 0);
      for (const c of this.canisters) c.update(dt, this.w, this.h);
      this.canisters = this.canisters.filter((c) => c.alive);
      this.particles.update(dt);
      this.handleCollisions();
      this.handleAlienHits();
      this.handleAlienBulletHits();
      this.handleCanisterPickups();
      this.handleCanisterShots();
      // Run after collisions so any beat marked by a kill this frame is
      // visible to the evaluator if its window happens to close on the same
      // frame (rare, but possible at the trailing edge).
      this.evaluateClosedBeats();
      if (this.asteroids.length === 0) {
        const wasBossWave = this.isBossWave(this.wave);
        this.wave += 1;
        this.sound.play("waveClear");
        this.sound.play("pulsarHum");
        this.pulsar.waveClear();
        this.pulsar.setWaveLevel(this.wave);
        this.updateBgBeatIntensity();
        // Boss just died — lock the planet hidden so the cleared boss
        // doesn't pop back into the sky as a planet on the next wave.
        if (wasBossWave) this.pulsar.setBossPlanetState("defeated");
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
    // killShip already cleared lastMarkedBeatIndex and beatCombo; the
    // combo grid may also have flipped (8ths → quarters if the previous
    // life had rapid), so rebase nextBeatToEvaluate to the first un-closed
    // beat in the new ship's grid.
    this.nextBeatToEvaluate = Math.max(0, Math.floor((this.beatTime - BEAT_WINDOW) / this.comboGrid()) + 1);
    this.state = "playing";
    this.syncHud();
  }

  tickBassBeats(musicDt: number) {
    this.beatTime += musicDt;
    // Background pulsar-approach beat: fire once per BEAT_GRID tick,
    // alternating downbeat (root) and offbeat (slightly higher pitch). Uses
    // the same beatTime clock as bassteroids so it stays locked to slow-mo
    // and frame stutters. Catches up if multiple beats elapsed in one frame.
    const grid = BEAT_GRID;
    const bgIdx = Math.floor(this.beatTime / grid);
    if (bgIdx < this.lastBgBeatIndex) this.lastBgBeatIndex = bgIdx - 1;
    while (this.lastBgBeatIndex < bgIdx) {
      this.lastBgBeatIndex += 1;
      const isOffbeat = (this.lastBgBeatIndex & 1) === 1;
      // 1.122 = whole-step lift (~E1 → F#1) — audibly distinct from the
      // downbeat without breaking the ominous mood.
      const pitchRatio = isOffbeat ? 1.122 : 1;
      this.sound.play("bgBeat", pitchRatio);
    }
    for (const a of this.asteroids) {
      if (!a.isBass()) continue;
      // Fire any beats that have elapsed since the last frame (typically one,
      // but defensively handle multi-step in case dt spiked). All bass
      // asteroids share the same once-per-measure period — what varies is
      // their `measureOffset`, which subdivides the measure as the ship is
      // split. The voice each piece plays is bound to its KIND, not its
      // current beat slot: split children carry their parent's percussive
      // timbre onto whichever beat they now occupy.
      while (this.beatTime >= a.nextBeatAt) {
        const sound = BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"];
        const pitchRatio = BASS_SPLIT_PITCH_RATIO[a.splitLevel] ?? 1;
        this.sound.play(sound, pitchRatio);
        a.beatFlash = 1.0;
        // Re-snap to BEAT_GRID after each advance so accumulated float error
        // can never drift the bass voice off the pulsar's beat over a long run.
        a.nextBeatAt = Math.round((a.nextBeatAt + BASS_MEASURE_LENGTH) / BEAT_GRID) * BEAT_GRID;
      }
    }
  }

  // Pulsar shockwave just fired this frame: shatter every asteroid, kick
  // the ship outward, and add a chunky screen-shake. Asteroids get treated
  // as "hit" — non-bass pieces split into their children (small ones simply
  // vanish), and bass pieces are zeroed-out so they split or die through
  // their normal pipeline. The ring is a free-of-charge environment event,
  // so no score or combo credit is awarded.
  detonateShockwave() {
    this.sound.play("shockwaveBoom");
    this.shake = Math.min(this.shake + 1.4, 2.0);
    const surviving: Asteroid[] = [];
    for (const a of this.asteroids) {
      // Bosses survive the shockwave intact — the planetoid is too massive
      // to be shattered by a pulsar ring, and instant-killing the fight via
      // an environmental event would feel cheap. The ring does still nudge
      // the boss outward so the player gets some visible feedback.
      if (a.isBoss()) {
        const kick = this.pulsar.shockwaveImpulseAt(a.pos);
        a.vel = { x: a.vel.x + kick.x * 120, y: a.vel.y + kick.y * 120 };
        a.flashAmount = 1;
        surviving.push(a);
        continue;
      }
      if (a.isBass()) {
        a.hp = 0;
        a.flashAmount = 1;
        this.emitExplosion(a, false);
        const children = a.split();
        for (const c of children) {
          this.alignBassBeat(c);
          // Kick children outward from the shock origin so the field reads
          // as flung-apart by the wavefront rather than spawning in place.
          const kick = this.pulsar.shockwaveImpulseAt(c.pos);
          c.vel = { x: c.vel.x + kick.x * 220, y: c.vel.y + kick.y * 220 };
          surviving.push(c);
        }
      } else {
        a.flashAmount = 1;
        this.emitExplosion(a, false);
        const children = a.split();
        for (const c of children) {
          const kick = this.pulsar.shockwaveImpulseAt(c.pos);
          c.vel = { x: c.vel.x + kick.x * 220, y: c.vel.y + kick.y * 220 };
          surviving.push(c);
        }
      }
    }
    this.asteroids = surviving;

    if (this.ship.alive) {
      // Distance falloff: ships near the origin take a bigger kick than
      // those at the far corner. Clamped so we always feel *something* and
      // never overflow the ship's maxSpeed cap on a single frame.
      const kick = this.pulsar.shockwaveImpulseAt(this.ship.pos);
      const d = Math.hypot(this.ship.pos.x - this.pulsar.shockOriginX, this.ship.pos.y - this.pulsar.shockOriginY);
      const falloff = Math.max(0.45, 1 - d / Math.max(this.w, this.h));
      const mag = SHOCKWAVE_SHIP_IMPULSE * falloff;
      this.ship.vel = { x: this.ship.vel.x + kick.x * mag, y: this.ship.vel.y + kick.y * mag };
      // A brief grace-frame so the player isn't punished for being kicked
      // straight into a freshly-shattered asteroid debris cluster.
      this.ship.invuln = Math.max(this.ship.invuln, 0.6);
    }

    // Outward-radiating sparks centred on the origin sell the wavefront as
    // having physical mass instead of being a pure light effect.
    const sparkIndices = Array.from({ length: 64 }, (_, i) => i);
    for (const _ of sparkIndices) {
      const angle = rand(0, TAU);
      const speed = rand(280, 520);
      this.particles.emit({
        pos: { x: this.pulsar.shockOriginX, y: this.pulsar.shockOriginY },
        vel: fromAngle(angle, speed),
        life: rand(0.5, 1.1),
        maxLife: 1.1,
        size: rand(1.4, 2.6),
        hue: 200 + rand(-10, 20),
        shrink: 1,
        drag: 0.9,
      });
    }
  }

  handleCollisions() {
    const surviving: Asteroid[] = [];
    for (const a of this.asteroids) {
      let killed = false;
      for (const b of this.bullets) {
        if (b.life <= 0) continue;
        if (!a.collidesWith(b.pos, b.effectiveRadius())) continue;
        // Pierce bullets stay alive after a hit so a single shot can punch
        // through a row of asteroids. Their `life` timer still expires
        // normally, so they don't last forever.
        if (!b.pierce) b.life = 0;
        // Connecting a shot refunds the beat trigger lock so a player who's
        // actually hitting things can keep up a faster cadence than the
        // cooldown allows — missed shots are what cost you tempo.
        this.ship.fireCooldown = 0;
        // A hit counts as on-beat if EITHER the bullet was fired on the
        // beat OR the impact itself lands in a beat window. The fire-time
        // case keeps long-range shots fair (a timed shot that drifts to a
        // far asteroid still earns its bonus), and the impact-time case
        // covers point-blank kills where the player times the destruction
        // rather than the trigger pull.
        const hitMarkedBeat = this.markBeat(this.beatTime);
        const isOnBeatHit = hitMarkedBeat || b.onBeat;
        // Unified damage path: every asteroid carries HP now. Non-killing
        // hits play crack feedback (cracks visible on the body via
        // Asteroid.renderCracks) and only mark the beat — no score, no
        // split. Killing hits award score, fire the explosion sound, and
        // dispatch the split. Bassteroids layer on bassHit/bassEcho.
        const { killed: didKill } = a.applyDamage(b.damage());
        this.shake = Math.min(this.shake + (didKill ? 0.4 : 0.2), 1.2);
        if (a.isBass()) this.sound.play("bassHit");
        if (!didKill) {
          this.emitCrackParticles(a, isOnBeatHit);
          if (isOnBeatHit) {
            this.sound.play("comboSparkle");
            if (hitMarkedBeat) this.pulseComboHud();
          }
          break;
        }
        let scoreEarned = a.scoreValue();
        if (isOnBeatHit) {
          const multiplier = Math.min(1 + this.beatCombo * COMBO_MULTIPLIER_STEP, COMBO_MULTIPLIER_MAX);
          scoreEarned = Math.round(scoreEarned * multiplier);
          this.sound.play("comboSparkle");
          if (hitMarkedBeat) this.pulseComboHud();
        }
        this.score += scoreEarned;
        if (a.isBass()) this.sound.play("bassEcho");
        this.sound.play(this.hitSoundFor(a));
        this.emitExplosion(a, isOnBeatHit);
        const children = a.split();
        for (const c of children) {
          if (a.isBass()) this.alignBassBeat(c);
          surviving.push(c);
        }
        killed = true;
        break;
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

  handleCanisterShots() {
    const remaining: Canister[] = [];
    for (const c of this.canisters) {
      let hit = false;
      for (const b of this.bullets) {
        if (b.life <= 0) continue;
        if (!c.collidesWith(b.pos, b.effectiveRadius())) continue;
        if (!b.pierce) b.life = 0;
        this.explodeCanister(c);
        hit = true;
        break;
      }
      if (!hit) remaining.push(c);
    }
    this.canisters = remaining;
  }

  explodeCanister(c: Canister) {
    this.sound.play("explosionSmall");
    this.shake = Math.min(this.shake + 0.25, 1.2);
    const burstIndices = Array.from({ length: 30 }, (_, i) => i);
    for (const _ of burstIndices) {
      const angle = rand(0, TAU);
      const speed = rand(120, 320);
      this.particles.emit({
        pos: { ...c.pos },
        vel: fromAngle(angle, speed),
        life: rand(0.4, 0.9),
        maxLife: 0.9,
        size: rand(1.2, 2.4),
        // White burst — match the pod's neutral look. Hue 0 with low
        // saturation in the particle renderer reads as white/grey.
        hue: 0,
        shrink: 1,
        drag: 1.8,
      });
    }
  }

  collectCanister(c: Canister) {
    this.sound.play("powerup");
    if (c.kind === "slow") {
      this.slowMoTimer = SLOW_MO_DURATION;
    } else {
      // Picking up rapid is the only mid-life event that flips comboGrid()
      // (quarters → 8ths). Each quarter-beat index k points at the same
      // musical moment as 8th-beat index 2k, so rescale the stored indices
      // so an in-flight streak chains into the new grid without resetting.
      if (c.kind === "rapid" && !this.ship.rapidActive) {
        if (this.lastMarkedBeatIndex >= 0) this.lastMarkedBeatIndex *= 2;
        const eighth = BEAT_GRID / 2;
        const firstUnclosedEighth = Math.max(0, Math.floor((this.beatTime - BEAT_WINDOW) / eighth) + 1);
        this.nextBeatToEvaluate = Math.max(this.lastMarkedBeatIndex + 1, firstUnclosedEighth);
      }
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

  hitSoundFor(a: Asteroid): "explosionLarge" | "explosionMedium" | "explosionSmall" | "chime" | "bell" | "warble" | "tink" {
    // Bassteroids have their own multi-hit handling in handleCollisions
    // (bassHit on every hit, bassEcho + explosion on the killing hit), so
    // this helper only covers the non-bass kinds now.
    if (a.kind === "chime") return "chime";
    if (a.kind === "bell") return "bell";
    if (a.kind === "warble") return "warble";
    if (a.kind === "tink") return "tink";
    return a.size === "large" ? "explosionLarge" : a.size === "medium" ? "explosionMedium" : "explosionSmall";
  }

  // Rock-shard burst for a non-killing bassteroid hit. Heavier and chunkier
  // than the old crumple-spark — slow dark debris reading as fragments
  // breaking off rather than sparks flying. Player reads "I cracked it" not
  // "I killed it".
  emitCrackParticles(a: Asteroid, onBeat: boolean) {
    const chunkCount = onBeat ? 14 : 9;
    const chunkIndices = Array.from({ length: chunkCount }, (_, i) => i);
    for (const _ of chunkIndices) {
      const angle = rand(0, TAU);
      const speed = rand(60, 180);
      this.particles.emit({
        pos: { ...a.pos },
        vel: fromAngle(angle, speed),
        life: rand(0.35, 0.7),
        maxLife: 0.7,
        size: rand(1.6, 2.8),
        hue: a.hue + rand(-8, 12),
        shrink: 1,
        drag: 3.0,
      });
    }
    if (onBeat) {
      const sparkleIndices = Array.from({ length: 8 }, (_, i) => i);
      for (const i of sparkleIndices) {
        const angle = (i / sparkleIndices.length) * TAU + rand(-0.08, 0.08);
        const speed = rand(140, 220);
        this.particles.emit({
          pos: { ...a.pos },
          vel: fromAngle(angle, speed),
          life: rand(0.25, 0.5),
          maxLife: 0.5,
          size: rand(1.4, 2.0),
          hue: 48 + rand(-6, 12),
          shrink: 1,
          drag: 2.2,
        });
      }
    }
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
    this.pulsar.render(ctx);

    for (const s of this.shards) s.render(ctx);
    for (const a of this.asteroids) a.render(ctx, this.time);
    for (const c of this.canisters) c.render(ctx, this.time);
    for (const al of this.aliens) al.render(ctx, this.time);
    for (const ab of this.alienBullets) ab.render(ctx);
    for (const b of this.bullets) b.render(ctx);
    this.particles.render(ctx);
    this.ship.renderReticules(ctx, BEAT_GRID, this.w, this.h);
    this.ship.render(ctx, this.time, this.currentBeatPulse());

    ctx.restore();
  }
}
