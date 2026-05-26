import { Mode } from "./Mode";

// Generative replacement for the fixed Sound.COMET_MELODY table. Each comet
// gets its own 8-bar phrase generated at spawn time from the current mode —
// so on wave 3 (Lydian) comets sing a bright open phrase, on wave 24 (Aeolian)
// they sing a melancholy one, all from the same shape grammar.
//
// Three things this fixes vs. the static table:
//
//  1. Melodic *evolution*. A comet's phrase = motif + variation + answer +
//     coda, not the same 16 notes on loop. If the comet lives long enough to
//     repeat its phrase, the second pass is transposed up a mode-step so the
//     repetition reads as climbing rather than treading water.
//
//  2. Multi-comet *register stratification*. The first comet on screen plays
//     in the upper octave, the second one drops to the middle, the third
//     plays a slow counter-melody below — so 2-3 comets layered are a
//     three-part canon rather than a melodic pile-up.
//
//  3. Mode-color emphasis. Each phrase visits the current mode's signature
//     degree (Lydian #4, Phrygian b2, etc.) at least once on a strong beat,
//     so the mode change is melodically *heard*, not just felt.
//
// Phrases are generated as arrays of (degree | null) where null = rest.
// Degree is the mode-degree to feed Mode.pitch; the caller is responsible for
// converting to Hz with the appropriate root frequency for that comet's
// register slot.

export type Phrase = (number | null)[];

// Three register slots for active comets. Each slot has a different root Hz
// and a different note-density preference, so layered comets sound like an
// arrangement.
export type RegisterSlot = "high" | "mid" | "low";

export const REGISTER_ROOT_HZ: Record<RegisterSlot, number> = {
  high: 1046.5, // C6 — bright top voice, the "lead"
  mid:  523.25, // C5 — middle voice, used for counter-melody
  low:  261.63, // C4 — slow bass-register counter, very sparse
};

// Per-register phrase length in beats (16ths of a BEAT_GRID phrase). The low
// voice phrase is longer + sparser so it doesn't compete with the mid for
// rhythmic attention.
const PHRASE_LENGTH: Record<RegisterSlot, number> = {
  high: 16,
  mid:  16,
  low:  32, // half-time feel
};

// Fraction of the phrase that should be rests, per slot. The low voice is
// mostly rests — it punctuates rather than melodizes.
const REST_DENSITY: Record<RegisterSlot, number> = {
  high: 0.40,
  mid:  0.55,
  low:  0.75,
};

// Pseudo-random number generator seeded from a comet-specific hash, so each
// comet gets a *deterministic* phrase that won't drift across re-renders.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick which register slot a newly spawned comet should occupy. The Game
// passes in how many comets are already on screen — we cycle high → mid →
// low → high so consecutive spawns auto-stratify.
export function pickRegisterSlot(activeCometCount: number): RegisterSlot {
  const order: RegisterSlot[] = ["high", "mid", "low"];
  return order[activeCometCount % 3];
}

