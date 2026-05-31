// /sound — checkbox-based mixer. The page walks the object×action registry
// (sounds.ts) and renders one section per game object, with one checkbox row
// per action that object performs. Checked rows play together on a shared
// 0.5s (BEAT_GRID) beat clock at the cadence they'd hit in gameplay;
// continuous loops (thrust / reverseThrust / sideThrust) start/stop directly
// off the checkbox.
//
// Add a sound → an action in sounds.ts under the right object.
// Add an object → entry in animations.ts + entry in OBJECTS in sounds.ts.

import { Sound } from "../../Sound";
import { loadSoundConfig } from "../../soundConfig";
import { BEAT_GRID } from "../../game/rhythmConstants";
import { ANIMATIONS, type Animator } from "./animations";
import { OBJECTS, animationFor, sublabelFor, type Action, type GameObject } from "./sounds";

const sound = new Sound();

type RowHandle = {
  object: GameObject;
  action: Action;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  checkbox: HTMLInputElement;
  animator: Animator;
  mountedAt: number;
  // Animator-relative seconds when this row's sound last fired (-1 if never).
  lastFiredAtAnim: number;
  // For loop rows — whether we've already started the underlying sound.
  loopActive: boolean;
};

const handles: RowHandle[] = [];
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

  for (const object of OBJECTS) {
    const section = document.createElement("section");
    section.className = "se-section";

    object.actions.forEach((action, idx) => {
      const el = document.createElement("div");
      el.className = "se-row";
      // Object label only on the first row of each object — keeps a visual
      // grouping without spending a whole row on a header.
      const objectLabel = idx === 0 ? object.label : "";
      el.innerHTML = `
        <div class="se-object">${objectLabel}</div>
        <div class="se-vis"><canvas width="200" height="100"></canvas></div>
        <div class="se-label">${action.verb}</div>
        <div class="se-sublabel">${sublabelFor(action)}</div>
        <label class="se-check">
          <input type="checkbox" />
          <span class="se-check-mark"></span>
        </label>
      `;
      section.appendChild(el);

      const canvas = el.querySelector("canvas") as HTMLCanvasElement;
      const ctx2d = canvas.getContext("2d");
      const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
      if (!ctx2d) return;

      const animator = ANIMATIONS[animationFor(object, action)]();
      const handle: RowHandle = {
        object,
        action,
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
        sound.ensureContext();
        if (sound.ctx?.state === "suspended") sound.ctx.resume();
        handleCheckChange(handle);
      });
    });

    list.appendChild(section);
  }

  lastFrameMs = performance.now();
  requestAnimationFrame(tick);
}

function handleCheckChange(h: RowHandle) {
  if (h.action.trigger.kind !== "loop") return;
  if (h.checkbox.checked && !h.loopActive) {
    sound.play(h.action.sound);
    h.loopActive = true;
    return;
  }
  if (!h.checkbox.checked && h.loopActive) {
    if (h.action.sound === "thrust") sound.stopThrust();
    else if (h.action.sound === "reverseThrust") sound.stopReverseThrust();
    else if (h.action.sound === "sideThrust") sound.stopSideThrust();
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

  // Off-beat (eighth-note) slots: phaseBeats = 0.5 rows fire half a beat
  // after each downbeat. Detected via a parallel index so the eighth grid
  // stays robust to dt jitter.
  const halfBeatNow = Math.floor((masterBeatTime - BEAT_GRID * 0.5) / BEAT_GRID);
  while (lastHalfBeatTickIdx < halfBeatNow) {
    lastHalfBeatTickIdx += 1;
    fireSlot(lastHalfBeatTickIdx, 0.5);
  }

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
    const trig = h.action.trigger;
    if (trig.kind !== "beat") continue;
    if ((trig.phaseBeats ?? 0) !== phaseBeats) continue;
    if (beatIdx % trig.periodBeats !== 0) continue;
    fireRow(h);
  }
}

function fireRow(h: RowHandle) {
  sound.play(h.action.sound);
  h.lastFiredAtAnim = (performance.now() - h.mountedAt) / 1000;
  h.el.classList.add("firing");
  window.setTimeout(() => h.el.classList.remove("firing"), 160);
}

init().catch((e) => console.error("/sound init failed", e));
