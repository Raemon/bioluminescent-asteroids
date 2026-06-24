// Shared headless browser/Web-Audio/DOM stubs for the offline game harnesses
//   (resim-replay.mjs, record-resim.mjs). Install BEFORE importing any game
//   module — glow.ts / Starfield.ts prebake to an offscreen canvas at import
//   time. A self-returning Proxy answers any unanticipated property/method with
//   another stub, so we only special-case the few values code branches on.
//
// The premise that makes no-op stubs CORRECT: the sim/update path is supposed to
//   be browser-independent (that's the whole replay-determinism contract). If a
//   no-op stub changes a checkpoint, that itself localises the leak.

// A stub that is callable, indexable, and chainable.
export const makeStub = (overrides = {}) => {
  const fn = function () { return proxy; };
  const target = Object.assign(fn, overrides);
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return Reflect.get(t, prop);
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

const make2dContext = () => makeStub({
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

export const makeCanvas = (w, h) => makeStub({
  width: w, height: h, style: style(), classList: classList(),
  getContext: () => make2dContext(),
  getBoundingClientRect: () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 }),
  addEventListener() {}, removeEventListener() {}, toDataURL: () => "data:,",
});

const makeElement = () => makeStub({
  style: style(), classList: classList(), value: "", textContent: "", innerHTML: "",
  addEventListener() {}, removeEventListener() {},
  appendChild(c) { return c; }, removeChild(c) { return c; }, append() {}, remove() {},
  setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
  focus() {}, blur() {}, click() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
  querySelector: () => makeElement(), querySelectorAll: () => [],
  getContext: () => make2dContext(),
});

const makeAudioNode = () => makeStub({
  connect: (n) => n ?? makeAudioNode(), disconnect() {}, start() {}, stop() {},
  gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} },
  frequency: { value: 440, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
  detune: { value: 0, setValueAtTime() {} },
  Q: { value: 1, setValueAtTime() {} },
  pan: { value: 0, setValueAtTime() {} },
  type: "sine", buffer: null,
  getByteFrequencyData(a) { if (a && a.fill) a.fill(0); },
  getByteTimeDomainData(a) { if (a && a.fill) a.fill(128); },
});

class StubAudioContext {
  constructor() {
    this.currentTime = 0; this.sampleRate = 48000; this.state = "suspended";
    this.destination = makeAudioNode(); this.listener = makeStub();
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

// Install all globals for the given logical dimensions. Returns { windowStub,
//   localStorage } so the caller can read back window.__replayDivergences etc.
export const installHeadlessStubs = (dims) => {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
  };

  const documentStub = {
    getElementById: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    createElement: (tag) => (String(tag).toLowerCase() === "canvas" ? makeCanvas(dims.w, dims.h) : makeElement()),
    createElementNS: () => makeElement(),
    addEventListener() {}, removeEventListener() {},
    body: makeElement(), documentElement: makeElement(),
    fonts: { ready: Promise.resolve(), load: () => Promise.resolve(), add() {} },
    hidden: false, visibilityState: "visible",
  };

  const listeners = new Map();
  const windowStub = {
    addEventListener(type, cb) { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(cb); },
    removeEventListener() {},
    dispatchEvent(ev) { for (const cb of listeners.get(ev?.type) ?? []) { try { cb(ev); } catch {} } return true; },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    innerWidth: dims.w, innerHeight: dims.h, devicePixelRatio: dims.dpr,
    location: { search: "", href: "http://localhost/", origin: "http://localhost" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getComputedStyle: () => style(),
    AudioContext: StubAudioContext, webkitAudioContext: StubAudioContext,
    localStorage,
    navigator: { userAgent: "node", platform: "node", maxTouchPoints: 0 },
    performance: globalThis.performance ?? { now: () => 0 },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };

  // Extend Node's real Event so anything touching the real EventTarget (the Neon
  //   DB driver's websocket) keeps working — clobbering global Event breaks it.
  const RealEvent = globalThis.Event;
  class CustomEventShim extends RealEvent { constructor(type, init) { super(type); this.detail = init?.detail; } }

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
  defineGlobal("fetch", () => Promise.reject(new Error("fetch disabled in headless harness")));

  return { windowStub, localStorage };
};
