// Tracks "last time the player started a run" so the intro sequence can pick
//   between a fresh-day pilot's-log opener and the lighter same-day single-hint
//   opener. The threshold is generous (4h) — the goal is to ration the long
//   intro to once-per-session, not to count strict calendar days.

const LAST_START_KEY = "pulsar.lastRunStartAt.v1";
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
  try {
    localStorage.setItem(LAST_START_KEY, String(now));
  } catch {
    // ignore
  }
};
