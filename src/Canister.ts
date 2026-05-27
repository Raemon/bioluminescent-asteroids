import { Vec, v, add, mul, fromAngle, rand, pick, TAU } from "./vec";

// Five powerup kinds, each with its own glyph so the player can read the
// canister at a glance from across the screen. Keeping the list short
// (rather than 10+ kinds) means each one stays familiar after a few waves.
export type PowerupKind = "trident" | "rapid" | "pierce" | "shield" | "slow" | "radar";

// Hue is kept for downstream effects (pickup burst tinting) but the canister
// itself renders pure white so the player reads it as "incoming pod" first
// and only resolves its kind from the glyph.
export const POWERUP_HUE: Record<PowerupKind, number> = {
  trident: 180,
  rapid: 300,
  pierce: 60,
  shield: 200,
  slow: 130,
  radar: 30,
};

const POWERUP_GLYPH: Record<PowerupKind, string> = {
  trident: "T",
  rapid: "R",
  pierce: "P",
  shield: "S",
  slow: "Z",
  radar: "X",
};

export const POWERUP_KINDS: PowerupKind[] = ["trident", "rapid", "pierce", "shield", "slow", "radar"];

export class Canister {
  pos: Vec;
  vel: Vec;
  kind: PowerupKind;
  hue: number;
  radius = 16;
  age = 0;
  alive = true;
  // Three independent tumble axes so the projected silhouette never settles
  // into a flat 2D spin — gives the eye a clear "3D object" read.
  rotX: number;
  rotY: number;
  rotZ: number;
  rotSpeedX: number;
  rotSpeedY: number;
  rotSpeedZ: number;

  constructor(pos: Vec, vel: Vec, kind: PowerupKind) {
    this.pos = pos;
    this.vel = vel;
    this.kind = kind;
    this.hue = POWERUP_HUE[kind];
    this.rotX = rand(0, TAU);
    this.rotY = rand(0, TAU);
    this.rotZ = rand(0, TAU);
    this.rotSpeedX = rand(-2.2, 2.2);
    this.rotSpeedY = rand(-2.2, 2.2);
    this.rotSpeedZ = rand(-1.2, 1.2);
  }

  update(dt: number, w: number, h: number) {
    this.age += dt;
    this.rotX += this.rotSpeedX * dt;
    this.rotY += this.rotSpeedY * dt;
    this.rotZ += this.rotSpeedZ * dt;
    this.pos = add(this.pos, mul(this.vel, dt));
    // Pods drift offscreen once and are gone — no screen-wrap. Generous
    // margin so the fade-out at the edge isn't visibly clipped.
    const margin = this.radius * 4;
    if (
      this.pos.x < -margin ||
      this.pos.x > w + margin ||
      this.pos.y < -margin ||
      this.pos.y > h + margin
    ) {
      this.alive = false;
    }
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    const dx = point.x - this.pos.x;
    const dy = point.y - this.pos.y;
    return Math.hypot(dx, dy) < this.radius + pointRadius;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    const time = t * 0.001;
    const pulse = 0.75 + 0.25 * Math.sin(time * 3 + this.age * 2);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Soft white bloom around the pod.
    const haloGrad = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, this.radius * 3.2);
    haloGrad.addColorStop(0, `rgba(255, 255, 255, ${0.55 * pulse})`);
    haloGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = haloGrad;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius * 3.2, 0, TAU);
    ctx.fill();

    // 3D tumble: define an octahedron's six vertices, rotate them through
    // three axes, then project orthographically. The crossing edges make
    // the tumble legible even when only a few pixels move per frame.
    const r = this.radius * 1.05;
    const verts: [number, number, number][] = [
      [r, 0, 0],
      [-r, 0, 0],
      [0, r, 0],
      [0, -r, 0],
      [0, 0, r],
      [0, 0, -r],
    ];
    const cx = Math.cos(this.rotX), sx = Math.sin(this.rotX);
    const cy = Math.cos(this.rotY), sy = Math.sin(this.rotY);
    const cz = Math.cos(this.rotZ), sz = Math.sin(this.rotZ);
    const projected = verts.map(([x, y, z]) => {
      // Rotate around X
      let y1 = y * cx - z * sx;
      let z1 = y * sx + z * cx;
      // Rotate around Y
      let x2 = x * cy + z1 * sy;
      let z2 = -x * sy + z1 * cy;
      // Rotate around Z
      let x3 = x2 * cz - y1 * sz;
      let y3 = x2 * sz + y1 * cz;
      return { x: x3, y: y3, z: z2 };
    });

    // Edges of the octahedron: each "equator" vertex (±x, ±y) connects to
    // both "poles" (±z) — gives 12 edges total, enough wireframe to read
    // as a solid tumbling shape without becoming visual noise.
    const edges: [number, number][] = [
      [0, 2], [0, 3], [0, 4], [0, 5],
      [1, 2], [1, 3], [1, 4], [1, 5],
      [2, 4], [2, 5], [3, 4], [3, 5],
    ];

    ctx.translate(this.pos.x, this.pos.y);
    ctx.lineWidth = 1.4;
    ctx.shadowColor = "rgba(255, 255, 255, 1)";
    ctx.shadowBlur = 12;
    for (const [a, b] of edges) {
      const va = projected[a];
      const vb = projected[b];
      // Depth fade: edges with a vertex behind the "camera" plane dim a
      // bit so the front faces pop. Cheap fake-shading that still sells
      // the 3D read.
      const depth = (va.z + vb.z) * 0.5;
      const depthAlpha = 0.55 + 0.45 * ((depth + r) / (2 * r));
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.85 * pulse * depthAlpha).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(va.x, va.y);
      ctx.lineTo(vb.x, vb.y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Glyph stays upright (no counter-rotation needed since we never rotated
    // the canvas) so the player can always read which powerup is incoming.
    ctx.fillStyle = `rgba(255, 255, 255, ${0.95 * pulse})`;
    ctx.font = `bold ${Math.round(this.radius * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(255, 255, 255, 1)";
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
  const driftSpeed = rand(60, 110);
  const kind = pick(POWERUP_KINDS);
  return new Canister(pos, fromAngle(driftAngle, driftSpeed), kind);
};
