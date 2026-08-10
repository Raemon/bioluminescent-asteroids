// Headless replay re-simulation. Pulls a saved replay from the DB (or reads a
//   payload file), stubs the browser/Web-Audio/DOM surface as no-ops, then runs
//   the REAL game sim via startReplay → precomputeRhythmHistogram. That sweep
//   asserts every recorded checkpoint against the live re-sim and stashes the
//   divergence list on window.__replayDivergences — which we print here.
//
// The whole point: reuse the production divergence logic (assertCheckpoint /
//   reportReplayAudit) verbatim, so the headless result matches what the browser
//   would report. A no-op stub is the CORRECT model of a render/audio dependency,
//   because the sim path is supposed to be browser-independent — if stubbing one
//   to a no-op changes the checkpoint outcome, that itself localises the leak.
//
// Usage:
//   node scripts/resim-replay.mjs              # newest saved replay in the DB
//   node scripts/resim-replay.mjs <highscoreId>
//   node scripts/resim-replay.mjs --file path/to/payload.json   # raw ReplayPayload JSON
//
// Run through tsx so it can import the game's .ts sources directly:
//   node --import tsx scripts/resim-replay.mjs ...
// (package.json has tsx; this file re-execs itself under tsx if not already.)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

// ---- self-reexec under tsx so `import ... from "../src/*.ts"` works ----
if (!process.env.__RESIM_UNDER_TSX) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, __RESIM_UNDER_TSX: "1" } },
  );
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// 1. Browser-surface stubs. Installed on globalThis BEFORE importing any game
//    module, because glow.ts / Starfield.ts prebake to an offscreen canvas at
//    import time. A self-returning Proxy answers any unanticipated property or
//    method with another stub, so we don't have to enumerate every getElementById
//    id or canvas/audio method — only the few that must return real values.
// ---------------------------------------------------------------------------

const HEADER_FALLBACK = { w: 1920, h: 1080, dpr: 2 };
let dims = { ...HEADER_FALLBACK }; // overwritten once we decode the payload header

// A stub that is callable, indexable, and chainable. Any `.foo` returns a stub;
//   calling it returns a stub. Numeric-ish coercion yields 0. Used for canvas
//   ctx, gradients, audio nodes, DOM elements, classList, style, etc.
const makeStub = (overrides = {}) => {
  const fn = function () { return proxy; };
  const target = Object.assign(fn, overrides);
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return Reflect.get(t, prop);
      // Common primitive-valued props that code reads and branches on.
      switch (prop) {
        case Symbol.toPrimitive: return () => 0;
        case "length": return 0;
        case Symbol.iterator: return [][Symbol.iterator].bind([]);
        case "then": return undefined; // not a thenable (avoid await traps)
        case "value": return 0;
        case "textContent": return "";
        case "innerHTML": return "";
        case "offsetWidth": case "offsetHeight": return 0;
        case "width": case "height": return 0;
        default: return makeStub();
      }
    },
    set() { return true; },
    has() { return true; },
    apply() { return makeStub(); },
  });
  return proxy;
};

const classList = () => ({ add() {}, remove() {}, toggle() {}, contains: () => false });
const style = () => new Proxy({ setProperty() {}, removeProperty() {} }, { get(t, p) { return p in t ? t[p] : ""; }, set() { return true; } });

// Canvas 2D context: real chainable methods, no-op draws, real-ish gradients.
const make2dContext = () => {
  const ctx = makeStub({
    setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, arcTo() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, rect() {}, ellipse() {},
    fill() {}, stroke() {}, clip() {}, fillRect() {}, strokeRect() {}, clearRect() {},
    fillText() {}, strokeText() {}, drawImage() {}, putImageData() {},
    setLineDash() {}, getLineDash: () => [],
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    measureText: () => ({ width: 0 }),
    canvas: null,
  });
  return ctx;
};

const makeCanvas = (w = dims.w, h = dims.h) => {
  const el = makeStub({
    width: w, height: h,
    style: style(),
    classList: classList(),
    getContext: () => make2dContext(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 }),
    addEventListener() {}, removeEventListener() {},
    toDataURL: () => "data:,",
  });
  return el;
};

const makeElement = () => makeStub({
  style: style(),
  classList: classList(),
  value: "",
  textContent: "",
  innerHTML: "",
  addEventListener() {}, removeEventListener() {},
  appendChild(c) { return c; }, removeChild(c) { return c; }, append() {}, remove() {},
  setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
  focus() {}, blur() {}, click() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
  querySelector: () => makeElement(), querySelectorAll: () => [],
  getContext: () => make2dContext(),
});

// In-memory localStorage so control-binding / pref reads return null (defaults)
//   rather than throwing, and any writes are harmless.
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
};

