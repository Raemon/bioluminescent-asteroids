import type { Game } from "../Game";
import {
  fetchHighscores,
  fetchTopPilots,
  getCachedHighscores,
  getRecentName,
  getSaveReplayPref,
  getTopEntriesOnly,
  saveCachedHighscores,
  saveRecentName,
  saveSaveReplayPref,
  saveTopEntriesOnly,
  submitHighscore,
  type HighscoreRow,
} from "./highscores";
import { uploadReplay, fetchReplay } from "./replayApi";
import { startReplay } from "./lifecycle";

// one module owns the score-entry form + leaderboard so lifecycle.ts and
// gameUpdate.ts don't have to know about DOM details or network state.

const setStatus = (game: Game, msg: string, kind: "info" | "error" | "success" = "info") => {
  // "press enter" refers to the key — render the key name white so it pops
  //   against the tinted status text.
  const keyMatch = msg.match(/^(.*press )(enter)(.*)$/i);
  if (keyMatch) {
    const keyEl = document.createElement("span");
    keyEl.className = "status-key";
    keyEl.textContent = keyMatch[2];
    game.scoreEntryStatusEl.textContent = "";
    game.scoreEntryStatusEl.append(keyMatch[1], keyEl, keyMatch[3]);
  } else {
    game.scoreEntryStatusEl.textContent = msg;
  }
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
  const wantReplay = game.replaySaveCheckboxEl.checked;
  game.scoreSubmitState = "submitting";
  game.scoreEntrySubmitEl.disabled = true;
  game.scoreEntryInputEl.disabled = true;
  game.replaySaveCheckboxEl.disabled = true;
  setStatus(game, "Transmitting…", "info");
  try {
    const saved = await submitHighscore(rawName, game);
    saveRecentName(rawName);
    game.lastRunScoreId = saved.id;
    game.lastRunScore = saved.score;
    game.scoreEntryInputEl.blur();
    if (wantReplay) {
      setStatus(game, "Uploading replay…", "info");
      try {
        const bytes = await waitForReplayBytes(game);
        if (!bytes) {
          setStatus(game, "Score saved. Replay unavailable. Press enter to continue.", "success");
        } else {
          await uploadReplay(saved.id, rawName, bytes);
          setStatus(game, "Score + replay saved. Press enter to continue.", "success");
        }
      } catch (err) {
        setStatus(game, `Score saved (replay upload failed: ${(err as Error).message}). Press enter to continue.`, "error");
      }
    } else {
      setStatus(game, "Score saved. Press enter to continue.", "success");
    }
    game.scoreSubmitState = "submitted";
  } catch (err) {
    game.scoreSubmitState = "idle";
    game.scoreEntrySubmitEl.disabled = false;
    game.scoreEntryInputEl.disabled = false;
    game.replaySaveCheckboxEl.disabled = false;
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
  game.replaySaveCheckboxEl.addEventListener("change", () => {
    saveSaveReplayPref(game.replaySaveCheckboxEl.checked);
  });
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
  game.replaySaveCheckboxEl.disabled = false;
  game.replaySaveCheckboxEl.checked = getSaveReplayPref();
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

// captureFrame fires in the update loop and serialize() is awaited inside
//   finalizeRecorder — by the time the player has typed a name + hit Enter,
//   the bytes are typically already on game.lastRunReplay. A short poll
//   covers the edge case where submit lands within the first frame after
//   gameover.
const waitForReplayBytes = async (game: Game, timeoutMs = 2000): Promise<Uint8Array | null> => {
  const start = performance.now();
  while (!game.lastRunReplay && performance.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return game.lastRunReplay;
};

// scoreSubmitState gates whether Enter restarts the game — we want the
// player to confirm the save (or see the error) before bouncing back to title.
export const isScoreEntryBlockingEnter = (game: Game): boolean => {
  if (game.scoreEntryFormEl.classList.contains("hidden")) return false;
  return game.scoreSubmitState !== "submitted";
};

// default sort: rhythm first (headline streak stat), score as tiebreaker.
const sortByComboThenScore = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const comboDiff = (b.max_combo ?? 0) - (a.max_combo ?? 0);
    if (comboDiff !== 0) return comboDiff;
    return b.score - a.score;
  });

const sortByScore = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return (b.max_combo ?? 0) - (a.max_combo ?? 0);
  });

