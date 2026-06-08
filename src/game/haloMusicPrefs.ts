// Per-variation × per-layer halo-music gain overrides. The /music page lets
// the player tweak each layer's peak gain independently and have that change
// reflected in-game on the next halo-music start (and live for the active
// stem, via the `halo-music-pref:changed` event). When no override is saved
// we return null so Sound.ts falls back to its hardcoded audit-calibrated
// value.

import type { HaloMusicVariation } from "../Sound";

export type HaloLayer = "ambient" | "melodic" | "layer3";

const STORAGE_PREFIX = "pulsar.haloMusicGain.v1";

const storageKey = (variation: HaloMusicVariation, layer: HaloLayer): string =>
  `${STORAGE_PREFIX}.${variation}.${layer}`;

const cache: Map<string, number> = new Map();

const clamp = (v: number): number => Math.max(0, Math.min(1, v));

export const getHaloLayerGain = (
  variation: HaloMusicVariation,
  layer: HaloLayer,
): number | null => {
  const key = storageKey(variation, layer);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return null;
    const clamped = clamp(parsed);
    cache.set(key, clamped);
    return clamped;
  } catch {
    return null;
  }
};

export const setHaloLayerGain = (
  variation: HaloMusicVariation,
  layer: HaloLayer,
  value: number,
): void => {
  const clamped = clamp(value);
  const key = storageKey(variation, layer);
  cache.set(key, clamped);
  try {
    localStorage.setItem(key, String(clamped));
  } catch {
    // private mode / blocked storage — preference applies for the session only.
  }
  try {
    window.dispatchEvent(new CustomEvent("halo-music-pref:changed", {
      detail: { variation, layer, value: clamped },
    }));
  } catch {
    // no-op in non-DOM contexts.
  }
};

export type HaloMusicPrefChange = {
  variation: HaloMusicVariation;
  layer: HaloLayer;
  value: number;
};
