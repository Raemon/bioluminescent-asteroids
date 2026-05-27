// Static metadata describing every hit-type in the game. Numbers reflect
// what's hard-coded in Sound.ts as of writing — they're for display, not
// truth (the visualizer captures actual playback). When the underlying
// sound is tweaked in Sound.ts, update the relevant entry here so the
// editor's "spec sheet" panel stays honest.

import type { SoundName } from "../Sound";

export type SoundGroup =
  | "fire"
  | "explosion"
  | "ship"
  | "bass"
  | "alien"
  | "rhythm"
  | "ui"
  | "comet";

export type SoundSpec = {
  name: SoundName;
  label: string;
  group: SoundGroup;
  // ~ how long the sound plays in seconds. The capture buffer is sized
  // from this with a small tail (+0.08s).
  expectedDurationSec: number;
  // Whether passing a non-1 pitchRatio to Sound.play(name, ratio) does
  // something meaningful. (For sounds that ignore it, the pitch knob
  // still works as a post-capture playbackRate.)
  acceptsPitchRatio: boolean;
  // Short hand-written description shown next to the visualizer.
  blurb: string;
  // Approx central pitch in Hz at default settings — for the spec panel.
  // Use 0 if the sound is purely noise-based.
  centerHz: number;
  // 0..1: how noise-dominated the sound is (vs tonal). Display only.
  noisiness: number;
};

