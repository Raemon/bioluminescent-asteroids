// Headless behavioral probe for the wave-skip wormhole (game/waveSkip.ts).
//   Boots a real Game with the headless stubs, manufactures alien kills, flies
//   the ship into the portal, and asserts the whole sequence: immediate wave
//   end + field sweep, ship absent through summary + title cascade, landing on
//   the right wave (boss clamp included), return portal, re-emergence.
//
// Usage: node scripts/probe-waveskip.mjs

import { spawnSync } from "node:child_process";

if (!process.env.__RESIM_UNDER_TSX) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, __RESIM_UNDER_TSX: "1" } },
  );
  process.exit(r.status ?? 1);
}

const DIMS = { w: 1920, h: 1080, dpr: 2 };
const SEED = 0xbeefcafe;
const DT = 1 / 60;

const { installHeadlessStubs, makeCanvas } = await import("./headless-stubs.mjs");
installHeadlessStubs(DIMS);

const fixedCrypto = {
  getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = SEED >>> 0; return arr; },
  randomUUID: () => "00000000-0000-0000-0000-000000000000",
};
try { globalThis.crypto = fixedCrypto; }
catch { Object.defineProperty(globalThis, "crypto", { value: fixedCrypto, configurable: true }); }

const { Game } = await import("../src/Game.ts");
const { startGame } = await import("../src/game/lifecycle.ts");
const { Alien } = await import("../src/Alien.ts");
const { maybeSpawnSkipPortal } = await import("../src/game/waveSkip.ts");
const { wormholeEnterable } = await import("../src/game/wormhole.ts");
const { isBossWave } = await import("../src/game/waveDirector.ts");
const { v } = await import("../src/vec.ts");