// Generate one phrase for the given mode + register slot + seed. The shape
// grammar is: a 4-note motif → an answer (motif transposed or inverted) →
// a development (longer notes, climbs to the mode's color degree) → a coda
// (returns toward the root). Each section gets ~1/4 of the phrase length.
export function generatePhrase(mode: Mode, slot: RegisterSlot, seed: number): Phrase {
  const rand = mulberry32(seed);
  const length = PHRASE_LENGTH[slot];
  const restDensity = REST_DENSITY[slot];
  const colorDeg = mode.colorDegree();

  // Build a 3-note motif drawn from the current mode. Degrees 0-6 cover the
  // octave; we bias toward 0, 2, 4, 6 (chord tones) for the motif so it has
  // melodic gravity.
  const chordTones = [0, 2, 4, 6];
  const motifNotes: number[] = [
    chordTones[Math.floor(rand() * 4)],
    chordTones[Math.floor(rand() * 4)],
    chordTones[Math.floor(rand() * 4)],
  ];

  const section = Math.floor(length / 4);
  const phrase: Phrase = new Array(length).fill(null);

  // Section 1 — the motif. Place the 3 notes at slot 0, 1, 2 and leave the
  // 4th step as rest so the motif breathes.
  for (let i = 0; i < motifNotes.length && i < section; i++) phrase[i] = motifNotes[i];

  // Section 2 — answer. Re-state the motif inverted around the 3rd, with a
  // small offset so it lands a little later in the section (gives it a
  // call/response feel).
  const answerStart = section + 1;
  for (let i = 0; i < motifNotes.length; i++) {
    const idx = answerStart + i;
    if (idx >= section * 2) break;
    // Inversion: a degree d becomes 2 - d, mirrored around the 3rd. Then
    // shift by +2 so the answer sits in the same register as the call.
    phrase[idx] = (2 - motifNotes[i]) + 2;
  }

  // Section 3 — development. Climb the scale, visiting the color degree on
  // the *first beat* of the section (strong beat) so the mode's signature
  // sound lands prominently.
  const devStart = section * 2;
  phrase[devStart] = colorDeg + 4; // an octave above the color tone for emphasis
  // Step pattern around the color tone — alternating chord tones above.
  if (devStart + 2 < section * 3) phrase[devStart + 2] = 6;
  if (devStart + 3 < section * 3) phrase[devStart + 3] = colorDeg + 7;

  // Section 4 — coda. Resolve back down through 5, 3, 1 toward the root.
  const codaStart = section * 3;
  phrase[codaStart]     = 4;
  if (codaStart + 1 < length) phrase[codaStart + 1] = 2;
  if (codaStart + 2 < length) phrase[codaStart + 2] = null; // pause before resolution
  if (codaStart + 3 < length) phrase[codaStart + 3] = 0;

  // Apply per-step rest probability — but never erase the structural anchors:
  // motif notes, the color degree on the development downbeat, the coda
  // resolution. Random rests carve breathing space into the rest of the line.
  const anchors = new Set([0, 1, 2, devStart, codaStart, codaStart + 3]);
  for (let i = 0; i < length; i++) {
    if (anchors.has(i)) continue;
    if (phrase[i] !== null && rand() < restDensity) phrase[i] = null;
  }

  // Low voice gets an extra cull pass: it should be mostly silence with the
  // occasional punctuation note on strong beats only.
  if (slot === "low") {
    for (let i = 0; i < length; i++) {
      if (i % 4 !== 0 && rand() < 0.6) phrase[i] = null;
    }
  }

  return phrase;
}

// One comet's musical state. Lives for the comet's lifetime; the Game holds
// a reference and calls noteForStep each beat to find out what (if anything)
// to play.
export class CometMelodyState {
  slot: RegisterSlot;
  rootHz: number;
  phrase: Phrase;
  // How many times the phrase has fully repeated. Each repeat transposes up
  // by one mode-step — gentle climb so a long-lived comet doesn't loop
  // identically. Caps at 2 (one octave) so it doesn't get shrill.
  repeats = 0;
  private mode: Mode;

  constructor(mode: Mode, slot: RegisterSlot, seed: number) {
    this.mode = mode;
    this.slot = slot;
    this.rootHz = REGISTER_ROOT_HZ[slot];
    this.phrase = generatePhrase(mode, slot, seed);
  }

  // Returns the frequency to play at this beat-step, or null for a rest.
  // step = the global comet beat counter (Game's c.noteIndex); we modulo
  // into the phrase ourselves and track repeats internally.
  noteForStep(step: number): number | null {
    const len = this.phrase.length;
    const stepInPhrase = ((step % len) + len) % len;
    // Detect phrase wraparound to bump the repeat counter (and re-generate
    // the phrase against the current mode in case the wave changed mid-phrase
    // — keeps a long comet feeling like a single arc despite shifting harmony).
    if (stepInPhrase === 0 && step > 0) {
      this.repeats = Math.min(this.repeats + 1, 2);
      this.phrase = generatePhrase(this.mode, this.slot, step * 9301 + 49297);
    }
    const degree = this.phrase[stepInPhrase];
    if (degree === null) return null;
    // Repeat-transposition: add one mode-step per repeat so long comets climb.
    return this.mode.pitch(degree + this.repeats * 2, this.rootHz);
  }
}
