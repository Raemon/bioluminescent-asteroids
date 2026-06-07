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

// Seconds over which an on-beat flash's ballooned core shrinks back to its
// resting size. The flash itself lasts longer (FLASH_DURATION_SEC in
// gameUpdate); this shorter tail makes the envelope hold at full size for the
// first half of the flash and decay over the final 0.06s.
const CORE_FLASH_TAIL_SEC = 0.06;
// Peak extra core growth at full flash — the bright core swells to
// (1 + CORE_FLASH_GROWTH)× its resting radius when flashEnv = 1.
const CORE_FLASH_GROWTH = 2.0;
// Fraction of the painted head-glow radius out to which the hitbox extends.
// The glow gradient (see glow.ts) holds a solid-looking blob until its
// addColorStop(0.6, …0.15) knot, then fades to fully transparent over the
// final stretch. 0.6 puts the hitbox right at that knot — the edge of the
// visibly-glowing zone — so a shot connects anywhere the bullet reads as lit,
// without claiming the faint outer halo.
const GLOW_VISIBLE_FRACTION = 0.6;

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
  // True when fired at combo ≥ 12. Renders as a tight white shot and flies
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
  // Snapshot of which hover rings had finished their lock animation at fire-time (index 0 =
  // 1-beat slot, 1 = 2-beat, ...). Any true entry makes this bullet drift-eligible — the
  // on-beat rhythm-grace is already enforced separately at fire-time.
  driftLockedSlots: boolean[] = [];
  // counts the integer-beat reticule lines the bullet has already crossed (incremented by
  // gameUpdate). Each new crossing samples the rhythm window; if on-beat, flashTimer fires.
  reticuleCrossings = 0;
  // seconds of white-flash remaining — set when a crossing happens on-beat, decays in update().
  flashTimer = 0;

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

  // True when this on-beat hit should award the drift-shot 4× bonus: any
  // hover ring that finished its lock animation before fire-time grants
  // drift eligibility for this bullet. The on-beat rhythm-grace window is
  // already enforced by the fire-time onBeat check, so once a lock exists
  // any hit by this bullet pays out — matching "if you got the lock
  // animation, you should be able to land a drift shot".
  driftEligibleAtHit(): boolean {
    for (let i = 0; i < this.driftLockedSlots.length; i++) {
      if (this.driftLockedSlots[i]) return true;
    }
    return false;
  }

  // Visual core radius. On-beat shots render larger; hitRadius() scales with
  // this so the collision box matches the visible glow.
  effectiveRadius(): number {
    return this.onBeat ? this.radius * 2.38 : this.radius;
  }

  // Radius of the bright painted core dot. Balloons during an on-beat flash
  // and settles back over CORE_FLASH_TAIL_SEC. render() paints exactly this,
  // and hitRadius() reuses it so the collision box tracks the visible core's
  // growth instead of duplicating the size math.
  coreDrawRadius(): number {
    if (this.flashTimer <= 0) return this.effectiveRadius();
    const flashEnv = Math.min(1, this.flashTimer / CORE_FLASH_TAIL_SEC);
    return this.effectiveRadius() * (1 + CORE_FLASH_GROWTH * flashEnv);
  }

  // Multiplier on the core radius for the painted head-glow halo. render()
  // draws the glow at effectiveRadius() × this, and hitRadius() reuses it so
  // the collision box scales with the glow rather than duplicating the number.
  // super-boosted (combo ≥ 12) keeps the yellow-tier core size but tightens the
  // halo (6 vs 10) for a sharper, more pointed read.
  headGlowRadiusMul(): number {
    return this.superBoosted ? 6 : this.onBeat ? 10 : 6;
  }

  // Collision radius — reaches out to the edge of the visibly-glowing zone
  // (GLOW_VISIBLE_FRACTION of the painted head-glow radius) so a shot connects
  // anywhere the bullet reads as lit. Never smaller than the actual painted
  // core (coreDrawRadius), which balloons when the bullet flashes at a beat
  // reticule, so the player's read of "I'm clearly inside the bullet" always
  // lands.
  hitRadius(): number {
    const glowVisibleRadius = this.effectiveRadius() * this.headGlowRadiusMul() * GLOW_VISIBLE_FRACTION;
    return Math.max(glowVisibleRadius, this.coreDrawRadius());
  }

  update(dt: number, w: number, h: number) {
    this.life -= dt;
    if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);
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
    // Super-boosted (combo ≥ 12): white — saturation 0 makes hue irrelevant.
    // Boosted on-beat: gold (hue 45) to match the tier-2 combo halo.
    // On-beat: deep saturated blue (hue 220) — sells "weightier" rhythm shot.
    // Pierce: yellow. Non-beat: pale cyan, smaller and quieter visually.
    const flashing = this.flashTimer > 0;
    const trailHue = this.boosted ? 45 : this.onBeat ? 220 : this.pierce ? 60 : 180;
    const headHue = this.boosted ? 48 : this.onBeat ? 222 : this.pierce ? 60 : 180;
    const trailAlphaScale = this.onBeat ? 0.85 : 0.4;
    const headAlpha = this.onBeat ? 1.0 : 0.75;
    const headRadiusMul = this.headGlowRadiusMul();
    const trailRadiusMul = this.superBoosted ? 3 : 5;
    const coreRadius = this.effectiveRadius();
    for (let i = 0; i < this.trail.length; i++) {
      const segmentT = i / this.trail.length;
      const p = this.trail[i];
      const r = coreRadius * segmentT * 1.5;
      drawGlow(ctx, p.x, p.y, r * trailRadiusMul, trailHue, trailAlphaScale * segmentT * rangeAlpha, this.superBoosted);
    }

    drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul, headHue, headAlpha * rangeAlpha, this.superBoosted || flashing);
    if (flashing) {
      // sharp attack, tail-off — peak brightness lands on the first frame of the flash.
      const flashEnv = Math.min(1, this.flashTimer / CORE_FLASH_TAIL_SEC);
      // outer halo: huge soft bloom so the flash reads from across the screen.
      drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul * 3.0, 0, 0.7 * flashEnv * rangeAlpha, true);
      // mid bloom: stacked twice for extra punch where the lighter composite peaks.
      drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul * 1.8, 0, 1.0 * flashEnv * rangeAlpha, true);
      drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul * 1.2, 0, 1.0 * flashEnv * rangeAlpha, true);
    }
    ctx.globalAlpha = rangeAlpha;
    // Bright core dot — for on-beat use a near-white blue-tinted highlight so
    // the deep-blue halo reads as the carrier and the core still pops.
    ctx.fillStyle = flashing
      ? "hsla(0, 0%, 100%, 1)"
      : this.superBoosted
      ? "hsla(0, 0%, 100%, 1)"
      : this.boosted
        ? "hsla(50, 100%, 90%, 1)"
        : this.onBeat
          ? "hsla(220, 100%, 85%, 1)"
          : this.pierce
            ? "hsla(60, 100%, 96%, 1)"
            : "hsla(180, 100%, 98%, 1)";
    const coreDrawRadius = this.coreDrawRadius();
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, coreDrawRadius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
