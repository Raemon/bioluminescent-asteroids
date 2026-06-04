// Player preference: whether the Pilot's Log captain VO plays at all.
//   When false, the unlocks still latch (so the chapter toast still appears
//   on the x6 unlock) but Sound.playPilotLog silent-skips the buffer source.
const VOCALS_KEY = "pulsar.vocalsEnabled.v1";

let cached: boolean | null = null;

export const getVocalsEnabled = (): boolean => {
  if (cached !== null) return cached;
  try {
    const raw = localStorage.getItem(VOCALS_KEY);
    cached = raw === null ? true : raw === "1";
  } catch {
    cached = true;
  }
  return cached;
};

export const setVocalsEnabled = (on: boolean): void => {
  cached = on;
  try {
    localStorage.setItem(VOCALS_KEY, on ? "1" : "0");
  } catch {
    // private mode / blocked storage — preference applies for the session only.
  }
};
