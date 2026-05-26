import { Mode, ModeName } from "./Mode";

// Mode-aware stinger pitch tables. The current Sound.ts plays chime, bell,
// tink, warble, powerup, and waveClear at fixed pitches (C6, A3, A6/E7, D5,
// C5-E5-G5-C6, E4-G#4-B4-Eb5). Those pitches were chosen in isolation; once
// the bed underneath is in a non-major mode the stinger fights the harmony.
//
// This module reframes each stinger as a *function of the current mode*. The
// stinger keeps its character (chime = sparkle, bell = somber, etc.) but the
// actual frequencies follow the harmony.
//
// Each function returns an array of frequencies — the caller still owns the
// envelope, timbre, and timing. Drop-in replacement for the hard-coded
// arrays in Sound.playChime / playBell / playTink / playPowerup / playWaveClear.
//
// Cache compatibility: the existing Sound.bakedBuffers cache is keyed by
// (soundName, pitchRatio). Mode-aware stingers can keep using it if the key
// includes the mode — see ModalBakeKey + the lazy-bake protocol at the bottom
// of this file. That protocol is what lets us keep the "no live synthesis on
// the hot path" guarantee from the bake work, even though the pitches now
// change per wave.

// "chime" — bright sparkle. Two-note open fifth from the top of the scale,
// drawn from degrees 4 and 7 (5th + octave) so it's always consonant against
// any mode and reads as "celebration" regardless of harmonic mood.
export function chimePitches(mode: Mode): number[] {
  const C6 = 1046.5;
  return [
    mode.pitch(0, C6),     // root above the action
    mode.pitch(4, C6),     // 5th — universally bright
  ];
}

// "bell" — somber, lower-register, inharmonic tail. Use the *current* tonic
// triad in the comfortable A3 octave so the bell tells the player what mode
// they're in. In Lydian it sings major; in Phrygian it sings minor with the
// signature flat-2 colour absent (we hold the triad to keep it pure).
export function bellChord(mode: Mode): number[] {
  const A3 = 220.0;
  return mode.diatonicTriad(0, A3);
}

// "tink" — rare crystal hit, very high. Currently A6 + E7 (perfect fifth).
// Keep the fifth (perfect fifth is invariant across modes), but transpose to
// match the mode root so it locks in instead of clashing.
export function tinkPitches(mode: Mode): number[] {
  const C7 = 2093.0;
  return [
    mode.pitch(0, C7),
    mode.pitch(4, C7),
  ];
}

// "powerup" — celebratory ascending arpeggio. Currently C5-E5-G5-C6 (I major
// triad + octave). Now: scale degrees 0, 2, 4, 7 in the *current* mode,
// rooted at C5. So in Phrygian the player hears C-Eb-G-C → still celebratory
// (a clear arpeggio resolving on the octave) but coloured by the mode they're
// playing in.
export function powerupArpeggio(mode: Mode): number[] {
  const C5 = 523.25;
  return [
    mode.pitch(0, C5),
    mode.pitch(2, C5),
    mode.pitch(4, C5),
    mode.pitch(7, C5),
  ];
}

// "waveClear" — the big chord that plays at the end of a wave. Currently a
// hard-coded E-G#-B-Eb (an E major add♭6, slightly enigmatic). Generate
// instead from the *upcoming* mode (the wave we're about to enter) so the
// wave-clear chord previews the harmonic shift — players will hear the colour
// change a beat before the next wave starts, which is gorgeous.
//
// Voicing: spread over 1.5 octaves so it sounds full without being muddy.
// Degrees 0, 2, 4, 7+1 (root, 3rd, 5th, 9th-ish) → diatonic 9 chord.
export function waveClearChord(mode: Mode): number[] {
  const E4 = 329.63;
  return [
    mode.pitch(0, E4),
    mode.pitch(2, E4),
    mode.pitch(4, E4),
    mode.pitch(7, E4) * 2, // octave up — adds a top sparkle voice
  ];
}

// "warble" — vocal-like sine with fast vibrato. Currently fixed at D5
// (587 Hz). D in C-major is fine; in C-Phrygian D is the b2, which is
// already a tension tone, and a vibrato on a b2 sounds anxious — which is
// arguably the *right* feeling for the late-game warble asteroid. So we
// pin warble to whatever degree-2 is in the current mode, deliberately
// letting it shift from "neutral" (D in major) to "ominous" (Db in Phrygian).
export function warblePitch(mode: Mode): number {
  return mode.pitch(1, 523.25); // degree 1 above C5; "second scale degree"
}

