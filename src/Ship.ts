import { Vec, v } from "./vec";
import { IInput } from "./Input";
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
import { renderShipReticules, ReticuleHoverProbe } from "./ship/reticule/reticuleRender";
import { ReticuleTarget, TrajectoryTrackMap } from "./ship/reticule/trajectoryPreview";

// BEAT_GRID is re-exported from Game.ts for backwards compatibility; Ship code reads it directly here.
export { BEAT_GRID };

// Ship owns the gameplay state; behavior lives in src/ship/* so each piece reads as one concept.
export class Ship {
  pos: Vec;
  vel: Vec = v(0, 0);
  heading = -Math.PI / 2;
  rotTapRate = 0.05; // slow turn rate while inside the tap window
  rotTapHoldTime = 0.04; // hold time before ramping past tap rate
  rotRampTime = 0.15 // blend time from tap rate to full rate
  rotMaxSpeed = 4; // steady turn rate once fully ramped
  rotInertia = false; // spin coasts on release instead of stopping
  rotVel = 0; // current angular velocity
  rotHoldTime = 0; // how long the turn key has been held
  rotHeldDir = 0; // turn direction last frame; reset ramp on flip
  thrustPower = 420;
  thrustRamp = 0;
  // drag is 0 so the ship coasts; thrust + retro are the only velocity inputs (Newtonian feel).
  drag = 0;
  maxSpeed = 460;
  radius = 14;
  // outer halo sits past the hull and IS the collision silhouette (matches what the player sees).
  baseHaloOffset = 8;
  get haloOffset() { return this.baseHaloOffset; }
  // shield draws an additional ring this far outside the ship's normal perimeter (purely cosmetic).
  shieldRingOffset = 12;
  // small uniform pad + forward bonus makes head-on collisions slightly more generous than rear hits.
  hitPad = 4;
  hitFrontBonus = 6;
  // conservative bounding radius circumscribes the forward halo tip — use for broad-phase only.
  get hitRadius() { return this.radius * 1.4 + this.haloOffset + this.hitPad + this.hitFrontBonus; }
  alive = true;
  invuln = 2.0;
  thrustOn = false;
  reverseThrustOn = false;
  // port = Z (accelerate left of heading), starboard = X (accelerate right of heading).
  portThrustOn = false;
  starboardThrustOn = false;
  // timestamp (in seconds, same clock as Game.beatTime) of the most recent frame the player
  // was thrusting. Drives the trajectory-preview fade — line stays solid for 2s after thrust ends,
  // then fades over 1s. -Infinity means "never thrusted" → preview hidden.
  lastThrustActiveAt = -Infinity;
  fireCooldown = 0;
  // one shot per beat by default; reticule previews where it lands at the next beat boundary.
  fireRate = BEAT_GRID;
  bulletSpeed = 620;
  bulletLife = 0.85;
  // prong/rapid/pierce/radar/longshot persist for the run; shield is one-shot.
  // prongCount stacks: each upgrade adds one more prong (and one more bullet).
  prongCount = 0;
  get prongActive() { return this.prongCount > 0; }
  rapidActive = false;
  pierceActive = false;
  shieldActive = false;
  radarActive = false;
  longshotActive = false;
  sideEnginesActive = false;
  lasershotActive = false;
  // Laser-shot charge state. Active while the player holds fire under the
  //   lasershot upgrade; release fires a beam dealing 1 + numChargedDots damage.
  //   See game/laserShot.ts for the charge/release logic.
  laserChargeActive = false;
  laserChargeStartBeatTime = 0;
  laserLastDotIndexFired = -1;
  // Set when an off-beat fire press is rejected so the fail sound only plays
  //   once per hold — cleared when the player releases and re-presses.
  laserChargeFailedThisHold = false;

