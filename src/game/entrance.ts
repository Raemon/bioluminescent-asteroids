import type { Game } from "../Game";
import type { Comet } from "../Comet";
import { wrapMut } from "../vec";

// Entrance presentation state — the arrival mirror of the warpT exit. A fresh
// edge spawn is placed in unfolded ship-frame coords (just off the visible
// border), folded in-domain for the sim, and drawn once at its unfolded
// entrance image (pos + enterOff) so it slides in from the screen border.
// The entrance is purely cosmetic and self-destructs on contact: the body
// collides toroidally like anything else, and its own collidesWith calls
// completeEntrance on a positive test — so ANY weapon or contact path, current
// or future, automatically ends the presentation before the hit lands and
// effects/splits stay torus-true. Once body + trail are fully on-screen the
// state clears anyway and the wrap-replicated world layer takes over. The
// torus equals the viewport, so a body whose entrance image recedes off-screen
// (ship outran it) or exits the far side is a visibility HOLE — it exists,
// collides, and takes a reticule, but draws nowhere. tickEntrances ends the
// fiction the moment the image is fully clipped past its closest approach,
// so the wrap copy surfaces flush at the opposite border instead.
//
// Giving a NEW entity type staged entrances means:
//   1. add the EnteringEntity fields (entering/enterOffX/enterOffY/
//      enterTraveled/enterMinOvershoot)
//   2. fold via foldWithEntrance (not bare wrapMut) in its update
//   3. call completeEntrance from its collidesWith on a positive test
//   4. stage spawns with stageEntrance; register the array in
//      shiftEntranceFrames + tickEntrances + paintEntrances (gameRender) and
//      skip entering bodies in the world layer + trailsRender
//   5. route its positional audio through audiblePos

export type EnteringEntity = {
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  entering: boolean;
  enterOffX: number;
  enterOffY: number;
  enterTraveled: number;
  enterMinOvershoot: number;
};

// Fold a spawn whose pos is in unfolded ship-frame coords and record the
// entrance image it should be drawn at until fully on-screen.
export const stageEntrance = (game: Game, e: EnteringEntity) => {
  const off = wrapMut(e.pos, game.w, game.h);
  e.enterOffX = off ? -off.x : 0;
  e.enterOffY = off ? -off.y : 0;
  e.entering = true;
  e.enterTraveled = 0;
  e.enterMinOvershoot = imageOvershoot(game, e, game.w / 2 - game.ship.pos.x, game.h / 2 - game.ship.pos.y);
};

// A ship fold jumps the camera offset by ∓w/∓h in one frame; shift every
// entrance frame by the same fold so the visible entrance image stays
// continuous under the raw (non-mod-normalized) camera translate.
export const shiftEntranceFrames = (game: Game, dx: number, dy: number) => {
  const shift = (e: EnteringEntity) => {
    if (!e.entering) return;
    e.enterOffX += dx;
    e.enterOffY += dy;
  };
  for (const a of game.asteroids) shift(a);
  for (const c of game.comets) shift(c);
  for (const al of game.aliens) shift(al);
  for (const g of game.gems) shift(g);
};

// End the entrance presentation. Entities call this from collidesWith on a
// positive test (contact reveals the body at its true torus position); the
// shockwave calls it directly (full-field event, no collision test).
export const completeEntrance = (e: EnteringEntity) => {
  if (!e.entering) return;
  e.entering = false;
  e.enterOffX = 0;
  e.enterOffY = 0;
  e.enterTraveled = 0;
  e.enterMinOvershoot = 0;
};

// Fold an entity onto the torus, keeping its entrance image continuous when
// it folds mid-entrance. Entrance-capable entities must use this instead of
// bare wrapMut; the returned offset still needs applying to any connected
// history buffer (trail shift), which stays with the owner.
export const foldWithEntrance = (e: EnteringEntity, w: number, h: number): { x: number; y: number } | null => {
  const off = wrapMut(e.pos, w, h);
  if (off && e.entering) {
    e.enterOffX -= off.x;
    e.enterOffY -= off.y;
  }
  return off;
};

