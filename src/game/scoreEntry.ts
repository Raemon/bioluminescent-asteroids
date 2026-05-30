import type { Game } from "../Game";
import {
  fetchHighscores,
  getRecentName,
  saveRecentName,
  submitHighscore,
  type HighscoreRow,
} from "./highscores";

// one module owns the score-entry form + leaderboard so lifecycle.ts and
// gameUpdate.ts don't have to know about DOM details or network state.

const setStatus = (game: Game, msg: string, kind: "info" | "error" | "success" = "info") => {
  game.scoreEntryStatusEl.textContent = msg;
  game.scoreEntryStatusEl.classList.remove("error", "success");
  if (kind === "error") game.scoreEntryStatusEl.classList.add("error");
  else if (kind === "success") game.scoreEntryStatusEl.classList.add("success");
};

const handleSubmit = async (game: Game, ev: Event) => {
  ev.preventDefault();
  if (game.scoreSubmitState !== "idle") return;
  const rawName = game.scoreEntryInputEl.value.trim();
  if (!rawName) {
    setStatus(game, "Enter a name to save your score.", "error");
    return;
  }
  game.scoreSubmitState = "submitting";
  game.scoreEntrySubmitEl.disabled = true;
  game.scoreEntryInputEl.disabled = true;
  setStatus(game, "Transmitting…", "info");
  try {
    const saved = await submitHighscore(rawName, game);
    saveRecentName(rawName);
    game.lastRunScoreId = saved.id;
    game.lastRunScore = saved.score;
    game.scoreSubmitState = "submitted";
    setStatus(game, "Score saved. Press enter to continue.", "success");
    game.scoreEntryInputEl.blur();
  } catch (err) {
    game.scoreSubmitState = "idle";
    game.scoreEntrySubmitEl.disabled = false;
    game.scoreEntryInputEl.disabled = false;
    setStatus(game, `Save failed: ${(err as Error).message}`, "error");
  }
};

// the Enter key normally restarts the game from the gameover screen, but
// while the input is focused we want it to submit the form instead. Escape
// dismisses the form so the player can press Enter to skip submission and
// restart without typing a name.
const handleInputKeydown = (game: Game, ev: KeyboardEvent) => {
  if (ev.key === "Enter") {
    ev.stopPropagation();
    return;
  }
  if (ev.key === "Escape") {
    ev.stopPropagation();
    ev.preventDefault();
    hideScoreEntry(game);
  }
};

let listenersBound = false;

const bindListeners = (game: Game) => {
  if (listenersBound) return;
  listenersBound = true;
  game.scoreEntryFormEl.addEventListener("submit", (ev) => void handleSubmit(game, ev));
  game.scoreEntryInputEl.addEventListener("keydown", (ev) => handleInputKeydown(game, ev));
};

export const showScoreEntry = (game: Game) => {
  bindListeners(game);
  // ram-only or otherwise score-less runs shouldn't pester for a name —
  // there's nothing meaningful to record.
  if (game.score <= 0) {
    game.scoreEntryFormEl.classList.add("hidden");
    return;
  }
  game.scoreSubmitState = "idle";
  game.scoreEntryInputEl.disabled = false;
  game.scoreEntrySubmitEl.disabled = false;
  game.scoreEntryInputEl.value = getRecentName();
  setStatus(game, "Esc to skip", "info");
  game.scoreEntryFormEl.classList.remove("hidden");
  // Defer focus so the overlay reveal animation doesn't fight the input.
  setTimeout(() => {
    if (!game.scoreEntryFormEl.classList.contains("hidden")) game.scoreEntryInputEl.focus();
  }, 60);
};

export const hideScoreEntry = (game: Game) => {
  game.scoreEntryFormEl.classList.add("hidden");
  game.scoreEntryInputEl.blur();
};

// scoreSubmitState gates whether Enter restarts the game — we want the
// player to confirm the save (or see the error) before bouncing back to title.
export const isScoreEntryBlockingEnter = (game: Game): boolean => {
  if (game.scoreEntryFormEl.classList.contains("hidden")) return false;
  return game.scoreSubmitState !== "submitted";
};

// max-combo-first sort celebrates the headline streak stat; used for the title-screen view.
const sortByComboThenScore = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const comboDiff = (b.max_combo ?? 0) - (a.max_combo ?? 0);
    if (comboDiff !== 0) return comboDiff;
    return b.score - a.score;
  });

// gameover ranks strictly by score so "5 closest in either direction" around the
//   player's run is well-defined.
const sortByScore = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => b.score - a.score);

// 11-row window (5 above + selected + 5 below) matches the original neighborhood view.
const WINDOW_RADIUS = 5;
const WINDOW_SIZE = WINDOW_RADIUS * 2 + 1;

// Window anchor that keeps the selection centred when possible, but clamps
//   against the list boundaries so we never show empty slots above the #1 row
//   or below the last row.
const windowStart = (selection: number, total: number): number => {
  if (total <= WINDOW_SIZE) return 0;
  const ideal = selection - WINDOW_RADIUS;
  const maxStart = total - WINDOW_SIZE;
  return Math.max(0, Math.min(maxStart, ideal));
};