  // discrete halo tier 0/1/2; intensity eases toward this target for a smooth visual response.
  comboHaloTier = 0;
  comboHaloIntensity = 0;
  // set to 1 by Game on a meaningful combo loss; decays in update to drive the red halo flash.
  comboLossFlash = 0;
  // per-target trajectory state — drives entry-flash phase, fade-out lingering, and pulse phase.
  private trajectoryTracks: TrajectoryTrackMap = new Map();
  // persists across frames so the 8th-note hover ring can fill in over a continuous hover.
  //   Public so the tutorial can read hover duration for its "hold the reticule" gate.
  //   completionBeatTime stamps when the ring first reaches the lock threshold so the
  //   completion flare (visual) and the octave-up companion hum (audio) fire once on the
  //   rising edge and persist for as long as the hover lasts.
  // One ring state per reachable on-beat slot (index 0 = 1-beat, index 1 = 2-beat, ...).
  //   Grown lazily by the renderer as longshot/superBoosted/etc. extend bullet range.
  //   hoverDotRingState aliases slot-1 so the tutorial's drift/hold gate keeps reading the
  //   same field it always has.
  //   zoneEnterBeatTime stamps when the reticule first entered the wider 75px "approach"
  //   zone for this slot (cleared on leaving), driving the soft outer hum + the contracting
  //   approach ring; distinct from hoverStartBeatTime, which only arms on the tight target area.
  hoverDotRingStates: Array<{
    hoverStartBeatTime: number | null;
    completionBeatTime: number | null;
    zoneEnterBeatTime: number | null;
    fadeOutStartTime: number | null;
    lastRingCenter: { x: number; y: number } | null;
  }> = [{ hoverStartBeatTime: null, completionBeatTime: null, zoneEnterBeatTime: null, fadeOutStartTime: null, lastRingCenter: null }];
  get hoverDotRingState() { return this.hoverDotRingStates[0]; }

  constructor(pos: Vec) { this.pos = pos; }

  // silhouette polygon used by both rendering and collision so the visible outline == the hitbox.
  haloVertices(): Array<[number, number]> { return haloVertices(this); }

  // bullets/asteroids query reach in a direction; lets glancing shots that look right actually hit.
  hitDistanceToward(theta: number): number { return hitDistanceToward(this, theta); }

  // combo tier comes from Game's beatCombo via a single setter so HUD and halo stay in sync.
  setCombo(combo: number) { setComboFromValue(this, combo); }

  // kept for callsite compatibility; the simplified halo has no per-beat state to advance.
  tickComboHalo(_dt: number, _beatPulse: number) {}

  // orchestrates a single frame of player control, audio, and motion in one delegated call.
  update(
    dt: number, input: IInput, particles: ParticleSystem, bullets: Bullet[],
    w: number, h: number, t: number, sound: Sound,
  ) {
    tickShip(this, dt, input, particles, bullets, w, h, t, sound);
  }

  // prong spreads + on-beat tagging happens in Game; the ship just emits the right bullet count.
  fire(bullets: Bullet[]) { fireBullets(this, bullets); }

  // powerup pickup goes through one entry point so the active-flag rules stay in one file.
  applyPowerup(kind: PowerupKind) { applyPowerup(this, kind); }

  // aim disc + radar cone + trajectory previews share one composition — single delegate.
  renderReticules(
    ctx: CanvasRenderingContext2D, beatGrid: number, w: number, h: number,
    targets: ReadonlyArray<ReticuleTarget> = [], beatTime: number = 0, doubletime: boolean = false,
    tutorialHighlight: boolean = false, sound: Sound | null = null, audioBeatTime: number = beatTime,
    superBoosted: boolean = false,
    hoverProbes: ReadonlyArray<ReticuleHoverProbe> = [],
  ) {
    renderShipReticules(this, { trajectoryTracks: this.trajectoryTracks, hoverDotRings: this.hoverDotRingStates }, ctx, beatGrid, w, h, targets, beatTime, doubletime, tutorialHighlight, sound, audioBeatTime, superBoosted, hoverProbes);
  }

  // hull + thrust + retro + shield + combo halo all composite together in one save/restore block.
  render(ctx: CanvasRenderingContext2D, t: number, beatPulse: number = 0) {
    renderShipBody(ctx, this, t, beatPulse);
  }
}
