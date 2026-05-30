import type { Game } from "../Game";
import { BEAT_GRID } from "./rhythmConstants";

// Pilot's Log unlocks fire at specific combo milestones. Each entry has a
// vocal cue (pre-rendered scratchy-radio MP3 in /sounds/vocals/) and a brief
// "unlocked" overlay on the HUD. Combo x6 = entry 1.
//
// Cadence: vocals are aligned to the next downbeat (every 2s = 4 beats) so
// the spoken line lands on the pad melody's phrase grid instead of floating
// in between bass hits.
const DOWNBEAT_SECONDS = BEAT_GRID * 4;

// Snap forward to the next downbeat boundary. Returns the delay in seconds.
const nextDownbeatDelay = (beatTime: number): number => {
  const phase = beatTime % DOWNBEAT_SECONDS;
  return phase === 0 ? 0 : DOWNBEAT_SECONDS - phase;
};

// Fade the chapter title in over the canvas. Inner <span> carries the
// scaleX squeeze (matches the main-menu title); outer element does the
// fade so the two transforms don't compose into a moving target.
const showUnlockToast = (label: string) => {
  let el = document.getElementById("pilot-log-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "pilot-log-toast";
    const inner = document.createElement("span");
    el.appendChild(inner);
    document.body.appendChild(el);
  }
  const inner = el.firstElementChild as HTMLSpanElement;
  inner.textContent = label;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  window.setTimeout(() => { el?.classList.remove("show"); }, 5000);
};

// Fire the combo-x6 unlock: HUD toast immediately, vocal cue on the next
// downbeat so it locks to the pad's phrase grid. Guarded so a stutter at the
// threshold can't re-trigger the line mid-playback.
export const tryUnlockPilotLog1 = (game: Game) => {
  if (game.pilotLog1Unlocked) return;
  if (game.beatCombo < 6) return;
  game.pilotLog1Unlocked = true;
  showUnlockToast("Chapter 1: The Outer Rim");
  game.sound.pilotLogPlaying = true;
  const delay = nextDownbeatDelay(game.beatTime);
  game.sound.playPilotLog(1, delay, 1.0).then((dur) => {
    window.setTimeout(() => { game.sound.pilotLogPlaying = false; }, (delay + dur + 0.5) * 1000);
  });
};
