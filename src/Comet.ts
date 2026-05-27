import { Vec, v, add, mul, fromAngle, rand, TAU } from "./vec";
import { Trail } from "./Trail";

// Ethereal background event that wanders across the field over ~25-40 seconds
// playing a slow melodic phrase locked to the bass-beat grid. Doesn't collide
// with anything — it's purely an audio/visual flourish that decorates the
// rhythm bed.
//
// The melody (see MELODY_NOTES in Sound.ts) cycles a C-major motif that
// harmonises with the bassteroid voices (rooted at C2) and the broken-open
// bassteroid drones (C-major triad bed). One note fires per BEAT_GRID
// (every 0.5s), so the comet weaves a quarter-note line over whatever
// bass/drone pattern is currently sounding.
export class Comet {
  pos: Vec;
  vel: Vec;
  age = 0;
  alive = true;
  // Trail of past positions for the streak. Newest at index 0.
  trail: { pos: Vec; age: number }[] = [];
  // The current step in the melody. Advanced by the Game on each BEAT_GRID
  // boundary; passed back to Sound.playCometNote so the timbre/octave can
  // be modulated per step.
  noteIndex = 0;
  // Bass-clock time (seconds) at which this comet's next melody note should
  // fire. Set when the comet is spawned to the next BEAT_GRID boundary, then
  // advanced by exactly one BEAT_GRID per note so the melody stays locked
  // to the bass grid for the comet's whole life.
  nextNoteBeatTime = 0;
  // Total lifetime (seconds) — set at spawn so brightness() and the audio
  // fade can both reference it.
  lifetime = 24;
  // Hue drives the colour of the streak and bloom. Picked at spawn from a
  // narrow cyan/violet band so multiple comets in successive waves all read
  // as the same "musical visitor" species.
  hue: number;
  // Shimmer-pad glow trail, layered behind the line-streak head. Multi-LFO
  // pulse mode produces the glittery breathing that visually echoes the
  // shimmer-pad audio. See Trail.ts.
  glowTrail: Trail;
  // How long the comet visibly fades in and out. Used for both the streak
  // bloom and the audio shimmer pad amplitude.
  static readonly FADE_IN = 1.6;
  static readonly FADE_OUT = 2.0;

  // Hit radius for the head. Roughly matches the bright pin-prick + halo so
  // a bullet that visually clips the head reads as a hit. The visual halo
  // extends a bit further but isn't part of the body — only the burning
  // core counts.
  static readonly HIT_RADIUS = 24;
  readonly radius = Comet.HIT_RADIUS;

  constructor(pos: Vec, vel: Vec, hue: number) {
    this.pos = pos;
    this.vel = vel;
    this.hue = hue;
    this.glowTrail = new Trail(hue, 18, 0.32, "shimmer", 1.6);
  }

  collidesWith(p: Vec, r: number): boolean {
    const dx = this.pos.x - p.x;
    const dy = this.pos.y - p.y;
    return dx * dx + dy * dy <= (this.radius + r) * (this.radius + r);
  }

  // Brightness envelope: rises during FADE_IN, holds at 1, eases out during
  // the last FADE_OUT seconds of life. The audio shimmer pad uses the same
  // curve so the comet's visual and sonic presence track together.
  brightness(): number {
    const inT = Math.min(1, this.age / Comet.FADE_IN);
    const remaining = Math.max(0, this.lifetime - this.age);
    const outT = Math.min(1, remaining / Comet.FADE_OUT);
    return Math.min(inT, outT);
  }

