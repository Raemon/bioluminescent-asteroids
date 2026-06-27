// Piano-keyboard playground for /music. Pick any sound from the repertoire —
// hardcoded synths (SoundName), downloaded sample libraries (WAVs in
// /sounds/guitar), or any General-MIDI instrument via soundfont-player — and
// play it at any pitch by clicking keys or typing on the computer keyboard.
//
// Pitch model
//   - Each key has a semitone offset relative to a "root key" (default C4).
//   - For synth sounds: pitchRatio = 2^(semitones/12), passed to sound.play().
//     pitchRatio=1 means the sound plays at its native pitch — the root key
//     is the sound's "home" note.
//   - For raw sample buffers: same exponent, applied via AudioBufferSourceNode
//     .playbackRate.
//   - For GM instruments: we pass the MIDI note directly to the soundfont
//     player, which has its own per-note samples — no pitch-shifting needed,
//     so the "root note" UI control is ignored for GM. The keyboard buttons
//     play their literal note (C4 button → C4 on the instrument).

import { useCallback, useEffect, useMemo, useState } from "react";
import Soundfont from "soundfont-player";
import { Sound, type SoundName } from "../../Sound";
import { loadSoundConfig } from "../../soundConfig";

// Inline subset of soundfont-player's runtime shape — its index.d.ts uses
// `export declare const instrument` but the lib actually `module.exports =
// Soundfont`, so default-importing the whole namespace is the safe runtime
// path. We type it ourselves so TypeScript stays happy.
type SfPlayer = {
  play: (note: string | number, when?: number, opts?: { gain?: number; duration?: number }) => unknown;
  connect: (dest: AudioNode) => SfPlayer;
};
type SfNamespace = {
  instrument: (ac: AudioContext, name: string, opts?: { soundfont?: string; format?: string; gain?: number }) => Promise<SfPlayer>;
};
const Sf = Soundfont as unknown as SfNamespace;

// ── repertoire ─────────────────────────────────────────────────────────

type SynthSource = {
  kind: "synth";
  id: string;
  label: string;
  // The SoundName to dispatch to sound.play().
  sound: SoundName;
  // Optional override: some synth voices ignore pitchRatio (e.g. fire, death,
  // explosions). We still expose them but mark them so the UI can warn.
  pitched: boolean;
  blurb?: string;
};

type SampleSource = {
  kind: "sample";
  id: string;
  label: string;
  url: string;
  // The recorded fundamental, used as the unit for playbackRate. The root
  // key plays the sample at exactly this Hz; other keys pitch-shift relative.
  recordedHz: number;
  blurb?: string;
};

// General MIDI instrument loaded via soundfont-player. The instrument name
// matches the package's catalogue (snake_case), e.g. "acoustic_grand_piano".
// Samples are served from gleitz/midi-js-soundfonts on GitHub Pages — first
// load of an instrument fetches ~88 small mp3s, then cached in-memory.
type GMSource = {
  kind: "gm";
  id: string;       // duplicate of `name` for selectedId stability
  label: string;
  name: string;     // soundfont instrument name
  family: GMFamily;
  blurb?: string;
};

type SoundSource = SynthSource | SampleSource | GMSource;

// ── GM family grouping ─────────────────────────────────────────────────
// Standard GM-spec groupings, used for the picker's <optgroup> headers so
// the user can scan 128+ instruments. Family assignment matches the GM 1
// program-change layout.

type GMFamily =
  | "Piano" | "Chromatic Percussion" | "Organ" | "Guitar" | "Bass" | "Strings"
  | "Ensemble" | "Brass" | "Reed" | "Pipe" | "Synth Lead" | "Synth Pad"
  | "Synth Effects" | "Ethnic" | "Percussive" | "Sound Effects";

