import type { Game } from "../Game";
import { BEAT_GRID } from "./rhythmConstants";
import { currentBeatPulse } from "./rhythmGate";
import { renderTrails } from "./trailsRender";
import { renderPopups } from "./popups";
import { computeConeFrame } from "../ship/reticule/coneGeometry";
import { pickCenterMostTargetForFocus, FOCUSED_TARGET_BRIGHTNESS, ReticuleTarget, isOnBeatHitReachable } from "../ship/reticule/trajectoryPreview";
import { computeAimCircle } from "../ship/reticule/reticuleRender";

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

// Why: ctx.filter is the cleanest way to recolor/brighten a single entity's existing sprite
// without touching every render() signature — wrap the call, paint, restore. Restoring to the
// previous filter value (rather than "none") lets callers nest filters safely.
//   focused      → focused-target brightness boost.
//   unreachable  → "you can't hit this on-beat from here" cue: hue-rotate to red plus saturate.
//                  Combines with brightness when both apply.
const withFocusFilter = (
  ctx: CanvasRenderingContext2D, focused: boolean, unreachable: boolean, paint: () => void,
) => {
  if (!focused && !unreachable) { paint(); return; }
  const prev = ctx.filter;
  const parts: string[] = [];
  if (focused) parts.push(`brightness(${FOCUSED_TARGET_BRIGHTNESS})`);
  if (unreachable) parts.push("hue-rotate(-90deg) saturate(2)");
  ctx.filter = parts.join(" ");
  paint();
  ctx.filter = prev;
};

// Why: bodies must sit ON their own trails, so trails pass before any per-entity render call.
const paintEntityLayers = (
  game: Game, focusedTarget: ReticuleTarget | null, focusedUnreachable: boolean,
) => {
  const { ctx } = game;
  renderTrails(game, ctx);
  const paintOne = (t: ReticuleTarget, draw: () => void) =>
    withFocusFilter(ctx, t === focusedTarget, t === focusedTarget && focusedUnreachable, draw);
  for (const c of game.comets) paintOne(c, () => c.render(ctx));
  for (const s of game.shards) s.render(ctx);
  for (const a of game.asteroids) paintOne(a, () => a.render(ctx, game.time));
  for (const c of game.canisters) paintOne(c, () => c.render(ctx, game.time));
  for (const al of game.aliens) paintOne(al, () => al.render(ctx, game.time));
  for (const ab of game.alienBullets) paintOne(ab, () => ab.render(ctx));
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
  // Why: pick the same focused target the reticule will draw the on-rhythm spot on, so the
  // brightness boost on the sprite and the reticule overlay agree. If that focused target is
  // not reachable on-beat (running away too fast, or so close every shot lands early), tint it
  // red so the player gets a visual cue without having to interpret the reticule alone.
  const targets = targetsForReticule(game);
  const focusedTarget = pickCenterMostTargetForFocus(
    game.ship.pos, computeConeFrame(game.ship), game.w, game.h, targets,
  );
  const aim = computeAimCircle(game.ship, BEAT_GRID);
  const focusedUnreachable = focusedTarget !== null && !isOnBeatHitReachable(
    game.ship.pos, game.w, game.h, focusedTarget, aim.center, aim.radius, BEAT_GRID,
  );
  paintEntityLayers(game, focusedTarget, focusedUnreachable);
  paintForeground(game);
  // Why: bass-drop white flash has to sit above every other layer to actually wash the screen.
  game.pulsar.renderShockwaveOverlay(ctx);
  ctx.restore();
};