export const SOUND_CATALOG: SoundSpec[] = [
  // — fire group —
  {
    name: "fire",
    label: "fire",
    group: "fire",
    expectedDurationSec: 0.14,
    acceptsPitchRatio: false,
    blurb: "Default shot — G4 sine + G5 partial + 1.6 kHz noise tick.",
    centerHz: 392,
    noisiness: 0.2,
  },
  {
    name: "fireBeat",
    label: "fire (on-beat)",
    group: "fire",
    expectedDurationSec: 0.32,
    acceptsPitchRatio: false,
    blurb: "Heavy timed-shot variant — C3 body + C2 sub + 600 Hz wood tick.",
    centerHz: 130.8,
    noisiness: 0.18,
  },

  // — explosion group —
  {
    name: "explosionLarge",
    label: "explosion / large",
    group: "explosion",
    expectedDurationSec: 0.6,
    acceptsPitchRatio: false,
    blurb: "Lowpassed noise sweep + sub sweep. (0.7, 160 Hz, 0.55s)",
    centerHz: 96,
    noisiness: 0.9,
  },
  {
    name: "explosionMedium",
    label: "explosion / medium",
    group: "explosion",
    expectedDurationSec: 0.46,
    acceptsPitchRatio: false,
    blurb: "Same shape, brighter & shorter. (0.55, 230 Hz, 0.42s)",
    centerHz: 138,
    noisiness: 0.9,
  },
  {
    name: "explosionSmall",
    label: "explosion / small",
    group: "explosion",
    expectedDurationSec: 0.34,
    acceptsPitchRatio: false,
    blurb: "Snappy upper-mid debris. (0.4, 340 Hz, 0.3s)",
    centerHz: 204,
    noisiness: 0.85,
  },
  {
    name: "death",
    label: "death",
    group: "explosion",
    expectedDurationSec: 1.7,
    acceptsPitchRatio: false,
    blurb: "Sub-thump + noise crack + detuned-saw scream + rumble tail.",
    centerHz: 60,
    noisiness: 0.8,
  },

  // — ship —
  {
    name: "thrust",
    label: "thrust (loop)",
    group: "ship",
    expectedDurationSec: 0.5,
    acceptsPitchRatio: false,
    blurb: "Looping triangle drone @ 110 Hz w/ 5 Hz tremolo. Captured 0.5s.",
    centerHz: 110,
    noisiness: 0.05,
  },
  {
    name: "shieldPop",
    label: "shield pop",
    group: "ship",
    expectedDurationSec: 0.38,
    acceptsPitchRatio: false,
    blurb: "880→440 Hz glide + bandpassed 3 kHz wash.",
    centerHz: 660,
    noisiness: 0.4,
  },
  {
    name: "shockwaveCharge",
    label: "shockwave / charge",
    group: "ship",
    expectedDurationSec: 5.0,
    acceptsPitchRatio: false,
    blurb: "Long tension-building windup with accelerating spin-up whine.",
    centerHz: 500,
    noisiness: 0.4,
  },
  {
    name: "shockwaveBoom",
    label: "shockwave / boom",
    group: "ship",
    expectedDurationSec: 3.0,
    acceptsPitchRatio: false,
    blurb: "Bass drop — deep sub + growl octave + wide noise wash.",
    centerHz: 70,
    noisiness: 0.85,
  },

  // — bassteroid rhythm —
  {
    name: "bassKick",
    label: "bass kick",
    group: "bass",
    expectedDurationSec: 0.36,
    acceptsPitchRatio: true,
    blurb: "Sine sweep 140→55 Hz with click. Pitch ratio scales tonally.",
    centerHz: 80,
    noisiness: 0.05,
  },
  {
    name: "bassPluck",
    label: "bass pluck",
    group: "bass",
    expectedDurationSec: 0.48,
    acceptsPitchRatio: true,
    blurb: "Detuned saw + tri @ G2 through closing LPF.",
    centerHz: 98,
    noisiness: 0.0,
  },
  {
    name: "bassBoom",
    label: "bass boom",
    group: "bass",
    expectedDurationSec: 0.5,
    acceptsPitchRatio: true,
    blurb: "180→87 Hz sweep + F1 sub + bandpass clack.",
    centerHz: 87,
    noisiness: 0.15,
  },
  {
    name: "bassSnap",
    label: "bass snap",
    group: "bass",
    expectedDurationSec: 0.18,
    acceptsPitchRatio: true,
    blurb: "Bandpass noise + 330→131 Hz triangle. Beat 4 accent.",
    centerHz: 220,
    noisiness: 0.7,
  },
  {
    name: "bassHit",
    label: "bass hit",
    group: "bass",
    expectedDurationSec: 0.45,
    acceptsPitchRatio: false,
    blurb: "Detuned saw 180→48 Hz + low-band noise crunch.",
    centerHz: 96,
    noisiness: 0.5,
  },
  {
    name: "bassEcho",
    label: "bass echo (×4)",
    group: "bass",
    expectedDurationSec: 1.2,
    acceptsPitchRatio: false,
    blurb: "Four E2 thuds decaying 0.22s apart, each darker than the last.",
    centerHz: 82,
    noisiness: 0.05,
  },

  // — alien —
  {
    name: "alienFireBig",
    label: "alien fire / big",
    group: "alien",
    expectedDurationSec: 0.4,
    acceptsPitchRatio: false,
    blurb: "Slow descending sweep — large alien shot.",
    centerHz: 180,
    noisiness: 0.2,
  },
  {
    name: "alienFireMedium",
    label: "alien fire / med",
    group: "alien",
    expectedDurationSec: 0.3,
    acceptsPitchRatio: false,
    blurb: "Mid-tier alien shot.",
    centerHz: 350,
    noisiness: 0.2,
  },
  {
    name: "alienFireSmall",
    label: "alien fire / small",
    group: "alien",
    expectedDurationSec: 0.2,
    acceptsPitchRatio: false,
    blurb: "Quick zap — small alien shot.",
    centerHz: 700,
    noisiness: 0.15,
  },
  {
    name: "alienHit",
    label: "alien hit",
    group: "alien",
    expectedDurationSec: 0.3,
    acceptsPitchRatio: false,
    blurb: "Quick non-fatal hit.",
    centerHz: 500,
    noisiness: 0.5,
  },
  {
    name: "alienExplode",
    label: "alien explode",
    group: "alien",
    expectedDurationSec: 0.5,
    acceptsPitchRatio: false,
    blurb: "Medium explosion (alien-flavored).",
    centerHz: 138,
    noisiness: 0.85,
  },

  // — rhythm / pickup —
  {
    name: "waveClear",
    label: "wave clear",
    group: "rhythm",
    expectedDurationSec: 0.9,
    acceptsPitchRatio: false,
    blurb: "Ascending E-G♯-B-E♭ chord arpeggio.",
    centerHz: 494,
    noisiness: 0.0,
  },
  {
    name: "powerup",
    label: "powerup",
    group: "rhythm",
    expectedDurationSec: 0.7,
    acceptsPitchRatio: false,
    blurb: "C5-E5-G5-C6 arpeggio + 2-3.5 kHz shimmer.",
    centerHz: 783,
    noisiness: 0.0,
  },
  {
    name: "bgBeat",
    label: "background beat",
    group: "rhythm",
    expectedDurationSec: 0.4,
    acceptsPitchRatio: true,
    blurb: "Pulsar-approach rumble. Intensity scales with wave.",
    centerHz: 60,
    noisiness: 0.5,
  },
  {
    name: "pulsarHum",
    label: "pulsar hum",
    group: "rhythm",
    expectedDurationSec: 0.8,
    acceptsPitchRatio: false,
    blurb: "Sustained low-end pulse — pulsar onscreen.",
    centerHz: 55,
    noisiness: 0.1,
  },

  // — UI / sparkle —
  {
    name: "chime",
    label: "chime",
    group: "ui",
    expectedDurationSec: 1.0,
    acceptsPitchRatio: false,
    blurb: "C6 sine + 2 harmonic partials, ~0.9s wind-chime decay.",
    centerHz: 1046.5,
    noisiness: 0.0,
  },
  {
    name: "bell",
    label: "bell",
    group: "ui",
    expectedDurationSec: 1.45,
    acceptsPitchRatio: false,
    blurb: "A3 sine + inharmonic partials (1, 2.76, 5.4, 8.93×). Temple bell.",
    centerHz: 220,
    noisiness: 0.0,
  },
  {
    name: "warble",
    label: "warble",
    group: "ui",
    expectedDurationSec: 0.65,
    acceptsPitchRatio: false,
    blurb: "D5 carrier with 8 Hz vibrato — vocal 'ooo'.",
    centerHz: 587.33,
    noisiness: 0.0,
  },
  {
    name: "comboTick",
    label: "combo tick",
    group: "ui",
    expectedDurationSec: 0.05,
    acceptsPitchRatio: false,
    blurb: "Tiny highpass noise burst — on-beat shot confirm.",
    centerHz: 5000,
    noisiness: 1.0,
  },
  {
    name: "comboSparkle",
    label: "combo sparkle",
    group: "ui",
    expectedDurationSec: 0.25,
    acceptsPitchRatio: false,
    blurb: "A5 + E6 mid sparkle — on-beat kill confirm.",
    centerHz: 1100,
    noisiness: 0.0,
  },
  {
    name: "tink",
    label: "tink",
    group: "ui",
    expectedDurationSec: 0.42,
    acceptsPitchRatio: false,
    blurb: "Bright A6 + E7 glassy stack — rare crystal asteroid.",
    centerHz: 2200,
    noisiness: 0.0,
  },

  // — comet —
  {
    name: "cometNote",
    label: "comet note",
    group: "comet",
    expectedDurationSec: 0.6,
    acceptsPitchRatio: true,
    blurb: "Single note from the comet melody. PitchRatio = scale step.",
    centerHz: 440,
    noisiness: 0.0,
  },
];

export const GROUP_ORDER: SoundGroup[] = [
  "fire",
  "explosion",
  "ship",
  "bass",
  "alien",
  "rhythm",
  "ui",
  "comet",
];

export const GROUP_LABEL: Record<SoundGroup, string> = {
  fire: "fire",
  explosion: "explosions",
  ship: "ship",
  bass: "bassteroid rhythm",
  alien: "alien",
  rhythm: "rhythm / pickups",
  ui: "ui / sparkle",
  comet: "comet",
};

// Accent color per group — feeds the visualizer's color encoding so groups
// read at a glance.  Hue picked to match style.css palette (cyan/gold/red).
export const GROUP_ACCENT: Record<SoundGroup, string> = {
  fire: "#ffd86a",
  explosion: "#ff7a5c",
  ship: "#6ad7ff",
  bass: "#b685ff",
  alien: "#7cffb0",
  rhythm: "#ffd86a",
  ui: "#e0f7ff",
  comet: "#ff9ad6",
};