// Hand-mapped from the soundfont-player catalogue (129 entries) to GM family.
// Where the package has variants outside the strict GM set (acoustic_bass,
// honkytonk_piano, etc.) they're placed by timbre. Picker order = this order.
const GM_INSTRUMENTS: readonly { name: string; family: GMFamily; label?: string }[] = [
  // Piano
  { name: "acoustic_grand_piano", family: "Piano", label: "acoustic grand piano" },
  { name: "bright_acoustic_piano", family: "Piano", label: "bright acoustic piano" },
  { name: "electric_grand_piano", family: "Piano", label: "electric grand piano" },
  { name: "honkytonk_piano", family: "Piano", label: "honkytonk piano" },
  { name: "electric_piano_1", family: "Piano", label: "electric piano 1" },
  { name: "electric_piano_2", family: "Piano", label: "electric piano 2" },
  { name: "harpsichord", family: "Piano" },
  { name: "clavinet", family: "Piano" },
  // Chromatic Percussion
  { name: "celesta", family: "Chromatic Percussion" },
  { name: "glockenspiel", family: "Chromatic Percussion" },
  { name: "music_box", family: "Chromatic Percussion", label: "music box" },
  { name: "vibraphone", family: "Chromatic Percussion" },
  { name: "marimba", family: "Chromatic Percussion" },
  { name: "xylophone", family: "Chromatic Percussion" },
  { name: "tubular_bells", family: "Chromatic Percussion", label: "tubular bells" },
  { name: "dulcimer", family: "Chromatic Percussion" },
  // Organ
  { name: "drawbar_organ", family: "Organ", label: "drawbar organ" },
  { name: "percussive_organ", family: "Organ", label: "percussive organ" },
  { name: "rock_organ", family: "Organ", label: "rock organ" },
  { name: "church_organ", family: "Organ", label: "church organ" },
  { name: "reed_organ", family: "Organ", label: "reed organ" },
  { name: "accordion", family: "Organ" },
  { name: "harmonica", family: "Organ" },
  { name: "tango_accordion", family: "Organ", label: "tango accordion" },
  // Guitar
  { name: "acoustic_guitar_nylon", family: "Guitar", label: "acoustic guitar (nylon)" },
  { name: "acoustic_guitar_steel", family: "Guitar", label: "acoustic guitar (steel)" },
  { name: "electric_guitar_jazz", family: "Guitar", label: "electric guitar (jazz)" },
  { name: "electric_guitar_clean", family: "Guitar", label: "electric guitar (clean)" },
  { name: "electric_guitar_muted", family: "Guitar", label: "electric guitar (muted)" },
  { name: "overdriven_guitar", family: "Guitar", label: "overdriven guitar" },
  { name: "distortion_guitar", family: "Guitar", label: "distortion guitar" },
  { name: "guitar_harmonics", family: "Guitar", label: "guitar harmonics" },
  // Bass
  { name: "acoustic_bass", family: "Bass", label: "acoustic bass" },
  { name: "electric_bass_finger", family: "Bass", label: "electric bass (finger)" },
  { name: "electric_bass_pick", family: "Bass", label: "electric bass (pick)" },
  { name: "fretless_bass", family: "Bass", label: "fretless bass" },
  { name: "slap_bass_1", family: "Bass", label: "slap bass 1" },
  { name: "slap_bass_2", family: "Bass", label: "slap bass 2" },
  { name: "synth_bass_1", family: "Bass", label: "synth bass 1" },
  { name: "synth_bass_2", family: "Bass", label: "synth bass 2" },
  // Strings
  { name: "violin", family: "Strings" },
  { name: "viola", family: "Strings" },
  { name: "cello", family: "Strings" },
  { name: "contrabass", family: "Strings" },
  { name: "tremolo_strings", family: "Strings", label: "tremolo strings" },
  { name: "pizzicato_strings", family: "Strings", label: "pizzicato strings" },
  { name: "orchestral_harp", family: "Strings", label: "orchestral harp" },
  { name: "timpani", family: "Strings" },
  // Ensemble
  { name: "string_ensemble_1", family: "Ensemble", label: "string ensemble 1" },
  { name: "string_ensemble_2", family: "Ensemble", label: "string ensemble 2" },
  { name: "synth_strings_1", family: "Ensemble", label: "synth strings 1" },
  { name: "synth_strings_2", family: "Ensemble", label: "synth strings 2" },
  { name: "choir_aahs", family: "Ensemble", label: "choir aahs" },
  { name: "voice_oohs", family: "Ensemble", label: "voice oohs" },
  { name: "synth_choir", family: "Ensemble", label: "synth choir" },
  { name: "orchestra_hit", family: "Ensemble", label: "orchestra hit" },
  // Brass
  { name: "trumpet", family: "Brass" },
  { name: "trombone", family: "Brass" },
  { name: "tuba", family: "Brass" },
  { name: "muted_trumpet", family: "Brass", label: "muted trumpet" },
  { name: "french_horn", family: "Brass", label: "french horn" },
  { name: "brass_section", family: "Brass", label: "brass section" },
  { name: "synth_brass_1", family: "Brass", label: "synth brass 1" },
  { name: "synth_brass_2", family: "Brass", label: "synth brass 2" },
  // Reed
  { name: "soprano_sax", family: "Reed", label: "soprano sax" },
  { name: "alto_sax", family: "Reed", label: "alto sax" },
  { name: "tenor_sax", family: "Reed", label: "tenor sax" },
  { name: "baritone_sax", family: "Reed", label: "baritone sax" },
  { name: "oboe", family: "Reed" },
  { name: "english_horn", family: "Reed", label: "english horn" },
  { name: "bassoon", family: "Reed" },
  { name: "clarinet", family: "Reed" },
  // Pipe
  { name: "piccolo", family: "Pipe" },
  { name: "flute", family: "Pipe" },
  { name: "recorder", family: "Pipe" },
  { name: "pan_flute", family: "Pipe", label: "pan flute" },
  { name: "blown_bottle", family: "Pipe", label: "blown bottle" },
  { name: "shakuhachi", family: "Pipe" },
  { name: "whistle", family: "Pipe" },
  { name: "ocarina", family: "Pipe" },
  // Synth Lead
  { name: "lead_1_square", family: "Synth Lead", label: "lead 1 (square)" },
  { name: "lead_2_sawtooth", family: "Synth Lead", label: "lead 2 (sawtooth)" },
  { name: "lead_3_calliope", family: "Synth Lead", label: "lead 3 (calliope)" },
  { name: "lead_4_chiff", family: "Synth Lead", label: "lead 4 (chiff)" },
  { name: "lead_5_charang", family: "Synth Lead", label: "lead 5 (charang)" },
  { name: "lead_6_voice", family: "Synth Lead", label: "lead 6 (voice)" },
  { name: "lead_7_fifths", family: "Synth Lead", label: "lead 7 (fifths)" },
  { name: "lead_8_bass__lead", family: "Synth Lead", label: "lead 8 (bass + lead)" },
  // Synth Pad
  { name: "pad_1_new_age", family: "Synth Pad", label: "pad 1 (new age)" },
  { name: "pad_2_warm", family: "Synth Pad", label: "pad 2 (warm)" },
  { name: "pad_3_polysynth", family: "Synth Pad", label: "pad 3 (polysynth)" },
  { name: "pad_4_choir", family: "Synth Pad", label: "pad 4 (choir)" },
  { name: "pad_5_bowed", family: "Synth Pad", label: "pad 5 (bowed)" },
  { name: "pad_6_metallic", family: "Synth Pad", label: "pad 6 (metallic)" },
  { name: "pad_7_halo", family: "Synth Pad", label: "pad 7 (halo)" },
  { name: "pad_8_sweep", family: "Synth Pad", label: "pad 8 (sweep)" },
  // Synth Effects
  { name: "fx_1_rain", family: "Synth Effects", label: "fx 1 (rain)" },
  { name: "fx_2_soundtrack", family: "Synth Effects", label: "fx 2 (soundtrack)" },
  { name: "fx_3_crystal", family: "Synth Effects", label: "fx 3 (crystal)" },
  { name: "fx_4_atmosphere", family: "Synth Effects", label: "fx 4 (atmosphere)" },
  { name: "fx_5_brightness", family: "Synth Effects", label: "fx 5 (brightness)" },
  { name: "fx_6_goblins", family: "Synth Effects", label: "fx 6 (goblins)" },
  { name: "fx_7_echoes", family: "Synth Effects", label: "fx 7 (echoes)" },
  { name: "fx_8_scifi", family: "Synth Effects", label: "fx 8 (sci-fi)" },
  // Ethnic
  { name: "sitar", family: "Ethnic" },
  { name: "banjo", family: "Ethnic" },
  { name: "shamisen", family: "Ethnic" },
  { name: "koto", family: "Ethnic" },
  { name: "kalimba", family: "Ethnic" },
  { name: "bagpipe", family: "Ethnic" },
  { name: "fiddle", family: "Ethnic" },
  { name: "shanai", family: "Ethnic" },
  // Percussive
  { name: "tinkle_bell", family: "Percussive", label: "tinkle bell" },
  { name: "agogo", family: "Percussive" },
  { name: "steel_drums", family: "Percussive", label: "steel drums" },
  { name: "woodblock", family: "Percussive" },
  { name: "taiko_drum", family: "Percussive", label: "taiko drum" },
  { name: "melodic_tom", family: "Percussive", label: "melodic tom" },
  { name: "synth_drum", family: "Percussive", label: "synth drum" },
  { name: "reverse_cymbal", family: "Percussive", label: "reverse cymbal" },
  // Sound Effects
  { name: "guitar_fret_noise", family: "Sound Effects", label: "guitar fret noise" },
  { name: "breath_noise", family: "Sound Effects", label: "breath noise" },
  { name: "seashore", family: "Sound Effects" },
  { name: "bird_tweet", family: "Sound Effects", label: "bird tweet" },
  { name: "telephone_ring", family: "Sound Effects", label: "telephone ring" },
  { name: "helicopter", family: "Sound Effects" },
  { name: "applause", family: "Sound Effects" },
  { name: "gunshot", family: "Sound Effects" },
];