class ScriptedInput {
  keys = new Set();
  justPressed = new Set();
  down(k) { return this.keys.has(k.toLowerCase()); }
  pressed(k) { return this.justPressed.has(k.toLowerCase()); }
  endFrame() { this.justPressed.clear(); }
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const freshGame = () => {
  const game = new Game(makeCanvas(DIMS.w, DIMS.h));
  game.localInput = new ScriptedInput();
  startGame(game, undefined);
  game.input = game.localInput;
  return game;
};

const step = (game, frames) => { for (let f = 0; f < frames; f++) game.update(DT); };

// Kill a synthetic alien of the given size at the ship's doorstep, then fly
// into the portal it leaves. Returns observations of the whole sequence.
const runSkipScenario = (game, size, waveInternal) => {
  game.wave = waveInternal;
  const al = new Alien(v(game.ship.pos.x + 200, game.ship.pos.y), v(10, 0), size);
  maybeSpawnSkipPortal(game, al);
  if (game.skipPortals.length === 0) return null;
  const portal = game.skipPortals[game.skipPortals.length - 1];
  const obs = {
    skip: portal.skip,
    enteredAtWave: waveInternal,
    sweptOnEntry: false,
    deadThroughCascade: true,
    titlesSeen: [],
    landing: null,
    landingBeforeEmerge: false,
    portalCountAtEmerge: 0,
    emerged: false,
    invulnOnEmerge: 0,
  };
  const titlesPending = () => game.waveSkip?.titles.map((t) => t.wave) ?? [];
  let queued = null;
  // Fly at the portal until the warp starts, then observe until it finishes.
  for (let f = 0; f < 60 * 60; f++) {
    if (!game.waveSkip) {
      game.ship.pos.x = portal.wormhole.x;
      game.ship.pos.y = portal.wormhole.y;
      game.ship.vel.x = 0;
      game.ship.vel.y = 0;
    }
    game.update(DT);
    if (game.waveSkip && queued === null) {
      queued = titlesPending();
      obs.sweptOnEntry = game.asteroids.length === 0 && game.waveTransitioning && !game.ship.alive;
    }
    if (game.waveSkip) {
      const pending = titlesPending();
      while (queued.length > pending.length) obs.titlesSeen.push(queued.shift());
      if (game.waveSkip.phase !== "emerge" && game.ship.alive) obs.deadThroughCascade = false;
      if (game.waveSkip.phase === "hidden" && !game.waveTransitioning && obs.landing === null) {
        obs.landing = game.wave;
        obs.landingBeforeEmerge = true;
      }
      if (game.waveSkip.phase === "emerge" && obs.portalCountAtEmerge === 0) {
        obs.portalCountAtEmerge = game.wormholes.length;
        obs.invulnOnEmerge = game.ship.invuln;
      }
    } else if (queued !== null) {
      obs.emerged = game.ship.alive && game.ship.skipWarpT === null;
      obs.landing = obs.landing ?? game.wave;
      break;
    }
  }
  return obs;
};

// ── Scenario 1: small alien on display wave 4 (internal 5) ─────────────────
{
  console.log("\nscenario 1: small alien, display wave 4 (spec example)");
  const game = freshGame();
  step(game, 30);
  const obs = runSkipScenario(game, "small", 5);
  check("portal spawned", obs !== null);
  if (obs) {
    check("skip depth is 1", obs.skip === 1, `skip=${obs.skip}`);
    check("wave ends immediately on entry (field swept, ship gone)", obs.sweptOnEntry);
    check("cascade title = internal 6 (\"Wave 5\")", obs.titlesSeen.length === 1 && obs.titlesSeen[0] === 6, `titles=${JSON.stringify(obs.titlesSeen)}`);
    check("ship absent until emerge", obs.deadThroughCascade);
    check("lands on internal 7 (\"Wave 6\")", obs.landing === 7, `landing=${obs.landing}`);
    check("landing wave spawns before ship re-appears", obs.landingBeforeEmerge);
    check("return portal open at emerge", obs.portalCountAtEmerge > 0);
    check("emerges alive with invuln", obs.emerged && obs.invulnOnEmerge > 0, `invuln=${obs.invulnOnEmerge.toFixed(2)}`);
  }
}

// ── Scenario 2: big alien rolls 3-5, no boss in range ──────────────────────
{
  console.log("\nscenario 2: big alien, display wave 12 (internal 13), skip 3-5");
  const game = freshGame();
  step(game, 30);
  const obs = runSkipScenario(game, "big", 13);
  check("portal spawned", obs !== null);
  if (obs) {
    check("skip depth in 3..5", obs.skip >= 3 && obs.skip <= 5, `skip=${obs.skip}`);
    check("cascade shows every skipped wave", obs.titlesSeen.length === obs.skip, `titles=${JSON.stringify(obs.titlesSeen)}`);
    check("lands skip+1 ahead", obs.landing === 13 + 1 + obs.skip, `landing=${obs.landing}`);
    check("emerges alive", obs.emerged);
  }
}

// ── Scenario 3: boss clamp — big alien on display wave 8 (internal 9) ──────
{
  console.log("\nscenario 3: big alien, display wave 8 — must clamp at boss (display 10)");
  const game = freshGame();
  step(game, 30);
  const obs = runSkipScenario(game, "big", 9);
  check("portal spawned", obs !== null);
  if (obs) {
    check("lands exactly on the boss wave (internal 11)", obs.landing === 11, `landing=${obs.landing} skip=${obs.skip}`);
    check("boss wave is a boss wave", isBossWave(11));
    check("cascade only covers waves before the boss", obs.titlesSeen.every((w) => w < 11), `titles=${JSON.stringify(obs.titlesSeen)}`);
    check("emerges alive", obs.emerged);
  }
}

// ── Scenario 4: no portal on a boss wave ────────────────────────────────────
{
  console.log("\nscenario 4: alien killed ON the boss wave leaves no portal");
  const game = freshGame();
  step(game, 30);
  game.wave = 11;
  const before = game.skipPortals.length;
  maybeSpawnSkipPortal(game, new Alien(v(400, 400), v(10, 0), "medium"));
  check("no portal spawned", game.skipPortals.length === before);
}

// ── Scenario 5: portal collapses when the wave ends normally ───────────────
{
  console.log("\nscenario 5: clearing the wave collapses the portal (no mid-transition entry)");
  const game = freshGame();
  step(game, 30);
  game.wave = 5;
  maybeSpawnSkipPortal(game, new Alien(v(game.ship.pos.x + 300, game.ship.pos.y), v(10, 0), "small"));
  const portal = game.skipPortals[0];
  step(game, 30); // let the mouth iris open
  check("portal enterable while wave is live", wormholeEnterable(portal.wormhole));
  game.asteroids = []; // empty field → advanceWave fires next frame
  step(game, 2);
  check("wave transition started", game.waveTransitioning);
  check("portal records cleared", game.skipPortals.length === 0);
  check("portal no longer enterable", !wormholeEnterable(portal.wormhole), `life=${portal.wormhole.life.toFixed(2)}`);
  // Park the ship on the dead portal through the whole transition — no warp.
  let warped = false;
  for (let f = 0; f < 60 * 15; f++) {
    game.ship.pos.x = portal.wormhole.x;
    game.ship.pos.y = portal.wormhole.y;
    game.update(DT);
    if (game.waveSkip) warped = true;
    if (!game.waveTransitioning && f > 60) break;
  }
  check("no warp through a collapsed portal", !warped);
  check("normal transition landed on wave 6", game.wave === 6, `wave=${game.wave}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
