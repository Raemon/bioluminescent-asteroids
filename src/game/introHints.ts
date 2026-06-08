// Cryptic, oblique gameplay advice in the Pulsar voice — half-prose, half-lullaby,
//   rhymes that almost land. Three are picked at random for the daily intro
//   sequence. Keep each line short enough to fit on one screen-width row at
//   the typography used in <IntroSequence>.
export const INTRO_HINT_POOL: readonly string[] = [
  "Feel the beat.",
  "Take it slow.",
  "Aim carefully.",
  "One shot, one kill.",
  "Build rhythm.",
  "Take a breath.",
  "Drift with the asteroids.",
  "Dance with the void.",
  "Become stronger.",
  "Fire on the beat. Hit on the beat.",
  "Find the rhythm.",
  "Feel the pulse.",
  "Tell your son you'll be home soon.",
  "Drift gently.",
  "Listen to the stars.",
  "Begin your journey.",
];

const HINT_KEY = "pulsar.lastIntroHints.v1";

// Try not to repeat hints from the previous run; falls back gracefully if
//   localStorage is unavailable or full.
const loadRecent = (): string[] => {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
};

const saveRecent = (hints: string[]) => {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify(hints));
  } catch {
    // ignore
  }
};

// Picks `count` distinct hints, preferring lines not used last run. Falls back
//   to the full pool if the avoid-set would leave too few to pick from.
export const pickIntroHints = (count: number): string[] => {
  const recent = new Set(loadRecent());
  const fresh = INTRO_HINT_POOL.filter((h) => !recent.has(h));
  const usable = fresh.length >= count ? fresh : [...INTRO_HINT_POOL];
  const pool = [...usable];
  const out: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  saveRecent(out);
  return out;
};
