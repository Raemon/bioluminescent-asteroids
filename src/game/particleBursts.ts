import { Vec, fromAngle, rand, TAU } from "../vec";
import { ParticleSystem } from "../Particle";
import { Asteroid } from "../Asteroid";
import { Comet } from "../Comet";
import { Alien } from "../Alien";
import { Canister } from "../Canister";
import { GoldCrystal } from "../GoldCrystal";
import { Shard, shatterAsteroid } from "../Shard";

// every burst in the game shares this shape; differences live in tuning, not code structure.
export type BurstSpec = {
  pos: Vec;
  count: number;
  speedRange: [number, number];
  lifeRange: [number, number];
  maxLife: number;
  sizeRange: [number, number];
  hue: number;
  hueSpread: [number, number];
  drag: number;
  angleMode: "random" | "uniform";
  angleJitter: number;
};

// one emit-loop replaces ~8 duplicated Array.from + emit blocks across kill/pop sites.
export const emitBurst = (particles: ParticleSystem, s: BurstSpec) => {
  for (let i = 0; i < s.count; i++) {
    const angle = s.angleMode === "uniform"
      ? (i / s.count) * TAU + rand(-s.angleJitter, s.angleJitter)
      : rand(0, TAU);
    const speed = rand(s.speedRange[0], s.speedRange[1]);
    particles.emit({
      pos: { ...s.pos },
      vel: fromAngle(angle, speed),
      life: rand(s.lifeRange[0], s.lifeRange[1]),
      maxLife: s.maxLife,
      size: rand(s.sizeRange[0], s.sizeRange[1]),
      hue: s.hue + rand(s.hueSpread[0], s.hueSpread[1]),
      shrink: 1,
      drag: s.drag,
    });
  }
};

// gold ring shared by every on-beat impact so the rhythm bonus reads consistently.
const emitOnBeatSparkleRing = (particles: ParticleSystem, pos: Vec, count: number, speedRange: [number, number], lifeMax: number, sizeRange: [number, number], drag: number) => {
  emitBurst(particles, {
    pos, count,
    speedRange,
    lifeRange: [lifeMax * 0.5, lifeMax],
    maxLife: lifeMax,
    sizeRange,
    hue: 48, hueSpread: [-6, 12],
    drag,
    angleMode: "uniform", angleJitter: 0.05,
  });
};

// shards carry "rock physically breaks"; particles + sparkle reinforce on-beat rhythm credit.
export const emitExplosion = (particles: ParticleSystem, shards: Shard[], a: Asteroid, onBeat: boolean) => {
  for (const s of shatterAsteroid(a)) shards.push(s);
  const baseCount = a.size === "large" ? 60 : a.size === "medium" ? 40 : 24;
  emitBurst(particles, {
    pos: a.pos,
    count: onBeat ? Math.round(baseCount * 1.6) : baseCount,
    speedRange: [80, 320],
    lifeRange: [0.5, 1.4], maxLife: 1.4,
    sizeRange: [1, 2.6],
    hue: a.hue, hueSpread: [-15, 25],
    drag: 1.5,
    angleMode: "random", angleJitter: 0,
  });
  if (onBeat) {
    emitOnBeatSparkleRing(particles, a.pos, 18, [220, 360], 0.7, [1.6, 2.4], 1.8);
  }
};

// a shot too weak to break armour bounces off — a tight, bright spray fired back
// along the impact normal reads as "deflected" rather than "absorbed".
export const emitBounceSparks = (particles: ParticleSystem, pos: Vec, normal: Vec, hue: number) => {
  const baseAngle = Math.atan2(normal.y, normal.x);
  const count = 7;
  for (let i = 0; i < count; i++) {
    const angle = baseAngle + rand(-0.7, 0.7);
    particles.emit({
      pos: { ...pos },
      vel: fromAngle(angle, rand(120, 280)),
      life: rand(0.12, 0.28),
      maxLife: 0.28,
      size: rand(1.2, 2.2),
      hue: hue + rand(-10, 14),
      shrink: 1,
      drag: 5.0,
    });
  }
};

