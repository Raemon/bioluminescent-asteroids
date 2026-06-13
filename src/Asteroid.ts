import { Vec, v, fromAngle, rand, TAU, addScaledMut, wrapMut } from "./vec";
import { Trail } from "./Trail";
import { SoundwaveRadiator } from "./SoundwaveRadiator";
import { rng } from "./game/rng";
import { ENTITY_CONFIG } from "./game/entityConfig";
import { drawGlow } from "./glow";

const HUE_PALETTE = [185, 200, 220, 250, 280, 310, 330];

// Lazy-init so the first cursor pick comes from the seeded RNG (after startGame
// calls seedRng) rather than module-load Math.random — replays would diverge.
let huePaletteCursor = -1;
export const nextWaveHue = (): number => {
  if (huePaletteCursor < 0) huePaletteCursor = Math.floor(rng() * HUE_PALETTE.length);
  huePaletteCursor = (huePaletteCursor + 1 + Math.floor(rng() * (HUE_PALETTE.length - 1))) % HUE_PALETTE.length;
  return HUE_PALETTE[huePaletteCursor];
};

export const resetHuePaletteCursor = (): void => { huePaletteCursor = -1; };

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
// "goldCrystal" looks like a normal large asteroid except a faintly visible
// gold crystal is embedded inside it (blurred, low-contrast — the player has
// to *notice* it). Killing it drops a collectible GoldCrystal where the rock
// was, plus an off-balanced fragment recipe (3 small OR 1 small + 1 medium).
// Always spawned at large size; doesn't survive past a single kill.
//
// "solidCrystal" is a tough, fully-faceted ice-blue crystal asteroid — 16 HP
// (4× a normal large), no embedded gold tease, the whole rock IS the crystal.
// On death it drops 1–3 collectible GoldCrystals AND splits into 4 fast-moving
// "solidCrystalSmall" fragments (4 HP each, no further split).
//
// "solidCrystalSmall" also spawns standalone as a rare "treat" — a tough
// 4 HP shard that pays out solidCrystal.smallScore on the killing hit. Same
// sprite + shatter sound as a parent-spawned fragment, no further split.
// Boss fragment kinds (level 10 culmination). The "boss" kind is the
// whole-body planetoid; it splits into two `bossHemisphere` halves + one
// `bossEye` core. Hemispheres further split into `bossPlate` shards (the
// modular ring panels they wore); the eye further splits into
// `bossIrisShard` slivers + a single inert `bossEmber` pupil.
//
// "glassPrison" is the post-boss horror: an angular indigo glass shell with
// 16 HP that drifts in starting display-level 11. A tortured silhouette is
// frozen inside, eyes glowing faintly. The killing hit shatters the shell —
// the captive wraith escapes screaming.
//
// "wraith" is what crawls out. It has no baked sprite (drawn live every
// frame from drifting noise layers and writhing tendrils), pursues the ship
// in a slow slither, and occasionally lunges. Eats a few bullets to finish.
export type AsteroidKind = "normal" | "bassA" | "bassB" | "bassC" | "bassD" | "chime" | "bell" | "warble" | "boss" | "bossHemisphere" | "bossEye" | "bossPlate" | "bossIrisShard" | "bossEmber" | "goldCrystal" | "solidCrystal" | "solidCrystalSmall" | "glassPrison" | "wraith" | "cathedralKeystone" | "glassShard" | "columnDrum" | "rubbleBlock";

// The cathedral ("bell") asteroid rolls one of these archetypes at spawn. Each
// reads as a different fragment of a civilization's basilica carved out of the
// asteroid belt — its own silhouette harmonics + its own carved-into-rock
// interior painter, all sharing the weathered-stone frame. See
// `paintCathedralFragmentBody`, which dispatches on this.
export type CathedralArchetype = "lancetWall" | "roseFacade" | "spireTower" | "arcade" | "buttressRuin";
const CATHEDRAL_ARCHETYPES: ReadonlyArray<CathedralArchetype> = ["lancetWall", "roseFacade", "spireTower", "arcade", "buttressRuin"];
// Terminal small kinds a cathedral asteroid shatters into — carved debris that
// makes conceptual sense as broken building pieces (cf. how bassteroids break
// into recognisable ship chunks). None of these split further.
const CATHEDRAL_DEBRIS_KINDS: ReadonlyArray<AsteroidKind> = ["cathedralKeystone", "glassShard", "columnDrum", "rubbleBlock"];

export const BASS_KINDS: ReadonlyArray<"bassA" | "bassB" | "bassC" | "bassD"> = ["bassA", "bassB", "bassC", "bassD"];

const SIZE_RADIUS = ENTITY_CONFIG.asteroid.radius;

// The boss asteroid is the first end-of-arc fight: a cratered planetoid that
// solidifies out of the looming background planet on wave 10. It's roughly
// 3× the diameter of a large asteroid, splits into 3 medium children, and
// each medium splits into 3 smalls (smalls don't split).
export const BOSS_RADIUS = ENTITY_CONFIG.boss.radius;
export const BOSS_HP = ENTITY_CONFIG.boss.hp;
// Boss hue. Matches the menace-rim red used by the foreshadowing planet so
// the "the planetoid just dropped in" read is unbroken. Children inherit.
export const BOSS_HUE = ENTITY_CONFIG.boss.hue;

export const SIZE_SPAWN_SPEED = ENTITY_CONFIG.asteroid.spawnSpeed;

const splitChildSpeed = (parentVel: Vec, childSize: AsteroidSize): number => {
  const parentSpeed = Math.hypot(parentVel.x, parentVel.y);
  if (childSize === "medium") return parentSpeed * rand(1.2, 1.7) + 40;
  return parentSpeed * rand(1.15, 1.65) + 40;
};

const SIZE_SCORE = ENTITY_CONFIG.asteroid.score;

const KIND_HUE: Partial<Record<AsteroidKind, number>> = {
  bassA: 0,
  bassB: 28,
  bassC: 215,
  bassD: 290,
  chime: 52,
  bell: 285,
  warble: 130,
  solidCrystal: 232,
  solidCrystalSmall: 232,
  glassPrison: 258,
  wraith: 286,
  // Cathedral debris inherits the parent bell's hue at spawn, so these are
  // only fallbacks for the rare case one is constructed standalone.
  cathedralKeystone: 285,
  glassShard: 285,
  columnDrum: 285,
  rubbleBlock: 285,
};

// Solid crystal large asteroids render slightly bigger than a stock large so
// they read as a more dangerous, more robust target. Smalls keep stock size.
const SOLID_CRYSTAL_LARGE_RADIUS = ENTITY_CONFIG.solidCrystal.largeRadius;

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
export const ASTEROID_HP = ENTITY_CONFIG.asteroid.hp;

// Combo-halo gap: the halo outline floats this many pixels outside the hull,
// uniform along every edge and across every bassteroid size (a center-scale
// multiplier would push long hull extremities much further out than the
// flanks, and would scale the gap with the rock).
const BASS_HALO_GAP_PX = 8;

// Bassteroids carry the asteroid-HP table scaled by the bass multiplier so
// the rhythm system has real teeth — even a rhythm-bullet (4 damage) needs
// four hits to crack a large bassteroid, matching the "armoured" silhouette.
export const BASS_HP_MULTIPLIER = ENTITY_CONFIG.bassteroid.hpMultiplier;
export const BASS_HP: Record<AsteroidSize, number> = {
  large: ASTEROID_HP.large * BASS_HP_MULTIPLIER,
  medium: ASTEROID_HP.medium * BASS_HP_MULTIPLIER,
  small: ASTEROID_HP.small * BASS_HP_MULTIPLIER,
};

// Solid-crystal HP: large matches the bass-armouring budget in a single tier,
// small fragments are tougher than a normal small (1 HP) so the splinter
// cleanup still demands a few well-timed shots.
export const SOLID_CRYSTAL_HP_LARGE = ENTITY_CONFIG.solidCrystal.largeHp;
export const SOLID_CRYSTAL_HP_SMALL = ENTITY_CONFIG.solidCrystal.smallHp;
export const SOLID_CRYSTAL_DAMAGE_REDUCTION = ENTITY_CONFIG.solidCrystal.damageReduction;

// Glass prison — the shell that locks a wraith in stasis. Tougher than a
// solid crystal so even a rhythm-saturated player has to commit to breaking
// one open. On death the prison spawns a single wraith at its position.
export const GLASS_PRISON_HP = ENTITY_CONFIG.glassPrison.hp;
export const GLASS_PRISON_RADIUS = ENTITY_CONFIG.glassPrison.radius;
// Wraith — the freed captive. HP is low (it's a wisp, not armoured), but
// it pursues and writhes so it's hard to line up cleanly.
export const WRAITH_HP = ENTITY_CONFIG.wraith.hp;
export const WRAITH_RADIUS = ENTITY_CONFIG.wraith.radius;

// Cathedral debris (carved building chunks a "bell" shatters into). Tougher
// than a stock small so clearing the rubble still asks for a couple of clean
// shots — same intent as solidCrystalSmall — and terminal (no further split).
export const CATHEDRAL_DEBRIS_HP = 2;

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
    const forkCount = 3 + Math.floor(rng() * 2);
    const branches: { points: Vec[] }[] = [];
    for (let f = 0; f < forkCount; f++) {
      const baseAngle = (f / forkCount) * TAU + rand(-0.4, 0.4);
      const segments = 3 + Math.floor(rng() * 2);
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

// ── Combo-halo outline geometry ──────────────────────────────────────────
// The halo is the boundary of the *union* of a bassteroid's module polygons,
// each pushed outward by a constant pixel gap. Offsetting per-module and
// stroking them all (the old approach) drew the interior shared edges too,
// criss-crossing wherever modules overlapped. Here we offset each module
// (sharp mitered corners — a center-scale would drift, a disk Minkowski sum
// would round), then keep only the offset edges that lie outside every other
// inflated module, and chain the survivors into closed loops. Result: one
// outline hugging the true outer perimeter, sharp corners preserved.

type HPt = { x: number; y: number };

// Offset a CCW-or-CW polygon outward by gap, mitering each corner (intersect
// adjacent shifted edges). Returns vertices in the same winding as input.
const offsetPolygon = (pts: HPt[], gap: number): HPt[] => {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area > 0 ? 1 : -1; // outward-normal selector
  const dirs: HPt[] = [];
  const anchors: HPt[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    dirs.push(d);
    anchors.push({ x: a.x + sign * d.y * gap, y: a.y - sign * d.x * gap });
  }
  const out: HPt[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const cross = dirs[j].x * dirs[i].y - dirs[j].y * dirs[i].x;
    if (Math.abs(cross) < 1e-9) {
      out.push({ x: pts[i].x + sign * dirs[i].y * gap, y: pts[i].y - sign * dirs[i].x * gap });
      continue;
    }
    const dx = anchors[i].x - anchors[j].x;
    const dy = anchors[i].y - anchors[j].y;
    const t = (dx * dirs[i].y - dy * dirs[i].x) / cross;
    out.push({ x: anchors[j].x + dirs[j].x * t, y: anchors[j].y + dirs[j].y * t });
  }
  return out;
};

const pointInPolygon = (px: number, py: number, poly: HPt[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > py) !== (b.y > py)) {
      const x = a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (px < x) inside = !inside;
    }
  }
  return inside;
};

