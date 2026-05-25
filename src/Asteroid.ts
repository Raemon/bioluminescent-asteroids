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

// "bassA" / "bassB" / "bassC" / "bassD" are the four layered bassteroid
// kinds — one per beat slot in a 4-beat measure (4 beats × 0.5s = 2s at
// 120 BPM). Their gen-0 offsets stagger them: A→beat1, B→beat2, C→beat3,
// D→beat4. Each kind has its own distinct percussive sound (kick / pluck /
// boom / snap, all in or around C major) so multiple kinds layered on a
// beat still harmonise.
//
// Unlike organic asteroids, bassteroids are armoured: a large piece has 4 HP
// and takes that many hits before exploding, each hit leaving visible
// crack damage. On the final hit it splits into two medium pieces
// (2 HP each) that share the parent's kind but sit half a measure apart —
// gen-1 bassA fires beats 1+3, gen-1 bassB fires 2+4, gen-1 bassC fires
// 3+1, gen-1 bassD fires 4+2. Splitting again subdivides further into
// quarter-measure offsets: four gen-2 small pieces (1 HP each) cover all
// four beats with the parent kind's voice. Every bassteroid hit also
// triggers a deeper bass-echo overlay sound on top of the regular hit.
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
// Every bassteroid fires exactly once per measure regardless of split
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

// Maximum number of times a bassteroid can be split. 0 = gen-0 (large, 4 HP),
// 1 = gen-1 (medium, 2 HP), 2 = gen-2 (small, 1 HP, terminal). Two splits
// stops the subdivision at quarter-notes, which is the densest pattern that
// still reads as rhythm rather than mush.
export const BASS_MAX_SPLIT_LEVEL = 2;

// General per-size hit point counts. Every asteroid uses this table now —
// each non-killing hit leaves a visible crack on the body, and the killing
// hit explodes (and splits, for non-terminal sizes). Non-rhythm bullets deal
// 1 damage so an unsynced run needs 4/2/1 shots for a large/medium/small;
// rhythm bullets deal 4 damage so a well-timed shot one-shots anything in
// this table.
export const ASTEROID_HP: Record<AsteroidSize, number> = {
  large: 4,
  medium: 2,
  small: 1,
};

// Bassteroids are 4× tougher than the table above so the rhythm system has
// real teeth — even a rhythm-bullet (4 damage) needs four hits to crack a
// large bassteroid, matching the "armoured" silhouette they already wear.
export const BASS_HP_MULTIPLIER = 4;
export const BASS_HP: Record<AsteroidSize, number> = {
  large: ASTEROID_HP.large * BASS_HP_MULTIPLIER,
  medium: ASTEROID_HP.medium * BASS_HP_MULTIPLIER,
  small: ASTEROID_HP.small * BASS_HP_MULTIPLIER,
};

// Vertex list (local-space, normalised to radius=1) for one armoured panel
// of a bassteroid. Each kind is a fixed cluster of these panels — drawn with
// hard edges and bright outlines so they read as built-by-hand spaceships
// rather than the organic Fourier blobs everything else uses.
type BassModule = { vertices: Vec[] };

