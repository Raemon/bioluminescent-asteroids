import type { Game } from "../Game";
import { Asteroid } from "../Asteroid";
import { emitExplosion, emitShockwaveSparks } from "./particleBursts";
import { alignBassBeat } from "./waveDirector";

// Why: strong enough to redirect, weak enough to avoid an unrecoverable spin.
const SHOCKWAVE_SHIP_IMPULSE = 320;

// Why: pulsar.shockJustFired flips a frame after this, so we kick off the vibrate sequence here.
export const startShockwave = (game: Game) => {
  game.pulsar.triggerShockwave();
  game.sound.play("shockwaveCharge");
};

// Why: instant-killing the boss via environment would feel cheap; we still nudge it for feedback.
const bossWeathersShockwave = (game: Game, a: Asteroid, surviving: Asteroid[]) => {
  const kick = game.pulsar.shockwaveImpulseAt(a.pos);
  a.vel = { x: a.vel.x + kick.x * 120, y: a.vel.y + kick.y * 120 };
  a.flashAmount = 1;
  surviving.push(a);
};

// Why: kicking children outward reads as flung-apart by the wavefront, not spawning in place.
const kickChildFromShockwave = (game: Game, child: Asteroid) => {
  const kick = game.pulsar.shockwaveImpulseAt(child.pos);
  child.vel = { x: child.vel.x + kick.x * 220, y: child.vel.y + kick.y * 220 };
};

// Why: bass children stay grid-aligned + inherit drones so the music keeps marching post-shatter.
const shatterBassRock = (game: Game, a: Asteroid, surviving: Asteroid[]) => {
  a.hp = 0;
  a.flashAmount = 1;
  emitExplosion(game.particles, game.shards, a, false);
  game.sound.stopBassteroidDrone(a);
  for (const c of a.split()) {
    alignBassBeat(game, c);
    if (c.size === "medium" || c.size === "small") {
      game.sound.startBassteroidDrone(c, c.kind as "bassA" | "bassB" | "bassC" | "bassD", c.size, c.pos);
    }
    kickChildFromShockwave(game, c);
    surviving.push(c);
  }
};

// Why: non-bass rocks have no drone or beat schedule, so the path stays free of audio bookkeeping.
const shatterPlainRock = (game: Game, a: Asteroid, surviving: Asteroid[]) => {
  a.flashAmount = 1;
  emitExplosion(game.particles, game.shards, a, false);
  for (const c of a.split()) {
    kickChildFromShockwave(game, c);
    surviving.push(c);
  }
};

// Why: rebuild via surviving[] so we don't mutate the array we're iterating over.
const shatterAllAsteroids = (game: Game) => {
  const surviving: Asteroid[] = [];
  for (const a of game.asteroids) {
    if (a.isBoss()) bossWeathersShockwave(game, a, surviving);
    else if (a.isBass()) shatterBassRock(game, a, surviving);
    else shatterPlainRock(game, a, surviving);
  }
  game.asteroids = surviving;
};

// Why: clamped distance falloff guarantees the player feels *something* even at the far corner.
const kickShipFromShockwave = (game: Game) => {
  if (!game.ship.alive) return;
  const kick = game.pulsar.shockwaveImpulseAt(game.ship.pos);
  const d = Math.hypot(game.ship.pos.x - game.pulsar.shockOriginX, game.ship.pos.y - game.pulsar.shockOriginY);
  const falloff = Math.max(0.45, 1 - d / Math.max(game.w, game.h));
  const mag = SHOCKWAVE_SHIP_IMPULSE * falloff;
  game.ship.vel = { x: game.ship.vel.x + kick.x * mag, y: game.ship.vel.y + kick.y * mag };
  // Why: grace frame avoids punishing the player for being kicked into freshly-shattered debris.
  game.ship.invuln = Math.max(game.ship.invuln, 0.6);
};

// Why: environment event — no score / combo so the ring stays a "free-of-charge" hazard reshape.
export const detonateShockwave = (game: Game) => {
  game.sound.play("shockwaveBoom");
  // Bass-drop shake kicks the screen hard so the impact registers in the
  // body as well as the ears. Capped so we never lose all sense of the frame.
  game.shake = Math.min(game.shake + 2.4, 3.0);
  shatterAllAsteroids(game);
  kickShipFromShockwave(game);
  emitShockwaveSparks(game.particles, { x: game.pulsar.shockOriginX, y: game.pulsar.shockOriginY });
};
