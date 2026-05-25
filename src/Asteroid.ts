import { Vec, v, add, mul, fromAngle, wrap, rand, TAU } from "./vec";

const HUE_PALETTE = [185, 200, 220, 250, 280, 310, 330];

let huePaletteCursor = Math.floor(Math.random() * HUE_PALETTE.length);
export const nextWaveHue = (): number => {
  huePaletteCursor = (huePaletteCursor + 1 + Math.floor(Math.random() * (HUE_PALETTE.length - 1))) % HUE_PALETTE.length;
  return HUE_PALETTE[huePaletteCursor];
};

type Harmonic = { amp: number; freq: number; phase: number };

type Nucleus = {
  angle: number;
  dist: number;
  size: number;
  pulsePhase: number;
  pulseSpeed: number;
};

export type AsteroidSize = "large" | "medium" | "small";

// "bassA" / "bassB" / "bassC" / "bassD" are the four layered bass-track
// "ships" — one per beat slot in a 4-beat measure (4 beats × 0.5s = 2s at
// 120 BPM). Their gen-0 offsets stagger them: A→beat1, B→beat2, C→beat3,
// D→beat4. Each kind has its own distinct percussive sound (kick / pluck /
// boom / snap, all in or around C major) so multiple kinds layered on a
// beat still harmonise.
//
// Unlike organic asteroids, bass ships are armoured: a large piece has 4 HP
// and takes that many hits before exploding, each hit leaving visible
// crumple damage. On the final hit it splits into two medium pieces
// (2 HP each) that share the parent's kind but sit half a measure apart —
// gen-1 bassA fires beats 1+3, gen-1 bassB fires 2+4, gen-1 bassC fires
// 3+1, gen-1 bassD fires 4+2. Splitting again subdivides further into
// quarter-measure offsets: four gen-2 small pieces (1 HP each) cover all
// four beats with the parent kind's voice. Every bass hit also triggers a
// deeper bass-echo overlay sound on top of the regular hit.
//
// "chime", "bell", "warble" are sound-decorator asteroids that behave exactly
// like normal ones but trigger a distinctive musical hit sound.
//
// "tink" is a rare one-shot crystal: spawned occasionally as a small asteroid
// (so it can't split) and emits the sharp glassy "tink" sound on destruction.
// Treat it as a "sometimes-found" treat — if you start seeing tink asteroids
// every wave, lower the per-wave spawn chance in Game.
export type AsteroidKind = "normal" | "bassA" | "bassB" | "bassC" | "bassD" | "chime" | "bell" | "warble" | "tink";

export const BASS_KINDS: ReadonlyArray<"bassA" | "bassB" | "bassC" | "bassD"> = ["bassA", "bassB", "bassC", "bassD"];

const SIZE_RADIUS: Record<AsteroidSize, number> = {
  large: 50,
  medium: 28,
  small: 16,
};

const SIZE_SPAWN_SPEED: Record<AsteroidSize, [number, number]> = {
  large: [40, 90],
  medium: [55, 105],
  small: [75, 125],
};

const splitChildSpeed = (parentVel: Vec, childSize: AsteroidSize): number => {
  const parentSpeed = Math.hypot(parentVel.x, parentVel.y);
  if (childSize === "medium") return parentSpeed * rand(1.2, 1.7) + 40;
  return parentSpeed * rand(1.35, 1.9) + 55;
};

const SIZE_SCORE: Record<AsteroidSize, number> = {
  large: 20,
  medium: 50,
  small: 100,
};

const KIND_HUE: Partial<Record<AsteroidKind, number>> = {
  bassA: 0,
  bassB: 28,
  bassC: 215,
  bassD: 290,
  chime: 52,
  bell: 285,
  warble: 130,
  tink: 195,
};

// Length of one musical measure (seconds). 4 beats at 120 BPM × 0.5s/beat.
// Every bass asteroid fires exactly once per measure regardless of split
// generation; what changes with splitting is which beat-slot in the measure
// each piece occupies (see `split()` below).
export const BASS_MEASURE_LENGTH = 2.0;

