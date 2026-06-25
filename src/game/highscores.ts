import type { Game } from "../Game";
import type { KillBucket } from "./killBuckets";
import { displayWave } from "./waveDirector";

// bucket names are emitted by killEffects.ts; this label map keeps the
// leaderboard summary readable instead of leaking internal asteroid kinds.
const BUCKET_LABELS: Record<KillBucket, string> = {
  asteroid_huge: "2xL",
  asteroid_large: "lg",
  asteroid_medium: "md",
  asteroid_small: "sm",
  bassteroid: "bass",
  chime: "chime",
  bell: "bell",
  warble: "warble",
  asteroidWithGem: "gem",
  burstGem: "gold gem",
  solidCrystal: "crystal",
  alien_big: "alien-L",
  alien_medium: "alien-M",
  alien_small: "alien-S",
  comet: "comet",
  boss: "boss",
  glassPrison: "prison",
  wraith: "wraith",
};

export type HighscoreRow = {
  id: number;
  name: string;
  score: number;
  wave: number;
  max_combo: number;
  kill_count: number;
  kill_summary: Record<string, number>;
  has_replay?: boolean;
  created_at: string;
};

export const totalKills = (tally: Readonly<Record<string, number>>): number => {
  let total = 0;
  for (const n of Object.values(tally)) total += n;
  return total;
};

export const submitHighscore = async (
  name: string,
  game: Game,
): Promise<HighscoreRow> => {
  // Read the frozen game-over snapshot when present: the highlight clip re-sims
  //   the run on the live game object, so game.score/maxCombo/killTally now hold
  //   the clip's in-progress values, not the finished run's. runSummary is the
  //   run as it ended.
  const s = game.runSummary;
  const res = await fetch("/api/highscores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      score: s ? s.score : game.score,
      wave: displayWave(s ? s.wave : game.wave),
      max_combo: s ? s.maxCombo : game.maxCombo,
      kill_count: totalKills(s ? s.killTally : game.killTally),
      kill_summary: s ? s.killTally : game.killTally,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`submit failed: ${res.status} ${text}`);
  }
  const body = (await res.json()) as { score: HighscoreRow };
  return body.score;
};

// no-store so a plain reload always reflects fresh server data — the API sends
//   a `public` Cache-Control for the edge, which the browser would otherwise
//   honour and replay a stale leaderboard on the next visit.
export const fetchHighscores = async (limit = 10, offset = 0): Promise<HighscoreRow[]> => {
  const url = `/api/highscores?limit=${limit}&offset=${offset}`;
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return body.scores;
};

// Server-side deduped "top N pilots" view — the initial title-screen payload.
//   The server runs the same per-pilot best-of-category logic the client used
//   to apply locally, so this returns far fewer rows than the raw top-100.
export const fetchTopPilots = async (): Promise<HighscoreRow[]> => {
  const res = await fetch("/api/highscores?mode=top-pilots", { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return body.scores;
};

// The most-recent rows, regardless of score. Folded into the title-screen pool
//   so a fresh run shows up by default only if it's a pilot's category best,
//   but is always reachable by sorting on the "When" column.
export const fetchRecentScores = async (): Promise<HighscoreRow[]> => {
  const res = await fetch("/api/highscores?mode=recent", { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return body.scores;
};

// Player-profile view: every run by one pilot, server-gathered as the top-50 in
//   each category (score, rhythm, wave, most-recent) and unioned. The view
//   renders these unfiltered (no per-pilot dedupe) so the player sees their
//   full board.
export const fetchPlayerScores = async (name: string): Promise<HighscoreRow[]> => {
  const res = await fetch(`/api/highscores?mode=player&name=${encodeURIComponent(name)}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return body.scores;
};

// "Load more" for a profile: that pilot's next page of runs by score-desc, past
//   the score-ranked rows already shown. Deduped against the loaded set by the
//   caller; an offset of 0 would re-fetch the union, so callers pass offset > 0.
export const fetchPlayerPage = async (
  name: string,
  offset: number,
  limit = 50,
): Promise<HighscoreRow[]> => {
  const url = `/api/highscores?mode=player&name=${encodeURIComponent(name)}&offset=${offset}&limit=${limit}`;
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return body.scores;
};

// Post-run "your standing": the rows ranked just above and below the player's
//   submitted score, with selfRank giving the score's true global position so
//   the leaderboard can show real rank numbers instead of a window-local index.
export const fetchNeighborhood = async (
  id: number,
  radius = 25,
): Promise<{ scores: HighscoreRow[]; selfRank: number }> => {
  const res = await fetch(`/api/highscores?mode=around&id=${id}&radius=${radius}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return (await res.json()) as { scores: HighscoreRow[]; selfRank: number };
};

// the leaderboard row shows a compressed kill breakdown; pick the top few
// buckets so the row stays scannable instead of dumping every category.
export const formatKillSummary = (summary: Record<string, number>): string => {
  const entries = Object.entries(summary ?? {});
  if (entries.length === 0) return "";
  entries.sort((a, b) => b[1] - a[1]);
  const parts: string[] = [];
  for (const [bucket, count] of entries.slice(0, 4)) {
    const label = BUCKET_LABELS[bucket as KillBucket] ?? bucket;
    parts.push(`${count}${label}`);
  }
  return parts.join(" · ");
};

const RECENT_NAME_KEY = "pulsar.recentName";

export const getRecentName = (): string => {
  try {
    return localStorage.getItem(RECENT_NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

export const saveRecentName = (name: string) => {
  try {
    localStorage.setItem(RECENT_NAME_KEY, name);
  } catch {
    // localStorage may be blocked (private mode); the leaderboard still works without it.
  }
};

// Cached top-50 from the last fetch so the title screen renders instantly on
// reload while the network call refreshes in the background.
const CACHED_ROWS_KEY = "pulsar.leaderboardCache";

export const getCachedHighscores = (): HighscoreRow[] => {
  try {
    const raw = localStorage.getItem(CACHED_ROWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as HighscoreRow[];
  } catch {
    return [];
  }
};

export const saveCachedHighscores = (rows: HighscoreRow[]) => {
  try {
    localStorage.setItem(CACHED_ROWS_KEY, JSON.stringify(rows));
  } catch {
    // localStorage may be blocked (private mode); leaderboard still works without cache.
  }
};

// Every fresh page load defaults the leaderboard to "top entries only" so
//   first impressions show one row per pilot. The toggle still flips it
//   within a session, but it is not persisted across reloads.
export const getTopEntriesOnly = (): boolean => true;

export const saveTopEntriesOnly = (_on: boolean) => {
  // Intentionally no-op — see getTopEntriesOnly for the rationale.
};

const REPLAY_OPT_IN_KEY = "pulsar.saveReplay";

// Default on so the replay-saving behaviour is discoverable on a first run.
export const getSaveReplayPref = (): boolean => {
  try {
    const raw = localStorage.getItem(REPLAY_OPT_IN_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
};

export const saveSaveReplayPref = (on: boolean) => {
  try {
    localStorage.setItem(REPLAY_OPT_IN_KEY, on ? "1" : "0");
  } catch {
    // localStorage may be blocked; the in-session checkbox state still works.
  }
};
