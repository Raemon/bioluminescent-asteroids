// /soundeditor — checkbox-based mixer. Each row is a "track" that pairs the
// in-game visual for a sound with a checkbox; checked tracks play together on
// a shared 0.5s (BEAT_GRID) beat clock, at the cadence they'd hit during
// gameplay. Continuous loops (thrust / reverseThrust) start/stop directly off
// the checkbox.

import { Sound, type SoundName } from "../Sound";
import { Ship } from "../Ship";
import { Bullet } from "../Bullet";
import { Asteroid } from "../Asteroid";
import { v, TAU } from "../vec";
import { loadSoundConfig } from "../soundConfig";
import { BEAT_GRID } from "../game/rhythmConstants";

// Animator inputs. `firing` is true on the frame a one-shot track triggers
// its sound; animators can use it to drive a hit-flash that decays naturally
// over the next several frames. `playing` is true while a continuous-loop
// row's checkbox is on (drives thrust flame, retro flares).
type AnimatorCtx = {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  t: number;
  dt: number;
  playing: boolean;
  firedAt: number; // seconds since canvas mount when last fire happened (-1 if never)
};

type TrackKind =
  | { kind: "loop"; sound: SoundName }
  | { kind: "beat"; sound: SoundName; periodBeats: number; phaseBeats: number };

type Track = {
  label: string;
  sublabel: string;
  trigger: TrackKind;
  animator: (a: AnimatorCtx) => void;
};

// ── tracks ──────────────────────────────────────────────────────────────

const TRACKS: Track[] = [
  {
    label: "pulsar beat",
    sublabel: "bgBeat · every beat",
    trigger: { kind: "beat", sound: "bgBeat", periodBeats: 1, phaseBeats: 0 },
    animator: drawPulsar(),
  },
  {
    label: "ship thrusting",
    sublabel: "thrust · continuous",
    trigger: { kind: "loop", sound: "thrust" },
    animator: drawShip({ thrust: true, reverse: false }),
  },
  {
    label: "back thrusting",
    sublabel: "reverseThrust · continuous",
    trigger: { kind: "loop", sound: "reverseThrust" },
    animator: drawShip({ thrust: false, reverse: true }),
  },
  {
    label: "weak bullet",
    sublabel: "fire · off-beat",
    trigger: { kind: "beat", sound: "fire", periodBeats: 1, phaseBeats: 0.5 },
    animator: drawBullet({ onBeat: false, boosted: false, count: 1 }),
  },
  {
    label: "rhythm bullet",
    sublabel: "fireBeat · on-beat",
    trigger: { kind: "beat", sound: "fireBeat", periodBeats: 1, phaseBeats: 0 },
    animator: drawBullet({ onBeat: true, boosted: false, count: 1 }),
  },
  {
    label: "4x bullets",
    sublabel: "fireBeat · trident on-beat",
    trigger: { kind: "beat", sound: "fireBeat", periodBeats: 1, phaseBeats: 0 },
    animator: drawBullet({ onBeat: true, boosted: true, count: 3 }),
  },
  {
    label: "big asteroid weak hit",
    sublabel: "explosionSmall · chip every 2 beats",
    trigger: { kind: "beat", sound: "explosionSmall", periodBeats: 2, phaseBeats: 0 },
    animator: drawAsteroidHit({ killing: false }),
  },
  {
    label: "strong bullet hit",
    sublabel: "explosionLarge · kill every 4 beats",
    trigger: { kind: "beat", sound: "explosionLarge", periodBeats: 4, phaseBeats: 0 },
    animator: drawAsteroidHit({ killing: true }),
  },
];

// ── visuals ─────────────────────────────────────────────────────────────

