import type { Game } from "../Game";
import { BEAT_GRID } from "./rhythmConstants";
import { currentBeatPulse, comboGrid } from "./rhythmGate";
import { renderTrails } from "./trailsRender";
import { renderPopups } from "./popups";
import { computeConeFrame } from "../ship/reticule/coneGeometry";
import { pickCenterMostTargetForFocus, ReticuleTarget } from "../ship/reticule/trajectoryPreview";
import { renderShipTrajectoryPreview } from "../ship/shipTrajectoryPreview";

// shake is purely cosmetic; isolate its math so render() reads top-down.
const applyScreenShake = (game: Game): { shakeX: number; shakeY: number } => {
  if (game.shake <= 0) return { shakeX: 0, shakeY: 0 };
  game.shakeSeed += 1;
  return {
    shakeX: (Math.random() - 0.5) * game.shake * 10,
    shakeY: (Math.random() - 0.5) * game.shake * 10,
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
const paintBackgroundLayers = (game: Game) => {
  game.starfield.render(game.ctx, game.time);
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

// bodies must sit ON their own trails, so trails pass before any per-entity render call.
const paintEntityLayers = (
  game: Game, focusedTarget: ReticuleTarget | null,
) => {
  const { ctx } = game;
  renderTrails(game, ctx);
  for (const c of game.comets) c.render(ctx);
  for (const s of game.shards) s.render(ctx);
  for (const a of game.asteroids) a.render(ctx, game.time);
  for (const c of game.canisters) c.render(ctx, game.time);
  for (const g of game.goldCrystals) g.render(ctx, game.time);
  for (const al of game.aliens) al.render(ctx, game.time);
  for (const ab of game.alienBullets) ab.render(ctx);
  for (const b of game.bullets) b.render(ctx);
  if (focusedTarget) paintFocusGlow(ctx, focusedTarget);
  game.particles.render(ctx);
};

// reticule reads every visible target on the field; gather them once not repeatedly.
// Exported so the ship-rotation snap (gameUpdate) can use the same target set as the reticule.
export const targetsForReticule = (game: Game) => [
  ...game.asteroids,
  ...game.comets,
  ...game.aliens,
  ...game.alienBullets,
  ...game.canisters,
];

// ship + reticule are the foreground; popups (combo/pickup/debug) sit above everything else.
const paintForeground = (game: Game, targets: ReadonlyArray<ReticuleTarget>) => {
  const { ctx } = game;
  const doubletime = comboGrid(game) < BEAT_GRID;
  // highlight the reticule + first-beat dot while the wave-1 tutorial is telling the
  //   player to use their targeting tools (stage 2 sub-line + stage 3 sub-line).
  const tutorialHighlight =
    (game.firstWaveHintStage === 2 && game.firstWaveHintSubVisible) ||
    game.firstWaveHintStage === 3;
  game.ship.renderReticules(ctx, BEAT_GRID, game.w, game.h, targets, game.beatTime, doubletime, tutorialHighlight, game.sound);
  renderShipTrajectoryPreview(ctx, game.ship, BEAT_GRID, game.beatTime, game.w, game.h);
  game.ship.render(ctx, game.time, currentBeatPulse(game));
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
  // bass-drop white flash has to sit above every other layer to actually wash the screen.
  game.pulsar.renderShockwaveOverlay(ctx);
  ctx.restore();
};
