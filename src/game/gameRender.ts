import type { Game } from "../Game";
import { BEAT_GRID } from "./rhythmConstants";
import { currentBeatPulse } from "./rhythmGate";
import { renderTrails } from "./trailsRender";
import { renderPopups } from "./popups";

// Why: shake is purely cosmetic; isolate its math so render() reads top-down.
const applyScreenShake = (game: Game): { shakeX: number; shakeY: number } => {
  if (game.shake <= 0) return { shakeX: 0, shakeY: 0 };
  game.shakeSeed += 1;
  return {
    shakeX: (Math.random() - 0.5) * game.shake * 10,
    shakeY: (Math.random() - 0.5) * game.shake * 10,
  };
};

// Why: deep-space backdrop has to repaint every frame or shake/clearRect leaves trails.
const paintBackdrop = (game: Game) => {
  const { ctx, w, h } = game;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#02030a";
  ctx.fillRect(0, 0, w, h);
};

// Why: starfield + pulsar are the "static" layers; everything else sits on top of them.
const paintBackgroundLayers = (game: Game) => {
  game.starfield.render(game.ctx, game.time);
  game.pulsar.render(game.ctx);
};

// Why: bodies must sit ON their own trails, so trails pass before any per-entity render call.
const paintEntityLayers = (game: Game) => {
  const { ctx } = game;
  renderTrails(game, ctx);
  for (const c of game.comets) c.render(ctx);
  for (const s of game.shards) s.render(ctx);
  for (const a of game.asteroids) a.render(ctx, game.time);
  for (const c of game.canisters) c.render(ctx, game.time);
  for (const al of game.aliens) al.render(ctx, game.time);
  for (const ab of game.alienBullets) ab.render(ctx);
  for (const b of game.bullets) b.render(ctx);
  game.particles.render(ctx);
};

// Why: reticule reads every visible target on the field; gather them once not repeatedly.
const targetsForReticule = (game: Game) => [
  ...game.asteroids,
  ...game.comets,
  ...game.aliens,
  ...game.alienBullets,
  ...game.canisters,
];

// Why: ship + reticule are the foreground; popups (combo/pickup/debug) sit above everything else.
const paintForeground = (game: Game) => {
  const { ctx } = game;
  game.ship.renderReticules(ctx, BEAT_GRID, game.w, game.h, targetsForReticule(game), game.beatTime);
  game.ship.render(ctx, game.time, currentBeatPulse(game));
  renderPopups(ctx, game.popups);
};

// Why: one entry point so main.ts doesn't see the layer ordering, and shake wraps the whole scene.
export const renderGame = (game: Game) => {
  const { ctx } = game;
  const { shakeX, shakeY } = applyScreenShake(game);
  ctx.save();
  paintBackdrop(game);
  ctx.translate(shakeX, shakeY);
  paintBackgroundLayers(game);
  paintEntityLayers(game);
  paintForeground(game);
  // Why: bass-drop white flash has to sit above every other layer to actually wash the screen.
  game.pulsar.renderShockwaveOverlay(ctx);
  ctx.restore();
};
