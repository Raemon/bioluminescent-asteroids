// Shared sound-tuning config — loaded by both the game and the /soundeditor
// page. The on-disk source of truth is /sounds/config.json; the editor PUTs
// changes back via the dev plugin in vite.config.ts so that edits are
// committable.
//
// Each sound has a `universal` block (volume + pitch — applied at the
// dispatcher in Sound.play) and an optional `semantic` block whose keys are
// specific to that sound's synthesis. Sound.ts reads semantic values inline
// via `cfgN(name, key, fallback)`.

import type { SoundName } from "./Sound";

export type UniversalKnobs = {
  volume: number;
  pitch: number;
};

export type SoundEntry = {
  universal: UniversalKnobs;
  semantic?: Record<string, number>;
};

export type SoundConfig = {
  _version: number;
  sounds: Partial<Record<SoundName, SoundEntry>>;
};

const DEFAULT_UNIVERSAL: UniversalKnobs = { volume: 1, pitch: 1 };

let current: SoundConfig = { _version: 1, sounds: {} };
let loaded = false;
const listeners = new Set<(c: SoundConfig) => void>();

export async function loadSoundConfig(): Promise<SoundConfig> {
  if (loaded) return current;
  try {
    const res = await fetch("/sounds/config.json", { cache: "no-store" });
    if (res.ok) {
      const json = (await res.json()) as SoundConfig;
      if (json && typeof json === "object") current = json;
    }
  } catch {
    // No config — run on hardcoded defaults.
  }
  loaded = true;
  for (const l of listeners) l(current);
  return current;
}

export function getSoundConfig(): SoundConfig {
  return current;
}

export function setSoundConfig(c: SoundConfig) {
  current = c;
  loaded = true;
  for (const l of listeners) l(current);
}

export function onSoundConfigChange(fn: (c: SoundConfig) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Get the universal knobs for a sound. Always returns a real object so call
// sites can multiply unconditionally.
export function cfgU(name: SoundName): UniversalKnobs {
  const entry = current.sounds[name];
  if (!entry) return DEFAULT_UNIVERSAL;
  return entry.universal ?? DEFAULT_UNIVERSAL;
}

// Get a semantic knob for a sound, falling back to the hardcoded value the
// caller passes. This lets Sound.ts use `const f = cfgN("bassKick", "startHz", 140)`
// in place of `const f = 140` — zero change in behavior until the editor
// writes a tuned value.
export function cfgN(name: SoundName, key: string, fallback: number): number {
  const entry = current.sounds[name];
  if (!entry || !entry.semantic) return fallback;
  const v = entry.semantic[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// Editor uses this. PATCH the config server-side then update local state.
// Returns true if the dev save endpoint accepted the write; false if we're
// in prod or the endpoint is missing.
export async function saveSoundConfig(c: SoundConfig): Promise<boolean> {
  setSoundConfig(c);
  try {
    const res = await fetch("/__sound-config__", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c, null, 2),
    });
    return res.ok;
  } catch {
    return false;
  }
}
