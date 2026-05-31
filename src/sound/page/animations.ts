// Animation registry for /sound. Each entry is a self-contained animator that
// renders one in-game entity into a 200×100 cell canvas and reacts to a "fire"
// event (one-shot trigger) or a "playing" flag (continuous loop).
//
// Adding a new entity = one entry. The registry is keyed by AnimationId; the
// sound registry maps each SoundName to one of these IDs.

import { Ship } from "../../Ship";
import { Bullet } from "../../Bullet";
import { Asteroid } from "../../Asteroid";
import { Pulsar } from "../../Pulsar";
import { Alien } from "../../Alien";
import { Comet } from "../../Comet";
import { Canister } from "../../Canister";
import { v } from "../../vec";
import { BEAT_GRID } from "../../game/rhythmConstants";

export type AnimatorCtx = {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  t: number;
  dt: number;
  playing: boolean;
  // Seconds (since canvas mount) when this row's sound last fired. -1 if never.
  firedAt: number;
};

export type Animator = (a: AnimatorCtx) => void;

// IDs that the sound registry uses to look up an animator. New entities slot in
// here and in the ANIMATIONS map below — nothing else changes.
export type AnimationId =
  | "pulsar"
  | "ship-thrust"
  | "ship-reverse"
  | "ship-side"
  | "bullet-weak"
  | "bullet-rhythm"
  | "bullet-trident"
  | "asteroid-chip"
  | "asteroid-kill"
  | "alien-big"
  | "alien-medium"
  | "alien-small"
  | "comet"
  | "canister"
  | "ship-death"
  | "ship-shield"
  | "generic";

// Uses the real in-game Pulsar — same render path as the centre of the game
// screen, just scoped to a cell-sized canvas.
function drawPulsar(): Animator {
  let pulsar: Pulsar | null = null;
  let lastFiredAt = -1;
  let beatClock = 0;
  return ({ ctx, w, h, dt, firedAt }) => {
    if (!pulsar || pulsar.w !== w || pulsar.h !== h) {
      pulsar = new Pulsar(w, h);
      pulsar.baseOffsetX = 0;
      pulsar.baseOffsetY = 0;
      pulsar.planets = [];
      pulsar.setWaveLevel(6);
      pulsar.displayWaveLevel = 6;
    }
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      pulsar.beat();
    }
    beatClock += dt;
    ctx.clearRect(0, 0, w, h);
    pulsar.update(dt, beatClock, BEAT_GRID);
    pulsar.render(ctx);
  };
}

function drawShip(opts: { thrust: boolean; reverse: boolean; shield?: boolean; death?: boolean }): Animator {
  const ship = new Ship(v(0, 0));
  ship.invuln = 0;
  let deathAt = -1;
  return ({ ctx, w, h, t, playing, firedAt }) => {
    ctx.clearRect(0, 0, w, h);
    ship.pos = v(w / 2, h / 2);
    ship.heading = -Math.PI / 2 + Math.sin(t * 0.6) * 0.2;
    ship.thrustOn = opts.thrust && playing;
    ship.reverseThrustOn = opts.reverse && playing;
    if (opts.shield) ship.invuln = playing ? 1.2 : 0;
    if (opts.death && firedAt !== deathAt && firedAt >= 0) {
      deathAt = firedAt;
      ship.invuln = 2.0;
    }
    ship.render(ctx, t * 1000, 0);
  };
}

function drawBullet(opts: { onBeat: boolean; boosted: boolean; count: number }): Animator {
  const lanes = opts.count === 3 ? [-0.35, 0, 0.35] : [0];
  type Tracked = { bullet: Bullet; vx: number; vy: number };
  let tracked: Tracked[] = [];
  let lastFiredAt = -1;
  return ({ ctx, w, h, dt, firedAt }) => {
    ctx.clearRect(0, 0, w, h);
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      for (const lane of lanes) {
        const b = new Bullet(
          v(10, h / 2 + lane * h * 0.6),
          v(0, 0),
          1.4,
        );
        b.onBeat = opts.onBeat;
        b.boosted = opts.boosted;
        tracked.push({ bullet: b, vx: 140, vy: lane * 18 });
      }
    }
    for (const tr of tracked) {
      tr.bullet.life -= dt;
      tr.bullet.trail.push({ x: tr.bullet.pos.x, y: tr.bullet.pos.y });
      if (tr.bullet.trail.length > 8) tr.bullet.trail.shift();
      tr.bullet.pos = v(tr.bullet.pos.x + tr.vx * dt, tr.bullet.pos.y + tr.vy * dt);
    }
    tracked = tracked.filter((tr) => tr.bullet.life > 0 && tr.bullet.pos.x < w + 30);
    for (const tr of tracked) tr.bullet.render(ctx);
  };
}

