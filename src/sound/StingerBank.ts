import { Mode } from "./Mode";

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