const GM_SOURCES: readonly GMSource[] = GM_INSTRUMENTS.map((i) => ({
  kind: "gm",
  id: `gm:${i.name}`,
  label: i.label ?? i.name.replace(/_/g, " "),
  name: i.name,
  family: i.family,
}));

const GM_FAMILY_ORDER: GMFamily[] = [
  "Piano", "Chromatic Percussion", "Organ", "Guitar", "Bass", "Strings",
  "Ensemble", "Brass", "Reed", "Pipe", "Synth Lead", "Synth Pad",
  "Synth Effects", "Ethnic", "Percussive", "Sound Effects",
];

// Hand-curated. Synth sounds first (most musical → least musical at the
// bottom). Loop sounds (thrust/reverseThrust/sideThrust) are intentionally
// omitted — they need explicit stop calls and don't fit a "press a key" model.
const SOURCES: readonly SoundSource[] = [
  // Bell-family — clearly pitched, long decay, great for melodic auditioning.
  { kind: "synth", id: "bell", label: "bell", sound: "bell", pitched: true, blurb: "Inharmonic bell partials (220 Hz root)." },
  { kind: "synth", id: "chime", label: "chime", sound: "chime", pitched: true, blurb: "Bright triangle chime (C6 root)." },
  { kind: "synth", id: "tink", label: "tink", sound: "tink", pitched: true, blurb: "Glassy two-partial crystal hit." },

  // Bass voices — all accept pitchRatio.
  { kind: "synth", id: "bassKick", label: "bass · kick", sound: "bassKick", pitched: true, blurb: "Pitched sine kick with sweep." },
  { kind: "synth", id: "bassPluck", label: "bass · pluck", sound: "bassPluck", pitched: true, blurb: "Filtered saw pluck." },
  { kind: "synth", id: "bassBoom", label: "bass · boom", sound: "bassBoom", pitched: true, blurb: "Sub-heavy boom with octave-down tail." },
  { kind: "synth", id: "bassSnap", label: "bass · snap", sound: "bassSnap", pitched: true, blurb: "Snap with filtered noise + body sweep." },

  // Melodic comet — accepts integer step index; we round before sending.
  { kind: "synth", id: "cometNote", label: "comet note", sound: "cometNote", pitched: true, blurb: "Pentatonic comet voice (rounded to integer)." },

  // Score blip + crystal shards — pitched but transient.
  { kind: "synth", id: "scoreBlip", label: "score blip", sound: "scoreBlip", pitched: true },
  { kind: "synth", id: "crystalSmall", label: "crystal · small", sound: "crystalShatterSmall", pitched: true },
  { kind: "synth", id: "crystalLarge", label: "crystal · large", sound: "crystalShatterLarge", pitched: true },

  // Background pulsar beat — accepts pitchRatio, used for big sub thumps.
  { kind: "synth", id: "bgBeat", label: "pulsar bgBeat", sound: "bgBeat", pitched: true },

  // The bullet sounds & explosions don't take pitchRatio meaningfully, but
  // they're part of the "repertoire" so the user can still trigger them.
  { kind: "synth", id: "fireBeat", label: "on-beat bullet (fireBeat)", sound: "fireBeat", pitched: false },
  { kind: "synth", id: "fire", label: "off-beat bullet (fire)", sound: "fire", pitched: false },
  { kind: "synth", id: "explosionSmall", label: "explosion · small", sound: "explosionSmall", pitched: false },
  { kind: "synth", id: "explosionMedium", label: "explosion · medium", sound: "explosionMedium", pitched: false },
  { kind: "synth", id: "explosionLarge", label: "explosion · large", sound: "explosionLarge", pitched: false },
  { kind: "synth", id: "powerup", label: "powerup", sound: "powerup", pitched: false },
  { kind: "synth", id: "shieldPop", label: "shield pop", sound: "shieldPop", pitched: false },
  { kind: "synth", id: "warble", label: "warble", sound: "warble", pitched: false },
  { kind: "synth", id: "comboTick", label: "combo tick", sound: "comboTick", pitched: false },
  { kind: "synth", id: "comboSparkle", label: "combo sparkle", sound: "comboSparkle", pitched: false },
  { kind: "synth", id: "shockwaveCharge", label: "shockwave charge", sound: "shockwaveCharge", pitched: false },
  { kind: "synth", id: "shockwaveBoom", label: "shockwave boom", sound: "shockwaveBoom", pitched: false },
  { kind: "synth", id: "canisterAppear", label: "canister appear", sound: "canisterAppear", pitched: false },
  { kind: "synth", id: "waveClear", label: "wave clear", sound: "waveClear", pitched: false },
  { kind: "synth", id: "pulsarHum", label: "pulsar hum", sound: "pulsarHum", pitched: false },

  // Sample libraries — raw WAVs decoded into AudioBuffers and played via
  // playbackRate. recordedHz lets us anchor the root key to a specific note.
  { kind: "sample", id: "guitar-jazz", label: "guitar · jazz (A3)", url: "/sounds/guitar/big-alien-jazz.wav", recordedHz: 220, blurb: "FreePats jazz electric guitar, recorded at A3 (220 Hz)." },
  { kind: "sample", id: "guitar-gretsch", label: "guitar · gretsch (A3)", url: "/sounds/guitar/big-alien-gretsch.wav", recordedHz: 220, blurb: "Karoryfer Gretsch hollowbody, recorded at A3 (220 Hz)." },
  { kind: "sample", id: "guitar-classic", label: "guitar · big-alien (A3)", url: "/sounds/guitar/big-alien.wav", recordedHz: 220, blurb: "Original big-alien guitar sample." },
];

