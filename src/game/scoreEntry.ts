import type { Game } from "../Game";
import {
  fetchHighscores,
  formatKillSummary,
  getRecentName,
  saveRecentName,
  submitHighscore,
  totalKills,
  type HighscoreRow,
} from "./highscores";

// Why: one module owns the score-entry form + leaderboard so lifecycle.ts and
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
    await submitHighscore(rawName, game);
    saveRecentName(rawName);
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

// Why: the Enter key normally restarts the game from the gameover screen, but
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
  // Why: ram-only or otherwise score-less runs shouldn't pester for a name —
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

// Why: scoreSubmitState gates whether Enter restarts the game — we want the
// player to confirm the save (or see the error) before bouncing back to title.
export const isScoreEntryBlockingEnter = (game: Game): boolean => {
  if (game.scoreEntryFormEl.classList.contains("hidden")) return false;
  return game.scoreSubmitState !== "submitted";
};

const renderLeaderboardRows = (game: Game, rows: HighscoreRow[]) => {
  if (rows.length === 0) {
    game.leaderboardListEl.innerHTML =
      '<li class="leaderboard-status">No scores yet — be the first pilot on the board.</li>';
    return;
  }
  const items = rows
    .map((row, idx) => {
      const rank = idx + 1;
      const kills = row.kill_count || totalKills(row.kill_summary ?? {});
      const summary = formatKillSummary(row.kill_summary ?? {});
      const meta = summary ? `W${row.wave} · ${kills}k · ${summary}` : `W${row.wave} · ${kills}k`;
      const safeName = escapeHtml(row.name);
      return `<li>
        <span class="lb-rank">${rank}</span>
        <span class="lb-name">${safeName}</span>
        <span class="lb-score">${row.score.toLocaleString()}</span>
        <span class="lb-meta">${escapeHtml(meta)}</span>
      </li>`;
    })
    .join("");
  game.leaderboardListEl.innerHTML = items;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

export const showLeaderboard = (game: Game) => {
  game.leaderboardEl.classList.remove("hidden");
  game.leaderboardListEl.innerHTML =
    '<li class="leaderboard-status">Loading top pilots…</li>';
  void refreshLeaderboard(game);
};

export const refreshLeaderboard = async (game: Game) => {
  try {
    const rows = await fetchHighscores(10);
    renderLeaderboardRows(game, rows);
  } catch {
    game.leaderboardListEl.innerHTML =
      '<li class="leaderboard-status">Leaderboard unavailable.</li>';
  }
};
