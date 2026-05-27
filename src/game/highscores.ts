import type { Game } from "../Game";
import type { KillBucket } from "./killBuckets";

// Why: bucket names are emitted by killEffects.ts; this label map keeps the
// leaderboard summary readable instead of leaking internal asteroid kinds.
const BUCKET_LABELS: Record<KillBucket, string> = {
  asteroid_large: "lg",
  asteroid_medium: "md",
  asteroid_small: "sm",
  bassteroid: "bass",
  chime: "chime",
  bell: "bell",
  warble: "warble",
  tink: "tink",
  alien_big: "alien-L",
  alien_medium: "alien-M",
  alien_small: "alien-S",
  comet: "comet",
  boss: "boss",
};

export type HighscoreRow = {
  id: number;
  name: string;
  score: number;
  wave: number;
  kill_count: number;
  kill_summary: Record<string, number>;
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
  const res = await fetch("/api/highscores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      score: game.score,
      wave: game.wave,
      kill_count: totalKills(game.killTally),
      kill_summary: game.killTally,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`submit failed: ${res.status} ${text}`);
  }
  const body = (await res.json()) as { score: HighscoreRow };
  return body.score;
};

export const fetchHighscores = async (limit = 10): Promise<HighscoreRow[]> => {
  const res = await fetch(`/api/highscores?limit=${limit}`, { method: "GET" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return body.scores;
};

// Why: the leaderboard row shows a compressed kill breakdown; pick the top few
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