// All available sources, in picker order: project synths/samples first, then
// GM instruments. Used both for the dropdown render and selectedId lookup.
const ALL_SOURCES: readonly SoundSource[] = [...SOURCES, ...GM_SOURCES];

// ── piano layout ───────────────────────────────────────────────────────

// Note name + MIDI-style octave, plus a semitone offset from MIDI 60 (C4).
type Note = { name: string; octave: number; midi: number; isBlack: boolean; whiteIndex: number };

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const BLACK_SET = new Set(["C#", "D#", "F#", "G#", "A#"]);

// Build notes from C3 to C5 inclusive (25 keys, 2 octaves + 1).
// Includes a few extra below + above so the keyboard feels musical.
const buildKeyboard = (startMidi: number, endMidi: number): Note[] => {
  const out: Note[] = [];
  let whiteIdx = 0;
  for (let m = startMidi; m <= endMidi; m++) {
    const pc = PITCH_CLASSES[m % 12];
    const octave = Math.floor(m / 12) - 1;
    const isBlack = BLACK_SET.has(pc);
    out.push({ name: pc, octave, midi: m, isBlack, whiteIndex: isBlack ? -1 : whiteIdx });
    if (!isBlack) whiteIdx++;
  }
  return out;
};

// C3 (48) .. C5 (72) — 2 full octaves.
const KEYBOARD = buildKeyboard(48, 72);
const WHITE_KEY_COUNT = KEYBOARD.filter((n) => !n.isBlack).length;