// AudioContext stub. currentTime stays 0 and state "suspended" — we never rely on
//   the audio clock here because we drive frames directly with recorded dt, not
//   via the rAF main loop (which is the only place audioNow is read).
const makeAudioNode = () => makeStub({
  connect: (n) => n ?? makeAudioNode(), disconnect() {}, start() {}, stop() {},
  gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} },
  frequency: { value: 440, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
  detune: { value: 0, setValueAtTime() {} },
  Q: { value: 1, setValueAtTime() {} },
  pan: { value: 0, setValueAtTime() {} },
  type: "sine",
  buffer: null,
  getByteFrequencyData(arr) { if (arr && arr.fill) arr.fill(0); },
  getByteTimeDomainData(arr) { if (arr && arr.fill) arr.fill(128); },
});

class StubAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = "suspended";
    this.destination = makeAudioNode();
    this.listener = makeStub();
  }
  createGain() { return makeAudioNode(); }
  createOscillator() { return makeAudioNode(); }
  createBiquadFilter() { return makeAudioNode(); }
  createDynamicsCompressor() { return makeAudioNode(); }
  createAnalyser() { return makeStub({ fftSize: 2048, frequencyBinCount: 1024, getByteFrequencyData(a){a&&a.fill&&a.fill(0);}, getByteTimeDomainData(a){a&&a.fill&&a.fill(128);}, connect:(n)=>n, disconnect(){} }); }
  createBufferSource() { return makeAudioNode(); }
  createStereoPanner() { return makeAudioNode(); }
  createBuffer() { return makeStub({ getChannelData: () => new Float32Array(1) }); }
  createWaveShaper() { return makeAudioNode(); }
  createConvolver() { return makeAudioNode(); }
  createDelay() { return makeAudioNode(); }
  decodeAudioData() { return Promise.resolve(makeStub({ getChannelData: () => new Float32Array(1), duration: 0 })); }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

const documentStub = {
  getElementById: () => makeElement(),
  querySelector: () => makeElement(),
  querySelectorAll: () => [],
  createElement: (tag) => (String(tag).toLowerCase() === "canvas" ? makeCanvas() : makeElement()),
  createElementNS: () => makeElement(),
  addEventListener() {}, removeEventListener() {},
  body: makeElement(),
  documentElement: makeElement(),
  fonts: { ready: Promise.resolve(), load: () => Promise.resolve(), add() {} },
  hidden: false,
  visibilityState: "visible",
};

// window: a real object (not a Proxy) so `window.__replayDivergences = ...` reads
//   back, but with no-op listeners + a CustomEvent shim. Captures dispatched
//   events' detail in case we want them later.
const listeners = new Map();
const windowStub = {
  addEventListener(type, cb) { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(cb); },
  removeEventListener() {},
  dispatchEvent(ev) { for (const cb of listeners.get(ev?.type) ?? []) { try { cb(ev); } catch {} } return true; },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  setTimeout: (fn) => (typeof fn === "function" ? 0 : 0), // never auto-fire in the harness
  clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  innerWidth: dims.w, innerHeight: dims.h, devicePixelRatio: dims.dpr,
  location: { search: "", href: "http://localhost/", origin: "http://localhost" },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => style(),
  AudioContext: StubAudioContext,
  webkitAudioContext: StubAudioContext,
  localStorage,
  navigator: { userAgent: "node", platform: "node", maxTouchPoints: 0 },
  performance: globalThis.performance ?? { now: () => 0 },
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
};

// Extend Node's real Event so game code that constructs CustomEvent stays
//   compatible with anything that touches the real EventTarget (the Neon DB
//   driver's websocket type-checks against the built-in Event — clobbering it
//   globally breaks the DB query).
const RealEvent = globalThis.Event;
class CustomEventShim extends RealEvent { constructor(type, init) { super(type); this.detail = init?.detail; } }

// Install globals. Some (navigator, performance) are read-only getters on Node's
//   globalThis, so define them defensively rather than via Object.assign.
const defineGlobal = (name, value) => {
  try { globalThis[name] = value; }
  catch { try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); } catch {} }
};
defineGlobal("window", windowStub);
defineGlobal("document", documentStub);
defineGlobal("localStorage", localStorage);
defineGlobal("navigator", windowStub.navigator);
defineGlobal("AudioContext", StubAudioContext);
defineGlobal("webkitAudioContext", StubAudioContext);
defineGlobal("CustomEvent", CustomEventShim);
defineGlobal("requestAnimationFrame", () => 0);
defineGlobal("cancelAnimationFrame", () => {});
defineGlobal("matchMedia", windowStub.matchMedia);
defineGlobal("getComputedStyle", windowStub.getComputedStyle);
defineGlobal("devicePixelRatio", dims.dpr);
defineGlobal("Image", class Image { constructor() { this.width = 0; this.height = 0; } set src(_) {} addEventListener() {} });
defineGlobal("HTMLCanvasElement", class HTMLCanvasElement {});
defineGlobal("HTMLElement", class HTMLElement {});
defineGlobal("fetch", () => Promise.reject(new Error("fetch disabled in headless re-sim")));
// Some libs read import.meta.env via Vite; tsx doesn't define it. Provide a shim
//   so `import.meta.env.VITE_BUILD_HASH` returns "dev" (matches recorder default).
if (!globalThis.importMetaEnvPatched) {
  globalThis.importMetaEnvPatched = true;
}

