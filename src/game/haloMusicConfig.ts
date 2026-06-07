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
// Pool (32-second C-pedal loops, 4 phrases ×4 bars, calibrated against the
// in-game-mix audit, beat-clock-aligned start). Each variation's layer 3
// introduces a single new element thematically matched to its ambient +
// melodic stems:
//   cinematic-el  ElevenLabs cinematic bed + felt piano + a lonely solo violin
//          (sfizz + VPO3 — three single-pitch held notes A4/C5/G4, each
//          a chord tone of the underlying bed at that phrase).
//   musicbox-sb  Procedural sine pad + FluidSynth felt piano + slow felt-mallet
//          glockenspiel arpeggio (warm chime, not a kit — extends the
//          felt-piano sparkle into the upper octave).
//   synthwave-el  ElevenLabs analog-synthwave Juno pad + soft lead + pulsed
//          synth-bass arp on the off-beats (synthwave-appropriate motion,
//          octave-low to fill the space the lead leaves).
//   flagship-sb  Self-built flagship: rhythmic 16th-note arp + smooth calliope
//          melody + sparse chime counter-melody (interlocks with the arp's
//          rest slots — adds bell-tone colour without doubling rhythm).
//   vaporwave-el  ElevenLabs dawn/vaporwave: glassy string-choir pad (ambient) +
//          sparse felt-bell sustains (melodic) + bright crystal-glockenspiel
//          arpeggio (layer 3). All three stems live in mid-upper register so
//          the bass field stays clean even with all layers active.
//   outerwilds-el  ElevenLabs Outer-Wilds folk: distant drone pad (ambient) +
//          fingerpicked acoustic guitar in G mixolydian (melodic, plucks
//          quantized to the 8th-note grid via piecewise rubberband stretch)
//          + sparse held-note pump organ in upper register (layer 3, three
//          long notes per 32s loop, Cmaj7 voicing). The melodic guitar is
//          G-rooted over the bass field's C — a deliberate V-over-I
//          suspension that never resolves, suiting the haunting vibe.
//
// Every pool entry is fetched + decoded at startGame so the first 4x
// doesn't pay fetch latency regardless of which one comes up.
import type { HaloMusicVariation } from "../Sound";
import { rng } from "./rng";

// Master on/off for the combo-driven music layers. When false, the 4x/6x/12x
// halo tiers still light up visually but no music (pre-rendered or legacy
// synth pad) starts — the field stays at bass-only.
export const PLAY_COMBO_MUSIC = true;

export const HALO_MUSIC_POOL: readonly HaloMusicVariation[] = ["cinematic-el", "musicbox-sb", "synthwave-el", "flagship-sb", "vaporwave-el", "outerwilds-el"];

// Pick a random variation from the pool, or "none" if the pool is empty
// (which routes syncHaloAmbient to the legacy synthesized pad path).
export function pickHaloMusicVariation(): HaloMusicVariation {
  if (HALO_MUSIC_POOL.length === 0) return "none";
  return HALO_MUSIC_POOL[Math.floor(rng() * HALO_MUSIC_POOL.length)];
}

// Pick a random variation from the pool excluding the currently-playing one.
// Used by the 24x climax swap so the new track always sounds different. Falls
// back to the regular pick when the pool has 0 or 1 entries.
export function pickHaloMusicVariationExcluding(current: HaloMusicVariation): HaloMusicVariation {
  if (HALO_MUSIC_POOL.length === 0) return "none";
  if (HALO_MUSIC_POOL.length === 1) return HALO_MUSIC_POOL[0];
  const others = HALO_MUSIC_POOL.filter((v) => v !== current);
  if (others.length === 0) return HALO_MUSIC_POOL[0];
  return others[Math.floor(rng() * others.length)];
}
