// Cryptic, oblique gameplay advice in the Pulsar voice — half-prose, half-lullaby,
//   rhymes that almost land. Three are picked at random for the daily intro
//   sequence: one from each slot pool so the sequence progresses from
//   arrival → skill → letting-go, leading into "Become one with the Pulsar."
//   Keep each line short enough to fit on one screen-width row at the
//   typography used in <IntroSequence>.

const SLOT_1_POOL: readonly string[] = [
  "Take a breath.",
  "Take it slow.",
  "Listen to the stars.",
  "Feel the pulse.",
  "Feel the beat.",
];

// The one hint that must wait out the start-of-run controls pane before it
//   can appear — IntroSequence suppresses it while the pane is still showing.
export const FIRE_HIT_HINT = "Fire on the beat. Hit on the beat.";

const SLOT_2_POOL: readonly string[] = [
  "Aim carefully.",
  "One shot. One kill.",
  "It's okay to wait.",
  "Patience.",
  "Drift gently.",
  FIRE_HIT_HINT,
  "Build rhythm, carefully.",
  "Find the rhythm.",
  "Become stronger.",
  "Drift among the asteroids.",
  "Get in sync.",
  "Heartbeat to heartbeat.",
];

const SLOT_3_POOL: readonly string[] = [
  "Dance with the void.",
  "Drink your coffee. It'll be a long night.",
  "Don't forget your dream.",
  "Report what you find.",
  "Tell your son you'll be home soon.",
  "Remember your promise to your wife.",
  "The stars are listening.",
  "You have all the time in the world.",
  "Don't forget the way back.",
  "Don't lose the way forward."
];

const SLOT_POOLS: readonly (readonly string[])[] = [SLOT_1_POOL, SLOT_2_POOL, SLOT_3_POOL];

const HINT_KEY = "pulsar.lastIntroHints.v1";

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

const pickFromPool = (pool: readonly string[], avoid: Set<string>): string => {
  const fresh = pool.filter((h) => !avoid.has(h));
  const usable = fresh.length > 0 ? fresh : pool;
  return usable[Math.floor(Math.random() * usable.length)];
};

// Picks `count` hints. For count===3, draws one from each slot pool so the
//   sequence reads opener → middle → closer. For count===1 (shortHint flavor),
//   pulls from the combined pool so single-hint intros aren't stuck on
//   openers. In both cases, prefers lines not used last run.
export const pickIntroHints = (count: number): string[] => {
  const recent = new Set(loadRecent());

  if (count === 3) {
    const out = SLOT_POOLS.map((pool) => pickFromPool(pool, recent));
    saveRecent(out);
    return out;
  }

  const combined = SLOT_POOLS.flat();
  const pool = [...combined];
  const out: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const fresh = pool.filter((h) => !recent.has(h));
    const usable = fresh.length > 0 ? fresh : pool;
    const pick = usable[Math.floor(Math.random() * usable.length)];
    out.push(pick);
    const idx = pool.indexOf(pick);
    if (idx >= 0) pool.splice(idx, 1);
  }
  saveRecent(out);
  return out;
};