// ---------------------------------------------------------------------------
// 2. Load the payload (DB by default, or --file).
// ---------------------------------------------------------------------------

const loadEnv = () => {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
};

const fileArgIdx = process.argv.indexOf("--file");

const getPayloadFromFile = (path) => {
  const raw = readFileSync(path, "utf8");
  // Accept either raw JSON or a gzipped base64 blob.
  try { return { payload: JSON.parse(raw), meta: { source: path } }; }
  catch {
    const gz = Buffer.from(raw.trim(), "base64");
    return { payload: JSON.parse(gunzipSync(gz).toString("utf8")), meta: { source: path } };
  }
};

const getPayloadFromDb = async (id) => {
  loadEnv();
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaNeon } = await import("@prisma/adapter-neon");
  const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }) });
  const row = id
    ? await prisma.highscore.findUnique({ where: { id: Number(id) }, select: { id: true, name: true, score: true, wave: true, createdAt: true, replayData: true } })
    : (await prisma.highscore.findMany({ where: { replayData: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, name: true, score: true, wave: true, createdAt: true, replayData: true } }))[0];
  await prisma.$disconnect();
  if (!row || !row.replayData) throw new Error(id ? `highscore #${id} has no replayData` : "no saved replays found");
  const payload = JSON.parse(gunzipSync(Buffer.from(row.replayData, "base64")).toString("utf8"));
  return { payload, meta: { source: `db#${row.id}`, name: row.name, score: row.score, wave: row.wave, createdAt: row.createdAt } };
};

const idArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const { payload, meta } = fileArgIdx >= 0
  ? getPayloadFromFile(process.argv[fileArgIdx + 1])
  : await getPayloadFromDb(idArg);

// Re-point dims at the recording so the stub canvas + resize() lock to the right
//   size BEFORE we import/seed (ship spawn + edge-wrap depend on w/h).
dims = { w: payload.header.w, h: payload.header.h, dpr: payload.header.dpr };
windowStub.innerWidth = dims.w; windowStub.innerHeight = dims.h; windowStub.devicePixelRatio = dims.dpr;
globalThis.devicePixelRatio = dims.dpr;

console.log(`\n=== headless re-sim of ${meta.source}${meta.name ? ` "${meta.name}" score=${meta.score} wave=${meta.wave}` : ""} ===`);
console.log(`  v=${payload.header.v} seed=${payload.header.seed} beatOffset=${payload.header.beatOffset} dims=${dims.w}x${dims.h}@${dims.dpr}`);
console.log(`  frames=${payload.frames.length} checkpoints=${(payload.checkpoints ?? []).length} beatResnaps=${(payload.beatResnaps ?? []).length}\n`);

// ---------------------------------------------------------------------------
// 3. Import the real game, build it, and run the replay sweep.
// ---------------------------------------------------------------------------

const { Game } = await import("../src/Game.ts");
const { startReplay } = await import("../src/game/lifecycle.ts");
const { encodeReplay } = await import("../src/game/replayFormat.ts");

const canvas = makeCanvas();
const game = new Game(canvas);

// startReplay decodes gzipped bytes → we re-encode the payload to feed it the
//   exact production entry point (decode + version-gate + seed + precompute sweep).
const bytes = await encodeReplay(payload);
await startReplay(game, bytes);

// ---------------------------------------------------------------------------
// 4. Report. reportReplayAudit (run inside the sweep) stashed a snapshot on
//    window.__replayDivergences + window.__firstDivergence.
// ---------------------------------------------------------------------------

const divs = windowStub.__replayDivergences ?? game.replayPlayer?.divergences ?? [];
const first = windowStub.__firstDivergence ?? null;