const sortByWave = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const waveDiff = (b.wave ?? 0) - (a.wave ?? 0);
    if (waveDiff !== 0) return waveDiff;
    return b.score - a.score;
  });

const sortByName = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const nameDiff = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (nameDiff !== 0) return nameDiff;
    return b.score - a.score;
  });

const rowEpoch = (r: HighscoreRow): number => {
  const t = Date.parse(r.created_at ?? "");
  return Number.isFinite(t) ? t : 0;
};

const sortByDate = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const dateDiff = rowEpoch(b) - rowEpoch(a);
    if (dateDiff !== 0) return dateDiff;
    return b.score - a.score;
  });

const sortRows = (rows: HighscoreRow[], key: Game["leaderboardSort"]): HighscoreRow[] => {
  switch (key) {
    case "score": return sortByScore(rows);
    case "wave": return sortByWave(rows);
    case "name": return sortByName(rows);
    case "date": return sortByDate(rows);
    case "rhythm":
    default: return sortByComboThenScore(rows);
  }
};

// Absolute date for the leaderboard tooltip: "Mar 5, 2026 · 14:32".
const formatExactDate = (iso: string | undefined): string => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
};

// Compact relative-time formatter for the leaderboard date column: 5m, 1d, 1w, 1mo, 2y.
const formatFromNow = (iso: string | undefined): string => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.floor(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)}h`;
  const day = hr / 24;
  if (day < 7) return `${Math.floor(day)}d`;
  const week = day / 7;
  if (week < 5) return `${Math.floor(week)}w`;
  const month = day / 30;
  if (month < 12) return `${Math.floor(month)}mo`;
  return `${Math.floor(day / 365)}y`;
};

// gameover "Your Standing" view: 51-row window (25 above + selected + 25 below).
// title screen: 7-row window so the opening reads as a hall of fame but arrows
//   still scroll through the full top-50.
const GAMEOVER_WINDOW_SIZE = 51;
const TITLE_WINDOW_SIZE = 7;

const visibleWindowSize = (game: Game): number =>
  game.lastRunScoreId !== null ? GAMEOVER_WINDOW_SIZE : TITLE_WINDOW_SIZE;

// Window anchor that keeps the selection centred when possible, but clamps
//   against the list boundaries so we never show empty slots above the #1 row
//   or below the last row.
const windowStart = (selection: number, total: number, size: number): number => {
  if (total <= size) return 0;
  const radius = (size - 1) >> 1;
  const ideal = selection - radius;
  const maxStart = total - size;
  return Math.max(0, Math.min(maxStart, ideal));
};

const renderLeaderboard = (game: Game) => {
  const rows = game.leaderboardRows;
  if (rows.length === 0) {
    game.leaderboardListEl.innerHTML =
      '<li class="leaderboard-status">No scores yet — be the first pilot on the board.</li>';
    return;
  }
  const expanded = game.leaderboardExpanded && game.lastRunScoreId === null;
  const windowSize = expanded ? rows.length : visibleWindowSize(game);
  const start = expanded ? 0 : windowStart(game.leaderboardSelection, rows.length, windowSize);
  const end = expanded ? rows.length : Math.min(rows.length, start + windowSize);
  const sortKey = game.leaderboardSort;
  const sortCls = (k: Game["leaderboardSort"]) => (sortKey === k ? " lb-sort-active" : "");
  const header = `<li class="lb-header">
    <span class="lb-rank"></span>
    <span class="lb-name lb-sortable${sortCls("name")}" data-sort="name">Pilot</span>
    <span class="lb-score lb-sortable${sortCls("score")}" data-sort="score">Score</span>
    <span class="lb-combo lb-sortable${sortCls("rhythm")}" data-sort="rhythm">Rhythm</span>
    <span class="lb-wave lb-sortable${sortCls("wave")}" data-sort="wave">Wave</span>
    <span class="lb-date lb-sortable${sortCls("date")}" data-sort="date">When</span>
  </li>`;
  const items: string[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const safeName = escapeHtml(row.name);
    const combo = row.max_combo ?? 0;
    const comboTier = combo >= 12 ? "white" : combo >= 4 ? "gold" : combo >= 2 ? "cyan" : "dim";
    const wave = row.wave ?? 1;
    const cls = i === game.leaderboardSelection ? ' class="lb-self"' : "";
    const replayBtn = row.has_replay
      ? `<button class="lb-replay" data-replay-id="${row.id}" title="Watch replay" type="button">▶</button>`
      : "";
    const fromNow = formatFromNow(row.created_at);
    const exactDate = escapeHtml(formatExactDate(row.created_at));
    const dateCell = fromNow
      ? `<span class="lb-date"><span class="lb-date-text">${fromNow}</span><span class="lb-date-tip">${exactDate}</span></span>`
      : `<span class="lb-date"></span>`;
    items.push(`<li${cls}>
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name">${safeName}${replayBtn}</span>
      <span class="lb-score">${row.score.toLocaleString()}</span>
      <span class="lb-combo lb-combo-${comboTier}">
        <span class="lb-combo-value">${combo}<span class="lb-combo-x">×</span></span>
      </span>
      <span class="lb-wave">${wave}</span>
      ${dateCell}
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
const LEADERBOARD_FETCH_LIMIT = 100;