const renderLeaderboard = (game: Game) => {
  const rows = game.leaderboardRows;
  if (rows.length === 0) {
    game.leaderboardListEl.innerHTML =
      '<li class="leaderboard-status">No scores yet — be the first pilot on the board.</li>';
    return;
  }
  const start = windowStart(game.leaderboardSelection, rows.length);
  const end = Math.min(rows.length, start + WINDOW_SIZE);
  const header = `<li class="lb-header">
    <span class="lb-rank"></span>
    <span class="lb-name">Pilot</span>
    <span class="lb-score">Score</span>
    <span class="lb-combo">Rhythm</span>
    <span class="lb-wave">Wave</span>
  </li>`;
  const items: string[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const safeName = escapeHtml(row.name);
    const combo = row.max_combo ?? 0;
    const comboTier = combo >= 8 ? "white" : combo >= 4 ? "gold" : combo >= 2 ? "cyan" : "dim";
    const wave = row.wave ?? 1;
    const cls = i === game.leaderboardSelection ? ' class="lb-self"' : "";
    items.push(`<li${cls}>
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name">${safeName}</span>
      <span class="lb-score">${row.score.toLocaleString()}</span>
      <span class="lb-combo lb-combo-${comboTier}">
        <span class="lb-combo-value">${combo}<span class="lb-combo-x">×</span></span>
      </span>
      <span class="lb-wave">${wave}</span>
    </li>`);
  }
  game.leaderboardListEl.innerHTML = header + items.join("");
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

// matches the API's MAX_LIMIT — fetching the full slice means a returning pilot
//   ranked anywhere in the top tier will be found by id and the rotation has
//   enough pilots to scroll through.
const LEADERBOARD_FETCH_LIMIT = 50;

const setLeaderboardTitle = (game: Game, text: string) => {
  const titleEl = game.leaderboardEl.querySelector(".leaderboard-title");
  if (titleEl) titleEl.textContent = text;
};

export const showLeaderboard = (game: Game) => {
  game.leaderboardEl.classList.remove("hidden");
  const showNeighborhood = game.lastRunScoreId !== null;
  setLeaderboardTitle(game, showNeighborhood ? "Your Standing" : "Top Pilots");
  game.leaderboardListEl.innerHTML =
    `<li class="leaderboard-status">${showNeighborhood ? "Loading your standing…" : "Loading top pilots…"}</li>`;
  game.leaderboardRows = [];
  game.leaderboardSelection = 0;
  game.leaderboardActive = false;
  void refreshLeaderboard(game);
};

export const refreshLeaderboard = async (game: Game) => {
  const selfId = game.lastRunScoreId;
  try {
    const rows = await fetchHighscores(LEADERBOARD_FETCH_LIMIT);
    const sorted = selfId !== null ? sortByScore(rows) : sortByComboThenScore(rows);
    game.leaderboardRows = sorted;
    if (selfId !== null) {
      const selfIdx = sorted.findIndex((r) => r.id === selfId);
      game.leaderboardSelection = selfIdx >= 0 ? selfIdx : 0;
    } else {
      game.leaderboardSelection = 0;
    }
    game.leaderboardActive = sorted.length > 0;
    renderLeaderboard(game);
  } catch {
    game.leaderboardListEl.innerHTML =
      '<li class="leaderboard-status">Leaderboard unavailable.</li>';
    game.leaderboardActive = false;
  }
};

// up/down on title + gameover slide the yellow selector toward the centre of
//   the visible 11-row window; once centred (or already centred, as on the
//   gameover "Your Standing" view), further presses scroll the underlying list
//   by clamping selection ± 1 against the row count.
export const moveLeaderboardSelection = (game: Game, delta: number) => {
  if (!game.leaderboardActive) return;
  const total = game.leaderboardRows.length;
  if (total === 0) return;
  const next = game.leaderboardSelection + delta;
  if (next < 0 || next >= total) return;
  game.leaderboardSelection = next;
  renderLeaderboard(game);
};

// Holding ↑/↓ should keep scrolling: an initial press fires immediately,
//   then after a short delay we tick at a steady cadence. Tracked per
//   direction so reversing mid-hold restarts the delay.
const REPEAT_DELAY = 0.35;
const REPEAT_INTERVAL = 0.08;
let upHeldTime = -1;
let upNextFireAt = 0;
let downHeldTime = -1;
let downNextFireAt = 0;

const tickRepeatDirection = (
  game: Game,
  dt: number,
  isDown: boolean,
  heldRef: { held: number; nextAt: number },
  delta: number,
): { held: number; nextAt: number } => {
  if (!isDown) return { held: -1, nextAt: 0 };
  let { held, nextAt } = heldRef;
  if (held < 0) {
    moveLeaderboardSelection(game, delta);
    return { held: 0, nextAt: REPEAT_DELAY };
  }
  held += dt;
  while (held >= nextAt) {
    moveLeaderboardSelection(game, delta);
    nextAt += REPEAT_INTERVAL;
  }
  return { held, nextAt };
};

export const tickLeaderboardKeyRepeat = (game: Game, dt: number) => {
  const upState = tickRepeatDirection(
    game,
    dt,
    game.input.down("arrowup"),
    { held: upHeldTime, nextAt: upNextFireAt },
    -1,
  );
  upHeldTime = upState.held;
  upNextFireAt = upState.nextAt;
  const downState = tickRepeatDirection(
    game,
    dt,
    game.input.down("arrowdown"),
    { held: downHeldTime, nextAt: downNextFireAt },
    1,
  );
  downHeldTime = downState.held;
  downNextFireAt = downState.nextAt;
};