// Computer keyboard → MIDI offset from root. Two rows: home row = white keys
// from root upward; top row = black keys interleaved (standard web-piano
// mapping). Plus 'z' shifts the root down an octave, '/' shifts up.
const KEYBOARD_MAP: Record<string, number> = {
  // White keys (root + 12 semitones, two-octave span on home row)
  a: 0, s: 2, d: 4, f: 5, g: 7, h: 9, j: 11, k: 12, l: 14, ";": 16, "'": 17,
  // Black keys (sharp/flat row above)
  w: 1, e: 3, t: 6, y: 8, u: 10, o: 13, p: 15,
};

// ── helpers ────────────────────────────────────────────────────────────

const semitonesToRatio = (st: number) => Math.pow(2, st / 12);
const noteLabel = (n: Note) => `${n.name}${n.octave}`;

// Shared Sound instance — same pattern as SoundEditor.tsx so the WebAudio
// context is created once and stays warm across re-renders. Exported so the
// Beat Sync section in MusicMixer can drive the REAL in-game full-halo path
// (startHaloFullMusic) on the same warm context instead of a parallel player.
export const sound = new Sound();

// Sample-buffer cache, populated lazily on first play of each sample source.
const sampleBuffers = new Map<string, AudioBuffer>();
const sampleLoading = new Map<string, Promise<AudioBuffer | null>>();

const loadSample = async (url: string): Promise<AudioBuffer | null> => {
  const cached = sampleBuffers.get(url);
  if (cached) return cached;
  const inflight = sampleLoading.get(url);
  if (inflight) return inflight;
  sound.ensureContext();
  const ctx = sound.ctx;
  if (!ctx) return null;
  const p = (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ab = await r.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      sampleBuffers.set(url, buf);
      return buf;
    } catch {
      return null;
    } finally {
      sampleLoading.delete(url);
    }
  })();
  sampleLoading.set(url, p);
  return p;
};

