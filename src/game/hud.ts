import type { Game } from "../Game";
import { SLOW_MO_DURATION } from "./slowMo";

// Why: cache the DOM handles once so per-frame syncs don't repeat document.getElementById calls.
export type HudElements = {
  scoreEl: HTMLElement;
  comboEl: HTMLElement;
  comboValueEl: HTMLElement;
  waveEl: HTMLElement;
  livesEl: HTMLElement;
  overlayEl: HTMLElement;
  overlayTitleEl: HTMLElement;
  overlayStartEl: HTMLElement;
  muteEl: HTMLButtonElement;
  abortEl: HTMLButtonElement;
  killedRowEl: HTMLCanvasElement;
};

// Cached references for the powerup slot row; resolved once at boot.
const powerupSlots: Record<string, HTMLElement> = {};
let slowProgressEl: HTMLElement | null = null;

// Why: single one-time DOM lookup means a missing element fails loudly at boot, not mid-game.
export const bindHudElements = (): HudElements => {
  const slots = document.querySelectorAll<HTMLElement>("#powerups .powerup-slot");
  slots.forEach((el) => {
    const kind = el.dataset.kind;
    if (kind) powerupSlots[kind] = el;
  });
  slowProgressEl = powerupSlots.slow?.querySelector<HTMLElement>(".powerup-progress") ?? null;
  return {
    scoreEl: document.getElementById("score")!,
    comboEl: document.getElementById("combo")!,
    comboValueEl: document.getElementById("combo-value")!,
    waveEl: document.getElementById("wave")!,
    livesEl: document.getElementById("lives")!,
    overlayEl: document.getElementById("overlay")!,
    overlayTitleEl: document.getElementById("overlay-title")!,
    overlayStartEl: document.getElementById("overlay-start")!,
    muteEl: document.getElementById("mute") as HTMLButtonElement,
    abortEl: document.getElementById("abort-mission") as HTMLButtonElement,
    killedRowEl: document.getElementById("killed-row") as HTMLCanvasElement,
  };
};

// Why: toggling the class on every frame would re-fire the pop animation; only flip on change.
const setSlotActive = (kind: string, active: boolean) => {
  const el = powerupSlots[kind];
  if (!el) return;
  const isActive = el.classList.contains("active");
  if (active && !isActive) el.classList.add("active");
  else if (!active && isActive) el.classList.remove("active");
};

// Why: collapses score/wave/lives/combo DOM writes into one call so handlers stay one-liners.
export const syncHud = (game: Game) => {
  game.scoreEl.textContent = String(game.score).padStart(6, "0");
  game.waveEl.textContent = `WAVE ${game.wave}`;
  const lifeSpans: string[] = [];
  for (let i = 0; i < game.lives; i++) lifeSpans.push("<span></span>");
  game.livesEl.innerHTML = lifeSpans.join("");
  syncComboHud(game);
  syncPowerupHud(game);
};

// Why: persistent flags drive on/off; slow-mo also shows a bottom-up timer bar of remaining duration.
export const syncPowerupHud = (game: Game) => {
  setSlotActive("trident", game.ship.tridentActive);
  setSlotActive("rapid", game.ship.rapidActive);
  setSlotActive("pierce", game.ship.pierceActive);
  setSlotActive("shield", game.ship.shieldActive);
  const slowOn = game.slowMoTimer > 0;
  setSlotActive("slow", slowOn);
  if (slowProgressEl) {
    const pct = slowOn ? Math.max(0, Math.min(1, game.slowMoTimer / SLOW_MO_DURATION)) * 100 : 0;
    slowProgressEl.style.height = `${pct}%`;
  }
};

// Why: x1 ("primed") doesn't yet multiply anything, so we hide it to avoid misleading the player.
export const syncComboHud = (game: Game) => {
  if (game.beatCombo >= 2) {
    game.comboEl.classList.remove("hidden");
    game.comboValueEl.textContent = String(game.beatCombo);
  } else {
    game.comboEl.classList.add("hidden");
  }
};
