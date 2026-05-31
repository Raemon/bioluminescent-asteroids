import type { Game } from "../Game";

// Player-measured timing offset, in seconds. Positive = the player's "on the
//   beat" presses land *after* the true beat — the normal case, because speaker
//   / Bluetooth output latency plus reaction time push every press late. We
//   slide the judged window *and* every visual cue forward by this amount (see
//   Game.perceivedBeatTime) so the moment the player should fire — visually and
//   for scoring — lines up with the beat they actually hear. The raw audio still
//   fires on the true grid (bassClock.ts); only the things the player reacts to
//   move to meet their ears.
const BEAT_OFFSET_KEY = "pulsar.beatOffsetSec.v1";

// Guard rails: a genuine offset is at most a couple hundred ms either way.
//   Anything wider is a miss-tap or a clock glitch, so clamp before trusting it.
const MIN_OFFSET = -0.2;
const MAX_OFFSET = 0.35;

export const clampBeatOffset = (sec: number): number =>
  Math.max(MIN_OFFSET, Math.min(MAX_OFFSET, sec));

// null = the player has never been through the calibrator. The start flow uses
//   this to decide whether to gate the first run behind it.
export const loadBeatOffset = (): number | null => {
  try {
    const raw = localStorage.getItem(BEAT_OFFSET_KEY);
    if (raw === null) return null;
    const sec = Number(raw);
    return Number.isFinite(sec) ? clampBeatOffset(sec) : null;
  } catch {
    return null;
  }
};

export const hasCalibrated = (): boolean => loadBeatOffset() !== null;

// best-effort persistence; private-mode / blocked storage just means we re-ask next session.
export const saveBeatOffset = (sec: number) => {
  try {
    localStorage.setItem(BEAT_OFFSET_KEY, String(clampBeatOffset(sec)));
  } catch {
    // ignore quota / blocked storage
  }
};

// single entry point so the live Game.beatOffset and the persisted value never drift apart.
export const applyBeatOffset = (game: Game, sec: number) => {
  game.beatOffset = clampBeatOffset(sec);
  saveBeatOffset(game.beatOffset);
};