// For the title-screen "Top entries only" view, keep each pilot's personal
//   best in *each* category (score, wave, rhythm) — so a pilot whose top-score
//   run is different from their top-wave run shows up multiple times, once
//   per category they lead. Runs that hold more than one PB collapse to a
//   single row via the row-id dedupe. Case-insensitive name match so
//   "RAEMON" and "raemon" share one pilot bucket.
const pickBest = (
  rows: HighscoreRow[],
  better: (a: HighscoreRow, b: HighscoreRow) => boolean,
): HighscoreRow | null => {
  let best: HighscoreRow | null = null;
  for (const row of rows) {
    if (!best || better(row, best)) best = row;
  }
  return best;
};

const dedupeByName = (rows: HighscoreRow[]): HighscoreRow[] => {
  const byPilot = new Map<string, HighscoreRow[]>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const list = byPilot.get(key);
    if (list) list.push(row);
    else byPilot.set(key, [row]);
  }
  const keptIds = new Set<number>();
  const out: HighscoreRow[] = [];
  for (const pilotRows of byPilot.values()) {
    const bestScore = pickBest(pilotRows, (a, b) =>
      a.score !== b.score ? a.score > b.score : (a.max_combo ?? 0) > (b.max_combo ?? 0),
    );
    const bestWave = pickBest(pilotRows, (a, b) => {
      const aw = a.wave ?? 0, bw = b.wave ?? 0;
      return aw !== bw ? aw > bw : a.score > b.score;
    });
    const bestRhythm = pickBest(pilotRows, (a, b) => {
      const ac = a.max_combo ?? 0, bc = b.max_combo ?? 0;
      return ac !== bc ? ac > bc : a.score > b.score;
    });
    for (const row of [bestScore, bestWave, bestRhythm]) {
      if (row && !keptIds.has(row.id)) {
        keptIds.add(row.id);
        out.push(row);
      }
    }
  }
  return out;
};

export const showLeaderboard = (game: Game) => {
  bindLeaderboardClicks(game);
  bindLeaderboardFooter(game);
  game.leaderboardEl.classList.remove("hidden");
  const showNeighborhood = game.lastRunScoreId !== null;
  // Post-run "your standing" view always shows the raw top-50 so the player
  //   sees their actual row even if a previous run by them ranks higher.
  game.leaderboardTopOnly = showNeighborhood ? false : getTopEntriesOnly();
  // Title screen defaults to fully-expanded: the deduped top-50 reads as a
  //   hall of fame, not a 7-row peek-window. Post-run keeps the scrolling
  //   window so the yellow self-row stays centred.
  game.leaderboardExpanded = !showNeighborhood;
  game.leaderboardLoadingMore = false;
  syncOverlayExpansion(!showNeighborhood);
  syncShowMoreVisibility(game);
  syncFooterUi(game);
  syncFooterVisibility(showNeighborhood);
  game.leaderboardSort = "rhythm";
  // Paint cached rows immediately so the title screen is never blank on reload;
  //   the in-flight fetch will swap them out with fresh data when it lands.
  const cached = getCachedHighscores();
  if (cached.length > 0) {
    // The cache holds the deep top-pilots payload; seed both sources from it so
    //   the toggle works before the live top-100 lands.
    game.leaderboardTopPilots = cached;
    game.leaderboardAllRows = cached;
    applySort(game, game.lastRunScoreId);
  } else {
    game.leaderboardListEl.innerHTML =
      `<li class="leaderboard-status">${showNeighborhood ? "Loading your standing…" : "Loading top pilots…"}</li>`;
    game.leaderboardTopPilots = [];
    game.leaderboardAllRows = [];
    game.leaderboardRows = [];
    game.leaderboardSelection = 0;
    game.leaderboardActive = false;
  }
  void refreshLeaderboard(game);
};

