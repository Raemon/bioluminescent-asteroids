// /soundeditor entry point. Builds a row per sound in SOUND_CATALOG, each
// with knobs that bind to /sounds/config.json. Every knob movement updates
// the in-memory SoundConfig, schedules a debounced PUT back to the file
// via the dev plugin, and (after the user has played the sound at least
// once) re-captures + re-renders the visualizer so they see what they did.

import { Sound } from "../Sound";
import {
  loadSoundConfig,
  getSoundConfig,
  setSoundConfig,
  saveSoundConfig,
  type SoundConfig,
} from "../soundConfig";
import {
  SOUND_CATALOG,
  GROUP_ORDER,
  GROUP_LABEL,
  GROUP_ACCENT,
  type SoundSpec,
} from "./catalog";
import { SoundVisualizer } from "./SoundVisualizer";

// ── semantic knob declarations ──────────────────────────────────────────
// For each sound that has semantic knobs in config.json, we describe the
// slider for it: range, step, and a display label. Keys here must match
// the keys in config.json. If a key isn't listed, the editor falls back
// to a generic 0..max range — but it's nicer to declare them.

type KnobDef = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  // optional formatter — defaults to the value with 2 decimals
  fmt?: (v: number) => string;
};

const hzFmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}k` : v.toFixed(0)) + " Hz";
const msFmt = (v: number) => `${Math.round(v * 1000)} ms`;
const ampFmt = (v: number) => v.toFixed(2);
const ratioFmt = (v: number) => `×${v.toFixed(3)}`;

const SEMANTIC_KNOBS: Record<string, KnobDef[]> = {
  fire: [
    { key: "bodyHz", label: "body", min: 60, max: 2000, step: 1, fmt: hzFmt },
    { key: "bodyPeak", label: "body lvl", min: 0, max: 0.6, step: 0.005, fmt: ampFmt },
    { key: "bodyDecay", label: "body decay", min: 0.01, max: 0.4, step: 0.005, fmt: msFmt },
    { key: "partialHz", label: "partial", min: 60, max: 4000, step: 1, fmt: hzFmt },
    { key: "partialPeak", label: "partial lvl", min: 0, max: 0.3, step: 0.005, fmt: ampFmt },
    { key: "partialDecay", label: "partial decay", min: 0.01, max: 0.2, step: 0.005, fmt: msFmt },
    { key: "tickHz", label: "tick", min: 200, max: 6000, step: 10, fmt: hzFmt },
    { key: "tickQ", label: "tick Q", min: 0.1, max: 8, step: 0.05, fmt: ampFmt },
    { key: "tickPeak", label: "tick lvl", min: 0, max: 0.2, step: 0.005, fmt: ampFmt },
    { key: "tickDecay", label: "tick decay", min: 0.005, max: 0.1, step: 0.001, fmt: msFmt },
  ],
  fireBeat: [
    { key: "bodyHz", label: "body", min: 40, max: 400, step: 0.5, fmt: hzFmt },
    { key: "bodyPeak", label: "body lvl", min: 0, max: 0.8, step: 0.005, fmt: ampFmt },
    { key: "bodyDecay", label: "body decay", min: 0.05, max: 0.6, step: 0.005, fmt: msFmt },
    { key: "subHz", label: "sub", min: 20, max: 200, step: 0.5, fmt: hzFmt },
    { key: "subPeak", label: "sub lvl", min: 0, max: 0.6, step: 0.005, fmt: ampFmt },
    { key: "subDecay", label: "sub decay", min: 0.05, max: 0.6, step: 0.005, fmt: msFmt },
    { key: "partialHz", label: "partial", min: 60, max: 800, step: 1, fmt: hzFmt },
    { key: "partialPeak", label: "partial lvl", min: 0, max: 0.4, step: 0.005, fmt: ampFmt },
    { key: "partialDecay", label: "partial decay", min: 0.02, max: 0.3, step: 0.005, fmt: msFmt },
    { key: "tickHz", label: "tick", min: 100, max: 4000, step: 5, fmt: hzFmt },
    { key: "tickQ", label: "tick Q", min: 0.1, max: 8, step: 0.05, fmt: ampFmt },
    { key: "tickPeak", label: "tick lvl", min: 0, max: 0.3, step: 0.005, fmt: ampFmt },
    { key: "tickDecay", label: "tick decay", min: 0.005, max: 0.15, step: 0.001, fmt: msFmt },
  ],
  explosionLarge: [
    { key: "volume", label: "volume", min: 0, max: 1.5, step: 0.01, fmt: ampFmt },
    { key: "lowpassStart", label: "lpf start", min: 40, max: 800, step: 1, fmt: hzFmt },
    { key: "duration", label: "duration", min: 0.1, max: 1.5, step: 0.01, fmt: msFmt },
  ],
  explosionMedium: [
    { key: "volume", label: "volume", min: 0, max: 1.5, step: 0.01, fmt: ampFmt },
    { key: "lowpassStart", label: "lpf start", min: 40, max: 800, step: 1, fmt: hzFmt },
    { key: "duration", label: "duration", min: 0.1, max: 1.5, step: 0.01, fmt: msFmt },
  ],
  explosionSmall: [
    { key: "volume", label: "volume", min: 0, max: 1.5, step: 0.01, fmt: ampFmt },
    { key: "lowpassStart", label: "lpf start", min: 40, max: 800, step: 1, fmt: hzFmt },
    { key: "duration", label: "duration", min: 0.05, max: 1.0, step: 0.01, fmt: msFmt },
  ],
  death: [
    { key: "subStartHz", label: "sub start", min: 40, max: 200, step: 1, fmt: hzFmt },
    { key: "subEndHz", label: "sub end", min: 18, max: 80, step: 1, fmt: hzFmt },
    { key: "subPeak", label: "sub lvl", min: 0, max: 1.0, step: 0.005, fmt: ampFmt },
    { key: "subDecay", label: "sub decay", min: 0.2, max: 2.0, step: 0.01, fmt: msFmt },
    { key: "crackVol", label: "crack lvl", min: 0, max: 1.0, step: 0.005, fmt: ampFmt },
    { key: "crackDur", label: "crack dur", min: 0.2, max: 2.0, step: 0.01, fmt: msFmt },
    { key: "screamStartHz", label: "scream start", min: 100, max: 800, step: 1, fmt: hzFmt },
    { key: "screamEndHz", label: "scream end", min: 20, max: 150, step: 1, fmt: hzFmt },
    { key: "screamPeak", label: "scream lvl", min: 0, max: 0.6, step: 0.005, fmt: ampFmt },
    { key: "screamDur", label: "scream dur", min: 0.2, max: 2.0, step: 0.01, fmt: msFmt },
    { key: "tailVol", label: "tail lvl", min: 0, max: 0.5, step: 0.005, fmt: ampFmt },
    { key: "tailDur", label: "tail dur", min: 0.2, max: 3.0, step: 0.01, fmt: msFmt },
  ],
  bassKick: [
    { key: "startHz", label: "start", min: 40, max: 400, step: 1, fmt: hzFmt },
    { key: "endHz", label: "end", min: 20, max: 200, step: 1, fmt: hzFmt },
    { key: "sweepTime", label: "sweep", min: 0.01, max: 0.4, step: 0.005, fmt: msFmt },
    { key: "peak", label: "peak", min: 0, max: 1.0, step: 0.005, fmt: ampFmt },
    { key: "decay", label: "decay", min: 0.05, max: 0.8, step: 0.005, fmt: msFmt },
  ],
  bassPluck: [
    { key: "fundamentalHz", label: "fundamental", min: 30, max: 400, step: 0.5, fmt: hzFmt },
    { key: "filterStartHz", label: "lpf start", min: 200, max: 5000, step: 10, fmt: hzFmt },
    { key: "filterEndHz", label: "lpf end", min: 80, max: 2000, step: 5, fmt: hzFmt },
    { key: "filterQ", label: "lpf Q", min: 0.1, max: 15, step: 0.1, fmt: ampFmt },
    { key: "peak", label: "peak", min: 0, max: 0.6, step: 0.005, fmt: ampFmt },
    { key: "decay", label: "decay", min: 0.05, max: 1.0, step: 0.005, fmt: msFmt },
  ],
  bassBoom: [
    { key: "startHz", label: "start", min: 40, max: 500, step: 1, fmt: hzFmt },
    { key: "endHz", label: "end", min: 30, max: 200, step: 0.5, fmt: hzFmt },
    { key: "sweepTime", label: "sweep", min: 0.01, max: 0.3, step: 0.005, fmt: msFmt },
    { key: "peak", label: "peak", min: 0, max: 1.0, step: 0.005, fmt: ampFmt },
    { key: "decay", label: "decay", min: 0.1, max: 1.0, step: 0.005, fmt: msFmt },
    { key: "subHz", label: "sub", min: 20, max: 120, step: 0.5, fmt: hzFmt },
    { key: "subPeak", label: "sub lvl", min: 0, max: 0.6, step: 0.005, fmt: ampFmt },
    { key: "subDecay", label: "sub decay", min: 0.1, max: 1.0, step: 0.005, fmt: msFmt },
  ],
  bassSnap: [
    { key: "noiseStartHz", label: "noise start", min: 200, max: 5000, step: 10, fmt: hzFmt },
    { key: "noiseEndHz", label: "noise end", min: 100, max: 3000, step: 10, fmt: hzFmt },
    { key: "noiseQ", label: "noise Q", min: 0.1, max: 8, step: 0.05, fmt: ampFmt },
    { key: "noisePeak", label: "noise lvl", min: 0, max: 0.6, step: 0.005, fmt: ampFmt },
    { key: "noiseDecay", label: "noise decay", min: 0.03, max: 0.4, step: 0.005, fmt: msFmt },
    { key: "bodyStartHz", label: "body start", min: 80, max: 800, step: 1, fmt: hzFmt },
    { key: "bodyEndHz", label: "body end", min: 50, max: 400, step: 1, fmt: hzFmt },
    { key: "bodyPeak", label: "body lvl", min: 0, max: 0.5, step: 0.005, fmt: ampFmt },
    { key: "bodyDecay", label: "body decay", min: 0.03, max: 0.3, step: 0.005, fmt: msFmt },
  ],
  chime: [
    { key: "fundamentalHz", label: "fundamental", min: 400, max: 3000, step: 1, fmt: hzFmt },
    { key: "partial1Ratio", label: "partial 1", min: 1.5, max: 4, step: 0.005, fmt: ratioFmt },
    { key: "partial2Ratio", label: "partial 2", min: 2, max: 6, step: 0.005, fmt: ratioFmt },
    { key: "peak", label: "peak", min: 0, max: 0.5, step: 0.005, fmt: ampFmt },
    { key: "decay", label: "decay", min: 0.2, max: 2.5, step: 0.01, fmt: msFmt },
  ],
  bell: [
    { key: "fundamentalHz", label: "fundamental", min: 80, max: 800, step: 0.5, fmt: hzFmt },
    { key: "partial1Ratio", label: "partial 1", min: 1.5, max: 5, step: 0.005, fmt: ratioFmt },
    { key: "partial2Ratio", label: "partial 2", min: 3, max: 8, step: 0.005, fmt: ratioFmt },
    { key: "partial3Ratio", label: "partial 3", min: 5, max: 12, step: 0.005, fmt: ratioFmt },
    { key: "peak", label: "peak", min: 0, max: 0.5, step: 0.005, fmt: ampFmt },
    { key: "decay", label: "decay", min: 0.3, max: 3, step: 0.01, fmt: msFmt },
  ],
  tink: [
    { key: "partial1Hz", label: "partial 1", min: 500, max: 5000, step: 1, fmt: hzFmt },
    { key: "partial2Hz", label: "partial 2", min: 800, max: 8000, step: 1, fmt: hzFmt },
    { key: "peak", label: "peak", min: 0, max: 0.5, step: 0.005, fmt: ampFmt },
    { key: "decay", label: "decay", min: 0.05, max: 1.5, step: 0.01, fmt: msFmt },
  ],
};

// Universal knobs shown on every row.
const UNIVERSAL_KNOBS: KnobDef[] = [
  { key: "volume", label: "volume", min: 0, max: 2, step: 0.01, fmt: ampFmt },
  { key: "pitch", label: "pitch", min: 0.25, max: 4, step: 0.01, fmt: (v) => `×${v.toFixed(2)}` },
];

// ── runtime state ───────────────────────────────────────────────────────

type RowHandle = {
  spec: SoundSpec;
  vis: SoundVisualizer | null;
  el: HTMLElement;
  visContainer: HTMLElement;
  hasCaptured: boolean;
};

const rows = new Map<string, RowHandle>();
const sound = new Sound();
let saveStatusEl: HTMLElement | null = null;
let pendingSave: ReturnType<typeof setTimeout> | null = null;

async function init() {
  await loadSoundConfig();

  // The editor always uses the legacy engine so the cfgN() values
  // immediately drive playback. The Tone engine bakes one-shots into
  // buffers ahead of time, which would freeze the visualizer to whatever
  // values were captured at bake time. The header dropdown still lets you
  // listen with the polished tone bus once values are settled.
  sound.engine = "legacy";

  buildGlobals();
  buildList();
  hookHeader();

  setSaveStatus("loaded", "saved");

  // Pre-render every row's visualizer via OfflineAudioContext. No user
  // gesture required, no audible playback — each sound's legacy synth recipe
  // is rendered into an offline buffer and the visualizer ingests it the
  // same way it would a live capture. Serialized so the main thread stays
  // responsive: each render typically takes < 30ms but they add up.
  prerenderAllRows();
}

async function prerenderAllRows() {
  setSaveStatus("rendering 0/" + SOUND_CATALOG.length, "");
  let done = 0;
  for (const spec of SOUND_CATALOG) {
    const handle = rows.get(spec.name);
    if (!handle || !handle.vis) { done++; continue; }
    handle.el.classList.add("rendering");
    // Suppress the "no capture yet" placeholder while the rendering overlay
    // is up, otherwise both ::after labels would stack.
    handle.visContainer.classList.remove("empty");
    try {
      // Same duration budget as the live capture path (capture takes
      // expectedDurationSec + 0.15, capped at 2.5s). Thrust gets a fixed
      // 0.6s window like the live path.
      const durSec = spec.name === "thrust" ? 0.6 : Math.min(spec.expectedDurationSec + 0.15, 2.5);
      // Sample rate has to be ≥ 8000 in Chrome's OfflineAudioContext. 44.1k
      // is enough resolution for visualization and keeps render fast.
      const buf = await sound.renderOfflineLegacy(spec.name, 1, durSec, 44100);
      if (buf) {
        handle.vis.ingestBuffer(buf);
        handle.vis.render();
        handle.hasCaptured = true;
      } else {
        // Restore the placeholder if the render didn't produce a buffer
        // (e.g. browser without OfflineAudioContext).
        handle.visContainer.classList.add("empty");
      }
    } catch (e) {
      console.warn("prerender failed for", spec.name, e);
      handle.visContainer.classList.add("empty");
    } finally {
      handle.el.classList.remove("rendering");
    }
    done++;
    setSaveStatus(`rendering ${done}/${SOUND_CATALOG.length}`, "");
    // Yield to the browser between renders so the UI stays responsive
    // (slider drags, scrolling) while the queue drains.
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  setSaveStatus("ready", "saved");
}

function setSaveStatus(text: string, cls: "saved" | "error" | "" = "") {
  if (!saveStatusEl) {
    saveStatusEl = document.createElement("span");
    saveStatusEl.className = "se-save-status";
    document.querySelector(".se-header-actions")!.prepend(saveStatusEl);
  }
  saveStatusEl.textContent = text;
  saveStatusEl.className = "se-save-status " + cls;
}

function buildGlobals() {
  // Reserved for genuinely global controls. For now it's just informational
  // — universal knobs live on each row.
  const root = document.getElementById("se-globals-knobs");
  if (!root) return;
  root.innerHTML = `
    <div class="se-knob" style="opacity: 0.55">
      <span class="se-knob-label">total sounds</span>
      <span style="grid-column: 2 / 4; text-align: right; color: #e0f7ff; font-weight: 500;">${SOUND_CATALOG.length}</span>
    </div>
    <div class="se-knob" style="opacity: 0.55">
      <span class="se-knob-label">w/ semantic</span>
      <span style="grid-column: 2 / 4; text-align: right; color: #ffd86a; font-weight: 500;">${Object.keys(SEMANTIC_KNOBS).length}</span>
    </div>
  `;
}

function buildList() {
  const root = document.getElementById("se-list");
  if (!root) return;

  for (const group of GROUP_ORDER) {
    const inGroup = SOUND_CATALOG.filter((s) => s.group === group);
    if (inGroup.length === 0) continue;

    const header = document.createElement("div");
    header.className = "se-group-header";
    header.textContent = GROUP_LABEL[group];
    header.style.color = GROUP_ACCENT[group];
    root.appendChild(header);

    for (const spec of inGroup) {
      const row = buildRow(spec);
      root.appendChild(row.el);
      rows.set(spec.name, row);
    }
  }
}

function buildRow(spec: SoundSpec): RowHandle {
  const accent = GROUP_ACCENT[spec.group];
  const el = document.createElement("div");
  el.className = "se-row";
  el.dataset.sound = spec.name;
  el.innerHTML = `
    <div class="se-row-meta">
      <div class="se-row-name" style="color: ${accent}; text-shadow: 0 0 10px ${accent}55;">${spec.label}</div>
      <div class="se-row-group">${spec.name}</div>
      <div class="se-row-blurb">${spec.blurb}</div>
      <div class="se-row-actions">
        <button type="button" class="primary" data-act="play">▶ play</button>
        <button type="button" data-act="reset">reset</button>
      </div>
    </div>
    <div class="se-row-vis empty">
      <canvas data-vis></canvas>
    </div>
    <div class="se-row-knobs"></div>
  `;

  const visContainer = el.querySelector(".se-row-vis") as HTMLElement;
  const canvas = el.querySelector("canvas[data-vis]") as HTMLCanvasElement;
  const visualizer = new SoundVisualizer(canvas, { width: 480, height: 120, accent });

  const knobsEl = el.querySelector(".se-row-knobs") as HTMLElement;
  // Universal first
  for (const def of UNIVERSAL_KNOBS) {
    knobsEl.appendChild(makeKnob(spec, "universal", def));
  }
  // Semantic if defined
  const sem = SEMANTIC_KNOBS[spec.name];
  if (sem) {
    for (const def of sem) {
      knobsEl.appendChild(makeKnob(spec, "semantic", def));
    }
  }

  // Wire actions
  el.querySelector('[data-act="play"]')!.addEventListener("click", async () => {
    await playAndCapture(spec);
  });
  el.querySelector('[data-act="reset"]')!.addEventListener("click", () => {
    resetRow(spec);
  });

  return { spec, vis: visualizer, el, visContainer, hasCaptured: false };
}

function makeKnob(spec: SoundSpec, kind: "universal" | "semantic", def: KnobDef): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "se-knob " + (kind === "semantic" ? "semantic" : "");
  const labelEl = document.createElement("span");
  labelEl.className = "se-knob-label";
  labelEl.textContent = def.label;
  const input = document.createElement("input");
  input.className = "se-knob-input";
  input.type = "range";
  input.min = String(def.min);
  input.max = String(def.max);
  input.step = String(def.step);
  const initial = readConfigValue(spec.name, kind, def.key);
  input.value = String(initial);
  const valueEl = document.createElement("span");
  valueEl.className = "se-knob-value";
  valueEl.textContent = (def.fmt ?? ampFmt)(initial);

  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    writeConfigValue(spec.name, kind, def.key, v);
    valueEl.textContent = (def.fmt ?? ampFmt)(v);
    wrap.classList.add("dirty");
    schedulePersist();
    schedulePreview(spec);
  });

  wrap.appendChild(labelEl);
  wrap.appendChild(input);
  wrap.appendChild(valueEl);
  return wrap;
}

function readConfigValue(soundName: string, kind: "universal" | "semantic", key: string): number {
  const cfg = getSoundConfig();
  const entry = cfg.sounds[soundName as keyof typeof cfg.sounds];
  if (!entry) return kind === "universal" ? (key === "volume" || key === "pitch" ? 1 : 0) : 0;
  if (kind === "universal") {
    return entry.universal[key as "volume" | "pitch"];
  }
  return entry.semantic?.[key] ?? 0;
}

function writeConfigValue(soundName: string, kind: "universal" | "semantic", key: string, v: number) {
  const cfg = getSoundConfig();
  const entry = cfg.sounds[soundName as keyof typeof cfg.sounds];
  if (!entry) return;
  if (kind === "universal") {
    (entry.universal as Record<string, number>)[key] = v;
  } else {
    if (!entry.semantic) entry.semantic = {};
    entry.semantic[key] = v;
  }
  setSoundConfig(cfg);
}

function schedulePersist() {
  setSaveStatus("dirty", "");
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(async () => {
    const ok = await saveSoundConfig(getSoundConfig());
    setSaveStatus(ok ? "saved" : "save failed", ok ? "saved" : "error");
  }, 250);
}

// Re-trigger capture after a debounce so quick slider drags don't re-render
// the visualizer hundreds of times — we wait until the user pauses.
const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePreview(spec: SoundSpec) {
  const handle = rows.get(spec.name);
  if (!handle || !handle.hasCaptured) return; // don't auto-preview before first explicit play
  const existing = previewTimers.get(spec.name);
  if (existing) clearTimeout(existing);
  previewTimers.set(
    spec.name,
    setTimeout(() => {
      playAndCapture(spec, true);
    }, 220),
  );
}

async function playAndCapture(spec: SoundSpec, silent = false) {
  const handle = rows.get(spec.name);
  if (!handle || !handle.vis) return;

  sound.ensureContext();
  if (!sound.ctx || !sound.master) return;
  if (sound.ctx.state === "suspended") await sound.ctx.resume();

  // Wire master → visualizer tap (idempotent — getTap returns same node).
  const tap = handle.vis.getTap(sound.ctx);
  try { sound.master.connect(tap); } catch { /* already connected */ }

  handle.el.classList.add("playing");
  if (!silent) {
    // No-op marker — both modes do the same thing.
  }

  const pitchRatio = 1; // universal pitch is folded into Sound.play internally
  const captureDur = Math.min(spec.expectedDurationSec + 0.15, 2.5);

  // For thrust (looping), trigger then stop after the window. Sound.stopThrust
  // is called inside the capture await.
  if (spec.name === "thrust") {
    await handle.vis.capture(sound.ctx, () => { sound.play("thrust", pitchRatio); }, 0.6);
    sound.stopThrust();
  } else {
    await handle.vis.capture(
      sound.ctx,
      () => { sound.play(spec.name, pitchRatio); },
      captureDur,
    );
  }

  handle.vis.render();
  handle.visContainer.classList.remove("empty");
  handle.hasCaptured = true;
  handle.el.classList.remove("playing");
}

function resetRow(spec: SoundSpec) {
  const cfg = getSoundConfig();
  // Re-fetch defaults from disk and copy the entry only (so other sounds'
  // unsaved edits are preserved if any). Cheapest: fetch config.json again.
  fetch("/sounds/config.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((fresh: SoundConfig) => {
      const freshEntry = fresh.sounds[spec.name as keyof typeof fresh.sounds];
      if (!freshEntry) return;
      cfg.sounds[spec.name as keyof typeof cfg.sounds] = freshEntry;
      setSoundConfig(cfg);
      // Refresh sliders for this row
      const handle = rows.get(spec.name);
      if (!handle) return;
      const knobs = handle.el.querySelectorAll(".se-knob");
      knobs.forEach((wrap) => {
        const input = wrap.querySelector("input") as HTMLInputElement | null;
        const valueEl = wrap.querySelector(".se-knob-value") as HTMLElement | null;
        const labelEl = wrap.querySelector(".se-knob-label") as HTMLElement | null;
        if (!input || !valueEl || !labelEl) return;
        const kind = wrap.classList.contains("semantic") ? "semantic" : "universal";
        const allDefs: KnobDef[] = kind === "universal" ? UNIVERSAL_KNOBS : (SEMANTIC_KNOBS[spec.name] ?? []);
        const def = allDefs.find((d) => d.label === labelEl.textContent);
        if (!def) return;
        const v = readConfigValue(spec.name, kind, def.key);
        input.value = String(v);
        valueEl.textContent = (def.fmt ?? ampFmt)(v);
        wrap.classList.remove("dirty");
      });
      schedulePersist();
      if (handle.hasCaptured) playAndCapture(spec, true);
    });
}

function hookHeader() {
  const engineSel = document.getElementById("se-engine-select") as HTMLSelectElement | null;
  if (engineSel) {
    engineSel.value = sound.engine;
    engineSel.addEventListener("change", () => {
      const next = engineSel.value as "legacy" | "tone";
      if (next === sound.engine) return;
      sound.cycleEngine();
      // cycleEngine flips one step; if we needed to flip twice, do it again.
      if (sound.engine !== next) sound.cycleEngine();
    });
  }
  const reCap = document.getElementById("se-recapture-all");
  if (reCap) {
    reCap.addEventListener("click", async () => {
      for (const spec of SOUND_CATALOG) {
        const handle = rows.get(spec.name);
        if (!handle || !handle.hasCaptured) continue;
        await playAndCapture(spec, true);
      }
    });
  }
}

init().catch((e) => {
  console.error("sound editor init failed", e);
});
