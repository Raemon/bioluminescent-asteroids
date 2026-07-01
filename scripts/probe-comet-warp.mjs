// Headless probe for the comet warp-out ("wormhole") departure.
//
// Question it answers: when a lone comet reaches end-of-life, does it dive
//   through the portal ON-SCREEN (so the player sees the animation), or does it
//   fade to invisible / warp off-screen (so the player just sees it vanish)?
//
// It steps the REAL Comet class through its whole life with the same dt clamp
//   the game loop uses (main.tsx: min(gap, 0.05); ~60fps), then reports, per
//   comet: where end-of-life fired, whether warp ran, how many warp frames were
//   on-screen, and the body brightness across the last pre-warp second.
//
// Run: node --import tsx scripts/probe-comet-warp.mjs
//   (self-reexecs under tsx so it can import ../src/*.ts)

import { spawnSync } from "node:child_process";

if (!process.env.__PROBE_UNDER_TSX) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, __PROBE_UNDER_TSX: "1" } },
  );
  process.exit(r.status ?? 1);
}

const W = 1920, H = 1080, DPR = 1;

// Install browser/audio/DOM stubs BEFORE importing any game module (glow.ts
//   prebakes an offscreen canvas at import time).
const { installHeadlessStubs } = await import("./headless-stubs.mjs");
installHeadlessStubs({ w: W, h: H, dpr: DPR });

const { spawnComet, Comet } = await import("../src/Comet.ts");
const { seedRng } = await import("../src/game/rng.ts");

// Optional coefficient sweep: override the comet's warp-lifetime multiplier so
//   we can find where on-screen visibility saturates without editing source.
//   COEF=0.6 scales lifetime to 0.6/0.85 of what cometWarpLifetime produced.
const COEF = process.env.COEF ? Number(process.env.COEF) : null;
const SRC_COEF = 0.6; // must track cometWarpLifetime's multiplier

const FPS = 60;
const FRAME_DT = 1 / FPS; // < the 0.05 game clamp, so this is the normal-play step
const DIAG = Math.hypot(W, H);

// Under the scroll camera the ship is locked at screen centre and the world is
//   ship-relative, so absolute world coords say nothing about visibility. What's
//   camera-independent is how far the comet has TRAVELLED from spawn: a comet
//   aimed across the field is at the visible far edge after ~1.0 diagonal, so a
//   warp that fires before ~1.0 diag of travel opens on-screen. We measure travel
//   from spawn in diagonals and treat "< 1.0 diag" as on-screen for the warp.
const travelDiagFromSpawn = (spawn, pos) =>
  Math.hypot(pos.x - spawn.x, pos.y - spawn.y) / DIAG;

// Recompute the body's render brightness the same way Comet.render does:
//   b = warping ? 1 : brightness().  We read the class method for the pre-warp
//   value so we're testing the real curve, not a copy.
// The visible frame is a W×H box centred on the ship. Under the scroll camera
//   the real spawner shifts the comet's off-edge origin by (ship - centre) and
//   aims it at the ship, so we model the ship at the playfield centre and treat
//   spawnComet's own framing (origin just off-edge, target in the central band)
//   as already ship-relative. A warp position inside this box is on-screen.
const SHIP = { x: W / 2, y: H / 2 };
const inVisibleBox = (p) =>
  Math.abs(p.x - SHIP.x) <= W / 2 && Math.abs(p.y - SHIP.y) <= H / 2;

const runOne = (seed) => {
  seedRng(seed);
  const c = spawnComet(W, H);
  if (COEF !== null) c.lifetime *= COEF / SRC_COEF; // rescale for the sweep
  const spawn = { x: c.pos.x, y: c.pos.y };

  const speed = Math.hypot(c.vel.x, c.vel.y);
  let eol = null;            // { travelDiag, onScreen, warpPos, brightnessAtEol }
  let warpFrames = 0;        // total warp update frames
  let warpFramesOnScreen = 0;
  let brightnessAtEol = null;

  let prevWarpNull = true;
  for (let i = 0; i < 100000; i++) {
    if (c.warpT === null) brightnessAtEol = c.brightness();
    c.update(FRAME_DT, W, H);

    if (prevWarpNull && c.warpT !== null && eol === null) {
      eol = {
        travelDiag: travelDiagFromSpawn(spawn, c.pos),
        onScreen: inVisibleBox(c.pos),
        warpPos: { x: Math.round(c.pos.x), y: Math.round(c.pos.y) },
        brightnessAtEol,
      };
    }
    if (c.warpT !== null) {
      warpFrames++;
      if (inVisibleBox(c.pos)) warpFramesOnScreen++;
    }
    prevWarpNull = c.warpT === null;
    if (!c.alive) break;
  }

  return {
    seed,
    speed: Math.round(speed),
    lifetime: +c.lifetime.toFixed(2),
    isMeteor: c.isMeteor,
    eol,
    warpFrames,
    warpFramesOnScreen,
    travelDiag: eol ? +eol.travelDiag.toFixed(2) : null,
    brightnessAtEol: eol && eol.brightnessAtEol != null ? +eol.brightnessAtEol.toFixed(3) : null,
  };
};

const N = Number(process.env.N ?? 200);
console.log(`Screen ${W}x${H}. Stepping ${N} comets at ${FPS}fps through full life.\n`);
const rows = [];
for (let s = 1; s <= N; s++) rows.push(runOne(s * 1013904223 >>> 0));

if (rows.length <= 16) for (const r of rows) {
  const eolWhere = r.eol
    ? `${r.eol.onScreen ? "ON " : "OFF"}-screen (${r.travelDiag} diag) @ (${r.eol.warpPos.x},${r.eol.warpPos.y})`
    : "NEVER";
  console.log(
    `seed ${String(r.seed).padStart(11)} | life ${String(r.lifetime).padStart(5)}s speed ${String(r.speed).padStart(4)} | ` +
    `warp fires ${eolWhere} | warpFrames on-screen ${String(r.warpFramesOnScreen).padStart(2)}/${String(r.warpFrames).padStart(2)} | ` +
    `bright@warp ${String(r.brightnessAtEol).padStart(5)}`
  );
}

// Aggregate verdict. On-screen = warp position is inside the ship-centred W×H box.
const eolOn = rows.filter((r) => r.eol && r.eol.onScreen).length;
const anyWarpVisible = rows.filter((r) => r.warpFramesOnScreen > 0).length;
const brightAtWarp = rows.filter((r) => r.brightnessAtEol != null && r.brightnessAtEol > 0.9).length;
console.log(`\nVerdict over ${rows.length} comets:`);
console.log(`  warp opens ON-screen:                    ${eolOn}/${rows.length}`);
console.log(`  ≥1 warp frame drawn on-screen:           ${anyWarpVisible}/${rows.length}`);
console.log(`  comet still bright (>0.9) when it warps:  ${brightAtWarp}/${rows.length}`);
