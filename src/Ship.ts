import { Vec, v } from "./vec";
import { Input } from "./Input";
import { ParticleSystem } from "./Particle";
import { Bullet } from "./Bullet";
import { Sound } from "./Sound";
import { PowerupKind } from "./Canister";
import { BEAT_GRID } from "./game/rhythmConstants";
import { haloVertices, hitDistanceToward } from "./ship/shipHitbox";
import { tickShip } from "./ship/shipPhysics";
import { fireBullets, applyPowerup } from "./ship/shipWeapons";
import { setComboFromValue } from "./ship/shipComboHalo";
import { renderShipBody } from "./ship/shipRender";
import { renderShipReticules } from "./ship/reticule/reticuleRender";
import { ReticuleTarget, TrajectoryTrackMap } from "./ship/reticule/trajectoryPreview";
import { HeadingLock } from "./ship/reticule/headingLockOn";

// Why: BEAT_GRID is re-exported from Game.ts for backwards compatibility; Ship code reads it directly here.
export { BEAT_GRID };

// Why: Ship owns the gameplay state; behavior lives in src/ship/* so each piece reads as one concept.
export class Ship {
  pos: Vec;
  vel: Vec = v(0, 0);
  heading = -Math.PI / 2;
  rotSpeed = 4.6;
  rotRamp = 0;
  thrustPower = 420;
  // Why: drag is 0 so the ship coasts; thrust + retro are the only velocity inputs (Newtonian feel).
  drag = 0;
  maxSpeed = 460;
  radius = 14;
  // Why: outer halo sits past the hull and IS the collision silhouette (matches what the player sees).
  haloOffset = 8;
  // Why: small uniform pad + forward bonus makes head-on collisions slightly more generous than rear hits.
  hitPad = 4;
  hitFrontBonus = 6;
  // Why: conservative bounding radius circumscribes the forward halo tip — use for broad-phase only.
  get hitRadius() { return this.radius * 1.4 + this.haloOffset + this.hitPad + this.hitFrontBonus; }
  alive = true;
  invuln = 2.0;
  thrustOn = false;
  reverseThrustOn = false;
  // Why: timestamp (in seconds, same clock as Game.beatTime) of the most recent frame the player
  // was thrusting. Drives the trajectory-preview fade — line stays solid for 2s after thrust ends,
  // then fades over 1s. -Infinity means "never thrusted" → preview hidden.
  lastThrustActiveAt = -Infinity;
  fireCooldown = 0;
  // Why: one shot per beat by default; reticule previews where it lands at the next beat boundary.
  fireRate = BEAT_GRID;
  bulletSpeed = 620;
  bulletLife = 0.85;
  // Why: trident/rapid/pierce/radar persist for the run; shield is one-shot.
  tridentActive = false;
  rapidActive = false;
  pierceActive = false;
  shieldActive = false;
  radarActive = false;

  // Why: discrete halo tier 0/1/2; intensity eases toward this target for a smooth visual response.
  comboHaloTier = 0;
  comboHaloIntensity = 0;
  // Why: set to 1 by Game on a meaningful combo loss; decays in update to drive the red halo flash.
  comboLossFlash = 0;
  // Why: per-target trajectory state — drives entry-flash phase, fade-out lingering, and pulse phase.
  private trajectoryTracks: TrajectoryTrackMap = new Map();
  // Why: when rotating would sweep the reticule across a trajectory line, the heading sticks to
  // the line until accumulated rotation intent exceeds the escape threshold. null = no active lock.
  headingLock: HeadingLock | null = null;

  constructor(pos: Vec) { this.pos = pos; }

  // Why: silhouette polygon used by both rendering and collision so the visible outline == the hitbox.
  haloVertices(): Array<[number, number]> { return haloVertices(this); }

  // Why: bullets/asteroids query reach in a direction; lets glancing shots that look right actually hit.
  hitDistanceToward(theta: number): number { return hitDistanceToward(this, theta); }

  // Why: combo tier comes from Game's beatCombo via a single setter so HUD and halo stay in sync.
  setCombo(combo: number) { setComboFromValue(this, combo); }

  // Why: kept for callsite compatibility; the simplified halo has no per-beat state to advance.
  tickComboHalo(_dt: number, _beatPulse: number) {}

  // Why: orchestrates a single frame of player control, audio, and motion in one delegated call.
  // `targets` feeds the trajectory-line-lock during rotation — empty array = no lock applied.
  update(
    dt: number, input: Input, particles: ParticleSystem, bullets: Bullet[],
    w: number, h: number, t: number, sound: Sound,
    targets: ReadonlyArray<ReticuleTarget> = [],
  ) {
    tickShip(this, dt, input, particles, bullets, w, h, t, sound, targets);
  }

  // Why: trident spreads + on-beat tagging happens in Game; the ship just emits the right bullet count.
  fire(bullets: Bullet[]) { fireBullets(this, bullets); }

  // Why: powerup pickup goes through one entry point so the active-flag rules stay in one file.
  applyPowerup(kind: PowerupKind) { applyPowerup(this, kind); }

  // Why: aim disc + radar cone + trajectory previews share one composition — single delegate.
  renderReticules(
    ctx: CanvasRenderingContext2D, beatGrid: number, w: number, h: number,
    targets: ReadonlyArray<ReticuleTarget> = [], beatTime: number = 0,
  ) {
    renderShipReticules(this, { trajectoryTracks: this.trajectoryTracks }, ctx, beatGrid, w, h, targets, beatTime);
  }

  // Why: hull + thrust + retro + shield + combo halo all composite together in one save/restore block.
  render(ctx: CanvasRenderingContext2D, t: number, beatPulse: number = 0) {
    renderShipBody(ctx, this, t, beatPulse);
  }
}