// Within-measure offset (seconds) for a freshly-spawned gen-0 asteroid of
// each kind. Each kind sits on its own beat slot so the four interlock into
// a kick-pluck-kick-pluck pattern when all four are on the field.
export const BASS_KIND_BASE_OFFSET: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
  bassA: 0.0,
  bassB: 0.5,
  bassC: 1.0,
  bassD: 1.5,
};

// Maximum number of times a bass ship can be split. 0 = gen-0 (large, 4 HP),
// 1 = gen-1 (medium, 2 HP), 2 = gen-2 (small, 1 HP, terminal). Two splits
// stops the subdivision at quarter-notes, which is the densest pattern that
// still reads as rhythm rather than mush.
export const BASS_MAX_SPLIT_LEVEL = 2;

// Per-size hit point counts for bass ships. Large gen-0 takes 4 hits before
// splitting into two mediums; mediums take 2 hits before splitting into two
// smalls; smalls are terminal one-shots. Each non-killing hit leaves a
// visible crumple dent on the body.
export const BASS_HP: Record<AsteroidSize, number> = {
  large: 4,
  medium: 2,
  small: 1,
};

// Vertex list (local-space, normalised to radius=1) for one armoured panel
// of a bass ship. Each kind is a fixed cluster of these panels — drawn with
// hard edges and bright outlines so they read as built-by-hand spaceships
// rather than the organic Fourier blobs everything else uses.
type BassModule = { vertices: Vec[] };

// Per-kind hard-points: little glowing dots painted on top of the panels.
// Treated as "running lights" so each kind has a memorable silhouette even
// when crumple damage has gnawed at the panel outlines.
type BassLight = { pos: Vec; size: number };

type BassShip = { modules: BassModule[]; lights: BassLight[] };

const rect = (x1: number, y1: number, x2: number, y2: number): BassModule => ({
  vertices: [v(x1, y1), v(x2, y1), v(x2, y2), v(x1, y2)],
});

