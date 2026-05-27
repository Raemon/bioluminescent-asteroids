import { Vec, v, add, mul, fromAngle, wrap, rand, TAU } from "./vec";
import { Trail } from "./Trail";
import { SoundwaveRadiator } from "./SoundwaveRadiator";

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
export type AsteroidKind = "normal" | "bassA" | "bassB" | "bassC" | "bassD" | "chime" | "bell" | "warble" | "tink" | "boss";

export const BASS_KINDS: ReadonlyArray<"bassA" | "bassB" | "bassC" | "bassD"> = ["bassA", "bassB", "bassC", "bassD"];

const SIZE_RADIUS: Record<AsteroidSize, number> = {
  large: 50,
  medium: 28,
  small: 16,
};

// The boss asteroid is the first end-of-arc fight: a cratered planetoid that
// solidifies out of the looming background planet on wave 10. It's roughly
// 3× the diameter of a large asteroid, splits into 3 medium children, and
// each medium splits into 3 smalls (smalls don't split). HP per tier is
// generous so a rhythm-locked player still needs a sustained engagement.
export const BOSS_RADIUS: Record<AsteroidSize, number> = {
  large: 160,
  medium: 70,
  small: 36,
};
export const BOSS_HP: Record<AsteroidSize, number> = {
  large: 60,
  medium: 18,
  small: 6,
};
// Boss hue. Matches the menace-rim red used by the foreshadowing planet so
// the "the planetoid just dropped in" read is unbroken. Children inherit.
export const BOSS_HUE = 12;

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

// Partition a parent's modules into `count` spatially-coherent chunks so a
// split child can render as "a piece of the original ship" rather than a
// scaled-down copy of the whole thing. We pick a random axis through the
// parent's centroid, sort modules by their centroid's projection onto that
// axis, and slice the sorted list into `count` contiguous groups. Lights are
// then assigned to whichever group's centroid is nearest.
//
// Each output BassShip's vertices are re-expressed in child-radius units:
// chunks are translated so the group centroid sits at local origin, and
// scaled so the chunk's bounding radius ~= 1 (i.e. the existing renderer's
// `vertex * this.radius` pipeline lands it at the child's tier radius).
const moduleCentroid = (m: BassModule): Vec => {
  let sx = 0;
  let sy = 0;
  for (const p of m.vertices) {
    sx += p.x;
    sy += p.y;
  }
  return v(sx / m.vertices.length, sy / m.vertices.length);
};

const partitionBassShip = (ship: BassShip, count: number): BassShip[] => {
  if (count <= 1) return [ship];
  const axisAngle = rand(0, TAU);
  const ax = Math.cos(axisAngle);
  const ay = Math.sin(axisAngle);
  const annotated = ship.modules.map(m => {
    const c = moduleCentroid(m);
    return { module: m, centroid: c, proj: c.x * ax + c.y * ay };
  });
  annotated.sort((a, b) => a.proj - b.proj);
  // Slice into `count` contiguous groups (last group absorbs the remainder).
  const groups: typeof annotated[] = [];
  const base = Math.floor(annotated.length / count);
  const extra = annotated.length - base * count;
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const take = base + (i < extra ? 1 : 0);
    groups.push(annotated.slice(cursor, cursor + take));
    cursor += take;
  }
  // Build a child BassShip per group. Centre vertices around the group's
  // centroid, then rescale so the chunk's max vertex radius is 1 — that way
  // when the renderer multiplies by the child's tier radius, the visible
  // chunk fills the child's footprint cleanly.
  return groups.map(group => {
    if (group.length === 0) return { modules: [], lights: [] };
    let gx = 0;
    let gy = 0;
    for (const entry of group) {
      gx += entry.centroid.x;
      gy += entry.centroid.y;
    }
    gx /= group.length;
    gy /= group.length;
    let maxR = 0;
    for (const entry of group) {
      for (const p of entry.module.vertices) {
        const r = Math.hypot(p.x - gx, p.y - gy);
        if (r > maxR) maxR = r;
      }
    }
    const scale = maxR > 0 ? 1 / maxR : 1;
    const modules = group.map(entry => ({
      vertices: entry.module.vertices.map(p => v((p.x - gx) * scale, (p.y - gy) * scale)),
    }));
    // Assign each light to the nearest group by centroid distance, then
    // recentre/rescale to match.
    const lights: BassLight[] = [];
    for (const light of ship.lights) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < groups.length; i++) {
        if (groups[i].length === 0) continue;
        let cx = 0;
        let cy = 0;
        for (const entry of groups[i]) {
          cx += entry.centroid.x;
          cy += entry.centroid.y;
        }
        cx /= groups[i].length;
        cy /= groups[i].length;
        const d = Math.hypot(light.pos.x - cx, light.pos.y - cy);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (groups[bestIdx] === group) {
        lights.push({
          pos: v((light.pos.x - gx) * scale, (light.pos.y - gy) * scale),
          size: light.size * scale,
        });
      }
    }
    return { modules, lights };
  });
};

