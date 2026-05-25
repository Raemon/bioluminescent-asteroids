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

// "bassA" / "bassB" are the layered bass-track asteroids: they pulse on a
// shared beat clock, and when hit they emit a "cool initial noise" and split
// into two pieces that loop at twice the parent's tempo. Those split pieces
// can't split further — shooting them destroys them entirely.
//
// "chime", "bell", "warble" are sound-decorator asteroids that behave exactly
// like normal ones but trigger a distinctive musical hit sound.
//
// "tink" is a rare one-shot crystal: spawned occasionally as a small asteroid
// (so it can't split) and emits the sharp glassy "tink" sound on destruction.
// Treat it as a "sometimes-found" treat — if you start seeing tink asteroids
// every wave, lower the per-wave spawn chance in Game.
export type AsteroidKind = "normal" | "bassA" | "bassB" | "chime" | "bell" | "warble" | "tink";

const SIZE_RADIUS: Record<AsteroidSize, number> = {
  large: 56,
  medium: 32,
  small: 18,
};

const SIZE_SCORE: Record<AsteroidSize, number> = {
  large: 20,
  medium: 50,
  small: 100,
};

const KIND_HUE: Partial<Record<AsteroidKind, number>> = {
  bassA: 0,
  bassB: 28,
  chime: 52,
  bell: 285,
  warble: 130,
  tink: 195,
};

// Base interval (seconds) between beats at normal tempo. Half a second = a
// 4/4 quarter at 120 BPM. The two bass kinds share this interval but with
// different phase offsets so they interlock instead of stacking on each beat.
export const BASS_BEAT_INTERVAL = 1.0;
export const BASS_PHASE_OFFSET: Record<"bassA" | "bassB", number> = {
  bassA: 0.0,
  bassB: 0.5,
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
  // For bass kinds, doubles each time the asteroid is hit-and-split. The
  // split children inherit the doubled value so their beats land twice as
  // often. Always 1 for non-bass kinds.
  tempoMultiplier = 1;
  // Game-time (seconds) at which this bass asteroid should fire its next
  // beat. Set by Game when the asteroid is spawned / split. Unused for
  // non-bass kinds.
  nextBeatAt = 0;

  constructor(pos: Vec, vel: Vec, size: AsteroidSize, hue?: number, kind: AsteroidKind = "normal") {
    this.pos = pos;
    this.vel = vel;
    this.size = size;
    this.radius = SIZE_RADIUS[size];
    this.rotation = rand(0, TAU);
    this.rotSpeed = rand(-0.6, 0.6);
    this.kind = kind;
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
    const localAngle = Math.atan2(dy, dx) - this.rotation;
    const surface = this.radiusAtAngle(localAngle);
    return distance < surface + pointRadius;
  }

  hit() {
    this.flashAmount = 1;
  }

  update(dt: number, w: number, h: number) {
    this.rotation += this.rotSpeed * dt;
    this.membranePhase += dt * 0.8;
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
    // Nucleus orbital drift is baked into the sprite so we no longer rotate
    // it here — the per-frame pulse highlight handles the only visible motion.
  }

  scoreValue(): number {
    return SIZE_SCORE[this.size];
  }

  isBass(): boolean {
    return this.kind === "bassA" || this.kind === "bassB";
  }

  split(): Asteroid[] {
    // Bass: large splits once into two medium pieces (no small stage). The
    // medium pieces don't split — shooting them destroys them completely.
    if (this.isBass()) {
      if (this.size !== "large") return [];
      const childSize: AsteroidSize = "medium";
      const childTempo = this.tempoMultiplier * 2;
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 2; i++) {
        const a = Math.atan2(this.vel.y, this.vel.x) + rand(-0.9, 0.9) + (i === 0 ? -1 : 1) * 0.5;
        const speedMag = Math.hypot(this.vel.x, this.vel.y) * rand(1.1, 1.6) + 30;
        const child = new Asteroid({ ...this.pos }, fromAngle(a, speedMag), childSize, this.hue, this.kind);
        child.tempoMultiplier = childTempo;
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
      const speedMag = Math.hypot(this.vel.x, this.vel.y) * rand(1.1, 1.6) + 30;
      fragmentList.push(new Asteroid({ ...this.pos }, fromAngle(a, speedMag), nextSize, this.hue, this.kind));
    }
    return fragmentList;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
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
  const speed = rand(40, 90);
  return new Asteroid(pos, v((dirX / norm) * speed, (dirY / norm) * speed), size, hue, kind);
};
