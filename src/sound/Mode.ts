// Harmonic context for the whole soundscape. Every melodic voice should
// pull its pitches from here so the bass kit, comet melody, drones, and
// stinger chords all shift mood together as the wave advances. Root is
// always C (so all the bass kit pitch math stays valid) — only the
// scale degrees move. This lets a comet on wave 3 play a bright Lydian
// climb while the same comet on wave 28 plays the same melodic shape in
// Phrygian and feels ominous, with zero changes to the calling code.
//
// All scales are returned as frequency multipliers relative to C (1.0 = C).
// Octave is the caller's job: multiply by 261.63 for a C4-rooted scale,
// 130.81 for C3, etc. That lets one mode table serve every register.

export type ModeName = "lydian" | "ionian" | "mixolydian" | "dorian" | "aeolian" | "phrygian";

// Pythagorean-ish 12-TET ratios for each chromatic step from the root.
// 0=root, 2=major-2, 3=minor-3, 4=major-3, 5=perfect-4, 6=tritone,
// 7=perfect-5, 8=minor-6, 9=major-6, 10=minor-7, 11=major-7.
const STEP_RATIO = [
  1,                    // 0  unison
  Math.pow(2, 1 / 12),  // 1  m2
  Math.pow(2, 2 / 12),  // 2  M2
  Math.pow(2, 3 / 12),  // 3  m3
  Math.pow(2, 4 / 12),  // 4  M3
  Math.pow(2, 5 / 12),  // 5  P4
  Math.pow(2, 6 / 12),  // 6  TT
  Math.pow(2, 7 / 12),  // 7  P5
  Math.pow(2, 8 / 12),  // 8  m6
  Math.pow(2, 9 / 12),  // 9  M6
  Math.pow(2, 10 / 12), // 10 m7
  Math.pow(2, 11 / 12), // 11 M7
];

// Scale degrees (semitone offsets from root) for each mode. Each mode is a
// 7-note scale; the 8th entry (octave) is implicit and added by getRatio if
// the caller asks for degree 7.
const MODE_DEGREES: Record<ModeName, number[]> = {
  lydian:     [0, 2, 4, 6, 7, 9, 11], // brightest — raised 4th
  ionian:     [0, 2, 4, 5, 7, 9, 11], // standard major
  mixolydian: [0, 2, 4, 5, 7, 9, 10], // major with flat 7 — bluesy
  dorian:     [0, 2, 3, 5, 7, 9, 10], // minor with raised 6th — melancholy but hopeful
  aeolian:    [0, 2, 3, 5, 7, 8, 10], // natural minor
  phrygian:   [0, 1, 3, 5, 7, 8, 10], // darkest — flat 2nd, exotic/ominous
};

// Wave → mode mapping. Hand-tuned so the brightest mode covers the calm
// opening waves and Phrygian only arrives when the pulsar is genuinely
// close. Boundaries are inclusive low, exclusive high.
const WAVE_MODE_THRESHOLDS: Array<{ untilWave: number; mode: ModeName }> = [
  { untilWave: 6,  mode: "lydian" },
  { untilWave: 13, mode: "ionian" },
  { untilWave: 19, mode: "mixolydian" },
  { untilWave: 25, mode: "dorian" },
  { untilWave: 29, mode: "aeolian" },
  { untilWave: 999, mode: "phrygian" },
];

export class Mode {
  // Updated by Game once per wave. Default = lydian so the very first wave
  // sounds maximally open before anyone plays a note.
  current: ModeName = "lydian";

  setWave(wave: number) {
    for (const t of WAVE_MODE_THRESHOLDS) {
      if (wave < t.untilWave) { this.current = t.mode; return; }
    }
  }

  // Frequency multiplier (relative to root) for scale degree `degree`. Degree
  // is 0-indexed within the current 7-note mode; values above 6 wrap into the
  // next octave automatically. Negative degrees descend below the root.
  ratio(degree: number, mode: ModeName = this.current): number {
    const scale = MODE_DEGREES[mode];
    const len = scale.length;
    const octShift = Math.floor(degree / len);
    const wrapped = ((degree % len) + len) % len;
    const semitones = scale[wrapped];
    return STEP_RATIO[semitones] * Math.pow(2, octShift);
  }

  // Pitch in Hz for `degree` above `rootHz`, in the current mode.
  pitch(degree: number, rootHz: number, mode: ModeName = this.current): number {
    return rootHz * this.ratio(degree, mode);
  }

  // Three-note chord built on a given degree of the current mode (root, third,
  // fifth of the *triad starting at that degree*, drawn from the mode itself —
  // i.e. diatonic harmony). Useful for drone beds that should follow the mode
  // without crowding the comet melody.
  diatonicTriad(rootDegree: number, rootHz: number, mode: ModeName = this.current): [number, number, number] {
    return [
      this.pitch(rootDegree, rootHz, mode),
      this.pitch(rootDegree + 2, rootHz, mode),
      this.pitch(rootDegree + 4, rootHz, mode),
    ];
  }

  // The signature "color tone" of the current mode — the degree that most
  // distinguishes it from natural major/minor. Comet melodies can lean on
  // this so the mode change is *heard*, not just statistical.
  colorDegree(mode: ModeName = this.current): number {
    switch (mode) {
      case "lydian":     return 3;  // #4 (raised 4th)
      case "ionian":     return 6;  // major 7
      case "mixolydian": return 6;  // flat 7
      case "dorian":     return 5;  // major 6
      case "aeolian":    return 5;  // minor 6
      case "phrygian":   return 1;  // flat 2 (the signature Phrygian sound)
    }
  }
}