// Build a simplified closed silhouette from a BassShip — the outer hull of
// all module vertices, resampled at fixed angular intervals around the
// centroid. Used by SoundwaveRadiator: a wave that wears the actual chunk's
// silhouette reads as "the broken piece is singing" rather than a generic
// ring. Returned in radius-units (caller scales by this.radius).
//
// Algorithm:
//   1. Gather every module vertex.
//   2. For each of N angular bins around (0,0), keep the farthest vertex
//      whose angle falls in that bin. This is a polar-max sweep — cheaper
//      than a true convex hull, and gives a slightly puffier outline that
//      reads as "the body" rather than "the exact edge of the body".
//   3. Bins with no contributors fall back to interpolation between their
//      filled neighbours so the curve is C0-continuous.
// Result: a 28-sample closed polygon, each sample = (angle, radius_norm).
// The renderer reconstructs xy by (cos a * r, sin a * r) * scaleRadius.
export type SilhouetteSample = { ax: number; ay: number; r: number };
export const buildBassSilhouette = (ship: BassShip, samples = 28): SilhouetteSample[] => {
  const bins: number[] = new Array(samples).fill(0);
  for (const m of ship.modules) {
    for (const p of m.vertices) {
      const r = Math.hypot(p.x, p.y);
      if (r <= 0) continue;
      let a = Math.atan2(p.y, p.x);
      if (a < 0) a += TAU;
      const idx = Math.min(samples - 1, Math.floor((a / TAU) * samples));
      if (r > bins[idx]) bins[idx] = r;
    }
  }
  // Fill any empty bins by linear interpolation from the nearest filled
  // neighbours on either side. If everything is empty (defensive), fall
  // back to a unit circle so the radiator still draws something.
  let anyFilled = false;
  for (const b of bins) if (b > 0) { anyFilled = true; break; }
  if (!anyFilled) {
    for (let i = 0; i < samples; i++) bins[i] = 1;
  } else {
    for (let i = 0; i < samples; i++) {
      if (bins[i] > 0) continue;
      let left = -1, right = -1;
      for (let k = 1; k <= samples; k++) {
        const li = (i - k + samples) % samples;
        if (bins[li] > 0) { left = li; break; }
      }
      for (let k = 1; k <= samples; k++) {
        const ri = (i + k) % samples;
        if (bins[ri] > 0) { right = ri; break; }
      }
      if (left === right) { bins[i] = bins[left]; continue; }
      // Shortest signed distance from left → i and i → right (going around).
      const dL = (i - left + samples) % samples;
      const dR = (right - i + samples) % samples;
      const t = dL / (dL + dR);
      bins[i] = bins[left] * (1 - t) + bins[right] * t;
    }
  }
  // Light low-pass: average each bin with its neighbours so the outline
  // breathes smoothly instead of stepping per-bin (which would read as
  // a polygon, not a soundwave).
  const smoothed: number[] = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const prev = bins[(i - 1 + samples) % samples];
    const next = bins[(i + 1) % samples];
    smoothed[i] = (prev + bins[i] * 2 + next) * 0.25;
  }
  const out: SilhouetteSample[] = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * TAU;
    out[i] = { ax: Math.cos(a), ay: Math.sin(a), r: smoothed[i] };
  }
  return out;
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
  // Bioluminescent glow trail, only allocated for bassteroids (the only
  // long-lasting drone source among asteroid kinds). One pre-baked sprite
  // stamp per ring-buffer sample under additive blend — no shadowBlur, no
  // per-frame allocation. See Trail.ts.
  trail: Trail | null = null;
  // Radiating-soundwave visualiser. Replaces `trail` once a bassteroid has
  // been broken into mediums/smalls — at which point its drone fades in and
  // the piece should "sing" outward rather than leave a wake. Anchored
  // origin per wave; see SoundwaveRadiator.ts.
  radiator: SoundwaveRadiator | null = null;

  constructor(pos: Vec, vel: Vec, size: AsteroidSize, hue?: number, kind: AsteroidKind = "normal", inheritBass?: BassShip) {
    this.pos = pos;
    this.vel = vel;
    this.size = size;
    this.radius = SIZE_RADIUS[size];
    this.rotation = rand(0, TAU);
    this.rotSpeed = rand(-0.6, 0.6);
    this.kind = kind;
    const isBass = kind === "bassA" || kind === "bassB" || kind === "bassC" || kind === "bassD";
    const isBoss = kind === "boss";
    if (isBass) {
      this.measureOffset = BASS_KIND_BASE_OFFSET[kind];
      // Split children inherit a chunk of the parent's modules so they look
      // like a literal piece of the original ship rather than a scaled-down
      // copy of the whole silhouette. Gen-0 spawns use the full hand-built
      // ship.
      this.bassShip = inheritBass ?? buildBassteroidShape(kind);
      // Bassteroids orient by intent (engines/cockpit point a way) so a
      // wildly spinning silhouette would muddy the modular read. Keep them
      // drifting slowly.
      this.rotSpeed = rand(-0.18, 0.18);
    }
    if (isBoss) {
      // Boss is huge — override the size table so its physical footprint
      // matches its visual identity as a planetoid that just dropped in.
      this.radius = BOSS_RADIUS[size];
      // Slow majestic spin. Even the small bosses keep a heavier rotation
      // than ordinary asteroids — these are chunks of broken planet, not
      // pebbles.
      this.rotSpeed = rand(-0.12, 0.12) * (size === "large" ? 0.5 : 1);
    }
    this.maxHp = isBoss ? BOSS_HP[size] : isBass ? BASS_HP[size] : ASTEROID_HP[size];
    this.hp = this.maxHp;
    // For most asteroids each HP gets its own pre-rolled crack so the
    // damage state escalates predictably. The boss has a much higher HP
    // budget (60 large) — drawing 60 multi-branch overlays every frame is
    // wasteful and looks like noise, so cap the boss at a handful of
    // distinct fractures and let `renderBossCracks` interpolate brightness
    // with the damage fraction instead.
    const crackCount = isBoss ? (size === "large" ? 12 : size === "medium" ? 8 : 5) : this.maxHp;
    this.cracks = rollCracks(crackCount);
    const kindHue = KIND_HUE[kind];
    this.hue = hue ?? (isBoss ? BOSS_HUE : kindHue !== undefined ? kindHue : nextWaveHue());
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
    // Bassteroid wake. Gen-0 (large) wears no drone yet — it gets the slow
    // glow Trail as a "pristine charged thing drifting in space" wake.
    // Mediums/smalls (only spawned via split) have an active drone voice,
    // so they instead wear a SoundwaveRadiator that radiates the drone
    // outward from their position. Trail hue / radiator hue both match the
    // bassteroid's own hue (set above from KIND_HUE).
    if (isBass) {
      if (size === "large") {
        const bassRateByKind: Record<string, number> = {
          bassA: 0.65,
          bassB: 0.85,
          bassC: 0.75,
          bassD: 1.05,
        };
        const rate = bassRateByKind[kind] ?? 0.8;
        // Trail radius scales with asteroid radius; alpha kept modest so a
        // field of four overlapping drones doesn't wash the screen out.
        this.trail = new Trail(this.hue, this.radius * 0.65, 0.28, "bass", rate);
      } else {
        // Fragmented: drone is fading in. Build a simplified silhouette
        // from this child's inherited ship chunk so the radiating waves
        // wear the actual broken-piece outline rather than a generic ring.
        const silhouette = buildBassSilhouette(this.bassShip!);
        const isHighOctave = size === "small";
        this.radiator = new SoundwaveRadiator(
          kind as "bassA" | "bassB" | "bassC" | "bassD",
          this.hue,
          silhouette,
          isHighOctave,
        );
      }
    }
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
    if (this.isBoss()) return this.buildBossSprite();
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
    if (distance > this.radius * 1.3 + pointRadius) return false;
    // Bassteroids are modular silhouettes, not organic blobs — use a tight
    // circle for the hitbox. 0.88 is a feel-tuned shrink so glancing shots
    // miss the gaps between modules instead of registering on empty space.
    if (this.isBass()) return distance < this.radius * 0.88 + pointRadius;
    // Boss planetoid is a round body — circle hitbox at near-full radius.
    if (this.isBoss()) return distance < this.radius * 0.95 + pointRadius;
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

  // Why: a non-killing hit should visibly shove the target — fraction of "kill-worth"
  // damage maps to a fraction of a reference speed bump along the impact direction.
  // Heavier targets (high maxHp) get pushed proportionally less for the same damage.
  applyKnockback(dirX: number, dirY: number, amount: number, referenceSpeed: number = 120) {
    const len = Math.hypot(dirX, dirY);
    if (len === 0) return;
    const fraction = Math.min(1, amount / Math.max(1, this.maxHp));
    const dv = fraction * referenceSpeed;
    this.vel.x += (dirX / len) * dv;
    this.vel.y += (dirY / len) * dv;
  }

  update(dt: number, w: number, h: number) {
    this.rotation += this.rotSpeed * dt;
    this.membranePhase += dt * 0.8;
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
    // Stamp/age the drone trail (bassteroids only). Done after the wrap so
    // a screen-wrap teleport is caught by Trail's own jump detector and the
    // trail restarts cleanly on the new side.
    if (this.trail) this.trail.update(dt, this.pos.x, this.pos.y);
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
    // Beat flare decays a touch slower than the hit flash so the visible
    // pulse rides the audio kick all the way through the beat window.
    if (this.beatFlash > 0) this.beatFlash = Math.max(0, this.beatFlash - dt * 2.6);
    // Nucleus orbital drift is baked into the sprite so we no longer rotate
    // it here — the per-frame pulse highlight handles the only visible motion.
  }

  scoreValue(): number {
    if (this.isBoss()) {
      // Boss scoring rewards the sustained engagement: large piece dwarfs a
      // normal kill, mediums and smalls are still chunky. Combo multiplier
      // applies on top at the call site.
      if (this.size === "large") return 2500;
      if (this.size === "medium") return 800;
      return 300;
    }
    return SIZE_SCORE[this.size];
  }

  isBass(): boolean {
    return this.kind === "bassA" || this.kind === "bassB" || this.kind === "bassC" || this.kind === "bassD";
  }

  isBoss(): boolean {
    return this.kind === "boss";
  }

  // `impactDir` is the bullet's velocity direction at the moment of the kill.
  // When provided, fragments fan out into the forward hemisphere relative to
  // that direction — i.e., mostly away from where the bullet came from. The
  // two pieces split off to either side of the bullet's path (like a wedge
  // cleaving the rock) with a small forward bias, which reads as physically
  // resonant: the kinetic momentum of the impactor pushes the debris through.
  // Falls back to the parent's velocity direction when no impactDir is given
  // (e.g. shockwave splits).
  split(impactDir?: Vec): Asteroid[] {
    // Boss: large → 3 medium, medium → 3 small, small → terminal. Children
    // fan outward from the parent's velocity in evenly-spaced cones so the
    // post-split field reads as a clean shatter rather than a dust cloud.
    if (this.isBoss()) {
      if (this.size === "small") return [];
      const nextSize: AsteroidSize = this.size === "large" ? "medium" : "small";
      // Boss is huge and ponderous, so the bullet's direction dominates the
      // shatter axis when available; otherwise fall back to parent velocity.
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      // Eject from a position offset out toward each child's direction so
      // mediums/smalls don't all start stacked on top of each other (which
      // would let one shot near the centre clip several at once before they
      // separated). Offset distance is half the parent radius.
      const ejectDist = this.radius * 0.5;
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 3; i++) {
        // Spread of ±1.2 rad with a small per-child jitter so the three
        // children aren't perfectly symmetrical.
        const childAngle = baseAngle + (i - 1) * 1.2 + rand(-0.15, 0.15);
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * ejectDist,
          y: this.pos.y + Math.sin(childAngle) * ejectDist,
        };
        const speedMag = Math.hypot(this.vel.x, this.vel.y) * rand(0.9, 1.4) + 60;
        const child = new Asteroid(childPos, fromAngle(childAngle, speedMag), nextSize, this.hue, this.kind);
        fragmentList.push(child);
      }
      return fragmentList;
    }
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
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      // Carve the parent's silhouette into 2 spatially-coherent chunks so
      // each child wears a recognisable piece of the original. Gen-1 mediums
      // split a gen-0 hand-built ship; gen-2 smalls split the gen-1 chunk
      // again — the fragmentation compounds naturally.
      const chunks = partitionBassShip(this.bassShip!, 2);
      for (let i = 0; i < 2; i++) {
        // Fan ±~0.9 rad off the bullet's heading (one to each side), forward
        // of the impact point — within ~±π/2, so both pieces head away from
        // where the bullet came from.
        const sideOffset = (i === 0 ? -1 : 1) * (0.9 + rand(-0.2, 0.2));
        const a = baseAngle + sideOffset + rand(-0.2, 0.2);
        const speedMag = splitChildSpeed(this.vel, childSize);
        const child = new Asteroid({ ...this.pos }, fromAngle(a, speedMag), childSize, this.hue, this.kind, chunks[i]);
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
    const baseAngle = impactDir
      ? Math.atan2(impactDir.y, impactDir.x)
      : Math.atan2(this.vel.y, this.vel.x);
    for (let i = 0; i < fragmentCount; i++) {
      // Two pieces flank the bullet's path, forward of the impact. Each
      // child's heading is bullet-direction ±~0.9 rad with jitter, so the
      // debris fans away from where the bullet came from rather than
      // streaming back through it.
      const sideOffset = (i === 0 ? -1 : 1) * (0.9 + rand(-0.2, 0.2));
      const a = baseAngle + sideOffset + rand(-0.25, 0.25);
      const speedMag = splitChildSpeed(this.vel, nextSize);
      fragmentList.push(new Asteroid({ ...this.pos }, fromAngle(a, speedMag), nextSize, this.hue, this.kind));
    }
    return fragmentList;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    if (this.isBoss()) {
      this.renderBoss(ctx, t);
      return;
    }
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
    ctx.save();
    this.tracePath(ctx, 1);
    ctx.clip();
    const crackScale = 0.7;
    for (let i = 0; i < cracksToDraw; i++) {
      const crack = this.cracks[i];
      const dx = crack.pos.x * this.radius;
      const dy = crack.pos.y * this.radius;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(crack.angle);
      ctx.scale(crackScale, crackScale);

      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(245,245,250,0.45)";
      ctx.lineWidth = 1.2;
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
      ctx.strokeStyle = `rgba(255,255,255,0.3)`;
      ctx.lineWidth = 0.5;
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
      ctx.restore();
    }
    ctx.restore();
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

  // Pre-rendered cratered planetoid sprite for the boss. Heavy dark body
  // with a strong red rim glow (matches the foreshadowing planet's menace
  // hue), pitted with craters, fractured by deep canyon lines, and lit from
  // the side by an off-screen sun so it reads as a 3D sphere rather than a
  // flat disc. Cracks and the live damage state are drawn per-frame in
  // renderBoss.
  buildBossSprite(): HTMLCanvasElement {
    const r = this.radius;
    const haloRadius = r * 1.55;
    const padding = 24;
    const size = Math.ceil(2 * (haloRadius + padding));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    this.spriteHalfSize = size / 2;
    const baseHue = this.hue;

    ctx.translate(size / 2, size / 2);

    // Wide outer corona — red/orange wash so the boss carries its menace
    // colour signature out into the surrounding space.
    ctx.globalCompositeOperation = "lighter";
    const corona = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, haloRadius);
    corona.addColorStop(0, `hsla(${baseHue}, 100%, 50%, 0.18)`);
    corona.addColorStop(0.55, `hsla(${baseHue - 8}, 100%, 45%, 0.08)`);
    corona.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, TAU);
    ctx.fill();

    // Body — dark molten rock with a directional gradient (the "sun" is up
    // and to the left). source-over so the body genuinely occludes the
    // corona behind it instead of glowing through it.
    ctx.globalCompositeOperation = "source-over";
    const body = ctx.createRadialGradient(-r * 0.4, -r * 0.4, r * 0.1, 0, 0, r);
    body.addColorStop(0, `hsl(${baseHue + 8}, 70%, 32%)`);
    body.addColorStop(0.45, `hsl(${baseHue + 4}, 75%, 18%)`);
    body.addColorStop(0.85, `hsl(${baseHue - 6}, 80%, 8%)`);
    body.addColorStop(1, `hsl(${baseHue - 10}, 80%, 4%)`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();

    // Craters — randomly placed dark pits with bright south-east rims (the
    // sun is up-left, so the lit side of each crater is opposite). Smaller
    // bosses get fewer craters proportionally so the silhouette stays
    // readable.
    const craterCount = this.size === "large" ? 14 : this.size === "medium" ? 8 : 5;
    for (let i = 0; i < craterCount; i++) {
      const a = rand(0, TAU);
      const d = rand(0, r * 0.78);
      const cx = Math.cos(a) * d;
      const cy = Math.sin(a) * d;
      const cr = rand(r * 0.06, r * 0.16);
      // Pit
      const pit = ctx.createRadialGradient(cx - cr * 0.2, cy - cr * 0.2, 0, cx, cy, cr);
      pit.addColorStop(0, `hsl(${baseHue - 6}, 75%, 4%)`);
      pit.addColorStop(0.7, `hsl(${baseHue}, 70%, 9%)`);
      pit.addColorStop(1, `hsl(${baseHue + 8}, 65%, 20%)`);
      ctx.fillStyle = pit;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, TAU);
      ctx.fill();
      // Sun-lit rim crescent on the lower-right of each crater. A thin
      // bright arc sells the depth without burying the body in noise.
      ctx.strokeStyle = `hsla(${baseHue + 25}, 90%, 65%, 0.8)`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx, cy, cr * 0.95, -0.4, 1.7);
      ctx.stroke();
    }

    // Glowing magma fault lines — bright canyons running across the body
    // suggesting the planetoid is unstable. Clipped to the disc.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = `hsla(${baseHue + 20}, 100%, 55%, 1)`;
    ctx.shadowBlur = 14;
    const faultCount = this.size === "large" ? 5 : this.size === "medium" ? 3 : 2;
    for (let i = 0; i < faultCount; i++) {
      const a = rand(0, TAU);
      const offset = rand(-r * 0.5, r * 0.5);
      ctx.strokeStyle = `hsla(${baseHue + 18 + i * 4}, 100%, 60%, 0.85)`;
      ctx.lineWidth = rand(1.2, 2.4);
      ctx.beginPath();
      let px = Math.cos(a) * -r * 1.2 + Math.cos(a + Math.PI / 2) * offset;
      let py = Math.sin(a) * -r * 1.2 + Math.sin(a + Math.PI / 2) * offset;
      ctx.moveTo(px, py);
      const segs = 6;
      for (let s = 1; s <= segs; s++) {
        const t = -1 + (s / segs) * 2;
        const jitter = (Math.random() - 0.5) * r * 0.08;
        px = Math.cos(a) * r * 1.2 * t + Math.cos(a + Math.PI / 2) * (offset + jitter);
        py = Math.sin(a) * r * 1.2 * t + Math.sin(a + Math.PI / 2) * (offset + jitter);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.restore();

    // Terminator — dark crescent on the lower-right where the body falls
    // into shadow. Sells the spherical lighting model harder than the body
    // gradient alone.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.clip();
    ctx.globalCompositeOperation = "source-over";
    const term = ctx.createRadialGradient(r * 0.5, r * 0.5, r * 0.2, r * 0.5, r * 0.5, r * 1.3);
    term.addColorStop(0, `hsla(0, 0%, 0%, 0)`);
    term.addColorStop(0.6, `hsla(0, 0%, 0%, 0.45)`);
    term.addColorStop(1, `hsla(0, 0%, 0%, 0.85)`);
    ctx.fillStyle = term;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Outline rim — thin bright ring so the boss reads cleanly against the
    // starfield even when the corona is washed out.
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${baseHue + 15}, 100%, 75%, 0.85)`;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = `hsla(${baseHue}, 100%, 60%, 1)`;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;

    return canvas;
  }

  // Per-frame boss draw. Sprite carries the body and craters; we paint live
  // damage cracks, hit flash, and a slow rotation on top. Damage cracks
  // escalate from hairlines to wide molten gashes as HP drops, so the
  // player gets clear feedback that they're chipping at this monster.
  renderBoss(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // Slow corona pulse driven by clock so the boss feels alive even when
    // nothing is happening. Drawn before the sprite so it sits behind.
    const breath = 0.5 + 0.5 * Math.sin(t * 0.0018);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const breathAlpha = 0.18 + 0.12 * breath + 0.35 * damageT;
    const breathR = this.radius * (1.35 + 0.05 * breath + 0.15 * damageT);
    const grad = ctx.createRadialGradient(0, 0, this.radius * 0.7, 0, 0, breathR);
    grad.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${breathAlpha * 0.4})`);
    grad.addColorStop(0.6, `hsla(${baseHue + 8}, 100%, 55%, ${breathAlpha})`);
    grad.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, breathR, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (this.sprite) {
      ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);
    }

    // Live damage cracks — same system as regular asteroids but with a
    // brighter, redder over-stroke so they read on the boss body. Number
    // shown scales with damage taken (one per HP lost, capped at crack
    // count).
    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 90%, ${this.flashAmount * 0.35})`;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 1.05, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  // Boss-specific crack overlay. We draw a dramatic radial-fracture pattern
  // proportional to damage taken — at low damage just a few hairline
  // fractures, at high damage the body is criss-crossed with glowing
  // molten gashes. Different look from the bassteroid renderCracks because
  // the boss is a planetoid, not an armoured ship.
  renderBossCracks(ctx: CanvasRenderingContext2D, damageT: number) {
    if (damageT <= 0.01) return;
    const cracksToDraw = Math.min(Math.ceil(damageT * this.cracks.length * 1.4), this.cracks.length);
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, TAU);
    ctx.clip();
    const crackScale = 0.7;
    for (let i = 0; i < cracksToDraw; i++) {
      const crack = this.cracks[i];
      const dx = crack.pos.x * this.radius;
      const dy = crack.pos.y * this.radius;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(crack.angle);
      ctx.scale(crackScale, crackScale);

      // Faint white fracture line (the crack itself).
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = `rgba(245,245,250, ${0.35 + 0.2 * damageT})`;
      ctx.lineWidth = 1.4 + damageT * 1.0;
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

      // Subtle bright over-stroke — still scales with damage so the boss
      // visibly stresses, but desaturated to white rather than molten orange.
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `rgba(255,255,255, ${0.25 + 0.3 * damageT})`;
      ctx.lineWidth = 0.6 + damageT * 0.8;
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
      ctx.restore();
    }
    ctx.restore();
  }
}

// Drop the boss directly at the screen position the looming planetoid was
// occupying, with a slow drift toward the screen centre. We don't aim at
// the ship — the boss is a planetoid, not a hunter — and we pick a gentle
// speed so the player has time to react to the new threat.
export const spawnBossAt = (
  pos: Vec,
  w: number,
  h: number,
): Asteroid => {
  const cx = w / 2;
  const cy = h / 2;
  const dx = cx - pos.x;
  const dy = cy - pos.y;
  const norm = Math.max(1, Math.hypot(dx, dy));
  const speed = 24;
  const vel = v((dx / norm) * speed, (dy / norm) * speed);
  return new Asteroid({ x: pos.x, y: pos.y }, vel, "large", undefined, "boss");
};

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
