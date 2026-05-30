// Halo music selection. Stems live in /sounds/halo-music/{variation}-{ambient,melodic,sparkle}.mp3.
//
// Each time the player crosses combo ≥ 4 from below, syncHaloAmbient picks
// a random variation from HALO_MUSIC_POOL. The chosen variation persists
// for the lifetime of that halo (so 6x melodic and 12x sparkle use the
// same variation's stems); a new pick happens on the next 4x trigger after
// combo breaks.
//
// To disable music entirely and fall back to the legacy synthesized pad,
// set HALO_MUSIC_POOL to []. To force a specific variation for an A/B test,
// set the pool to a single entry.
//
// Round 2/3 pool (32-second C-pedal loops, 4 phrases ×4 bars, calibrated
// against the in-game-mix audit, beat-clock-aligned start):
//   r2-el  ElevenLabs cinematic bed + felt piano + (self-built) celesta
//          chimes sparkle. Centroid ~600 Hz, sits dark and wide. Plays gain 0.25.
//   r2-sb  Procedural sine pad + FluidSynth felt piano + glockenspiel
//          sparkle, all with sox reverb. Centroid ~280 Hz, warmer / drier.
//          Plays gain 0.30.
//   r3-el  ElevenLabs end-to-end analog-synthwave: Juno-style pad + soft
//          lead + crystalline arpeggiated sparkle. All three layers from EL.
//          Centroid ~425 Hz ambient/melodic, ~2.1 kHz sparkle. Bass-heavy
//          pad needs conservative gain 0.22.
//   r4-sb  Self-built flagship: rhythmic 16th-note arp + pad (ambient),
//          smooth calliope-synth melody that breathes in the gaps between
//          sparkle cascades (melodic), celesta counter-melody (sparkle).
//          Three layers interlocked on a 16th-note grid with the melody
//          phrased to leave room for the cascade fragments. Plays gain
//          0.25 across all layers.
//
// Every pool entry is fetched + decoded at startGame so the first 4x
// doesn't pay fetch latency regardless of which one comes up.
import type { HaloMusicVariation } from "../Sound";

export const HALO_MUSIC_POOL: readonly HaloMusicVariation[] = ["r2-el", "r2-sb", "r3-el", "r4-sb"];

// Pick a random variation from the pool, or "none" if the pool is empty
// (which routes syncHaloAmbient to the legacy synthesized pad path).
export function pickHaloMusicVariation(): HaloMusicVariation {
  if (HALO_MUSIC_POOL.length === 0) return "none";
  return HALO_MUSIC_POOL[Math.floor(Math.random() * HALO_MUSIC_POOL.length)];
}
