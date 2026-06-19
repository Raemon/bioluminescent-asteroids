import type { Game } from "../Game";
import type { Vec } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { currentBeatPulse, currentBeatFlash, comboGrid } from "./rhythmGate";
import { renderTrails } from "./trailsRender";
import { renderPopups } from "./popups";
import { renderBassLightnings } from "./bassLightning";
import { computeConeFrame } from "../ship/reticule/coneGeometry";
import { pickCenterMostTargetForFocus, ReticuleTarget } from "../ship/reticule/trajectoryPreview";
import { renderShipTrajectoryPreview } from "../ship/shipTrajectoryPreview";
import { renderLasers, renderLaserChargeDots, renderLaserAmbientFlash } from "./laserShot";
import { renderBossBeams } from "./bossBeam";
import { renderSlowMoTimerBar } from "./slowMoTimerBar";
import { rng } from "./rng";

// shake is purely cosmetic; isolate its math so render() reads top-down.
const applyScreenShake = (game: Game): { shakeX: number; shakeY: number } => {
  if (game.shake <= 0) return { shakeX: 0, shakeY: 0 };
  game.shakeSeed += 1;
  return {
    shakeX: (rng() - 0.5) * game.shake * 10,
    shakeY: (rng() - 0.5) * game.shake * 10,
  };
};

// deep-space backdrop has to repaint every frame or shake/clearRect leaves trails.
const paintBackdrop = (game: Game) => {
  const { ctx, w, h } = game;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#02030a";
  ctx.fillRect(0, 0, w, h);
};

// starfield + pulsar are the "static" layers; everything else sits on top of them.
// The starfield reads the pulsar's camera view so its parallax + roll stay locked
// to the pulsar's dolly — the whole background reads as one coherent camera move.
const paintBackgroundLayers = (game: Game) => {
  game.starfield.render(game.ctx, game.time, game.pulsar.cameraView());
  game.pulsar.render(game.ctx);
};