// heavier dark debris reads "cracked, not killed" — distinguishes a chip from a kill.
export const emitCrackParticles = (particles: ParticleSystem, a: Asteroid, onBeat: boolean) => {
  emitBurst(particles, {
    pos: a.pos,
    count: onBeat ? 14 : 9,
    speedRange: [60, 180],
    lifeRange: [0.35, 0.7], maxLife: 0.7,
    sizeRange: [1.6, 2.8],
    hue: a.hue, hueSpread: [-8, 12],
    drag: 3.0,
    angleMode: "random", angleJitter: 0,
  });
  if (onBeat) {
    emitOnBeatSparkleRing(particles, a.pos, 8, [140, 220], 0.5, [1.4, 2.0], 2.2);
  }
};

// sparks + slow dust cloud reads "celestial" — distinguishes comet kill from rock kill.
export const emitCometExplosion = (particles: ParticleSystem, c: Comet) => {
  emitBurst(particles, {
    pos: c.pos, count: 90,
    speedRange: [160, 520],
    lifeRange: [0.6, 1.6], maxLife: 1.6,
    sizeRange: [1.4, 2.8],
    hue: c.hue, hueSpread: [-15, 25],
    drag: 1.2,
    angleMode: "random", angleJitter: 0,
  });
  emitBurst(particles, {
    pos: c.pos, count: 40,
    speedRange: [40, 180],
    lifeRange: [1.5, 3.0], maxLife: 3.0,
    sizeRange: [2.0, 3.4],
    hue: c.hue, hueSpread: [-40, 40],
    drag: 0.7,
    angleMode: "random", angleJitter: 0,
  });
};

// count scales with size so a 4-HP big saucer's death feels meatier than a 1-HP small one's.
export const emitAlienExplosion = (particles: ParticleSystem, a: Alien) => {
  const count = a.size === "big" ? 70 : a.size === "medium" ? 48 : 30;
  emitBurst(particles, {
    pos: a.pos, count,
    speedRange: [80, 340],
    lifeRange: [0.5, 1.2], maxLife: 1.2,
    sizeRange: [1, 2.6],
    hue: a.hue, hueSpread: [-15, 25],
    drag: 1.4,
    angleMode: "random", angleJitter: 0,
  });
};

// white = "wasted pod"; tints the destruction differently from the celebratory pickup burst.
// Also used for off-beat gem shots, so accepts any object with a position.
export const emitCanisterPop = (particles: ParticleSystem, c: { pos: Vec }) => {
  emitBurst(particles, {
    pos: c.pos, count: 30,
    speedRange: [120, 320],
    lifeRange: [0.4, 0.9], maxLife: 0.9,
    sizeRange: [1.2, 2.4],
    hue: 0, hueSpread: [0, 0],
    drag: 1.8,
    angleMode: "random", angleJitter: 0,
  });
};

// canister-hue tint makes each pickup kind read visually distinct (vs. white "wasted" burst).
export const emitCanisterPickup = (particles: ParticleSystem, c: Canister) => {
  emitBurst(particles, {
    pos: c.pos, count: 36,
    speedRange: [80, 260],
    lifeRange: [0.5, 1.0], maxLife: 1.0,
    sizeRange: [1.4, 2.6],
    hue: c.hue, hueSpread: [-10, 20],
    drag: 1.6,
    angleMode: "random", angleJitter: 0,
  });
};

// Bigger, slower-fading gold burst for the crystal pickup — reads as a richer
// reward than the standard canister pickup since the player had to spot the
// embedded crystal in the first place.
export const emitGoldCrystalPickup = (particles: ParticleSystem, g: GoldCrystal) => {
  emitBurst(particles, {
    pos: g.pos, count: 56,
    speedRange: [120, 340],
    lifeRange: [0.7, 1.4], maxLife: 1.4,
    sizeRange: [1.6, 3.0],
    hue: g.hue, hueSpread: [-6, 14],
    drag: 1.4,
    angleMode: "random", angleJitter: 0,
  });
};

