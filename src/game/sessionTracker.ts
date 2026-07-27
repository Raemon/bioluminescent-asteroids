// Tracks "last time the player started a run" so the intro sequence can pick
//   between a fresh-day pilot's-log opener and the lighter same-day single-hint
//   opener. The threshold is generous (4h) — the goal is to ration the long
//   intro to once-per-session, not to count strict calendar days.
//
// The same window rations the in-run pilot's-log vocals (x6 / x12): a line the
//   player already heard this session stays quiet on every later run until the
//   session lapses, matching the full-hints/short-hint split.

const LAST_START_KEY = "pulsar.lastRunStartAt.v1";
const PILOT_LOG_HEARD_KEY = "pulsar.pilotLogHeardAt.v1";
const NEW_DAY_GAP_MS = 4 * 60 * 60 * 1000;

const readLastStart = (): number | null => {
  try {
    const raw = localStorage.getItem(LAST_START_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

// `null` covers first-ever play; both should run the full pilot's-log intro.
export const isNewDaySession = (now: number = Date.now()): boolean => {
  const last = readLastStart();
  if (last === null) return true;
  return now - last >= NEW_DAY_GAP_MS;
};

export const markSessionStart = (now: number = Date.now()) => {
  // A run started inside the same session drags the pilot's-log window along
  //   with it, so a marathon sitting never crosses the 4h line mid-play and
  //   replays a line the player already heard an hour ago. A genuinely new
  //   session leaves the old stamps alone — they're already stale, so the
  //   logs unmute on their own.
  if (!isNewDaySession(now)) rollPilotLogWindow(now);
  try {
    localStorage.setItem(LAST_START_KEY, String(now));
  } catch {
    // ignore
  }
};

// --- Pilot's-log vocals (x6 / x12) -----------------------------------------
// Keyed by milestone so each line is rationed independently: a session that
//   never got past x6 still hears x12 fresh the first time it lands.

const readHeardMap = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(PILOT_LOG_HEARD_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

const writeHeardMap = (map: Record<string, number>) => {
  try {
    localStorage.setItem(PILOT_LOG_HEARD_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
};

// Same gate as the full-hints intro, applied per vocal line: unheard, or last
//   heard longer ago than the session gap.
export const shouldPlayPilotLog = (milestone: number, now: number = Date.now()): boolean => {
  const last = readHeardMap()[String(milestone)];
  if (last === undefined) return true;
  return now - last >= NEW_DAY_GAP_MS;
};

export const markPilotLogHeard = (milestone: number, now: number = Date.now()) => {
  const map = readHeardMap();
  map[String(milestone)] = now;
  writeHeardMap(map);
};

// Push every existing stamp forward to `now` — see markSessionStart.
const rollPilotLogWindow = (now: number) => {
  const map = readHeardMap();
  const keys = Object.keys(map);
  if (keys.length === 0) return;
  for (const k of keys) map[k] = now;
  writeHeardMap(map);
};