function drawAsteroidHit(opts: { killing: boolean }): Animator {
  let asteroid = new Asteroid(v(0, 0), v(0, 0), "large");
  let lastFiredAt = -1;
  let killedAt = -Infinity;
  return ({ ctx, w, h, t, dt, firedAt }) => {
    ctx.clearRect(0, 0, w, h);
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      if (opts.killing) {
        asteroid.hp = 0;
        asteroid.flashAmount = 1;
        killedAt = t;
      } else {
        if (asteroid.hp <= 1) {
          asteroid = new Asteroid(v(0, 0), v(0, 0), "large");
        }
        asteroid.applyDamage(1);
      }
    }
    if (opts.killing && t - killedAt > 0.9 && asteroid.hp === 0) {
      asteroid = new Asteroid(v(0, 0), v(0, 0), "large");
      killedAt = -Infinity;
    }
    const fit = 0.78;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(fit, fit);
    ctx.translate(-w / 2, -h / 2);
    asteroid.pos = v(w / 2, h / 2);
    asteroid.update(dt, w * 4, h * 4);
    asteroid.pos = v(w / 2, h / 2);
    asteroid.render(ctx, t * 1000);
    ctx.restore();
  };
}

function drawAlien(size: "big" | "medium" | "small"): Animator {
  // Tiny constant velocity so the alien's internal rotation = heading-of-velocity
  // points nose-right with a gentle weave. We pin pos in the centre each frame
  // so the saucer hovers in the cell instead of drifting across.
  const alien = new Alien(v(0, 0), v(40, 0), size);
  let lastFiredAt = -1;
  return ({ ctx, w, h, t, dt, firedAt }) => {
    ctx.clearRect(0, 0, w, h);
    alien.pos = v(w / 2, h / 2);
    alien.update(dt, w * 4, h * 4);
    alien.pos = v(w / 2, h / 2);
    // Fire flashes & hit flashes use the alien's own fields — animate them on
    // each row firing so the row visually responds (hit on explode/hit sounds,
    // muzzle flash on alien-fire sounds; both look fine here as a generic
    // "alien-reacts" cue).
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      alien.fireFlash = 1;
      alien.flashAmount = 0.6;
    }
    const fit = size === "big" ? 0.55 : size === "medium" ? 0.8 : 1.0;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(fit, fit);
    ctx.translate(-w / 2, -h / 2);
    alien.render(ctx, t * 1000);
    ctx.restore();
  };
}

function drawComet(): Animator {
  let comet = new Comet(v(0, 0), v(40, 0), 200);
  return ({ ctx, w, h, dt }) => {
    ctx.clearRect(0, 0, w, h);
    // Wrap horizontally so the comet keeps streaking across the cell.
    if (comet.pos.x > w + 40) comet = new Comet(v(-20, h / 2), v(40, 0), 200);
    comet.update(dt, w, h);
    comet.render(ctx);
  };
}

function drawCanister(): Animator {
  const canister = new Canister(v(0, 0), v(0, 0), "shield", 1e9);
  return ({ ctx, w, h, t, dt }) => {
    ctx.clearRect(0, 0, w, h);
    canister.pos = v(w / 2, h / 2);
    canister.update(dt, w * 4, h * 4);
    canister.pos = v(w / 2, h / 2);
    canister.render(ctx, t * 1000);
  };
}

// Fallback used for sounds that don't have a dedicated entity (UI-only sounds,
// abstract ambience, etc.). Renders a soft pulse on each fire so the row still
// has visual feedback when its sound triggers.
function drawGenericPulse(): Animator {
  let lastFiredAt = -1;
  let flash = 0;
  let loopFlash = 0;
  return ({ ctx, w, h, dt, firedAt, playing }) => {
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      flash = 1;
    }
    flash = Math.max(0, flash - dt * 2.2);
    loopFlash = playing ? Math.min(1, loopFlash + dt * 3) : Math.max(0, loopFlash - dt * 3);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const r = 6 + flash * 32 + loopFlash * 14;
    const a = 0.18 + flash * 0.55 + loopFlash * 0.35;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(106, 215, 255, ${a})`);
    grad.addColorStop(1, "rgba(106, 215, 255, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(106, 215, 255, ${0.4 + flash * 0.4})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 6 + loopFlash * 4, 0, Math.PI * 2);
    ctx.stroke();
  };
}

export const ANIMATIONS: Record<AnimationId, () => Animator> = {
  pulsar: drawPulsar,
  "ship-thrust": () => drawShip({ thrust: true, reverse: false }),
  "ship-reverse": () => drawShip({ thrust: false, reverse: true }),
  "ship-side": () => drawShip({ thrust: false, reverse: false }),
  "ship-shield": () => drawShip({ thrust: false, reverse: false, shield: true }),
  "ship-death": () => drawShip({ thrust: false, reverse: false, death: true }),
  "bullet-weak": () => drawBullet({ onBeat: false, boosted: false, count: 1 }),
  "bullet-rhythm": () => drawBullet({ onBeat: true, boosted: false, count: 1 }),
  "bullet-trident": () => drawBullet({ onBeat: true, boosted: true, count: 3 }),
  "asteroid-chip": () => drawAsteroidHit({ killing: false }),
  "asteroid-kill": () => drawAsteroidHit({ killing: true }),
  "alien-big": () => drawAlien("big"),
  "alien-medium": () => drawAlien("medium"),
  "alien-small": () => drawAlien("small"),
  comet: drawComet,
  canister: drawCanister,
  generic: drawGenericPulse,
};