// uniformly spaced ring reads as a deflected wavefront, not a chaotic kill explosion.
export const emitShieldPop = (particles: ParticleSystem, pos: Vec) => {
  emitBurst(particles, {
    pos, count: 28,
    speedRange: [180, 260],
    lifeRange: [0.35, 0.65], maxLife: 0.65,
    sizeRange: [1.6, 2.4],
    hue: 200, hueSpread: [-8, 12],
    drag: 1.8,
    angleMode: "uniform", angleJitter: 0,
  });
};

// cyan-leaning hue ties debris to the ship's own hull palette so it reads as personal loss.
export const emitShipDebris = (particles: ParticleSystem, pos: Vec) => {
  emitBurst(particles, {
    pos, count: 70,
    speedRange: [60, 280],
    lifeRange: [0.7, 1.6], maxLife: 1.6,
    sizeRange: [1.2, 2.6],
    hue: 195, hueSpread: [-10, 30],
    drag: 1.2,
    angleMode: "random", angleJitter: 0,
  });
};

// Glass-prison shatter: a quick outward ring of pale-blue glass chips +
// a slower expanding cloud of dark purple wisps (the captive's breath
// escaping). Two layers so the impact reads as both "the shell broke"
// and "something just got out".
export const emitGlassPrisonShatter = (particles: ParticleSystem, shards: Shard[], a: Asteroid) => {
  // Physical Shard objects — the prison's shell is real glass that should
  // break into chunks rather than only fading particles.
  for (const s of shatterAsteroid(a)) shards.push(s);
  // (1) Bright glass shards — pale indigo, fast, short-lived.
  emitBurst(particles, {
    pos: a.pos, count: 70,
    speedRange: [180, 480],
    lifeRange: [0.5, 1.1], maxLife: 1.1,
    sizeRange: [1.2, 2.6],
    hue: a.hue, hueSpread: [-12, 18],
    drag: 1.6,
    angleMode: "random", angleJitter: 0,
  });
  // (2) Dark exhale — slow, deep purple wisps. Different drag so they
  // bloom outward and linger after the bright shards have faded.
  emitBurst(particles, {
    pos: a.pos, count: 36,
    speedRange: [40, 140],
    lifeRange: [1.4, 2.4], maxLife: 2.4,
    sizeRange: [2.4, 3.6],
    hue: 290, hueSpread: [-12, 18],
    drag: 0.7,
    angleMode: "random", angleJitter: 0,
  });
};

// Wraith death: no bright sparks — a dispersing cloud of dark purple wisps
// that drift outward then dissolve. Reads as "it came apart" rather than
// "it exploded".
export const emitWraithDeath = (particles: ParticleSystem, a: Asteroid) => {
  emitBurst(particles, {
    pos: a.pos, count: 50,
    speedRange: [60, 200],
    lifeRange: [1.0, 2.2], maxLife: 2.2,
    sizeRange: [2.0, 3.4],
    hue: a.hue, hueSpread: [-16, 24],
    drag: 1.0,
    angleMode: "random", angleJitter: 0,
  });
  // A faint reddish flicker at the centre — the eyes going out.
  emitBurst(particles, {
    pos: a.pos, count: 14,
    speedRange: [40, 120],
    lifeRange: [0.4, 0.9], maxLife: 0.9,
    sizeRange: [1.4, 2.4],
    hue: 0, hueSpread: [-10, 18],
    drag: 1.8,
    angleMode: "random", angleJitter: 0,
  });
};

// outward-radiating sparks sell the shockwave as physical mass, not a pure light effect.
export const emitShockwaveSparks = (particles: ParticleSystem, pos: Vec) => {
  emitBurst(particles, {
    pos, count: 64,
    speedRange: [280, 520],
    lifeRange: [0.5, 1.1], maxLife: 1.1,
    sizeRange: [1.4, 2.6],
    hue: 200, hueSpread: [-10, 20],
    drag: 0.9,
    angleMode: "random", angleJitter: 0,
  });
};