export const refreshLeaderboard = async (game: Game) => {
  const selfId = game.lastRunScoreId;
  // Two-phase. Phase 1: the deep top-pilots set (server-deduped, scanned far
  //   enough for ~20 distinct scores) — this is what the default "top entries
  //   only" view renders. Phase 2: the raw top-100, which powers the view once
  //   the toggle is turned OFF and is the base for "show more" paging. Phase 2
  //   must NOT clobber the phase-1 view — the raw top-100 can be one pilot deep.
  let paintedInitial = false;
  try {
    const initial = await fetchTopPilots();
    paintedInitial = true;
    saveCachedHighscores(initial);
    game.leaderboardTopPilots = initial;
    game.leaderboardHasMore = true;
    applySort(game, selfId);
    syncShowMoreVisibility(game);
  } catch {
    // fall through to the full fetch — it can still recover the view.
  }
  try {
    const rows = await fetchHighscores(LEADERBOARD_FETCH_LIMIT);
    game.leaderboardAllRows = rows;
    game.leaderboardHasMore = rows.length >= LEADERBOARD_FETCH_LIMIT;
    // Re-render only matters when the toggle is off (the on-view reads the
    //   phase-1 set); applySort handles both and is cheap.
    applySort(game, selfId);
    syncShowMoreVisibility(game);
  } catch {
    if (!paintedInitial && game.leaderboardTopPilots.length === 0) {
      game.leaderboardListEl.innerHTML =
        '<li class="leaderboard-status">Leaderboard unavailable.</li>';
      game.leaderboardActive = false;
    }
  }
};

// Fetches the next page of rows past what's already loaded, dedupes by id
//   against the in-memory rows (in case new submissions shifted offsets), and
//   appends. Updates hasMore based on whether the page was full.
const loadMoreLeaderboard = async (game: Game) => {
  if (game.leaderboardLoadingMore || !game.leaderboardHasMore) return;
  game.leaderboardLoadingMore = true;
  syncShowMoreVisibility(game);
  try {
    const offset = game.leaderboardAllRows.length;
    const rows = await fetchHighscores(LEADERBOARD_FETCH_LIMIT, offset);
    const existingIds = new Set(game.leaderboardAllRows.map((r) => r.id));
    const fresh = rows.filter((r) => !existingIds.has(r.id));
    game.leaderboardAllRows = [...game.leaderboardAllRows, ...fresh];
    game.leaderboardHasMore = rows.length >= LEADERBOARD_FETCH_LIMIT;
    applySort(game, game.lastRunScoreId);
  } catch {
    // leave the existing list intact; user can retry by clicking again.
  } finally {
    game.leaderboardLoadingMore = false;
    syncShowMoreVisibility(game);
  }
};

// Renders from the deep top-pilots set when "top entries only" is on, else
//   from the full top-100. The deep set still gets a client dedupe pass so a
//   stale or over-broad payload can't leak duplicate pilot rows.
const applySort = (game: Game, selfId: number | null) => {
  const filtered = game.leaderboardTopOnly
    ? dedupeByName(game.leaderboardTopPilots)
    : game.leaderboardAllRows;
  const sorted = sortRows(filtered, game.leaderboardSort);
  game.leaderboardRows = sorted;
  if (selfId !== null) {
    const selfIdx = sorted.findIndex((r) => r.id === selfId);
    game.leaderboardSelection = selfIdx >= 0 ? selfIdx : 0;
  } else {
    game.leaderboardSelection = 0;
  }
  game.leaderboardActive = sorted.length > 0;
  renderLeaderboard(game);
};