// Per-kind hard-points: little glowing dots painted on top of the panels.
// Treated as "running lights" so each kind has a memorable silhouette even
// when crack damage has gnawed at the panel outlines.
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
const buildBassteroidShape = (kind: "bassA" | "bassB" | "bassC" | "bassD"): BassShip => {
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

// Pre-rolled local-space placements for crack damage. We generate one entry
// per HP — cracks reveal in order as hits land so the same bassteroid gives
// a consistent, escalating fracture pattern per playthrough. Each crack is
// a jagged poly-line through the impact point: `branches` are line segments
// fanning outward from local origin, all in radius-units.
type AsteroidCrack = {
  pos: Vec;
  size: number;
  angle: number;
  branches: { points: Vec[] }[];
};
const rollCracks = (count: number): AsteroidCrack[] => {
  const cracks: AsteroidCrack[] = [];
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU);
    const r = rand(0.2, 0.78);
    const size = rand(0.28, 0.42);
    // 3–4 jagged forks per impact, each a short zig-zag polyline radiating
    // from the impact centre. Forks are stored in local crack-space; the
    // renderer translates+rotates them into the bassteroid's frame.
    const forkCount = 3 + Math.floor(Math.random() * 2);
    const branches: { points: Vec[] }[] = [];
    for (let f = 0; f < forkCount; f++) {
      const baseAngle = (f / forkCount) * TAU + rand(-0.4, 0.4);
      const segments = 3 + Math.floor(Math.random() * 2);
      const points: Vec[] = [v(0, 0)];
      let cx = 0;
      let cy = 0;
      let ang = baseAngle;
      for (let s = 0; s < segments; s++) {
        const len = size * rand(0.35, 0.7);
        ang += rand(-0.7, 0.7);
        cx += Math.cos(ang) * len;
        cy += Math.sin(ang) * len;
        points.push(v(cx, cy));
      }
      branches.push({ points });
    }
    cracks.push({ pos: v(Math.cos(a) * r, Math.sin(a) * r), size, angle: rand(0, TAU), branches });
  }
  return cracks;
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
  // Number of times this bassteroid has already been split. 0 = gen-0 large,
  // 1 = gen-1 medium (terminal — its final hit destroys it outright).
  // Always 0 for non-bass kinds.
  splitLevel = 0;
  // Game-time (seconds) at which this bassteroid should fire its next
  // beat. Set by Game when the asteroid is spawned / split. Unused for
  // non-bass kinds.
  nextBeatAt = 0;
  // Hitpoints. Every asteroid uses the HP/crack system now. Non-killing
  // bullet hits decrement `hp` and reveal one more entry in `cracks`; the
  // killing hit (hp → 0) explodes the asteroid (and splits it, for non-
  // terminal sizes). Bassteroids carry a 4× multiplier on top of the size
  // table — see `ASTEROID_HP` / `BASS_HP`.
  hp = 0;
  maxHp = 0;
  cracks: AsteroidCrack[] = [];
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
    const isBass = kind === "bassA" || kind === "bassB" || kind === "bassC" || kind === "bassD";
    if (isBass) {
      this.measureOffset = BASS_KIND_BASE_OFFSET[kind];
      this.bassShip = buildBassteroidShape(kind);
      // Bassteroids orient by intent (engines/cockpit point a way) so a
      // wildly spinning silhouette would muddy the modular read. Keep them
      // drifting slowly.
      this.rotSpeed = rand(-0.18, 0.18);
    }
    this.maxHp = isBass ? BASS_HP[size] : ASTEROID_HP[size];
    this.hp = this.maxHp;
    this.cracks = rollCracks(this.maxHp);
    const kindHue = KIND_HUE[kind];
    this.hue = hue ?? (kindHue !== undefined ? kindHue : nextWaveHue());
    this.harmonics = this.buildHarmonicsForKind(kind);
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

  // Each non-bass kind gets a subtly distinct silhouette via its harmonic
  // mix. "normal" stays the classic lumpy default; chime/bell/warble/tink
  // each lean on different frequencies so they read as different shapes
  // even before colour cues land.
  buildHarmonicsForKind(kind: AsteroidKind): Harmonic[] {
    const out: Harmonic[] = [];
    // Per-kind frequency list and amplitude scale. Bass kinds keep the
    // default since their actual silhouette is the modular ship sprite.
    let freqs: number[];
    let ampScale = 1;
    if (kind === "chime") {
      // Sharp crystalline shards: high frequencies, low amplitude.
      freqs = [5, 7, 9, 11];
      ampScale = 0.7;
    } else if (kind === "bell") {
      // Smooth rounded bell-curve body: dominant low harmonic, gentle.
      freqs = [2, 4, 6];
      ampScale = 0.55;
    } else if (kind === "warble") {
      // Wobbly elongated lobes: strong 3-fold + odd higher mode.
      freqs = [3, 5, 8];
      ampScale = 1.4;
    } else if (kind === "tink") {
      // Tiny faceted gem: very angular, many high frequencies.
      freqs = [4, 6, 9, 13];
      ampScale = 0.85;
    } else {
      // Default — classic asteroid lumpiness.
      freqs = [2, 3, 5, 7];
    }
    for (const freq of freqs) {
      out.push({
        amp: (rand(0.05, 0.18) / Math.sqrt(freq)) * ampScale,
        freq,
        phase: rand(0, TAU),
      });
    }
    return out;
  }

  buildSprite(): HTMLCanvasElement {
    if (this.isBass()) return this.buildBassteroidSprite();
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
    // Normal asteroids are essentially monochrome rock — drop saturation
    // hard so the special kinds (chime/bell/warble/tink/bass) are the only
    // things drawing the eye with colour.
    const isPlain = this.kind === "normal";
    const sHi = isPlain ? 8 : 100;
    const sMid = isPlain ? 6 : 80;
    const sLo = isPlain ? 5 : 70;
    const sFaint = isPlain ? 4 : 60;

    const halo = ctx.createRadialGradient(0, 0, this.radius * 0.7, 0, 0, haloRadius);
    halo.addColorStop(0, `hsla(${baseHue}, ${sHi}%, 60%, 0.12)`);
    halo.addColorStop(0.5, `hsla(${baseHue + 10}, ${sHi}%, 55%, 0.048)`);
    halo.addColorStop(1, `hsla(${baseHue}, ${sHi}%, 60%, 0)`);
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
    interior.addColorStop(0, `hsla(${baseHue}, ${sMid}%, 30%, 0.35)`);
    interior.addColorStop(0.7, `hsla(${baseHue - 10}, ${sLo}%, 18%, 0.25)`);
    interior.addColorStop(1, `hsla(${baseHue}, ${sFaint}%, 10%, 0.05)`);
    ctx.fillStyle = interior;
    ctx.fill();

    ctx.lineWidth = 1.3;
    ctx.strokeStyle = `hsla(${baseHue + 10}, ${sHi}%, 75%, 0.7)`;
    ctx.shadowColor = `hsla(${baseHue}, ${sHi}%, 65%, 1)`;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.clip();
    const filamentCount = this.size === "large" ? 6 : this.size === "medium" ? 4 : 3;
    ctx.strokeStyle = `hsla(${baseHue + 5}, ${isPlain ? 6 : 90}%, 70%, 0.18)`;
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
      grad.addColorStop(0, `hsla(${baseHue + 15}, ${sHi}%, 90%, ${0.9 * bakedNucleusPulse})`);
      grad.addColorStop(0.4, `hsla(${baseHue}, ${sHi}%, 65%, ${0.45 * bakedNucleusPulse})`);
      grad.addColorStop(1, `hsla(${baseHue}, ${sHi}%, 60%, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(nx, ny, nucleusRadius, 0, TAU);
      ctx.fill();
    }

    return canvas;
  }

  // Pre-rendered modular bassteroid body. Hard-edged panels with bright
  // outlines, a tight halo, engine glow, and "running lights" give each kind
  // a memorable silhouette distinct from the organic shapes everything else
  // uses. Cracks and the beat-flash are drawn live in `render()` because
  // they animate per frame.
  buildBassteroidSprite(): HTMLCanvasElement {
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
    // Bassteroids are modular silhouettes, not organic blobs — use a tight
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

  // Apply `amount` damage to this asteroid. Decrements HP and returns
  // whether it's now dead. Non-killing hits reveal one or more cracks (the
  // number revealed scales with the damage dealt so a 4-damage rhythm hit
  // visibly cracks the asteroid harder than a 1-damage plain hit, even if
  // it didn't kill). Caller is responsible for sound, particles, and split.
  applyDamage(amount: number = 1): { killed: boolean } {
    this.hp = Math.max(0, this.hp - amount);
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
    // Bassteroid: each split subdivides the parent's beat slot. Gen-0 (large)
    // → 2 gen-1 (medium) half a measure apart, gen-1 → 2 gen-2 (small) a
    // quarter measure apart, gen-2 is terminal. Children keep the parent's
    // kind (and therefore the parent's voice) so the four percussive timbres
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

    const isPlain = this.kind === "normal";
    const nSat = isPlain ? 6 : 100;
    const nucleusList = this.nuclei;
    for (const n of nucleusList) {
      const driftR = n.dist + Math.sin(time * n.pulseSpeed + n.pulsePhase) * 2;
      const nx = Math.cos(n.angle) * driftR;
      const ny = Math.sin(n.angle) * driftR;
      const pulse = 0.6 + 0.4 * Math.sin(time * n.pulseSpeed * 2 + n.pulsePhase);
      ctx.fillStyle = `hsla(${baseHue + 30}, ${nSat}%, 96%, ${pulse})`;
      ctx.beginPath();
      ctx.arc(nx, ny, n.size * 0.9, 0, TAU);
      ctx.fill();
    }

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, ${nSat}%, 95%, ${this.flashAmount * 0.25})`;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 1.1, 0, TAU);
      ctx.fill();
    }

    this.renderCracks(ctx);

    ctx.restore();
  }

  // Trace this asteroid's silhouette into the current path, in local space
  // (assumes caller has already translated to pos and rotated by rotation),
  // scaled by `scale` relative to radius=1. For bassteroids the path is the
  // union of all module polygons (each module is a subpath); for organic
  // asteroids it's the lumpy Fourier outline. Use this to draw silhouette-
  // shaped pulses, halos, or hit flashes instead of a generic circle.
  tracePath(ctx: CanvasRenderingContext2D, scale: number) {
    ctx.beginPath();
    if (this.isBass() && this.bassShip) {
      for (const module of this.bassShip.modules) {
        for (let i = 0; i < module.vertices.length; i++) {
          const x = module.vertices[i].x * this.radius * scale;
          const y = module.vertices[i].y * this.radius * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      return;
    }
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i] * scale;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // Generic crack overlay used by both organic asteroids and bassteroids.
  // Draws one crack per HP lost (jagged fracture-lines radiating from the
  // impact point) as a dark inner stroke plus a thin bright over-stroke
  // (heat/strain glow). Caller must have already translated to the
  // asteroid's centre and rotated into its frame.
  renderCracks(ctx: CanvasRenderingContext2D) {
    const cracksToDraw = Math.min(this.maxHp - this.hp, this.cracks.length);
    if (cracksToDraw <= 0) return;
    for (let i = 0; i < cracksToDraw; i++) {
      const crack = this.cracks[i];
      const dx = crack.pos.x * this.radius;
      const dy = crack.pos.y * this.radius;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(crack.angle);

      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(6,2,1,0.95)";
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const branch of crack.branches) {
        ctx.beginPath();
        for (let p = 0; p < branch.points.length; p++) {
          const px = branch.points[p].x * this.radius;
          const py = branch.points[p].y * this.radius;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(20, 100%, 70%, 0.55)`;
      ctx.lineWidth = 0.8;
      ctx.shadowColor = `hsla(15, 100%, 55%, 1)`;
      ctx.shadowBlur = 5;
      for (const branch of crack.branches) {
        ctx.beginPath();
        for (let p = 0; p < branch.points.length; p++) {
          const px = branch.points[p].x * this.radius;
          const py = branch.points[p].y * this.radius;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }

  // Render path for bassteroids: pre-baked modular sprite + live cracks
  // (one per HP lost) + a big bright beat flare on the beat. The beat flare
  // gates the visual rhythm — when all four kinds are active it reads as a
  // syncopated lighthouse sweep across the screen.
  renderBass(ctx: CanvasRenderingContext2D) {
    const baseHue = this.hue;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // Beat-time bloom drawn as scaled copies of the bassteroid silhouette
    // rather than a generic circle, so the pulse reads as "the shape getting
    // bigger" instead of an unrelated disc. Two concentric scaled outlines
    // (outer = soft glow, inner = bright rim) sell the shockwave.
    if (this.beatFlash > 0) {
      const a = this.beatFlash;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const outerScale = 1.7 + 0.6 * a;
      ctx.fillStyle = `hsla(${baseHue + 25}, 100%, 70%, ${0.22 * a})`;
      ctx.shadowColor = `hsla(${baseHue + 15}, 100%, 75%, 1)`;
      ctx.shadowBlur = 28 + 16 * a;
      this.tracePath(ctx, outerScale);
      ctx.fill();
      ctx.shadowBlur = 0;

      const innerScale = 1.25 + 0.18 * a;
      ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 90%, ${0.95 * a})`;
      ctx.lineWidth = 2.4 + 2.6 * a;
      ctx.shadowColor = `hsla(${baseHue + 20}, 100%, 85%, 1)`;
      ctx.shadowBlur = 18 + 12 * a;
      this.tracePath(ctx, innerScale);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // A small scale-up on the beat (cosmetic only — collisions still use
    // this.radius). Capped low enough that the bassteroid doesn't appear to
    // grow into the player's path during a rhythm window.
    const beatScale = 1 + 0.06 * this.beatFlash;
    ctx.scale(beatScale, beatScale);
    ctx.globalCompositeOperation = "lighter";

    if (this.sprite) {
      ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);
    }

    this.renderCracks(ctx);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 95%, ${this.flashAmount * 0.32})`;
      this.tracePath(ctx, 1.05);
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
