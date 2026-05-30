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

type RankedRow = { row: HighscoreRow; rank: number };

// max-combo-first sort celebrates the headline streak stat; used for the global top-10 view.
const sortByComboThenScore = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const comboDiff = (b.max_combo ?? 0) - (a.max_combo ?? 0);
    if (comboDiff !== 0) return comboDiff;
    return b.score - a.score;
  });

// neighborhood view ranks strictly by score so "5 closest in either direction" is
//   well-defined; the API already returns rows in this order.
const sortByScore = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => b.score - a.score);

const renderRows = (game: Game, ranked: RankedRow[], selfId: number | null) => {
  if (ranked.length === 0) {
    game.leaderboardListEl.innerHTML =
      '<li class="leaderboard-status">No scores yet — be the first pilot on the board.</li>';
    return;
  }
  const header = `<li class="lb-header">
    <span class="lb-rank"></span>
    <span class="lb-name">Pilot</span>
    <span class="lb-score">Score</span>
    <span class="lb-combo">Rhythm</span>
    <span class="lb-wave">Wave</span>
  </li>`;
  const items = ranked
    .map(({ row, rank }) => {
      const safeName = escapeHtml(row.name);
      const combo = row.max_combo ?? 0;
      const comboTier = combo >= 8 ? "white" : combo >= 4 ? "gold" : combo >= 2 ? "cyan" : "dim";
      const wave = row.wave ?? 1;
      const isSelf = selfId !== null && row.id === selfId;
      const cls = isSelf ? ' class="lb-self"' : "";
      return `<li${cls}>
        <span class="lb-rank">${rank}</span>
        <span class="lb-name">${safeName}</span>
        <span class="lb-score">${row.score.toLocaleString()}</span>
        <span class="lb-combo lb-combo-${comboTier}">
          <span class="lb-combo-value">${combo}<span class="lb-combo-x">×</span></span>
        </span>
        <span class="lb-wave">${wave}</span>
      </li>`;
    })
    .join("");
  game.leaderboardListEl.innerHTML = header + items;
};

const renderTopRows = (game: Game, rows: HighscoreRow[]) => {
  const sorted = sortByComboThenScore(rows);
  const ranked: RankedRow[] = sorted.map((row, idx) => ({ row, rank: idx + 1 }));
  renderRows(game, ranked, null);
};

// pick the 5 score-rank neighbours above and below the player's row so a returning
//   pilot sees who they need to beat next and who's nipping at their heels.
const renderNeighborhoodRows = (game: Game, rows: HighscoreRow[], selfId: number) => {
  const sorted = sortByScore(rows);
  const selfIdx = sorted.findIndex((r) => r.id === selfId);
  if (selfIdx < 0) {
    renderTopRows(game, rows);
    return;
  }
  const RADIUS = 5;
  const start = Math.max(0, selfIdx - RADIUS);
  const end = Math.min(sorted.length, selfIdx + RADIUS + 1);
  const ranked: RankedRow[] = sorted
    .slice(start, end)
    .map((row, idx) => ({ row, rank: start + idx + 1 }));
  renderRows(game, ranked, selfId);
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

// matches the API's MAX_LIMIT — fetching the full slice means a returning pilot
//   ranked anywhere in the top tier will be found by id and centered in the view.
const NEIGHBORHOOD_FETCH_LIMIT = 50;

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
  void refreshLeaderboard(game);
};

export const refreshLeaderboard = async (game: Game) => {
  const selfId = game.lastRunScoreId;
  const limit = selfId !== null ? NEIGHBORHOOD_FETCH_LIMIT : 10;
  try {
    const rows = await fetchHighscores(limit);
    if (selfId !== null) renderNeighborhoodRows(game, rows, selfId);
    else renderTopRows(game, rows);
  } catch {
    game.leaderboardListEl.innerHTML =
      '<li class="leaderboard-status">Leaderboard unavailable.</li>';
  }
};
