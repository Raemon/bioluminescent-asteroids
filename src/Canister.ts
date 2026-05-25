import { Vec, v, add, mul, fromAngle, wrap, rand, pick, TAU } from "./vec";
import { drawGlow } from "./glow";

// Five powerup kinds, each with its own hue + glyph so the player can read
// the canister at a glance from across the screen. Keeping the list short
// (rather than 10+ kinds) means each one stays familiar after a few waves.
export type PowerupKind = "trident" | "rapid" | "pierce" | "shield" | "slow";

export const POWERUP_HUE: Record<PowerupKind, number> = {
  trident: 180,
  rapid: 300,
  pierce: 60,
  shield: 200,
  slow: 130,
};

// Single capital letter rendered inside the capsule. Deliberately ASCII so
// it stays sharp at any zoom and doesn't need a custom font asset.
const POWERUP_GLYPH: Record<PowerupKind, string> = {
  trident: "T",
  rapid: "R",
  pierce: "P",
  shield: "S",
  slow: "Z",
};

export const POWERUP_KINDS: PowerupKind[] = ["trident", "rapid", "pierce", "shield", "slow"];

export class Canister {
  pos: Vec;
  vel: Vec;
  kind: PowerupKind;
  hue: number;
  radius = 16;
  age = 0;
  rotation: number;
  rotSpeed: number;

  constructor(pos: Vec, vel: Vec, kind: PowerupKind) {
    this.pos = pos;
    this.vel = vel;
    this.kind = kind;
    this.hue = POWERUP_HUE[kind];
    this.rotation = rand(0, TAU);
    this.rotSpeed = rand(-0.6, 0.6);
  }

  update(dt: number, w: number, h: number) {
    this.age += dt;
    this.rotation += this.rotSpeed * dt;
    this.pos = wrap(add(this.pos, mul(this.vel, dt)), w, h);
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    const dx = point.x - this.pos.x;
    const dy = point.y - this.pos.y;
    return Math.hypot(dx, dy) < this.radius + pointRadius;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    const time = t * 0.001;
    const pulse = 0.7 + 0.3 * Math.sin(time * 3 + this.age * 2);
    const beckon = 0.8 + 0.2 * Math.sin(time * 1.7);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    drawGlow(ctx, this.pos.x, this.pos.y, this.radius * 3.4, this.hue, 0.55 * beckon);
    drawGlow(ctx, this.pos.x, this.pos.y, this.radius * 1.6, this.hue, 0.85 * pulse);

    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation * 0.4);

    const capsuleW = this.radius * 1.4;
    const capsuleH = this.radius * 0.85;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = `hsla(${this.hue}, 100%, 80%, ${0.9 * pulse})`;
    ctx.shadowColor = `hsla(${this.hue}, 100%, 70%, 1)`;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(-capsuleW, -capsuleH, capsuleW * 2, capsuleH * 2, capsuleH);
    } else {
      ctx.rect(-capsuleW, -capsuleH, capsuleW * 2, capsuleH * 2);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = `hsla(${this.hue}, 100%, 25%, 0.4)`;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(-capsuleW, -capsuleH, capsuleW * 2, capsuleH * 2, capsuleH);
    } else {
      ctx.rect(-capsuleW, -capsuleH, capsuleW * 2, capsuleH * 2);
    }
    ctx.fill();

    ctx.rotate(-this.rotation * 0.4);
    ctx.fillStyle = `hsla(${this.hue}, 100%, 96%, ${0.95 * pulse})`;
    ctx.font = `bold ${Math.round(this.radius * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = `hsla(${this.hue}, 100%, 80%, 1)`;
    ctx.shadowBlur = 8;
    ctx.fillText(POWERUP_GLYPH[this.kind], 0, 1);

    ctx.restore();
  }
}

export const spawnCanister = (w: number, h: number, shipPos: Vec): Canister => {
  // Try a handful of random positions and pick the first that's a safe
  // distance from the ship; fall back to the last candidate if every roll
  // happened to land close (vanishingly rare).
  let pos = v(rand(60, w - 60), rand(60, h - 60));
  const placementAttempts = [0, 1, 2, 3, 4, 5];
  for (const _ of placementAttempts) {
    pos = v(rand(60, w - 60), rand(60, h - 60));
    const dx = pos.x - shipPos.x;
    const dy = pos.y - shipPos.y;
    if (Math.hypot(dx, dy) > 220) break;
  }
  const driftAngle = rand(0, TAU);
  const driftSpeed = rand(10, 25);
  const kind = pick(POWERUP_KINDS);
  return new Canister(pos, fromAngle(driftAngle, driftSpeed), kind);
};