// Body is fully inside the viewport when its entrance image sits at least
// its visible reach from every edge.
const bodyInside = (game: Game, e: EnteringEntity, reach: number, camX: number, camY: number): boolean => {
  const sx = e.pos.x + e.enterOffX + camX;
  const sy = e.pos.y + e.enterOffY + camY;
  return sx >= reach && sx <= game.w - reach && sy >= reach && sy <= game.h - reach;
};

// How far the entrance image's centre sits outside the viewport (0 on-screen).
const imageOvershoot = (game: Game, e: EnteringEntity, camX: number, camY: number): number => {
  const sx = e.pos.x + e.enterOffX + camX;
  const sy = e.pos.y + e.enterOffY + camY;
  return Math.max(0, -sx, sx - game.w, -sy, sy - game.h);
};

const ENTRANCE_EXIT_SLACK = 24;

// Two ways an entrance ends besides contact/full-on-screen:
// • gone — the image receded past its closest approach and is fully clipped
//   (>= reach can't fire with visible pixels; >= min+slack can't fire at
//   spawn, and the running min lets a staggered flock straggler that never
//   approached still hand off at the flush-border moment).
// • budget — fully crossing the diagonal guarantees the body swept the whole
//   screen, so a spawn pacing the ship (relative motion ~0, overshoot frozen)
//   can't ride the border half-drawn forever.
const advance = (game: Game, e: EnteringEntity, dt: number, inside: boolean, reach: number, camX: number, camY: number): boolean => {
  e.enterTraveled += Math.hypot(e.vel.x, e.vel.y) * dt;
  const overshoot = imageOvershoot(game, e, camX, camY);
  e.enterMinOvershoot = Math.min(e.enterMinOvershoot, overshoot);
  const gone = overshoot >= Math.max(reach, e.enterMinOvershoot + ENTRANCE_EXIT_SLACK);
  if (inside || gone || e.enterTraveled > Math.hypot(game.w, game.h)) {
    completeEntrance(e);
    return true;
  }
  return false;
};

const cometTrailInside = (game: Game, c: Comet, ox: number, oy: number): boolean => {
  for (const t of c.trail) {
    const x = t.pos.x + ox;
    const y = t.pos.y + oy;
    if (x < 0 || x >= game.w || y < 0 || y >= game.h) return false;
  }
  return c.glowTrail.allInside(ox, oy, game.w, game.h);
};

// Advance every entrance and complete the ones fully on-screen. Reads only
// sim state (pos/vel/trail sample buffers), so it's replay-deterministic.
export const tickEntrances = (game: Game, dt: number) => {
  const camX = game.w / 2 - game.ship.pos.x;
  const camY = game.h / 2 - game.ship.pos.y;
  for (const a of game.asteroids) {
    if (!a.entering) continue;
    const reach = a.radius * 2.4;
    const inside =
      bodyInside(game, a, reach, camX, camY) &&
      (a.trail ? a.trail.allInside(a.enterOffX + camX, a.enterOffY + camY, game.w, game.h) : true);
    advance(game, a, dt, inside, reach, camX, camY);
  }
  for (const c of game.comets) {
    if (!c.entering) continue;
    const reach = 70 * c.scale;
    const inside =
      bodyInside(game, c, reach, camX, camY) &&
      cometTrailInside(game, c, c.enterOffX + camX, c.enterOffY + camY);
    advance(game, c, dt, inside, reach, camX, camY);
  }
  for (const al of game.aliens) {
    if (!al.entering) continue;
    const reach = al.radius * 2.2;
    const inside =
      bodyInside(game, al, reach, camX, camY) &&
      al.trail.allInside(al.enterOffX + camX, al.enterOffY + camY, game.w, game.h);
    advance(game, al, dt, inside, reach, camX, camY);
  }
  for (const g of game.gems) {
    if (!g.entering) continue;
    const reach = g.radius * 1.5;
    advance(game, g, dt, bodyInside(game, g, reach, camX, camY), reach, camX, camY);
  }
};

// Where a positional sound for this body should pan from: the visible
// entrance image while entering, the folded pos otherwise.
export const audiblePos = (e: EnteringEntity): { x: number; y: number } =>
  e.entering ? { x: e.pos.x + e.enterOffX, y: e.pos.y + e.enterOffY } : e.pos;