// ── Lazy per-mode bake protocol ─────────────────────────────────────────────
// Sound.ts already has a baked-buffer cache (bakedBuffers) keyed by
// (soundName, pitchRatio). With mode-aware stingers those buffers depend on
// the *mode* too, so we extend the key with the mode name and lazy-bake on
// mode change instead of warming everything at startup.
//
// The protocol below describes what Sound.ts needs to implement; this module
// stays decoupled from the audio engine (no Tone import, no AudioContext
// usage) so it can be unit-tested and so the audio engine retains ownership
// of the actual buffer rendering.

// Which stingers are mode-aware. bgBeat / bassKit / fireBeat stay fixed-pitch
// (they're the rhythm bed and shouldn't drift across waves), so they keep
// using the existing pre-bake-everything-at-startup approach unchanged.
export const MODAL_STINGERS = ["chime", "bell", "tink", "powerup", "waveClear", "warble"] as const;
export type ModalStingerName = typeof MODAL_STINGERS[number];

// Composite cache key. Pass this to bakedBuffers.get / .set in Sound.ts so
// Lydian-chime, Phrygian-chime, etc. coexist in the same Map.
export function modalBakeKey(name: ModalStingerName, mode: ModeName): string {
  return `${name}|mode=${mode}`;
}

// The bake recipe Sound.ts needs in order to render a buffer for one
// (stinger, mode) pair. Sound.ts already knows how to build offline contexts
// and trigger Tone synths; this just hands it the pitches + a duration hint.
export interface ModalBakeRecipe {
  name: ModalStingerName;
  mode: ModeName;
  pitchesHz: number[];        // sorted ascending, exactly the freqs to trigger
  durationSec: number;        // how long to render (covers envelope + reverb tail)
}

// Per-stinger render duration. Matches the existing durations table in
// Sound.bakeSound so the modal-bake path doesn't truncate tails.
const STINGER_DURATIONS: Record<ModalStingerName, number> = {
  chime:     2.0,
  bell:      2.2,
  tink:      1.4,
  powerup:   1.6,
  waveClear: 2.4,
  warble:    1.2,
};

// Build the full set of bake recipes for one mode — the thing the caller
// passes to the audio engine when a mode change happens. Six recipes per
// mode, 6 modes total across a 30-wave run = 36 total renders across an
// entire session, lazy-loaded as the player advances. Compare to the
// startup pre-bake (~8 sounds rendered eagerly at boot).
export function recipesForMode(mode: Mode): ModalBakeRecipe[] {
  const m = mode.current;
  return [
    { name: "chime",     mode: m, pitchesHz: chimePitches(mode),    durationSec: STINGER_DURATIONS.chime },
    { name: "bell",      mode: m, pitchesHz: bellChord(mode),       durationSec: STINGER_DURATIONS.bell },
    { name: "tink",      mode: m, pitchesHz: tinkPitches(mode),     durationSec: STINGER_DURATIONS.tink },
    { name: "powerup",   mode: m, pitchesHz: powerupArpeggio(mode), durationSec: STINGER_DURATIONS.powerup },
    { name: "waveClear", mode: m, pitchesHz: waveClearChord(mode),  durationSec: STINGER_DURATIONS.waveClear },
    { name: "warble",    mode: m, pitchesHz: [warblePitch(mode)],   durationSec: STINGER_DURATIONS.warble },
  ];
}

// Wire-up in Sound.ts (paraphrased):
//
//   setMode(mode: Mode) {
//     for (const recipe of recipesForMode(mode)) {
//       const key = modalBakeKey(recipe.name, recipe.mode);
//       if (!this.bakedBuffers.has(key) && !this.bakingInFlight.has(key)) {
//         this.bakingInFlight.add(key);
//         this.bakeChain = this.bakeChain.then(() => this.bakeModalStinger(recipe).then((buf) => {
//           if (buf) this.bakedBuffers.set(key, buf);
//           this.bakingInFlight.delete(key);
//         }));
//       }
//     }
//   }
//
//   playChime() {
//     const key = modalBakeKey("chime", this.mode.current);
//     const buf = this.bakedBuffers.get(key);
//     if (buf) { /* play baked buffer, return */ }
//     // Fallback: synthesize live with chimePitches(this.mode). Only happens
//     // for the first few triggers immediately after a mode change.
//   }
//
// Net effect: ~50ms of background bake work at each of the 6 mode boundaries
// (waves 5/12/18/24/28). All cold-cache triggers fall back to live synthesis
// transparently, so the first chime after a wave-shift is the same cost it
// was *before* the bake cache existed — and every subsequent trigger in that
// mode hits the cache for the rest of the session.