const syncFooterUi = (game: Game) => {
  const checkbox = document.getElementById("leaderboard-top-only-input") as HTMLInputElement | null;
  if (checkbox) checkbox.checked = game.leaderboardTopOnly;
};

// Hide the filter controls on the post-run "your standing" view; the player
//   wants to see their actual rank there, not a deduped global view.
const syncFooterVisibility = (hide: boolean) => {
  const footer = document.getElementById("leaderboard-footer");
  if (footer) footer.classList.toggle("hidden", hide);
};

let leaderboardFooterBound = false;
const bindLeaderboardFooter = (game: Game) => {
  if (leaderboardFooterBound) return;
  const checkbox = document.getElementById("leaderboard-top-only-input") as HTMLInputElement | null;
  const showMore = document.getElementById("leaderboard-show-more");
  if (!checkbox || !showMore) return;
  leaderboardFooterBound = true;
  checkbox.addEventListener("change", () => {
    game.leaderboardTopOnly = checkbox.checked;
    saveTopEntriesOnly(checkbox.checked);
    applySort(game, game.lastRunScoreId);
  });
  showMore.addEventListener("click", () => {
    if (game.leaderboardLoadingMore) return;
    if (game.leaderboardTopOnly) {
      game.leaderboardTopOnly = false;
      saveTopEntriesOnly(false);
      syncFooterUi(game);
    }
    // First click expands the rendered window to show every loaded row.
    //   Subsequent clicks page the next 50 from the server and append.
    const justExpanded = !game.leaderboardExpanded;
    if (justExpanded) {
      game.leaderboardExpanded = true;
      syncOverlayExpansion(true);
      applySort(game, game.lastRunScoreId);
      syncShowMoreVisibility(game);
      return;
    }
    void loadMoreLeaderboard(game);
  });
};

const syncOverlayExpansion = (expanded: boolean) => {
  const overlay = document.getElementById("overlay");
  if (overlay) overlay.classList.toggle("leaderboard-expanded", expanded);
};

const syncShowMoreVisibility = (game: Game) => {
  const btn = document.getElementById("leaderboard-show-more");
  if (!btn) return;
  // Hide once we've expanded AND there's nothing more the server could give us.
  //   Otherwise the button persists in the bottom-left so the player can keep
  //   loading more pages.
  const nothingToShow = game.leaderboardExpanded && !game.leaderboardHasMore;
  btn.classList.toggle("hidden", nothingToShow);
  btn.textContent = game.leaderboardLoadingMore ? "loading…" : "show more";
  (btn as HTMLButtonElement).disabled = game.leaderboardLoadingMore;
};

let leaderboardClicksBound = false;
const bindLeaderboardClicks = (game: Game) => {
  if (leaderboardClicksBound) return;
  leaderboardClicksBound = true;
  game.leaderboardListEl.addEventListener("click", (ev) => {
    const el = ev.target as HTMLElement | null;
    if (!el) return;
    const replayEl = el.closest<HTMLElement>("[data-replay-id]");
    if (replayEl) {
      ev.stopPropagation();
      const id = Number(replayEl.dataset.replayId);
      if (id > 0) void launchReplay(game, id);
      return;
    }
    const sortEl = el.closest<HTMLElement>("[data-sort]");
    if (!sortEl) return;
    const key = sortEl.dataset.sort as Game["leaderboardSort"] | undefined;
    if (!key || key === game.leaderboardSort) return;
    game.leaderboardSort = key;
    applySort(game, game.lastRunScoreId);
  });
};

const launchReplay = async (game: Game, scoreId: number) => {
  try {
    const bytes = await fetchReplay(scoreId);
    await startReplay(game, bytes);
  } catch (err) {
    console.error("[replay launch] failed:", err);
  }
};

// up/down on title + gameover slide the yellow selector toward the centre of
// the visible window; once centred, further presses scroll the underlying
// list by clamping selection ± 1 against the row count.
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