const playSample = async (src: SampleSource, semitones: number, gain: number) => {
  const buf = await loadSample(src.url);
  if (!buf || !sound.ctx || !sound.master) return;
  const ctx = sound.ctx;
  if (ctx.state === "suspended") await ctx.resume();
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.playbackRate.value = semitonesToRatio(semitones);
  const g = ctx.createGain();
  g.gain.value = gain;
  node.connect(g);
  g.connect(sound.master);
  node.start();
};

// GM-instrument cache. Loads on first use; subsequent plays reuse the same
// SfPlayer (which internally caches all its per-note buffers).
const gmInstruments = new Map<string, SfPlayer>();
const gmLoading = new Map<string, Promise<SfPlayer | null>>();

const loadGM = async (name: string): Promise<SfPlayer | null> => {
  const cached = gmInstruments.get(name);
  if (cached) return cached;
  const inflight = gmLoading.get(name);
  if (inflight) return inflight;
  sound.ensureContext();
  const ctx = sound.ctx;
  const master = sound.master;
  if (!ctx || !master) return null;
  const p = (async () => {
    try {
      const inst = await Sf.instrument(ctx, name, { soundfont: "MusyngKite", format: "mp3" });
      // Route the instrument through the project master so it picks up the
      // same compression/limiting/master-gain chain as the rest of the page.
      inst.connect(master);
      gmInstruments.set(name, inst);
      return inst;
    } catch {
      return null;
    } finally {
      gmLoading.delete(name);
    }
  })();
  gmLoading.set(name, p);
  return p;
};