// ---------------------------------------------------------------------------
// 4b. Optional per-frame entity trace around a frame window. After the sweep the
//     world is rewound to frame 0 (precompute → restartReplayWorld), so we can
//     re-step from 0 and dump ship/bullet/asteroid state across [TRACE_FROM,
//     TRACE_TO]. Reveals WHICH entity position diverges when the checkpoint only
//     says "a hit didn't land" — e.g. a bullet that misses in the re-sim.
//     Usage: TRACE_FROM=1290 TRACE_TO=1325 node scripts/resim-replay.mjs <id>
// ---------------------------------------------------------------------------
if (process.env.TRACE_TO && game.replayPlayer) {
  const { __stepReplayFrameForTest } = await import("../src/game/gameUpdate.ts");
  const from = Number(process.env.TRACE_FROM ?? 0);
  const to = Number(process.env.TRACE_TO);
  const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "·");
  const fmtV = (v) => (v ? `(${fmt(v.x)},${fmt(v.y)})` : "·");
  console.log(`\n=== ENTITY TRACE frames ${from}..${to} (re-sim side) ===`);
  // player is at frame 0; step up to `to`, dumping once we enter the window.
  while (game.replayPlayer.position() <= to) {
    const i = game.replayPlayer.position(); // frame about to be consumed
    const more = __stepReplayFrameForTest(game);
    const f = i; // frame just consumed
    if (f >= from && f <= to) {
      const s = game.ship;
      const keys = [...game.replayPlayer.input.keys].sort().join("+") || "—";
      const jp = [...(game.replayPlayer.input.justPressed ?? [])].sort().join("+") || "·";
      const fmt4 = (n) => (typeof n === "number" ? n.toFixed(4) : "·");
      console.log(`f${String(f).padStart(5)} cmb=${game.beatCombo} sc=${game.score} blt=${game.bullets.length} | bt=${fmt4(game.beatTime)} pbt=${fmt4(game.perceivedBeatTime)} nextEval=${game.nextBeatToEvaluate} offBeatSince=${game.firedOffBeatSinceLastBeat} | keys=${keys} jp=${jp}`);
      for (const b of game.bullets) console.log(`         bullet @${fmtV(b.pos)} v${fmtV(b.vel)} life=${fmt(b.life)}/${fmt(b.maxLife)} onBeat=${b.onBeat} boost=${b.boosted} super=${b.superBoosted} hitR=${fmt(b.hitRadius())}`);
      for (const a of game.asteroids) console.log(`         ast[${a.kind}/${a.size} r=${fmt(a.radius)} hp=${a.hp}] @${fmtV(a.pos)} v${fmtV(a.vel)}`);
    }
    if (!more) break;
  }
  console.log(`=== end trace ===\n`);
}

const { __stepReplayFrameForTest: stepToEnd } = await import("../src/game/gameUpdate.ts");
while (game.replayPlayer && stepToEnd(game)) {}
const finalScore = game.score;
const scoreOk = finalScore === payload.header.score;
console.log(`  end state — recorded score ${payload.header.score} → replayed ${finalScore} ${scoreOk ? "✅" : "❌"}\n`);

if (!divs.length && scoreOk) {
  console.log("RESULT: ✅ no checkpoint divergence and the final score matches — the re-sim reproduced the recording exactly.\n");
  process.exit(0);
}

if (!scoreOk) console.log(`RESULT: ❌ final-score mismatch — recorded ${payload.header.score}, replayed ${finalScore}.`);
if (!divs.length) { console.log(); process.exit(1); }

console.log(`RESULT: ❌ ${divs.length} divergent checkpoint(s).`);
const f0 = divs[0];
console.log(`\nFIRST divergence — frame ${f0.frame} (${f0.timeSec.toFixed(2)}s in):`);
for (const fld of f0.fields) console.log(`    ${fld.field}: recorded ${fld.recorded} → replayed ${fld.replayed}  (Δ ${fld.delta})`);
if (first) {
  console.log(`\n  full recorded checkpoint:`, first.recorded);
  console.log(`  full replayed checkpoint:`, first.replayed);
  const rngMatch = first.recorded.rngState === first.replayed.rngState;
  console.log(`\n  DIAGNOSIS: rngState ${rngMatch ? "MATCHES" : "DIFFERS"} at the first divergence →`);
  console.log(rngMatch
    ? "    rng streams are aligned, so this is a RHYTHM-JUDGMENT / non-rng drift (beatTime, combo,\n    scoring, or a dt-derived branch) — NOT a seeded-draw count leak."
    : "    the gameplay-rng draw COUNT differs between record and replay — a determinism leak:\n    a gameplay-stream draw on a path that runs a different number of times in replay\n    (render-only draw, audio-gated branch, or a frame-count-dependent loop).");
}

// First few divergences after the first, to see the cascade shape.
if (divs.length > 1) {
  console.log(`\n  next divergences (cascade):`);
  for (const d of divs.slice(1, 8)) {
    console.log(`    f${d.frame} (${d.timeSec.toFixed(2)}s): ${d.fields.map((f) => `${f.field} Δ${f.delta}`).join(", ")}`);
  }
}
console.log();
process.exit(1);
