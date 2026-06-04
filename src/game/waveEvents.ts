import { rand } from "../vec";
import { rng } from "./rng";

// one event slot type collapses canister/shockwave/comet/alien into uniform schedule entries.
export type WaveEvent = {
  at: number;
  fire: () => void;
};

export type WaveEventSchedule = {
  events: WaveEvent[];
};

// spawnWave needs a clean slate per wave so leftover events from a previous wave can't double-fire.
export const newWaveEventSchedule = (): WaveEventSchedule => ({ events: [] });

// separate from maybeSchedule so always-firing events (e.g. alien after the size roll) stay readable.
export const scheduleAt = (sch: WaveEventSchedule, at: number, fire: () => void) => {
  sch.events.push({ at, fire });
};

// collapses the chance + random-window roll all four event types repeated by hand into one call.
export const maybeSchedule = (
  sch: WaveEventSchedule,
  chance: number,
  window: [number, number],
  fire: () => void,
) => {
  if (rng() >= chance) return;
  scheduleAt(sch, rand(window[0], window[1]), fire);
};

// single per-frame poll replaces four separate `if (xSpawnAt !== null && elapsed >= xSpawnAt)` blocks.
export const tickWaveEvents = (sch: WaveEventSchedule, waveElapsed: number) => {
  if (sch.events.length === 0) return;
  const pending: WaveEvent[] = [];
  for (const e of sch.events) {
    if (waveElapsed >= e.at) e.fire();
    else pending.push(e);
  }
  sch.events = pending;
};
