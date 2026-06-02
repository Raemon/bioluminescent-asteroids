// Halo music selection. Stems live in /sounds/halo-music/{variation}-{ambient,melodic,layer3}.mp3.
//
// Each time the player crosses combo ≥ 4 from below, syncHaloAmbient picks
// a random variation from HALO_MUSIC_POOL. The chosen variation persists
// for the lifetime of that halo (so 6x melodic and 12x layer3 use the
// same variation's stems); a new pick happens on the next 4x trigger after
// combo breaks.
//
// To disable music entirely and fall back to the legacy synthesized pad,
// set HALO_MUSIC_POOL to []. To force a specific variation for an A/B test,
// set the pool to a single entry.
//
// Round 2/3/4 pool (32-second C-pedal loops, 4 phrases ×4 bars, calibrated
// against the in-game-mix audit, beat-clock-aligned start). Each variation's
// layer 3 introduces a single new element thematically matched to its
// ambient + melodic stems:
//   r2-el  ElevenLabs cinematic bed + felt piano + a lonely solo violin
//          (FluidSynth — string section third voice).
//   r2-sb  Procedural sine pad + FluidSynth felt piano + slow felt-mallet
//          glockenspiel arpeggio (warm chime, not a kit — extends the
//          felt-piano sparkle into the upper octave).
//   r3-el  ElevenLabs analog-synthwave Juno pad + soft lead + pulsed
//          synth-bass arp on the off-beats (synthwave-appropriate motion,
//          octave-low to fill the space the lead leaves).
//   r4-sb  Self-built flagship: rhythmic 16th-note arp + smooth calliope
//          melody + sparse chime counter-melody (interlocks with the arp's
//          rest slots — adds bell-tone colour without doubling rhythm).
//
// Every pool entry is fetched + decoded at startGame so the first 4x
// doesn't pay fetch latency regardless of which one comes up.
import type { HaloMusicVariation } from "../Sound";

// Master on/off for the combo-driven music layers. When false, the 4x/6x/12x
// halo tiers still light up visually but no music (pre-rendered or legacy
// synth pad) starts — the field stays at bass-only.
export const PLAY_COMBO_MUSIC = true;

export const HALO_MUSIC_POOL: readonly HaloMusicVariation[] = ["r2-el", "r2-sb", "r3-el", "r4-sb"];

// Pick a random variation from the pool, or "none" if the pool is empty
// (which routes syncHaloAmbient to the legacy synthesized pad path).
export function pickHaloMusicVariation(): HaloMusicVariation {
  if (HALO_MUSIC_POOL.length === 0) return "none";
  return HALO_MUSIC_POOL[Math.floor(Math.random() * HALO_MUSIC_POOL.length)];
}
