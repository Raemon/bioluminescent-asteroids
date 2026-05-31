// /sound — checkbox-based mixer. Each row is a "track" built from the sound
// registry (sounds.ts) and animation registry (animations.ts). Checked tracks
// play together on a shared 0.5s (BEAT_GRID) beat clock at the cadence they'd
// hit during gameplay; continuous loops (thrust / reverseThrust / sideThrust)
// start/stop directly off the checkbox.
//
// Adding a new sound = one entry in sounds.ts. Adding a new entity visual =
// one entry in animations.ts. Nothing in this file changes.

import { Sound } from "../../Sound";
import { loadSoundConfig } from "../../soundConfig";
import { BEAT_GRID } from "../../game/rhythmConstants";
import { ANIMATIONS, type Animator } from "./animations";
import { SOUND_ENTRIES, type SoundEntry } from "./sounds";

const sound = new Sound();

type RowHandle = {
  entry: SoundEntry;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  checkbox: HTMLInputElement;
  animator: Animator;
  mountedAt: number;
  // Track-local "last fire" timestamp in animator seconds (since mount). The
  // animator uses this to detect a new fire event and start/restart a
  // hit-flash or bullet volley.
  lastFiredAtAnim: number;
  // For loop tracks — whether we've already started the underlying sound.
  loopActive: boolean;
};

const handles: RowHandle[] = [];
// Shared beat clock — seconds since the page mounted, ticked every frame.
// Integer beat slots fall on multiples of BEAT_GRID. Eighth-note phase
// (0.5 beats) is used by off-beat rows.
let masterBeatTime = 0;
let lastBeatTickIdx = -1;
let lastHalfBeatTickIdx = -1;
let lastFrameMs = 0;

async function init() {
  await loadSoundConfig();
  // The bgBeat is gated on bgBeatIntensity (0 = silent), which Game ramps
  // 0.08 → 1.0 across waves 1–30. The page has no wave clock, so without
  // this the pulsar-beat row would tick visually but emit nothing. Pin to
  // the same wave-6 level the pulsar visual is locked to, so audio matches
  // what you see and reads as typical-game volume rather than wave-30 peak.
  sound.bgBeatIntensity = 0.08 + (5 / 29) * 0.92;
  const list = document.getElementById("se-list");
  if (!list) return;

  for (const entry of SOUND_ENTRIES) {
    const el = document.createElement("div");
    el.className = "se-row";
    el.innerHTML = `
      <div class="se-vis"><canvas width="200" height="100"></canvas></div>
      <div class="se-meta">
        <div class="se-label">${entry.label}</div>
        <div class="se-sublabel">${entry.sublabel ?? ""}</div>
      </div>
      <label class="se-check">
        <input type="checkbox" />
        <span class="se-check-mark"></span>
      </label>
    `;
    list.appendChild(el);

    const canvas = el.querySelector("canvas") as HTMLCanvasElement;
    const ctx2d = canvas.getContext("2d");
    const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (!ctx2d) continue;

    const animator = ANIMATIONS[entry.animation]();

    const handle: RowHandle = {
      entry,
      el,
      canvas,
      ctx: ctx2d,
      checkbox,
      animator,
      mountedAt: performance.now(),
      lastFiredAtAnim: -1,
      loopActive: false,
    };
    handles.push(handle);

    checkbox.addEventListener("change", () => {
      el.classList.toggle("checked", checkbox.checked);
      // Resume audio on the first user gesture so iOS / Chrome let us play.
      sound.ensureContext();
      if (sound.ctx?.state === "suspended") sound.ctx.resume();
      handleCheckChange(handle);
    });
  }

  lastFrameMs = performance.now();
  requestAnimationFrame(tick);
}

function handleCheckChange(h: RowHandle) {
  if (h.entry.trigger.kind !== "loop") return;
  if (h.checkbox.checked && !h.loopActive) {
    sound.play(h.entry.sound);
    h.loopActive = true;
    return;
  }
  if (!h.checkbox.checked && h.loopActive) {
    // Each continuous-loop sound has its own stop method. Anything else falls
    // through harmlessly (one-shot semantics — the sound has already finished
    // by the time the user unchecks).
    if (h.entry.sound === "thrust") sound.stopThrust();
    else if (h.entry.sound === "reverseThrust") sound.stopReverseThrust();
    else if (h.entry.sound === "sideThrust") sound.stopSideThrust();
    h.loopActive = false;
  }
}

function tick(nowMs: number) {
  const dtMs = nowMs - lastFrameMs;
  lastFrameMs = nowMs;
  const dt = Math.min(0.05, dtMs / 1000);

  masterBeatTime += dt;

  // Walk every beat slot crossed since the last frame. With dt ≤ 50ms and
  // BEAT_GRID = 500ms this loop runs at most once per frame, but the walk
  // is necessary if the tab was throttled and dt was clamped.
  const currentBeatIdx = Math.floor(masterBeatTime / BEAT_GRID);
  while (lastBeatTickIdx < currentBeatIdx) {
    lastBeatTickIdx += 1;
    fireSlot(lastBeatTickIdx, 0);
  }

  // Off-beat (eighth-note) slots: phaseBeats = 0.5 tracks fire half a beat
  // after each downbeat. We detect the crossing of the half-beat mark
  // separately so the eighth grid stays robust to dt jitter.
  const halfBeatNow = Math.floor((masterBeatTime - BEAT_GRID * 0.5) / BEAT_GRID);
  while (lastHalfBeatTickIdx < halfBeatNow) {
    lastHalfBeatTickIdx += 1;
    fireSlot(lastHalfBeatTickIdx, 0.5);
  }

  // Per-row animator tick.
  for (const h of handles) {
    const t = (nowMs - h.mountedAt) / 1000;
    h.animator({
      ctx: h.ctx,
      w: h.canvas.width,
      h: h.canvas.height,
      t,
      dt,
      playing: h.loopActive,
      firedAt: h.lastFiredAtAnim,
    });
  }

  requestAnimationFrame(tick);
}

function fireSlot(beatIdx: number, phaseBeats: 0 | 0.5) {
  for (const h of handles) {
    if (!h.checkbox.checked) continue;
    const trig = h.entry.trigger;
    if (trig.kind !== "beat") continue;
    if (trig.phaseBeats !== phaseBeats) continue;
    if (beatIdx % trig.periodBeats !== 0) continue;
    fireRow(h);
  }
}

function fireRow(h: RowHandle) {
  sound.play(h.entry.sound);
  // Animator-relative timestamp so the visual flash lines up with the audio.
  h.lastFiredAtAnim = (performance.now() - h.mountedAt) / 1000;
  // Brief CSS flash on the canvas frame.
  h.el.classList.add("firing");
  window.setTimeout(() => h.el.classList.remove("firing"), 160);
}

init().catch((e) => console.error("/sound init failed", e));