const hexagon = (cx: number, cy: number, r: number, rot = 0): BassModule => {
  const verts: Vec[] = [];
  for (let i = 0; i < 6; i++) {
    const a = rot + (i / 6) * TAU;
    verts.push(v(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return { vertices: verts };
};

// Each kind is hand-tuned to look distinct at a glance — silhouettes are
// the primary identifier since hues blend together under additive blending.
//   bassA: "Hauler"     — long horizontal hull + side pods, cockpit on right
//   bassB: "Tri-cluster"— three hex pods around a central hub
//   bassC: "Cross"      — square core with four cardinal arms
//   bassD: "Tower"      — vertical stack (engine block, tank, cockpit cone)
// Coordinates are in radius-units; the renderer scales by this.radius.
const buildBassShip = (kind: "bassA" | "bassB" | "bassC" | "bassD"): BassShip => {
  if (kind === "bassA") {
    return {
      modules: [
        rect(-0.85, -0.28, 0.55, 0.28),
        { vertices: [v(0.55, -0.28), v(0.98, 0), v(0.55, 0.28)] },
        rect(-0.55, -0.68, 0.25, -0.32),
        rect(-0.55, 0.32, 0.25, 0.68),
        { vertices: [v(-0.85, -0.22), v(-1.02, -0.08), v(-1.02, 0.08), v(-0.85, 0.22)] },
      ],
      lights: [
        { pos: v(0.7, 0), size: 0.06 },
        { pos: v(-0.15, -0.5), size: 0.05 },
        { pos: v(-0.15, 0.5), size: 0.05 },
        { pos: v(-0.95, 0), size: 0.07 },
      ],
    };
  }
  if (kind === "bassB") {
    const podRadius = 0.34;
    return {
      modules: [
        hexagon(0, -0.5, podRadius),
        hexagon(-0.46, 0.28, podRadius),
        hexagon(0.46, 0.28, podRadius),
        hexagon(0, 0, 0.18),
        rect(-0.04, -0.45, 0.04, -0.16),
        rect(-0.42, 0.25, -0.16, 0.13),
        rect(0.16, 0.13, 0.42, 0.25),
      ],
      lights: [
        { pos: v(0, -0.5), size: 0.06 },
        { pos: v(-0.46, 0.28), size: 0.06 },
        { pos: v(0.46, 0.28), size: 0.06 },
        { pos: v(0, 0), size: 0.05 },
      ],
    };
  }
  if (kind === "bassC") {
    return {
      modules: [
        rect(-0.32, -0.32, 0.32, 0.32),
        rect(-0.14, -0.96, 0.14, -0.32),
        rect(-0.14, 0.32, 0.14, 0.96),
        rect(0.32, -0.14, 0.96, 0.14),
        rect(-0.96, -0.14, -0.32, 0.14),
      ],
      lights: [
        { pos: v(0, -0.92), size: 0.06 },
        { pos: v(0, 0.92), size: 0.06 },
        { pos: v(0.92, 0), size: 0.06 },
        { pos: v(-0.92, 0), size: 0.06 },
        { pos: v(0, 0), size: 0.07 },
      ],
    };
  }
  return {
    modules: [
      { vertices: [v(-0.55, 0.98), v(0.55, 0.98), v(0.32, 0.55), v(-0.32, 0.55)] },
      rect(-0.38, 0.0, 0.38, 0.55),
      rect(-0.28, -0.5, 0.28, 0.0),
      { vertices: [v(-0.28, -0.5), v(0, -0.95), v(0.28, -0.5)] },
      { vertices: [v(-0.38, 0.1), v(-0.72, 0.32), v(-0.38, 0.4)] },
      { vertices: [v(0.38, 0.1), v(0.72, 0.32), v(0.38, 0.4)] },
    ],
    lights: [
      { pos: v(-0.28, 0.78), size: 0.06 },
      { pos: v(0.28, 0.78), size: 0.06 },
      { pos: v(0, 0.28), size: 0.05 },
      { pos: v(0, -0.78), size: 0.06 },
    ],
  };
};

// Pre-rolled local-space placements for crumple dents. We generate one extra
// over the worst case (4 for large) so the layout's RNG settles before any
// damage is taken — dents reveal in order as hits land so the same ship
// gives a consistent, escalating wreck silhouette per playthrough.
type BassDent = { pos: Vec; size: number; angle: number };
const rollBassDents = (count: number): BassDent[] => {
  const dents: BassDent[] = [];
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU);
    const r = rand(0.2, 0.78);
    dents.push({ pos: v(Math.cos(a) * r, Math.sin(a) * r), size: rand(0.18, 0.28), angle: rand(0, TAU) });
  }
  return dents;
};

export class Asteroid {
  pos: Vec;
  vel: Vec;
  size: AsteroidSize;
  radius: number;
  rotation: number;
  rotSpeed: number;
  hue: number;
  harmonics: Harmonic[];
  nuclei: Nucleus[];
  outline: number[];
  outlineSamples = 60;
  membranePhase: number;
  flashAmount = 0;
  // Pre-rendered offscreen sprite of the static body (halo, outline, interior,
  // filaments, baseline nucleus glow). Built once in the constructor. Per-frame
  // rendering is a single drawImage + a couple of cheap pulse/flash overlays.
  sprite: HTMLCanvasElement | null = null;
  spriteHalfSize = 0;
  kind: AsteroidKind;
  // For bass kinds, the within-measure beat slot (seconds) this piece
  // occupies. Always equal to `BASS_KIND_BASE_OFFSET[kind]` — split children
  // inherit the parent's slot rather than subdividing, so the beat each
  // kind plays never moves. Unused for non-bass kinds.
  measureOffset = 0;
  // Number of times this bass ship has already been split. 0 = gen-0 large,
  // 1 = gen-1 medium (terminal — its final hit destroys it outright).
  // Always 0 for non-bass kinds.
  splitLevel = 0;
  // Game-time (seconds) at which this bass asteroid should fire its next
  // beat. Set by Game when the asteroid is spawned / split. Unused for
  // non-bass kinds.
  nextBeatAt = 0;
  // Bass armour. Each non-killing bullet hit decrements `hp` by 1 and
  // reveals one more entry in `dents`; the killing hit (hp → 0) either
  // splits the ship (large → 2 medium) or destroys it outright (medium).
  // Unused for non-bass kinds.
  hp = 0;
  maxHp = 0;
  dents: BassDent[] = [];
  bassShip: BassShip | null = null;
  // Lingering "I just played a beat" flare. Independent from `flashAmount`
  // (the bullet-hit flash) so a beat-flash and a hit-flash can co-exist
  // without overwriting each other. Set to 1.0 in tickBassBeats and decays
  // a little slower so the visual beat actually lands.
  beatFlash = 0;

  constructor(pos: Vec, vel: Vec, size: AsteroidSize, hue?: number, kind: AsteroidKind = "normal") {
    this.pos = pos;
    this.vel = vel;
    this.size = size;
    this.radius = SIZE_RADIUS[size];
    this.rotation = rand(0, TAU);
    this.rotSpeed = rand(-0.6, 0.6);
    this.kind = kind;
    if (kind === "bassA" || kind === "bassB" || kind === "bassC" || kind === "bassD") {
      this.measureOffset = BASS_KIND_BASE_OFFSET[kind];
      this.bassShip = buildBassShip(kind);
      this.maxHp = BASS_HP[size];
      this.hp = this.maxHp;
      this.dents = rollBassDents(this.maxHp);
      // Bass ships orient by intent (engines/cockpit point a way) so a
      // wildly spinning silhouette would muddy the modular read. Keep them
      // drifting slowly.
      this.rotSpeed = rand(-0.18, 0.18);
    }
    const kindHue = KIND_HUE[kind];
    this.hue = hue ?? (kindHue !== undefined ? kindHue : nextWaveHue());
    this.harmonics = [];
    const harmonicLayerFrequencies = [2, 3, 5, 7];
    for (const freq of harmonicLayerFrequencies) {
      this.harmonics.push({
        amp: rand(0.05, 0.18) / Math.sqrt(freq),
        freq,
        phase: rand(0, TAU),
      });
    }
    this.outline = this.computeOutline();
    this.nuclei = [];
    const nucleusCount = size === "large" ? 5 : size === "medium" ? 3 : 2;
    const nucleusIndices = Array.from({ length: nucleusCount }, (_, i) => i);
    for (const i of nucleusIndices) {
      this.nuclei.push({
        angle: (i / nucleusCount) * TAU + rand(-0.3, 0.3),
        dist: rand(0.15, 0.55) * this.radius,
        size: rand(2, 4) * (size === "large" ? 1.3 : 1),
        pulsePhase: rand(0, TAU),
        pulseSpeed: rand(1.2, 2.4),
      });
    }
    this.membranePhase = rand(0, TAU);
    this.sprite = this.buildSprite();
  }

  buildSprite(): HTMLCanvasElement {
    if (this.isBass()) return this.buildBassSprite();
    const haloRadius = this.radius * 2.3;
    const padding = 14;
    const size = Math.ceil(2 * (haloRadius + padding));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    this.spriteHalfSize = size / 2;

    ctx.translate(size / 2, size / 2);
    ctx.globalCompositeOperation = "lighter";
    const baseHue = this.hue;

    const halo = ctx.createRadialGradient(0, 0, this.radius * 0.7, 0, 0, haloRadius);
    halo.addColorStop(0, `hsla(${baseHue}, 100%, 60%, 0.12)`);
    halo.addColorStop(0.5, `hsla(${baseHue + 10}, 100%, 55%, 0.048)`);
    halo.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, TAU);
    ctx.fill();

    ctx.beginPath();
    const outlineSampleIndices = Array.from({ length: this.outlineSamples }, (_, i) => i);
    for (const i of outlineSampleIndices) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const interior = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius);
    interior.addColorStop(0, `hsla(${baseHue}, 80%, 30%, 0.35)`);
    interior.addColorStop(0.7, `hsla(${baseHue - 10}, 70%, 18%, 0.25)`);
    interior.addColorStop(1, `hsla(${baseHue}, 60%, 10%, 0.05)`);
    ctx.fillStyle = interior;
    ctx.fill();

    ctx.lineWidth = 1.3;
    ctx.strokeStyle = `hsla(${baseHue + 10}, 100%, 75%, 0.7)`;
    ctx.shadowColor = `hsla(${baseHue}, 100%, 65%, 1)`;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.clip();
    const filamentCount = this.size === "large" ? 6 : this.size === "medium" ? 4 : 3;
    ctx.strokeStyle = `hsla(${baseHue + 5}, 90%, 70%, 0.18)`;
    ctx.lineWidth = 0.6;
    const filamentIndexList = Array.from({ length: filamentCount }, (_, i) => i);
    for (const i of filamentIndexList) {
      const fa = (i / filamentCount) * TAU + this.membranePhase * 0.2;
      ctx.beginPath();
      ctx.moveTo(-this.radius, Math.sin(fa) * this.radius * 0.4);
      ctx.bezierCurveTo(
        -this.radius * 0.3, Math.cos(fa * 2) * this.radius * 0.5,
        this.radius * 0.3, Math.sin(fa * 1.5 + 1) * this.radius * 0.5,
        this.radius, Math.cos(fa) * this.radius * 0.4,
      );
      ctx.stroke();
    }
    ctx.restore();

    const bakedNucleusPulse = 0.7;
    for (const n of this.nuclei) {
      const nx = Math.cos(n.angle) * n.dist;
      const ny = Math.sin(n.angle) * n.dist;
      const nucleusRadius = n.size * 6 * bakedNucleusPulse;
      const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, nucleusRadius);
      grad.addColorStop(0, `hsla(${baseHue + 15}, 100%, 90%, ${0.9 * bakedNucleusPulse})`);
      grad.addColorStop(0.4, `hsla(${baseHue}, 100%, 65%, ${0.45 * bakedNucleusPulse})`);
      grad.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(nx, ny, nucleusRadius, 0, TAU);
      ctx.fill();
    }

    return canvas;
  }

  // Pre-rendered modular spaceship body for bass kinds. Hard-edged panels
  // with bright outlines, a tight halo, engine glow, and "running lights"
  // give each kind a memorable silhouette distinct from the organic shapes
  // everything else uses. Crumple dents and the beat-flash are drawn live
  // in `render()` because they animate per frame.
  buildBassSprite(): HTMLCanvasElement {
    const haloRadius = this.radius * 1.6;
    const padding = 18;
    const size = Math.ceil(2 * (haloRadius + padding));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    this.spriteHalfSize = size / 2;
    const ship = this.bassShip!;
    const r = this.radius;
    const baseHue = this.hue;

    ctx.translate(size / 2, size / 2);
    ctx.globalCompositeOperation = "lighter";

    const halo = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, haloRadius);
    halo.addColorStop(0, `hsla(${baseHue}, 100%, 60%, 0.22)`);
    halo.addColorStop(0.6, `hsla(${baseHue + 12}, 100%, 55%, 0.06)`);
    halo.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, TAU);
    ctx.fill();

    const tracePanel = (module: BassModule) => {
      ctx.beginPath();
      for (let i = 0; i < module.vertices.length; i++) {
        const x = module.vertices[i].x * r;
        const y = module.vertices[i].y * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    ctx.shadowColor = `hsla(${baseHue}, 100%, 65%, 1)`;
    for (const module of ship.modules) {
      tracePanel(module);
      const fill = ctx.createLinearGradient(-r, -r, r, r);
      fill.addColorStop(0, `hsla(${baseHue}, 70%, 22%, 0.85)`);
      fill.addColorStop(0.5, `hsla(${baseHue + 8}, 65%, 32%, 0.85)`);
      fill.addColorStop(1, `hsla(${baseHue - 5}, 75%, 14%, 0.85)`);
      ctx.fillStyle = fill;
      ctx.shadowBlur = 0;
      ctx.fill();
      ctx.shadowBlur = 10;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = `hsla(${baseHue + 12}, 100%, 78%, 0.95)`;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Inner panel-line accents: a thin bright stripe inside each module so
    // the surface reads as plated metal rather than a flat fill.
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 85%, 0.45)`;
    for (const module of ship.modules) {
      ctx.save();
      tracePanel(module);
      ctx.clip();
      const cx = module.vertices.reduce((s, p) => s + p.x, 0) / module.vertices.length * r;
      const cy = module.vertices.reduce((s, p) => s + p.y, 0) / module.vertices.length * r;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.4, cy);
      ctx.lineTo(cx + r * 0.4, cy);
      ctx.stroke();
      ctx.restore();
    }

    for (const light of ship.lights) {
      const lx = light.pos.x * r;
      const ly = light.pos.y * r;
      const lr = light.size * r * 1.4;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr * 3);
      lg.addColorStop(0, `hsla(${baseHue + 30}, 100%, 96%, 1)`);
      lg.addColorStop(0.35, `hsla(${baseHue + 10}, 100%, 75%, 0.6)`);
      lg.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `hsla(${baseHue + 40}, 100%, 98%, 1)`;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 0.6, 0, TAU);
      ctx.fill();
    }

    return canvas;
  }

  computeOutline(): number[] {
    const samples: number[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      let r = 1;
      for (const harmonic of this.harmonics) {
        r += harmonic.amp * Math.cos(angle * harmonic.freq + harmonic.phase);
      }
      samples.push(r * this.radius);
    }
    return samples;
  }

  radiusAtAngle(angle: number): number {
    let r = 1;
    for (const harmonic of this.harmonics) {
      r += harmonic.amp * Math.cos(angle * harmonic.freq + harmonic.phase);
    }
    return r * this.radius;
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    const dx = point.x - this.pos.x;
    const dy = point.y - this.pos.y;
    const distance = Math.hypot(dx, dy);
    if (distance > this.radius * 1.3) return false;
    // Bass ships are modular silhouettes, not organic blobs — use a tight
    // circle for the hitbox. 0.88 is a feel-tuned shrink so glancing shots
    // miss the gaps between modules instead of registering on empty space.
    if (this.isBass()) return distance < this.radius * 0.88 + pointRadius;
    const localAngle = Math.atan2(dy, dx) - this.rotation;
    const surface = this.radiusAtAngle(localAngle);
    return distance < surface + pointRadius;
  }

  hit() {
    this.flashAmount = 1;
  }

  // Apply one bullet's worth of damage to a bass ship. Decrements HP and
  // returns whether the ship is now dead. Non-killing hits leave a visible
  // crumple dent in `dents`. Caller (Game.handleCollisions) is responsible
  // for emitting effects and dispatching to `split()` on a kill.
  applyBassDamage(): { killed: boolean } {
    this.hp = Math.max(0, this.hp - 1);
    this.flashAmount = 1;
    return { killed: this.hp <= 0 };
  }

  update(dt: number, w: number, h: number) {
    this.rotation += this.rotSpeed * dt;
    this.membranePhase += dt * 0.8;
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
    // Beat flare decays a touch slower than the hit flash so the visible
    // pulse rides the audio kick all the way through the beat window.
    if (this.beatFlash > 0) this.beatFlash = Math.max(0, this.beatFlash - dt * 2.6);
    // Nucleus orbital drift is baked into the sprite so we no longer rotate
    // it here — the per-frame pulse highlight handles the only visible motion.
  }

  scoreValue(): number {
    return SIZE_SCORE[this.size];
  }

  isBass(): boolean {
    return this.kind === "bassA" || this.kind === "bassB" || this.kind === "bassC" || this.kind === "bassD";
  }

  split(): Asteroid[] {
    // Bass: each split subdivides the parent's beat slot. Gen-0 (large) → 2
    // gen-1 (medium) half a measure apart, gen-1 → 2 gen-2 (small) a quarter
    // measure apart, gen-2 is terminal. Children keep the parent's kind
    // (and therefore the parent's voice) so the four percussive timbres
    // spread across the measure as the field thickens. Fresh HP per the
    // child size — no carryover from the parent.
    if (this.isBass()) {
      if (this.splitLevel >= BASS_MAX_SPLIT_LEVEL) return [];
      const childLevel = this.splitLevel + 1;
      const childSize: AsteroidSize = childLevel === 1 ? "medium" : "small";
      const splitDelta = BASS_MEASURE_LENGTH / Math.pow(2, childLevel);
      const childOffsets = [
        this.measureOffset,
        (this.measureOffset + splitDelta) % BASS_MEASURE_LENGTH,
      ];
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 2; i++) {
        const a = Math.atan2(this.vel.y, this.vel.x) + rand(-0.9, 0.9) + (i === 0 ? -1 : 1) * 0.5;
        const speedMag = splitChildSpeed(this.vel, childSize);
        const child = new Asteroid({ ...this.pos }, fromAngle(a, speedMag), childSize, this.hue, this.kind);
        child.splitLevel = childLevel;
        child.measureOffset = childOffsets[i];
        fragmentList.push(child);
      }
      return fragmentList;
    }
    if (this.size === "small") return [];
    const nextSize: AsteroidSize = this.size === "large" ? "medium" : "small";
    const fragmentCount = 2;
    const fragmentList: Asteroid[] = [];
    for (let i = 0; i < fragmentCount; i++) {
      const a = Math.atan2(this.vel.y, this.vel.x) + rand(-0.9, 0.9) + (i === 0 ? -1 : 1) * 0.5;
      const speedMag = splitChildSpeed(this.vel, nextSize);
      fragmentList.push(new Asteroid({ ...this.pos }, fromAngle(a, speedMag), nextSize, this.hue, this.kind));
    }
    return fragmentList;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    if (this.isBass()) {
      this.renderBass(ctx);
      return;
    }
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    const baseHue = this.hue;
    const time = t * 0.001;
    const membraneSwell = 1 + 0.025 * Math.sin(this.membranePhase * 0.5);
    ctx.scale(membraneSwell, membraneSwell);
    ctx.globalCompositeOperation = "lighter";

    if (this.sprite) {
      ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);
    }

    const nucleusList = this.nuclei;
    for (const n of nucleusList) {
      const driftR = n.dist + Math.sin(time * n.pulseSpeed + n.pulsePhase) * 2;
      const nx = Math.cos(n.angle) * driftR;
      const ny = Math.sin(n.angle) * driftR;
      const pulse = 0.6 + 0.4 * Math.sin(time * n.pulseSpeed * 2 + n.pulsePhase);
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 96%, ${pulse})`;
      ctx.beginPath();
      ctx.arc(nx, ny, n.size * 0.9, 0, TAU);
      ctx.fill();
    }

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 95%, ${this.flashAmount * 0.25})`;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 1.1, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  // Render path for bass ships: pre-baked modular sprite + live crumple
  // dents (one per HP lost) + a big bright beat flare on the beat. The
  // beat flare gates the visual rhythm — when all four kinds are active
  // it reads as a syncopated lighthouse sweep across the screen.
  renderBass(ctx: CanvasRenderingContext2D) {
    const baseHue = this.hue;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    // Beat-time bloom that lives OUTSIDE the rotated/scaled body so it
    // reads as a halo around the ship rather than a co-rotating disc.
    if (this.beatFlash > 0) {
      ctx.globalCompositeOperation = "lighter";
      const bloom = ctx.createRadialGradient(0, 0, this.radius * 0.4, 0, 0, this.radius * 2.6);
      const a = this.beatFlash;
      bloom.addColorStop(0, `hsla(${baseHue + 30}, 100%, 90%, ${0.85 * a})`);
      bloom.addColorStop(0.35, `hsla(${baseHue + 10}, 100%, 70%, ${0.45 * a})`);
      bloom.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 2.6, 0, TAU);
      ctx.fill();
      // Bright kicked-up rim so the beat reads even against a busy field.
      ctx.strokeStyle = `hsla(${baseHue + 25}, 100%, 88%, ${0.9 * a})`;
      ctx.lineWidth = 2.4 + 2.6 * a;
      ctx.shadowColor = `hsla(${baseHue + 15}, 100%, 80%, 1)`;
      ctx.shadowBlur = 22 + 18 * a;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * (1.15 + 0.18 * a), 0, TAU);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.rotate(this.rotation);
    // A small scale-up on the beat (cosmetic only — collisions still use
    // this.radius). Capped low enough that the ship doesn't appear to grow
    // into the player's path during a rhythm window.
    const beatScale = 1 + 0.06 * this.beatFlash;
    ctx.scale(beatScale, beatScale);
    ctx.globalCompositeOperation = "lighter";

    if (this.sprite) {
      ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);
    }

    const dentsToDraw = this.maxHp - this.hp;
    if (dentsToDraw > 0) {
      // Crumple dent overlays. Drawn in source-over (a dark scorch blob on
      // top of the panel) rather than destination-out so we don't punch
      // holes through the starfield behind the ship. Then a bright ember
      // dot in additive mode reads as the still-hot impact crater.
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      for (let i = 0; i < dentsToDraw; i++) {
        const dent = this.dents[i];
        const dx = dent.pos.x * this.radius;
        const dy = dent.pos.y * this.radius;
        const ds = dent.size * this.radius;
        ctx.save();
        ctx.translate(dx, dy);
        ctx.rotate(dent.angle);
        const scorch = ctx.createRadialGradient(0, 0, 0, 0, 0, ds);
        scorch.addColorStop(0, "rgba(8,4,2,0.95)");
        scorch.addColorStop(0.6, "rgba(20,8,4,0.75)");
        scorch.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = scorch;
        ctx.beginPath();
        ctx.moveTo(-ds, -ds * 0.35);
        ctx.lineTo(ds * 0.4, -ds * 0.6);
        ctx.lineTo(ds, -ds * 0.05);
        ctx.lineTo(ds * 0.5, ds * 0.55);
        ctx.lineTo(-ds * 0.25, ds * 0.4);
        ctx.lineTo(-ds * 0.85, ds * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(${baseHue + 18}, 100%, 80%, 0.9)`;
      ctx.lineWidth = 1.1;
      ctx.shadowColor = `hsla(20, 100%, 60%, 1)`;
      ctx.shadowBlur = 6;
      for (let i = 0; i < dentsToDraw; i++) {
        const dent = this.dents[i];
        const dx = dent.pos.x * this.radius;
        const dy = dent.pos.y * this.radius;
        const ds = dent.size * this.radius;
        ctx.beginPath();
        ctx.arc(dx, dy, ds * 0.7, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = `hsla(20, 100%, 75%, 0.85)`;
        ctx.beginPath();
        ctx.arc(dx, dy, ds * 0.18, 0, TAU);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 95%, ${this.flashAmount * 0.32})`;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 1.05, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }
}

export const spawnAsteroidAtEdge = (
  w: number,
  h: number,
  hue?: number,
  kind: AsteroidKind = "normal",
  size: AsteroidSize = "large",
): Asteroid => {
  const edge = Math.floor(Math.random() * 4);
  let pos: Vec;
  if (edge === 0) pos = v(rand(0, w), -40);
  else if (edge === 1) pos = v(w + 40, rand(0, h));
  else if (edge === 2) pos = v(rand(0, w), h + 40);
  else pos = v(-40, rand(0, h));
  const center = v(w / 2 + rand(-w * 0.2, w * 0.2), h / 2 + rand(-h * 0.2, h * 0.2));
  const dirX = center.x - pos.x;
  const dirY = center.y - pos.y;
  const norm = Math.hypot(dirX, dirY);
  const [speedMin, speedMax] = SIZE_SPAWN_SPEED[size];
  const speed = rand(speedMin, speedMax);
  return new Asteroid(pos, v((dirX / norm) * speed, (dirY / norm) * speed), size, hue, kind);
};
