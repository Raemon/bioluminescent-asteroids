import { Vec, addScaledMut, wrapMut, TAU } from "./vec";
import { drawGlow } from "./glow";

// Damage dealt by a non-rhythm bullet — enough to one-shot a small asteroid
// but takes the full size table (4/2/1) of hits to chew through a large.
export const BULLET_DAMAGE_BASE = 1;
// Damage dealt by an on-beat bullet — 4× the base, sized to one-shot any
// non-bass asteroid and meaningfully crack a bassteroid (which carries a 4×
// HP multiplier of its own, so an on-beat shot does a "normal hit" against
// armour).
export const BULLET_DAMAGE_BEAT = 4;
// Damage dealt by a boosted on-beat bullet — fired while the yellow combo
// halo is up (combo ≥ 4). Doubles the on-beat damage to reward the streak.
export const BULLET_DAMAGE_BEAT_BOOSTED = 8;

export class Bullet {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  // Base radius for the visible core. Collision uses hitRadius(), which is
  // larger so shots inside the glow register as hits.
  radius = 1.8;
  trail: Vec[] = [];
  // True when fired within the on-beat window. Drives a deeper-blue, larger
  // glow so the player can see at a glance that the shot landed on the grid,
  // and is read by Game on collision to apply the combo score multiplier.
  // Also bumps the damage from BULLET_DAMAGE_BASE to BULLET_DAMAGE_BEAT.
  onBeat = false;
  // True when this on-beat bullet was fired while the yellow combo halo was
  // up (combo ≥ 4). Renders yellow instead of blue and deals 2× the on-beat
  // damage so the gold-tier streak feels lethal as well as visible.
  boosted = false;
  // True when fired at combo ≥ 8. Renders as a tight white shot and flies
  // twice as far — same hitbox/core as the yellow tier, but sharper-looking
  // and with extended reach so the streak feels like a longer arm.
  superBoosted = false;
  // Set by Ship.fire when the player has the pierce powerup active. Game's
  // collision pass keeps a piercing bullet alive on hit instead of consuming
  // it, so a single shot can punch through a row of asteroids.
  pierce = false;
  // beatTime (seconds since game start) at which this bullet was fired.
  // Recorded by Game when stamping new bullets so debug logging at hit time
  // can report the original fire offset, not just the impact offset.
  firedAtBeatTime = 0;
  // life-remaining threshold below which the bullet fades to 0 opacity. Set by
  // shipWeapons at fire-time to the gap between maxLife and the farthest beat
  // reticule, so the visible bullet dims out across the post-reticule tail
  // where any hit would no longer land on a beat. 0 = no fade.
  fadeStartLife = 0;

  constructor(pos: Vec, vel: Vec, life: number) {
    this.pos = { ...pos };
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
  }

  damage(): number {
    if (this.boosted) return BULLET_DAMAGE_BEAT_BOOSTED;
    return this.onBeat ? BULLET_DAMAGE_BEAT : BULLET_DAMAGE_BASE;
  }

  // Visual core radius. On-beat shots render larger; hitRadius() scales with
  // this so the collision box matches the visible glow.
  effectiveRadius(): number {
    return this.onBeat ? this.radius * 2.38 : this.radius;
  }

  // Collision radius — larger than the visible core so glancing shots that
  // look like they should connect (inside the glow) actually register.
  hitRadius(): number {
    return this.effectiveRadius() * 2.5;
  }

  update(dt: number, w: number, h: number) {
    this.life -= dt;
    this.trail.push({ ...this.pos });
    if (this.trail.length > 8) this.trail.shift();
    addScaledMut(this.pos, this.vel, dt);
    wrapMut(this.pos, w, h);
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const rangeAlpha = this.fadeStartLife > 0 && this.life < this.fadeStartLife
      ? Math.max(0, this.life / this.fadeStartLife)
      : 1;
    // Super-boosted (combo ≥ 8): white — saturation 0 makes hue irrelevant.
    // Boosted on-beat: gold (hue 45) to match the tier-2 combo halo.
    // On-beat: deep saturated blue (hue 220) — sells "weightier" rhythm shot.
    // Pierce: yellow. Non-beat: pale cyan, smaller and quieter visually.
    const trailHue = this.boosted ? 45 : this.onBeat ? 220 : this.pierce ? 60 : 180;
    const headHue = this.boosted ? 48 : this.onBeat ? 222 : this.pierce ? 60 : 180;
    const trailAlphaScale = this.onBeat ? 0.85 : 0.4;
    const headAlpha = this.onBeat ? 1.0 : 0.75;
    // super-boosted (combo ≥ 8) keeps the yellow-tier core size but tightens
    // the halo (6 vs 10) for a sharper, more pointed read.
    const headRadiusMul = this.superBoosted ? 6 : this.onBeat ? 10 : 6;
    const trailRadiusMul = this.superBoosted ? 3 : 5;
    const coreRadius = this.effectiveRadius();
    for (let i = 0; i < this.trail.length; i++) {
      const segmentT = i / this.trail.length;
      const p = this.trail[i];
      const r = coreRadius * segmentT * 1.5;
      drawGlow(ctx, p.x, p.y, r * trailRadiusMul, trailHue, trailAlphaScale * segmentT * rangeAlpha, this.superBoosted);
    }

    drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul, headHue, headAlpha * rangeAlpha, this.superBoosted);
    ctx.globalAlpha = rangeAlpha;
    // Bright core dot — for on-beat use a near-white blue-tinted highlight so
    // the deep-blue halo reads as the carrier and the core still pops.
    ctx.fillStyle = this.superBoosted
      ? "hsla(0, 0%, 100%, 1)"
      : this.boosted
        ? "hsla(50, 100%, 90%, 1)"
        : this.onBeat
          ? "hsla(220, 100%, 85%, 1)"
          : this.pierce
            ? "hsla(60, 100%, 96%, 1)"
            : "hsla(180, 100%, 98%, 1)";
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, coreRadius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
