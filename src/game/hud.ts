import type { Game } from "../Game";

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

// Why: single one-time DOM lookup means a missing element fails loudly at boot, not mid-game.
export const bindHudElements = (): HudElements => ({
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
});

// Why: collapses score/wave/lives/combo DOM writes into one call so handlers stay one-liners.
export const syncHud = (game: Game) => {
  game.scoreEl.textContent = String(game.score).padStart(6, "0");
  game.waveEl.textContent = `WAVE ${game.wave}`;
  const lifeSpans: string[] = [];
  for (let i = 0; i < game.lives; i++) lifeSpans.push("<span></span>");
  game.livesEl.innerHTML = lifeSpans.join("");
  syncComboHud(game);
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
