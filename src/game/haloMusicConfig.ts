// Halo music selection. Stems live in /sounds/halo-music/{variation}-{ambient,melodic}.mp3.
//
// Each time the player crosses combo ≥ 4 from below, syncHaloAmbient picks
// a random variation from HALO_MUSIC_POOL. The chosen variation persists
// for the lifetime of that halo (so 6x melodic uses the same variation's
// stem); a new pick happens on the next 4x trigger after combo breaks.
//
// To disable music entirely and fall back to the legacy synthesized pad,
// set HALO_MUSIC_POOL to []. To force a specific variation for an A/B test,
// set the pool to a single entry.
//
// Round 2 pool (32-second C-pedal loops, 4 phrases ×4 bars, calibrated
// against the in-game-mix audit, beat-clock-aligned start):
//   r2-el  ElevenLabs cinematic bed + felt piano. Centroid ~600 Hz, sits
//          dark and wide. Plays gain 0.25.
//   r2-sb  Procedural sine pad + FluidSynth felt piano with sox reverb.
//          Centroid ~280 Hz, warmer / drier. Plays gain 0.30.
//
// Every pool entry is fetched + decoded at
// startGame so the first 4x doesn't pay fetch latency regardless of which
// one comes up.
import type { HaloMusicVariation } from "../Sound";

export const HALO_MUSIC_POOL: readonly HaloMusicVariation[] = ["r2-el", "r2-sb"];

// Pick a random variation from the pool, or "none" if the pool is empty
// (which routes syncHaloAmbient to the legacy synthesized pad path).
export function pickHaloMusicVariation(): HaloMusicVariation {
  if (HALO_MUSIC_POOL.length === 0) return "none";
  return HALO_MUSIC_POOL[Math.floor(Math.random() * HALO_MUSIC_POOL.length)];
}
