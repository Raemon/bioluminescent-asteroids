import type { Game } from "../Game";

// hard cap keeps worst-case drawImage count bounded; dropped trails are the furthest offscreen.
const MAX_VISIBLE_TRAILS = 40;

// numeric tags over strings keep the distance-sort cache-friendly.
const SECTION_ASTEROID = 0;
const SECTION_ALIEN = 1;
const SECTION_COMET = 2;

// scratch buffers at module scope so renderTrails never allocates per frame.
const idx = new Int32Array(128);
const sect = new Int8Array(128);
const sqDist = new Float32Array(128);

// squared distance from screen centre — cheap selection metric for the over-cap fallback.
const collectTrailCandidates = (game: Game, cx: number, cy: number): number => {
  let n = 0;
  const cap = idx.length;
  for (let i = 0; i < game.asteroids.length && n < cap; i++) {
    // gen-0 bassteroids wear a Trail, post-split fragments wear a
    // SoundwaveRadiator — either qualifies as a candidate to draw.
    if (!game.asteroids[i].trail && !game.asteroids[i].radiator) continue;
    const dx = game.asteroids[i].pos.x - cx;
    const dy = game.asteroids[i].pos.y - cy;
    idx[n] = i; sect[n] = SECTION_ASTEROID; sqDist[n] = dx * dx + dy * dy;
    n++;
  }
  for (let i = 0; i < game.aliens.length && n < cap; i++) {
    if (!game.aliens[i].alive) continue;
    const dx = game.aliens[i].pos.x - cx;
    const dy = game.aliens[i].pos.y - cy;
    idx[n] = i; sect[n] = SECTION_ALIEN; sqDist[n] = dx * dx + dy * dy;
    n++;
  }
  for (let i = 0; i < game.comets.length && n < cap; i++) {
    const dx = game.comets[i].pos.x - cx;
    const dy = game.comets[i].pos.y - cy;
    idx[n] = i; sect[n] = SECTION_COMET; sqDist[n] = dx * dx + dy * dy;
    n++;
  }
  return n;
};

// partial-sort is cheaper than a full sort when only the top-K matters and K is small.
const sortNearestToFront = (n: number, maxN: number) => {
  for (let i = 0; i < maxN; i++) {
    let minJ = i;
    let minD = sqDist[i];
    for (let j = i + 1; j < n; j++) {
      if (sqDist[j] < minD) { minD = sqDist[j]; minJ = j; }
    }
    if (minJ !== i) {
      const td = sqDist[i]; sqDist[i] = sqDist[minJ]; sqDist[minJ] = td;
      const ti = idx[i]; idx[i] = idx[minJ]; idx[minJ] = ti;
      const ts = sect[i]; sect[i] = sect[minJ]; sect[minJ] = ts;
    }
  }
};

// one composite-mode change for the whole batch beats toggling per-entity.
const paintSelectedTrails = (game: Game, ctx: CanvasRenderingContext2D, n: number, tSec: number) => {
  for (let i = 0; i < n; i++) {
    const k = idx[i];
    const s = sect[i];
    if (s === SECTION_ASTEROID) {
      const a = game.asteroids[k];
      if (a.trail) a.trail.render(ctx, tSec);
      else if (a.radiator) a.radiator.render(ctx, tSec, a.radius);
    } else if (s === SECTION_ALIEN) {
      game.aliens[k].trail.render(ctx, tSec);
    } else {
      game.comets[k].glowTrail.render(ctx, tSec);
    }
  }
};

// trails drawn before bodies so each entity sits on top of its own trail; one pass for all.
export const renderTrails = (game: Game, ctx: CanvasRenderingContext2D) => {
  const cx = game.w * 0.5;
  const cy = game.h * 0.5;
  let n = collectTrailCandidates(game, cx, cy);
  if (n === 0) return;
  if (n > MAX_VISIBLE_TRAILS) {
    sortNearestToFront(n, MAX_VISIBLE_TRAILS);
    n = MAX_VISIBLE_TRAILS;
  }
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  paintSelectedTrails(game, ctx, n, game.time * 0.001);
  ctx.globalAlpha = 1;
  ctx.restore();
};