// Outline of the union of several offset polygons. Each edge of each polygon
// is cut at every crossing with edges of the *other* polygons, then a sub-edge
// is kept iff its midpoint lies outside all other polygons. Kept sub-edges are
// chained head-to-tail into closed loops. Winding is normalized so every input
// polygon contributes outward-consistent edges.
const unionOutline = (polys: HPt[][]): HPt[][] => {
  // Normalize all to CCW so "outside-all-others" is winding-consistent.
  const ccw = polys.map((p) => {
    let area = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area < 0 ? [...p].reverse() : p;
  });

  const EPS = 1e-7;
  const kept: { a: HPt; b: HPt }[] = [];
  for (let pi = 0; pi < ccw.length; pi++) {
    const poly = ccw[pi];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      // Collect split parameters (t along a→b) from intersections with every
      // edge of every other polygon.
      const ts = [0, 1];
      for (let qi = 0; qi < ccw.length; qi++) {
        if (qi === pi) continue;
        const other = ccw[qi];
        for (let k = 0; k < other.length; k++) {
          const c = other[k], d = other[(k + 1) % other.length];
          const r = { x: b.x - a.x, y: b.y - a.y };
          const s = { x: d.x - c.x, y: d.y - c.y };
          const denom = r.x * s.y - r.y * s.x;
          if (Math.abs(denom) < 1e-12) continue;
          const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
          const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
          if (t > EPS && t < 1 - EPS && u > -EPS && u < 1 + EPS) ts.push(t);
        }
      }
      ts.sort((m, n) => m - n);
      for (let s = 0; s < ts.length - 1; s++) {
        const t0 = ts[s], t1 = ts[s + 1];
        if (t1 - t0 < EPS) continue;
        const mt = (t0 + t1) / 2;
        const mx = a.x + (b.x - a.x) * mt;
        const my = a.y + (b.y - a.y) * mt;
        let buried = false;
        for (let qi = 0; qi < ccw.length; qi++) {
          if (qi === pi) continue;
          if (pointInPolygon(mx, my, ccw[qi])) { buried = true; break; }
        }
        if (buried) continue;
        kept.push({
          a: { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
          b: { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
        });
      }
    }
  }

  // Chain kept segments into closed loops by snapping endpoints to a grid.
  const key = (p: HPt) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  const adj = new Map<string, { seg: { a: HPt; b: HPt }; used: boolean }[]>();
  for (const seg of kept) {
    const ka = key(seg.a);
    if (!adj.has(ka)) adj.set(ka, []);
    adj.get(ka)!.push({ seg, used: false });
  }
  const loops: HPt[][] = [];
  const allEntries = [...adj.values()].flat();
  for (const start of allEntries) {
    if (start.used) continue;
    const loop: HPt[] = [];
    let cur: { seg: { a: HPt; b: HPt }; used: boolean } | undefined = start;
    let guard = 0;
    const startKey = key(start.seg.a);
    while (cur && !cur.used && guard++ < 10000) {
      cur.used = true;
      loop.push(cur.seg.a);
      const nextKey = key(cur.seg.b);
      if (nextKey === startKey) break;
      const candidates = adj.get(nextKey);
      cur = candidates?.find((c) => !c.used);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
};

// ── Halo-outline cache ───────────────────────────────────────────────────
// unionOutline is an O(edges²) clip + chain — cheap for one rock but a visible
// frame spike when several bassteroids ignite their combo halo on the same
// beat (e.g. the boss wave spawns one of every kind). The outline depends only
// on (module geometry, radius, gap), all fixed at construction, so we build it
// once per distinct shape and memoize. Gen-0 rocks of the same kind+size share
// an entry; split children (custom inherited geometry) get their own, built
// once on the split rather than every frame. prewarmHaloOutlines() fills every
// gen-0 combo at module load so nothing computes during gameplay.
const haloOutlineCache = new Map<string, { x: number; y: number }[][]>();

const haloCacheKey = (ship: BassShip, radius: number, gapPx: number): string => {
  // Round to 0.001 unit so float jitter in inherited geometry still hits the
  // same key; radius+gap fold in because the offset is in pixels (gap doesn't
  // scale with radius), so the same modules at a different tier differ.
  let s = `${radius.toFixed(2)}|${gapPx}|`;
  for (const m of ship.modules) {
    for (const vt of m.vertices) s += `${Math.round(vt.x * 1000)},${Math.round(vt.y * 1000)};`;
    s += "/";
  }
  return s;
};

const computeHaloOutline = (ship: BassShip, radius: number, gapPx: number): { x: number; y: number }[][] => {
  const offset = ship.modules
    .filter((m) => m.vertices.length >= 3)
    .map((m) =>
      offsetPolygon(m.vertices.map((vt) => ({ x: vt.x * radius, y: vt.y * radius })), gapPx),
    );
  if (offset.length === 0) return [];
  if (offset.length === 1) return offset;
  return unionOutline(offset);
};

const getHaloOutline = (ship: BassShip, radius: number, gapPx: number): { x: number; y: number }[][] => {
  const key = haloCacheKey(ship, radius, gapPx);
  let cached = haloOutlineCache.get(key);
  if (!cached) {
    cached = computeHaloOutline(ship, radius, gapPx);
    haloOutlineCache.set(key, cached);
  }
  return cached;
};

// Warm the cache for every gen-0 bassteroid at module load, so the union-clip
// never runs during a frame. Gen-0 rocks always spawn at "large" (split tiers
// carry custom inherited geometry and memoize on their first split, off the
// combo-ignition frame).
const prewarmHaloOutlines = () => {
  for (const kind of BASS_KINDS) {
    getHaloOutline(buildBassteroidShape(kind), SIZE_RADIUS.large, BASS_HALO_GAP_PX);
  }
};
prewarmHaloOutlines();

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
  // 0→1 progress through the current beat interval (0 just after a beat fires,
  // 1 the instant before the next). Updated each tick from beatTime in
  // bassClock; drives the halo shimmer and the pre-beat warm-up so the
  // anticipation animation can ramp without threading beatTime into render().
  beatPhase = 0;
  // Hitpoints. Every asteroid uses the HP/crack system now. Non-killing
  // bullet hits decrement `hp` and reveal one more entry in `cracks`; the
  // killing hit (hp → 0) explodes the asteroid (and splits it, for non-
  // terminal sizes). Bassteroids carry a 4× multiplier on top of the size
  // table — see `ASTEROID_HP` / `BASS_HP`.
  hp = 0;
  maxHp = 0;
  // Flat amount subtracted from every incoming hit before it touches HP. A hit
  // whose raw damage doesn't exceed this is fully absorbed — no HP lost, no
  // crack, the shot bounces off. Solid crystals set this; 0 for everything else.
  damageReduction = 0;
  cracks: AsteroidCrack[] = [];
  bassShip: BassShip | null = null;
  // Combo-halo outline: each module polygon offset outward by a fixed pixel
  // gap (mitered, so corners stay sharp). Hull + radius never change after
  // construction, so the offset polygons are built once and cached here.
  haloOutline: { x: number; y: number }[][] | null = null;
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
  // Number of gem collectibles this solid crystal will drop on death (0–3).
  // Decided at spawn so the same count can be pre-rendered as frosted gems
  // visible inside the crystal body. Unused for other kinds.
  embeddedGemCount = 0;
  // Local-space positions for the frosted gems inside a solidCrystal. Picked
  // at construction so they sit at the same spots in the pre-baked sprite
  // and the death payout.
  embeddedGemSpots: { x: number; y: number; r: number; tilt: number }[] = [];

  // Which cathedral archetype this "bell" asteroid wears (lancet wall, rose
  // facade, spire tower, arcade, buttress ruin). Rolled at construction; picks
  // both the silhouette harmonics and the interior painter. Unused off-kind.
  cathedralArchetype: CathedralArchetype = "lancetWall";

  // Level-10 boss reveal phase. "dormant" plays the 8s grow-and-rotate
  // foreshadow animation and is invulnerable. "live" is the normal damageable
  // engagement. Only meaningful when isBossFamily().
  bossPhase: "dormant" | "live" = "live";
  // Seconds elapsed since spawn while dormant; drives the swell + the rotate
  // -around reveal of the architecture. Reaches revealDuration → phase
  // transitions to "live" and the eye opens.
  bossRevealT = 0;
  // Eye-core target radius (set at construction for "boss" too so the
  // closed-eye lid seam is positioned consistently). For "bossEye" this is
  // the full body radius — the eye IS the asteroid.
  bossEyeRadius = 0;
  // Iris angle the eye is currently aiming. Lerps toward the player position
  // over a short window so quick player jukes are tracked but not perfectly.
  bossIrisAngle = 0;
  // Tracked aim point — locked at the start of the laser charge window so a
  // player who jukes during beats 7→8 actually dodges the bolt.
  bossEyeAimX = 0;
  bossEyeAimY = 0;
  // Per-fragment local-space orientation marker. For bossHemisphere this is
  // the angle of the cut diameter (so the straight edge faces a known
  // direction); for bossPlate it's the original modular hue band the plate
  // came from. Stored on the asteroid so the renderer doesn't need to derive
  // it from velocity (which drifts post-spawn).
  bossFragmentAngle = 0;
  // Color band index for bossPlate fragments — 0..3 picks one of the four
  // bassteroid hues that decorate the equatorial ring.
  bossPlateBand = 0;
  // For bossEmber: tiny inert pupil — no firing, just drifts. No state
  // beyond hue/radius is needed, this flag is implicit in kind.

  // ---- boss rhythm. Cycle = 16 beats × 0.5s = 8.0s; laser fires on beat 8 ----
  // Phase within the cycle (seconds 0..4). Driven by gameUpdate from
  // game.beatTime each tick. Used by the live boss and by post-break
  // fragments to fire their flash + plasma on the assigned slot.
  bossRhythmT = 0;
  // Per-section flash amplitudes — set to 1 on the assigned beat and decay.
  // Top hemisphere flashes on beat 1, bottom on beat 3, brass iris ring on
  // beat 5, pupil double-flash on beats 7 & 8 (the second triggers the bolt).
  bossTopFlash = 0;
  bossBottomFlash = 0;
  bossIrisFlash = 0;
  bossPupilFlash = 0;
  // Per-cycle latches. Each pulse fires exactly once per 8-beat cycle even
  // if dt overshoots the slot. Cleared when bossRhythmT wraps back to 0.
  bossDidTop = false;
  bossDidBottom = false;
  bossDidIris = false;
  bossDidPupil1 = false;
  bossDidPupil2 = false;
  // Flipped true after the first tickBossRhythm call so the very first
  // tick doesn't cascade every-prior-slot at once if the asteroid happens
  // to spawn mid-cycle.
  bossRhythmInit = false;
  // One-shot edge: true for exactly one tick after bossPhase transitions
  // dormant→live. gameUpdate reads it to play the wrong-note stinger and
  // zero the player's combo, then clears it.
  bossJustOpenedEye = false;
  // Laser charge ramp (0 → 1 across the windup). Renderer reads this to
  // crescendo the pupil core glow before the bolt leaves.
  bossLaserCharge = 0;
  // Latest ship position cached by trackPlayer each tick — so the per-beat
  // re-aim inside tickBossRhythm can snap the targeting line to the player
  // without tickBossRhythm needing its own ship handle.
  bossTrackedShipX = 0;
  bossTrackedShipY = 0;
  // Windup beat index the targeting aim last ticked on. The aim steps toward
  // the player once per beat across the windup (beats 4..7) so the player
  // reads a sightline visibly walking onto them, then locking for the fire.
  bossAimBeatIndex = -1;
  // Latch flipped true after the post-break top/bottom hemispheres fire
  // their plasma ball on this cycle, reset on cycle wrap. Lives on every
  // boss-family asteroid so each hemisphere keeps its own state.
  bossPlasmaFired = false;

  // Wraith-only state. The writhe phase drives the live-painted body's
  // breathing distortion and tendril extrusion. Lunges fire on a beat-
  // aligned cadence (every WRAITH_LUNGE_PERIOD seconds, offset per-wraith
  // so they stagger). Pre-roll per-tendril phase offsets at construction
  // so each wraith has its own gait.
  writhePhase = 0;
  // 0 → just-emerged, 1 → fully manifested. Eases up over emergeDuration
  // so a wraith doesn't appear and instantly start damaging the player.
  wraithEmerge = 0;
  // beatTime (in seconds) offset within the lunge period. Baked at spawn
  // (0 or one measure) so several wraiths don't fire on the same downbeat.
  lungePhaseOffset = 0;
  // beatTime of the last lunge ignition; used to detect the next crossing.
  lungeLastFiredBeat = -1;
  // > 0 while mid-lunge; counts down. Drives the red-eye flare and the
  // additional pursuit acceleration burst during the lunge window.
  lungeActiveT = 0;
  // Per-tendril phase offsets (length determines tendril count). Decided at
  // spawn so each wraith reads as an individual; the actual extrusion is
  // computed live from this + writhePhase.
  wraithTendrils: number[] = [];
  // Emission cooldown for the dark-smoke trail the wraith bleeds behind it.
  wraithSmokeT = 0;

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
    const isBossHemisphere = kind === "bossHemisphere";
    const isBossEye = kind === "bossEye";
    const isBossPlate = kind === "bossPlate";
    const isBossIrisShard = kind === "bossIrisShard";
    const isBossEmber = kind === "bossEmber";
    const isBossFragment = isBossHemisphere || isBossEye || isBossPlate || isBossIrisShard || isBossEmber;
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
    if (kind === "solidCrystal") {
      // Slightly oversized vs a stock large — reads as a more menacing target
      // without towering over the field. Smalls keep stock size.
      this.radius = SOLID_CRYSTAL_LARGE_RADIUS;
      this.damageReduction = SOLID_CRYSTAL_DAMAGE_REDUCTION;
    }
    if (kind === "glassPrison") {
      // Slightly taller/thinner-feeling than a normal large; the elongated
      // facet polygon (kiki harmonics + low sample count) does the work.
      this.radius = GLASS_PRISON_RADIUS;
      this.rotSpeed = rand(-0.18, 0.18);
    }
    if (kind === "wraith") {
      this.radius = WRAITH_RADIUS;
      // Slow tumble — the writhe body deformation does the real visual work.
      this.rotSpeed = rand(-0.4, 0.4);
      this.writhePhase = rand(0, TAU);
      this.lungePhaseOffset = Math.random() < 0.5 ? 0 : BASS_MEASURE_LENGTH;
      // Five tendrils, evenly distributed around the body with per-piece
      // phase jitter so they wave asynchronously.
      const tendrilCount = 5;
      for (let i = 0; i < tendrilCount; i++) {
        this.wraithTendrils.push((i / tendrilCount) * TAU + rand(-0.4, 0.4));
      }
    }
    if (kind === "bell") {
      // Roll the cathedral archetype up front — buildHarmonicsForKind reads it
      // to pick a silhouette that suits the architecture (a spire is tall and
      // narrow, an arcade is wide and squat, etc.), and paintCathedralFragment
      // -Body dispatches the interior on it.
      this.cathedralArchetype = CATHEDRAL_ARCHETYPES[Math.floor(rng() * CATHEDRAL_ARCHETYPES.length)];
    }
    if (isBoss) {
      // Boss is huge — override the size table so its physical footprint
      // matches its visual identity as a planetoid that just dropped in.
      this.radius = BOSS_RADIUS[size];
      // Slow majestic spin. Even the small bosses keep a heavier rotation
      // than ordinary asteroids — these are chunks of broken planet, not
      // pebbles.
      this.rotSpeed = rand(-0.12, 0.12) * (size === "large" ? 0.5 : 1);
      // Whole-body boss starts dormant: the 8s grow-and-rotate reveal plays
      // before the eye opens and damage becomes possible. Children of the
      // shatter spawn directly into "live" phase (overridden below).
      this.bossPhase = "dormant";
      this.bossRevealT = 0;
      // The closed eyelid seam is centred at this latitude; the iris radius
      // is fixed for visual layout consistency.
      this.bossEyeRadius = ENTITY_CONFIG.boss.eyeRadius * (this.radius / BOSS_RADIUS.large);
    }
    if (isBossHemisphere) {
      // Hemispheres render as half-discs but use a circular hitbox sized to
      // the full half-disc bounds. Radius matches the boss medium tier.
      this.radius = BOSS_RADIUS.medium;
      this.rotSpeed = rand(-0.18, 0.18);
    }
    if (isBossEye) {
      // Eye core is smaller than the hemispheres but the most dangerous
      // piece — it keeps firing. Use the dedicated eyeRadius.
      this.radius = ENTITY_CONFIG.boss.eyeRadius;
      this.rotSpeed = rand(-0.12, 0.12);
      // Rhythm fields are inherited from the parent boss via Asteroid.split
      // — no per-construction setup needed beyond the defaults declared at
      // the field level.
    }
    if (isBossPlate) {
      this.radius = BOSS_RADIUS.small;
      this.rotSpeed = rand(-1.4, 1.4);
    }
    if (isBossIrisShard) {
      this.radius = BOSS_RADIUS.small * 0.85;
      this.rotSpeed = rand(-2.0, 2.0);
    }
    if (isBossEmber) {
      this.radius = BOSS_RADIUS.small * 0.55;
      this.rotSpeed = rand(-1.0, 1.0);
    }
    this.maxHp = isBoss
      ? BOSS_HP[size]
      : isBossHemisphere
        ? BOSS_HP.medium
        : isBossEye
          ? ENTITY_CONFIG.boss.eyeHp
          : isBossPlate || isBossIrisShard || isBossEmber
            ? BOSS_HP.small
            : isBass
              ? BASS_HP[size]
              : kind === "solidCrystal"
                ? SOLID_CRYSTAL_HP_LARGE
                : kind === "solidCrystalSmall"
                  ? SOLID_CRYSTAL_HP_SMALL
                  : kind === "glassPrison"
                    ? GLASS_PRISON_HP
                    : kind === "wraith"
                      ? WRAITH_HP
                      : CATHEDRAL_DEBRIS_KINDS.includes(kind)
                        ? CATHEDRAL_DEBRIS_HP
                        : ASTEROID_HP[size];
    this.hp = this.maxHp;
    // For most asteroids each HP gets its own pre-rolled crack so the
    // damage state escalates predictably. The boss has a much higher HP
    // budget (60 large) — drawing 60 multi-branch overlays every frame is
    // wasteful and looks like noise, so cap the boss at a handful of
    // distinct fractures and let `renderBossCracks` interpolate brightness
    // with the damage fraction instead.
    const crackCount = isBoss
      ? 12
      : isBossHemisphere ? 8 : isBossEye ? 6 : (isBossPlate || isBossIrisShard || isBossEmber) ? 4
      : this.maxHp;
    this.cracks = rollCracks(crackCount);
    const kindHue = KIND_HUE[kind];
    this.hue = hue ?? ((isBoss || isBossFragment) ? BOSS_HUE : kindHue !== undefined ? kindHue : nextWaveHue());
    this.harmonics = this.buildHarmonicsForKind(kind);
    // Solid crystal reads as cut glass — drop the outline sample count to a
    // small number (7 for large, 6 for small fragments) so the silhouette
    // is a hard-edged polygon with sharp corners rather than a smoothly
    // resampled Fourier curve. Kiki, not bouba.
    if (kind === "solidCrystal") this.outlineSamples = 7;
    else if (kind === "solidCrystalSmall") this.outlineSamples = 6;
    // Prison silhouette is a tall narrow polygon — 8 vertices read as a
    // hand-cut sarcophagus rather than a generic rock.
    else if (kind === "glassPrison") this.outlineSamples = 8;
    // Bell asteroid is a chunk of cathedral wall — moderate-count polygon
    // (chipped masonry edge) rather than a smooth organic curve.
    else if (kind === "bell") this.outlineSamples = 22;
    // Cathedral debris: glass shard is a hard-edged sliver (few vertices, kiki);
    // keystone is a chunky wedge; column drum + rubble keep more vertices for a
    // chipped-stone edge.
    else if (kind === "glassShard") this.outlineSamples = 6;
    else if (kind === "cathedralKeystone") this.outlineSamples = 8;
    else if (kind === "columnDrum" || kind === "rubbleBlock") this.outlineSamples = 16;
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
    // Roll embedded gem count for solid crystals — weighted 60/25/10/5 for
    // 0/1/2/3 gems — and pick local-space spots so they can be pre-baked into
    // the sprite as frosted hints and dropped at the same positions on death.
    if (kind === "solidCrystal") {
      const gemRoll = rng();
      this.embeddedGemCount = gemRoll < 0.6 ? 0 : gemRoll < 0.85 ? 1 : gemRoll < 0.95 ? 2 : 3;
      for (let i = 0; i < this.embeddedGemCount; i++) {
        const angle = rand(0, TAU);
        const dist = this.embeddedGemCount === 1 ? rand(0, this.radius * 0.18) : this.radius * rand(0.28, 0.42);
        const a = this.embeddedGemCount === 1 ? 0 : angle + (i * TAU) / this.embeddedGemCount;
        this.embeddedGemSpots.push({
          x: Math.cos(a) * dist,
          y: Math.sin(a) * dist,
          r: this.radius * rand(0.18, 0.24),
          tilt: rand(0, TAU),
        });
      }
    }
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
  // mix. "normal" stays the classic lumpy default; chime/bell/warble each
  // lean on different frequencies so they read as different shapes even
  // before colour cues land.
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
      // Cathedral fragment carved from an asteroid. The archetype picks the
      // gross proportion: a spire/tower wants a tall narrow body, an arcade
      // wants a wide squat slab, etc. Low harmonics give the chunky "broken
      // slab of building" silhouette; paintCathedralFragmentBody does the
      // architectural detailing on the interior.
      switch (this.cathedralArchetype) {
        case "spireTower": freqs = [1, 2, 3]; ampScale = 1.2; break;
        case "arcade":     freqs = [1, 2, 4]; ampScale = 1.4; break;
        case "roseFacade": freqs = [2, 3, 5]; ampScale = 1.1; break;
        case "buttressRuin": freqs = [1, 3, 5]; ampScale = 1.7; break;
        default:           freqs = [1, 2, 4]; ampScale = 1.5; break;
      }
    } else if (kind === "cathedralKeystone") {
      // A wedge-shaped voussoir / keystone chunk — strong 1-harmonic gives the
      // tapered "fat at one end" wedge, 3 jags the broken edges.
      freqs = [1, 3]; ampScale = 1.8;
    } else if (kind === "glassShard") {
      // A sharp sliver of stained glass — high amp on a low freq makes a long
      // pointed splinter; the low sample count keeps the edges hard.
      freqs = [1, 2]; ampScale = 2.0;
    } else if (kind === "columnDrum") {
      // A section of carved column / capital — nearly round (a drum of stone)
      // with light fluting wobble.
      freqs = [2, 6]; ampScale = 0.6;
    } else if (kind === "rubbleBlock") {
      // A plain chipped masonry block — chunky irregular polygon.
      freqs = [1, 2, 4]; ampScale = 1.3;
    } else if (kind === "warble") {
      // Wobbly elongated lobes: strong 3-fold + odd higher mode.
      freqs = [3, 5, 8];
      ampScale = 1.4;
    } else if (kind === "glassPrison") {
      // Strong 1-harmonic = tall asymmetric sarcophagus (one end wider than
      // the other). 3 and 5 jut individual facet vertices outward. The clamp
      // in computeOutline (set for glassPrison alongside crystals) prevents
      // a degenerate collapse if phases happen to align.
      freqs = [1, 3, 5];
      ampScale = 1.6;
    } else if (kind === "solidCrystal" || kind === "solidCrystalSmall") {
      // Pure crystal: a low harmonic count + low outlineSamples (set in the
      // constructor) make the silhouette a hard-edged polygon. Avoid any
      // freq that divides outlineSamples (7 for large, 6 for small) — those
      // alias to a constant offset across all sample points and produce no
      // visible variation. Low harmonics (1,2) handle the overall lopsided
      // body (one side bulges, the other tapers); 4 and 5 spike individual
      // vertices outward as broken-off shards. Result: dramatically irregular
      // polygons, each one different. computeOutline clamps the resulting
      // radius to a safe band so the shard can't collapse to a degenerate
      // self-intersecting polygon when harmonics happen to align in phase.
      freqs = [1, 2, 4, 5];
      ampScale = 1.8;
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

  buildSprite(): HTMLCanvasElement | null {
    // Boss-family pieces all paint live (the whole-body boss needs to swell
    // during the dormant reveal, hemispheres draw a half-disc that depends
    // on bossFragmentAngle, eye core renders the tracking iris each frame,
    // shards are tumbling sub-pieces). Returning null skips the pre-bake;
    // render() branches on kind below to dispatch to the live painters.
    // Wraiths also paint live — their entire identity is "writhing motion",
    // so a pre-baked silhouette would defeat the point.
    if (this.isBossFamily() || this.kind === "wraith") return null;
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
    // hard so the special kinds (chime/bell/warble/bass) are the only
    // things drawing the eye with colour. goldCrystal mimics a normal rock
    // (the crystal hint is painted in separately below) so it stays plain.
    const isPlain = this.kind === "normal" || this.kind === "goldCrystal";
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
    ctx.stroke();

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

    if (this.kind === "goldCrystal") this.paintEmbeddedGoldCrystal(ctx);
    if (this.kind === "solidCrystal" || this.kind === "solidCrystalSmall") this.paintSolidCrystalBody(ctx);
    if (this.kind === "glassPrison") this.paintGlassPrisonBody(ctx);
    if (this.kind === "bell") this.paintCathedralFragmentBody(ctx);
    if (this.kind === "cathedralKeystone") this.paintKeystoneBody(ctx);
    if (this.kind === "glassShard") this.paintGlassShardBody(ctx);
    if (this.kind === "columnDrum") this.paintColumnDrumBody(ctx);
    if (this.kind === "rubbleBlock") this.paintRubbleBlockBody(ctx);

    return canvas;
  }

  // The glass prison is faceted indigo crystal containing a captive wraith.
  // Pre-baked: the outer shell (etched runes, faceted shading, rim) + the
  // dark interior with the frozen silhouette of the thing inside. Per-frame
  // we overlay an eye-glow pulse in render() so the captive reads as "still
  // alive". Drawing order: shell paint → clip → interior void → silhouette
  // → runes overstroke.
  private paintGlassPrisonBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    const verts: Vec[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      verts.push(v(Math.cos(angle) * r, Math.sin(angle) * r));
    }

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
      else ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    ctx.clip();

    // Interior void — much darker than a solid crystal. The captive lives
    // in here; the player should feel they're peering into a black sarcophagus.
    ctx.globalCompositeOperation = "source-over";
    const voidGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    voidGrad.addColorStop(0, `hsla(${H - 8}, 60%, 6%, 1)`);
    voidGrad.addColorStop(0.6, `hsla(${H}, 55%, 10%, 0.95)`);
    voidGrad.addColorStop(1, `hsla(${H + 8}, 45%, 16%, 0.85)`);
    ctx.fillStyle = voidGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    // Frosted facet wash — same fan-triangulation trick the solid crystal
    // uses, but additive and far lower-alpha so the void shows through. The
    // faintly-lit facets sell the "this is cut glass" read without making
    // the shell read as solid.
    const lightX = -R * 0.5;
    const lightY = -R * 0.55;
    const maxLightDist = R * 1.9;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const cx = (a.x + b.x) / 3;
      const cy = (a.y + b.y) / 3;
      const d = Math.hypot(cx - lightX, cy - lightY);
      const lit = Math.pow(Math.max(0, 1 - d / maxLightDist), 1.4);
      const lightness = 22 + lit * 36;
      const alpha = 0.18 + lit * 0.22;
      ctx.fillStyle = `hsla(${H + 8}, 75%, ${lightness}%, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.closePath();
      ctx.fill();
    }

    // The captive silhouette — a hunched figure rendered in near-black with a
    // single bright violet rim. Hand-tuned vertex list (in local space, scaled
    // by R) so each prison reads as the SAME thing inside, not a procedural
    // blob. The figure faces the viewer, arms hugging itself.
    ctx.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.fillStyle = `hsla(${H - 12}, 80%, 4%, 0.95)`;
    ctx.beginPath();
    const head = R * 0.16;
    ctx.arc(0, -R * 0.28, head, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-R * 0.20, -R * 0.05);
    ctx.lineTo( R * 0.20, -R * 0.05);
    ctx.lineTo( R * 0.28,  R * 0.30);
    ctx.lineTo( R * 0.10,  R * 0.55);
    ctx.lineTo(-R * 0.10,  R * 0.55);
    ctx.lineTo(-R * 0.28,  R * 0.30);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-R * 0.18, -R * 0.02);
    ctx.lineTo(-R * 0.32,  R * 0.18);
    ctx.lineTo(-R * 0.14,  R * 0.32);
    ctx.lineTo(-R * 0.08,  R * 0.10);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo( R * 0.18, -R * 0.02);
    ctx.lineTo( R * 0.32,  R * 0.18);
    ctx.lineTo( R * 0.14,  R * 0.32);
    ctx.lineTo( R * 0.08,  R * 0.10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Frost veil — a milky band just inside the silhouette so the figure
    // reads as "encased in ice" rather than "painted on a window".
    const frostGrad = ctx.createRadialGradient(0, 0, R * 0.15, 0, 0, R * 1.0);
    frostGrad.addColorStop(0, `hsla(${H + 4}, 30%, 90%, 0)`);
    frostGrad.addColorStop(0.65, `hsla(${H + 2}, 40%, 78%, 0.08)`);
    frostGrad.addColorStop(1, `hsla(${H}, 50%, 88%, 0.32)`);
    ctx.fillStyle = frostGrad;
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    // Etched containment runes — thin bright glyph segments scattered along
    // the inside of the rim. Suggests "this thing was bound here on purpose".
    // Pre-rolled positions look identical every paint (we want every prison
    // to feel like a deliberate ritual artefact, not procedurally noisy).
    ctx.strokeStyle = `hsla(${H + 22}, 80%, 82%, 0.55)`;
    ctx.lineWidth = 0.8;
    const runeCount = 12;
    for (let i = 0; i < runeCount; i++) {
      const a = (i / runeCount) * TAU + 0.12;
      const rr = R * 0.84;
      const cx = Math.cos(a) * rr;
      const cy = Math.sin(a) * rr;
      const tang = a + Math.PI / 2;
      const len = R * 0.07;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(tang) * len, cy - Math.sin(tang) * len);
      ctx.lineTo(cx + Math.cos(tang) * len, cy + Math.sin(tang) * len);
      ctx.stroke();
      // tiny perpendicular tick = stylised glyph rather than a hash mark.
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * len * 0.6, cy + Math.sin(a) * len * 0.6);
      ctx.stroke();
    }

    // Hairline facet seams from centre to each vertex.
    ctx.strokeStyle = `hsla(${H + 14}, 90%, 80%, 0.16)`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (const vtx of verts) {
      ctx.moveTo(0, 0);
      ctx.lineTo(vtx.x * 0.95, vtx.y * 0.95);
    }
    ctx.stroke();

    // Thick shell rim — two stacked strokes: an outer dark layer for depth,
    // a bright inner band for the "cut glass edge" tell. Heavier and cooler
    // than the solid crystal so the prison reads as a tougher object.
    const rimPath = () => {
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
        else ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.closePath();
    };
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    ctx.strokeStyle = `hsla(${H - 16}, 75%, 14%, 0.95)`;
    ctx.lineWidth = 5.0;
    rimPath();
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 18}, 70%, 88%, 0.85)`;
    ctx.lineWidth = 2.4;
    rimPath();
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 30}, 60%, 96%, 0.55)`;
    ctx.lineWidth = 0.8;
    ctx.save();
    ctx.scale(0.94, 0.94);
    rimPath();
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  // Trace this asteroid's organic outline as a path (no fill/stroke). Shared by
  // the cathedral painters for clip + rim work.
  private traceOutline(ctx: CanvasRenderingContext2D, scale = 1) {
    ctx.beginPath();
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

  // The chipped-masonry double rim every cathedral piece wears: a thick dark
  // outer stroke (occlusion contact against the starfield) + a thin bright
  // inset stroke (sunlit stone catching the upper-left light).
  private paintStoneRim(ctx: CanvasRenderingContext2D, H: number) {
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    ctx.strokeStyle = `hsla(${H}, 22%, 7%, 0.92)`;
    ctx.lineWidth = 3.0;
    this.traceOutline(ctx);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 6}, 18%, 72%, 0.45)`;
    ctx.lineWidth = 0.9;
    this.traceOutline(ctx, 0.96);
    ctx.stroke();
  }

  // Weathered raw-asteroid stone: an offset upper-left hot-spot body gradient +
  // a scatter of deterministic crater pits (each with a bright lit lip and a
  // dark floor) so the surface reads as living rock the architecture was carved
  // OUT OF — not a clean built wall. Seeded from the harmonic phases so each
  // bell weathers differently but stably across the bake.
  private paintAsteroidStone(ctx: CanvasRenderingContext2D, H: number, R: number) {
    ctx.globalCompositeOperation = "source-over";
    const stoneGrad = ctx.createRadialGradient(-R * 0.4, -R * 0.5, R * 0.1, 0, 0, R * 1.35);
    stoneGrad.addColorStop(0, `hsla(${H}, 13%, 56%, 1)`);
    stoneGrad.addColorStop(0.5, `hsla(${H}, 11%, 36%, 1)`);
    stoneGrad.addColorStop(1, `hsla(${H + 8}, 18%, 12%, 1)`);
    ctx.fillStyle = stoneGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.45, 0, TAU);
    ctx.fill();

    // Crater pits — concave dimples in the raw rock. Bright up-left lip, dark
    // down-right floor = a believable mini-terminator per pit.
    const seed = this.harmonics.reduce((s, h) => s + h.phase * h.freq, 0);
    const pitCount = 7;
    for (let i = 0; i < pitCount; i++) {
      const a = seed + (i / pitCount) * TAU + Math.sin(i * 2.1 + seed) * 0.6;
      const d = R * (0.30 + 0.55 * Math.abs(Math.cos(i * 1.7 + seed)));
      const px = Math.cos(a) * d;
      const py = Math.sin(a) * d;
      const pr = R * (0.10 + 0.09 * Math.abs(Math.sin(i * 1.3 + seed)));
      const floor = ctx.createRadialGradient(px + pr * 0.2, py + pr * 0.2, 0, px, py, pr);
      floor.addColorStop(0, `hsla(${H}, 16%, 14%, 0.5)`);
      floor.addColorStop(1, `hsla(${H}, 12%, 36%, 0)`);
      ctx.fillStyle = floor;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, TAU);
      ctx.fill();
      const lip = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, 0, px - pr * 0.4, py - pr * 0.4, pr * 0.9);
      lip.addColorStop(0, `hsla(${H + 10}, 14%, 66%, 0.32)`);
      lip.addColorStop(1, `hsla(${H}, 12%, 40%, 0)`);
      ctx.fillStyle = lip;
      ctx.beginPath();
      ctx.arc(px - pr * 0.4, py - pr * 0.4, pr * 0.9, 0, TAU);
      ctx.fill();
    }
  }

  // Draw a beveled recess into the stone: this is what sells "carved into the
  // asteroid" rather than "a window pasted on a wall". The opening is filled
  // dark (the hollow), then an inner highlight stroke on the upper-left edge
  // (stone catching light as it steps down) and a darker stroke on the lower-
  // right (the cut face in shadow). `pathFn(inset)` traces the opening at a
  // given inset so callers reuse their own opening shape.
  private paintCarvedRecess(ctx: CanvasRenderingContext2D, H: number, pathFn: (inset: number) => void) {
    ctx.fillStyle = `hsla(${H}, 14%, 30%, 1)`;
    pathFn(-3.0);
    ctx.fill();
    ctx.fillStyle = `hsla(${H}, 16%, 9%, 1)`;
    pathFn(-1.0);
    ctx.fill();
    ctx.save();
    pathFn(-3.0);
    ctx.clip();
    ctx.lineJoin = "round";
    ctx.strokeStyle = `hsla(${H + 8}, 16%, 70%, 0.6)`;
    ctx.lineWidth = 1.6;
    ctx.translate(-1.1, -1.1);
    pathFn(-1.2);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    pathFn(-3.0);
    ctx.clip();
    ctx.strokeStyle = `hsla(${H}, 22%, 6%, 0.7)`;
    ctx.lineWidth = 1.6;
    ctx.translate(1.1, 1.1);
    pathFn(-1.2);
    ctx.stroke();
    ctx.restore();
  }

  // Fill an opening with lit stained glass + leaded seams + a warm interior
  // bleed. `pathFn(inset)` traces the opening; `cx,cy` is the glow centre and
  // `top,bot` the vertical span for the lighting gradient; `seams` draws the
  // leading inside a clip.
  private paintStainedGlass(
    ctx: CanvasRenderingContext2D,
    H: number,
    pathFn: (inset: number) => void,
    top: number,
    bot: number,
    cx: number,
    cy: number,
    glowR: number,
    seams: () => void,
  ) {
    const glassGrad = ctx.createLinearGradient(0, top, 0, bot);
    glassGrad.addColorStop(0, `hsla(${H + 14}, 88%, 72%, 1)`);
    glassGrad.addColorStop(0.5, `hsla(${H}, 82%, 50%, 1)`);
    glassGrad.addColorStop(1, `hsla(${H - 16}, 76%, 28%, 1)`);
    ctx.fillStyle = glassGrad;
    pathFn(0);
    ctx.fill();

    ctx.save();
    pathFn(0);
    ctx.clip();
    ctx.strokeStyle = `hsla(${H - 10}, 32%, 8%, 0.85)`;
    ctx.lineWidth = 1.0;
    seams();
    ctx.restore();

    ctx.strokeStyle = `hsla(${H}, 12%, 72%, 0.85)`;
    ctx.lineWidth = 1.8;
    pathFn(0);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H}, 18%, 13%, 0.7)`;
    ctx.lineWidth = 0.9;
    pathFn(1.5);
    ctx.stroke();

    ctx.globalCompositeOperation = "lighter";
    const bleed = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    bleed.addColorStop(0, `hsla(${H + 8}, 82%, 62%, 0.26)`);
    bleed.addColorStop(1, `hsla(${H}, 70%, 40%, 0)`);
    ctx.fillStyle = bleed;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  // Lay a band of dressed masonry courses behind an archetype's feature so the
  // carved architecture sits on worked stone, not raw rock — offset-brick
  // mortar lines within the vertical band [yTop, yBot].
  private paintMasonryBand(ctx: CanvasRenderingContext2D, H: number, R: number, yTop: number, yBot: number) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-R * 1.5, yTop, R * 3, yBot - yTop);
    ctx.clip();
    ctx.fillStyle = `hsla(${H}, 12%, 42%, 0.5)`;
    ctx.fillRect(-R * 1.5, yTop, R * 3, yBot - yTop);
    ctx.strokeStyle = `hsla(${H}, 18%, 8%, 0.6)`;
    ctx.lineWidth = 0.8;
    const courseH = R * 0.2;
    ctx.beginPath();
    for (let y = yTop; y <= yBot; y += courseH) {
      ctx.moveTo(-R * 1.5, y);
      ctx.lineTo(R * 1.5, y);
    }
    ctx.stroke();
    ctx.beginPath();
    const joint = R * 0.34;
    let row = 0;
    for (let y = yTop; y < yBot; y += courseH) {
      const stagger = row % 2 === 0 ? 0 : joint / 2;
      for (let col = -5; col <= 5; col++) {
        const x = col * joint + stagger;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + courseH);
      }
      row++;
    }
    ctx.stroke();
    ctx.restore();
  }

  // Trace a gothic lancet (pointed-arch) opening centred at cx.
  private lancetPath(ctx: CanvasRenderingContext2D, cx: number, halfW: number, top: number, bot: number, tip: number, inset: number) {
    const hw = halfW - inset;
    const t = top + inset;
    const b = bot - inset;
    const tp = tip + inset * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx - hw, b);
    ctx.lineTo(cx - hw, t);
    ctx.quadraticCurveTo(cx - hw, tp, cx, tp);
    ctx.quadraticCurveTo(cx + hw, tp, cx + hw, t);
    ctx.lineTo(cx + hw, b);
    ctx.closePath();
  }

  // A round rose / wheel window of stained-glass petals carved at (cx, cy).
  private paintRoseWindow(ctx: CanvasRenderingContext2D, H: number, cx: number, cy: number, rr: number, petals: number) {
    const ringPath = (inset: number) => {
      ctx.beginPath();
      ctx.arc(cx, cy, rr - inset, 0, TAU);
    };
    this.paintCarvedRecess(ctx, H, ringPath);
    ctx.fillStyle = `hsla(${H + 6}, 82%, 52%, 1)`;
    ctx.beginPath();
    ctx.arc(cx, cy, rr - 1.2, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H - 10}, 32%, 9%, 0.85)`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (rr - 1.5), cy + Math.sin(a) * (rr - 1.5));
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, rr * 0.6, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H}, 12%, 72%, 0.8)`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `hsla(${H + 16}, 92%, 82%, 0.95)`;
    ctx.beginPath();
    ctx.arc(cx, cy, rr * 0.16, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    const bleed = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr * 2.0);
    bleed.addColorStop(0, `hsla(${H + 14}, 86%, 70%, 0.30)`);
    bleed.addColorStop(1, `hsla(${H}, 70%, 40%, 0)`);
    ctx.fillStyle = bleed;
    ctx.beginPath();
    ctx.arc(cx, cy, rr * 2.0, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  // ----- Archetype: lancet wall (the classic — one tall pointed window) -----
  private paintLancetWall(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 0.95, R * 0.55);
    const top = -R * 0.6, bot = R * 0.24, halfW = R * 0.22, tip = -R * 0.8;
    const path = (inset: number) => this.lancetPath(ctx, 0, halfW, top, bot, tip, inset);
    this.paintCarvedRecess(ctx, H, path);
    this.paintStainedGlass(ctx, H, path, top, bot, 0, (top + bot) / 2, R * 0.5, () => {
      ctx.beginPath();
      for (let i = 1; i <= 3; i++) {
        const x = -halfW + (i / 4) * (2 * halfW);
        ctx.moveTo(x, tip);
        ctx.lineTo(x, bot);
      }
      const ty = (top + bot) / 2 + R * 0.05;
      ctx.moveTo(-halfW, ty);
      ctx.lineTo(halfW, ty);
      ctx.stroke();
    });
    const sillW = halfW + R * 0.06;
    ctx.fillStyle = `hsla(${H}, 14%, 50%, 1)`;
    ctx.fillRect(-sillW, bot + R * 0.01, sillW * 2, R * 0.05);
    ctx.fillStyle = `hsla(${H}, 18%, 11%, 0.55)`;
    ctx.fillRect(-sillW, bot + R * 0.06, sillW * 2, R * 0.025);
    this.paintRoseWindow(ctx, H, 0, tip - R * 0.18, R * 0.1, 6);
  }

  // ----- Archetype: rose facade (a big wheel window over twin lancets) -----
  private paintRoseFacade(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 0.9, R * 0.7);
    this.paintRoseWindow(ctx, H, 0, -R * 0.28, R * 0.3, 8);
    const top = R * 0.12, bot = R * 0.6, halfW = R * 0.1, tip = R * 0.0;
    for (const cx of [-R * 0.22, R * 0.22]) {
      const path = (inset: number) => this.lancetPath(ctx, cx, halfW, top, bot, tip, inset);
      this.paintCarvedRecess(ctx, H, path);
      this.paintStainedGlass(ctx, H, path, top, bot, cx, (top + bot) / 2, R * 0.25, () => {
        ctx.beginPath();
        ctx.moveTo(cx, tip);
        ctx.lineTo(cx, bot);
        ctx.stroke();
      });
    }
  }

  // ----- Archetype: spire / belfry tower (tall, stacked slit openings) -----
  private paintSpireTower(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 1.0, R * 0.9);
    const halfW = R * 0.08;
    for (let i = 0; i < 3; i++) {
      const cy0 = -R * 0.55 + i * R * 0.42;
      const top = cy0, bot = cy0 + R * 0.26, tip = cy0 - R * 0.1;
      const path = (inset: number) => this.lancetPath(ctx, 0, halfW, top, bot, tip, inset);
      this.paintCarvedRecess(ctx, H, path);
      this.paintStainedGlass(ctx, H, path, top, bot, 0, (top + bot) / 2, R * 0.22, () => {
        ctx.beginPath();
        ctx.moveTo(0, tip);
        ctx.lineTo(0, bot);
        ctx.stroke();
      });
    }
    ctx.strokeStyle = `hsla(${H}, 12%, 76%, 0.85)`;
    ctx.lineWidth = 1.6;
    const fy = -R * 0.78;
    ctx.beginPath();
    ctx.moveTo(0, fy - R * 0.12);
    ctx.lineTo(0, fy + R * 0.1);
    ctx.moveTo(-R * 0.07, fy - R * 0.03);
    ctx.lineTo(R * 0.07, fy - R * 0.03);
    ctx.stroke();
  }

  // ----- Archetype: arcade (a row of small round-arch openings) -----
  private paintArcade(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 0.5, R * 0.5);
    const top = -R * 0.18, bot = R * 0.32, halfW = R * 0.13, tip = -R * 0.34;
    for (const cx of [-R * 0.5, 0, R * 0.5]) {
      const path = (inset: number) => this.lancetPath(ctx, cx, halfW, top, bot, tip, inset);
      this.paintCarvedRecess(ctx, H, path);
      this.paintStainedGlass(ctx, H, path, top, bot, cx, (top + bot) / 2, R * 0.28, () => {
        ctx.beginPath();
        ctx.moveTo(cx, tip);
        ctx.lineTo(cx, bot);
        ctx.stroke();
      });
    }
    ctx.fillStyle = `hsla(${H}, 14%, 50%, 1)`;
    ctx.fillRect(-R * 0.85, bot + R * 0.03, R * 1.7, R * 0.05);
    ctx.fillStyle = `hsla(${H}, 18%, 11%, 0.5)`;
    ctx.fillRect(-R * 0.85, bot + R * 0.08, R * 1.7, R * 0.025);
  }

  // ----- Archetype: buttressed ruin (a broken flying-buttress stub) -----
  private paintButtressRuin(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 0.7, R * 0.8);
    ctx.save();
    ctx.strokeStyle = `hsla(${H}, 13%, 44%, 1)`;
    ctx.lineWidth = R * 0.16;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-R * 0.6, R * 0.55);
    ctx.quadraticCurveTo(-R * 0.1, -R * 0.1, R * 0.35, -R * 0.2);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 8}, 14%, 66%, 0.7)`;
    ctx.lineWidth = R * 0.04;
    ctx.beginPath();
    ctx.moveTo(-R * 0.6, R * 0.5);
    ctx.quadraticCurveTo(-R * 0.12, -R * 0.16, R * 0.33, -R * 0.25);
    ctx.stroke();
    ctx.restore();
    const top = -R * 0.45, bot = R * 0.2, halfW = R * 0.12, tip = -R * 0.6;
    const cx = R * 0.42;
    const path = (inset: number) => this.lancetPath(ctx, cx, halfW, top, bot, tip, inset);
    this.paintCarvedRecess(ctx, H, path);
    this.paintStainedGlass(ctx, H, path, top, bot, cx, (top + bot) / 2, R * 0.3, () => {
      ctx.beginPath();
      ctx.moveTo(cx, tip);
      ctx.lineTo(cx, bot);
      ctx.stroke();
    });
    ctx.fillStyle = `hsla(${H}, 16%, 24%, 0.8)`;
    for (let i = -2; i <= 2; i++) {
      const tx = i * R * 0.22;
      ctx.fillRect(tx, R * 0.6, R * 0.12, R * 0.18);
    }
  }

  // ===== Cathedral debris (terminal small fragments a bell shatters into) =====

  // A wedge-shaped keystone / arch voussoir — the dressed stone block that
  // locked an arch. Trapezoidal block face, chisel grooves, bright sunlit top.
  private paintKeystoneBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    this.paintAsteroidStone(ctx, H, R);
    ctx.globalCompositeOperation = "source-over";
    const face = ctx.createLinearGradient(-R, -R, R, R);
    face.addColorStop(0, `hsla(${H + 6}, 14%, 62%, 1)`);
    face.addColorStop(0.5, `hsla(${H}, 12%, 42%, 1)`);
    face.addColorStop(1, `hsla(${H + 8}, 16%, 18%, 1)`);
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.moveTo(-R * 0.62, -R * 0.5);
    ctx.lineTo(R * 0.62, -R * 0.5);
    ctx.lineTo(R * 0.4, R * 0.62);
    ctx.lineTo(-R * 0.4, R * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `hsla(${H}, 18%, 12%, 0.5)`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(i * R * 0.26, -R * 0.46);
      ctx.lineTo(i * R * 0.2, R * 0.56);
    }
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 8}, 16%, 74%, 0.7)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-R * 0.6, -R * 0.48);
    ctx.lineTo(R * 0.6, -R * 0.48);
    ctx.stroke();
    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // A sharp sliver of stained glass — still lit, still ringing. The most
  // colourful debris: a translucent jewel splinter with a glowing leaded edge.
  private paintGlassShardBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    ctx.globalCompositeOperation = "source-over";
    const glass = ctx.createLinearGradient(-R, -R, R, R);
    glass.addColorStop(0, `hsla(${H + 16}, 90%, 76%, 1)`);
    glass.addColorStop(0.5, `hsla(${H}, 84%, 52%, 1)`);
    glass.addColorStop(1, `hsla(${H - 18}, 78%, 30%, 1)`);
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.2, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H - 12}, 34%, 10%, 0.7)`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = i * 1.3 + 0.5;
      ctx.moveTo(-R * 0.2, -R * 0.15);
      ctx.lineTo(Math.cos(a) * R * 1.1 - R * 0.2, Math.sin(a) * R * 1.1 - R * 0.15);
    }
    ctx.stroke();
    ctx.fillStyle = `hsla(${H + 20}, 95%, 92%, 0.85)`;
    ctx.beginPath();
    ctx.ellipse(-R * 0.32, -R * 0.34, R * 0.18, R * 0.08, -0.7, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H - 8}, 40%, 8%, 0.9)`;
    ctx.lineWidth = 2.2;
    this.traceOutline(ctx);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 16}, 95%, 82%, 0.7)`;
    ctx.lineWidth = 0.9;
    this.traceOutline(ctx, 0.94);
    ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.6);
    bloom.addColorStop(0, `hsla(${H + 10}, 90%, 64%, 0.30)`);
    bloom.addColorStop(1, `hsla(${H}, 80%, 50%, 0)`);
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.6, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // A drum of a carved column / capital — a near-cylindrical stone section
  // with vertical fluting and a banded capital ring near the top.
  private paintColumnDrumBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    this.paintAsteroidStone(ctx, H, R);
    ctx.globalCompositeOperation = "source-over";
    const cyl = ctx.createLinearGradient(-R, 0, R, 0);
    cyl.addColorStop(0, `hsla(${H + 6}, 13%, 30%, 0.8)`);
    cyl.addColorStop(0.32, `hsla(${H + 8}, 14%, 64%, 0.85)`);
    cyl.addColorStop(0.6, `hsla(${H}, 12%, 40%, 0.7)`);
    cyl.addColorStop(1, `hsla(${H + 8}, 16%, 18%, 0.85)`);
    ctx.fillStyle = cyl;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.3, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H}, 18%, 12%, 0.45)`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = -3; i <= 3; i++) {
      const x = i * R * 0.22;
      ctx.moveTo(x, -R * 0.9);
      ctx.lineTo(x, R * 0.9);
    }
    ctx.stroke();
    ctx.fillStyle = `hsla(${H}, 14%, 52%, 1)`;
    ctx.fillRect(-R * 1.2, -R * 0.5, R * 2.4, R * 0.12);
    ctx.fillStyle = `hsla(${H}, 18%, 11%, 0.5)`;
    ctx.fillRect(-R * 1.2, -R * 0.38, R * 2.4, R * 0.04);
    ctx.fillStyle = `hsla(${H + 8}, 16%, 70%, 0.6)`;
    ctx.fillRect(-R * 1.2, -R * 0.52, R * 2.4, R * 0.03);
    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // A plain chipped masonry block — the least adorned debris. Dressed-stone
  // courses + a single offset joint, weathered, no glass.
  private paintRubbleBlockBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    this.paintAsteroidStone(ctx, H, R);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = `hsla(${H}, 18%, 9%, 0.6)`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(-R * 1.3, -R * 0.2);
    ctx.lineTo(R * 1.3, -R * 0.12);
    ctx.moveTo(-R * 1.3, R * 0.38);
    ctx.lineTo(R * 1.3, R * 0.42);
    ctx.moveTo(R * 0.05, -R * 0.16);
    ctx.lineTo(R * 0.02, R * 0.4);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 8}, 16%, 72%, 0.45)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-R * 0.9, -R * 0.55);
    ctx.lineTo(R * 0.2, -R * 0.7);
    ctx.stroke();
    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // The cathedral ("bell") asteroid reads as a fragment of a basilica that a
  // lost civilization carved out of an asteroid — weathered raw rock with
  // architecture recessed INTO it (beveled openings, not pasted-on walls).
  // Five archetypes (rolled at construction) give a row of bells real variety:
  // a lancet-window wall, a rose-window facade, a tapering belfry, an arcade of
  // small arches, and a buttressed ruin. Pre-baked, clipped to the organic
  // silhouette so the carved face bleeds into the chipped stone edge.
  private paintCathedralFragmentBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    this.paintAsteroidStone(ctx, H, R);
    switch (this.cathedralArchetype) {
      case "roseFacade": this.paintRoseFacade(ctx, H, R); break;
      case "spireTower": this.paintSpireTower(ctx, H, R); break;
      case "arcade": this.paintArcade(ctx, H, R); break;
      case "buttressRuin": this.paintButtressRuin(ctx, H, R); break;
      default: this.paintLancetWall(ctx, H, R); break;
    }
    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // Paint a faintly visible, blurred gold crystal inside the asteroid body —
  // the player has to *look* to spot it. Drawn at sprite-build time so it
  // pans/rotates with the rock for free. We clip to the asteroid outline so
  // the glow can't bleed past the silhouette and give away the secret. Note
  // the ctx.filter blur is applied inside a save/restore so it doesn't leak
  // to other passes.
  private paintEmbeddedGoldCrystal(ctx: CanvasRenderingContext2D) {
    const GOLD_HUE = 46;
    ctx.save();
    // Clip to the asteroid silhouette so any blurred bleed stays inside.
    ctx.beginPath();
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();

    // Soft gold halo behind the crystal — sells the "something is glowing
    // through the rock" read even when the facet polygon is too small to
    // pick out by itself. Drawn first so the facets overprint it.
    ctx.globalCompositeOperation = "lighter";
    ctx.filter = "blur(6px)";
    const haloR = this.radius * 0.7;
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
    halo.addColorStop(0, `hsla(${GOLD_HUE}, 85%, 60%, 0.32)`);
    halo.addColorStop(0.55, `hsla(${GOLD_HUE - 6}, 80%, 50%, 0.16)`);
    halo.addColorStop(1, `hsla(${GOLD_HUE}, 80%, 50%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloR, 0, TAU);
    ctx.fill();

    // Multi-faceted gem polygon — 6 vertices around a tilted hex with mild
    // per-vertex jitter so it reads as "hand-cut crystal" rather than a
    // perfect hexagon. Sized to ~35% of asteroid radius. Heavily blurred so
    // the silhouette is suggestive, not crisp.
    const facetCount = 6;
    const baseR = this.radius * 0.34;
    const tilt = rand(0, TAU);
    const verts: { x: number; y: number }[] = [];
    for (let i = 0; i < facetCount; i++) {
      const a = tilt + (i / facetCount) * TAU;
      const rj = baseR * rand(0.78, 1.08);
      verts.push({ x: Math.cos(a) * rj, y: Math.sin(a) * rj });
    }
    ctx.filter = "blur(3.5px)";
    // Fill — soft gold body.
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
      else ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    const body = ctx.createRadialGradient(0, 0, 0, 0, 0, baseR);
    body.addColorStop(0, `hsla(${GOLD_HUE + 6}, 95%, 72%, 0.55)`);
    body.addColorStop(0.6, `hsla(${GOLD_HUE}, 90%, 55%, 0.4)`);
    body.addColorStop(1, `hsla(${GOLD_HUE - 8}, 85%, 40%, 0.18)`);
    ctx.fillStyle = body;
    ctx.fill();

    // Faint facet lines from centre to each vertex — gives the gem its
    // internal cut. Low alpha so they read as "hint of structure", not as
    // a vector diagram.
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = `hsla(${GOLD_HUE + 18}, 100%, 85%, 0.35)`;
    for (const vtx of verts) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(vtx.x, vtx.y);
      ctx.stroke();
    }

    // Tiny bright centre highlight so the eye lands on something specific
    // through the blur.
    ctx.filter = "blur(2px)";
    const corePulse = ctx.createRadialGradient(0, 0, 0, 0, 0, baseR * 0.35);
    corePulse.addColorStop(0, `hsla(${GOLD_HUE + 18}, 100%, 92%, 0.55)`);
    corePulse.addColorStop(1, `hsla(${GOLD_HUE + 6}, 95%, 70%, 0)`);
    ctx.fillStyle = corePulse;
    ctx.beginPath();
    ctx.arc(0, 0, baseR * 0.35, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  // Paint a faceted crystal body over the asteroid silhouette. The interior
  // facets are built by triangulating the silhouette polygon itself — each
  // triangle (apex → adjacent outer vertices) gets a fill tinted by its
  // distance from a virtual light source, so the gem reads as one coherent
  // refractive object rather than a polygon with disjoint sparkle stapled on.
  private paintSolidCrystalBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    // Outer polygon vertices in local space — the same hard polygon the
    // silhouette stroke draws. We reuse these for triangulation so the inner
    // facet seams land *on* the outer corners.
    const verts: Vec[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      verts.push(v(Math.cos(angle) * r, Math.sin(angle) * r));
    }

    ctx.save();
    // Clip to the silhouette so anything we draw stays inside the gem.
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
      else ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    ctx.clip();

    // Virtual light source — sits up-left, just outside the gem. Each facet's
    // brightness comes from its centroid's distance to this point, so the
    // shading is continuous across the body and the gem looks like one solid
    // object catching light from one direction.
    const lightX = -R * 0.55;
    const lightY = -R * 0.6;
    const maxLightDist = R * 2.0;

    // Slightly inset "core" point each triangle fans from — offset toward the
    // light so the brightest pool isn't pinned to the exact geometric centre
    // (which always looks artificial). Tiny inset, no random jitter — keeps
    // every solid crystal coherent rather than each one looking ad-hoc.
    const coreX = -R * 0.08;
    const coreY = -R * 0.08;

    ctx.globalCompositeOperation = "source-over";

    // Triangulate the polygon as a fan around the core point. Each triangle
    // is one visible facet, shaded by its proximity to the virtual light.
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const cx = (coreX + a.x + b.x) / 3;
      const cy = (coreY + a.y + b.y) / 3;
      const d = Math.hypot(cx - lightX, cy - lightY);
      // 1.0 = right under the light, 0.0 = farthest facet. Power curve makes
      // the lit side noticeably brighter without crushing the shaded side.
      const lit = Math.pow(Math.max(0, 1 - d / maxLightDist), 1.6);
      const lightness = 16 + lit * 56;          // 16% (deep ice) → 72% (frosted highlight)
      // Saturation falls off toward the lit side — frosted ice scatters light
      // and reads near-white where it's hit, deep cool blue where it isn't.
      const sat = 85 - lit * 30;                // 85% (shaded) → 55% (lit, frost-pale)
      const alpha = 0.75 + lit * 0.2;
      ctx.fillStyle = `hsla(${H}, ${sat}%, ${lightness}%, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(coreX, coreY);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.closePath();
      ctx.fill();
    }

    // Hairline facet seams — the cuts between adjacent fan triangles. Drawn
    // as one path so the seam style is uniform and the alpha doesn't stack
    // at the core point.
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${H + 20}, 100%, 90%, 0.18)`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (const vtx of verts) {
      ctx.moveTo(coreX, coreY);
      ctx.lineTo(vtx.x * 0.96, vtx.y * 0.96);
    }
    ctx.stroke();

    // Frosted veil — a milky pale-blue ring sitting just inside the rim,
    // fading to transparent at the centre. Light scatters near the surface of
    // ice; this is the optical tell. Drawn additive so it brightens facets
    // underneath without flattening them.
    const frostGrad = ctx.createRadialGradient(0, 0, R * 0.15, 0, 0, R * 1.0);
    frostGrad.addColorStop(0, `hsla(${H + 10}, 30%, 90%, 0)`);
    frostGrad.addColorStop(0.55, `hsla(${H + 8}, 45%, 85%, 0.12)`);
    frostGrad.addColorStop(0.85, `hsla(${H + 6}, 55%, 92%, 0.32)`);
    frostGrad.addColorStop(1, `hsla(${H + 4}, 60%, 96%, 0.45)`);
    ctx.fillStyle = frostGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    // Inner luminous core — small soft pool at the gem's heart, biased toward
    // the light. Sells the "you can see *into* the crystal" depth without
    // burning a bright spot onto the surface like the old highlight did.
    const coreGrad = ctx.createRadialGradient(
      coreX, coreY, 0,
      coreX, coreY, R * 0.55,
    );
    coreGrad.addColorStop(0, `hsla(${H + 15}, 40%, 95%, 0.45)`);
    coreGrad.addColorStop(0.5, `hsla(${H + 5}, 55%, 82%, 0.15)`);
    coreGrad.addColorStop(1, `hsla(${H}, 60%, 65%, 0)`);
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(coreX, coreY, R * 0.55, 0, TAU);
    ctx.fill();

    // Thick shell rim — three stacked strokes along the outer polygon read as
    // a chunky crystalline shell, not a hairline. Outer dark layer gives the
    // gem visible thickness, middle bright layer is the "cut glass" tell, and
    // a thin inner highlight catches the light along the inside of the shell.
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    const rimPath = () => {
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
        else ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.closePath();
    };
    // Small variant is more fragile — render with a thinner shell rim.
    const isSmall = this.kind === "solidCrystalSmall";
    // Outer dark shell — gives the rim visible depth before the bright band.
    ctx.strokeStyle = `hsla(${H - 10}, 70%, 22%, 0.85)`;
    ctx.lineWidth = isSmall ? 2.0 : 4.5;
    rimPath();
    ctx.stroke();
    // Frosted highlight band — softer and cooler than a cut-glass edge would
    // be. Lower saturation + a wider shadow blur reads as light scattering on
    // a rimey ice surface instead of a polished gem facet.
    ctx.strokeStyle = `hsla(${H + 18}, 45%, 92%, 0.75)`;
    ctx.lineWidth = isSmall ? 1.2 : 2.6;
    rimPath();
    ctx.stroke();
    // Inner hairline — sits just inside the bright band; the cool, low-sat
    // tint keeps it reading as ice rather than chrome.
    ctx.strokeStyle = `hsla(${H + 25}, 35%, 96%, 0.55)`;
    ctx.lineWidth = 0.8;
    ctx.save();
    ctx.scale(0.93, 0.93);
    rimPath();
    ctx.stroke();
    ctx.restore();

    this.paintFrostedEmbeddedGems(ctx);

    ctx.restore();
  }

  // Heavily blurred gold gem hints visible through the crystal — same hue as
  // the GoldCrystal collectible they'll drop on death so the player can read
  // the loot in advance. Painted while the surrounding paintSolidCrystalBody
  // clip is still active, so any blurred bleed stays inside the silhouette.
  private paintFrostedEmbeddedGems(ctx: CanvasRenderingContext2D) {
    if (this.embeddedGemCount === 0) return;
    const GOLD_HUE = 46;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const spot of this.embeddedGemSpots) {
      ctx.save();
      ctx.translate(spot.x, spot.y);
      ctx.rotate(spot.tilt);
      // Soft halo behind the gem so it reads as "something glowing through
      // the ice" even when the hex polygon is too small to pick out.
      ctx.filter = "blur(5px)";
      const haloR = spot.r * 1.5;
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
      halo.addColorStop(0, `hsla(${GOLD_HUE}, 90%, 65%, 0.55)`);
      halo.addColorStop(0.6, `hsla(${GOLD_HUE - 6}, 85%, 55%, 0.22)`);
      halo.addColorStop(1, `hsla(${GOLD_HUE}, 80%, 50%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, haloR, 0, TAU);
      ctx.fill();
      // Faceted gem body — heavy blur keeps the silhouette suggestive.
      const facetCount = 6;
      const verts: { x: number; y: number }[] = [];
      for (let i = 0; i < facetCount; i++) {
        const a = (i / facetCount) * TAU;
        const rj = spot.r * rand(0.82, 1.04);
        verts.push({ x: Math.cos(a) * rj, y: Math.sin(a) * rj });
      }
      ctx.filter = "blur(3px)";
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
        else ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.closePath();
      const body = ctx.createRadialGradient(0, 0, 0, 0, 0, spot.r);
      body.addColorStop(0, `hsla(${GOLD_HUE + 6}, 95%, 75%, 0.7)`);
      body.addColorStop(0.6, `hsla(${GOLD_HUE}, 90%, 58%, 0.5)`);
      body.addColorStop(1, `hsla(${GOLD_HUE - 8}, 85%, 42%, 0.22)`);
      ctx.fillStyle = body;
      ctx.fill();
      // Tiny bright core through the frost.
      ctx.filter = "blur(2px)";
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, spot.r * 0.4);
      core.addColorStop(0, `hsla(${GOLD_HUE + 18}, 100%, 92%, 0.7)`);
      core.addColorStop(1, `hsla(${GOLD_HUE + 6}, 95%, 70%, 0)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, spot.r * 0.4, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
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

    // ---- Phase A: solid body (source-over) ----
    // Each panel is lit by a single upper-left sun, same recipe as the boss
    // body, so a bassteroid reads as a chunk of the same planetoid rather than
    // a flat neon decal. The fill is opaque (source-over) — this is matter,
    // not glow; the additive halo/lights come back in Phase C.
    ctx.globalCompositeOperation = "source-over";
    for (const module of ship.modules) {
      tracePanel(module);
      // Directional body gradient: hot-spot offset up-left, hue drifting warmer
      // and lighter in the lit corner, cooler and darker in shadow.
      const body = ctx.createLinearGradient(-r * 0.6, -r * 0.6, r * 0.6, r * 0.6);
      body.addColorStop(0, `hsl(${baseHue + 8}, 70%, 42%)`);
      body.addColorStop(0.5, `hsl(${baseHue}, 72%, 26%)`);
      body.addColorStop(1, `hsl(${baseHue - 8}, 78%, 11%)`);
      ctx.fillStyle = body;
      ctx.fill();
    }

    // Per-panel bevel: a bright strip along the top edge and a dark strip along
    // the bottom, clipped to the panel, so each plate catches the sun on its
    // upper lip and falls into shadow below — the boss-ring plate trick.
    for (const module of ship.modules) {
      ctx.save();
      tracePanel(module);
      ctx.clip();
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      for (const p of module.vertices) {
        minY = Math.min(minY, p.y * r); maxY = Math.max(maxY, p.y * r);
        minX = Math.min(minX, p.x * r); maxX = Math.max(maxX, p.x * r);
      }
      const w = maxX - minX;
      ctx.fillStyle = `hsla(${baseHue + 20}, 100%, 80%, 0.5)`;
      ctx.fillRect(minX, minY, w, 1.6);
      ctx.fillStyle = `hsla(${baseHue - 10}, 70%, 5%, 0.5)`;
      ctx.fillRect(minX, maxY - 1.6, w, 1.6);
      // Inner panel-line accent — a thin bright stripe through the panel so the
      // surface reads as plated metal rather than a flat fill.
      const cx = module.vertices.reduce((s, p) => s + p.x, 0) / module.vertices.length * r;
      const cy = module.vertices.reduce((s, p) => s + p.y, 0) / module.vertices.length * r;
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 85%, 0.45)`;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.4, cy);
      ctx.lineTo(cx + r * 0.4, cy);
      ctx.stroke();
      ctx.restore();
    }

    // Crater/mottle pass — a few deterministic craters (seeded from the hue so
    // they're stable) clipped to the panels. Each is a dark pit plus a bright
    // upper-left crescent rim, lit by the same sun. The single strongest "same
    // rock as the boss" cue. Clipped to the union of panels via per-panel clip.
    for (const module of ship.modules) {
      ctx.save();
      tracePanel(module);
      ctx.clip();
      const cx = module.vertices.reduce((s, p) => s + p.x, 0) / module.vertices.length * r;
      const cy = module.vertices.reduce((s, p) => s + p.y, 0) / module.vertices.length * r;
      for (let i = 0; i < 3; i++) {
        const s1 = Math.abs(Math.sin(baseHue * 12.9 + i * 78.2 + cx * 0.7));
        const s2 = Math.abs(Math.sin(baseHue * 39.3 + i * 17.7 + cy * 0.7));
        const s3 = Math.abs(Math.sin(baseHue * 4.41 + i * 91.0));
        const px = cx + (s1 - 0.5) * r * 0.7;
        const py = cy + (s2 - 0.5) * r * 0.7;
        const cr = r * (0.05 + s3 * 0.08);
        ctx.fillStyle = `hsla(${baseHue - 10}, 80%, 5%, 0.55)`;
        ctx.beginPath();
        ctx.arc(px, py, cr, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = `hsla(${baseHue + 20}, 80%, 45%, 0.45)`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(px - cr * 0.25, py - cr * 0.25, cr * 0.85, Math.PI * 0.6, Math.PI * 1.7);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- Phase B: rim light (source-over) ----
    // Two stacked strokes on the panel outlines: a dark outer line that seats
    // the body against the dark backdrop, then a bright inner line that catches
    // the sun — the house-style rim that makes the boss read as solid. Drawn
    // per module so concave hulls keep a crisp edge.
    for (const module of ship.modules) {
      tracePanel(module);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `hsla(${baseHue}, 40%, 5%, 0.9)`;
      ctx.stroke();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = `hsla(${baseHue + 15}, 100%, 78%, 0.95)`;
      ctx.stroke();
    }

    // ---- Phase C: additive energy (lighter) ----
    // Running lights now read as brass power-cores fitted to a solid plate —
    // brass (hue ~48) is the boss eye-aperture colour, the shared family
    // signature marking both as built by the same hand.
    ctx.globalCompositeOperation = "lighter";
    for (const light of ship.lights) {
      const lx = light.pos.x * r;
      const ly = light.pos.y * r;
      const lr = light.size * r * 1.4;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr * 3);
      lg.addColorStop(0, `hsla(48, 100%, 96%, 1)`);
      lg.addColorStop(0.35, `hsla(${baseHue + 10}, 100%, 75%, 0.6)`);
      lg.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `hsla(48, 100%, 98%, 1)`;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 0.6, 0, TAU);
      ctx.fill();
    }

    return canvas;
  }

  computeOutline(): number[] {
    const isClamped = this.kind === "solidCrystal" || this.kind === "solidCrystalSmall" || this.kind === "glassPrison" || this.kind === "bell" || CATHEDRAL_DEBRIS_KINDS.includes(this.kind);
    const samples: number[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      let r = 1;
      for (const harmonic of this.harmonics) {
        r += harmonic.amp * Math.cos(angle * harmonic.freq + harmonic.phase);
      }
      // Crystals + bell run with aggressive harmonic amps to get dramatic
      // shard / wall-chunk silhouettes; clamp so an unlucky phase alignment
      // can't collapse a vertex to (or past) the origin.
      if (isClamped) r = Math.max(0.45, Math.min(1.55, r));
      samples.push(r * this.radius);
    }
    return samples;
  }

  radiusAtAngle(angle: number): number {
    let r = 1;
    for (const harmonic of this.harmonics) {
      r += harmonic.amp * Math.cos(angle * harmonic.freq + harmonic.phase);
    }
    // Mirror the clamp in computeOutline so the collision surface matches
    // the visible silhouette for the high-amp crystal / cathedral harmonics.
    if (this.kind === "solidCrystal" || this.kind === "solidCrystalSmall" || this.kind === "glassPrison" || this.kind === "bell") {
      r = Math.max(0.45, Math.min(1.55, r));
    }
    return r * this.radius;
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    // Dormant boss is intangible during the 8s grow-and-reveal — neither
    // bullets nor the ship can interact with the looming silhouette. The
    // transition to "live" enables both at once on the same frame as the
    // eye opens.
    if (this.isBoss() && this.bossPhase === "dormant") return false;
    const dx = point.x - this.pos.x;
    const dy = point.y - this.pos.y;
    const distance = Math.hypot(dx, dy);
    if (distance > this.radius * 1.3 + pointRadius) return false;
    // Bassteroids are modular silhouettes, not organic blobs — use a tight
    // circle for the hitbox. 0.88 is a feel-tuned shrink so glancing shots
    // miss the gaps between modules instead of registering on empty space.
    if (this.isBass()) return distance < this.radius * 0.88 + pointRadius;
    // Boss planetoid is a round body — circle hitbox at near-full radius.
    // Boss-family fragments use the same circular hitbox at slightly looser
    // radius so all the awkward shard shapes register cleanly.
    if (this.isBoss()) return distance < this.radius * 0.95 + pointRadius;
    if (this.isBossFragment()) return distance < this.radius * 0.92 + pointRadius;
    const localAngle = Math.atan2(dy, dx) - this.rotation;
    const surface = this.radiusAtAngle(localAngle);
    return distance < surface + pointRadius;
  }

  hit() {
    this.flashAmount = 1;
  }

  // Apply `amount` damage to this asteroid. `damageReduction` is subtracted
  // first; a hit that doesn't break through deals no HP loss and reports
  // `bounced` so the caller can deflect the shot instead of consuming it as a
  // real hit. Decrements HP and returns whether it's now dead. Non-killing
  // hits reveal one or more cracks (the number revealed scales with the damage
  // dealt so a 4-damage rhythm hit visibly cracks the asteroid harder than a
  // 1-damage plain hit, even if it didn't kill). Caller is responsible for
  // sound, particles, and split.
  applyDamage(amount: number = 1): { killed: boolean; bounced: boolean; dealt: number } {
    const dealt = Math.max(0, amount - this.damageReduction);
    if (dealt <= 0) return { killed: false, bounced: true, dealt: 0 };
    this.hp = Math.max(0, this.hp - dealt);
    this.flashAmount = 1;
    return { killed: this.hp <= 0, bounced: false, dealt };
  }

  // a non-killing hit should visibly shove the target — fraction of "kill-worth"
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
    addScaledMut(this.pos, this.vel, dt);
    wrapMut(this.pos, w, h);
    // Stamp/age the drone trail (gen-0 large) or radiator (fragments). Done
    // after the wrap so a screen-wrap teleport is caught by Trail's own
    // jump detector and the trail restarts cleanly on the new side. The
    // radiator anchors each wave to its own emission origin, so a wrap
    // simply means future waves emit from the new side while older waves
    // age out where they were — no special-case handling needed.
    if (this.trail) this.trail.update(dt, this.pos.x, this.pos.y);
    if (this.radiator) this.radiator.update(dt, this.pos.x, this.pos.y, this.vel.x, this.vel.y);
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
    // Beat flare decays a touch slower than the hit flash so the visible
    // pulse rides the audio kick all the way through the beat window.
    if (this.beatFlash > 0) this.beatFlash = Math.max(0, this.beatFlash - dt * 2.6);
    if (this.bossTopFlash > 0) this.bossTopFlash = Math.max(0, this.bossTopFlash - dt * 1.6);
    if (this.bossBottomFlash > 0) this.bossBottomFlash = Math.max(0, this.bossBottomFlash - dt * 1.6);
    if (this.bossIrisFlash > 0) this.bossIrisFlash = Math.max(0, this.bossIrisFlash - dt * 1.8);
    if (this.bossPupilFlash > 0) this.bossPupilFlash = Math.max(0, this.bossPupilFlash - dt * 2.4);
    // Whole-body boss reveal: ticks the dormant timer toward revealDuration,
    // then transitions to live. While dormant the asteroid cannot take
    // damage (gateApplyDamage) and the eye cannot fire. Rendering holds a
    // quiet black silhouette for most of the window, then shudders, dusts off
    // its crust, and opens the eye in the trailing revealActiveDuration.
    if (this.isBoss() && this.bossPhase === "dormant") {
      this.bossRevealT += dt;
      if (this.bossRevealT >= ENTITY_CONFIG.boss.revealDuration) {
        this.bossPhase = "live";
        // One-shot edge flag picked up next frame by gameUpdate to play the
        // dissonant eye-open stinger and zero out the player's combo. Cleared
        // after the consumer reads it.
        this.bossJustOpenedEye = true;
        // Reset rhythm state so the first cycle's beat 1 lands wherever
        // game.beatTime currently is, not back-dated to a stale cooldown.
        this.bossRhythmT = 0;
        this.bossDidTop = false;
        this.bossDidBottom = false;
        this.bossDidIris = false;
        this.bossDidPupil1 = false;
        this.bossDidPupil2 = false;
        this.bossPlasmaFired = false;
      }
    }
    // Nucleus orbital drift is baked into the sprite so we no longer rotate
    // it here — the per-frame pulse highlight handles the only visible motion.
  }

  // Update the iris to track the player. Caller (gameUpdate) passes the
  // current ship position so the boss/eye can do its slit-pupil aim. Done
  // outside `update()` because the asteroid module doesn't know about Ship.
  trackPlayer(shipX: number, shipY: number) {
    if (!this.isBoss() && this.kind !== "bossEye") return;
    // Cache for the windup aim slew in tickLaserAim.
    this.bossTrackedShipX = shipX;
    this.bossTrackedShipY = shipY;
    // Seed the locked aim on the first track so the telegraph doesn't slew
    // up from the (0,0) origin on the eye's first live frame.
    if (this.bossEyeAimX === 0 && this.bossEyeAimY === 0) {
      this.bossEyeAimX = shipX;
      this.bossEyeAimY = shipY;
    }
    const target = Math.atan2(shipY - this.pos.y, shipX - this.pos.x);
    // Smoothly slew the iris toward the player along the shorter angular
    // path. Constant lerp factor keeps it from snapping during dodges so the
    // sightline (when a telegraph is up) reads as a deliberate aim.
    let diff = target - this.bossIrisAngle;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    this.bossIrisAngle += diff * 0.18;
    // The worldspace aim point is no longer slewed here — the targeting line
    // snaps to the player on each windup beat inside tickBossRhythm, so it
    // reads as a discrete "re-target" tick rather than a smooth drag.
  }

  // Tick the targeting aim toward the player once per beat across the windup.
  // Beats 4..7 land at t = 1.5, 2.0, 2.5, 3.0 → indices 0..3. On each new
  // beat the aim steps a fixed fraction of the remaining gap toward the
  // player's current position, so the sightline visibly walks onto the player
  // over four discrete ticks and the player can read where the shot commits.
  // Beat 7 (index 3) is the final tick; the aim then holds for the beat-8
  // fire, so juking after the last tick slips the shot. Outside the windup
  // the aim tracks the player each frame so an idle eye still looks alive.
  // `tNow` is the phase within the 8.0s cycle.
  private tickLaserAim(tNow: number) {
    const inWindup = tNow >= 1.5 && tNow < 3.5;
    if (!inWindup) {
      this.bossAimBeatIndex = -1;
      this.bossEyeAimX = this.bossTrackedShipX;
      this.bossEyeAimY = this.bossTrackedShipY;
      return;
    }
    const beatIndex = Math.floor((tNow - 1.5) / 0.5);
    if (beatIndex > this.bossAimBeatIndex) {
      this.bossAimBeatIndex = beatIndex;
      // Step a portion of the way to the player; later ticks close more of the
      // gap so the aim converges and lands tight on the final beat.
      const step = 0.4 + 0.2 * beatIndex;
      this.bossEyeAimX += (this.bossTrackedShipX - this.bossEyeAimX) * step;
      this.bossEyeAimY += (this.bossTrackedShipY - this.bossEyeAimY) * step;
    }
  }

  // Drives a wraith's pursuit, lunge cycle, and writhe phase. Called once
  // per tick from the game loop with dt + ship position + beatTime. Updates
  // velocity in place (capped pursuit + lunge burst when the lunge fires).
  // Returns true on the tick a lunge ignites so the caller can play SFX.
  // The rotation field is overwritten with the gaze angle so the renderer
  // can place eyes along it.
  tickWraith(dt: number, shipX: number, shipY: number, beatTime: number): boolean {
    if (this.kind !== "wraith") return false;
    const cfg = ENTITY_CONFIG.wraith;
    // Emerge fade-in over emergeDuration. While < 1, damage gating + visuals
    // both scale down — the wraith should not feel suddenly there.
    if (this.wraithEmerge < 1) {
      this.wraithEmerge = Math.min(1, this.wraithEmerge + dt / cfg.emergeDuration);
    }
    // Writhe advances steadily; tendril/body deformation reads from it.
    this.writhePhase += dt * 2.2;

    // Gaze direction: always face the ship (for the eyes + lunge vector).
    const dx = shipX - this.pos.x;
    const dy = shipY - this.pos.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const toShipX = dx / dist;
    const toShipY = dy / dist;
    this.rotation = Math.atan2(dy, dx);

    // Beat-aligned lunge cycle. The lunge fires every lungePeriodMeasures
    // bass measures, snapped to the bass grid + a per-wraith offset so
    // multiple wraiths don't all ignite on the same downbeat. Detect the
    // ignition by watching the (shifted) beatTime cross a measure boundary.
    let didLunge = false;
    if (this.lungeActiveT > 0) {
      this.lungeActiveT = Math.max(0, this.lungeActiveT - dt);
    } else if (this.wraithEmerge >= 1) {
      const period = cfg.lungePeriodMeasures * BASS_MEASURE_LENGTH;
      const shifted = beatTime - this.lungePhaseOffset;
      const currentSlot = Math.floor(shifted / period);
      if (this.lungeLastFiredBeat < 0) {
        this.lungeLastFiredBeat = currentSlot;
      } else if (currentSlot > this.lungeLastFiredBeat) {
        this.lungeActiveT = cfg.lungeDuration;
        this.lungeLastFiredBeat = currentSlot;
        didLunge = true;
      }
    }

    // Pursuit acceleration (always-on, capped). Don't start chasing until
    // the wraith has finished emerging — gives the player room to read it.
    if (this.wraithEmerge >= 1) {
      const accel = cfg.pursuitAccel * dt;
      this.vel.x += toShipX * accel;
      this.vel.y += toShipY * accel;
    }
    // Lunge burst: heavy acceleration along the gaze ray while active.
    if (this.lungeActiveT > 0 && this.wraithEmerge >= 1) {
      const burst = cfg.lungeAccel * dt;
      this.vel.x += toShipX * burst;
      this.vel.y += toShipY * burst;
    }
    // Writhe drag: perpendicular sinusoidal nudge that flips sign, making
    // the path slither instead of arrow straight in. Small magnitude so it
    // reads as a body motion rather than wild swerves.
    const perpX = -toShipY;
    const perpY = toShipX;
    const writheStr = Math.sin(this.writhePhase * 0.9) * 30 * dt;
    this.vel.x += perpX * writheStr;
    this.vel.y += perpY * writheStr;

    // Cap pursuit speed unless mid-lunge (a lunge briefly exceeds the cap
    // by design — that's what makes it feel dangerous).
    const maxSpeed = this.lungeActiveT > 0 ? cfg.maxPursuitSpeed * 2.8 : cfg.maxPursuitSpeed;
    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > maxSpeed) {
      const k = maxSpeed / speed;
      this.vel.x *= k;
      this.vel.y *= k;
    }
    return didLunge;
  }

  // Step the 16-beat boss rhythm and return slot events for this tick.
  // beatTime = game.beatTime in seconds. The 8.0s cycle:
  //   beat 1 (t=0.0) top hemisphere flashes (post-break: top fires plasma)
  //   beat 3 (t=1.0) bottom hemisphere flashes (post-break: bottom fires)
  //   beat 4 (t=1.5) laser charge ramp begins + aim locks (4-beat windup)
  //   beat 5 (t=2.0) brass iris ring flashes
  //   beat 7 (t=3.0) pupil flash #1
  //   beat 8 (t=3.5) pupil flash #2 + laser fires
  //   beats 9-16 (t=4.0-8.0) rest, so the laser fires once per 8s block
  // The live whole-body boss runs every slot. Post-break hemispheres run
  // only their assigned half; bossEye runs iris + pupil + laser.
  tickBossRhythm(beatTime: number): {
    topFlash: boolean;
    bottomFlash: boolean;
    irisFlash: boolean;
    pupilFlash: boolean;
    fireLaser: boolean;
    firePlasma: "top" | "bottom" | null;
  } {
    const events = {
      topFlash: false,
      bottomFlash: false,
      irisFlash: false,
      pupilFlash: false,
      fireLaser: false,
      firePlasma: null as null | "top" | "bottom",
    };
    if (!this.isBossLikeRhythmHolder()) return events;
    const CYCLE = 8.0;
    const tPrev = this.bossRhythmT;
    const tNow = beatTime - Math.floor(beatTime / CYCLE) * CYCLE;
    // First time this asteroid joins the rhythm — pre-arm any slots already
    // past in the current cycle so we don't cascade-fire every prior slot
    // at once. Marked by bossRhythmInit; flipped true after the first tick.
    if (!this.bossRhythmInit) {
      this.bossRhythmInit = true;
      this.bossRhythmT = tNow;
      this.bossDidTop = tNow >= 0.0;
      this.bossDidBottom = tNow >= 1.0;
      this.bossDidIris = tNow >= 2.0;
      this.bossDidPupil1 = tNow >= 3.0;
      this.bossDidPupil2 = tNow >= 3.5;
      this.bossPlasmaFired = tNow >= 0.0 && tNow < 1.0 ? false : tNow >= 1.0;
      return events;
    }
    this.bossRhythmT = tNow;
    if (tNow < tPrev) {
      this.bossDidTop = false;
      this.bossDidBottom = false;
      this.bossDidIris = false;
      this.bossDidPupil1 = false;
      this.bossDidPupil2 = false;
      this.bossPlasmaFired = false;
    }
    // 4-beat windup: the telegraph wedge ramps from beat 4 (t=1.5) to the
    // beat-8 fire (t=3.5), giving the player 2s of warning before it commits.
    // After the fire the telegraph drops quickly so it doesn't hang over the
    // live sweep beam.
    if (tNow >= 1.5 && tNow < 3.5) this.bossLaserCharge = (tNow - 1.5) / 2.0;
    else this.bossLaserCharge = Math.max(0, this.bossLaserCharge - 0.16);

    const role = this.bossRhythmRole();
    if (role === "whole" || role === "eye") this.tickLaserAim(tNow);

    if (!this.bossDidTop && tNow >= 0.0) {
      if (role === "whole" || role === "top") {
        this.bossTopFlash = 1;
        events.topFlash = true;
        if (role === "top" && !this.bossPlasmaFired) {
          events.firePlasma = "top";
          this.bossPlasmaFired = true;
        }
      }
      this.bossDidTop = true;
    }
    if (!this.bossDidBottom && tNow >= 1.0) {
      if (role === "whole" || role === "bottom") {
        this.bossBottomFlash = 1;
        events.bottomFlash = true;
        if (role === "bottom" && !this.bossPlasmaFired) {
          events.firePlasma = "bottom";
          this.bossPlasmaFired = true;
        }
      }
      this.bossDidBottom = true;
    }
    if (!this.bossDidIris && tNow >= 2.0) {
      if (role === "whole" || role === "eye") {
        this.bossIrisFlash = 1;
        events.irisFlash = true;
      }
      this.bossDidIris = true;
    }
    if (!this.bossDidPupil1 && tNow >= 3.0) {
      if (role === "whole" || role === "eye") {
        this.bossPupilFlash = 1;
        events.pupilFlash = true;
        // Aim was already locked at the windup start (t=1.5); don't re-snap
        // here or the 4-beat telegraph would lie about the final direction.
      }
      this.bossDidPupil1 = true;
    }
    if (!this.bossDidPupil2 && tNow >= 3.5) {
      if (role === "whole" || role === "eye") {
        this.bossPupilFlash = 1;
        events.pupilFlash = true;
        events.fireLaser = true;
      }
      this.bossDidPupil2 = true;
    }
    return events;
  }

  private isBossLikeRhythmHolder(): boolean {
    if (this.isBoss() && this.bossPhase === "live") return true;
    if (this.kind === "bossHemisphere") return true;
    if (this.kind === "bossEye") return true;
    return false;
  }

  // The whole-body live boss owns every section; a hemisphere owns its
  // half (top = the one whose cut diameter points upward); the detached
  // eye-core owns iris + pupil + laser.
  bossRhythmRole(): "whole" | "top" | "bottom" | "eye" | "none" {
    if (this.isBoss() && this.bossPhase === "live") return "whole";
    if (this.kind === "bossEye") return "eye";
    if (this.kind === "bossHemisphere") {
      const sy = Math.sin(this.bossFragmentAngle);
      return sy <= 0 ? "top" : "bottom";
    }
    return "none";
  }

  // Direction from the iris toward its locked aim point. Used both by the
  // telegraph renderer and by the bullet-spawn so the rendered sightline
  // matches the shot.
  eyeAimAngle(): number {
    const dx = this.bossEyeAimX - this.pos.x;
    const dy = this.bossEyeAimY - this.pos.y;
    return Math.atan2(dy, dx);
  }

  scoreValue(): number {
    if (this.isBoss()) {
      // Boss scoring rewards the sustained engagement: large dwarfs a normal
      // kill, mediums and smalls are still chunky. Combo multiplier applies
      // on top at the call site.
      return ENTITY_CONFIG.boss.score[this.size];
    }
    // Boss fragments inherit the boss score band by tier — hemispheres use
    // the medium boss score, plates/shards/embers use small. The eye-core
    // gets its own bump for being the most dangerous fragment.
    if (this.kind === "bossHemisphere") return ENTITY_CONFIG.boss.score.medium;
    if (this.kind === "bossEye") return ENTITY_CONFIG.boss.eyeScore;
    if (this.kind === "bossPlate" || this.kind === "bossIrisShard" || this.kind === "bossEmber") {
      return ENTITY_CONFIG.boss.score.small;
    }
    // Solid crystal pays out for the bullet budget it absorbs (16 HP / 4 HP).
    if (this.kind === "solidCrystal") return ENTITY_CONFIG.solidCrystal.largeScore;
    if (this.kind === "solidCrystalSmall") return ENTITY_CONFIG.solidCrystal.smallScore;
    if (this.kind === "glassPrison") return ENTITY_CONFIG.glassPrison.score;
    if (this.kind === "wraith") return ENTITY_CONFIG.wraith.score;
    return SIZE_SCORE[this.size];
  }

  isBass(): boolean {
    return this.kind === "bassA" || this.kind === "bassB" || this.kind === "bassC" || this.kind === "bassD";
  }

  isWraith(): boolean { return this.kind === "wraith"; }
  isGlassPrison(): boolean { return this.kind === "glassPrison"; }

  isBoss(): boolean {
    return this.kind === "boss";
  }

  // The level-10 boss fragments after the planetoid breaks: hemispheres,
  // eye core, plates, iris shards, ember. They share the boss hue / scoring
  // / shatter-aesthetic but render and split differently than the whole-body
  // planetoid.
  isBossFragment(): boolean {
    return this.kind === "bossHemisphere" || this.kind === "bossEye"
      || this.kind === "bossPlate" || this.kind === "bossIrisShard" || this.kind === "bossEmber";
  }

  isBossFamily(): boolean {
    return this.isBoss() || this.isBossFragment();
  }

  // `impactDir` is the bullet's velocity direction at the moment of the kill.
  // Falls back to the parent's velocity direction when no impactDir is given
  // (e.g. shockwave splits).
  //
  // Bass/boss splits use a heading-based fan (fragments fly out into the
  // forward hemisphere relative to the impact direction). Regular splits
  // build fragment velocities as `parent_vel + bullet-push + perp-burst`
  // with mass-weighted perpendicular kicks summing to zero — see
  // splitRegular() for the momentum-conservation details.
  //
  // For regular (non-bass, non-boss) *large* asteroids, the optional
  // `impactPos`, `combo`, and `onBeat` inputs steer the breakup pattern:
  //   - A center hit cleanly splits the rock into 2 mediums; a glancing hit
  //     spalls 2 small chips off the struck side while one medium continues
  //     mostly forward along the original trajectory.
  //   - An on-beat hit while combo ≥ 2 pulverises a large into 4 smalls —
  //     the skill-and-rhythm reward for staying in the pocket.
  // Mediums always split into the classic 2-small wedge regardless of hit
  // context.
  split(opts?: { impactDir?: Vec; impactPos?: Vec; combo?: number; onBeat?: boolean }): Asteroid[] {
    const impactDir = opts?.impactDir;
    // Boss whole-body: cracks open into two hemisphere halves + the iris
    // eye-core (3 mediums total, but with distinct identities). Cleavage
    // axis is perpendicular to the killing-shot direction so the bullet
    // visibly "splits the planet in two", and the hemispheres fly out along
    // that perpendicular while the eye drifts forward along the bullet's
    // line of travel.
    if (this.isBoss()) {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      // perpendicular to the bullet: cleavage plane direction
      const cutAxis = baseAngle + Math.PI / 2;
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      // Halves are nearly full-body sized now, so push their spawn centres
      // farther apart and drive them outward harder — they overlap at the
      // instant of the cut and need to clear each other quickly.
      const ejectDist = this.radius * 0.72;
      const fragmentList: Asteroid[] = [];
      // Two hemispheres — one to each side of the cut axis.
      for (let i = 0; i < 2; i++) {
        const sign = i === 0 ? -1 : 1;
        const childAngle = cutAxis + sign * 0.15;
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * ejectDist,
          y: this.pos.y + Math.sin(childAngle) * ejectDist,
        };
        const speedMag = parentSpeed * rand(0.9, 1.3) + 95;
        const hemi = new Asteroid(childPos, fromAngle(childAngle, speedMag), "medium", this.hue, "bossHemisphere");
        // Remember which side of the cut this hemisphere came from so the
        // renderer can paint the flat diameter facing back along the cut
        // axis — that's the freshly-revealed cross-section of the broken
        // planet, with the inner ring laid bare.
        hemi.bossFragmentAngle = cutAxis + (sign === -1 ? Math.PI : 0);
        // Inherit the parent's rhythm position + slot latches so each
        // fragment marches on the same downbeat the whole-body boss was on
        // when it cracked.
        hemi.bossRhythmT = this.bossRhythmT;
        hemi.bossDidTop = this.bossDidTop;
        hemi.bossDidBottom = this.bossDidBottom;
        hemi.bossDidIris = this.bossDidIris;
        hemi.bossDidPupil1 = this.bossDidPupil1;
        hemi.bossDidPupil2 = this.bossDidPupil2;
        hemi.bossPlasmaFired = false;
        hemi.bossRhythmInit = true;
        fragmentList.push(hemi);
      }
      // Eye core — flies forward along the bullet's line, slightly slower
      // than the hemispheres so the player can tell the moving threat from
      // the rubble. Inherits the iris angle so its first telegraphed shot
      // points roughly where it was already aiming.
      const eyePos = {
        x: this.pos.x + Math.cos(baseAngle) * ejectDist * 0.4,
        y: this.pos.y + Math.sin(baseAngle) * ejectDist * 0.4,
      };
      const eyeSpeed = parentSpeed * rand(0.7, 1.0) + 30;
      const eye = new Asteroid(eyePos, fromAngle(baseAngle, eyeSpeed), "medium", this.hue, "bossEye");
      eye.bossIrisAngle = this.bossIrisAngle;
      eye.bossEyeAimX = this.bossEyeAimX;
      eye.bossEyeAimY = this.bossEyeAimY;
      eye.bossRhythmT = this.bossRhythmT;
      eye.bossDidTop = this.bossDidTop;
      eye.bossDidBottom = this.bossDidBottom;
      eye.bossDidIris = this.bossDidIris;
      eye.bossDidPupil1 = this.bossDidPupil1;
      eye.bossDidPupil2 = this.bossDidPupil2;
      eye.bossLaserCharge = this.bossLaserCharge;
      eye.bossRhythmInit = true;
      fragmentList.push(eye);
      return fragmentList;
    }
    // Boss hemisphere: shatters into three modular plate fragments — each
    // a sliver of the equatorial Bassteroid-style ring this hemisphere wore.
    // Each plate carries one of the four bass-hue bands so the rubble paints
    // a recognisable echo of the parent's architecture.
    if (this.kind === "bossHemisphere") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 3; i++) {
        const childAngle = baseAngle + (i - 1) * 0.9 + rand(-0.18, 0.18);
        const speedMag = Math.hypot(this.vel.x, this.vel.y) * rand(1.0, 1.5) + 80;
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * this.radius * 0.4,
          y: this.pos.y + Math.sin(childAngle) * this.radius * 0.4,
        };
        const plate = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, "bossPlate");
        // Distribute the four bass-band hues across the three plates: the
        // hemisphere wore two color rings (each plate gets a distinct one,
        // the third samples a third). Modular indices into BASS_KIND_BASE.
        plate.bossPlateBand = (i + Math.floor(rng() * 2)) % 4;
        fragmentList.push(plate);
      }
      return fragmentList;
    }
    // Boss eye-core: shatters into two iris-crescent shards + one inert
    // ember (the burnt-out pupil). The shards fan opposite the bullet,
    // the ember drifts slowly forward — a final remnant cooling off.
    if (this.kind === "bossEye") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 2; i++) {
        const sign = i === 0 ? -1 : 1;
        const childAngle = baseAngle + sign * 1.4 + rand(-0.15, 0.15);
        const speedMag = Math.hypot(this.vel.x, this.vel.y) * rand(1.1, 1.5) + 90;
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * this.radius * 0.5,
          y: this.pos.y + Math.sin(childAngle) * this.radius * 0.5,
        };
        const shard = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, "bossIrisShard");
        // Track which side of the iris this shard came from so the renderer
        // can draw the brass rim arc on the correct edge.
        shard.bossFragmentAngle = sign === -1 ? -1 : 1;
        fragmentList.push(shard);
      }
      // The ember drifts slowly forward along the impact line — a tiny
      // black sphere with a smouldering core. No firing, no telegraph.
      const emberSpeed = Math.hypot(this.vel.x, this.vel.y) * rand(0.4, 0.7) + 20;
      const ember = new Asteroid({ ...this.pos }, fromAngle(baseAngle, emberSpeed), "small", this.hue, "bossEmber");
      fragmentList.push(ember);
      return fragmentList;
    }
    // Boss small-tier shards are terminal — they break into nothing further.
    if (this.kind === "bossPlate" || this.kind === "bossIrisShard" || this.kind === "bossEmber") {
      return [];
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
        // Broken pieces tumble. Mediums (gen-1) drift with a gentle wobble;
        // smalls (gen-2) — the lightest fragments — spin noticeably faster.
        const spinMag = childSize === "medium" ? rand(0.4, 0.9) : rand(1.4, 2.6);
        child.rotSpeed = spinMag * (rng() < 0.5 ? -1 : 1);
        fragmentList.push(child);
      }
      return fragmentList;
    }
    // Glass prison: shatters into a single wraith born at the prison's
    // centre + a few inert crystal fragments fanning out from the impact.
    // The wraith starts stationary (its tickWraith emerge phase handles the
    // fade-in); the shards fly outward fast so the visual reads as "the
    // prison just broke open and something stepped out".
    if (this.kind === "glassPrison") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const fragmentList: Asteroid[] = [];
      const wraith = new Asteroid({ x: this.pos.x, y: this.pos.y }, v(0, 0), "medium", undefined, "wraith");
      fragmentList.push(wraith);
      // Three small crystal shards as the prison's broken pieces. Reuse the
      // solidCrystalSmall kind so they look like cut glass and ring on hit;
      // they hand the player a small extra payout for cracking the prison.
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      const ejectDist = this.radius * 0.5;
      for (let i = 0; i < 3; i++) {
        const childAngle = baseAngle + (i - 1) * 0.9 + rand(-0.18, 0.18);
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * ejectDist,
          y: this.pos.y + Math.sin(childAngle) * ejectDist,
        };
        const speedMag = parentSpeed * rand(1.0, 1.4) + rand(160, 220);
        const shard = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, "solidCrystalSmall");
        shard.rotSpeed = rand(1.2, 2.4) * (rng() < 0.5 ? -1 : 1);
        fragmentList.push(shard);
      }
      return fragmentList;
    }
    // Wraith: terminal — no split. The escaping puff is handled by
    // particle/sound effects in killEffects.
    if (this.kind === "wraith") return [];
    // Solid crystal: large shatters into 2 fast-moving small crystal
    // fragments fanning around the bullet's heading. Smalls don't split
    // further — they're the terminal tier.
    if (this.kind === "solidCrystal") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      const ejectDist = this.radius * 0.55;
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 2; i++) {
        // Two pieces fanned forward of the impact — neither flying straight
        // back at the shooter.
        const offsets = [-0.7, 0.7];
        const childAngle = baseAngle + offsets[i] + rand(-0.12, 0.12);
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * ejectDist,
          y: this.pos.y + Math.sin(childAngle) * ejectDist,
        };
        // Fast-moving: parent speed + a generous burst kick. Floor ensures
        // even a stationary parent ejects sharp shards.
        const speedMag = parentSpeed * rand(1.1, 1.5) + rand(180, 240);
        const child = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, "solidCrystalSmall");
        child.rotSpeed = rand(1.2, 2.4) * (rng() < 0.5 ? -1 : 1);
        fragmentList.push(child);
      }
      return fragmentList;
    }
    if (this.kind === "solidCrystalSmall") return [];
    // Cathedral ("bell"): doesn't crumble into smaller cathedrals — it breaks
    // into recognisable carved building pieces, the way a bassteroid breaks
    // into ship chunks. A keystone (the wedge that locked an arch), a glowing
    // stained-glass shard, a column drum, and a plain rubble block fan out from
    // the impact. Each is a terminal small. Larger fragments throw more pieces;
    // a small bell throws a representative subset so the read survives at every
    // tier. The mandatory debris is glass + keystone (the iconic pair); column
    // and rubble fill in for bigger breaks.
    if (this.kind === "bell") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      const ejectDist = this.radius * 0.45;
      // Glass + keystone always; add column + rubble as the fragment grows.
      const pieces: AsteroidKind[] =
        this.size === "large" ? ["glassShard", "cathedralKeystone", "columnDrum", "rubbleBlock"]
        : this.size === "medium" ? ["glassShard", "cathedralKeystone", "rubbleBlock"]
        : ["glassShard", "cathedralKeystone"];
      const fragmentList: Asteroid[] = [];
      // Fan the pieces forward of the impact in an even spread so none flies
      // straight back at the shooter.
      const spread = 1.7;
      for (let i = 0; i < pieces.length; i++) {
        const frac = pieces.length === 1 ? 0 : i / (pieces.length - 1) - 0.5;
        const childAngle = baseAngle + frac * spread + rand(-0.12, 0.12);
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * ejectDist,
          y: this.pos.y + Math.sin(childAngle) * ejectDist,
        };
        // Glass shards fly fastest + spin hardest (lightest, sharpest); stone
        // drums and rubble are heavier and tumble more slowly.
        const isGlass = pieces[i] === "glassShard";
        const speedMag = parentSpeed * rand(1.0, 1.4) + (isGlass ? rand(150, 210) : rand(90, 150));
        const child = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, pieces[i]);
        child.rotSpeed = (isGlass ? rand(1.6, 2.8) : rand(0.6, 1.4)) * (rng() < 0.5 ? -1 : 1);
        fragmentList.push(child);
      }
      return fragmentList;
    }
    // Cathedral debris is terminal — carved chunks don't subdivide further.
    if (CATHEDRAL_DEBRIS_KINDS.includes(this.kind)) return [];
    if (this.size === "small") return [];
    return this.splitRegular(opts);
  }

  // Pick a fragment recipe for a non-bass, non-boss kill, with fragment
  // velocities built to respect momentum conservation.
  //
  // Model: each fragment's velocity is
  //   v_frag = v_parent + bulletKick * d̂_bullet + perpKick * n̂
  // where n̂ is perpendicular to the bullet's direction. The mass-weighted
  // sum of perpKicks across fragments is forced to zero so the fragments
  // don't gain net perpendicular momentum out of nowhere; bulletKick
  // accounts for the small forward push the (low-mass, high-speed) bullet
  // imparts to the rubble cloud. Mass lost to dust/vapour just doesn't
  // appear as a fragment — the dust is modelled as drifting at parent
  // velocity, which conserves momentum trivially.
  //
  // Hit-angle bands for large (driven by perpFrac = |perp|/radius):
  //   < 0.35  → "center"   — clean 2-medium split
  //   > 0.7   → "glancing" — 1 medium continues + 2 small chips off struck side
  //   else    → "normal"   — 2-medium wedge
  // Large kills have a flat 1-in-10 chance to pulverise into 4 smalls — rare
  // so it stays a treat. Two flavours, picked 50/50: "line" (four smalls
  // fanned along the perpendicular axis) and "cross" (four smalls at 90°
  // apart around the bullet axis). Both conserve perpendicular momentum.
  // Medium always → 2-small wedge.
  private splitRegular(opts?: { impactDir?: Vec; impactPos?: Vec; combo?: number; onBeat?: boolean }): Asteroid[] {
    const impactDir = opts?.impactDir;
    // Unit bullet-direction d̂ and perpendicular n̂ (rotated +90°, so "left of
    // bullet"). Fall back to parent-velocity direction if no impact info.
    let dx: number, dy: number;
    if (impactDir && (impactDir.x !== 0 || impactDir.y !== 0)) {
      const L = Math.hypot(impactDir.x, impactDir.y);
      dx = impactDir.x / L; dy = impactDir.y / L;
    } else {
      const L = Math.hypot(this.vel.x, this.vel.y) || 1;
      dx = this.vel.x / L; dy = this.vel.y / L;
    }
    const nx = -dy, ny = dx;

    let hitClass: "center" | "normal" | "glancing" = "normal";
    let perpSign = rng() < 0.5 ? -1 : 1;
    if (impactDir && opts?.impactPos) {
      const ox = this.pos.x - opts.impactPos.x;
      const oy = this.pos.y - opts.impactPos.y;
      const perp = ox * nx + oy * ny;
      const perpFrac = Math.abs(perp) / Math.max(1, this.radius);
      if (perpFrac < 0.35) hitClass = "center";
      else if (perpFrac > 0.7) hitClass = "glancing";
      perpSign = perp >= 0 ? 1 : -1;
    }

    // Rare 4-small pulverise: a flat 1-in-10 roll on any large kill. Kept
    // rare so it stays a treat rather than the default outcome.
    const PULVERISE_CHANCE = 0.1;
    const pulverise = rng() < PULVERISE_CHANCE;
    // When the pulverise fires, pick line vs cross 50/50.
    const pulveriseCross = pulverise && rng() < 0.5;

    // Mass units (small = 1, medium = 8, large = 64). Used only for the
    // momentum-balance arithmetic below, not for any other game system.
    const massOf = (s: AsteroidSize): number => (s === "small" ? 1 : s === "medium" ? 8 : 64);

    // Each fragment carries a perpendicular kick (signed, in px/s along n̂)
    // and a forward bullet-kick (in px/s along d̂). The fragment's final
    // velocity is parent_vel + bulletKick * d̂ + perpKick * n̂.
    type FragSpec = { size: AsteroidSize; perpKick: number; bulletKick: number };

    // Speed scale for the perpendicular spray. Calibrated so the visible
    // outward velocity feels like the original heading-fan version, which
    // sat at parentSpeed * ~1.4 at ±0.9 rad. sin(0.9) ≈ 0.78 → perp ≈ 110.
    // We use a fixed budget (not parent-speed-scaled) so a slow rock still
    // visibly bursts when hit and a fast one doesn't catapult absurdly.
    const PERP_BURST = 110;

    // Bullet's forward push on the rubble. Small but non-zero — the rubble
    // cloud's centre-of-mass picks up a touch of the bullet's momentum.
    const BULLET_PUSH = 50;

    let specs: FragSpec[];
    if (this.size === "large" && this.kind === "goldCrystal") {
      // Gold-crystal large drops the embedded crystal pickup as its primary
      // payload (handled by killEffects), and only spits out a small handful
      // of fragments instead of the usual 2-medium / 4-small patterns. The
      // recipe is rolled 50/50:
      //   "trio" → 3 smalls fanning out (Σ perp = 0 by symmetry).
      //   "pair" → 1 small + 1 medium (mass-weighted Σ perp = 0; medium
      //            counter-recoils at 1/8 of the small's perp kick).
      // Both conserve momentum within the perpendicular axis and apply the
      // usual forward bullet push to the cloud's centre of mass.
      const trio = rng() < 0.5;
      if (trio) {
        // 3 smalls: symmetric around the bullet axis. One straight forward
        // (perp = 0), two flanking at ±PERP. Forward push spread so the
        // forward chip doesn't stack on top of the flanks.
        specs = [
          { size: "small", perpKick: -PERP_BURST, bulletKick: BULLET_PUSH * 0.9 },
          { size: "small", perpKick: 0,           bulletKick: BULLET_PUSH * 1.4 },
          { size: "small", perpKick: PERP_BURST,  bulletKick: BULLET_PUSH * 0.9 },
        ];
      } else {
        // 1 small + 1 medium: small kicks hard sideways, medium counter-
        // recoils at 1/8 of the small's perp magnitude (8 = mass ratio).
        const smallSign = rng() < 0.5 ? -1 : 1;
        const smallPerp = smallSign * PERP_BURST * 1.25;
        const medPerp = -smallPerp / massOf("medium");
        specs = [
          { size: "small",  perpKick: smallPerp, bulletKick: BULLET_PUSH * 1.1 },
          { size: "medium", perpKick: medPerp,   bulletKick: BULLET_PUSH * 0.7 },
        ];
      }
    } else if (this.size === "large") {
      if (pulverise && pulveriseCross) {
        // 4 small in a cross: four equal-mass fragments at 90° apart around the
        // bullet axis. The four perp/forward kicks sum to zero in the burst
        // frame, so parent momentum is preserved. A uniform forward bullet-push
        // shifts the rubble cloud's centre of mass slightly along the bullet
        // direction (same intent as BULLET_PUSH in the other branches).
        // Rotate the cross by 45° off the bullet axis so no fragment flies
        // straight back at the shooter.
        const crossSpeed = PERP_BURST * 1.15;
        specs = [
          { size: "small", perpKick:  crossSpeed * Math.SQRT1_2, bulletKick: BULLET_PUSH + crossSpeed * Math.SQRT1_2 },
          { size: "small", perpKick:  crossSpeed * Math.SQRT1_2, bulletKick: BULLET_PUSH - crossSpeed * Math.SQRT1_2 },
          { size: "small", perpKick: -crossSpeed * Math.SQRT1_2, bulletKick: BULLET_PUSH + crossSpeed * Math.SQRT1_2 },
          { size: "small", perpKick: -crossSpeed * Math.SQRT1_2, bulletKick: BULLET_PUSH - crossSpeed * Math.SQRT1_2 },
        ];
      } else if (pulverise) {
        // 4 small in a line: symmetric ±k, ±3k pattern (mass-weighted perp
        // sums to 0). All four fragments share the same forward bullet-push,
        // so they spread out along the perpendicular axis.
        specs = [
          { size: "small", perpKick: -PERP_BURST * 1.6, bulletKick: BULLET_PUSH },
          { size: "small", perpKick: -PERP_BURST * 0.55, bulletKick: BULLET_PUSH },
          { size: "small", perpKick: PERP_BURST * 0.55, bulletKick: BULLET_PUSH },
          { size: "small", perpKick: PERP_BURST * 1.6, bulletKick: BULLET_PUSH },
        ];
      } else if (hitClass === "glancing") {
        // Two small chips fly off the struck side (the centre lies perpSign-ward
        // of the bullet path, so the bullet hits the -perpSign edge). The
        // medium must counter-recoil to the perpSign side to conserve
        // perpendicular momentum.
        //   Σ m_i * perpKick_i = 0
        //   8 * v_med + 1 * v_c1 + 1 * v_c2 = 0
        // With v_c1 = -perpSign * 1.3 * PERP and v_c2 = -perpSign * 0.85 * PERP
        // (both chips off the struck side, the bullet-direction chip kicked
        // harder), v_med = perpSign * (1.3 + 0.85) / 8 * PERP ≈ 0.27 * PERP.
        const chipSign = -perpSign;
        const c1 = chipSign * 1.3 * PERP_BURST;
        const c2 = chipSign * 0.85 * PERP_BURST;
        const vMed = -(c1 + c2) / massOf("medium");
        specs = [
          { size: "medium", perpKick: vMed, bulletKick: BULLET_PUSH * 0.4 },
          { size: "small",  perpKick: c1,   bulletKick: BULLET_PUSH * 1.2 },
          { size: "small",  perpKick: c2,   bulletKick: BULLET_PUSH * 1.1 },
        ];
      } else {
        // Center / normal: symmetric 2-medium wedge, equal opposite perp kicks.
        specs = [
          { size: "medium", perpKick: -PERP_BURST, bulletKick: BULLET_PUSH },
          { size: "medium", perpKick:  PERP_BURST, bulletKick: BULLET_PUSH },
        ];
      }
    } else {
      // Medium → 2 small symmetric wedge.
      specs = [
        { size: "small", perpKick: -PERP_BURST, bulletKick: BULLET_PUSH },
        { size: "small", perpKick:  PERP_BURST, bulletKick: BULLET_PUSH },
      ];
    }

    const fragmentList: Asteroid[] = [];
    // Gold-crystal fragments are just plain rock chunks — the embedded
    // crystal was the payload, and it's been ejected as a pickup elsewhere.
    // Don't propagate the "goldCrystal" kind to children or we'd cascade.
    const childKind: AsteroidKind = this.kind === "goldCrystal" ? "normal" : this.kind;
    for (const spec of specs) {
      // Apply jitter to perp kick only (forward kick is small enough that
      // jitter on it is just noise). Keep jitter small relative to PERP_BURST
      // so the conservation arithmetic above isn't drowned out.
      const perpJ = spec.perpKick + rand(-12, 12);
      const fk = spec.bulletKick;
      const vx = this.vel.x + fk * dx + perpJ * nx;
      const vy = this.vel.y + fk * dy + perpJ * ny;
      fragmentList.push(new Asteroid({ ...this.pos }, { x: vx, y: vy }, spec.size, this.hue, childKind));
    }
    return fragmentList;
  }

  render(ctx: CanvasRenderingContext2D, t: number, comboHalo?: { intensity: number; beatPulse: number }) {
    if (this.isBoss()) {
      // Dormant boss draws the swelling planetoid silhouette + the slow
      // architecture reveal; live boss draws the fully-built body with the
      // tracking eye and any in-progress fire telegraph.
      if (this.bossPhase === "dormant") this.renderBossDormant(ctx, t);
      else this.renderBossLive(ctx, t);
      return;
    }
    if (this.kind === "bossHemisphere") { this.renderBossHemisphere(ctx, t); return; }
    if (this.kind === "bossEye") { this.renderBossEye(ctx, t); return; }
    if (this.kind === "bossPlate") { this.renderBossPlate(ctx, t); return; }
    if (this.kind === "bossIrisShard") { this.renderBossIrisShard(ctx, t); return; }
    if (this.kind === "bossEmber") { this.renderBossEmber(ctx, t); return; }
    if (this.kind === "wraith") { this.renderWraith(ctx, t); return; }
    if (this.isBass()) {
      this.renderBass(ctx, t, comboHalo);
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

    // Glass prison: live eye-glow pulse over the baked silhouette. Two faint
    // red pinpricks where the captive's eyes sit, breathing in and out so the
    // figure inside reads as "alive, watching". Drawn additive so it brightens
    // through the void without flattening the frosted facets.
    if (this.kind === "glassPrison") {
      const eyePulse = 0.55 + 0.45 * Math.sin(time * 1.6 + this.membranePhase);
      const eyeY = -this.radius * 0.30;
      const eyeX = this.radius * 0.055;
      const glowR = this.radius * 0.22 * (0.7 + 0.3 * eyePulse);
      ctx.globalCompositeOperation = "lighter";
      drawGlow(ctx, -eyeX, eyeY, glowR, 0, 0.55 * eyePulse);
      drawGlow(ctx,  eyeX, eyeY, glowR, 0, 0.55 * eyePulse);
      ctx.globalAlpha = 1;
      // Tight bright pupil dots over the glow so the gaze has a centre.
      ctx.fillStyle = `hsla(8, 100%, 80%, ${0.85 * eyePulse})`;
      ctx.beginPath();
      ctx.arc(-eyeX, eyeY, 1.2, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc( eyeX, eyeY, 1.2, 0, TAU);
      ctx.fill();
    }

    const isPlain = this.kind === "normal" || this.kind === "goldCrystal";
    const nSat = isPlain ? 6 : 100;
    // Bell asteroid + its carved debris are baked architectural sprites —
    // drifting bioluminescent nuclei would read as bright pinpricks floating
    // on a stone wall.
    const isArchitectural = this.kind === "bell" || CATHEDRAL_DEBRIS_KINDS.includes(this.kind);
    if (!isArchitectural) {
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

  // Wraith renderer — fully live-painted. The whole point of this entity is
  // motion that "shouldn't be possible", so a baked sprite would defeat it.
  // Layered approach: outer aura → 3 drifting noisy silhouettes at different
  // writhe phases (the "ghost in multiple film exposures" read) → wispy
  // tendrils extruding outward → eyes tracking the ship. Hue shifts from
  // deep violet (idle) toward red while lunging.
  private renderWraith(ctx: CanvasRenderingContext2D, t: number) {
    const time = t * 0.001;
    const phase = this.writhePhase;
    const emerge = this.wraithEmerge;
    // Lunge mix: smooth 0→1 by how active the lunge is. Drives hue shift
    // toward red and brightens the eyes.
    const lungeCfg = ENTITY_CONFIG.wraith;
    const lungeMix = lungeCfg.lungeDuration > 0
      ? Math.min(1, Math.max(0, this.lungeActiveT / lungeCfg.lungeDuration))
      : 0;
    const hue = this.hue + (0 - this.hue) * lungeMix * 0.35;
    const R = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.globalCompositeOperation = "lighter";

    // (1) Outer aura — dim purple haze, larger than the body. Sells the
    // "this thing has a presence around it" read without using shadowBlur.
    const auraAlpha = 0.28 * emerge * (0.7 + 0.3 * Math.sin(phase * 0.7));
    drawGlow(ctx, 0, 0, R * 2.6, hue, auraAlpha);
    ctx.globalAlpha = 1;

    // (2) Three drifting noisy body layers. Each layer is a closed wobble
    // polygon, offset in phase + tinted at a different lightness, so the
    // body reads as "ghost in multiple exposures". The polygons are drawn
    // around a base radius modulated by sin-harmonics of `phase`.
    const layers: Array<{ phaseOff: number; rMul: number; alpha: number; lightness: number }> = [
      { phaseOff: 0.0, rMul: 1.00, alpha: 0.45, lightness: 22 },
      { phaseOff: 1.3, rMul: 0.85, alpha: 0.35, lightness: 32 },
      { phaseOff: 2.6, rMul: 0.72, alpha: 0.30, lightness: 44 },
    ];
    const wobbleSamples = 24;
    for (const layer of layers) {
      ctx.fillStyle = `hsla(${hue}, 75%, ${layer.lightness}%, ${layer.alpha * emerge})`;
      ctx.beginPath();
      for (let i = 0; i < wobbleSamples; i++) {
        const a = (i / wobbleSamples) * TAU;
        // 3-fold + 5-fold deformation with phase offset per layer gives each
        // layer its own "breathing" rhythm.
        const dist = R * layer.rMul * (
          1
          + 0.18 * Math.sin(a * 3 + phase + layer.phaseOff)
          + 0.10 * Math.sin(a * 5 - phase * 1.3 + layer.phaseOff)
          + 0.05 * Math.cos(a * 7 + phase * 0.6)
        );
        const x = Math.cos(a) * dist;
        const y = Math.sin(a) * dist;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }

    // (3) Tendrils — wispy extrusions per stored phase offset. Length
    // oscillates so they look like reaching limbs. Drawn as tapered lines
    // (thicker near the body, thin at the tip) using a small gradient stroke
    // approximation: draw segments with decreasing alpha + width.
    const tendrilSegments = 6;
    for (const baseAngle of this.wraithTendrils) {
      const a = baseAngle + Math.sin(phase * 0.4 + baseAngle) * 0.25;
      // Length ramps with lungeMix — tendrils extend during a lunge.
      const lengthMul = 0.95 + 0.55 * Math.sin(phase * 0.8 + baseAngle * 1.3) + lungeMix * 0.6;
      const length = R * lengthMul;
      for (let s = 0; s < tendrilSegments; s++) {
        const f0 = s / tendrilSegments;
        const f1 = (s + 1) / tendrilSegments;
        // Curl: each segment offset slightly perpendicular to the tendril
        // axis, growing with distance from the body. Curl direction flips
        // with phase so the tendril wriggles instead of holding a static curve.
        const curl0 = Math.sin(phase + baseAngle + f0 * 3.0) * R * 0.18 * f0;
        const curl1 = Math.sin(phase + baseAngle + f1 * 3.0) * R * 0.18 * f1;
        const r0 = R * 0.85 + f0 * length;
        const r1 = R * 0.85 + f1 * length;
        const px = Math.cos(a) * r0 - Math.sin(a) * curl0;
        const py = Math.sin(a) * r0 + Math.cos(a) * curl0;
        const qx = Math.cos(a) * r1 - Math.sin(a) * curl1;
        const qy = Math.sin(a) * r1 + Math.cos(a) * curl1;
        const segAlpha = (1 - f0) * 0.55 * emerge;
        ctx.strokeStyle = `hsla(${hue + 8}, 80%, ${50 - f0 * 30}%, ${segAlpha})`;
        ctx.lineWidth = (1 - f0) * 3.2 + 0.3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(qx, qy);
        ctx.stroke();
      }
    }

    // (4) Inner dark heart — a small near-black pit at centre. Without this
    // the wraith reads as a soft cloud; the dark core makes it feel hollow.
    const heartR = R * 0.35;
    const heartGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, heartR);
    heartGrad.addColorStop(0, `hsla(${hue - 10}, 90%, 4%, 0.85)`);
    heartGrad.addColorStop(1, `hsla(${hue}, 80%, 8%, 0)`);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = heartGrad;
    ctx.beginPath();
    ctx.arc(0, 0, heartR, 0, TAU);
    ctx.fill();

    // (5) Eyes — two pinpricks tracking the ship. The local-space angle was
    // resolved in update() and stored on `rotation`; we just place the eyes
    // along that direction. Brighter, redder, larger while lunging.
    const gazeX = Math.cos(this.rotation) * R * 0.18;
    const gazeY = Math.sin(this.rotation) * R * 0.18;
    const perpX = -Math.sin(this.rotation) * R * 0.10;
    const perpY =  Math.cos(this.rotation) * R * 0.10;
    const eyeHue = 286 - lungeMix * 280;  // violet → red
    const eyeBright = 0.6 + 0.4 * Math.sin(time * 5 + phase) + lungeMix * 0.8;
    const eyeR = R * 0.18 * (0.6 + 0.4 * eyeBright);
    ctx.globalCompositeOperation = "lighter";
    drawGlow(ctx, gazeX + perpX, gazeY + perpY, eyeR, eyeHue, 0.7 * eyeBright * emerge);
    drawGlow(ctx, gazeX - perpX, gazeY - perpY, eyeR, eyeHue, 0.7 * eyeBright * emerge);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `hsla(${eyeHue}, 100%, 90%, ${0.95 * emerge})`;
    ctx.beginPath();
    ctx.arc(gazeX + perpX, gazeY + perpY, 1.4, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(gazeX - perpX, gazeY - perpY, 1.4, 0, TAU);
    ctx.fill();

    // (6) Hit flash — same approach as the standard render, but in the
    // wraith's body-tint so the flash feels of-a-piece with the entity.
    if (this.flashAmount > 0) {
      ctx.globalCompositeOperation = "lighter";
      drawGlow(ctx, 0, 0, R * 1.6, hue + 20, this.flashAmount * 0.45);
      ctx.globalAlpha = 1;
    }

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

  // Combo-halo outline: the boundary of the union of every module polygon,
  // each inflated outward by gapPx with sharp mitered corners. Tracing the
  // union (rather than each module) drops the interior shared edges that used
  // to criss-cross multi-module rocks, while still following the true outer
  // perimeter exactly — every concave notch and sharp corner preserved.
  // Pixel-space (already × radius); served from the shared shape cache so the
  // O(edges²) clip runs once per distinct shape, never per frame.
  buildHaloOutline(gapPx: number): { x: number; y: number }[][] {
    if (!this.bassShip) return [];
    return getHaloOutline(this.bassShip, this.radius, gapPx);
  }

  // Trace the cached combo-halo outline into the current path (local space,
  // caller already translated/rotated). The shape cache means the offset
  // polygons are computed once per (geometry, radius, gap) and reused.
  traceHaloOutline(ctx: CanvasRenderingContext2D) {
    if (!this.haloOutline) this.haloOutline = this.buildHaloOutline(BASS_HALO_GAP_PX);
    ctx.beginPath();
    for (const poly of this.haloOutline) {
      for (let i = 0; i < poly.length; i++) {
        if (i === 0) ctx.moveTo(poly[i].x, poly[i].y);
        else ctx.lineTo(poly[i].x, poly[i].y);
      }
      ctx.closePath();
    }
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
  renderBass(ctx: CanvasRenderingContext2D, t: number, comboHalo?: { intensity: number; beatPulse: number }) {
    const baseHue = this.hue;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // Breathing corona — the boss's slow living-planet pulse, given to the
    // bassteroids so they're never inert between beats. One cached glow-sprite
    // blit (no per-frame gradient), drawn behind the body so it reads as the
    // rock's own aura. Same breath math as the boss corona.
    {
      const breath = 0.5 + 0.5 * Math.sin(t * 0.0018 + this.pos.x * 0.01);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      drawGlow(ctx, 0, 0, this.radius * (1.4 + 0.12 * breath), baseHue, 0.1 + 0.06 * breath);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

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
      this.tracePath(ctx, outerScale);
      ctx.fill();

      const innerScale = 1.25 + 0.18 * a;
      ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 90%, ${0.95 * a})`;
      ctx.lineWidth = 2.4 + 2.6 * a;
      this.tracePath(ctx, innerScale);
      ctx.stroke();
      ctx.restore();
    }

    // A small scale-up on the beat (cosmetic only — collisions still use
    // this.radius). Capped low enough that the bassteroid doesn't appear to
    // grow into the player's path during a rhythm window.
    const beatScale = 1 + 0.06 * this.beatFlash;
    ctx.scale(beatScale, beatScale);
    ctx.globalCompositeOperation = "lighter";

    // Combo halo: at 4+ rhythm (ship halo tier 2) every bassteroid wears the
    // same gold beat-pulsing outline the ship does, shifting to white at 12+
    // (tier 3) — same hue/sat/light/alpha math as shipComboHalo.paintActiveHalo,
    // gated by tier2 so it only exists once the ship halo has turned gold.
    // Eased by the ship's comboHaloIntensity so it ignites and fades in
    // lockstep with the ship's own halo. Traced on the bassteroid's silhouette
    // (just outside the hull) so it reads as the rock joining the combo, not a
    // HUD ring.
    if (comboHalo) {
      const tier2 = Math.max(0, Math.min(1, comboHalo.intensity - 1));
      const tier3 = Math.max(0, Math.min(1, comboHalo.intensity - 2));
      if (tier2 > 0.001) {
        const hue = 195 + (45 - 195) * tier2;
        const sat = 100 * (1 - tier3);
        const flash = this.beatFlash;

        // Shimmer: a low-amplitude twinkle on the resting line so the halo is
        // never perfectly static. Two incommensurate sines (one slow drift,
        // one faster glint that travels via the phase term) keep it from
        // reading as a single throb.
        const shimmer =
          0.5 +
          0.5 * (0.6 * Math.sin(t * 0.0021 + this.beatPhase * 7) +
                 0.4 * Math.sin(t * 0.0047 + this.pos.x * 0.03));

        // Warm-up: in the last slice of the beat interval the rim tightens and
        // brightens — a held breath before the downbeat. Eased so it ramps in
        // gently over the final ~22% rather than snapping on.
        const WARMUP_FROM = 0.78;
        const warm =
          this.beatPhase > WARMUP_FROM
            ? Math.pow((this.beatPhase - WARMUP_FROM) / (1 - WARMUP_FROM), 1.6)
            : 0;

        // Resting line is faint now; the on-beat flash, the warm-up and the
        // shimmer are what carry it. beatFlash still whites it out on the hit.
        const light = Math.min(100, 70 + (100 - 70) * tier3 + 22 * flash + 12 * warm);
        const alpha =
          (0.22 + 0.12 * comboHalo.beatPulse + 0.08 * shimmer + 0.5 * flash + 0.2 * warm) * tier2;

        // Expanding soundwave: on the beat, a copy of the perimeter blooms
        // outward and fades. beatFlash decays from 1, so (1 - flash) is the
        // wave's age — it starts tight on the rim and rides out to ~1.5×.
        if (flash > 0.001) {
          const age = 1 - flash;
          const ringScale = 1 + 0.5 * age;
          ctx.save();
          ctx.scale(ringScale, ringScale);
          this.traceHaloOutline(ctx);
          ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${0.45 * flash * tier2})`;
          ctx.lineWidth = Math.max(1, this.radius * 0.05) / ringScale;
          ctx.stroke();
          ctx.restore();
        }

        // The bassteroid body is a big bright additive sprite, so a hairline
        // stroke vanishes against it — the halo carries its own glow. Same
        // path stroked twice: a wide faint aura pass, a narrow bright rim pass
        // (the trick the beat flare uses instead of shadowBlur). Both widen on
        // the beat and the warm-up so the anticipation reads as a bloom.
        const w = Math.max(1, this.radius * 0.04);
        this.traceHaloOutline(ctx);
        ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${Math.min(100, light - 10)}%, ${(0.3 + 0.2 * flash + 0.15 * warm) * alpha})`;
        ctx.lineWidth = w * (2.4 + 2.4 * flash + 1.2 * warm);
        ctx.stroke();
        ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
        ctx.lineWidth = w * (1 + 0.3 * warm);
        ctx.stroke();
      }
    }

    if (this.sprite) {
      ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);
    }

    // Live rim shimmer — a faint additive glint travelling along the baked rim,
    // driven by the same incommensurate-sines used by the combo halo and the
    // boss rim, so boss and bassteroid edges glint in one shared rhythm. The
    // baked rim (Phase B of the sprite) is the resting line; this rides on top.
    {
      const shimmer =
        0.5 +
        0.5 * (0.6 * Math.sin(t * 0.0021 + this.beatPhase * 7) +
               0.4 * Math.sin(t * 0.0047 + this.pos.x * 0.03));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      this.tracePath(ctx, 1);
      ctx.strokeStyle = `hsla(${baseHue + 18}, 100%, 82%, ${0.1 + 0.16 * shimmer})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }

    this.renderCracks(ctx);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 95%, ${this.flashAmount * 0.32})`;
      this.tracePath(ctx, 1.05);
      ctx.fill();
    }

    ctx.restore();
  }

  // Boss eased reveal curve. 0 → 1 over the 8s dormant window, with a
  // Two-phase dormant intro keyed off absolute seconds:
  //   quiet  (all but the last revealActiveDuration s): a black, subdued
  //          silhouette slowly swelling toward full size — reads as part of
  //          the background. No architecture, no colour, no motion.
  //   active (the final revealActiveDuration s): the planetoid shudders,
  //          dusts its crust off to expose the boss architecture, makes its
  //          final swell to full radius, and the eye begins to crack. The eye
  //          barely parts for most of this window, then snaps fully open over
  //          the last 100ms.
  // Returns: swellT (0..1 body size), revealT (0..1 architecture visibility),
  // shudder (0..1 shake intensity), dust (0..1 crust-shedding amount), and
  // lidOpen (0..1 eye-open progress).
  bossDormantPhase(): { swellT: number; revealT: number; shudder: number; dust: number; lidOpen: number } {
    const total = Math.max(0.001, ENTITY_CONFIG.boss.revealDuration);
    const active = Math.min(total, ENTITY_CONFIG.boss.revealActiveDuration);
    const elapsed = this.bossRevealT;
    const activeStart = total - active;
    // Seconds into the active window (negative while still quiet).
    const aS = elapsed - activeStart;
    // 0..1 progress through the active window.
    const a = Math.max(0, Math.min(1, aS / active));

    // Quiet swell: slow creep from the planet's last silhouette size up to
    // ~88% across the whole long approach. Background-like, never hurried.
    const quietProgress = Math.min(1, elapsed / activeStart);
    const quietSwell = quietProgress * 0.88;
    // Active swell: finish from 88% to full over the active window, eased so
    // the body settles into its final size rather than lurching.
    const activeSwell = a * a * (3 - 2 * a) * 0.12;
    const swellT = aS < 0 ? quietSwell : 0.88 + activeSwell;

    // Architecture only resolves during the active window — before that the
    // body is a pure black disc. Ramps in over the first ~70% of the window
    // (the dust-off) and is fully painted before the eye snaps open.
    const revealT = aS < 0 ? 0 : Math.min(1, a / 0.7);

    // Shudder ramps up across the active window (quadratic so it builds), so
    // the planetoid trembles harder the closer it is to waking.
    const shudder = aS < 0 ? 0 : a * a;
    // Dust sheds most heavily in the first half of the active window as the
    // crust breaks away, then tapers as the architecture stands revealed.
    const dust = aS < 0 ? 0 : Math.sin(Math.min(1, a * 1.3) * Math.PI);

    // Eye: barely cracks for most of the active window (creeps to ~0.14),
    // then snaps fully open over the last 100ms, smoothly continuing from the
    // partly-open form rather than jumping.
    const snapWindow = 0.1; // seconds of the final fast open
    const sliver = 0.08;    // how far the eye barely cracks before the snap
    const secsLeft = total - elapsed;
    let lidOpen: number;
    if (aS < 0) {
      lidOpen = 0;
    } else if (secsLeft > snapWindow) {
      // Slow creep to a bare sliver across the whole active window.
      lidOpen = sliver * a;
    } else {
      // Final 100ms: smoothstep from the sliver to fully open, continuing
      // smoothly from the partly-cracked form rather than jumping.
      const s = Math.max(0, Math.min(1, 1 - secsLeft / snapWindow));
      const eased = s * s * (3 - 2 * s);
      lidOpen = sliver + (1 - sliver) * eased;
    }
    return { swellT, revealT, shudder, dust, lidOpen };
  }

  // Render the dormant whole-body boss: a swelling planet silhouette that
  // gradually reveals modular architecture as it rotates. Mimics the
  // background-planet renderer (dark disc + faint rim) at the start so the
  // hand-off from background planet → boss is seamless.
  renderBossDormant(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const phase = this.bossDormantPhase();
    const r = this.radius * (0.42 + 0.58 * phase.swellT);

    ctx.save();
    // Shudder: as the planetoid wakes it trembles in place, harder the closer
    // it is to bursting. Pure cosmetic jitter — collisions are off while
    // dormant. A fast wobble plus a coarse per-frame kick so it reads as a
    // strained rumble, not a smooth orbit.
    let shakeX = 0, shakeY = 0;
    if (phase.shudder > 0.001) {
      const amp = phase.shudder * 6;
      shakeX = Math.sin(t * 0.05) * amp * 0.5 + (rng() - 0.5) * amp;
      shakeY = Math.cos(t * 0.061) * amp * 0.5 + (rng() - 0.5) * amp;
    }
    ctx.translate(this.pos.x + shakeX, this.pos.y + shakeY);

    // Soft outer corona — invisible during the quiet black approach, blooms
    // only as the architecture is dusted off in the active window.
    if (phase.revealT > 0.001) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const coronaA = 0.05 + 0.18 * phase.revealT;
      const coronaR = r * (1.25 + 0.18 * phase.revealT);
      const corona = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, coronaR);
      corona.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${coronaA * 0.5})`);
      corona.addColorStop(0.55, `hsla(${baseHue - 8}, 100%, 45%, ${coronaA * 0.25})`);
      corona.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
      ctx.fillStyle = corona;
      ctx.beginPath();
      ctx.arc(0, 0, coronaR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Dark silhouette body — matches the background planet's near-black so the
    // quiet phase reads as part of the backdrop, not a thing to shoot. Stays
    // essentially black until the reveal window, when it lifts toward a faintly
    // lit body.
    ctx.save();
    const dark = 1 + phase.revealT * 11;
    const sat = 90 - phase.revealT * 20;
    ctx.fillStyle = `hsl(${baseHue}, ${sat}%, ${dark}%)`;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Crust shedding — chunks of the dark exterior flake off and drift outward
    // during the dust-off, exposing the architecture beneath. Deterministic
    // per chunk so they stream consistently; driven by `dust`.
    if (phase.dust > 0.001) this.paintBossDustOff(ctx, r, phase.dust, phase.revealT, t);

    // Architecture: clipped to the disc, alpha climbing with revealT so the
    // body stays a clean black silhouette until the crust breaks away.
    if (phase.revealT > 0.001) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.clip();

      // Equatorial Bassteroid-style ring of plated panels — four hue bands
      // (red/amber/blue/violet) span the visible arc. Modeled as a wide
      // horizontal band across the body, clipped by the disc so the curved
      // limb cuts the bottom and top of the band.
      const bandHeight = r * 0.42;
      const bassHues = [0, 28, 215, 290];
      const panelCount = 14;
      for (let i = 0; i < panelCount; i++) {
        const u = i / panelCount;
        const x0 = -r * 1.2 + u * r * 2.4;
        const x1 = -r * 1.2 + (u + 1 / panelCount) * r * 2.4;
        const hueBand = bassHues[Math.floor(u * 4) % 4];
        const panel = ctx.createLinearGradient(0, -bandHeight, 0, bandHeight);
        const a = 0.55 * phase.revealT;
        panel.addColorStop(0, `hsla(${hueBand}, 60%, 18%, ${a * 0.7})`);
        panel.addColorStop(0.45, `hsla(${hueBand}, 75%, 30%, ${a})`);
        panel.addColorStop(0.55, `hsla(${hueBand}, 75%, 22%, ${a})`);
        panel.addColorStop(1, `hsla(${hueBand}, 60%, 10%, ${a * 0.7})`);
        ctx.fillStyle = panel;
        ctx.fillRect(x0, -bandHeight, x1 - x0, bandHeight * 2);
        // Plate seam
        ctx.strokeStyle = `hsla(${hueBand + 20}, 100%, 80%, ${0.55 * phase.revealT})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, -bandHeight);
        ctx.lineTo(x1, bandHeight);
        ctx.stroke();
      }

      // Polar caps (north + south) — darker hex-paneled lids stitched on
      // top of the ring. Just a darker fill with one bright rim arc on the
      // ring-facing edge.
      for (const sign of [-1, 1]) {
        ctx.fillStyle = `hsla(${baseHue}, 70%, 10%, ${0.7 * phase.revealT})`;
        ctx.beginPath();
        ctx.ellipse(0, sign * r * 0.55, r * 1.1, r * 0.5, 0, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = `hsla(${baseHue + 10}, 100%, 55%, ${0.5 * phase.revealT})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(0, sign * r * 0.55, r * 1.1, r * 0.5, 0, 0, TAU);
        ctx.stroke();
      }

      // Closed-eye seam: a thin horizontal canyon across the equator where
      // the lid will part. Just a faint dark line while shut; the actual
      // opening is drawn un-rotated below so the eye faces the camera.
      const seamGlow = 0.3 * phase.revealT * (1 - phase.lidOpen);
      ctx.strokeStyle = `hsla(${baseHue}, 100%, 30%, ${seamGlow})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-r * 0.75, 0);
      ctx.lineTo(r * 0.75, 0);
      ctx.stroke();

      ctx.restore();
    }

    // ---- Eye-opening: armored lids part to reveal the iris ----
    // Drawn un-rotated (the eye opens square to the camera). The two lids are
    // armored shutters covering the aperture; as lidOpen ramps they slide
    // apart vertically — upper lid retracts up, lower lid drops down —
    // uncovering a vesica-shaped gap that the brass aperture + iris fill.
    if (phase.lidOpen > 0.001) this.paintBossEyeOpening(ctx, r, phase.lidOpen, t);

    // Outline rim — fully absent during the quiet silhouette so the body has no
    // edge to give it away against the starfield, then sharpens in as the reveal
    // builds. This is what sells "thing in space" once the boss is waking.
    if (phase.revealT > 0.001) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(${baseHue + 12}, 100%, 65%, ${0.8 * phase.revealT})`;
      ctx.lineWidth = 1.2 + 1.6 * phase.revealT;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // Crust shedding for the dust-off: dark exterior flakes break loose around
  // the limb and drift outward, plus a haze of fine dust motes — the rock
  // sloughing off its disguise to expose the boss. `dust` 0..1 sets emission;
  // `reveal` brightens the freshly-exposed under-edges. Deterministic per
  // chunk (seeded off the boss hue) so a chunk streams smoothly across frames.
  paintBossDustOff(ctx: CanvasRenderingContext2D, r: number, dust: number, reveal: number, t: number) {
    const baseHue = this.hue;
    ctx.save();
    // Flaking plates: 14 dark shards lifting off the limb, each easing outward
    // on its own phase. Drawn dark (they're crust) with a hot inner edge where
    // they tore free.
    const CHUNKS = 14;
    for (let i = 0; i < CHUNKS; i++) {
      const seed = Math.abs(Math.sin(baseHue * 7.3 + i * 53.7));
      const ang = (i / CHUNKS) * TAU + seed * 0.6;
      // Per-chunk drift phase loops so chunks keep peeling for the whole
      // dust-off rather than launching once.
      const ph = ((t * 0.0006 + seed) % 1);
      const lift = ph * (0.5 + 0.5 * dust);
      const cr = r * (0.07 + seed * 0.06);
      const cx = Math.cos(ang) * (r * 0.92 + r * 0.7 * lift);
      const cy = Math.sin(ang) * (r * 0.92 + r * 0.7 * lift);
      const alpha = dust * (1 - ph) * 0.85;
      if (alpha < 0.02) continue;
      ctx.fillStyle = `hsla(${baseHue}, 60%, 6%, ${alpha})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, cr, cr * 0.7, ang, 0, TAU);
      ctx.fill();
      // Hot torn edge facing the body.
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(${baseHue + 25}, 100%, 60%, ${alpha * reveal})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, ang + Math.PI * 0.6, ang + Math.PI * 1.4);
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }
    // Fine dust haze drifting off — a scatter of tiny motes in a ring just
    // outside the limb, additive so they glint against the dark.
    ctx.globalCompositeOperation = "lighter";
    const MOTES = 40;
    for (let i = 0; i < MOTES; i++) {
      const s1 = Math.abs(Math.sin(baseHue * 3.1 + i * 12.9));
      const s2 = Math.abs(Math.sin(baseHue * 9.7 + i * 4.33));
      const ph = ((t * 0.0011 + s1) % 1);
      const ang = s1 * TAU;
      const rad = r * (0.95 + ph * 0.55);
      const mx = Math.cos(ang) * rad;
      const my = Math.sin(ang) * rad;
      const alpha = dust * (1 - ph) * 0.5 * s2;
      if (alpha < 0.02) continue;
      ctx.fillStyle = `hsla(${baseHue + 15}, 80%, 55%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(mx, my, 0.8 + s2 * 1.2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // The multi-part eye-open, drawn at the body centre in local space (caller
  // has already translated to pos). `open` is 0..1. Moving parts, in order of
  // appearance:
  //   1. a hot light-bleed glow grows out of the parting seam
  //   2. the iris + slit pupil are revealed through the parting gap — clipped
  //      to the opening, so a thin horizontal strip shows first and widens to
  //      the full disc
  //   3. two armored lids (upper + lower) slide apart, each trailing a hot
  //      inner edge where it tore away from the other
  paintBossEyeOpening(ctx: CanvasRenderingContext2D, bodyR: number, open: number, t: number) {
    const hue = this.hue;
    // The fully-open eye matches the live boss's eye radius, scaled by how
    // far the body has swelled so the reveal lands on the live size.
    const eyeR = this.bossEyeRadius * (bodyR / this.radius);
    // Vertical half-height of the open gap. Starts as a sliver, widens to the
    // full eye height. The horizontal extent (the canthi) is always the full
    // eye width so the gap reads as an eye, not a growing circle.
    const gapH = eyeR * (0.06 + 0.94 * open);
    const gapW = eyeR * (1.02 + 0.04 * open);

    ctx.save();

    // 1. Light bleeding through the seam — hottest right as it cracks, settles
    // as the eye fully opens and the iris (darker) takes over the centre.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const bleed = Math.sin(Math.min(1, open * 1.4) * Math.PI);
    const bleedR = eyeR * (0.9 + 0.7 * open);
    const bleedGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, bleedR);
    bleedGrad.addColorStop(0, `hsla(48, 100%, 95%, ${0.5 * bleed})`);
    bleedGrad.addColorStop(0.4, `hsla(${hue + 30}, 100%, 70%, ${0.35 * bleed})`);
    bleedGrad.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
    ctx.fillStyle = bleedGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, bleedR, bleedR * (0.4 + 0.6 * open), 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 2+3. The iris, revealed through the open gap. Clip to the vesica so the
    // eye appears progressively as the lids part — early on only a thin
    // horizontal strip of iris shows, widening to the full disc as it opens.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, gapW, gapH, 0, 0, TAU);
    ctx.clip();
    this.paintBossEyeAt(ctx, 0, 0, eyeR, hue, this.bossIrisAngle, 0, t, 0, 0);
    ctx.restore();

    // 4. The two armored lids. Each is the body-coloured armor that covered
    // the eye, now a shutter sliding away from the equator. We draw them as
    // filled half-bands whose inner edge is the parting line; the inner edge
    // carries a hot rim where it tore from its partner.
    const lidShift = gapH; // each lid's inner edge sits at the gap boundary
    for (const sign of [-1, 1]) {
      ctx.save();
      // Lid plate — a rounded armored cap covering from its inner edge out
      // past the eye. Body-dark with a beveled brass lip on the inner edge.
      const innerY = sign * lidShift;
      const outerY = sign * (eyeR * 1.35 + lidShift);
      const lidGrad = ctx.createLinearGradient(0, innerY, 0, outerY);
      lidGrad.addColorStop(0, `hsl(${hue + 6}, 70%, 12%)`);
      lidGrad.addColorStop(0.5, `hsl(${hue + 2}, 72%, 8%)`);
      lidGrad.addColorStop(1, `hsl(${hue - 6}, 78%, 4%)`);
      ctx.fillStyle = lidGrad;
      ctx.beginPath();
      // Inner edge is a shallow arc (the lid's curved rim) so the gap reads
      // as a lens; the rest is a wide rect out past the eye.
      ctx.ellipse(0, innerY, gapW, eyeR * 0.28, 0, 0, Math.PI, sign < 0);
      ctx.lineTo(eyeR * 1.6, outerY);
      ctx.lineTo(-eyeR * 1.6, outerY);
      ctx.closePath();
      ctx.fill();
      // Hot inner lip — the freshly-separated edge glows.
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(48, 100%, ${70 + 20 * open}%, ${0.5 + 0.4 * open})`;
      ctx.lineWidth = 1.4 + 2.2 * open;
      ctx.beginPath();
      ctx.ellipse(0, innerY, gapW, eyeR * 0.28, 0, 0, Math.PI, sign < 0);
      ctx.stroke();
      // A couple of plate rivets along the lid so it reads as armor.
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `hsla(48, 100%, 88%, 0.7)`;
      for (const rx of [-eyeR * 0.55, eyeR * 0.55]) {
        ctx.beginPath();
        ctx.arc(rx, innerY + sign * eyeR * 0.5, 1.6, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  // Render the live whole-body boss: layered orrery with a tracking eye.
  // The architecture stays static (cached painting overlaid live) and the
  // iris + telegraph + damage cracks are the only animated overlays.
  renderBossLive(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    // Slow corona breath. Stronger at high damage so the planet visibly
    // stresses as it takes hits.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 0.0018);
    const breathAlpha = 0.18 + 0.12 * breath + 0.35 * damageT;
    const breathR = r * (1.35 + 0.05 * breath + 0.15 * damageT);
    const grad = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, breathR);
    grad.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${breathAlpha * 0.4})`);
    grad.addColorStop(0.6, `hsla(${baseHue + 8}, 100%, 55%, ${breathAlpha})`);
    grad.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, breathR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Body — dark planetoid base with a directional gradient (sun up-left).
    ctx.save();
    const body = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    body.addColorStop(0, `hsl(${baseHue + 8}, 70%, 22%)`);
    body.addColorStop(0.45, `hsl(${baseHue + 4}, 75%, 14%)`);
    body.addColorStop(0.9, `hsl(${baseHue - 6}, 80%, 6%)`);
    body.addColorStop(1, `hsl(${baseHue - 10}, 80%, 3%)`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Architecture (clipped to body). Equatorial plated ring + hex pole
    // caps + storm-band texture + rivet seams. Drawn each frame so the live
    // boss reads as fully alive — no static sprite.
    this.paintBossArchitecture(ctx, r, t);

    // Live damage cracks
    this.renderBossCracks(ctx, damageT);

    // Section flashes (beats 1 + 3). Top/bottom half blooms — drawn after
    // the architecture so the flash reads as the panels themselves lighting
    // up, not a separate overlay floating above the body.
    if (this.bossTopFlash > 0) this.paintBossHalfFlash(ctx, r, -1, this.bossTopFlash);
    if (this.bossBottomFlash > 0) this.paintBossHalfFlash(ctx, r, 1, this.bossBottomFlash);

    // Eye — sits at the body center, iris rotates to track player. Drawn
    // last (above architecture + cracks) so it always reads as the primary
    // focal point. Iris/pupil flashes + laser charge layer on top.
    this.paintBossEyeAt(ctx, 0, 0, this.bossEyeRadius, baseHue, this.bossIrisAngle, this.bossLaserCharge, t, this.bossIrisFlash, this.bossPupilFlash);

    // Outline rim — glints with the same incommensurate-sines shimmer the
    // bassteroid rims use, so boss and rocks share one rhythm at the edge.
    {
      const shimmer =
        0.5 +
        0.5 * (0.6 * Math.sin(t * 0.0021) +
               0.4 * Math.sin(t * 0.0047 + this.pos.x * 0.03));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(${baseHue + 15}, 100%, 75%, ${0.7 + 0.25 * shimmer})`;
      ctx.lineWidth = 2.2 + 0.6 * shimmer;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    if (this.flashAmount > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 90%, ${this.flashAmount * 0.35})`;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.05, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    // Laser charge sightline grows across beats 7→8 and snaps off at fire.
    if (this.bossLaserCharge > 0.05) this.paintBossLaserChargeBeam(ctx);
  }

  // Top/bottom hemisphere flash bloom — used by the live whole-body boss
  // for its beat-1 + beat-3 pulses. `side` = -1 paints the upper half,
  // +1 paints the lower half. The bloom reads as the panels of that half
  // catching a sudden internal light: a clipped overlay tinted with a
  // hot-white inner gradient + a soft rim flare.
  paintBossHalfFlash(ctx: CanvasRenderingContext2D, r: number, side: 1 | -1, amount: number) {
    if (amount <= 0) return;
    const baseHue = this.hue;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Clip to this half-circle so the bloom only fills the matching panels.
    ctx.beginPath();
    ctx.arc(0, 0, r, side < 0 ? Math.PI : 0, side < 0 ? Math.PI * 2 : Math.PI);
    ctx.closePath();
    ctx.clip();
    // Hot inner gradient toward the equator — feels like light pouring out
    // of the seam between top and bottom, not a flat colour wash.
    const grad = ctx.createLinearGradient(0, -side * r * 0.95, 0, side * r * 0.05);
    grad.addColorStop(0, `hsla(${baseHue + 25}, 100%, 65%, ${0.28 * amount})`);
    grad.addColorStop(0.55, `hsla(${baseHue + 35}, 100%, 78%, ${0.55 * amount})`);
    grad.addColorStop(1, `hsla(48, 100%, 96%, ${0.85 * amount})`);
    ctx.fillStyle = grad;
    ctx.fillRect(-r * 1.1, -r * 1.1, r * 2.2, r * 2.2);
    // Equator seam crack — a bright glowing line right along the cut where
    // the flash erupts. Sells the "the planet is breathing through the seam."
    ctx.strokeStyle = `hsla(48, 100%, 95%, ${0.85 * amount})`;
    ctx.lineWidth = 1.6 + 3.0 * amount;
    ctx.beginPath();
    ctx.moveTo(-r * 0.95, 0);
    ctx.lineTo(r * 0.95, 0);
    ctx.stroke();
    ctx.restore();
    // Outer rim halo on the lit half — drawn outside the clip so the
    // crescent of light spills slightly past the silhouette.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.18, side < 0 ? Math.PI : 0, side < 0 ? Math.PI * 2 : Math.PI);
    ctx.closePath();
    ctx.clip();
    const rim = ctx.createRadialGradient(0, 0, r * 0.95, 0, 0, r * 1.25);
    rim.addColorStop(0, `hsla(${baseHue + 30}, 100%, 75%, 0)`);
    rim.addColorStop(0.6, `hsla(${baseHue + 30}, 100%, 80%, ${0.45 * amount})`);
    rim.addColorStop(1, `hsla(${baseHue + 30}, 100%, 80%, 0)`);
    ctx.fillStyle = rim;
    ctx.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6);
    ctx.restore();
  }

  // Targeting telegraph: a single crisp sightline down the locked aim, capped
  // by a lock-on reticle. The aim ticks toward the player once per windup beat
  // (see tickLaserAim), so the line visibly steps onto the player each beat
  // and then holds — the player reads exactly where the beam will fire. The
  // beam fires straight down this line, so the telegraph is an honest
  // predictor of the shot. World-space; drawn source-over as a HUD cue.
  paintBossLaserChargeBeam(ctx: CanvasRenderingContext2D) {
    const charge = this.bossLaserCharge;
    if (charge <= 0.02) return;
    const a = this.eyeAimAngle();
    const startR = (this.kind === "bossEye" ? this.radius : this.bossEyeRadius) * 1.05;
    const aimDist = Math.hypot(this.bossEyeAimX - this.pos.x, this.bossEyeAimY - this.pos.y);
    // The line runs the full length the beam will reach so the threat covers
    // the same span as the shot, not just up to the player.
    const reach = Math.max(startR + 200, aimDist + 600);
    const alpha = 0.3 + 0.6 * charge;
    const sx = this.pos.x + Math.cos(a) * startR;
    const sy = this.pos.y + Math.sin(a) * startR;
    const ex = this.pos.x + Math.cos(a) * reach;
    const ey = this.pos.y + Math.sin(a) * reach;

    ctx.save();
    // Soft underlay along the line — widens slightly as the charge completes
    // so the sightline thickens into "about to fire" without becoming a beam.
    ctx.strokeStyle = `hsla(${this.hue}, 100%, 60%, ${0.12 * charge})`;
    ctx.lineWidth = 4 + 6 * charge;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Crisp dashed sightline — the readable aim. Steps onto the player on each
    // windup beat.
    ctx.strokeStyle = `hsla(${this.hue}, 100%, ${62 + 30 * charge}%, ${alpha})`;
    ctx.lineWidth = 1.4 + 1.2 * charge;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);

    // Lock-on reticle on the aim point: an outer ring that contracts as the
    // charge completes (acquiring → locked) plus a four-tick crosshair, so the
    // exact target reads unmistakably.
    const tx = this.pos.x + Math.cos(a) * Math.max(startR + 30, aimDist);
    const ty = this.pos.y + Math.sin(a) * Math.max(startR + 30, aimDist);
    const ringR = 26 - 14 * charge;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(tx, ty, ringR, 0, TAU);
    ctx.stroke();
    const tickOut = ringR + 7;
    const tickIn = ringR + 2;
    for (let k = 0; k < 4; k++) {
      const ang = a + (k * TAU) / 4;
      ctx.beginPath();
      ctx.moveTo(tx + Math.cos(ang) * tickIn, ty + Math.sin(ang) * tickIn);
      ctx.lineTo(tx + Math.cos(ang) * tickOut, ty + Math.sin(ang) * tickOut);
      ctx.stroke();
    }
    ctx.fillStyle = `hsla(${this.hue}, 100%, ${60 + 35 * charge}%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(tx, ty, 1.5 + 1.5 * charge, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Surface architecture for the live boss. Pulled apart into named layers
  // so the texture reads as a constructed body — not a beach ball with
  // stripes. Layer order, top to bottom on screen:
  //   1. storm-band turbulence rendered across the equator (multiple thin
  //      arc bands + scatter of pock craters; deterministic from the boss's
  //      hue+angle seed so it's stable across frames)
  //   2. equatorial Bassteroid plated ring — same 4-hue bands but with
  //      proper bevel highlights + rivet pins along each plate seam
  //   3. polar hex panel caps — actual hex grid pattern, not just stripes
  //   4. meridian fracture seams running pole-to-pole (3 of them)
  //   5. the broken lid scar where the eye opened
  paintBossArchitecture(ctx: CanvasRenderingContext2D, r: number, t: number) {
    const baseHue = this.hue;
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.clip();

    // ---- 1. Storm-band turbulence ----
    // Three soft horizontal arcs swept across the body — suggestive of an
    // atmosphere or molten band layered under the plating. Drawn first so
    // the plate ring covers most of it; the band peeks out top and bottom
    // of the ring like weather curling out of an exhaust grille.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < 3; k++) {
      const yC = (k - 1) * r * 0.55;
      const bandH = r * (0.18 + 0.06 * k);
      const seed = Math.abs(Math.sin(baseHue * 0.317 + k * 9.111));
      const grad = ctx.createLinearGradient(0, yC - bandH, 0, yC + bandH);
      grad.addColorStop(0, `hsla(${baseHue + 6 + 8 * seed}, 90%, 24%, 0)`);
      grad.addColorStop(0.5, `hsla(${baseHue + 6 + 8 * seed}, 90%, 30%, 0.32)`);
      grad.addColorStop(1, `hsla(${baseHue + 6 + 8 * seed}, 90%, 24%, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(-r * 1.2, yC - bandH, r * 2.4, bandH * 2);
    }
    ctx.restore();
    // Scatter pock craters across the body — deterministic from the boss
    // seed. Each crater is a soft dark disc + bright crescent rim, so the
    // surface reads as cratered rock under the architecture.
    {
      const craterCount = 22;
      for (let i = 0; i < craterCount; i++) {
        const s1 = Math.abs(Math.sin(baseHue * 12.9 + i * 78.2));
        const s2 = Math.abs(Math.sin(baseHue * 39.3 + i * 17.7));
        const s3 = Math.abs(Math.sin(baseHue * 4.41 + i * 91.0));
        const ang = s1 * TAU;
        const rad = r * (0.05 + s2 * 0.92);
        const cx = Math.cos(ang) * rad;
        const cy = Math.sin(ang) * rad;
        const cr = r * (0.025 + s3 * 0.055);
        const inBand = Math.abs(cy) < r * 0.32;
        if (inBand) continue;
        ctx.fillStyle = `hsla(${baseHue - 10}, 80%, 5%, 0.65)`;
        ctx.beginPath();
        ctx.arc(cx, cy, cr, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = `hsla(${baseHue + 20}, 80%, 40%, 0.45)`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(cx - cr * 0.25, cy - cr * 0.25, cr * 0.85, Math.PI * 0.6, Math.PI * 1.7);
        ctx.stroke();
      }
    }

    // ---- 2. Equatorial Bassteroid plate ring ----
    // Four-hue band wrapping the body. Each panel gets a top-edge highlight
    // and a bottom-edge shadow (bevel), an interior brace line, and rivet
    // pins at the corners along the seams. The result reads as plated armor,
    // not a stripe.
    const bandHeight = r * 0.42;
    const bassHues = [0, 28, 215, 290];
    const panelCount = 14;
    // Per-quadrant beat pulse: the red/orange/blue/purple quadrants light in
    // sequence (kick→pluck→boom→snap), borrowing the bassteroids' rhythm. Four
    // free-running phases a quarter-measure apart over a 2s measure; each is a
    // sharp attack + decay so the quadrant flares as its voice would fire. (A
    // free-running phase from t, not the live bass clock — render() isn't given
    // the clock; this reads near-identically and keeps the signature unchanged.)
    const MEASURE_MS = 2000;
    const quadPulse = (q: number) => {
      const ph = (((t - q * (MEASURE_MS / 4)) % MEASURE_MS) + MEASURE_MS) % MEASURE_MS / MEASURE_MS;
      // ph 0 = the quadrant's downbeat: snap to 1 then ease back down.
      return Math.pow(1 - ph, 3);
    };
    for (let i = 0; i < panelCount; i++) {
      const u = i / panelCount;
      const x0 = -r * 1.2 + u * r * 2.4;
      const x1 = -r * 1.2 + (u + 1 / panelCount) * r * 2.4;
      const quad = Math.floor(u * 4) % 4;
      const hueBand = bassHues[quad];
      const panel = ctx.createLinearGradient(0, -bandHeight, 0, bandHeight);
      panel.addColorStop(0, `hsla(${hueBand}, 60%, 18%, 0.65)`);
      panel.addColorStop(0.45, `hsla(${hueBand}, 75%, 32%, 0.92)`);
      panel.addColorStop(0.55, `hsla(${hueBand}, 75%, 22%, 0.92)`);
      panel.addColorStop(1, `hsla(${hueBand}, 60%, 10%, 0.65)`);
      ctx.fillStyle = panel;
      ctx.fillRect(x0, -bandHeight, x1 - x0, bandHeight * 2);
      // Top bevel — bright thin strip across the panel top edge.
      ctx.fillStyle = `hsla(${hueBand + 20}, 100%, 80%, 0.55)`;
      ctx.fillRect(x0 + 1, -bandHeight, x1 - x0 - 2, 1.8);
      // Bottom shadow — dark thin strip at the bottom for depth.
      ctx.fillStyle = `hsla(${hueBand - 10}, 70%, 5%, 0.55)`;
      ctx.fillRect(x0 + 1, bandHeight - 1.8, x1 - x0 - 2, 1.8);
      // Plate seam (vertical line at panel boundary).
      ctx.strokeStyle = `hsla(${hueBand + 25}, 100%, 82%, 0.65)`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x1, -bandHeight);
      ctx.lineTo(x1, bandHeight);
      ctx.stroke();
      // Rivet pins at the seam (top + bottom of each plate boundary).
      ctx.fillStyle = `hsla(48, 100%, 92%, 0.85)`;
      ctx.beginPath();
      ctx.arc(x1, -bandHeight + 3.5, 1.4, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x1, bandHeight - 3.5, 1.4, 0, TAU);
      ctx.fill();
      // Interior brace — a thin horizontal accent in the panel mid-band.
      // Offset every other panel so the ring doesn't look like a stencil.
      const braceY = (i % 2 === 0 ? -1 : 1) * bandHeight * 0.32;
      ctx.strokeStyle = `hsla(${hueBand + 30}, 90%, 70%, 0.35)`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x0 + (x1 - x0) * 0.18, braceY);
      ctx.lineTo(x0 + (x1 - x0) * 0.82, braceY);
      ctx.stroke();
      // Beat pulse — this quadrant's voice firing lights the whole plate
      // additively. Flat rect, no gradient; the brightest beat for the brightest
      // plate, sweeping around the ring in voice order.
      const pulse = quadPulse(quad);
      if (pulse > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = `hsla(${hueBand + 18}, 100%, 70%, ${0.32 * pulse})`;
        ctx.fillRect(x0 + 1, -bandHeight, x1 - x0 - 2, bandHeight * 2);
        ctx.restore();
      }
    }

    // ---- 3. Polar caps with proper hex grid ----
    for (const sign of [-1, 1]) {
      // Dark fill — chunkier than before, with a stronger gradient so the
      // cap reads as curving away from the eye instead of being flat.
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, sign * r * 0.55, r * 1.1, r * 0.5, 0, 0, TAU);
      ctx.clip();
      const capGrad = ctx.createLinearGradient(0, sign * r * 0.1, 0, sign * r * 1.05);
      capGrad.addColorStop(0, `hsla(${baseHue}, 75%, 14%, 0.85)`);
      capGrad.addColorStop(1, `hsla(${baseHue - 10}, 90%, 3%, 0.95)`);
      ctx.fillStyle = capGrad;
      ctx.fillRect(-r * 1.2, sign > 0 ? 0 : -r * 1.1, r * 2.4, r * 1.1);
      // Hex grid — small honeycomb of darker outlines. Two staggered rows of
      // hexes per band; rows are clipped to the cap ellipse.
      const hexR = r * 0.075;
      const hexW = hexR * Math.sqrt(3);
      const hexH = hexR * 1.5;
      ctx.strokeStyle = `hsla(${baseHue + 10}, 65%, 22%, 0.75)`;
      ctx.lineWidth = 0.7;
      const rows = 6;
      for (let row = 0; row < rows; row++) {
        const ry = sign * (r * 0.18 + row * hexH);
        const xOff = (row % 2) * hexW * 0.5;
        const cols = 10;
        for (let col = -cols; col <= cols; col++) {
          const cx = col * hexW + xOff;
          ctx.beginPath();
          for (let v = 0; v < 6; v++) {
            const ang = (v / 6) * TAU + Math.PI / 6;
            const px = cx + Math.cos(ang) * hexR;
            const py = ry + Math.sin(ang) * hexR;
            if (v === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.restore();
      // Cap inner rim — bright crisp line where the cap meets the equator.
      ctx.strokeStyle = `hsla(${baseHue + 10}, 100%, 60%, 0.65)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, sign * r * 0.55, r * 1.1, r * 0.5, 0, 0, TAU);
      ctx.stroke();
      // Cap rivets — three pinprick highlights along the rim edge.
      ctx.fillStyle = `hsla(48, 100%, 95%, 0.85)`;
      for (const xR of [-r * 0.7, 0, r * 0.7]) {
        const yR = sign * (r * 0.55 - r * 0.46);
        ctx.beginPath();
        ctx.arc(xR, yR, 1.4, 0, TAU);
        ctx.fill();
      }
    }

    // ---- 4. Meridian fractures ----
    // Three thin curved scars running pole-to-pole, dark with a faint hot
    // inner glow. They sell the boss as a tectonic body that's been holding
    // together under stress, not a smooth ball.
    for (const mx of [-r * 0.62, -r * 0.05, r * 0.55]) {
      ctx.strokeStyle = `hsla(${baseHue - 6}, 80%, 4%, 0.85)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(mx, -r * 0.95);
      ctx.bezierCurveTo(mx + r * 0.05, -r * 0.4, mx - r * 0.04, r * 0.4, mx + r * 0.02, r * 0.95);
      ctx.stroke();
      // Hot inner glint — only faint, suggests pressure inside.
      ctx.strokeStyle = `hsla(${baseHue + 25}, 90%, 55%, 0.18)`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(mx, -r * 0.95);
      ctx.bezierCurveTo(mx + r * 0.05, -r * 0.4, mx - r * 0.04, r * 0.4, mx + r * 0.02, r * 0.95);
      ctx.stroke();
    }

    // ---- 5. Broken-lid scar at the equator centre ----
    ctx.strokeStyle = `hsla(${baseHue}, 90%, 28%, 0.6)`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, 0);
    ctx.lineTo(-r * 0.32, 0);
    ctx.moveTo(r * 0.32, 0);
    ctx.lineTo(r * 0.85, 0);
    ctx.stroke();
    // Hot glint along the scar — the lid is broken; light leaks out faintly.
    ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 70%, 0.35)`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, 0);
    ctx.lineTo(-r * 0.32, 0);
    ctx.moveTo(r * 0.32, 0);
    ctx.lineTo(r * 0.85, 0);
    ctx.stroke();

    ctx.restore();
    void t;
  }

  // Iris + pupil + brass aperture rim. Shared by the whole-body boss
  // (drawn at the planet center) and the detached eye-core. `irisAngle`
  // is the world-space pupil aim. `chargeT` 0..1 is the beat-7→beat-8
  // laser charge ramp (paints a hot inner core glow). `irisFlashAmp` is
  // the beat-5 brass-ring pulse amplitude; `pupilFlashAmp` is the beat-7
  // /beat-8 pupil double-pulse amplitude.
  paintBossEyeAt(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    eyeR: number,
    hue: number,
    irisAngle: number,
    chargeT: number,
    t: number,
    irisFlashAmp: number = 0,
    pupilFlashAmp: number = 0,
  ) {
    ctx.save();
    ctx.translate(x, y);

    // Brass aperture rim — a wide ring framing the iris. Brass = warm
    // ochre, distinct from the body's red so the eye reads as a fitted
    // device rather than a wound. On beat 5 the rim blooms.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const rimBoost = 1 + irisFlashAmp * 0.9;
    const rimR = eyeR * (1.12 + 0.18 * irisFlashAmp);
    const rim = ctx.createRadialGradient(0, 0, eyeR * 0.85, 0, 0, rimR);
    rim.addColorStop(0, `hsla(38, 80%, 55%, 0)`);
    rim.addColorStop(0.45, `hsla(38, 95%, ${60 + 25 * irisFlashAmp}%, ${0.55 * rimBoost})`);
    rim.addColorStop(1, `hsla(28, 90%, 45%, 0)`);
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(0, 0, rimR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Iris — dark crimson disc. Subtle radial gradient gives it depth.
    const irisFill = ctx.createRadialGradient(0, 0, 0, 0, 0, eyeR);
    irisFill.addColorStop(0, `hsl(${hue + 8}, 90%, 22%)`);
    irisFill.addColorStop(0.55, `hsl(${hue - 4}, 85%, 11%)`);
    irisFill.addColorStop(1, `hsl(${hue - 10}, 90%, 4%)`);
    ctx.fillStyle = irisFill;
    ctx.beginPath();
    ctx.arc(0, 0, eyeR, 0, TAU);
    ctx.fill();

    // Brass rim outline — thin precise ring. Brightens with the beat-5 pulse.
    ctx.strokeStyle = `hsla(38, 95%, ${65 + 30 * irisFlashAmp}%, ${0.85 + 0.15 * irisFlashAmp})`;
    ctx.lineWidth = 1.8 + 2.4 * irisFlashAmp;
    ctx.beginPath();
    ctx.arc(0, 0, eyeR, 0, TAU);
    ctx.stroke();

    // Inner sclera ring — concentric darker line. Lifted to brass-bright
    // during the iris flash so the ring reads as the whole aperture firing.
    ctx.strokeStyle = irisFlashAmp > 0.1
      ? `hsla(48, 100%, ${70 + 20 * irisFlashAmp}%, ${0.6 + 0.4 * irisFlashAmp})`
      : `hsla(${hue}, 80%, 18%, 0.85)`;
    ctx.lineWidth = 0.9 + 1.8 * irisFlashAmp;
    ctx.beginPath();
    ctx.arc(0, 0, eyeR * 0.78, 0, TAU);
    ctx.stroke();

    // Pupil — vertical slit aligned to irisAngle. Drawn as a tall, narrow
    // black ellipse; rotation by irisAngle aims it at the player. A slow
    // dilate breath modulates the slit width; the pupil flash dilates the
    // slit and lights the inner core white-hot.
    ctx.save();
    ctx.rotate(irisAngle);
    const dilate = 1 + 0.1 * Math.sin(t * 0.003) + 0.6 * pupilFlashAmp;
    const slitW = eyeR * 0.16 * dilate;
    const slitH = eyeR * 0.7;
    ctx.fillStyle = `hsla(0, 0%, 0%, ${0.95 - 0.4 * pupilFlashAmp})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, slitW, slitH, 0, 0, TAU);
    ctx.fill();
    // Laser charge core. Ramps from a faint glow on beat 7 to a brilliant
    // white-hot ball on beat 8. Independent of pupilFlashAmp so the charge
    // is visible across the entire beat-7→beat-8 window, not just on the
    // beat hits themselves.
    if (chargeT > 0.02 || pupilFlashAmp > 0.05) {
      const amp = Math.max(chargeT, pupilFlashAmp);
      ctx.globalCompositeOperation = "lighter";
      const coreR = slitW * (0.8 + 2.4 * amp);
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
      core.addColorStop(0, `hsla(48, 100%, 98%, ${0.95 * amp})`);
      core.addColorStop(0.45, `hsla(${hue + 35}, 100%, 75%, ${0.7 * amp})`);
      core.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, TAU);
      ctx.fill();
      // Two stretched lensflare spikes along the slit axis on peak charge —
      // sells "barrel about to fire" instead of just "warm pupil".
      if (amp > 0.4) {
        ctx.strokeStyle = `hsla(48, 100%, 98%, ${(amp - 0.4) * 1.4})`;
        ctx.lineWidth = slitW * 0.4;
        ctx.lineCap = "round";
        const spike = eyeR * (0.55 + 0.7 * amp);
        ctx.beginPath();
        ctx.moveTo(0, -spike);
        ctx.lineTo(0, spike);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Pupil flash bloom — radiates OUT from the iris on the pupil double-
    // pulse. Wide soft halo so the entire eye visibly throbs.
    if (pupilFlashAmp > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const haloR = eyeR * (1.6 + 0.6 * pupilFlashAmp);
      const halo = ctx.createRadialGradient(0, 0, eyeR * 0.2, 0, 0, haloR);
      halo.addColorStop(0, `hsla(48, 100%, 96%, ${0.55 * pupilFlashAmp})`);
      halo.addColorStop(0.55, `hsla(${hue + 30}, 100%, 70%, ${0.4 * pupilFlashAmp})`);
      halo.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, haloR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Highlight glint — small bright spot on the upper-left of the iris,
    // sells "wet" reflective optic rather than dull cratered rock.
    ctx.fillStyle = `hsla(48, 100%, 92%, 0.7)`;
    ctx.beginPath();
    ctx.arc(-eyeR * 0.35, -eyeR * 0.35, eyeR * 0.08, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  // (Old dt-based sightline removed — replaced by paintBossLaserChargeBeam
  // which is driven by bossLaserCharge from the 8-beat rhythm.)

  // Hemisphere fragment: a half-disc with the freshly-revealed inner
  // cross-section facing the cut axis. The straight edge (the diameter)
  // shows a glowing interior — molten core glimpse — while the curved limb
  // wears its share of the equatorial Bassteroid ring.
  renderBossHemisphere(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // The hemisphere is the half-disc on the side opposite the cut axis.
    // In its own local frame we draw the half on +x side (so the cut
    // diameter is the y-axis), then the outer rotation places it correctly.
    // Apply the fragment angle so the cut faces the recorded direction.
    ctx.rotate(this.bossFragmentAngle);

    // Wide outer corona — same hue family as the whole boss
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 0.002);
    const coronaA = 0.14 + 0.08 * breath + 0.3 * damageT;
    const coronaR = r * (1.35 + 0.18 * damageT);
    const corona = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, coronaR);
    corona.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${coronaA * 0.5})`);
    corona.addColorStop(0.6, `hsla(${baseHue + 8}, 100%, 50%, ${coronaA})`);
    corona.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(0, 0, coronaR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // The half-disc body itself (curved side on +x). Clip a circular path
    // to the +x half-plane so the renderer can paint architecture inside.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(0, -r);
    ctx.closePath();
    ctx.clip();

    // Body fill — dark planetoid base
    const body = ctx.createRadialGradient(r * 0.4, -r * 0.3, r * 0.1, 0, 0, r);
    body.addColorStop(0, `hsl(${baseHue + 8}, 70%, 22%)`);
    body.addColorStop(0.5, `hsl(${baseHue}, 75%, 12%)`);
    body.addColorStop(1, `hsl(${baseHue - 8}, 80%, 4%)`);
    ctx.fillStyle = body;
    ctx.fillRect(0, -r, r, r * 2);

    // Equatorial ring slice — this hemisphere wore half the boss's ring.
    // Draw it as a horizontal band on the +x side; the diameter edge cuts
    // the band so its left edge is the broken cross-section.
    const bandHeight = r * 0.36;
    const bassHues = [0, 28, 215, 290];
    for (let i = 0; i < 7; i++) {
      const u = i / 7;
      const x0 = u * r * 1.05;
      const x1 = (u + 1 / 7) * r * 1.05;
      const hueBand = bassHues[Math.floor(u * 4) % 4];
      const panel = ctx.createLinearGradient(0, -bandHeight, 0, bandHeight);
      panel.addColorStop(0, `hsla(${hueBand}, 60%, 18%, 0.5)`);
      panel.addColorStop(0.5, `hsla(${hueBand}, 75%, 28%, 0.8)`);
      panel.addColorStop(1, `hsla(${hueBand}, 60%, 10%, 0.5)`);
      ctx.fillStyle = panel;
      ctx.fillRect(x0, -bandHeight, x1 - x0, bandHeight * 2);
      ctx.strokeStyle = `hsla(${hueBand + 20}, 100%, 80%, 0.5)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x1, -bandHeight);
      ctx.lineTo(x1, bandHeight);
      ctx.stroke();
    }

    ctx.restore();

    // The cut cross-section — the flat diameter face of the broken planet.
    // Glowing molten interior so the freshly-revealed inside reads as
    // "this thing was alive inside". Draw on top, only along the diameter.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const cutGlow = ctx.createLinearGradient(-r * 0.05, 0, r * 0.3, 0);
    cutGlow.addColorStop(0, `hsla(${baseHue + 25}, 100%, 75%, 0.95)`);
    cutGlow.addColorStop(0.4, `hsla(${baseHue + 12}, 100%, 55%, 0.75)`);
    cutGlow.addColorStop(1, `hsla(${baseHue}, 100%, 40%, 0)`);
    ctx.fillStyle = cutGlow;
    ctx.fillRect(-r * 0.04, -r, r * 0.3, r * 2);
    // Bright thin seam right at x=0
    ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 90%, 0.9)`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(0, r);
    ctx.stroke();
    ctx.restore();

    // Outline rim — curved limb only (the half-circle arc on +x)
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${baseHue + 15}, 100%, 75%, 0.85)`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.restore();

    // Damage cracks (clipped to the half-disc)
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(0, -r);
    ctx.closePath();
    ctx.clip();
    this.renderBossCracks(ctx, damageT);
    ctx.restore();

    if (this.flashAmount > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 90%, ${this.flashAmount * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.05, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(0, -r);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  // Eye-core fragment: a free-floating iris that keeps firing on its 4s
  // cadence. Renders very similarly to the whole-body eye but as its own
  // standalone entity (smaller, more agile target).
  renderBossEye(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    // Corona — slightly more agitated than the whole-body boss; this thing
    // is detached and angry. Pulses harder with damage.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 0.003);
    const coronaA = 0.22 + 0.16 * breath + 0.4 * damageT;
    const coronaR = r * (1.6 + 0.25 * damageT);
    const corona = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, coronaR);
    corona.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${coronaA * 0.6})`);
    corona.addColorStop(0.55, `hsla(${baseHue + 12}, 100%, 55%, ${coronaA})`);
    corona.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(0, 0, coronaR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Iris/pupil — full eye-core uses the same painter, with the eye
    // occupying its entire body. Beat-5 iris + beat-7/8 pupil flashes are
    // forwarded so the detached eye-core keeps its rhythm post-break.
    this.paintBossEyeAt(ctx, 0, 0, r, baseHue, this.bossIrisAngle, this.bossLaserCharge, t, this.bossIrisFlash, this.bossPupilFlash);

    // Damage cracks
    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 92%, ${this.flashAmount * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.1, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    if (this.bossLaserCharge > 0.05) this.paintBossLaserChargeBeam(ctx);
  }

  // Plate fragment: a single Bassteroid-style modular shard, painted in
  // one of the four ring hues. Tumbles freely. Reads as a literal piece of
  // the equatorial band that just flew off.
  renderBossPlate(ctx: CanvasRenderingContext2D, t: number) {
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;
    const bassHues = [0, 28, 215, 290];
    const hue = bassHues[this.bossPlateBand];

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // Small hue-tinted halo
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const halo = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.8);
    halo.addColorStop(0, `hsla(${hue}, 100%, 60%, 0.4)`);
    halo.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.8, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Plate silhouette — a chunky trapezoidal panel with bevelled corners.
    // Hand-built shape so it doesn't read as a generic rock.
    ctx.fillStyle = `hsl(${hue}, 60%, 14%)`;
    ctx.beginPath();
    ctx.moveTo(-r * 0.9, -r * 0.45);
    ctx.lineTo(r * 0.65, -r * 0.7);
    ctx.lineTo(r * 0.95, -r * 0.1);
    ctx.lineTo(r * 0.75, r * 0.55);
    ctx.lineTo(-r * 0.55, r * 0.75);
    ctx.lineTo(-r * 0.95, r * 0.1);
    ctx.closePath();
    ctx.fill();

    // Panel inner gradient — bright top edge, dark bottom (suggests light
    // reflecting off the plated surface)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-r * 0.9, -r * 0.45);
    ctx.lineTo(r * 0.65, -r * 0.7);
    ctx.lineTo(r * 0.95, -r * 0.1);
    ctx.lineTo(r * 0.75, r * 0.55);
    ctx.lineTo(-r * 0.55, r * 0.75);
    ctx.lineTo(-r * 0.95, r * 0.1);
    ctx.closePath();
    ctx.clip();
    const sheen = ctx.createLinearGradient(0, -r, 0, r);
    sheen.addColorStop(0, `hsla(${hue + 10}, 90%, 50%, 0.55)`);
    sheen.addColorStop(0.5, `hsla(${hue}, 75%, 25%, 0.4)`);
    sheen.addColorStop(1, `hsla(${hue - 10}, 80%, 8%, 0.5)`);
    ctx.fillStyle = sheen;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    // Inner stripe — Bassteroid plate accent
    ctx.strokeStyle = `hsla(${hue + 30}, 100%, 80%, 0.55)`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, 0);
    ctx.lineTo(r * 0.5, 0);
    ctx.stroke();
    ctx.restore();

    // Panel outline — bright rim
    ctx.strokeStyle = `hsla(${hue + 20}, 100%, 75%, 0.9)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-r * 0.9, -r * 0.45);
    ctx.lineTo(r * 0.65, -r * 0.7);
    ctx.lineTo(r * 0.95, -r * 0.1);
    ctx.lineTo(r * 0.75, r * 0.55);
    ctx.lineTo(-r * 0.55, r * 0.75);
    ctx.lineTo(-r * 0.95, r * 0.1);
    ctx.closePath();
    ctx.stroke();

    // One running light — pinprick glow at a corner
    ctx.fillStyle = `hsla(${hue + 40}, 100%, 95%, 1)`;
    ctx.beginPath();
    ctx.arc(r * 0.6, -r * 0.4, r * 0.08, 0, TAU);
    ctx.fill();

    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${hue + 30}, 100%, 92%, ${this.flashAmount * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
    void t;
  }

  // Iris-shard fragment: a crescent sliver of the brass aperture rim with
  // a sliver of pupil. Reads as a slice of the dead eye.
  renderBossIrisShard(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;
    const side = this.bossFragmentAngle >= 0 ? 1 : -1;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // Faint halo
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const halo = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.6);
    halo.addColorStop(0, `hsla(${baseHue}, 100%, 55%, 0.4)`);
    halo.addColorStop(1, `hsla(${baseHue}, 100%, 55%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.6, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Crescent shape — outer arc + inner arc on the same side.
    ctx.fillStyle = `hsl(${baseHue}, 80%, 10%)`;
    ctx.beginPath();
    ctx.arc(0, 0, r, side * -Math.PI / 2, side * Math.PI / 2, side < 0);
    ctx.arc(0, 0, r * 0.55, side * Math.PI / 2, side * -Math.PI / 2, side > 0);
    ctx.closePath();
    ctx.fill();

    // Brass rim on the outer arc
    ctx.strokeStyle = `hsla(38, 90%, 60%, 0.9)`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, r, side * -Math.PI / 2, side * Math.PI / 2, side < 0);
    ctx.stroke();
    // Dim inner edge
    ctx.strokeStyle = `hsla(${baseHue}, 80%, 30%, 0.7)`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, side * -Math.PI / 2, side * Math.PI / 2, side < 0);
    ctx.stroke();

    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 92%, ${this.flashAmount * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
    void t;
  }

  // Inert pupil ember — a tiny black sphere with a final smouldering core.
  // Doesn't fire, doesn't telegraph. Pure remnant.
  renderBossEmber(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // Tiny corona — the last warmth
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const flicker = 0.5 + 0.5 * Math.sin(t * 0.004);
    const coreA = 0.4 + 0.25 * flicker;
    const coreR = r * 1.8;
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, `hsla(48, 100%, 90%, ${coreA})`);
    core.addColorStop(0.35, `hsla(${baseHue + 30}, 100%, 60%, ${coreA * 0.7})`);
    core.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Black ember body
    ctx.fillStyle = `hsl(${baseHue}, 80%, 5%)`;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();

    // Hot pinprick at center
    ctx.fillStyle = `hsla(48, 100%, 95%, ${0.6 + 0.3 * flicker})`;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.22, 0, TAU);
    ctx.fill();

    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(48, 100%, 90%, ${this.flashAmount * 0.5})`;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
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
  const speed = 5;
  const vel = v((dx / norm) * speed, (dy / norm) * speed);
  return new Asteroid({ x: pos.x, y: pos.y }, vel, "large", undefined, "boss");
};

// min sin of angle between trajectory and the spawn edge. sin(30°) = 0.5 — at
// shallower angles an edge spawn skims along its own edge for a long time
// before drifting inward, which reads as the rock briefly hugging the border.
const EDGE_SPAWN_MIN_INWARD = 0.5;

export const spawnAsteroidAtEdge = (
  w: number,
  h: number,
  hue?: number,
  kind: AsteroidKind = "normal",
  size: AsteroidSize = "large",
): Asteroid => {
  const edge = Math.floor(rng() * 4);
  let pos: Vec;
  let inwardAxis: "x" | "y";
  let inwardSign: 1 | -1;
  if (edge === 0)      { pos = v(rand(0, w), -40);       inwardAxis = "y"; inwardSign = 1;  }
  else if (edge === 1) { pos = v(w + 40, rand(0, h));    inwardAxis = "x"; inwardSign = -1; }
  else if (edge === 2) { pos = v(rand(0, w), h + 40);    inwardAxis = "y"; inwardSign = -1; }
  else                 { pos = v(-40, rand(0, h));       inwardAxis = "x"; inwardSign = 1;  }
  const center = v(w / 2 + rand(-w * 0.2, w * 0.2), h / 2 + rand(-h * 0.2, h * 0.2));
  let dirX = center.x - pos.x;
  let dirY = center.y - pos.y;
  const norm = Math.hypot(dirX, dirY);
  dirX /= norm;
  dirY /= norm;
  // enforce minimum steepness off the spawning edge. component along the
  // outward-edge axis is what determines how shallow the angle is; scale up
  // until its absolute value matches the min threshold.
  const inwardComp = inwardAxis === "x" ? dirX * inwardSign : dirY * inwardSign;
  if (inwardComp < EDGE_SPAWN_MIN_INWARD) {
    if (inwardAxis === "x") {
      dirX = inwardSign * EDGE_SPAWN_MIN_INWARD;
      const tangentMag = Math.sqrt(1 - EDGE_SPAWN_MIN_INWARD * EDGE_SPAWN_MIN_INWARD);
      dirY = Math.sign(dirY) * tangentMag;
    } else {
      dirY = inwardSign * EDGE_SPAWN_MIN_INWARD;
      const tangentMag = Math.sqrt(1 - EDGE_SPAWN_MIN_INWARD * EDGE_SPAWN_MIN_INWARD);
      dirX = Math.sign(dirX) * tangentMag;
    }
  }
  const [speedMin, speedMax] = SIZE_SPAWN_SPEED[size];
  const speed = rand(speedMin, speedMax);
  return new Asteroid(pos, v(dirX * speed, dirY * speed), size, hue, kind);
};