  update(dt: number, w: number, h: number) {
    this.age += dt;
    this.pos = add(this.pos, mul(this.vel, dt));
    this.glowTrail.update(dt, this.pos.x, this.pos.y);

    // Sample the current position every frame so the trail is dense enough
    // to read as a smooth streak. Trim the tail when the oldest sample has
    // outlived its visible window.
    this.trail.unshift({ pos: { ...this.pos }, age: 0 });
    for (const t of this.trail) t.age += dt;
    const TAIL_LIFE = 1.1;
    while (this.trail.length > 0 && this.trail[this.trail.length - 1].age > TAIL_LIFE) {
      this.trail.pop();
    }

    // Die once the lifetime runs out OR when we drift well off-screen. The
    // FADE_OUT window in brightness() means the visible streak has already
    // faded by the time we mark alive=false.
    if (this.age >= this.lifetime) {
      this.alive = false;
      return;
    }
    const margin = 240;
    if (
      this.pos.x < -margin || this.pos.x > w + margin ||
      this.pos.y < -margin || this.pos.y > h + margin
    ) {
      // Comet has drifted off the field. Let the music tail keep playing
      // until the lifetime expires — the Sound side handles fade — but stop
      // updating the trail so we don't accumulate samples in negative space.
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    const b = this.brightness();
    if (b <= 0) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Tail: gradient of soft strokes from the current head back through the
    // recorded positions. Each segment fades with age so the trail tapers
    // to nothing rather than ending in a hard edge.
    const TAIL_LIFE = 1.1;
    for (let i = 0; i < this.trail.length - 1; i++) {
      const a = this.trail[i];
      const c = this.trail[i + 1];
      const aT = 1 - a.age / TAIL_LIFE;
      const segAlpha = Math.max(0, aT) * 0.55 * b;
      if (segAlpha <= 0.002) continue;
      const width = 1.5 + 7 * Math.max(0, aT);
      ctx.strokeStyle = `hsla(${this.hue}, 95%, 78%, ${segAlpha.toFixed(3)})`;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a.pos.x, a.pos.y);
      ctx.lineTo(c.pos.x, c.pos.y);
      ctx.stroke();
    }

    // Head bloom — soft halo that pulses subtly with the melody step so the
    // visual feels coupled to the audio. Pulse amplitude is gentle (±15%)
    // because the bass kit already supplies the strong rhythmic accents.
    const pulse = 0.85 + 0.15 * Math.sin(this.noteIndex * 1.3 + this.age * 2);
    const radius = 26 * pulse;
    const halo = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, radius * 2.6);
    halo.addColorStop(0, `hsla(${this.hue}, 100%, 92%, ${(0.85 * b).toFixed(3)})`);
    halo.addColorStop(0.4, `hsla(${this.hue}, 95%, 80%, ${(0.35 * b).toFixed(3)})`);
    halo.addColorStop(1, `hsla(${this.hue}, 95%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, radius * 2.6, 0, TAU);
    ctx.fill();

    // Bright pin-prick at the head — sells the "burning ice" core. Pure
    // white centre so the hue reads as bloom around a hot point.
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * b).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, radius * 0.32, 0, TAU);
    ctx.fill();

    ctx.restore();
  }
}

// Spawn a comet drifting in from one edge across the screen. Velocity is
// slow (≈ 1 screen-width per ~12 seconds) so the comet feels like a
// distant celestial object rather than a fast-moving threat. The exact
// path is randomised but always crosses near (not through) the centre so
// the player can see it during play.
export const spawnComet = (w: number, h: number): Comet => {
  // Pick an off-screen origin and a target somewhere in the central band,
  // then derive velocity to traverse between them in ~14-18 seconds.
  const edge = Math.floor(Math.random() * 4);
  const offset = 80;
  let from: Vec;
  if (edge === 0) from = v(-offset, rand(h * 0.15, h * 0.85));
  else if (edge === 1) from = v(w + offset, rand(h * 0.15, h * 0.85));
  else if (edge === 2) from = v(rand(w * 0.15, w * 0.85), -offset);
  else from = v(rand(w * 0.15, w * 0.85), h + offset);

  const target = v(rand(w * 0.25, w * 0.75), rand(h * 0.25, h * 0.75));
  const angle = Math.atan2(target.y - from.y, target.x - from.x);
  const traversalSeconds = rand(14, 18);
  const distance = Math.hypot(target.x - from.x, target.y - from.y) * 2.4;
  const speed = distance / traversalSeconds;
  const vel = fromAngle(angle, speed);

  // Narrow band of cool hues (cyan → violet) keeps every comet feeling
  // like the same celestial visitor across runs.
  const hue = rand(180, 290);
  return new Comet(from, vel, hue);
};