// MIDI 60 → "C4". Used to convert a MIDI note number to the note name the
// soundfont-player expects ("C4", "C#4", etc.).
const midiToNoteName = (midi: number): string => {
  const pc = PITCH_CLASSES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${pc}${octave}`;
};

const playGM = async (src: GMSource, midi: number, gain: number) => {
  const inst = await loadGM(src.name);
  if (!inst) return;
  if (sound.ctx?.state === "suspended") await sound.ctx.resume();
  inst.play(midiToNoteName(midi), 0, { gain });
};

// ── component ──────────────────────────────────────────────────────────

export const PianoKeyboard = () => {
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(SOURCES[0].id);
  // The "root" MIDI note that plays the sound at pitchRatio 1.0 (synth) or
  // recordedHz (sample). Defaults to C4 (60) — middle C.
  const [rootMidi, setRootMidi] = useState(60);
  const [gain, setGain] = useState(0.8);
  // Visual feedback: which key is currently held down.
  const [activeMidi, setActiveMidi] = useState<Set<number>>(() => new Set());

  const selectedSource = useMemo(
    () => ALL_SOURCES.find((s) => s.id === selectedId) ?? ALL_SOURCES[0],
    [selectedId],
  );

  // Async GM-load tracking, so the UI can show "loading instrument" while a
  // newly-picked GM instrument's per-note samples are still being fetched.
  const [gmLoadState, setGmLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  useEffect(() => {
    if (selectedSource.kind !== "gm") {
      setGmLoadState("idle");
      return;
    }
    if (gmInstruments.has(selectedSource.name)) {
      setGmLoadState("ready");
      return;
    }
    let cancelled = false;
    setGmLoadState("loading");
    loadGM(selectedSource.name).then((inst) => {
      if (cancelled) return;
      setGmLoadState(inst ? "ready" : "error");
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSource]);

  // Load the global sound config once so cfgU() works for the synth voices.
  // Mirrors SoundEditor.tsx's init.
  useEffect(() => {
    let cancelled = false;
    loadSoundConfig().then(() => {
      if (cancelled) return;
      sound.bgBeatIntensity = 0.5;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const playMidi = useCallback(
    (midi: number) => {
      const semitones = midi - rootMidi;
      sound.ensureContext();
      if (sound.ctx?.state === "suspended") void sound.ctx.resume();
      const src = selectedSource;
      if (src.kind === "synth") {
        const ratio = src.pitched ? semitonesToRatio(semitones) : 1;
        sound.play(src.sound, ratio);
      } else if (src.kind === "sample") {
        void playSample(src, semitones, gain);
      } else {
        // GM instruments have per-note samples — pass the absolute MIDI note
        // through and ignore the root-shift, so a C4 button always plays C4.
        void playGM(src, midi, gain);
      }
      setActiveMidi((prev) => {
        const next = new Set(prev);
        next.add(midi);
        return next;
      });
      // Release the visual highlight after a short hold — sounds are
      // one-shot so there's no "key up" event to clear it from.
      window.setTimeout(() => {
        setActiveMidi((prev) => {
          if (!prev.has(midi)) return prev;
          const next = new Set(prev);
          next.delete(midi);
          return next;
        });
      }, 220);
    },
    [rootMidi, selectedSource, gain],
  );

  // Computer-keyboard input. Ignore auto-repeat so holding a key doesn't
  // machine-gun the synth.
  useEffect(() => {
    const downKeys = new Set<string>();
    const onDown = (ev: KeyboardEvent) => {
      if (ev.repeat) return;
      // Don't hijack typing in inputs (e.g. the root-note number field).
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const k = ev.key.toLowerCase();
      if (k === "z") { setRootMidi((m) => Math.max(24, m - 12)); return; }
      if (k === "/") { setRootMidi((m) => Math.min(96, m + 12)); return; }
      const offset = KEYBOARD_MAP[k];
      if (offset === undefined) return;
      if (downKeys.has(k)) return;
      downKeys.add(k);
      playMidi(rootMidi + offset);
    };
    const onUp = (ev: KeyboardEvent) => {
      downKeys.delete(ev.key.toLowerCase());
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [playMidi, rootMidi]);

  // ── render ────────────────────────────────────────────────────────────

  // Render: a wide row of white keys with black keys overlaid at calculated
  // x offsets. Each white key claims an equal-width slot; black keys sit
  // between adjacent whites (skipping the E-F and B-C gaps).
  const whiteWidthPct = 100 / WHITE_KEY_COUNT;
  const blackWidthPct = whiteWidthPct * 0.6;

  // Map computer keyboard keys back to MIDI for badge rendering on each key.
  const midiToKbd = useMemo(() => {
    const m = new Map<number, string>();
    for (const [k, off] of Object.entries(KEYBOARD_MAP)) {
      m.set(rootMidi + off, k === ";" ? ";" : k === "'" ? "'" : k.toUpperCase());
    }
    return m;
  }, [rootMidi]);

  return (
    <section className="rounded-lg border border-[rgba(106,215,255,0.22)] bg-[rgba(106,215,255,0.04)] p-4 shadow-[0_0_24px_rgba(106,215,255,0.06)_inset]">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[0.14em] text-[#b8ecff]">
            piano keyboard
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[#9bb5d6]">
            Pick a sound, then click keys or type{" "}
            <code className="rounded bg-[rgba(106,215,255,0.1)] px-1 text-[#d6ecff]">a s d f g h j k l ; &apos;</code>{" "}
            (white) and{" "}
            <code className="rounded bg-[rgba(106,215,255,0.1)] px-1 text-[#d6ecff]">w e t y u o p</code>{" "}
            (black). <code className="rounded bg-[rgba(106,215,255,0.1)] px-1 text-[#d6ecff]">z</code>/
            <code className="rounded bg-[rgba(106,215,255,0.1)] px-1 text-[#d6ecff]">/</code> shifts the root note one octave.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-[10px] uppercase tracking-[0.18em] ${ready ? "text-[#7bd58e]" : "text-[#ffd49b]"}`}>
            {ready ? "ready" : "loading config"}
          </span>
          {selectedSource.kind === "gm" && (
            <span
              className={
                "text-[10px] uppercase tracking-[0.18em] " +
                (gmLoadState === "ready"
                  ? "text-[#7bd58e]"
                  : gmLoadState === "loading"
                    ? "text-[#ffd49b]"
                    : gmLoadState === "error"
                      ? "text-[#ff9b9b]"
                      : "text-[#5a7593]")
              }
            >
              instrument · {gmLoadState}
            </span>
          )}
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-[#9bb5d6]">
          sound
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded border border-[rgba(106,215,255,0.3)] bg-[rgba(8,12,20,0.8)] px-2 py-1 text-[12px] tracking-normal text-[#d6ecff]"
          >
            <optgroup label="Pulsar — synth voices">
              {SOURCES.filter((s) => s.kind === "synth").map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.kind === "synth" && !s.pitched ? " (unpitched)" : ""}
                </option>
              ))}
            </optgroup>
            <optgroup label="Pulsar — sample libraries">
              {SOURCES.filter((s) => s.kind === "sample").map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </optgroup>
            {GM_FAMILY_ORDER.map((family) => (
              <optgroup key={family} label={`GM · ${family}`}>
                {GM_SOURCES.filter((s) => s.family === family).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-[#9bb5d6]">
          root
          <select
            value={rootMidi}
            onChange={(e) => setRootMidi(parseInt(e.target.value, 10))}
            className="rounded border border-[rgba(106,215,255,0.3)] bg-[rgba(8,12,20,0.8)] px-2 py-1 text-[12px] tracking-normal text-[#d6ecff]"
          >
            {Array.from({ length: 5 }, (_, i) => {
              const m = 36 + i * 12;
              return (
                <option key={m} value={m}>
                  C{Math.floor(m / 12) - 1} ({m})
                </option>
              );
            })}
          </select>
        </label>

        <label className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-[#9bb5d6]">
          sample gain
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={gain}
            onChange={(e) => setGain(parseFloat(e.target.value))}
            className="w-32 accent-[#6ad7ff]"
          />
          <span className="w-10 text-right text-[#d6ecff] tabular-nums">{gain.toFixed(2)}</span>
        </label>
      </div>

      {selectedSource.kind === "gm" ? (
        <p className="mb-3 text-[11px] italic leading-relaxed text-[#7d9bbd]">
          GM · {selectedSource.family} · MusyngKite soundfont (per-note samples
          fetched from gleitz/midi-js-soundfonts on first use; root note is
          ignored — buttons play their literal note).
        </p>
      ) : (
        selectedSource.blurb && (
          <p className="mb-3 text-[11px] italic leading-relaxed text-[#7d9bbd]">{selectedSource.blurb}</p>
        )
      )}

      {/* Keyboard */}
      <div className="relative h-44 w-full select-none">
        {/* White keys */}
        <div className="absolute inset-0 flex">
          {KEYBOARD.filter((n) => !n.isBlack).map((n) => {
            const isActive = activeMidi.has(n.midi);
            const isRoot = n.midi === rootMidi;
            const kbd = midiToKbd.get(n.midi);
            return (
              <button
                key={n.midi}
                type="button"
                onMouseDown={() => playMidi(n.midi)}
                style={{ width: `${whiteWidthPct}%` }}
                className={
                  "relative flex h-full flex-col items-center justify-end gap-1 border-r border-[rgba(0,0,0,0.5)] pb-2 pt-1 transition-colors " +
                  (isActive
                    ? "bg-[#6ad7ff] text-[#04060a]"
                    : isRoot
                      ? "bg-[#cfe4f5] text-[#04060a] hover:bg-[#e2eef9]"
                      : "bg-[#f4f6f9] text-[#3a4a5f] hover:bg-[#e2eef9]")
                }
              >
                {kbd && (
                  <span className="rounded border border-[rgba(0,0,0,0.2)] bg-[rgba(255,255,255,0.6)] px-1 text-[9px] uppercase tracking-[0.1em] text-[#3a4a5f]">
                    {kbd}
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-[0.12em] opacity-70">
                  {noteLabel(n)}
                </span>
              </button>
            );
          })}
        </div>
        {/* Black keys, overlaid */}
        <div className="pointer-events-none absolute inset-0">
          {KEYBOARD.map((n, idx) => {
            if (!n.isBlack) return null;
            // Position: centered on the boundary between this key's previous
            // white and the next white. The previous white's whiteIndex is
            // (whites-seen-before-this-black) - 1, so left edge of the black
            // key sits at (prevWhiteIdx + 1) * whiteWidthPct - blackWidth/2.
            const whitesBefore = KEYBOARD.slice(0, idx).filter((k) => !k.isBlack).length;
            const left = whitesBefore * whiteWidthPct - blackWidthPct / 2;
            const isActive = activeMidi.has(n.midi);
            const isRoot = n.midi === rootMidi;
            const kbd = midiToKbd.get(n.midi);
            return (
              <button
                key={n.midi}
                type="button"
                onMouseDown={() => playMidi(n.midi)}
                style={{ left: `${left}%`, width: `${blackWidthPct}%`, height: "62%" }}
                className={
                  "pointer-events-auto absolute top-0 flex flex-col items-center justify-end gap-1 rounded-b border border-[rgba(0,0,0,0.8)] pb-1 pt-1 transition-colors " +
                  (isActive
                    ? "bg-[#6ad7ff] text-[#04060a]"
                    : isRoot
                      ? "bg-[#2a3a52] text-[#cfe4f5] hover:bg-[#3a4a62]"
                      : "bg-[#0a0f18] text-[#9bb5d6] hover:bg-[#1a2230]")
                }
              >
                {kbd && (
                  <span className="rounded border border-[rgba(255,255,255,0.2)] bg-[rgba(0,0,0,0.4)] px-1 text-[9px] uppercase tracking-[0.1em]">
                    {kbd}
                  </span>
                )}
                <span className="text-[9px] uppercase tracking-[0.1em] opacity-70">
                  {n.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};