// ctx.filter = brightness(...) is implemented as a full-canvas pixel pass on most browsers
// and caused noticeable per-frame lag when several focusable bodies were on screen. Replace it
// with a single additive radial-gradient disc painted on top of the focused target — every other
// entity already uses globalCompositeOperation = "lighter", so an extra additive splash reads
// as "this one is glowing brighter" without touching any sprite pipeline.
const FOCUS_GLOW_RADIUS_MULT = 1.35;
const FOCUS_GLOW_ALPHA = 0.22;
const FOCUS_GLOW_MIN_RADIUS = 8;
const paintFocusGlow = (ctx: CanvasRenderingContext2D, t: ReticuleTarget) => {
  const r = Math.max(FOCUS_GLOW_MIN_RADIUS, (t.radius ?? FOCUS_GLOW_MIN_RADIUS) * FOCUS_GLOW_RADIUS_MULT);
  const g = ctx.createRadialGradient(t.pos.x, t.pos.y, 0, t.pos.x, t.pos.y, r);
  g.addColorStop(0, `rgba(255, 255, 255, ${FOCUS_GLOW_ALPHA})`);
  g.addColorStop(0.5, `rgba(255, 255, 255, ${(FOCUS_GLOW_ALPHA * 0.3).toFixed(3)})`);
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(t.pos.x, t.pos.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

// On-beat brightening for every wave body. Same additive-disc trick as paintFocusGlow
// (ctx.filter=brightness is a slow full-canvas pass — see that note), so the flash reads as
// "this lit up" on top of the sprite without touching each entity's own draw pipeline.
const BEAT_FLASH_RADIUS_MULT = 1.15;
const BEAT_FLASH_ALPHA = 0.35;
const paintBeatFlash = (
  ctx: CanvasRenderingContext2D, pos: Vec, radius: number, flash: number,
) => {
  const r = Math.max(6, radius) * BEAT_FLASH_RADIUS_MULT;
  const a = BEAT_FLASH_ALPHA * flash;
  const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r);
  g.addColorStop(0, `rgba(255, 255, 255, ${a.toFixed(3)})`);
  g.addColorStop(0.6, `rgba(255, 255, 255, ${(a * 0.4).toFixed(3)})`);
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

// bodies must sit ON their own trails, so trails pass before any per-entity render call.
const paintEntityLayers = (
  game: Game, focusedTarget: ReticuleTarget | null,
) => {
  const { ctx } = game;
  renderTrails(game, ctx);
  for (const c of game.comets) c.render(ctx);
  for (const s of game.shards) s.render(ctx);
  // bassteroids wear the ship's 4+/12+ combo halo — share the ship's eased
  // intensity + the live beat pulse so every halo on the field rides one rhythm.
  const comboHalo = { intensity: game.ship.comboHaloIntensity, beatPulse: currentBeatPulse(game) };
  for (const a of game.asteroids) a.render(ctx, game.time, comboHalo);
  for (const c of game.canisters) c.render(ctx, game.time);
  for (const g of game.gems) g.render(ctx, game.time);
  for (const al of game.aliens) al.render(ctx, game.time);
  for (const ab of game.alienBullets) ab.render(ctx);
  renderBossBeams(ctx, game.bossBeams);
  for (const b of game.bullets) b.render(ctx);
  renderLasers(ctx, game.lasers);
  // every wave body brightens on the beat then tapers over ~100ms (paints over the sprites above).
  const beatFlash = currentBeatFlash(game);
  if (beatFlash > 0) {
    for (const a of game.asteroids) paintBeatFlash(ctx, a.pos, a.radius, beatFlash);
    for (const c of game.comets) paintBeatFlash(ctx, c.pos, c.radius, beatFlash);
    for (const al of game.aliens) paintBeatFlash(ctx, al.pos, al.radius, beatFlash);
    for (const c of game.canisters) paintBeatFlash(ctx, c.pos, c.radius, beatFlash);
    for (const g of game.gems) paintBeatFlash(ctx, g.pos, g.radius, beatFlash);
  }
  if (focusedTarget) paintFocusGlow(ctx, focusedTarget);
  renderBassLightnings(ctx, game.bassLightnings, game.time * 0.001);
  game.particles.render(ctx);
};

// reticule reads every visible target on the field; gather them once not repeatedly.
// Exported so the ship-rotation snap (gameUpdate) can use the same target set as the reticule.
// Alien bullets are deliberately excluded — they're incoming threats, not things you shoot,
// and painting trajectories for them clutters the field with predictions the player can't act on.
// The dormant boss is excluded too — during its approach it's meant to read as part of the
// background planet, so the reticule must not light it up or treat it as a lockable target.
export const targetsForReticule = (game: Game) => [
  // Skip intangible rocks — a dormant boss and a phased-out warble both pass
  // bullets through, so the reticule shouldn't promise a hit on them.
  ...game.asteroids.filter((a) => !(a.isBoss() && a.bossPhase === "dormant") && !a.isPhasedOut()),
  ...game.comets,
  ...game.aliens,
  ...game.canisters,
];

// ship + reticule are the foreground; popups (combo/pickup/debug) sit above everything else.
const paintForeground = (game: Game, targets: ReadonlyArray<ReticuleTarget>) => {
  const { ctx } = game;
  const doubletime = comboGrid(game) < BEAT_GRID;
  // highlight the reticule + first-beat dot while the tutorial wants the player on a
  //   target: the drift/hover gate (3), the fire-and-hit sub-line (4), and build-to-4x (5).
  const tutorialHighlight =
    game.firstWaveHintStage === 3 ||
    (game.firstWaveHintStage === 4 && game.firstWaveHintSubVisible) ||
    game.firstWaveHintStage === 5;
  // perceivedBeatTime: the reticule pulse + first-beat dots cue when to fire, so they
  //   ride the latency-shifted clock and peak on the beat the player hears.
  // superBoosted (combo ≥ 12) doubles bullet range the same way longshot does — pass it
  //   through so the reticule renderer paints the matching 2-beat slot.
  const superBoosted = game.beatCombo >= 12;
  // gold crystals are stationary (or near-stationary) "First Dot" probes — they need a direct
  // proximity pass since the trajectory walk skips speed<1 targets.
  game.ship.renderReticules(ctx, BEAT_GRID, game.w, game.h, targets, game.perceivedBeatTime, doubletime, tutorialHighlight, game.sound, game.beatTime, superBoosted, game.gems);
  // ship.lastThrustActiveAt is recorded in game.time/1000 units; pass the same clock so
  // the post-thrust fade doesn't get stuck after intro overlays (which advance beatTime
  // without advancing game.time).
  renderShipTrajectoryPreview(ctx, game.ship, BEAT_GRID, game.time / 1000, game.w, game.h);
  game.ship.render(ctx, game.time, currentBeatPulse(game));
  renderLaserChargeDots(ctx, game, game.beatTime);
  renderPopups(ctx, game.popups);
};

// one entry point so main.ts doesn't see the layer ordering, and shake wraps the whole scene.
export const renderGame = (game: Game) => {
  const { ctx } = game;
  const { shakeX, shakeY } = applyScreenShake(game);
  ctx.save();
  paintBackdrop(game);
  ctx.translate(shakeX, shakeY);
  paintBackgroundLayers(game);
  // pick the same focused target the reticule will draw the on-rhythm spot on, so the
  // brightness boost on the sprite and the reticule overlay agree on which target is "the one".
  // One target gather per frame, reused by the focus pick and the reticule pass.
  const targets = targetsForReticule(game);
  const focusedTarget = pickCenterMostTargetForFocus(
    game.ship.pos, computeConeFrame(game.ship), game.w, game.h, targets,
  );
  paintEntityLayers(game, focusedTarget);
  paintForeground(game, targets);
  // slow-mo countdown rail sits above the field so its beat ticks read clearly.
  renderSlowMoTimerBar(game);
  // laser ambient wash sits above entities; the bass-drop white flash sits above
  // even that so a bass drop still wins.
  renderLaserAmbientFlash(ctx, game);
  game.pulsar.renderShockwaveOverlay(ctx);
  ctx.restore();
};