// A miniature pulsar — a hot bright core with two opposing beams that snap
// to peak on every beat fire, then decay. Independent of the in-game Pulsar
// class (which draws to a full-screen canvas with planets); this is a
// portable cell-sized version that reads the same as "the pulsar pulsing."
function drawPulsar() {
  return ({ ctx, w, h, t, firedAt }: AnimatorCtx) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    // Pulse envelope: snaps to 1 at firedAt and decays with a ~0.4s tail.
    const sincePulse = firedAt >= 0 ? t - firedAt : Infinity;
    const pulse = Math.max(0, Math.exp(-sincePulse * 3.2));
    // Slow rotation so the beams sweep visibly between pulses.
    const spin = t * 1.6;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Outer halo (the "approach glow"), driven by pulse.
    const haloR = 32 + 18 * pulse;
    const haloG = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    haloG.addColorStop(0, `hsla(48, 100%, 70%, ${0.45 + 0.4 * pulse})`);
    haloG.addColorStop(0.5, `hsla(48, 100%, 60%, ${0.18 + 0.2 * pulse})`);
    haloG.addColorStop(1, `hsla(48, 100%, 60%, 0)`);
    ctx.fillStyle = haloG;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, TAU);
    ctx.fill();

    // Twin beams — lengthen on the pulse.
    const beamLen = 26 + 22 * pulse;
    const beamW = 4 + 6 * pulse;
    for (const dir of [0, Math.PI]) {
      const a = spin + dir;
      const tipX = cx + Math.cos(a) * beamLen;
      const tipY = cy + Math.sin(a) * beamLen;
      const grad = ctx.createLinearGradient(cx, cy, tipX, tipY);
      grad.addColorStop(0, `hsla(48, 100%, 92%, ${0.85 + 0.15 * pulse})`);
      grad.addColorStop(1, `hsla(48, 100%, 80%, 0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = beamW;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
    }

    // Bright neutron-star core.
    const coreR = 5 + 4 * pulse;
    const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    coreG.addColorStop(0, `hsla(60, 100%, 98%, 1)`);
    coreG.addColorStop(0.5, `hsla(48, 100%, 88%, 0.8)`);
    coreG.addColorStop(1, `hsla(48, 100%, 70%, 0)`);
    ctx.fillStyle = coreG;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fill();

    ctx.restore();
  };
}

function drawShip(opts: { thrust: boolean; reverse: boolean }) {
  const ship = new Ship(v(0, 0));
  ship.invuln = 0;
  return ({ ctx, w, h, t, playing }: AnimatorCtx) => {
    ctx.clearRect(0, 0, w, h);
    ship.pos = v(w / 2, h / 2);
    ship.heading = -Math.PI / 2 + Math.sin(t * 0.6) * 0.2;
    ship.thrustOn = opts.thrust && playing;
    ship.reverseThrustOn = opts.reverse && playing;
    ship.render(ctx, t * 1000, 0);
  };
}

function drawBullet(opts: { onBeat: boolean; boosted: boolean; count: number }) {
  const lanes = opts.count === 3 ? [-0.35, 0, 0.35] : [0];
  type Tracked = { bullet: Bullet; vx: number; vy: number };
  let tracked: Tracked[] = [];
  let lastFiredAt = -1;
  return ({ ctx, w, h, dt, firedAt }: AnimatorCtx) => {
    ctx.clearRect(0, 0, w, h);
    // Spawn a fresh volley each time the sound fires.
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

function drawAsteroidHit(opts: { killing: boolean }) {
  let asteroid = new Asteroid(v(0, 0), v(0, 0), "large");
  let lastFiredAt = -1;
  let killedAt = -Infinity;
  return ({ ctx, w, h, t, dt, firedAt }: AnimatorCtx) => {
    ctx.clearRect(0, 0, w, h);

    // Fresh fire = apply a hit. For the killing variant, walk it down all
    // the way; for the chip variant just one hit at a time, re-spawning
    // when it would die so the row stays visually intact.
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

// ── runtime ─────────────────────────────────────────────────────────────

const sound = new Sound();

type RowHandle = {
  track: Track;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  checkbox: HTMLInputElement;
  mountedAt: number;
  // Track-local "last fire" timestamp in animator seconds (since mount). The
  // animator uses this to detect a new fire event and start/restart a
  // hit-flash or bullet volley.
  lastFiredAtAnim: number;
  lastTickAt: number;
  // For loop tracks — whether we've already started the underlying sound.
  loopActive: boolean;
};

const handles: RowHandle[] = [];
// Shared beat clock — seconds since the editor mounted, ticked every frame.
// Integer beat slots fall on multiples of BEAT_GRID. Eighth-note phase (0.5
// beats) is used by the "weak bullet" off-beat row.
let masterBeatTime = 0;
let lastBeatTickIdx = -1;
let lastHalfBeatTickIdx = -1;
let lastFrameMs = 0;

async function init() {
  await loadSoundConfig();
  const list = document.getElementById("se-list");
  if (!list) return;

  for (const track of TRACKS) {
    const el = document.createElement("div");
    el.className = "se-row";
    el.innerHTML = `
      <div class="se-vis"><canvas width="200" height="100"></canvas></div>
      <div class="se-meta">
        <div class="se-label">${track.label}</div>
        <div class="se-sublabel">${track.sublabel}</div>
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

    const handle: RowHandle = {
      track,
      el,
      canvas,
      ctx: ctx2d,
      checkbox,
      mountedAt: performance.now(),
      lastFiredAtAnim: -1,
      lastTickAt: performance.now(),
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
  if (h.track.trigger.kind === "loop") {
    if (h.checkbox.checked && !h.loopActive) {
      sound.play(h.track.trigger.sound);
      h.loopActive = true;
    } else if (!h.checkbox.checked && h.loopActive) {
      if (h.track.trigger.sound === "thrust") sound.stopThrust();
      else if (h.track.trigger.sound === "reverseThrust") sound.stopReverseThrust();
      h.loopActive = false;
    }
  }
  // Beat tracks need no immediate action — they fire on the next matching
  // beat slot.
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
    fireBeatSlot(lastBeatTickIdx);
  }

  // Off-beat (eighth-note) slots: phaseBeats = 0.5 tracks fire half a beat
  // after each downbeat. We detect the crossing of the half-beat mark
  // separately so the eighth grid stays robust to dt jitter.
  const halfBeatNow = Math.floor((masterBeatTime - BEAT_GRID * 0.5) / BEAT_GRID);
  while (lastHalfBeatTickIdx < halfBeatNow) {
    lastHalfBeatTickIdx += 1;
    fireOffBeatSlot(lastHalfBeatTickIdx);
  }

  // Per-row animator tick.
  for (const h of handles) {
    const t = (nowMs - h.mountedAt) / 1000;
    const playing = h.loopActive;
    h.track.animator({
      ctx: h.ctx,
      w: h.canvas.width,
      h: h.canvas.height,
      t,
      dt,
      playing,
      firedAt: h.lastFiredAtAnim,
    });
  }

  requestAnimationFrame(tick);
}

function fireBeatSlot(beatIdx: number) {
  for (const h of handles) {
    if (!h.checkbox.checked) continue;
    if (h.track.trigger.kind !== "beat") continue;
    if (h.track.trigger.phaseBeats !== 0) continue;
    if (beatIdx % h.track.trigger.periodBeats !== 0) continue;
    fireRow(h);
  }
}

function fireOffBeatSlot(beatIdx: number) {
  for (const h of handles) {
    if (!h.checkbox.checked) continue;
    if (h.track.trigger.kind !== "beat") continue;
    if (h.track.trigger.phaseBeats !== 0.5) continue;
    if (beatIdx % h.track.trigger.periodBeats !== 0) continue;
    fireRow(h);
  }
}

function fireRow(h: RowHandle) {
  if (h.track.trigger.kind !== "beat") return;
  sound.play(h.track.trigger.sound);
  // Animator-relative timestamp so the visual flash lines up with the audio.
  h.lastFiredAtAnim = (performance.now() - h.mountedAt) / 1000;
  // Brief CSS flash on the canvas frame.
  h.el.classList.add("firing");
  window.setTimeout(() => h.el.classList.remove("firing"), 160);
}

init().catch((e) => console.error("sound editor init failed", e));
