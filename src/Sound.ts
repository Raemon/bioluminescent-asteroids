import * as Tone from "tone";
import { cfgN, cfgU } from "./soundConfig";

// Tone.js master bus. Every voice — both Tone-native synths (bassKick,
// chimeSynth, etc.) and the hand-built WebAudio voices (playFire,
// playExplosion, etc.) — feeds into this chain: dry → toneMaster, wet →
// reverbSend → chorus → reverb → toneMaster, then toneMaster → compressor
// → limiter → destination. Hand-built voices connect via Sound.master,
// which routes into voiceBusDry/Wet.
type ToneEngineNodes = {
  toneMaster: Tone.Gain;
  reverbSend: Tone.Gain;
  reverb: Tone.Reverb;
  chorus: Tone.Chorus;
  compressor: Tone.Compressor;
  limiter: Tone.Limiter;
  // Input nodes for the hand-built WebAudio voices. Sound.master connects
  // into both: dry for presence, wet for shared reverb tail polish.
  voiceBusDry: Tone.Gain;
  voiceBusWet: Tone.Gain;
  cometMelodySynth: Tone.PolySynth;
  cometShimmerByKey: Map<object, ToneCometShimmer>;
  // Per-voice synths for the highest-impact sounds — the ones the player
  // hears most often or that most differentiate "polished" from "raw
  // oscillators". Lower-traffic sounds still use the hand-built WebAudio
  // code, routed through the same master bus.
  bgBeatKick: Tone.MembraneSynth;
  bassKick: Tone.MembraneSynth;
  bassBoom: Tone.MembraneSynth;
  bassPluck: Tone.MonoSynth;
  bassSnap: Tone.MetalSynth;
  fireBeatBody: Tone.MembraneSynth;
  fireBeatPluck: Tone.PluckSynth;
  chimeSynth: Tone.PolySynth;
  powerupSynth: Tone.PolySynth;
  waveClearSynth: Tone.PolySynth;
};

type ToneCometShimmer = {
  synth: Tone.PolySynth;
  chord: string[];
  fadeGain: Tone.Gain;
  lfos: Tone.LFO[];
};

// Per-alien drone voice. Two detuned sines through a slow-sweeping lowpass,
// modulated by an LFO on amplitude for the theremin pulse. Held open for the
// lifetime of an alien; torn down on death or mute.
type AlienDroneNode = {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  pulseLfo: OscillatorNode;
  vibratoLfo: OscillatorNode;
  vibratoDepth: GainNode;
  filter: BiquadFilterNode;
  pulseGain: GainNode;
  mainGain: GainNode;
  spatial?: SpatialNodes;
};

// Per-bassteroid ambient drone. Opened when a large bassteroid breaks open
// into mediums (and again when mediums break into smalls), held for the
// lifetime of that piece. Each (kind, size) pairs to one of 8 voices in a
// C-major bed — see startBassteroidDrone for the assignment.
type BassDroneNode = {
  oscs: OscillatorNode[];
  lfos: OscillatorNode[];
  noise?: AudioBufferSourceNode;
  mainGain: GainNode;
  spatial?: SpatialNodes;
};

// Per-comet shimmer pad. Underlies the comet melody for the entire lifetime
// of one comet — a soft chord wash that thickens whenever a comet is on
// screen. Set up once at spawn, torn down on despawn.
type CometShimmerNode = {
  oscs: OscillatorNode[];
  lfos: OscillatorNode[];
  mainGain: GainNode;
  spatial?: SpatialNodes;
};

// Ambient pad that holds for the duration of a yellow-halo combo (≥4) and
// thickens further at white-bullet tier (≥8). Voices C2/C3/G3 are common to
// both the bassteroid C-major bed and the comet's C-rooted phrygian cluster,
// so they layer pleasantly with both. The "third voice" frequency glides
// between E4 (major third, bright with bass field) and Eb4 (minor third,
// neutral with the comet's b2/tritone dissonance) — controlled by
// setHaloAmbientCometMode. On top sits a slow, looping melody voice playing
// a "determined" 8-step motif drawn entirely from mode-invariant pitches
// (C, D, F, G), so the figure stays musical regardless of the wave's mode
// without fighting the comet's b2/tritone cluster.
type HaloAmbientNode = {
  oscs: OscillatorNode[];
  lfos: OscillatorNode[];
  mainGain: GainNode;
  thirdOsc: OscillatorNode;
  // tier1 (yellow halo only): C+G open fifth foundation + E/Eb third voice.
  // tier2 (white bullets): extra octave-up voice swells in for a brighter top.
  tier2Gain: GainNode;
  // Slow melodic voice — a single oscillator whose frequency + gain envelope
  // are re-scheduled once per step by a JS-side interval. Interval handle is
  // stored so stopHaloAmbient can clear it.
  melodyOsc: OscillatorNode;
  melodyGain: GainNode;
  melodyInterval: ReturnType<typeof setInterval> | null;
};

// Pre-rendered music variations for the 4x/6x combo halo. Each variation has
// two looping stems — ambient (4x trigger) and melodic (6x trigger) — that
// share key, tempo (120 BPM), and 8-second loop length so they mix cleanly.
// The user picks one at HALO_MUSIC_VARIATION; "none" falls back to the legacy
// synthesized startHaloAmbient pad.
export type HaloMusicVariation =
  | "r2-el"   // ElevenLabs 32-second C-pedal cinematic bed + sustained-tone piano
  | "r2-sb"   // Self-built 32-second C-pedal procedural pad + held-tone felt piano
  | "r3-el"   // ElevenLabs 32-second C-pedal analog-synthwave: Juno-style pad + soft lead + layer 3
  | "r4-sb"   // Self-built 32-second C-pedal flagship — pulsing arp + smooth calliope melody + layer 3 (rhythmic, interlocked)
  | "none";   // Legacy synthesized pad (the original startHaloAmbient)

type HaloMusicNode = {
  // Three looping AudioBufferSourceNodes — ambient runs whenever music is
  // active; melodic + layer3 run continuously but their gains are ducked to
  // 0 until their respective tiers are requested (melodic at combo ≥ 6,
  // layer3 at combo ≥ 12). Starting a layer only when its tier first hits
  // would risk a phase-misalignment with the ambient loop, so we keep all
  // three always-playing-but-silent for sample-accurate phase lock.
  ambientSrc: AudioBufferSourceNode;
  melodicSrc: AudioBufferSourceNode;
  // Layer-3 stem may be missing (file deleted / never generated for this
  // variation); ambient + melodic still play normally in that case.
  layer3Src: AudioBufferSourceNode | null;
  ambientGain: GainNode;
  melodicGain: GainNode;
  layer3Gain: GainNode | null;
  mainGain: GainNode;
  // Variation that's currently loaded — preserved so a 6x→4x→6x tier flick
  // doesn't trigger a reload.
  variation: HaloMusicVariation;
  // Whether the melodic layer is currently ducked-up (combo ≥ 6) or down.
  melodicActive: boolean;
  // Whether layer 3 is currently ducked-up (combo ≥ 12) or down.
  layer3Active: boolean;
};

// Optional pan + distance-falloff splice. When a sound (one-shot or drone)
// is positional, its voices feed into spatial.in; spatial.out connects to the
// usual master/bakedOut sink. The Game updates pan/gain values per frame for
// drones via setSpatial.
type SpatialNodes = {
  panner: StereoPannerNode;
  distGain: GainNode;
};

export type Pos = { x: number; y: number };

export type SoundName =
  | "fire"
  | "fireBeat"
  | "explosionLarge"
  | "explosionMedium"
  | "explosionSmall"
  | "asteroidBoomBeat"
  | "thrust"
  | "reverseThrust"
  | "sideThrust"
  | "death"
  | "waveClear"
  | "bassKick"
  | "bassPluck"
  | "bassBoom"
  | "bassSnap"
  | "bassHit"
  | "bassEcho"
  | "chime"
  | "bell"
  | "warble"
  | "comboTick"
  | "comboSparkle"
  | "tink"
  | "scoreBlip"
  | "summaryDownbeat"
  | "powerup"
  | "shieldPop"
  | "pulsarHum"
  | "bgBeat"
  | "shockwaveCharge"
  | "shockwaveBoom"
  | "alienFireBig"
  | "alienFireMedium"
  | "alienFireSmall"
  | "alienHit"
  | "alienExplode"
  | "cometNote"
  | "cometDestroyed"
  | "cometDestroyedSad"
  | "canisterAppear"
  | "canisterDestroyed"
  | "comboLost";

// Combo-milestone vocal pools. Each milestone (x6, x12) has its own folder
// under /sounds/vocals/in-use/. When the player hits the milestone, one file
// is picked at random from that folder. Adding a new take = drop the mp3 in
// the folder and add its filename here. Picking randomly per fire keeps the
// captain's voice from feeling canned across replays.
const PILOT_LOG_POOLS: Readonly<Record<number, readonly string[]>> = {
  6: ["ralf-deep.mp3"],
  12: ["lullaby.mp3"],
};

// Resolve the URLs for a given combo milestone. Everything lives under
// /sounds/vocals/in-use/<milestone>x/ — that folder is the canonical source
// of truth for what plays in-game. Audition material stays elsewhere.
const pilotLogUrlsForIndex = (milestone: number): string[] => {
  const pool = PILOT_LOG_POOLS[milestone] ?? [];
  return pool.map((f) => `/sounds/vocals/in-use/${milestone}x/${f}`);
};

export class Sound {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  thrustNode: {
    tri1: OscillatorNode;
    tri2: OscillatorNode;
    sub: OscillatorNode;
    lfo: OscillatorNode;
    lfoDepth: GainNode;
    filter: BiquadFilterNode;
    tremoloGain: GainNode;
    mainGain: GainNode;
  } | null = null;
  reverseThrustNode: {
    tri1: OscillatorNode;
    tri2: OscillatorNode;
    sub: OscillatorNode;
    lfo: OscillatorNode;
    lfoDepth: GainNode;
    filter: BiquadFilterNode;
    tremoloGain: GainNode;
    mainGain: GainNode;
  } | null = null;
  // Side engines (Z/X) — third engine voice; pitch sits between forward thrust
  // and retro so the player hears it as a distinct vector.
  sideThrustNode: {
    tri1: OscillatorNode;
    tri2: OscillatorNode;
    sub: OscillatorNode;
    lfo: OscillatorNode;
    lfoDepth: GainNode;
    filter: BiquadFilterNode;
    tremoloGain: GainNode;
    mainGain: GainNode;
  } | null = null;
  enabled = true;
  // Master volume multiplier. 1.0 = original baseline (master/bakedOut gains
  // at 0.6); 2.0 = double, the slider's default max. 0 disables playback via
  // `enabled` so per-voice early-outs still kick in.
  volume = 2;
  // Bumped up from 0.6 so the default (volume=2 → 1.2 effective) lands well
  // above the old all-the-way-up calibration; the slider lets players pull
  // back if it's too hot on their setup.
  private static readonly MASTER_BASE_GAIN = 1.0;
  private static readonly BAKED_BASE_GAIN = 1.0;
  // Wave-scaled intensity (0..1) for the background pulsar-approach beat.
  // 0 = silent, 1 = full ominous rumble at wave 30. Set by Game each wave;
  // read by playBgBeat when each beat fires.
  bgBeatIntensity = 0;
  // Per-alien continuous theremin drone. Keyed by the Alien instance so the
  // Game side can start/stop without us needing an ID scheme.
  alienDrones: Map<object, AlienDroneNode> = new Map();
  // Per-bassteroid ambient drone, keyed by the Asteroid instance. Only
  // populated for medium/small bass pieces (a large piece is "sealed" — it
  // hasn't been broken open yet).
  bassDrones: Map<object, BassDroneNode> = new Map();
  // Per-comet shimmer pad, keyed by the Comet instance.
  cometShimmers: Map<object, CometShimmerNode> = new Map();
  // Single combo-halo ambient pad. Null when combo < 4 (no yellow halo yet).
  // Tier rides with the halo: 1 = yellow only, 2 = white bullets (combo ≥ 8).
  haloAmbient: HaloAmbientNode | null = null;
  haloAmbientTier = 0;
  // True while any comet is on screen — slides the pad's "third voice" from
  // major-third E4 (bright over the C-major bass bed) down to minor-third
  // Eb4, which is consonant with the comet's phrygian dissonance instead of
  // fighting it.
  haloAmbientCometMode = false;
  // Active pre-rendered halo music node — null when no music is playing
  // (i.e. combo < 4 or the legacy synthesized pad is selected).
  haloMusic: HaloMusicNode | null = null;
  // Per-stem buffer cache, keyed by URL. AudioBuffers are decoded once and
  // reused across all start/stop cycles for a given variation.
  haloMusicBuffers: Map<string, AudioBuffer> = new Map();
  private haloMusicLoading: Map<string, Promise<AudioBuffer | null>> = new Map();
  toneEngine: ToneEngineNodes | null = null;

  // Pilot's Log vocal one-shots. Decoded once on first play, cached forever.
  // Voiced (ElevenLabs) + post-processed to scratchy astronaut-radio character;
  // mixed dry to bakedOut so the comp/limiter/reverb master chain doesn't
  // smear the spoken word. pilotLogPlaying is a soft mutex so a repeated
  // trigger doesn't stack a second voice on top of the first.
  //
  // Cache is keyed by URL (not just index) because index 1 (combo-x6 unlock)
  // picks a random take from a pool each fire — see PILOT_LOG_1_TAKES.
  pilotLogBuffers: Map<string, AudioBuffer> = new Map();
  pilotLogPlaying = false;
  private pilotLogLoading: Map<string, Promise<AudioBuffer | null>> = new Map();

  // Listener position (ship). Pan + distance falloff are computed relative
  // to this. Half-width/half-height scale the screen so pan saturates at the
  // edges; updated by the game on resize. Listener defaults to screen center
  // so positional sounds before the first setListener() still pan sensibly.
  listenerX = 0;
  listenerY = 0;
  halfW = 1;
  halfH = 1;
  // Subtle spatial profile: pan saturates at ~60% of full L/R, and volume
  // drops to ~50% by the screen edge.
  private static readonly PAN_MAX = 0.6;
  private static readonly DIST_MIN_GAIN = 0.5;

  // Tell the audio bus where the listener (ship) is and how big the screen is.
  // Called once per frame from the game loop.
  setListener(x: number, y: number, w: number, h: number) {
    this.listenerX = x;
    this.listenerY = y;
    this.halfW = Math.max(1, w * 0.5);
    this.halfH = Math.max(1, h * 0.5);
  }

  // Compute pan + falloff gain from a world position relative to the listener.
  // Pan is the x-offset normalized to [-PAN_MAX, +PAN_MAX]; gain falls off
  // smoothly with euclidean distance, clamped to DIST_MIN_GAIN at the edge.
  private spatialFor(pos: Pos): { pan: number; gain: number } {
    const dx = (pos.x - this.listenerX) / this.halfW;
    const dy = (pos.y - this.listenerY) / this.halfH;
    const pan = Math.max(-1, Math.min(1, dx)) * Sound.PAN_MAX;
    const d = Math.min(1, Math.hypot(dx, dy));
    const gain = 1 - (1 - Sound.DIST_MIN_GAIN) * d;
    return { pan, gain };
  }

  // Build a pan+gain splice node connected to `sink`. Voices in the caller
  // connect into `panner` (or `distGain` — equivalent, both are upstream).
  private makeSpatial(pos: Pos, sink: AudioNode): SpatialNodes | null {
    if (!this.ctx) return null;
    const { pan, gain } = this.spatialFor(pos);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    const distGain = this.ctx.createGain();
    distGain.gain.value = gain;
    panner.connect(distGain);
    distGain.connect(sink);
    return { panner, distGain };
  }

  // Update an existing spatial splice (used per-frame for drones as the
  // underlying entity moves around the screen).
  private updateSpatial(s: SpatialNodes, pos: Pos) {
    if (!this.ctx) return;
    const { pan, gain } = this.spatialFor(pos);
    const t = this.ctx.currentTime;
    // setTargetAtTime smooths the change over a short time constant so we
    // don't hear zipper noise when an entity moves quickly.
    s.panner.pan.setTargetAtTime(pan, t, 0.05);
    s.distGain.gain.setTargetAtTime(gain, t, 0.05);
  }

  ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = Sound.MASTER_BASE_GAIN * this.volume;
    // Direct-to-destination bus for pre-baked buffers (whose tail already
    // contains the full Tone master chain). Mirrors the master gain level so
    // baked and live voices sit at a comparable loudness.
    this.bakedOut = this.ctx.createGain();
    this.bakedOut.gain.value = Sound.BAKED_BASE_GAIN * this.volume;
    this.bakedOut.connect(this.ctx.destination);
    // Build the Tone bus immediately so master is hot before the first
    // voice plays. ensureToneEngine wires master → voiceBusDry/Wet.
    this.ensureToneEngine();
    // Pre-fill the noise-buffer cache so the first bassteroid/comet spawn
    // doesn't pay the 6-8s buffer allocation mid-gameplay. AudioBuffers can't
    // be created before the context exists, so this is the earliest we can do
    // it — runs once, on first user interaction.
    this.prewarmNoiseBuffers();
  }

  // Every duration ever passed to makeNoiseBuffer across the codebase. Grep
  // for `makeNoiseBuffer(` if you add a new caller with a fresh duration —
  // missing entries still work (lazy alloc on first call), they just pay
  // the spawn-time stutter you're avoiding here.
  private prewarmNoiseBuffers() {
    const durations = [0.018, 0.025, 0.08, 0.18, 0.3, 0.4, 3, 4, 6, 8];
    for (const d of durations) this.makeNoiseBuffer(d);
  }

  // Lazy-build the Tone.js master bus and shared synths. Shares our existing
  // AudioContext via Tone.setContext so a single ctx drives both engines
  // (browsers cap how many AudioContexts you can have open).
  ensureToneEngine(): ToneEngineNodes | null {
    if (this.toneEngine) return this.toneEngine;
    this.ensureContext();
    if (!this.ctx) return null;

    // Adopt our existing AudioContext. Tone wraps it; Tone destination ===
    // ctx.destination so we can either route through Tone or stay on the
    // raw WebAudio path within the same session.
    Tone.setContext(this.ctx as unknown as BaseAudioContext as never);

    // Master chain: dry + wet fx, summed → compressor → limiter → out.
    // Compressor glues transients together; limiter is a brick-wall safety
    // net so layered hits never clip even when many sources fire at once.
    const toneMaster = new Tone.Gain(0.7);
    const compressor = new Tone.Compressor({
      threshold: -18,
      ratio: 3,
      attack: 0.01,
      release: 0.18,
      knee: 12,
    });
    const limiter = new Tone.Limiter(-1);
    toneMaster.connect(compressor);
    compressor.connect(limiter);
    limiter.toDestination();

    // Shared fx send. Voices either connect dry to toneMaster or wet via
    // reverbSend → chorus → reverb → toneMaster. Decay shortened from 3.5s to
    // 1.5s — convolution cost scales linearly with decay length, and 1.5s
    // still gives comet bells a clear tail without the smear on rhythmic
    // bass-grid hits. Wet level controlled at reverbSend so the reverb itself
    // doesn't convolve the full signal at unity.
    const reverbSend = new Tone.Gain(0.5);
    const chorus = new Tone.Chorus({
      frequency: 0.6,
      delayTime: 3.5,
      depth: 0.6,
      type: "sine",
      spread: 180,
      wet: 0.5,
    }).start();
    const reverb = new Tone.Reverb({ decay: 1.5, preDelay: 0.02, wet: 1 });
    reverbSend.connect(chorus);
    chorus.connect(reverb);
    reverb.connect(toneMaster);

    // Hand-built voice bus inputs. Sound.master (the WebAudio GainNode every
    // hand-built voice writes into) connects to both: dry sums straight into
    // toneMaster for presence; wet sends to the fx bus. The wet level is
    // intentionally subtle (~25%) so the percussion family (bass kit, bg-beat)
    // doesn't get washed out in reverb. Comet voices already have a heavier
    // wet send via their own dedicated Tone synth path.
    const voiceBusDry = new Tone.Gain(0.95);
    const voiceBusWet = new Tone.Gain(0.25);
    voiceBusDry.connect(toneMaster);
    voiceBusWet.connect(reverbSend);

    // Comet melody voice: FM synth tuned for an unsettling, hollow timbre.
    // Inharmonic harmonicity (2.41 ≈ a sour just-out-of-tune interval) plus
    // a sawtooth modulator give every note a slight metallic warble that
    // reads as "not quite right" against the bass kit's clean tonal bed.
    // Slow attack and long release let notes overlap into a fog rather than
    // landing as discrete bells.
    const cometMelodySynth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 2.41,
      modulationIndex: 11,
      oscillator: { type: "sine" },
      modulation: { type: "sawtooth" },
      envelope: { attack: 0.05, decay: 0.6, sustain: 0.35, release: 3.4 },
      modulationEnvelope: { attack: 0.04, decay: 0.5, sustain: 0.1, release: 2.0 },
      volume: -12,
    });
    // Dry path (small amount, for presence) and wet (lush tail).
    const cometDry = new Tone.Gain(0.35);
    const cometWet = new Tone.Gain(0.9);
    cometMelodySynth.connect(cometDry);
    cometMelodySynth.connect(cometWet);
    cometDry.connect(toneMaster);
    cometWet.connect(reverbSend);

    // Helper to wire a synth (or chain end) into the bus with a dry/wet split.
    // Returns the synth so chained `.set(...)` style calls still work upstream.
    const wireToBus = <T extends Tone.ToneAudioNode>(node: T, dry = 1.0, wet = 0.18): T => {
      const dryG = new Tone.Gain(dry);
      const wetG = new Tone.Gain(wet);
      node.connect(dryG);
      node.connect(wetG);
      dryG.connect(toneMaster);
      wetG.connect(reverbSend);
      return node;
    };

    // Background pulsar-approach beat. Tone's MembraneSynth is purpose-built
    // for kick-style hits — pitched body that sweeps down, with adjustable
    // decay and "octaves" (sweep range) we tune for the bgBeat's signature
    // deep heartbeat character.
    const bgBeatKick = wireToBus(new Tone.MembraneSynth({
      pitchDecay: 0.06,
      octaves: 6,
      oscillator: { type: "sine" },
      envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.5 },
      volume: -6,
    }), 1, 0.1);

    // Bassteroid kick on C2 — same MembraneSynth shape, slightly faster pitch
    // decay so the body reads as percussive rather than melodic.
    const bassKick = wireToBus(new Tone.MembraneSynth({
      pitchDecay: 0.04,
      octaves: 4,
      oscillator: { type: "sine" },
      envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.3 },
      volume: -4,
    }));

    // Bassteroid boom (F2/IV chord tone). Longer pitch tail and a touch more
    // sustain than the kick so the boom sits deeper in the mix.
    const bassBoom = wireToBus(new Tone.MembraneSynth({
      pitchDecay: 0.08,
      octaves: 5,
      oscillator: { type: "sine" },
      envelope: { attack: 0.002, decay: 0.42, sustain: 0, release: 0.4 },
      volume: -4,
    }));

    // Bassteroid pluck (G2 sub-bass with closing filter). MonoSynth gives us a
    // proper voice with built-in lowpass that the envelope can sweep.
    const bassPluck = wireToBus(new Tone.MonoSynth({
      oscillator: { type: "sawtooth" },
      filter: { type: "lowpass", Q: 6, rolloff: -24 },
      envelope: { attack: 0.005, decay: 0.18, sustain: 0, release: 0.25 },
      filterEnvelope: { attack: 0.005, decay: 0.18, sustain: 0.1, release: 0.3, baseFrequency: 90, octaves: 3 },
      volume: -8,
    }));

    // Bassteroid snap — metal synth for the percussive bandpassed snap timbre.
    const bassSnap = wireToBus(new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.12, release: 0.15 },
      harmonicity: 5.1,
      modulationIndex: 16,
      resonance: 1700,
      octaves: 0.7,
      volume: -16,
    }), 1, 0.25);

    // Rhythm-shot pluck. Two voices: a MembraneSynth body for the C3 thump
    // and a PluckSynth for the bright pluck-noise character at attack.
    const fireBeatBody = wireToBus(new Tone.MembraneSynth({
      pitchDecay: 0.04,
      octaves: 3,
      oscillator: { type: "sine" },
      envelope: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.25 },
      volume: -8,
    }));
    const fireBeatPluck = wireToBus(new Tone.PluckSynth({
      attackNoise: 0.9,
      dampening: 3200,
      resonance: 0.7,
      volume: -16,
    }), 1, 0.25);

    // Chime (bright sparkle) — PolySynth around FMSynth gives a bell-like
    // partials with controlled inharmonicity.
    const chimeSynth = wireToBus(new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.5,
      modulationIndex: 8,
      oscillator: { type: "sine" },
      envelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.9 },
      modulationEnvelope: { attack: 0.005, decay: 0.3, sustain: 0, release: 0.6 },
      volume: -12,
    }), 0.6, 0.7);

    // Powerup arpeggio — sine PolySynth with bright attack, heavy reverb
    // since this is a celebratory cue and shouldn't sit dry.
    const powerupSynth = wireToBus(new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.45 },
      volume: -10,
    }), 0.5, 0.7);

    // Wave-clear chord — sine pad PolySynth, also heavily wet for celebration.
    const waveClearSynth = wireToBus(new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 0.02, decay: 0.3, sustain: 0.2, release: 0.7 },
      volume: -10,
    }), 0.5, 0.7);

    this.toneEngine = {
      toneMaster,
      reverbSend,
      reverb,
      chorus,
      compressor,
      limiter,
      voiceBusDry,
      voiceBusWet,
      cometMelodySynth,
      cometShimmerByKey: new Map(),
      bgBeatKick,
      bassKick,
      bassBoom,
      bassPluck,
      bassSnap,
      fireBeatBody,
      fireBeatPluck,
      chimeSynth,
      powerupSynth,
      waveClearSynth,
    };
    this.wireMasterToBus();
    // Warm the baked-buffer cache immediately so the first in-game trigger
    // hits the cache instead of paying for live synthesis. Bakes run async
    // in parallel; total wall time is dominated by the longest single recipe
    // (waveClear/chime ~50ms on desktop). Sounds that fire before their bake
    // lands still fall back to live Tone synthesis transparently.
    this.warmBakedCache();
    return this.toneEngine;
  }

  // Kick off offline-render for every recipe (and every quantized pitch
  // variant) we know about. Fire-and-forget; results land in bakedBuffers as
  // each promise resolves. Safe to call repeatedly — playBaked's in-flight
  // guard de-dupes.
  private warmBakedCache() {
    // bgBeat is the first sound the player hears every run — and unlike all
    // other voices, its playBgBeat path *requires* a baked buffer (the live
    // Tone fallback was removed because its scheduler lookahead made the
    // first few beats drift before the cache caught up). Bake the early-wave
    // downbeat buckets before anything else so the first downbeats at game
    // start aren't dropped silently.
    for (let bucket = 0; bucket <= 2; bucket++) {
      const intensityBucket = bucket / 10;
      this.queueBake("bgBeat", 1 * 100 + intensityBucket);
    }
    // Per-sound list of pitch ratios to pre-bake. Mirrors the values Game
    // passes at runtime: bassteroid split levels use BASS_SPLIT_PITCH_RATIO
    // ([1, 1, 0.8409]); bgBeat uses 1 or 1.122 (offbeats), composited with
    // an intensity bucket (0..1 in 0.1 steps → ~11 buckets).
    const standardPitches = [1, 0.8409];
    const oneShots: Array<[SoundName, number[]]> = [
      ["fireBeat", [1]],
      ["chime", [1]],
      ["powerup", [1]],
      ["waveClear", [1]],
      ["bassKick", standardPitches],
      ["bassBoom", standardPitches],
      ["bassPluck", standardPitches],
      ["bassSnap", standardPitches],
    ];
    for (const [name, pitches] of oneShots) {
      for (const p of pitches) {
        this.queueBake(name, p);
      }
    }
    // Remaining bgBeat variants: full 11-bucket sweep × {downbeat, offbeat} ×
    // {main, light-eighth}. The early downbeat buckets above already queued
    // — queueBake dedupes, so re-listing them here is a no-op.
    for (const basePitch of [1, 1.122]) {
      for (let bucket = 0; bucket <= 10; bucket++) {
        const intensityBucket = bucket / 10;
        this.queueBake("bgBeat", basePitch * 100 + intensityBucket);
        this.queueBake("bgBeat", basePitch * 100 + intensityBucket + 1000);
      }
    }
  }

  // Trigger a bake for one (sound, pitchKey) pair if it isn't cached or in
  // flight. Two-tier flow: first try fetching a pre-baked MP3 from
  // public/sounds/baked/ (no Tone.js work — runs in parallel across calls);
  // only if that 404s do we fall through to the live Tone bake. The live
  // bakes are still serialized via bakeChain because Tone.setContext is
  // global, but in practice (with the MP3s committed) we never hit that
  // path in prod and only hit it on first dev play after a synth-recipe
  // edit. In dev the rendered buffer is POSTed back to /__bake-dump__ so
  // the next reload is fully fetch-only.
  private queueBake(name: SoundName, pitchRatio: number) {
    const key = this.bakedKey(name, pitchRatio);
    if (this.bakedBuffers.has(key) || this.bakingInFlight.has(key)) return;
    this.bakingInFlight.add(key);
    void this.fetchBakedMp3(name, pitchRatio).then((fetched) => {
      if (fetched) {
        this.bakedBuffers.set(key, fetched);
        this.bakingInFlight.delete(key);
        return;
      }
      // Fall through to live Tone bake (serialized).
      this.bakeChain = this.bakeChain.then(() => this.bakeSound(name, pitchRatio).then((rendered) => {
        if (rendered) {
          this.bakedBuffers.set(key, rendered);
          void this.dumpBakedToDev(name, pitchRatio, rendered);
        }
        this.bakingInFlight.delete(key);
      }).catch(() => { this.bakingInFlight.delete(key); }));
    }).catch(() => { this.bakingInFlight.delete(key); });
  }

  // Wire Sound.master into the Tone bus. Master sums every hand-built
  // WebAudio voice; it taps into voiceBusDry for presence and voiceBusWet
  // for the shared reverb tail. The Tone chain ends at ctx.destination via
  // the limiter.
  private wireMasterToBus() {
    if (!this.ctx || !this.master || !this.toneEngine) return;
    this.master.disconnect();
    this.master.connect(this.toneEngine.voiceBusDry.input as AudioNode);
    this.master.connect(this.toneEngine.voiceBusWet.input as AudioNode);
  }

  // ── Pre-rendered Tone one-shots ─────────────────────────────────────────
  // The biggest perf cost of the Tone engine is per-trigger voice allocation
  // inside PolySynth/MembraneSynth/etc. plus the live convolution reverb.
  // For one-shot sounds (kick, fire, chime, etc.) the synth recipe is fixed,
  // so we render it once into an AudioBuffer via OfflineAudioContext and just
  // play that buffer on every subsequent trigger. The reverb/chorus tail is
  // baked into the buffer, so even the wet path costs nothing at runtime.
  //
  // Cache keyed by `${name}|${quantizedPitchRatio}` — pitch ratios from Game
  // are a tiny finite set (1, 0.8409, 1.122 for bassteroids; 1 for everything
  // else), so the cache stays small.
  bakedBuffers: Map<string, AudioBuffer> = new Map();
  // Sounds we're currently baking — guards against double-bake when the same
  // sound fires several times before the first bake completes.
  bakingInFlight: Set<string> = new Set();
  // Serialized bake queue. bakeSound swaps Tone's global context to the
  // OfflineAudioContext for the duration of the render, so running two
  // bakes concurrently would race on Tone.setContext. We chain promises
  // here so each bake completes (and restores Tone's context) before the
  // next starts.
  bakeChain: Promise<unknown> = Promise.resolve();
  // Dedicated GainNode for baked-buffer playback. Baked buffers already
  // contain the full Tone bus chain (compressor+chorus+reverb+limiter), so
  // they bypass this.master (which is itself routed through the Tone bus in
  // tone mode) and go straight to destination via this gain — otherwise the
  // bus chain would be applied twice.
  bakedOut: GainNode | null = null;
  // Set by play() while a single dispatch is in progress, so playBaked can
  // pick up the position without per-helper plumbing. Null when the call has
  // no spatial position.
  private spatialPosForCall: Pos | null = null;

  private bakedKey(name: SoundName, pitchRatio: number): string {
    // Quantize to 4 decimals so floating-point noise doesn't fragment the cache.
    return `${name}|${pitchRatio.toFixed(4)}`;
  }

  // Filename-safe form of bakedKey for disk storage. `|` would force a URL
  // escape on every fetch and trips the dev plugin's path-safety regex, so we
  // swap it for `__`. The 4-decimal quantization stays, dots are file-safe.
  private bakedFileSlug(name: SoundName, pitchRatio: number): string {
    return `${name}__${pitchRatio.toFixed(4)}`;
  }

  private bakedFileUrl(name: SoundName, pitchRatio: number): string {
    return `/sounds/baked/${this.bakedFileSlug(name, pitchRatio)}.mp3`;
  }

  // Encode an AudioBuffer as a 16-bit PCM WAV in a single Uint8Array. Used to
  // ship a freshly-rendered bake to the dev plugin for ffmpeg → MP3 conversion.
  // Stereo interleaved; sample rate from the buffer.
  private encodeWav(buf: AudioBuffer): Uint8Array {
    const numCh = buf.numberOfChannels;
    const sr = buf.sampleRate;
    const frames = buf.length;
    const dataBytes = frames * numCh * 2;
    const out = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(out);
    const writeStr = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);            // PCM chunk size
    view.setUint16(20, 1, true);             // PCM format
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * 2, true);
    view.setUint16(32, numCh * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataBytes, true);
    const channels: Float32Array[] = [];
    for (let c = 0; c < numCh; c++) channels.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Uint8Array(out);
  }

  // Fetch a pre-baked MP3 from public/sounds/baked/. Returns the decoded
  // AudioBuffer on hit, null on 404 (so queueBake can fall through to a live
  // Tone bake — which in dev also POSTs the result back for next time).
  private async fetchBakedMp3(name: SoundName, pitchRatio: number): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      const r = await fetch(this.bakedFileUrl(name, pitchRatio));
      if (!r.ok) return null;
      const ab = await r.arrayBuffer();
      return await this.ctx.decodeAudioData(ab);
    } catch {
      return null;
    }
  }

  // Dev-only: POST a freshly-rendered bake to the Vite plugin so it lands in
  // public/sounds/baked/ as MP3. The plugin no-ops if the file already exists,
  // so this is safe to call on every bake.
  private async dumpBakedToDev(name: SoundName, pitchRatio: number, buf: AudioBuffer): Promise<void> {
    if (!import.meta.env.DEV) return;
    try {
      const wav = this.encodeWav(buf);
      await fetch(`/__bake-dump__?key=${encodeURIComponent(this.bakedFileSlug(name, pitchRatio))}`, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }),
      });
    } catch {
      // dev convenience only; never block playback on a dump failure.
    }
  }

  // Play a pre-rendered buffer through the live master bus. Returns true if
  // a baked buffer was found and played; false if the caller should fall
  // back to live synthesis (typically while the first bake is still running).
  private playBaked(name: SoundName, pitchRatio: number): boolean {
    if (!this.ctx || !this.bakedOut) return false;
    const key = this.bakedKey(name, pitchRatio);
    const buf = this.bakedBuffers.get(key);
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      // Positional splice: if play() recorded a pos for this dispatch, route
      // the buffer through the same pan + distance-gain pair we'd use for
      // live voices. Baked buffers don't go through this.master, so we wire
      // them straight into bakedOut.
      const pos = this.spatialPosForCall;
      if (pos) {
        const spatial = this.makeSpatial(pos, this.bakedOut);
        if (spatial) src.connect(spatial.panner);
        else src.connect(this.bakedOut);
      } else {
        src.connect(this.bakedOut);
      }
      src.start();
      return true;
    }
    // Kick off async bake; subsequent calls will hit the cache.
    this.queueBake(name, pitchRatio);
    return false;
  }

  // Render a single Tone-engine sound recipe into an AudioBuffer. We build
  // the same synth chain (incl. the fx bus + reverb tail) inside an
  // OfflineAudioContext, trigger the voice at t=0, and let it render its
  // full natural decay. Duration is chosen per-sound to fit the longest
  // envelope+release+reverb tail.
  private async bakeSound(name: SoundName, pitchRatio: number): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    const sr = this.ctx.sampleRate;
    // Total duration to render. Longer than the dry note so the reverb tail
    // (1.5s decay in the bus) lands inside the buffer.
    const durations: Partial<Record<SoundName, number>> = {
      fireBeat: 1.0,
      bgBeat: 1.2,
      bassKick: 1.2,
      bassBoom: 1.4,
      bassPluck: 1.2,
      bassSnap: 0.9,
      chime: 2.0,
      powerup: 1.6,
      waveClear: 2.4,
    };
    const dur = durations[name] ?? 1.5;
    const length = Math.ceil(sr * dur);
    const OAC = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!OAC) return null;
    const offline = new OAC(2, length, sr);

    // Mirror the live tone-engine fx bus into the offline context. This is
    // a stripped-down copy of ensureToneEngine — same chain (compressor +
    // limiter + chorus + reverb) so the baked tail matches the live mix.
    Tone.setContext(offline as unknown as BaseAudioContext as never);
    const toneMaster = new Tone.Gain(0.7);
    const compressor = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.01, release: 0.18, knee: 12 });
    const limiter = new Tone.Limiter(-1);
    toneMaster.connect(compressor);
    compressor.connect(limiter);
    limiter.toDestination();
    const reverbSend = new Tone.Gain(0.5);
    const chorus = new Tone.Chorus({ frequency: 0.6, delayTime: 3.5, depth: 0.6, type: "sine", spread: 180, wet: 0.5 }).start();
    const reverb = new Tone.Reverb({ decay: 1.5, preDelay: 0.02, wet: 1 });
    reverbSend.connect(chorus);
    chorus.connect(reverb);
    reverb.connect(toneMaster);
    // Pre-generate the reverb IR — required before rendering.
    await reverb.generate();

    const wire = <T extends Tone.ToneAudioNode>(node: T, dry: number, wet: number): T => {
      const d = new Tone.Gain(dry); const w = new Tone.Gain(wet);
      node.connect(d); node.connect(w);
      d.connect(toneMaster); w.connect(reverbSend);
      return node;
    };

    // Per-sound recipe: build synth, trigger at offline time 0.
    switch (name) {
      case "fireBeat": {
        const body = wire(new Tone.MembraneSynth({ pitchDecay: 0.03, octaves: 3, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.2 }, volume: -6 }), 1, 0.12);
        const pluck = wire(new Tone.PluckSynth({ attackNoise: 0.5, dampening: 4000, resonance: 0.7 }), 0.9, 0.25);
        body.triggerAttackRelease("C3", "16n", 0, 0.9);
        pluck.triggerAttack("G4", 0.001);
        break;
      }
      case "bgBeat": {
        // The composite key is `actualPitch * 100 + intensityBucket`, with a
        // +1000 offset added when this is a doubletime "light eighth" variant
        // (see playBgBeatLight). Decode:
        const isLight = pitchRatio >= 500;
        const baseKey = isLight ? pitchRatio - 1000 : pitchRatio;
        const intensity = baseKey - Math.floor(baseKey);
        const actualPitch = Math.floor(baseKey) / 100;
        const kick = wire(new Tone.MembraneSynth({ pitchDecay: 0.06, octaves: 6, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.5 }, volume: -6 }), 1, 0.1);
        const isOffbeat = actualPitch !== 1;
        const offbeatMul = isOffbeat ? 0.35 + intensity * 0.45 : 1;
        const lightMul = isLight ? 0.42 : 1;
        const levelMul = (0.35 + 0.65 * intensity) * offbeatMul * lightMul;
        const velocity = (0.25 + intensity * 0.75) * levelMul;
        // Light eighths are pitched a semitone up so they sit between the
        // main quarter-note pitches: C2 → C#2, D2 → D#2.
        const note = isLight
          ? (actualPitch === 1 ? "C#2" : "D#2")
          : (actualPitch === 1 ? "C2" : "D2");
        kick.triggerAttackRelease(note, "8n", 0, velocity);
        break;
      }
      case "bassKick": {
        const kick = wire(new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 4, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.3 }, volume: -4 }), 1, 0.18);
        kick.triggerAttackRelease(65.4 * pitchRatio, "16n", 0, 0.95);
        break;
      }
      case "bassBoom": {
        const boom = wire(new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 5, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.45, sustain: 0.05, release: 0.4 }, volume: -3 }), 1, 0.18);
        boom.triggerAttackRelease(87.3 * pitchRatio, "8n", 0, 0.9);
        break;
      }
      case "bassPluck": {
        const pluck = wire(new Tone.MonoSynth({ oscillator: { type: "sawtooth" }, filter: { Q: 6, type: "lowpass", rolloff: -24 }, envelope: { attack: 0.005, decay: 0.18, sustain: 0, release: 0.25 }, filterEnvelope: { attack: 0.005, decay: 0.18, sustain: 0.1, release: 0.3, baseFrequency: 90, octaves: 3 }, volume: -8 }), 1, 0.18);
        pluck.triggerAttackRelease(98 * pitchRatio, "8n", 0, 0.85);
        break;
      }
      case "bassSnap": {
        const snap = wire(new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.1 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5, volume: -16 }), 1, 0.18);
        snap.triggerAttackRelease("C3", "16n", 0, 0.7);
        break;
      }
      case "chime": {
        const chime = wire(new Tone.PolySynth(Tone.FMSynth, { harmonicity: 3.5, modulationIndex: 8, oscillator: { type: "sine" }, envelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.9 }, modulationEnvelope: { attack: 0.005, decay: 0.3, sustain: 0, release: 0.6 }, volume: -12 }), 0.6, 0.7);
        chime.triggerAttackRelease(["C6", "G6"], "8n", 0, 0.65);
        break;
      }
      case "powerup": {
        const synth = wire(new Tone.PolySynth(Tone.Synth, { oscillator: { type: "sine" }, envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.45 }, volume: -10 }), 0.5, 0.7);
        const notes = ["C5", "E5", "G5", "C6"];
        for (let i = 0; i < notes.length; i++) synth.triggerAttackRelease(notes[i], "16n", i * 0.06, 0.7);
        break;
      }
      case "waveClear": {
        const synth = wire(new Tone.PolySynth(Tone.Synth, { oscillator: { type: "sine" }, envelope: { attack: 0.02, decay: 0.3, sustain: 0.2, release: 0.7 }, volume: -10 }), 0.5, 0.7);
        const notes = ["E4", "G#4", "B4", "Eb5"];
        for (let i = 0; i < notes.length; i++) synth.triggerAttackRelease(notes[i], "4n", i * 0.06, 0.7);
        break;
      }
      default:
        // Restore live context before bailing.
        Tone.setContext(this.ctx as unknown as BaseAudioContext as never);
        return null;
    }

    try {
      const rendered = await offline.startRendering();
      return rendered;
    } finally {
      // Always swap Tone back to the live AudioContext, even if rendering throws.
      Tone.setContext(this.ctx as unknown as BaseAudioContext as never);
    }
  }

  // Render one voice recipe into an AudioBuffer for the sound editor's
  // page-load pre-render. Routes play(name) through an OfflineAudioContext
  // by temporarily swapping this.ctx / this.master, then restoring.
  //
  // The hand-built voice methods read this.ctx/this.master directly, so the
  // swap transparently redirects every createOscillator/createBuffer/connect
  // to the offline graph. The 10 Tone-native voices (fireBeat, bgBeat, bass*,
  // chime, powerup, waveClear, cometNote) won't render meaningfully via this
  // path — they need Tone.setContext to be pointed at the offline context,
  // which the editor doesn't currently do; pre-render falls back to silent
  // buffers for those. (The runtime baked-buffer pipeline still serves the
  // game's actual playback.)
  async renderOfflineVoice(
    name: SoundName,
    pitchRatio: number,
    durationSec: number,
    sampleRate: number,
  ): Promise<AudioBuffer | null> {
    const OAC = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!OAC) return null;
    const length = Math.max(1, Math.ceil(durationSec * sampleRate));
    const offline = new OAC(1, length, sampleRate);

    const savedCtx = this.ctx;
    const savedMaster = this.master;
    const savedEnabled = this.enabled;
    const savedThrust = this.thrustNode;
    const savedReverseThrust = this.reverseThrustNode;
    const savedSideThrust = this.sideThrustNode;

    // Build a fresh master node + compressor inside the offline graph that
    // mirrors the live tone chain (master → compressor → destination), so
    // the rendered buffer sounds like what the player hears.
    const offlineMaster = offline.createGain();
    offlineMaster.gain.value = 0.6;
    const offlineComp = offline.createDynamicsCompressor();
    offlineComp.threshold.value = -12;
    offlineComp.knee.value = 12;
    offlineComp.ratio.value = 4;
    offlineComp.attack.value = 0.005;
    offlineComp.release.value = 0.15;
    offlineMaster.connect(offlineComp);
    offlineComp.connect(offline.destination);

    this.ctx = offline as unknown as AudioContext;
    this.master = offlineMaster;
    this.enabled = true;
    // Detach any live thrust node so play("thrust") starts cleanly on the
    // offline ctx. We restore the live one in `finally`.
    this.thrustNode = null;
    this.reverseThrustNode = null;
    this.sideThrustNode = null;

    try {
      this.play(name, pitchRatio);
      const rendered = await offline.startRendering();
      return rendered;
    } catch (e) {
      console.warn(`renderOfflineVoice(${name}) failed`, e);
      return null;
    } finally {
      this.ctx = savedCtx;
      this.master = savedMaster;
      this.enabled = savedEnabled;
      this.thrustNode = savedThrust;
      this.reverseThrustNode = savedReverseThrust;
      this.sideThrustNode = savedSideThrust;
    }
  }

  resume() {
    this.ensureContext();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  // First-user-gesture entry point. Browsers gate AudioContext creation +
  // resume on a user gesture; main.tsx wires this to keydown/pointerdown so
  // the heavy bake work overlaps with the title screen rather than the first
  // few seconds of gameplay. Returns a promise that resolves when every
  // currently-queued bake (including the bgBeat sweep in warmBakedCache) is
  // done — startGame awaits it so the first beats land on cached buffers.
  // Idempotent: repeated calls return the same promise.
  private warmPromise: Promise<void> | null = null;
  warmAudio(): Promise<void> {
    if (this.warmPromise) return this.warmPromise;
    this.resume();
    // ensureToneEngine internally calls warmBakedCache; we capture bakeChain
    // *after* that so the returned promise covers the full warm queue. Wrap
    // in a fresh promise that strips bakeChain's any-typed result.
    this.warmPromise = this.bakeChain.then(() => undefined);
    return this.warmPromise;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on && this.thrustNode) this.stopThrust();
    if (!on && this.reverseThrustNode) this.stopReverseThrust();
    if (!on && this.sideThrustNode) this.stopSideThrust();
    if (!on) this.stopAllAlienDrones();
    if (!on) this.stopAllBassteroidDrones();
    if (!on) this.stopAllCometShimmers();
    if (!on) this.stopHaloAmbient();
    if (!on) this.stopHaloMusic();
  }

  // Scales the two output buses (master for live voices, bakedOut for
  // pre-baked buffers) by the volume multiplier. v = 0 disables playback so
  // the per-voice early-outs gate any in-flight starts; v > 0 re-enables.
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(2, v));
    if (this.master) this.master.gain.value = Sound.MASTER_BASE_GAIN * this.volume;
    if (this.bakedOut) this.bakedOut.gain.value = Sound.BAKED_BASE_GAIN * this.volume;
    this.setEnabled(this.volume > 0);
  }

  // Start a continuous theremin-ish drone for an alien. The `key` is the
  // Alien instance (or any unique object) used to look up the drone when
  // it's time to stop it. Carrier frequency depends on size — bigger
  // saucers sit deeper in the mix so multiple aliens read as a chord
  // rather than a single wall of sound.
  startAlienDrone(key: object, size: "big" | "medium" | "small", pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.alienDrones.has(key)) return;
    const t = this.ctx.currentTime;
    const spatial = pos ? this.makeSpatial(pos, this.master) : null;
    const sink: AudioNode = spatial ? spatial.panner : this.master;

    // Carrier frequencies — A minor pentatonic-ish so multiple drones layer
    // without dissonance: big=A2 (110), medium=E3 (165), small=A3 (220).
    const baseFreq = size === "big" ? 110 : size === "medium" ? 165 : 220;
    // Detune just enough for the slow-beating "wobbly sine" theremin feel.
    const detuneRatio = 1.006;

    const oscA = this.ctx.createOscillator();
    const oscB = this.ctx.createOscillator();
    oscA.type = "sine";
    oscB.type = "sine";
    oscA.frequency.value = baseFreq;
    oscB.frequency.value = baseFreq * detuneRatio;

    // Vibrato LFO — slow pitch bend that gives the drone its theremin-y
    // hand-wobble quality. Routed to both oscillator frequencies.
    const vibratoLfo = this.ctx.createOscillator();
    vibratoLfo.type = "sine";
    vibratoLfo.frequency.value = size === "big" ? 1.8 : size === "medium" ? 2.4 : 3.2;
    const vibratoDepth = this.ctx.createGain();
    vibratoDepth.gain.value = baseFreq * 0.012;
    vibratoLfo.connect(vibratoDepth);
    vibratoDepth.connect(oscA.frequency);
    vibratoDepth.connect(oscB.frequency);

    // Pulse LFO — slow amplitude swell so the drone reads as "pulsing
    // softly" rather than a flat sustain. Maps to (0..1) on the pulse gain.
    const pulseLfo = this.ctx.createOscillator();
    pulseLfo.type = "sine";
    pulseLfo.frequency.value = 0.7;
    const pulseGain = this.ctx.createGain();
    // Pulse depth ≈ 0.5 → audible swell without going silent at trough.
    const pulseDepth = this.ctx.createGain();
    pulseDepth.gain.value = 0.5;
    pulseLfo.connect(pulseDepth);
    pulseDepth.connect(pulseGain.gain);
    pulseGain.gain.value = 0.5; // bias so depth swings 0..1

    // Lowpass with mid-Q for a softer voice-like character — keeps the
    // sines from sounding sterile and gives the bigger sizes a darker tone.
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 3;
    filter.frequency.value = size === "big" ? 380 : size === "medium" ? 560 : 820;

    // Per-size base loudness. Big saucers are quieter on a per-voice basis
    // because the sub frequency takes up more sonic real estate; small
    // saucers can be a touch louder without crowding.
    const peak = size === "big" ? 0.11 : size === "medium" ? 0.09 : 0.08;
    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(peak, t + 0.6);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(pulseGain);
    pulseGain.connect(mainGain);
    mainGain.connect(sink);

    oscA.start(t);
    oscB.start(t);
    pulseLfo.start(t);
    vibratoLfo.start(t);

    this.alienDrones.set(key, {
      oscA, oscB, pulseLfo, vibratoLfo, vibratoDepth, filter, pulseGain, mainGain,
      spatial: spatial ?? undefined,
    });
  }

  updateAlienDrone(key: object, pos: Pos) {
    const node = this.alienDrones.get(key);
    if (!node || !node.spatial) return;
    this.updateSpatial(node.spatial, pos);
  }

  stopAlienDrone(key: object) {
    if (!this.ctx) return;
    const node = this.alienDrones.get(key);
    if (!node) return;
    const t = this.ctx.currentTime;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    node.oscA.stop(t + 0.22);
    node.oscB.stop(t + 0.22);
    node.pulseLfo.stop(t + 0.22);
    node.vibratoLfo.stop(t + 0.22);
    this.alienDrones.delete(key);
  }

  stopAllAlienDrones() {
    for (const key of Array.from(this.alienDrones.keys())) this.stopAlienDrone(key);
  }

  // Ambient drone played for the lifetime of a broken-open bassteroid. There
  // are 8 voices (4 kinds × 2 sizes), all sitting in a C-major bed so any
  // combination layers without dissonance. Voices are deliberately soft and
  // beatless — they're a *bed* underneath the rhythmic bass hits, not part
  // of the rhythm itself.
  //
  // Pitch map (medium voices sit a fifth below their small counterpart so a
  // medium and its eventual small children form a stacked fifth chord while
  // the field is shattering):
  //   bassA medium = C3 (130.81), small = G4 (392.00)
  //   bassB medium = G3 (196.00), small = D5 (587.33)
  //   bassC medium = E3 (164.81), small = B4 (493.88)
  //   bassD medium = A3 (220.00), small = E5 (659.25)
  //
  // Per-kind timbre (chosen to evoke each kind's percussive voice without
  // repeating it):
  //   bassA = warm filtered sine pad (soft hum)
  //   bassB = detuned sine pair with vibrato (breathy choir)
  //   bassC = sine + sine-fifth (open chorale)
  //   bassD = sine + bandpassed noise (wind-through-metal)
  startBassteroidDrone(key: object, kind: "bassA" | "bassB" | "bassC" | "bassD", size: "medium" | "small", pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.bassDrones.has(key)) return;
    const t = this.ctx.currentTime;
    const spatial = pos ? this.makeSpatial(pos, this.master) : null;
    const sink: AudioNode = spatial ? spatial.panner : this.master;

    const mediumFreq: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
      bassA: 130.81, bassB: 196.00, bassC: 164.81, bassD: 220.00,
    };
    const smallFreq: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
      bassA: 392.00, bassB: 587.33, bassC: 493.88, bassD: 659.25,
    };
    const baseFreq = size === "medium" ? mediumFreq[kind] : smallFreq[kind];

    // Per-size base loudness. Several drones will commonly stack (a single
    // medium that splits gives 2 smalls, two mediums give 4 smalls, etc.),
    // so each voice is intentionally quiet. Mediums get a touch more body
    // than smalls so the lower octave still anchors the mix when present.
    const peakBase = size === "medium" ? 0.035 : 0.022;

    // Lowpass kept conservative so even the brighter D voice never bites.
    // The cutoff sits one octave above the fundamental for mediums and a
    // little tighter (×1.6) for smalls to keep the high voices from getting
    // shrill when several are present.
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.2;
    filter.frequency.value = size === "medium" ? baseFreq * 2.2 : baseFreq * 1.6;

    // Slow amplitude swell — each kind gets a different LFO rate so two
    // pieces of different kinds don't beat in lockstep. Rates are all in the
    // 0.07–0.18 Hz range (5–14 second period) so the bed reads as gently
    // breathing rather than pulsing.
    const pulseRate: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
      bassA: 0.09, bassB: 0.13, bassC: 0.07, bassD: 0.17,
    };
    const pulseLfo = this.ctx.createOscillator();
    pulseLfo.type = "sine";
    pulseLfo.frequency.value = pulseRate[kind];
    const pulseDepth = this.ctx.createGain();
    pulseDepth.gain.value = 0.35;
    const pulseGain = this.ctx.createGain();
    pulseGain.gain.value = 0.65;
    pulseLfo.connect(pulseDepth);
    pulseDepth.connect(pulseGain.gain);

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    // ~1.4s fade-in so the drone arrives as the piece settles, not as a pop.
    mainGain.gain.exponentialRampToValueAtTime(peakBase, t + 1.4);

    filter.connect(pulseGain);
    pulseGain.connect(mainGain);
    mainGain.connect(sink);

    const oscs: OscillatorNode[] = [];
    const lfos: OscillatorNode[] = [pulseLfo];
    let noise: AudioBufferSourceNode | undefined;

    if (kind === "bassA") {
      // Warm filtered sine pad — single sine, soft.
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = baseFreq;
      osc.connect(filter);
      osc.start(t);
      oscs.push(osc);
    } else if (kind === "bassB") {
      // Detuned sine pair with slow vibrato → breathy choir character.
      const oscA = this.ctx.createOscillator();
      const oscB = this.ctx.createOscillator();
      oscA.type = "sine";
      oscB.type = "sine";
      oscA.frequency.value = baseFreq;
      oscB.frequency.value = baseFreq * 1.008;
      const vib = this.ctx.createOscillator();
      vib.type = "sine";
      vib.frequency.value = 0.6;
      const vibDepth = this.ctx.createGain();
      vibDepth.gain.value = baseFreq * 0.004;
      vib.connect(vibDepth);
      vibDepth.connect(oscA.frequency);
      vibDepth.connect(oscB.frequency);
      oscA.connect(filter);
      oscB.connect(filter);
      oscA.start(t);
      oscB.start(t);
      vib.start(t);
      oscs.push(oscA, oscB);
      lfos.push(vib);
    } else if (kind === "bassC") {
      // Open chorale — root + perfect fifth above. Both sines so the
      // interval reads as harmonic colour rather than a separate voice.
      const root = this.ctx.createOscillator();
      const fifth = this.ctx.createOscillator();
      root.type = "sine";
      fifth.type = "sine";
      root.frequency.value = baseFreq;
      fifth.frequency.value = baseFreq * 1.5;
      const fifthGain = this.ctx.createGain();
      fifthGain.gain.value = 0.45; // fifth quieter than root so it just tints
      root.connect(filter);
      fifth.connect(fifthGain);
      fifthGain.connect(filter);
      root.start(t);
      fifth.start(t);
      oscs.push(root, fifth);
    } else {
      // bassD — sine + narrow bandpassed noise for a wind-through-metal hush.
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = baseFreq;
      osc.connect(filter);
      osc.start(t);
      oscs.push(osc);

      const noiseBuf = this.makeNoiseBuffer(6);
      if (noiseBuf) {
        const n = this.ctx.createBufferSource();
        n.buffer = noiseBuf;
        n.loop = true;
        const nBp = this.ctx.createBiquadFilter();
        nBp.type = "bandpass";
        nBp.Q.value = 8;
        nBp.frequency.value = baseFreq * 2;
        const nGain = this.ctx.createGain();
        nGain.gain.value = 0.18; // breath, not hiss
        n.connect(nBp);
        nBp.connect(nGain);
        nGain.connect(filter);
        n.start(t);
        noise = n;
      }
    }

    pulseLfo.start(t);

    this.bassDrones.set(key, { oscs, lfos, noise, mainGain, spatial: spatial ?? undefined });
  }

  updateBassteroidDrone(key: object, pos: Pos) {
    const node = this.bassDrones.get(key);
    if (!node || !node.spatial) return;
    this.updateSpatial(node.spatial, pos);
  }

  stopBassteroidDrone(key: object) {
    if (!this.ctx) return;
    const node = this.bassDrones.get(key);
    if (!node) return;
    const t = this.ctx.currentTime;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    const stopAt = t + 0.4;
    for (const o of node.oscs) o.stop(stopAt);
    for (const l of node.lfos) l.stop(stopAt);
    if (node.noise) node.noise.stop(stopAt);
    this.bassDrones.delete(key);
  }

  stopAllBassteroidDrones() {
    for (const key of Array.from(this.bassDrones.keys())) this.stopBassteroidDrone(key);
  }

  // Comet melody: a slow C-aeolian phrase that layers on top of the halo
  // ambient pad (C–G + Eb-in-comet-mode = C minor triad). Pitches are drawn
  // from C minor pentatonic (C / Eb / F / G / Bb) so every note is consonant
  // with both the pad's C–G–Eb foundation and the halo melody's mode-safe
  // C/D/F/G line. The looming quality comes from the timbre + lower octave
  // and one ornamental Db (b2) grace step per phrase, not from a permanent
  // tritone cluster — the b2 visits and resolves rather than sustaining and
  // muddying the pad.
  //
  // Step rate: one note every 2 BEAT_GRID ticks (1.0 s), matching the halo
  // melody's pulse so the two lines hocket cleanly. The phrase is 8 steps ×
  // 1.0 s = 8 s = 4 bass measures. Indices 0 and 4 are the phrase downbeats
  // (sustained); 3 is the one octave-lift; 5 is a deliberate rest so the
  // halo melody's bright C5 step has the floor; 7 is the b2 grace tension.
  //
  // Shape: G3 → Eb3 (downward yield) → F3 → ↑G4 (lift, octave answer) →
  //        Eb3 → rest → Bb3 → Db3-grace (the one ornamental tension that
  //        immediately bows back toward C the next phrase).
  private static readonly COMET_MELODY: (number | null)[] = [
    196.00,  // G3   — downbeat: pad's fifth, anchors the new entry
    155.56,  // Eb3  — the b3 colour from the pad's third voice an octave down
    174.61,  // F3   — neighbour-tone, sets up the lift
    392.00,  // G4   — octave lift, one bright reach per phrase
    155.56,  // Eb3  — settles back to the b3
    null,    // rest — gives the halo melody's C5/G3 step the floor
    233.08,  // Bb3  — pentatonic colour pitch, dark but consonant
    138.59,  // Db3  — single low grace note: phrygian b2 flavour, low enough
             //        and short enough that it tints rather than collides
  ];

  // Fire one note of the comet melody. `step` is the global step index since
  // the comet appeared; we modulo into the melody table so the phrase loops
  // smoothly for as long as the comet is on screen. Velocity ducks on the
  // ornamental Db grace step so the b2 tension passes by rather than lands;
  // downbeats and the octave lift get longer durations so the pad-blend is
  // felt, while interior steps stay short to leave space for the halo line.
  playCometNote(step: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const melody = Sound.COMET_MELODY;
    const idx = ((step % melody.length) + melody.length) % melody.length;
    const freq = melody[idx];
    if (freq === null) return;

    const eng = this.ensureToneEngine();
    if (!eng) return;
    const isPhraseDownbeat = idx === 0 || idx === 4;
    const isLift = idx === 3;
    const isGrace = idx === 7;
    const velocity = isPhraseDownbeat ? 0.7 : isLift ? 0.64 : isGrace ? 0.3 : 0.5;
    const duration = isPhraseDownbeat || isLift ? "1n" : isGrace ? "4n" : "2n";
    eng.cometMelodySynth.triggerAttackRelease(freq, duration, undefined, velocity);
  }

  // Ominous voice held under the comet's entire lifetime. Begins with a
  // big "shhwwwoorrr" — a wide noise band sweeping from high down to mid —
  // plus a short-lived dissonant cluster (Db2 + F#2 over the C2 root) that
  // makes the arrival feel like something *wrong* is approaching. After
  // ~3 s the tension voices fade out entirely, leaving a stable low C-minor
  // triad (C2 + Eb2 + G2) that matches the halo ambient pad's C–G–Eb voicing
  // an octave down. The bed therefore layers with the halo pad rather than
  // muddying it: same chord, deeper register, slow tremolo for life.
  // Also briefly ducks the halo pad during the entrance so the arrival
  // reads as a dramatic event that the music bows to, then everyone
  // re-balances together.
  startCometShimmer(key: object, pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;

    // The comet voice is built on the legacy WebAudio path for both engines —
    // the bandpass-swept noise + saw-cluster drone is easier to express here
    // than in Tone, and in tone-engine mode the legacy bus already routes
    // through the same compressor/limiter chain, so polish is shared.
    if (this.cometShimmers.has(key)) return;
    const t = this.ctx.currentTime;
    const spatial = pos ? this.makeSpatial(pos, this.master) : null;
    const sink: AudioNode = spatial ? spatial.panner : this.master;

    // ── Master comet voice gain ──────────────────────────────────────────
    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    // Big swell up over the FADE_IN window so the entrance lands hard.
    // Fade-in window matches Comet.FADE_IN (1.6s) so the audio swell tracks
    // the visual bloom landing.
    const audioFadeIn = 1.6;
    mainGain.gain.exponentialRampToValueAtTime(0.32, t + audioFadeIn);
    // Then ease back to a sustained but quieter drone level so the melody
    // notes have headroom to cut through.
    mainGain.gain.exponentialRampToValueAtTime(0.085, t + audioFadeIn + 2.0);
    mainGain.connect(sink);

    const oscs: OscillatorNode[] = [];
    const lfos: OscillatorNode[] = [];

    // ── "Shhwwwoorrr" entrance: bandpass-swept noise ────────────────────
    // 6 seconds of looped pink-ish noise routed through a bandpass that
    // sweeps from ~5kHz down to ~600Hz over the first ~3 seconds — gives
    // the classic "approaching from a distance" wind/whoosh, then tails
    // off into the drone bed.
    const noiseBuf = this.makeNoiseBuffer(8);
    if (noiseBuf) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuf;
      noise.loop = true;

      const noiseBp = this.ctx.createBiquadFilter();
      noiseBp.type = "bandpass";
      noiseBp.Q.value = 2.4;
      noiseBp.frequency.setValueAtTime(5200, t);
      noiseBp.frequency.exponentialRampToValueAtTime(1200, t + 1.6);
      noiseBp.frequency.exponentialRampToValueAtTime(620, t + 3.2);
      // A slow LFO on the bandpass after the sweep gives the drone its
      // restless, breathing quality — the wind never settles.
      const sweepLfo = this.ctx.createOscillator();
      sweepLfo.type = "sine";
      sweepLfo.frequency.value = 0.09;
      const sweepDepth = this.ctx.createGain();
      sweepDepth.gain.value = 220;
      sweepLfo.connect(sweepDepth);
      sweepDepth.connect(noiseBp.frequency);
      sweepLfo.start(t + 3.2);

      const noiseGain = this.ctx.createGain();
      // The whoosh is loud at entry, then drops to a thin hiss under the
      // drone. Time these to the master swell.
      noiseGain.gain.setValueAtTime(0.0001, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.85, t + 0.45);
      noiseGain.gain.exponentialRampToValueAtTime(0.55, t + 2.0);
      noiseGain.gain.exponentialRampToValueAtTime(0.12, t + 4.5);

      noise.connect(noiseBp);
      noiseBp.connect(noiseGain);
      noiseGain.connect(mainGain);
      noise.start(t);

      // Track the noise source under oscs so stopCometShimmer cleans it up.
      // (OscillatorNode and AudioBufferSourceNode both have .stop, and the
      // cleanup loop only calls .stop — close enough that we can store as
      // OscillatorNode for the type without runtime fallout.)
      oscs.push(noise as unknown as OscillatorNode);
      lfos.push(sweepLfo);
    }

    // ── Sustained drone bed (life of the comet) ────────────────────────
    // Low C-minor triad — C2 (65.4) + Eb2 (77.8) + G2 (98.0). Same chord the
    // halo ambient pad outlines in comet mode (C3 + Eb4 + G3), an octave
    // down, so the comet bed reinforces the pad's harmonic root instead of
    // fighting it. Each voice is two slightly detuned sawtooths through a
    // dark lowpass, so the triad reads as a thick rumble rather than three
    // distinct pitches.
    const sustainFreqs = [65.41, 77.78, 98.00]; // C2, Eb2, G2
    const sustainLevels = [0.55, 0.30, 0.34];
    const tremRates = [0.07, 0.11, 0.13];

    const droneFilter = this.ctx.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.Q.value = 1.4;
    // Filter opens during the entry then settles dark — gives the bed a slow
    // unwrapping quality that matches the visual bloom.
    droneFilter.frequency.setValueAtTime(400, t);
    droneFilter.frequency.exponentialRampToValueAtTime(1100, t + 2.5);
    droneFilter.frequency.exponentialRampToValueAtTime(620, t + 6.0);
    droneFilter.connect(mainGain);

    for (let i = 0; i < sustainFreqs.length; i++) {
      const f = sustainFreqs[i];
      const oscA = this.ctx.createOscillator();
      const oscB = this.ctx.createOscillator();
      oscA.type = "sawtooth";
      oscB.type = "sawtooth";
      oscA.frequency.value = f;
      oscB.frequency.value = f * 1.011;

      const trem = this.ctx.createOscillator();
      trem.type = "sine";
      trem.frequency.value = tremRates[i];
      const tremDepth = this.ctx.createGain();
      tremDepth.gain.value = 0.4;
      const voiceGain = this.ctx.createGain();
      voiceGain.gain.value = sustainLevels[i];
      trem.connect(tremDepth);
      tremDepth.connect(voiceGain.gain);

      oscA.connect(voiceGain);
      oscB.connect(voiceGain);
      voiceGain.connect(droneFilter);

      oscA.start(t);
      oscB.start(t);
      trem.start(t);

      oscs.push(oscA, oscB);
      lfos.push(trem);
    }

    // ── Transient tension cluster (entrance only) ───────────────────────
    // Db2 (b2, "wrong note") and F#2 (tritone, "diabolus") swell in with
    // the whoosh and fade out fully by ~3.5s. The brief collision makes the
    // arrival feel ominous, but the cluster doesn't sustain — once the
    // melody starts singing, the bed is the pure C-minor triad above.
    const tensionFreqs = [69.30, 92.50]; // Db2, F#2
    const tensionPeaks = [0.16, 0.20];
    for (let i = 0; i < tensionFreqs.length; i++) {
      const f = tensionFreqs[i];
      const oscA = this.ctx.createOscillator();
      const oscB = this.ctx.createOscillator();
      oscA.type = "sawtooth";
      oscB.type = "sawtooth";
      oscA.frequency.value = f;
      oscB.frequency.value = f * 1.011;

      const voiceGain = this.ctx.createGain();
      voiceGain.gain.setValueAtTime(0.0001, t);
      voiceGain.gain.exponentialRampToValueAtTime(tensionPeaks[i], t + 0.7);
      // Hold briefly, then fade out to silence by t+3.5s — by the time the
      // first melody note plays (typically t+~1–2s on the next downbeat),
      // these tension voices are already on their way out.
      voiceGain.gain.exponentialRampToValueAtTime(tensionPeaks[i] * 0.6, t + 1.6);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);

      oscA.connect(voiceGain);
      oscB.connect(voiceGain);
      voiceGain.connect(droneFilter);

      oscA.start(t);
      oscB.start(t);
      // Stop the voices after they're inaudible so we don't keep silent
      // oscillators alive for the comet's entire lifetime.
      oscA.stop(t + 3.6);
      oscB.stop(t + 3.6);
      // Not pushed into oscs[] because they self-terminate before
      // stopCometShimmer runs — adding them would re-call .stop() on a
      // node that's already ended, which is harmless but noisy in DevTools.
    }

    // ── Brief duck on the halo ambient pad during the entrance ──────────
    // If the player has the halo up (combo ≥ 4) when the comet arrives,
    // bow the pad ~6 dB for the duration of the whoosh, then restore.
    // Makes the comet's entry feel like the music yielding to a new
    // presence — small dramatic gesture, paid back as everything balances.
    if (this.haloAmbient) {
      const hG = this.haloAmbient.mainGain.gain;
      const current = hG.value;
      hG.cancelScheduledValues(t);
      hG.setValueAtTime(current, t);
      hG.exponentialRampToValueAtTime(Math.max(current * 0.45, 0.0001), t + 0.5);
      // Hold the duck through the whoosh peak, then unduck over ~2.5s so the
      // pad re-emerges naturally as the comet bed settles.
      hG.setValueAtTime(Math.max(current * 0.45, 0.0001), t + 1.8);
      hG.exponentialRampToValueAtTime(Math.max(current, 0.0001), t + 4.3);
    }

    this.cometShimmers.set(key, { oscs, lfos, mainGain, spatial: spatial ?? undefined });
  }

  updateCometShimmer(key: object, pos: Pos) {
    const node = this.cometShimmers.get(key);
    if (!node || !node.spatial) return;
    this.updateSpatial(node.spatial, pos);
  }

  stopCometShimmer(key: object) {
    if (this.toneEngine) {
      const shimmer = this.toneEngine.cometShimmerByKey.get(key);
      if (shimmer) {
        const fadeOut = 2.0;
        shimmer.fadeGain.gain.rampTo(0, fadeOut);
        const now = Tone.now();
        shimmer.synth.triggerRelease(shimmer.chord, now);
        // Dispose after release tail clears, plus a small safety margin.
        const cleanupAt = now + fadeOut + 0.5;
        Tone.getTransport().scheduleOnce(() => {
          for (const l of shimmer.lfos) l.dispose();
          shimmer.synth.dispose();
          shimmer.fadeGain.dispose();
        }, cleanupAt);
        this.toneEngine.cometShimmerByKey.delete(key);
        // Fall through in case the legacy map also holds this key (it won't,
        // but defensive — we're in the middle of an engine switch sometimes).
      }
    }
    if (!this.ctx) return;
    const node = this.cometShimmers.get(key);
    if (!node) return;
    const t = this.ctx.currentTime;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.0 /* COMET_FADE_OUT */);
    const stopAt = t + 2.0 /* COMET_FADE_OUT */ + 0.1;
    for (const o of node.oscs) o.stop(stopAt);
    for (const l of node.lfos) l.stop(stopAt);
    this.cometShimmers.delete(key);
  }

  // Big explosive-into-quiet death sound for a player-destroyed comet.
  // Begins with a sharp white-noise crack + low sub-thump (the actual
  // explosion impact) and resolves into a long noise + sub drone that
  // fades out over 15 seconds — the wreckage echoing through the void.
  // Played on top of (and louder than) the comet's own drone, which
  // continues its normal ~2s fade-out via stopCometShimmer.
  playCometDestroyed() {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const TAIL = 15.0;

    // ── Initial crack: short broadband noise burst with a fast HP→LP
    // sweep so it reads as "explosion now, then debris".
    const crackBuf = this.makeNoiseBuffer(0.4);
    if (crackBuf) {
      const crack = this.ctx.createBufferSource();
      crack.buffer = crackBuf;
      const crackFilter = this.ctx.createBiquadFilter();
      crackFilter.type = "lowpass";
      crackFilter.Q.value = 0.9;
      crackFilter.frequency.setValueAtTime(8000, t);
      crackFilter.frequency.exponentialRampToValueAtTime(1400, t + 0.18);
      const crackGain = this.ctx.createGain();
      crackGain.gain.setValueAtTime(0.85, t);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      crack.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(this.master);
      crack.start(t);
      crack.stop(t + 0.4);
    }

    // ── Sub-bass thump: pitched sine sweep from ~120Hz down to ~30Hz.
    // The chest-thump under the crack — gives the explosion physical weight.
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(140, t);
    sub.frequency.exponentialRampToValueAtTime(30, t + 0.9);
    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.55, t + 0.01);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 1.5);

    // ── Long tail: looped pink noise through a slow-closing bandpass.
    // After the initial crack settles, the noise band drops from ~1200Hz
    // down to ~80Hz over the 15-second tail, so the "wreckage" gets
    // duller (more felt than heard) as it fades.
    const tailBuf = this.makeNoiseBuffer(4);
    if (tailBuf) {
      const tail = this.ctx.createBufferSource();
      tail.buffer = tailBuf;
      tail.loop = true;

      const tailFilter = this.ctx.createBiquadFilter();
      tailFilter.type = "bandpass";
      tailFilter.Q.value = 1.6;
      tailFilter.frequency.setValueAtTime(2400, t);
      tailFilter.frequency.exponentialRampToValueAtTime(1200, t + 0.6);
      tailFilter.frequency.exponentialRampToValueAtTime(80, t + TAIL);

      const tailGain = this.ctx.createGain();
      // Big at the impact, then a long exponential fade to silence at
      // exactly TAIL seconds. The shape uses two segments so the first
      // ~2s of tail are still meaty before the long quiet fade takes over.
      tailGain.gain.setValueAtTime(0.0001, t);
      tailGain.gain.exponentialRampToValueAtTime(0.45, t + 0.05);
      tailGain.gain.exponentialRampToValueAtTime(0.18, t + 2.0);
      tailGain.gain.exponentialRampToValueAtTime(0.0001, t + TAIL);

      tail.connect(tailFilter);
      tailFilter.connect(tailGain);
      tailGain.connect(this.master);
      tail.start(t);
      tail.stop(t + TAIL + 0.2);
    }

    // ── Sub-drone under the tail: low sawtooth that hums for the full
    // 15s. Gives the fade a tangible low-end presence so the player can
    // still feel the comet's ghost long after the visual is gone.
    const droneRoot = this.ctx.createOscillator();
    const droneOct = this.ctx.createOscillator();
    droneRoot.type = "sawtooth";
    droneOct.type = "sawtooth";
    droneRoot.frequency.value = 49.0; // G1 — sits below the bassteroid bed
    droneOct.frequency.value = 49.0 * 1.013; // wide detune for slow beating
    const droneLp = this.ctx.createBiquadFilter();
    droneLp.type = "lowpass";
    droneLp.Q.value = 0.8;
    droneLp.frequency.setValueAtTime(600, t);
    droneLp.frequency.exponentialRampToValueAtTime(120, t + TAIL);
    const droneGain = this.ctx.createGain();
    droneGain.gain.setValueAtTime(0.0001, t);
    droneGain.gain.exponentialRampToValueAtTime(0.22, t + 0.4);
    droneGain.gain.exponentialRampToValueAtTime(0.0001, t + TAIL);
    droneRoot.connect(droneLp);
    droneOct.connect(droneLp);
    droneLp.connect(droneGain);
    droneGain.connect(this.master);
    droneRoot.start(t);
    droneOct.start(t);
    droneRoot.stop(t + TAIL + 0.2);
    droneOct.stop(t + TAIL + 0.2);
  }

  // Sadder sibling of playCometDestroyed for off-rhythm comet kills. Same
  // overall shape (crack → sub thump → noise tail → low drone) but smaller,
  // duller, and with a descending pitched sigh layered on top. The drone
  // sits a minor-6th lower (Eb1 vs G1) for a darker root, the tail collapses
  // in ~6s instead of 15s, and the sub thump ends on a falling minor-third
  // sine sigh — the literal "aww" of wasting the comet's moment.
  playCometDestroyedSad() {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const TAIL = 6.0;

    // Softer crack — duller, quicker decay so it reads as a fizzle.
    const crackBuf = this.makeNoiseBuffer(0.3);
    if (crackBuf) {
      const crack = this.ctx.createBufferSource();
      crack.buffer = crackBuf;
      const crackFilter = this.ctx.createBiquadFilter();
      crackFilter.type = "lowpass";
      crackFilter.Q.value = 0.9;
      crackFilter.frequency.setValueAtTime(4500, t);
      crackFilter.frequency.exponentialRampToValueAtTime(900, t + 0.18);
      const crackGain = this.ctx.createGain();
      crackGain.gain.setValueAtTime(0.55, t);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      crack.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(this.master);
      crack.start(t);
      crack.stop(t + 0.32);
    }

    // Sub thump — softer than the celebratory variant and lower start pitch.
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(110, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 1.0);
    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.38, t + 0.015);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 1.4);

    // Descending sigh — soft sine falling a minor third (G4 → E4 → C4-ish),
    // the audible "aww" that tells the player they missed the rhythm window.
    const sigh = this.ctx.createOscillator();
    sigh.type = "sine";
    sigh.frequency.setValueAtTime(392, t + 0.05); // G4
    sigh.frequency.exponentialRampToValueAtTime(311, t + 0.55); // Eb4
    sigh.frequency.exponentialRampToValueAtTime(220, t + 1.5); // A3 — settles below
    const sighGain = this.ctx.createGain();
    sighGain.gain.setValueAtTime(0.0001, t + 0.05);
    sighGain.gain.exponentialRampToValueAtTime(0.12, t + 0.15);
    sighGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    sigh.connect(sighGain);
    sighGain.connect(this.master);
    sigh.start(t + 0.05);
    sigh.stop(t + 1.85);

    // Short noise tail — bandpass collapses quickly so the wreckage clears
    // in ~6s instead of lingering for 15. The comet didn't get to sing.
    const tailBuf = this.makeNoiseBuffer(3);
    if (tailBuf) {
      const tail = this.ctx.createBufferSource();
      tail.buffer = tailBuf;
      tail.loop = true;

      const tailFilter = this.ctx.createBiquadFilter();
      tailFilter.type = "bandpass";
      tailFilter.Q.value = 1.8;
      tailFilter.frequency.setValueAtTime(1400, t);
      tailFilter.frequency.exponentialRampToValueAtTime(500, t + 0.6);
      tailFilter.frequency.exponentialRampToValueAtTime(60, t + TAIL);

      const tailGain = this.ctx.createGain();
      tailGain.gain.setValueAtTime(0.0001, t);
      tailGain.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
      tailGain.gain.exponentialRampToValueAtTime(0.08, t + 1.2);
      tailGain.gain.exponentialRampToValueAtTime(0.0001, t + TAIL);

      tail.connect(tailFilter);
      tailFilter.connect(tailGain);
      tailGain.connect(this.master);
      tail.start(t);
      tail.stop(t + TAIL + 0.2);
    }

    // Low drone — tuned to Eb1 (~38.9Hz), a minor-6th below the celebratory
    // G1, so the harmonic root reads as "minor key" instead of open root.
    const droneRoot = this.ctx.createOscillator();
    const droneOct = this.ctx.createOscillator();
    droneRoot.type = "sawtooth";
    droneOct.type = "sawtooth";
    droneRoot.frequency.value = 38.9; // Eb1
    droneOct.frequency.value = 38.9 * 1.011;
    const droneLp = this.ctx.createBiquadFilter();
    droneLp.type = "lowpass";
    droneLp.Q.value = 0.8;
    droneLp.frequency.setValueAtTime(500, t);
    droneLp.frequency.exponentialRampToValueAtTime(100, t + TAIL);
    const droneGain = this.ctx.createGain();
    droneGain.gain.setValueAtTime(0.0001, t);
    droneGain.gain.exponentialRampToValueAtTime(0.16, t + 0.4);
    droneGain.gain.exponentialRampToValueAtTime(0.0001, t + TAIL);
    droneRoot.connect(droneLp);
    droneOct.connect(droneLp);
    droneLp.connect(droneGain);
    droneGain.connect(this.master);
    droneRoot.start(t);
    droneOct.start(t);
    droneRoot.stop(t + TAIL + 0.2);
    droneOct.stop(t + TAIL + 0.2);
  }

  stopAllCometShimmers() {
    for (const key of Array.from(this.cometShimmers.keys())) this.stopCometShimmer(key);
    if (this.toneEngine) {
      for (const key of Array.from(this.toneEngine.cometShimmerByKey.keys())) this.stopCometShimmer(key);
    }
  }

  // Yellow-halo ambient pad. A soft, C-rooted bed that hangs under the bass
  // field whenever the player is holding a halo. The voicing is a stable
  // open-fifth (C+G) with a single colour-third floating over it — the open
  // fifth is at home in *both* the bassteroids' C-major bed AND the comet's
  // C-rooted phrygian/diminished cluster, and the colour third slides
  // between E (bright over major bass) and Eb (neutral over the comet) via
  // setHaloAmbientCometMode.
  //
  // Over that bed sits a quiet looping melody — a 1-second-per-step "keep
  // going" motif played on a soft triangle. The line is built only from
  // C/D/F/G (the four pitches that are mode-invariant across all six modes
  // the game visits), so it stays in tune on a Lydian wave 3 and on a
  // Phrygian wave 30 alike, and never collides with the comet's b2/tritone.
  // The shape — G → F → G → C5 → G → F → D → (rest) — climbs to the octave
  // once per phrase then settles back, like a quiet determined breath:
  // forward, settle, forward, settle. Slow attack/release per note keeps
  // each step blooming rather than punching, so the pad still reads as
  // ambient at white-bullet tier doubletime.
  startHaloAmbient(tier: 1 | 2 = 1) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.haloAmbient) {
      this.setHaloAmbientTier(tier);
      return;
    }
    const t = this.ctx.currentTime;

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    // ~2s fade-in — the pad arrives as a halo emerging, not as a click.
    // Peak level chosen to sit just under the bass drones: with the per-voice
    // gains below, the loudest moment of the root voice is ~0.04 amplitude,
    // comparable to one bassteroid drone (0.022–0.035 peak).
    mainGain.gain.exponentialRampToValueAtTime(0.09, t + 2.0);

    // Lowpass keeps the pad soft and "behind" the bass drones (which have
    // their own brighter top end). Cutoff sits above the highest voice so
    // we shape rather than mute it.
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.9;
    filter.frequency.value = 1600;
    filter.connect(mainGain);

    // Slow tremolo — the pad breathes at ~0.06 Hz (16s period). Slower than
    // any bass drone's pulseLfo (0.07–0.18 Hz) so the layers don't beat in
    // lockstep and the pad reads as the slowest moving voice in the mix.
    const tremLfo = this.ctx.createOscillator();
    tremLfo.type = "sine";
    tremLfo.frequency.value = 0.06;
    const tremDepth = this.ctx.createGain();
    tremDepth.gain.value = 0.28;
    const tremGain = this.ctx.createGain();
    tremGain.gain.value = 0.72;
    tremLfo.connect(tremDepth);
    tremDepth.connect(tremGain.gain);
    tremGain.connect(filter);
    tremLfo.start(t);

    const oscs: OscillatorNode[] = [];
    const lfos: OscillatorNode[] = [tremLfo];

    // C3 fundamental (130.81). Same pitch as bassA medium so they reinforce
    // when bassA is present and form a clean root when it's not.
    const root = this.ctx.createOscillator();
    root.type = "sine";
    root.frequency.value = 130.81;
    const rootGain = this.ctx.createGain();
    rootGain.gain.value = 0.55;
    root.connect(rootGain);
    rootGain.connect(tremGain);
    root.start(t);
    oscs.push(root);

    // G3 fifth (196.00). Same pitch as bassB medium. The C+G open fifth is
    // the harmonic invariant — it's in every mode that begins on C and
    // doesn't fight the comet's b2 (Db) or tritone (F#) the way an E or A
    // would. A second slightly-detuned oscillator gives a gentle phasing
    // shimmer without using a chorus that would cost CPU.
    const fifth = this.ctx.createOscillator();
    const fifthDetuned = this.ctx.createOscillator();
    fifth.type = "sine";
    fifthDetuned.type = "sine";
    fifth.frequency.value = 196.00;
    fifthDetuned.frequency.value = 196.00 * 1.006;
    const fifthGain = this.ctx.createGain();
    fifthGain.gain.value = 0.40;
    fifth.connect(fifthGain);
    fifthDetuned.connect(fifthGain);
    fifthGain.connect(tremGain);
    fifth.start(t);
    fifthDetuned.start(t);
    oscs.push(fifth, fifthDetuned);

    // Third voice — defaults to E4 (329.63), glides down to Eb4 (311.13)
    // when a comet is present. E4 turns the open fifth into a C-major triad
    // (CEG up an octave), which is rich and bright over the bass major bed.
    // Eb4 turns it into a C-minor triad which is *consonant with the comet's
    // dissonant cluster* — Eb is the b3 in C-phrygian. Either way the bottom
    // C+G stays put, so the pad never breaks character; only the colour
    // shifts.
    const thirdOsc = this.ctx.createOscillator();
    thirdOsc.type = "sine";
    thirdOsc.frequency.value = this.haloAmbientCometMode ? 311.13 : 329.63;
    const thirdGain = this.ctx.createGain();
    thirdGain.gain.value = 0.28;
    thirdOsc.connect(thirdGain);
    thirdGain.connect(tremGain);
    thirdOsc.start(t);
    oscs.push(thirdOsc);

    // Tier-2 (white bullet) gain — an octave-up colour layer that swells in
    // when combo crosses 8. Wired here so the upgrade is a single gain ramp
    // rather than starting a new oscillator stack mid-game.
    const tier2Gain = this.ctx.createGain();
    tier2Gain.gain.value = 0.0001;

    // Octave-up top: C4 + G4. Brighter sparkle for the white-bullet tier.
    const topC = this.ctx.createOscillator();
    const topG = this.ctx.createOscillator();
    topC.type = "sine";
    topG.type = "sine";
    topC.frequency.value = 261.63;
    topG.frequency.value = 392.00;
    const topGain = this.ctx.createGain();
    topGain.gain.value = 0.18;
    topC.connect(topGain);
    topG.connect(topGain);
    topGain.connect(tier2Gain);
    tier2Gain.connect(tremGain);
    topC.start(t);
    topG.start(t);
    oscs.push(topC, topG);

    // ── Melody voice ──────────────────────────────────────────────────────
    // One triangle oscillator runs continuously; per-step we cancel the
    // previous envelope, retune the frequency, and schedule a fresh
    // attack/sustain/release. Triangle has a warmer, slightly hollow voice
    // than sine — it carries the line above the sine bed without the bite
    // of a saw, so the motif reads as introspective rather than declarative.
    const melodyOsc = this.ctx.createOscillator();
    melodyOsc.type = "triangle";
    // A gentle lowpass softens the triangle's high partials so the line sits
    // *behind* the bass field's brightness instead of cutting through it.
    const melodyFilter = this.ctx.createBiquadFilter();
    melodyFilter.type = "lowpass";
    melodyFilter.Q.value = 0.7;
    melodyFilter.frequency.value = 1100;
    const melodyGain = this.ctx.createGain();
    melodyGain.gain.setValueAtTime(0.0001, t);
    melodyOsc.connect(melodyFilter);
    melodyFilter.connect(melodyGain);
    // Routed through tremGain so the melody breathes with the same slow
    // 16-second swell as the rest of the pad.
    melodyGain.connect(tremGain);
    // Start at the first phrase pitch (G3) — first step's frequency
    // schedule below will override anyway, but giving it a sane initial
    // value avoids any glitch on the very first attack.
    melodyOsc.frequency.value = 196.00;
    melodyOsc.start(t);
    oscs.push(melodyOsc);

    // Determined 8-step motif. One step every PAD_STEP_S seconds (1.0s, so
    // two BEAT_GRID ticks — slow enough to feel like a held thought, fast
    // enough that the line clearly *is* a line rather than a chord). Rests
    // are null. Pitches are restricted to {C, D, F, G} in two octaves so
    // the figure is mode-safe across the whole game.
    //
    //  step  pitch   feel
    //  0     G3      "forward" — open fifth, settled but moving
    //  1     F3      "step back" — a half-yield, acknowledges the dark
    //  2     G3      "forward again" — same step, more resolved
    //  3     C5      "lift" — the one bright reach per phrase
    //  4     G3      "settle" — back to the foundation
    //  5     F3      "breathe down"
    //  6     D3      "lowest reach" — pulls under the root before resolving
    //  7     null    rest — silence is the resolution; loop restarts at G
    const MELODY_HZ: (number | null)[] = [
      196.00,  // G3
      174.61,  // F3
      196.00,  // G3
      523.25,  // C5
      196.00,  // G3
      174.61,  // F3
      146.83,  // D3
      null,
    ];
    const PAD_STEP_S = 1.0;
    // Peak gain per note. Sits well below rootGain (0.55) and fifthGain
    // (0.40) so the line stays subordinate to the bed it floats over —
    // it's a hummed melody, not a lead. The C5 lift step gets a touch less
    // gain so the upper octave doesn't pop forward in the mix.
    const noteGainFor = (hz: number) => (hz >= 400 ? 0.16 : 0.22);

    let step = 0;
    const triggerStep = () => {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const hz = MELODY_HZ[step % MELODY_HZ.length];
      step++;
      melodyGain.gain.cancelScheduledValues(now);
      // Always start from the current value so we don't click if a previous
      // envelope hasn't finished its release.
      melodyGain.gain.setValueAtTime(melodyGain.gain.value, now);
      if (hz === null) {
        // Quiet release — let the previous note tail off into the rest.
        melodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        return;
      }
      // Slight portamento between notes (60ms) so each pitch glides into
      // place — the line sounds like a held human voice rather than a
      // chord-stab sequencer.
      melodyOsc.frequency.cancelScheduledValues(now);
      melodyOsc.frequency.setValueAtTime(melodyOsc.frequency.value, now);
      melodyOsc.frequency.exponentialRampToValueAtTime(hz, now + 0.06);
      // ADSR-ish per note: 0.25s bloom in, hold ~0.45s, 0.30s release.
      // Total ~1.0s = one step, so notes overlap minimally at the edges.
      const peak = noteGainFor(hz);
      melodyGain.gain.exponentialRampToValueAtTime(peak, now + 0.25);
      melodyGain.gain.setValueAtTime(peak, now + 0.70);
      melodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.00);
    };
    // Fire the first step immediately so the pad arrives with a sung-into
    // entrance rather than a second of silent build.
    triggerStep();
    const melodyInterval = setInterval(triggerStep, PAD_STEP_S * 1000);

    mainGain.connect(this.master);

    this.haloAmbient = { oscs, lfos, mainGain, thirdOsc, tier2Gain, melodyOsc, melodyGain, melodyInterval };
    this.haloAmbientTier = 1;
    if (tier === 2) this.setHaloAmbientTier(2);
  }

  setHaloAmbientTier(tier: 1 | 2) {
    if (!this.ctx || !this.haloAmbient) return;
    if (this.haloAmbientTier === tier) return;
    const t = this.ctx.currentTime;
    const target = tier === 2 ? 1.0 : 0.0001;
    this.haloAmbient.tier2Gain.gain.cancelScheduledValues(t);
    this.haloAmbient.tier2Gain.gain.setValueAtTime(this.haloAmbient.tier2Gain.gain.value, t);
    // Fade up over ~0.5s for a smooth tier promotion, demote a bit slower
    // so a single mistimed shot doesn't strip the sparkle abruptly.
    this.haloAmbient.tier2Gain.gain.exponentialRampToValueAtTime(target, t + (tier === 2 ? 0.5 : 0.9));
    this.haloAmbientTier = tier;
  }

  // ── Pre-rendered halo music ────────────────────────────────────────────
  // Loads a music variation (ambient + melodic stems) and schedules them as
  // looping buffer sources. The ambient stem fades in immediately; the
  // melodic stem starts ducked and only fades up when
  // setHaloMusicMelodicLayer(true) is called (combo ≥ 6). Both stems share
  // length and downbeat so they stay phase-locked for the lifetime of the
  // music.
  //
  // Round 1 used 8-second loops at -6 dBFS peak with gain 0.55 — the audit
  // showed those were ~7× hotter than the legacy synth pad and fighting the
  // bass in the 200–500 Hz lo-mid. Round 2 uses 32-second loops at -12 dBFS
  // peak with per-variation gain targets calibrated against the in-game-mix
  // audit (`scripts/music-gen/ingame_mix.py`): EL stems pass with gain 0.25,
  // self-built stems with 0.30, leaving the bass dominant by ≥7 dB in every
  // band.
  //
  // Routed via this.master (not bakedOut) so the music sits inside the same
  // reverb/compressor bus as live voices. The pre-rendered stems are already
  // loop-faded so the master bus's reverb tail at the seam won't click.
  private haloMusicUrl(variation: HaloMusicVariation, layer: "ambient" | "melodic" | "layer3"): string {
    return `/sounds/halo-music/${variation}-${layer}.mp3`;
  }

  // Per-variation playback gain, calibrated against the in-game-mix audit
  // (`scripts/music-gen/ingame_mix.py`) so the bass kit stays dominant by
  // ≥7 dB in every band. EL stems are spectrally darker so they need a
  // touch less gain to match perceived loudness with the self-built stems.
  private haloMusicGain(variation: HaloMusicVariation): number {
    switch (variation) {
      case "r2-el": return 0.25;
      case "r2-sb": return 0.30;
      // r3-el is an EL-generated analog synth pad with 42% energy in 60-200
      // and 44% in 200-500. At gain 0.22 the melodic layer's lo-mid sits
      // +6.8 dB above the ≥4 dB pass threshold. Going higher risks the
      // analog pad fighting the bass field.
      case "r3-el": return 0.22;
      // r4-sb is the rhythmic flagship — pulsing arp + smooth calliope-synth
      // melody that breathes in the gaps left by layer 3. Audit at gain 0.25
      // keeps lo-mid clean by ≥8.9 dB with all three layers stacked; same gain
      // applied across layers so the interlock stays even.
      case "r4-sb": return 0.25;
      default:      return 0.30;
    }
  }

  // Layer-3 playback gain (combo ≥ 12). Calibrated per variation against the
  // in-game-mix audit so the bass kit stays dominant by ≥6 dB in lo-mid and
  // ≥10 dB in bass. Each variation's layer 3 is a single new musical element
  // chosen to thematically fit its existing ambient + melodic stems (lonely
  // violin / glockenspiel / synth-bass arp / chime counter-melody — see
  // build_layer3.py for the per-variation design).
  private haloMusicLayer3Gain(variation: HaloMusicVariation): number {
    switch (variation) {
      case "r2-el": return 0.45;   // lonely violin (cinematic third voice)
      case "r2-sb": return 0.40;   // warm felt-glockenspiel arpeggio
      case "r3-el": return 0.30;   // synthwave plucked synth-bass arp
      case "r4-sb": return 0.32;   // chime counter-melody (interlocks, low-rhythm)
      default:      return 0.40;
    }
  }

  private loadHaloMusicBuffer(url: string): Promise<AudioBuffer | null> {
    const cached = this.haloMusicBuffers.get(url);
    if (cached) return Promise.resolve(cached);
    const inflight = this.haloMusicLoading.get(url);
    if (inflight) return inflight;
    if (!this.ctx) return Promise.resolve(null);
    const ctx = this.ctx;
    const p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => (ab ? ctx.decodeAudioData(ab) : null))
      .then((buf) => {
        if (buf) this.haloMusicBuffers.set(url, buf);
        this.haloMusicLoading.delete(url);
        return buf;
      })
      .catch(() => {
        this.haloMusicLoading.delete(url);
        return null;
      });
    this.haloMusicLoading.set(url, p);
    return p;
  }

  // Warm both stems for a variation so the first 4x trigger plays without
  // fetch+decode latency. Safe to call multiple times — cached entries are
  // deduped.
  preloadHaloMusic(variation: HaloMusicVariation): void {
    if (variation === "none") return;
    this.ensureContext();
    void this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "ambient"));
    void this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "melodic"));
    void this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "layer3"));
  }

  // Start (or hot-restart) the pre-rendered halo music for a variation. If a
  // node is already playing for the same variation, we just toggle the
  // melodic layer; otherwise we tear down the old one and load the new.
  // melodicActive: should the melodic layer be audible from the start?
  // (Used when combo jumps straight to ≥ 6 without stopping at 4.)
  //
  // measureAlignDelay: optional seconds to delay the buffer .start() so the
  // music's downbeat lands on a bass-measure boundary. Computed by the
  // caller from game.beatTime modulo BASS_MEASURE_LENGTH. If negative or
  // not provided, start immediately. Phase-correct alignment matters more
  // for 32-second loops with internal chord changes than for the round-1
  // 8-second loops, where any seam landed within one bar of the bass clock
  // anyway.
  async startHaloMusic(variation: HaloMusicVariation, melodicActive: boolean,
                       measureAlignDelay: number = 0,
                       layer3Active: boolean = false): Promise<void> {
    if (variation === "none") return;
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    // Same variation already running — just sync the layered tiers.
    if (this.haloMusic && this.haloMusic.variation === variation) {
      this.setHaloMusicMelodicLayer(melodicActive);
      this.setHaloMusicLayer3(layer3Active);
      return;
    }
    // Different variation playing — fade out the old node before swapping.
    if (this.haloMusic) this.stopHaloMusic();

    const [ambientBuf, melodicBuf, layer3Buf] = await Promise.all([
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "ambient")),
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "melodic")),
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "layer3")),
    ]);
    if (!this.ctx || !this.master) return;
    if (!ambientBuf || !melodicBuf) return;
    if (this.haloMusic) return;  // raced with another start

    const t = this.ctx.currentTime;
    const startAt = t + Math.max(0, measureAlignDelay);
    const ambientSrc = this.ctx.createBufferSource();
    const melodicSrc = this.ctx.createBufferSource();
    ambientSrc.buffer = ambientBuf;
    melodicSrc.buffer = melodicBuf;
    ambientSrc.loop = true;
    melodicSrc.loop = true;

    // Per-variation playback peak gain. See haloMusicGain — round-2 stems
    // (-12 dBFS peak) need lower gain than round-1 (-6 dBFS peak) to sit
    // under the bass field. Layer 3 has its own gain since it lives outside
    // the bass-melodic register and tolerates an independent mix.
    const peakGain = this.haloMusicGain(variation);

    // Fade-in starts at the *aligned* start time, not now, so the music
    // doesn't bleed in during the wait-for-downbeat window.
    const ambientGain = this.ctx.createGain();
    ambientGain.gain.setValueAtTime(0.0001, startAt);
    ambientGain.gain.exponentialRampToValueAtTime(peakGain, startAt + 1.5);

    const melodicGain = this.ctx.createGain();
    melodicGain.gain.setValueAtTime(0.0001, startAt);
    if (melodicActive) {
      melodicGain.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.5);
    }

    const mainGain = this.ctx.createGain();
    mainGain.gain.value = 1.0;

    ambientSrc.connect(ambientGain);
    melodicSrc.connect(melodicGain);
    ambientGain.connect(mainGain);
    melodicGain.connect(mainGain);
    mainGain.connect(this.master);

    // Layer 3 is optional — only wire it up if the stem actually loaded.
    let layer3Src: AudioBufferSourceNode | null = null;
    let layer3Gain: GainNode | null = null;
    if (layer3Buf) {
      const layer3Peak = this.haloMusicLayer3Gain(variation);
      layer3Src = this.ctx.createBufferSource();
      layer3Src.buffer = layer3Buf;
      layer3Src.loop = true;
      layer3Gain = this.ctx.createGain();
      layer3Gain.gain.setValueAtTime(0.0001, startAt);
      if (layer3Active) {
        layer3Gain.gain.exponentialRampToValueAtTime(layer3Peak, startAt + 0.5);
      }
      layer3Src.connect(layer3Gain);
      layer3Gain.connect(mainGain);
    }

    // All sources start at exactly the same audio time so they remain
    // phase-locked for the lifetime of the music — switching the melodic
    // or layer-3 tier is then just a gain ramp, no fresh .start() that
    // would risk loop-phase drift between the stems.
    ambientSrc.start(startAt);
    melodicSrc.start(startAt);
    if (layer3Src) layer3Src.start(startAt);

    this.haloMusic = {
      ambientSrc, melodicSrc, layer3Src,
      ambientGain, melodicGain, layer3Gain, mainGain,
      variation, melodicActive,
      layer3Active: layer3Active && layer3Src !== null,
    };
  }

  // Fade the melodic layer in (true) or out (false). 0.5s fade-in matches the
  // legacy setHaloAmbientTier curve; 0.9s fade-out is slightly slower so a
  // single mistimed shot doesn't strip the melody abruptly.
  setHaloMusicMelodicLayer(active: boolean): void {
    if (!this.ctx || !this.haloMusic) return;
    if (this.haloMusic.melodicActive === active) return;
    const t = this.ctx.currentTime;
    const peakGain = this.haloMusicGain(this.haloMusic.variation);
    const target = active ? peakGain : 0.0001;
    const ramp = active ? 0.5 : 0.9;
    this.haloMusic.melodicGain.gain.cancelScheduledValues(t);
    this.haloMusic.melodicGain.gain.setValueAtTime(this.haloMusic.melodicGain.gain.value, t);
    this.haloMusic.melodicGain.gain.exponentialRampToValueAtTime(target, t + ramp);
    this.haloMusic.melodicActive = active;
  }

  // Fade layer 3 in (true) or out (false). Slightly slower fade-in than
  // melodic (0.7s vs 0.5s) so the 12x reward blooms in rather than snapping.
  // 1.1s fade-out cushions a combo break so the layer rings down instead of
  // cutting.
  setHaloMusicLayer3(active: boolean): void {
    if (!this.ctx || !this.haloMusic) return;
    if (!this.haloMusic.layer3Gain) return;
    if (this.haloMusic.layer3Active === active) return;
    const t = this.ctx.currentTime;
    const peakGain = this.haloMusicLayer3Gain(this.haloMusic.variation);
    const target = active ? peakGain : 0.0001;
    const ramp = active ? 0.7 : 1.1;
    this.haloMusic.layer3Gain.gain.cancelScheduledValues(t);
    this.haloMusic.layer3Gain.gain.setValueAtTime(this.haloMusic.layer3Gain.gain.value, t);
    this.haloMusic.layer3Gain.gain.exponentialRampToValueAtTime(target, t + ramp);
    this.haloMusic.layer3Active = active;
  }

  // Long fade-out + teardown. ~1.2s matches stopHaloAmbient so swapping
  // between the legacy pad and the pre-rendered music feels consistent on
  // combo break.
  stopHaloMusic(): void {
    if (!this.ctx || !this.haloMusic) return;
    const t = this.ctx.currentTime;
    const node = this.haloMusic;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    const stopAt = t + 1.3;
    node.ambientSrc.stop(stopAt);
    node.melodicSrc.stop(stopAt);
    if (node.layer3Src) node.layer3Src.stop(stopAt);
    this.haloMusic = null;
  }

  // Comet-on-screen toggle. Slides the third voice between E4 (no comet) and
  // Eb4 (comet present) over ~0.8s — slow enough to read as a mood shift,
  // fast enough that the player connects it to the comet's appearance.
  setHaloAmbientCometMode(active: boolean) {
    if (this.haloAmbientCometMode === active) return;
    this.haloAmbientCometMode = active;
    if (!this.ctx || !this.haloAmbient) return;
    const t = this.ctx.currentTime;
    const targetHz = active ? 311.13 : 329.63;
    this.haloAmbient.thirdOsc.frequency.cancelScheduledValues(t);
    this.haloAmbient.thirdOsc.frequency.setValueAtTime(this.haloAmbient.thirdOsc.frequency.value, t);
    this.haloAmbient.thirdOsc.frequency.exponentialRampToValueAtTime(targetHz, t + 0.8);
  }

  stopHaloAmbient() {
    if (!this.ctx || !this.haloAmbient) return;
    const t = this.ctx.currentTime;
    const node = this.haloAmbient;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    // ~1.2s fade-out — long enough that the loss of halo feels musical, not
    // a hard mute. Bass drones stay, so the bed under the pad keeps playing.
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    const stopAt = t + 1.3;
    for (const o of node.oscs) o.stop(stopAt);
    for (const l of node.lfos) l.stop(stopAt);
    if (node.melodyInterval !== null) clearInterval(node.melodyInterval);
    this.haloAmbient = null;
    this.haloAmbientTier = 0;
  }

  // Pilot's Log vocal loader. Files live at /sounds/vocals/... — pre-rendered
  // ElevenLabs takes with bandpass + bitcrush + hiss applied so they already
  // sound like a scratchy astronaut radio. Decoded once per URL and cached;
  // subsequent plays are buffer-source cheap.
  private loadPilotLogBuffer(url: string): Promise<AudioBuffer | null> {
    const existing = this.pilotLogLoading.get(url);
    if (existing) return existing;
    if (this.pilotLogBuffers.has(url)) return Promise.resolve(this.pilotLogBuffers.get(url)!);
    if (!this.ctx) return Promise.resolve(null);
    const ctx = this.ctx;
    const p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => (ab ? ctx.decodeAudioData(ab) : null))
      .then((buf) => {
        if (buf) this.pilotLogBuffers.set(url, buf);
        this.pilotLogLoading.delete(url);
        return buf;
      })
      .catch(() => {
        this.pilotLogLoading.delete(url);
        return null;
      });
    this.pilotLogLoading.set(url, p);
    return p;
  }

  // Warm the buffer cache so the first playPilotLog doesn't pay fetch+decode
  // latency. `milestone` is the combo threshold (6, 12, ...). For pooled
  // milestones this warms every take so whichever one gets randomly picked at
  // fire time is already decoded.
  preloadPilotLog(milestone: number): void {
    this.ensureContext();
    for (const url of pilotLogUrlsForIndex(milestone)) void this.loadPilotLogBuffer(url);
  }

  // Fire a Pilot's Log vocal cue for the given combo milestone. Picks one
  // file at random from the milestone's pool (so repeat plays don't sound
  // canned), then routes through bakedOut so master comp/reverb doesn't smear
  // the spoken word. `delaySec` lets the caller align to a downbeat.
  async playPilotLog(milestone: number, delaySec = 0, gain = 1.0): Promise<number> {
    if (!this.enabled) return 0;
    this.ensureContext();
    if (!this.ctx || !this.bakedOut) return 0;
    const urls = pilotLogUrlsForIndex(milestone);
    if (urls.length === 0) return 0;
    const url = urls[Math.floor(Math.random() * urls.length)];
    const targetStartTime = this.ctx.currentTime + Math.max(0, delaySec);
    const buf = await this.loadPilotLogBuffer(url);
    if (!buf || !this.ctx || !this.bakedOut) return 0;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.bakedOut);
    src.start(Math.max(this.ctx.currentTime, targetStartTime));
    return buf.duration;
  }

  // Lighter sibling of playBgBeat — used for the in-between eighths when the
  // background pulse doubles at white-bullet tier. Same voice as the main
  // beat (so it locks in tonally) at ~40% velocity so the new eighths read as
  // grace-note in-betweens, not as a thicker downbeat. Pitch is shifted up a
  // semitone (C#2 / D#2) so the bake cache stores it under a distinct key
  // from the main beat without re-baking on every dispatch.
  // Baked-only — matches playBgBeat's policy (see comment there for why the
  // live Tone fallback was removed). Light eighths only fire at combo ≥ 12,
  // which is many seconds into a run, so the bake cache is always warm by
  // the time this is reachable.
  playBgBeatLight(pitchRatio = 1) {
    if (!this.enabled) return;
    if (!this.ctx || !this.master) return;
    if (this.bgBeatIntensity <= 0) return;
    const intensity = Math.max(0, Math.min(1, this.bgBeatIntensity));
    const intensityBucket = Math.round(intensity * 10) / 10;
    // Light variant tagged in the bake key by a +1000 sentinel offset. Stays
    // unambiguous against the main beat's `pitchRatio * 100 + bucket`
    // encoding (max ~113) so the decode in bakeSound can identify "light" by
    // simply checking key > 500.
    const bgBeatPitchKey = pitchRatio * 100 + intensityBucket + 1000;
    this.playBaked("bgBeat", bgBeatPitchKey);
  }

  // Cached per requested duration. The samples are pure random noise — there's
  // no perceptible difference between "fresh noise every spawn" and a single
  // shared buffer, but allocating + filling a 6s buffer (264k samples) on every
  // bassteroid spawn was a noticeable main-thread stutter on slower devices.
  private noiseBufferCache: Map<number, AudioBuffer> = new Map();
  private makeNoiseBuffer(duration: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const cached = this.noiseBufferCache.get(duration);
    if (cached) return cached;
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buf = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBufferCache.set(duration, buf);
    return buf;
  }

  play(name: SoundName, pitchRatio = 1, pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;

    // Universal volume + pitch knobs (from sounds/config.json). Volume is
    // applied by routing all voices of this call through a per-call gain
    // node sitting between master and the rest of the chain; we swap
    // this.master temporarily, run the play method (which connects its
    // voices into "master" — actually our voice gain), then restore. The
    // voice gain stays connected to the real master so its nodes outlive
    // the swap.
    //
    // Positional audio piggybacks on the same swap: when pos is provided we
    // insert a StereoPanner + distance-gain pair upstream of the (possibly
    // volume-adjusted) voice gain. The cached bakedOut path is spliced
    // separately inside playBaked.
    const u = cfgU(name);
    const effectivePitch = pitchRatio * u.pitch;
    const realMaster = this.master;
    // Build the chain bottom-up: sink = (volume gain → realMaster) if volume
    // differs, else realMaster. Then if positional, splice panner+distGain
    // upstream of sink. Finally we always swap this.master to a per-call
    // pass-through gain whose output feeds the chain — that way every
    // per-sound helper still calls `connect(this.master)` (a GainNode) and
    // we don't need to widen master's type.
    let sink: AudioNode = realMaster;
    if (u.volume !== 1) {
      const volGain = this.ctx.createGain();
      volGain.gain.value = u.volume;
      volGain.connect(sink);
      sink = volGain;
    }
    if (pos) {
      const spatial = this.makeSpatial(pos, sink);
      if (spatial) sink = spatial.panner;
    }
    let voiceMaster: GainNode | null = null;
    if (sink !== realMaster) {
      voiceMaster = this.ctx.createGain();
      voiceMaster.connect(sink);
      this.master = voiceMaster;
    }
    // Stash so playBaked can pick the same splice up without re-threading
    // pos through every per-sound helper.
    this.spatialPosForCall = pos ?? null;

    switch (name) {
      case "fire": this.playFire(); break;
      case "fireBeat": this.playFireBeat(); break;
      case "explosionLarge": this.playExplosion(cfgN("explosionLarge", "volume", 0.7), cfgN("explosionLarge", "lowpassStart", 160), cfgN("explosionLarge", "duration", 0.55)); break;
      case "explosionMedium": this.playExplosion(cfgN("explosionMedium", "volume", 0.55), cfgN("explosionMedium", "lowpassStart", 230), cfgN("explosionMedium", "duration", 0.42)); break;
      case "explosionSmall": this.playExplosion(cfgN("explosionSmall", "volume", 0.4), cfgN("explosionSmall", "lowpassStart", 340), cfgN("explosionSmall", "duration", 0.3)); break;
      case "asteroidBoomBeat": this.playAsteroidBoomBeat(); break;
      case "thrust": this.startThrust(); break;
      case "reverseThrust": this.startReverseThrust(); break;
      case "sideThrust": this.startSideThrust(); break;
      case "death": this.playDeath(); break;
      case "waveClear": this.playWaveClear(); break;
      case "bassKick": this.playBassKick(effectivePitch); break;
      case "bassPluck": this.playBassPluck(effectivePitch); break;
      case "bassBoom": this.playBassBoom(effectivePitch); break;
      case "bassSnap": this.playBassSnap(effectivePitch); break;
      case "bassHit": this.playBassHit(); break;
      case "bassEcho": this.playBassEcho(); break;
      case "chime": this.playChime(); break;
      case "bell": this.playBell(); break;
      case "warble": this.playWarble(); break;
      case "comboTick": this.playComboTick(); break;
      case "comboSparkle": this.playComboSparkle(); break;
      case "tink": this.playTink(); break;
      case "scoreBlip": this.playScoreBlip(effectivePitch); break;
      case "summaryDownbeat": this.playSummaryDownbeat(Math.round(pitchRatio)); break;
      case "powerup": this.playPowerup(); break;
      case "shieldPop": this.playShieldPop(); break;
      case "pulsarHum": this.playPulsarHum(); break;
      case "bgBeat": this.playBgBeat(effectivePitch); break;
      case "shockwaveCharge": this.playShockwaveCharge(); break;
      case "shockwaveBoom": this.playShockwaveBoom(); break;
      case "alienFireBig": this.playAlienFireBig(); break;
      case "alienFireMedium": this.playAlienFireMedium(); break;
      case "alienFireSmall": this.playAlienFireSmall(); break;
      case "alienHit": this.playAlienHit(); break;
      case "alienExplode": this.playAlienExplode(); break;
      case "cometNote": this.playCometNote(Math.round(effectivePitch)); break;
      case "cometDestroyed": this.playCometDestroyed(); break;
      case "cometDestroyedSad": this.playCometDestroyedSad(); break;
      case "canisterAppear": this.playCanisterAppear(); break;
      case "canisterDestroyed": this.playCanisterDestroyed(); break;
      case "comboLost": this.playComboLost(); break;
    }

    this.master = realMaster;
    this.spatialPosForCall = null;
  }

  // Three alien-fire voices, harmonically related so they layer cleanly with
  // the bassteroid bed (C major / I-iii-V flavour). All three open with a
  // brief portamento-style pitch bend so each shot reads as "musical noise"
  // rather than a sterile bleep, and each leans on a different timbre so the
  // player can tell which size fired from sound alone.
  //
  // big    : C3 (130.8 Hz) — deep brassy sawtooth swell, slow attack, long
  //          tail. Sits one octave below the medium so the slow 1-shot-per-2-
  //          beats cadence reads as the bassline of the alien's "song".
  // medium : E4 (329.6 Hz) — square-wave pluck with a bit of detune for
  //          chorus. Mid-range; pairs with bg-beat downbeats.
  // small  : G5 (784 Hz) — sharp triangle pluck with a fast vibrato, sits
  //          on top of the mix as a melodic ostinato when several smalls
  //          are firing in succession.

  private playAlienFireBig() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // Carrier: sawtooth bending up half a semitone over the attack, then
    // sustained. Two oscs slightly detuned for body.
    const f0 = 130.8; // C3
    const oscA = this.ctx.createOscillator();
    const oscB = this.ctx.createOscillator();
    oscA.type = "sawtooth";
    oscB.type = "sawtooth";
    oscA.frequency.setValueAtTime(f0 * 0.94, t);
    oscA.frequency.exponentialRampToValueAtTime(f0, t + 0.08);
    oscB.frequency.setValueAtTime(f0 * 0.94 * 1.006, t);
    oscB.frequency.exponentialRampToValueAtTime(f0 * 1.006, t + 0.08);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(420, t);
    filter.frequency.exponentialRampToValueAtTime(1400, t + 0.06);
    filter.frequency.exponentialRampToValueAtTime(380, t + 0.45);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.32, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    oscA.start(t);
    oscB.start(t);
    oscA.stop(t + 0.6);
    oscB.stop(t + 0.6);

    // Octave shimmer — a sine one octave up that fades in late, giving the
    // shot a "lifting off" quality.
    const sh = this.ctx.createOscillator();
    sh.type = "sine";
    sh.frequency.value = f0 * 2;
    const shGain = this.ctx.createGain();
    shGain.gain.setValueAtTime(0.0001, t);
    shGain.gain.exponentialRampToValueAtTime(0.09, t + 0.12);
    shGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    sh.connect(shGain);
    shGain.connect(this.master);
    sh.start(t);
    sh.stop(t + 0.55);
  }

  private playAlienFireMedium() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const f0 = 329.6; // E4
    // Square pluck — bright, characterful, very 8-bit alien.
    const oscA = this.ctx.createOscillator();
    const oscB = this.ctx.createOscillator();
    oscA.type = "square";
    oscB.type = "square";
    oscA.frequency.setValueAtTime(f0 * 0.95, t);
    oscA.frequency.exponentialRampToValueAtTime(f0, t + 0.05);
    oscB.frequency.setValueAtTime(f0 * 0.95 * 1.008, t);
    oscB.frequency.exponentialRampToValueAtTime(f0 * 1.008, t + 0.05);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(2400, t);
    filter.frequency.exponentialRampToValueAtTime(700, t + 0.35);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    oscA.start(t);
    oscB.start(t);
    oscA.stop(t + 0.42);
    oscB.stop(t + 0.42);

    // Tiny click at attack so the shot "lands" rhythmically.
    const clickBuf = this.makeNoiseBuffer(0.025);
    if (!clickBuf) return;
    const click = this.ctx.createBufferSource();
    click.buffer = clickBuf;
    const clickFilter = this.ctx.createBiquadFilter();
    clickFilter.type = "highpass";
    clickFilter.frequency.value = 2200;
    const clickGain = this.ctx.createGain();
    clickGain.gain.setValueAtTime(0.08, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(this.master);
    click.start(t);
    click.stop(t + 0.03);
  }

  private playAlienFireSmall() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const f0 = 784; // G5
    // Triangle carrier with a fast vibrato — sits in the upper mid, doesn't
    // mask anything else even when fired every half-beat.
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(f0 * 0.95, t);
    osc.frequency.exponentialRampToValueAtTime(f0, t + 0.025);
    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 16;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.value = 18;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.frequency);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.13, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.18);
    lfo.stop(t + 0.18);

    // Tiny upward partial — fifth above — gives each shot a 8-bit chip
    // character.
    const p2 = this.ctx.createOscillator();
    p2.type = "sine";
    p2.frequency.value = f0 * 1.5;
    const p2Gain = this.ctx.createGain();
    p2Gain.gain.setValueAtTime(0.0001, t);
    p2Gain.gain.exponentialRampToValueAtTime(0.05, t + 0.004);
    p2Gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    p2.connect(p2Gain);
    p2Gain.connect(this.master);
    p2.start(t);
    p2.stop(t + 0.1);
  }

  // Non-killing alien hit — short metallic spank that says "I dinged it"
  // without being as heavy as bassHit. Bandpassed noise + a high triangle
  // ping.
  private playAlienHit() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const noiseBuf = this.makeNoiseBuffer(0.08);
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(2400, t);
    filter.frequency.exponentialRampToValueAtTime(1200, t + 0.08);
    filter.Q.value = 1.4;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.22, t);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.1);

    const ping = this.ctx.createOscillator();
    ping.type = "triangle";
    ping.frequency.setValueAtTime(1320, t);
    ping.frequency.exponentialRampToValueAtTime(660, t + 0.1);
    const pingGain = this.ctx.createGain();
    pingGain.gain.setValueAtTime(0.0001, t);
    pingGain.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
    pingGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    ping.connect(pingGain);
    pingGain.connect(this.master);
    ping.start(t);
    ping.stop(t + 0.15);
  }

  // Alien destruction — a small requiem: a brief breath of hit-noise, a
  // mournful Eb temple-bell (b3 of C, the minor colour the halo lives in),
  // a sine sigh falling G4→Eb4→C4→Bb3 with the lowpass closing down like a
  // voice trailing off, and a faint C2 sub that swells in late and lingers
  // as the absence. No explosion thud — the kill should land as loss.
  private playAlienExplode() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;

    // Gasp — bandpassed noise puff, short and high so it reads as a breath
    // catching rather than a body bursting.
    const gaspBuf = this.makeNoiseBuffer(0.18);
    if (gaspBuf) {
      const gasp = this.ctx.createBufferSource();
      gasp.buffer = gaspBuf;
      const gFilter = this.ctx.createBiquadFilter();
      gFilter.type = "bandpass";
      gFilter.frequency.setValueAtTime(1800, t);
      gFilter.frequency.exponentialRampToValueAtTime(700, t + 0.18);
      gFilter.Q.value = 2.2;
      const gGain = this.ctx.createGain();
      gGain.gain.setValueAtTime(0.0001, t);
      gGain.gain.exponentialRampToValueAtTime(0.12, t + 0.012);
      gGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      gasp.connect(gFilter);
      gFilter.connect(gGain);
      gGain.connect(this.master);
      gasp.start(t);
      gasp.stop(t + 0.22);
    }

    // Eb temple bell with inharmonic partials. Same DNA as playBell — ratios
    // 2.76 / 5.4 / 8.93 give the tolled-bell timbre — but tuned to Eb4 and
    // given a much longer decay so the note hangs and mourns.
    const bellFund = 311.13; // Eb4 — b3 of C minor, the mode's grief pitch
    const bellRatios = [1, 2.76, 5.4, 8.93];
    const bellPeak = 0.18;
    const bellDecay = 2.6;
    for (let i = 0; i < bellRatios.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = bellFund * bellRatios[i];
      const peak = bellPeak / (i + 1.4);
      const decay = Math.max(0.4, bellDecay - i * 0.35);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }

    // The sigh — sine glissando G4 → Eb4 → C4 → Bb3 over ~0.9s, a voice
    // settling downward through the C-minor scale and out. Lowpass closes
    // as it falls so the timbre darkens with the pitch.
    const sigh = this.ctx.createOscillator();
    sigh.type = "sine";
    sigh.frequency.setValueAtTime(392.00, t + 0.04);        // G4
    sigh.frequency.exponentialRampToValueAtTime(311.13, t + 0.32); // Eb4
    sigh.frequency.exponentialRampToValueAtTime(261.63, t + 0.62); // C4
    sigh.frequency.exponentialRampToValueAtTime(233.08, t + 0.95); // Bb3
    const sighFilter = this.ctx.createBiquadFilter();
    sighFilter.type = "lowpass";
    sighFilter.Q.value = 0.9;
    sighFilter.frequency.setValueAtTime(1800, t);
    sighFilter.frequency.exponentialRampToValueAtTime(420, t + 1.0);
    const sighGain = this.ctx.createGain();
    sighGain.gain.setValueAtTime(0.0001, t);
    sighGain.gain.exponentialRampToValueAtTime(0.14, t + 0.08);
    sighGain.gain.setTargetAtTime(0.08, t + 0.4, 0.25);
    sighGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
    sigh.connect(sighFilter);
    sighFilter.connect(sighGain);
    sighGain.connect(this.master);
    sigh.start(t + 0.04);
    sigh.stop(t + 1.1);

    // The absence — a C2 sub that fades in late, after the sigh is gone,
    // and lingers as the chest-pressure of "something is missing now".
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 65.41; // C2
    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    subGain.gain.exponentialRampToValueAtTime(0.18, t + 1.1);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 2.7);
  }

  // Long tension-building windup played while the pulsar vibrates and spins
  // itself up. Length matches Pulsar.SHOCK_VIBRATE_DURATION (5.0s) so it
  // tops out exactly as the flash fires. Layers a deep sub that holds low
  // then climbs into the drop, a near-DC sine for chest pressure, an
  // accelerating "spin-up whine" whose frequency tracks the pulsar's
  // quadratic angular acceleration on screen, and a snare-roll noise wash
  // that ducks to silence right before the apex.
  private playShockwaveCharge() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const duration = 5.0;

    // Sub carrier — held low for the first 60% of the windup then sweeps up
    // sharply so the tension peak lands right before the drop.
    const sub = this.ctx.createOscillator();
    sub.type = "sawtooth";
    sub.frequency.setValueAtTime(28, t);
    sub.frequency.exponentialRampToValueAtTime(36, t + duration * 0.6);
    sub.frequency.exponentialRampToValueAtTime(190, t + duration);
    const subFilter = this.ctx.createBiquadFilter();
    subFilter.type = "lowpass";
    subFilter.Q.value = 8;
    subFilter.frequency.setValueAtTime(120, t);
    subFilter.frequency.exponentialRampToValueAtTime(900, t + duration);
    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.42, t + duration);
    sub.connect(subFilter);
    subFilter.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + duration + 0.05);

    // Near-DC reinforcement — gives the long windup real chest pressure even
    // before the sub carrier starts climbing.
    const subSine = this.ctx.createOscillator();
    subSine.type = "sine";
    subSine.frequency.setValueAtTime(22, t);
    subSine.frequency.exponentialRampToValueAtTime(90, t + duration);
    const subSineGain = this.ctx.createGain();
    subSineGain.gain.setValueAtTime(0.0001, t);
    subSineGain.gain.exponentialRampToValueAtTime(0.55, t + duration);
    subSine.connect(subSineGain);
    subSineGain.connect(this.master);
    subSine.start(t);
    subSine.stop(t + duration + 0.05);

    // Spin-up whine. Frequency rises quadratically in t (matches the
    // quadratic angular acceleration on the visual side) so the player hears
    // the pulsar speeding up. We sample the curve at 24 control points so
    // it sweeps smoothly without us having to schedule one ramp per frame.
    const whine = this.ctx.createOscillator();
    whine.type = "sawtooth";
    const startHz = 120;
    const endHz = 1800;
    const samples = 24;
    whine.frequency.setValueAtTime(startHz, t);
    for (let i = 1; i <= samples; i++) {
      const ti = i / samples;
      const f = startHz + (endHz - startHz) * ti * ti;
      whine.frequency.linearRampToValueAtTime(f, t + ti * duration);
    }
    const whineFilter = this.ctx.createBiquadFilter();
    whineFilter.type = "bandpass";
    whineFilter.Q.value = 3;
    whineFilter.frequency.setValueAtTime(startHz, t);
    whineFilter.frequency.exponentialRampToValueAtTime(endHz, t + duration);
    const whineGain = this.ctx.createGain();
    whineGain.gain.setValueAtTime(0.0001, t);
    // Stays quiet for the first second so the windup builds, then climbs
    // hard. Capped well below the sub so the spin-up colours the sound
    // rather than dominating it.
    whineGain.gain.exponentialRampToValueAtTime(0.04, t + duration * 0.4);
    whineGain.gain.exponentialRampToValueAtTime(0.22, t + duration);
    whine.connect(whineFilter);
    whineFilter.connect(whineGain);
    whineGain.connect(this.master);
    whine.start(t);
    whine.stop(t + duration + 0.05);

    // Tail-end "snare roll" noise wash — accelerates the same way the visual
    // jitter does, so the last second feels like the universe is about to
    // tear. Bandpass swept upward; gain ramps in late and ducks just before
    // the drop to leave silence at the apex.
    const noiseBuf = this.makeNoiseBuffer(duration);
    if (noiseBuf) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = "bandpass";
      nFilter.frequency.setValueAtTime(400, t);
      nFilter.frequency.exponentialRampToValueAtTime(3500, t + duration);
      nFilter.Q.value = 1.2;
      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + duration * 0.5);
      nGain.gain.exponentialRampToValueAtTime(0.18, t + duration * 0.95);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(this.master);
      noise.start(t);
      noise.stop(t + duration + 0.05);
    }
  }

  // Bass drop — the payoff for the long windup. Deep sub fundamental that
  // punches in at t=0, fat saw body pitching down, square sub-octave growl
  // for grit, and a wide noise wash for the wavefront. Designed to feel
  // like the floor dropping out under the player.
  private playShockwaveBoom() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;

    // Sub thud — louder, lower, and with a long decay so the floor stays
    // gone for a beat.
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(95, t);
    sub.frequency.exponentialRampToValueAtTime(12, t + 1.0);
    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(1.0, t + 0.012);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 3.3);

    // Body — fat sawtooth pitch-down with hard front transient.
    const body = this.ctx.createOscillator();
    body.type = "sawtooth";
    body.frequency.setValueAtTime(150, t);
    body.frequency.exponentialRampToValueAtTime(22, t + 1.2);
    const bodyFilter = this.ctx.createBiquadFilter();
    bodyFilter.type = "lowpass";
    bodyFilter.Q.value = 4;
    bodyFilter.frequency.setValueAtTime(900, t);
    bodyFilter.frequency.exponentialRampToValueAtTime(90, t + 2.5);
    const bodyGain = this.ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.85, t + 0.02);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 3.0);
    body.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(this.master);
    body.start(t);
    body.stop(t + 3.1);

    // Square sub-octave growl — adds the gritty edge classic bass drops have
    // without taking the low end out of pure-sine territory.
    const growl = this.ctx.createOscillator();
    growl.type = "square";
    growl.frequency.setValueAtTime(58, t);
    growl.frequency.exponentialRampToValueAtTime(20, t + 1.4);
    const growlFilter = this.ctx.createBiquadFilter();
    growlFilter.type = "lowpass";
    growlFilter.Q.value = 2;
    growlFilter.frequency.setValueAtTime(220, t);
    growlFilter.frequency.exponentialRampToValueAtTime(70, t + 2.0);
    const growlGain = this.ctx.createGain();
    growlGain.gain.setValueAtTime(0.0001, t);
    growlGain.gain.exponentialRampToValueAtTime(0.32, t + 0.03);
    growlGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    growl.connect(growlFilter);
    growlFilter.connect(growlGain);
    growlGain.connect(this.master);
    growl.start(t);
    growl.stop(t + 2.5);

    // Wide noise wash — the wavefront passing over you.
    const noiseBuf = this.makeNoiseBuffer(2.5);
    if (noiseBuf) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = "bandpass";
      nFilter.frequency.setValueAtTime(1600, t);
      nFilter.frequency.exponentialRampToValueAtTime(60, t + 1.8);
      nFilter.Q.value = 1.0;
      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.exponentialRampToValueAtTime(0.48, t + 0.025);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(this.master);
      noise.start(t);
      noise.stop(t + 2.5);
    }
  }

  // ~20-second deep "brrrmmm" drone played on wave clear. Two slightly
  // detuned sawtooths at ~50–58 Hz pushed through a slow-sweeping lowpass,
  // plus a sub sine for the chest-thump and a quiet noise wash for breath.
  // The whole bus envelopes up fast and decays quickly so the tremolo swells
  // read as in-time pulses rather than a long sustained hum.
  private playPulsarHum() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const duration = 20;

    // Decay quickly so the bass hum doesn't drown out subsequent beats —
    // most of the audible body lives in the first ~3 seconds.
    const bus = this.ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(0.32, t + 0.3);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
    bus.connect(this.master);

    // Tremolo locked to 2× the beat rate (BEAT_GRID = 0.5s → 2 Hz beat, so
    // 4 Hz tremolo). Depth bumped up so each pulse reads distinctly.
    const tremoloGain = this.ctx.createGain();
    tremoloGain.gain.value = 1.0;
    tremoloGain.connect(bus);
    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 4;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.value = 0.55;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain);
    lfo.start(t);
    lfo.stop(t + duration + 0.2);

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(180, t);
    filter.frequency.exponentialRampToValueAtTime(520, t + 1.5);
    filter.frequency.exponentialRampToValueAtTime(120, t + duration);
    filter.connect(tremoloGain);

    const saw1 = this.ctx.createOscillator();
    saw1.type = "sawtooth";
    saw1.frequency.value = 51;
    const saw2 = this.ctx.createOscillator();
    saw2.type = "sawtooth";
    saw2.frequency.value = 57.3;
    saw1.connect(filter);
    saw2.connect(filter);
    saw1.start(t);
    saw2.start(t);
    saw1.stop(t + duration + 0.2);
    saw2.stop(t + duration + 0.2);

    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 36;
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.6;
    sub.connect(subGain);
    subGain.connect(bus);
    sub.start(t);
    sub.stop(t + duration + 0.2);

    const noiseBuf = this.makeNoiseBuffer(duration + 0.5);
    if (noiseBuf) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = "bandpass";
      nFilter.frequency.value = 240;
      nFilter.Q.value = 1.5;
      const nGain = this.ctx.createGain();
      nGain.gain.value = 0.08;
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(bus);
      noise.start(t);
      noise.stop(t + duration + 0.2);
    }
  }

  // Background "pulsar approach" beat — a deep sub-bass thud that fires on
  // every BEAT_GRID tick from Game. Volume scales with bgBeatIntensity (set
  // per wave, 0 at wave 1 → 1 at wave 30) so it interpolates from fainter-
  // than-any-other-sound up to an ominous rumble as the pulsar gets close.
  // pitchRatio carries the on/off-beat flag from the caller: 1.0 on downbeats,
  // slightly above 1 on offbeats so the pattern reads as a heartbeat rhythm
  // rather than a flat metronome.
  //
  // Baked-only: the live Tone fallback was removed because its scheduler
  // lookahead (~100ms) made the first few beats land late before the bake
  // cache warmed up, then "snap" onto the grid mid-run — the perceptual
  // effect was the early beats sounding clustered/faster than they should
  // be. Dropping the fallback means the first beat or two during cache
  // warmup may go silent — far less disorienting than late thuds, and
  // warmBakedCache now queues the early-wave downbeat buckets first so the
  // silent window is short. Intensity/offbeat amplitude is encoded into the
  // baked buffer at bake time (see the bgBeat case in bakeSound).
  private playBgBeat(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;
    if (this.bgBeatIntensity <= 0) return;
    const intensity = Math.max(0, Math.min(1, this.bgBeatIntensity));
    const intensityBucket = Math.round(intensity * 10) / 10;
    const bgBeatPitchKey = pitchRatio * 100 + intensityBucket;
    this.playBaked("bgBeat", bgBeatPitchKey);
  }

  // Plucked-string "pew" for non-rhythm shots — quieter and shorter than
  // the on-beat version (playFireBeat) so untimed fire feels like the weak
  // mode and the rhythm shot is the obvious power tier. Same musical-pluck
  // shape (G4 fundamental, octave partial, soft tick) at reduced gain.
  private playFire() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const bodyHz = cfgN("fire", "bodyHz", 392);
    const bodyPeak = cfgN("fire", "bodyPeak", 0.16);
    const bodyDecay = cfgN("fire", "bodyDecay", 0.11);
    const partialHz = cfgN("fire", "partialHz", 784);
    const partialPeak = cfgN("fire", "partialPeak", 0.07);
    const partialDecay = cfgN("fire", "partialDecay", 0.05);
    const tickHz = cfgN("fire", "tickHz", 1600);
    const tickQ = cfgN("fire", "tickQ", 1.2);
    const tickPeak = cfgN("fire", "tickPeak", 0.04);
    const tickDecay = cfgN("fire", "tickDecay", 0.02);

    const body = this.ctx.createOscillator();
    const bodyGain = this.ctx.createGain();
    body.type = "sine";
    body.frequency.value = bodyHz;
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(bodyPeak, t + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + bodyDecay);
    body.connect(bodyGain);
    bodyGain.connect(this.master);
    body.start(t);
    body.stop(t + bodyDecay + 0.02);

    const partial = this.ctx.createOscillator();
    const partialGain = this.ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = partialHz;
    partialGain.gain.setValueAtTime(0.0001, t);
    partialGain.gain.exponentialRampToValueAtTime(partialPeak, t + 0.003);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t + partialDecay);
    partial.connect(partialGain);
    partialGain.connect(this.master);
    partial.start(t);
    partial.stop(t + partialDecay + 0.02);

    const tickBuf = this.makeNoiseBuffer(Math.max(tickDecay, 0.005));
    if (!tickBuf) return;
    const tick = this.ctx.createBufferSource();
    tick.buffer = tickBuf;
    const tickFilter = this.ctx.createBiquadFilter();
    tickFilter.type = "bandpass";
    tickFilter.frequency.value = tickHz;
    tickFilter.Q.value = tickQ;
    const tickGain = this.ctx.createGain();
    tickGain.gain.setValueAtTime(tickPeak, t);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, t + tickDecay);
    tick.connect(tickFilter);
    tickFilter.connect(tickGain);
    tickGain.connect(this.master);
    tick.start(t);
    tick.stop(t + tickDecay + 0.005);
  }

  // Deeper "thump" pluck for rhythm shots — same musical-pluck shape as
  // playFire but tuned an octave-and-a-half lower (C3 carrier instead of
  // G4) with a sub-octave reinforcement at C2 and a perfect-fifth partial
  // at G3 for body. Wood-thump bandpassed tick around 600 Hz instead of
  // the 1.6 kHz "thumb pad" — gives the attack a heavier wooden character
  // rather than a tight zing. Louder + longer tail than playFire so the
  // player can feel the weight of a timed shot.
  private playFireBeat() {
    if (this.playBaked("fireBeat", 1)) return;
    const eng = this.ensureToneEngine();
    if (!eng) return;
    eng.fireBeatBody.triggerAttackRelease("C3", "16n", undefined, 0.9);
    eng.fireBeatPluck.triggerAttack("G4");
  }

  private playExplosion(volume: number, lowpassStart: number, duration: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const noiseBuf = this.makeNoiseBuffer(duration);
    if (!noiseBuf) return;
    const source = this.ctx.createBufferSource();
    source.buffer = noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(lowpassStart * 4, t);
    filter.frequency.exponentialRampToValueAtTime(lowpassStart * 0.4, t + duration);
    filter.Q.value = 1.2;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(t);
    source.stop(t + duration);

    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(lowpassStart * 0.6, t);
    sub.frequency.exponentialRampToValueAtTime(40, t + duration * 0.8);
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(volume * 0.45, t + 0.02);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + duration);
  }

  // Big odaiko boom for on-beat plain-asteroid kills. Fully hand-built,
  // routed direct-to-master to bypass the Tone bus (chorus + reverb on
  // sub-bass content phase-cancels and saps perceived weight — exactly the
  // "tinny" character we kept hearing). Four layers, all peaking at t=0 so
  // the perceived hit lands exactly when the explosion's noise burst does:
  //
  //   1. Boom body at 90→55 Hz — sine sweep in the *audible* boom band.
  //      This is where humans actually hear "boom"; everything below 60 Hz
  //      is felt, not heard. Loud (peak 1.6) and short attack (1.5 ms) so
  //      the peak lands within one frame of the explosion.
  //   2. Sub anchor at 50→32 Hz — the chest-thump layer. Big speakers feel
  //      it; small speakers can't reproduce it, hence the boom band above.
  //   3. Transient click — a 6 ms filtered noise burst at the very front,
  //      gives the hit an unambiguous attack edge that aligns the perceived
  //      onset with the explosion's noise crack.
  //   4. Wood-shell tail — bandpassed brown noise centred at 180 Hz,
  //      tapering over 600 ms. Adds the resonating-drum-shell texture
  //      without competing with the noise of the explosion crash.
  //
  // All four start at exactly ctx.currentTime — no pre-delay, no pitch
  // ramp that lags the perceived peak. Peak alignment with the explosion's
  // 10 ms attack is the key fix from the previous iteration.
  private boomConvolverIR: AudioBuffer | null = null;
  private getBoomReverbIR(): AudioBuffer | null {
    if (!this.ctx) return null;
    if (this.boomConvolverIR) return this.boomConvolverIR;
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 1.3);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        const env = Math.pow(1 - x, 3.0);
        const lowBias = 0.6 + 0.4 * Math.sin(i * 0.0009 + ch);
        data[i] = (Math.random() * 2 - 1) * env * lowBias;
      }
    }
    this.boomConvolverIR = buf;
    return buf;
  }

  private makeBoomSaturator(amount: number): WaveShaperNode | null {
    if (!this.ctx) return null;
    const ws = this.ctx.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    const k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    ws.curve = curve;
    ws.oversample = "4x";
    return ws;
  }

  private playAsteroidBoomBeat() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const tail = 1.0;

    const jitter = 1 + (Math.random() - 0.5) * 0.06;

    const convolver = this.ctx.createConvolver();
    const ir = this.getBoomReverbIR();
    if (ir) convolver.buffer = ir;
    const wetGain = this.ctx.createGain();
    wetGain.gain.value = 0.32;
    convolver.connect(wetGain);
    wetGain.connect(this.master);

    const lowShelf = this.ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 130;
    lowShelf.gain.value = 3.5;
    lowShelf.connect(this.master);
    lowShelf.connect(convolver);

    const body = this.ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(110 * jitter, t);
    body.frequency.exponentialRampToValueAtTime(65 * jitter, t + 0.18);
    const bodyGain = this.ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(1.3, t + 0.002);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + tail);
    const bodySat = this.makeBoomSaturator(2.0);
    body.connect(bodyGain);
    if (bodySat) {
      bodyGain.connect(bodySat);
      bodySat.connect(lowShelf);
    } else {
      bodyGain.connect(lowShelf);
    }
    body.start(t);
    body.stop(t + tail);

    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(60 * jitter, t);
    sub.frequency.exponentialRampToValueAtTime(38 * jitter, t + 0.35);
    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(1.4, t + 0.003);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + tail + 0.15);
    sub.connect(subGain);
    subGain.connect(lowShelf);
    sub.start(t);
    sub.stop(t + tail + 0.15);

    const thumpBuf = this.makeNoiseBuffer(0.14);
    if (thumpBuf) {
      const thump = this.ctx.createBufferSource();
      thump.buffer = thumpBuf;
      const thumpFilter = this.ctx.createBiquadFilter();
      thumpFilter.type = "bandpass";
      thumpFilter.Q.value = 1.0;
      thumpFilter.frequency.setValueAtTime(230, t);
      thumpFilter.frequency.exponentialRampToValueAtTime(150, t + 0.14);
      const thumpGain = this.ctx.createGain();
      thumpGain.gain.setValueAtTime(0.0001, t);
      thumpGain.gain.exponentialRampToValueAtTime(0.75, t + 0.003);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      thump.connect(thumpFilter);
      thumpFilter.connect(thumpGain);
      thumpGain.connect(lowShelf);
      thump.start(t);
      thump.stop(t + 0.15);
    }

    const clickBuf = this.makeNoiseBuffer(0.018);
    if (clickBuf) {
      const click = this.ctx.createBufferSource();
      click.buffer = clickBuf;
      const clickFilter = this.ctx.createBiquadFilter();
      clickFilter.type = "bandpass";
      clickFilter.Q.value = 0.9;
      clickFilter.frequency.value = 340;
      const clickGain = this.ctx.createGain();
      clickGain.gain.setValueAtTime(0.0001, t);
      clickGain.gain.exponentialRampToValueAtTime(0.65, t + 0.001);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
      click.connect(clickFilter);
      clickFilter.connect(clickGain);
      clickGain.connect(this.master);
      clickGain.connect(convolver);
      click.start(t);
      click.stop(t + 0.018);
    }

    const shellBuf = this.makeNoiseBuffer(0.65);
    if (shellBuf) {
      const shell = this.ctx.createBufferSource();
      shell.buffer = shellBuf;
      const shellFilter = this.ctx.createBiquadFilter();
      shellFilter.type = "bandpass";
      shellFilter.Q.value = 1.8;
      shellFilter.frequency.setValueAtTime(260, t);
      shellFilter.frequency.exponentialRampToValueAtTime(120, t + 0.6);
      const shellGain = this.ctx.createGain();
      shellGain.gain.setValueAtTime(0.0001, t);
      shellGain.gain.exponentialRampToValueAtTime(0.55, t + 0.005);
      shellGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
      shell.connect(shellFilter);
      shellFilter.connect(shellGain);
      shellGain.connect(lowShelf);
      shell.start(t);
      shell.stop(t + 0.65);
    }
  }

  private startThrust() {
    if (!this.ctx || !this.master) return;
    if (this.thrustNode) return;
    const t = this.ctx.currentTime;

    const tri1 = this.ctx.createOscillator();
    tri1.type = "triangle";
    tri1.frequency.value = 110.0;
    const tri2 = this.ctx.createOscillator();
    tri2.type = "triangle";
    tri2.frequency.value = 110.7;
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 55.0;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;
    filter.Q.value = 0.7;

    const tremoloGain = this.ctx.createGain();
    tremoloGain.gain.value = 1.0;

    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.value = 0.08;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain);

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(0.16, t + 0.08);

    tri1.connect(filter);
    tri2.connect(filter);
    sub.connect(filter);
    filter.connect(tremoloGain);
    tremoloGain.connect(mainGain);
    mainGain.connect(this.master);

    tri1.start(t);
    tri2.start(t);
    sub.start(t);
    lfo.start(t);

    this.thrustNode = { tri1, tri2, sub, lfo, lfoDepth, filter, tremoloGain, mainGain };
  }

  stopThrust() {
    if (!this.ctx || !this.thrustNode) return;
    const t = this.ctx.currentTime;
    const { tri1, tri2, sub, lfo, mainGain } = this.thrustNode;
    mainGain.gain.cancelScheduledValues(t);
    mainGain.gain.setValueAtTime(mainGain.gain.value, t);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    tri1.stop(t + 0.1);
    tri2.stop(t + 0.1);
    sub.stop(t + 0.1);
    lfo.stop(t + 0.1);
    this.thrustNode = null;
  }

  // Deeper sibling of startThrust — same architecture, lower oscillator
  // frequencies and a darker filter cutoff so the retro-jets read as a
  // heavier, lower-pitched rumble than the forward thrusters.
  private startReverseThrust() {
    if (!this.ctx || !this.master) return;
    if (this.reverseThrustNode) return;
    const t = this.ctx.currentTime;

    const tri1 = this.ctx.createOscillator();
    tri1.type = "triangle";
    tri1.frequency.value = 72.0;
    const tri2 = this.ctx.createOscillator();
    tri2.type = "triangle";
    tri2.frequency.value = 72.5;
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 36.0;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 800;
    filter.Q.value = 0.7;

    const tremoloGain = this.ctx.createGain();
    tremoloGain.gain.value = 1.0;

    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 4.2;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.value = 0.08;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain);

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(0.16, t + 0.08);

    tri1.connect(filter);
    tri2.connect(filter);
    sub.connect(filter);
    filter.connect(tremoloGain);
    tremoloGain.connect(mainGain);
    mainGain.connect(this.master);

    tri1.start(t);
    tri2.start(t);
    sub.start(t);
    lfo.start(t);

    this.reverseThrustNode = { tri1, tri2, sub, lfo, lfoDepth, filter, tremoloGain, mainGain };
  }

  stopReverseThrust() {
    if (!this.ctx || !this.reverseThrustNode) return;
    const t = this.ctx.currentTime;
    const { tri1, tri2, sub, lfo, mainGain } = this.reverseThrustNode;
    mainGain.gain.cancelScheduledValues(t);
    mainGain.gain.setValueAtTime(mainGain.gain.value, t);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    tri1.stop(t + 0.1);
    tri2.stop(t + 0.1);
    sub.stop(t + 0.1);
    lfo.stop(t + 0.1);
    this.reverseThrustNode = null;
  }

  // Side engines — third engine voice. Architecture mirrors thrust/retro, but
  // pitch sits between the two (90Hz/45Hz here vs 110/55 forward and 72/36 retro)
  // and the filter cutoff opens slightly brighter so the side jet reads as
  // a tighter, more agile burst than either main thruster.
  private startSideThrust() {
    if (!this.ctx || !this.master) return;
    if (this.sideThrustNode) return;
    const t = this.ctx.currentTime;

    const tri1 = this.ctx.createOscillator();
    tri1.type = "triangle";
    tri1.frequency.value = 90.0;
    const tri2 = this.ctx.createOscillator();
    tri2.type = "triangle";
    tri2.frequency.value = 90.7;
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 45.0;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1500;
    filter.Q.value = 0.7;

    const tremoloGain = this.ctx.createGain();
    tremoloGain.gain.value = 1.0;

    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 6.5;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.value = 0.1;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain);

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(0.14, t + 0.06);

    tri1.connect(filter);
    tri2.connect(filter);
    sub.connect(filter);
    filter.connect(tremoloGain);
    tremoloGain.connect(mainGain);
    mainGain.connect(this.master);

    tri1.start(t);
    tri2.start(t);
    sub.start(t);
    lfo.start(t);

    this.sideThrustNode = { tri1, tri2, sub, lfo, lfoDepth, filter, tremoloGain, mainGain };
  }

  stopSideThrust() {
    if (!this.ctx || !this.sideThrustNode) return;
    const t = this.ctx.currentTime;
    const { tri1, tri2, sub, lfo, mainGain } = this.sideThrustNode;
    mainGain.gain.cancelScheduledValues(t);
    mainGain.gain.setValueAtTime(mainGain.gain.value, t);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    tri1.stop(t + 0.09);
    tri2.stop(t + 0.09);
    sub.stop(t + 0.09);
    lfo.stop(t + 0.09);
    this.sideThrustNode = null;
  }

  // Player-ship death: deep, dramatic, satisfying. Layered as:
  //   (1) sub-bass impact thump — chest-punch sine sweep ~85Hz → 26Hz
  //   (2) broadband noise crack with LP sweep ~3kHz → 110Hz (debris)
  //   (3) detuned saw pair sweeping 330Hz → 30Hz through a resonant LP
  //       (the "dying engine" scream — replaces the old single sawtooth)
  //   (4) sub-octave sine doubling under the saws for weight
  //   (5) bandpass noise rumble tail fading to silence ~1.6s in
  // Total body ~1.5s; fits inside the 1.8s `dyingTimer` in Game.respawn.
  private playDeath() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;

    const subStartHz = cfgN("death", "subStartHz", 85);
    const subEndHz = cfgN("death", "subEndHz", 26);
    const subPeak = cfgN("death", "subPeak", 0.65);
    const subDecay = cfgN("death", "subDecay", 1.2);
    const crackVol = cfgN("death", "crackVol", 0.55);
    const crackDur = cfgN("death", "crackDur", 1.4);
    const screamStartHz = cfgN("death", "screamStartHz", 330);
    const screamEndHz = cfgN("death", "screamEndHz", 30);
    const screamPeak = cfgN("death", "screamPeak", 0.22);
    const screamDur = cfgN("death", "screamDur", 1.1);
    const tailVol = cfgN("death", "tailVol", 0.18);
    const tailDur = cfgN("death", "tailDur", 1.6);

    // (1) Sub-bass impact thump
    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(subStartHz, t);
    sub.frequency.exponentialRampToValueAtTime(subEndHz, t + subDecay * 0.75);
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(subPeak, t + 0.01);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + subDecay);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + subDecay + 0.05);

    // (2) Broadband noise crack with LP sweep
    const crackBuf = this.makeNoiseBuffer(crackDur);
    if (crackBuf) {
      const crack = this.ctx.createBufferSource();
      crack.buffer = crackBuf;
      const crackFilter = this.ctx.createBiquadFilter();
      crackFilter.type = "lowpass";
      crackFilter.Q.value = 1.1;
      crackFilter.frequency.setValueAtTime(3000, t);
      crackFilter.frequency.exponentialRampToValueAtTime(110, t + crackDur);
      const crackGain = this.ctx.createGain();
      crackGain.gain.setValueAtTime(0.0001, t);
      crackGain.gain.exponentialRampToValueAtTime(crackVol, t + 0.015);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, t + crackDur);
      crack.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(this.master);
      crack.start(t);
      crack.stop(t + crackDur + 0.05);
    }

    // (3) Detuned saw pair — the dying engine scream
    const screamFilter = this.ctx.createBiquadFilter();
    screamFilter.type = "lowpass";
    screamFilter.Q.value = 4.5;
    screamFilter.frequency.setValueAtTime(1800, t);
    screamFilter.frequency.exponentialRampToValueAtTime(180, t + screamDur);
    const screamGain = this.ctx.createGain();
    screamGain.gain.setValueAtTime(0.0001, t);
    screamGain.gain.exponentialRampToValueAtTime(screamPeak, t + 0.03);
    screamGain.gain.exponentialRampToValueAtTime(0.0001, t + screamDur);
    screamFilter.connect(screamGain);
    screamGain.connect(this.master);
    for (const detune of [-7, 6]) {
      const saw = this.ctx.createOscillator();
      saw.type = "sawtooth";
      saw.detune.value = detune;
      saw.frequency.setValueAtTime(screamStartHz, t);
      saw.frequency.exponentialRampToValueAtTime(screamEndHz, t + screamDur * 0.85);
      saw.connect(screamFilter);
      saw.start(t);
      saw.stop(t + screamDur + 0.05);
    }

    // (4) Sub-octave sine doubling for weight
    const octave = this.ctx.createOscillator();
    const octaveGain = this.ctx.createGain();
    octave.type = "sine";
    octave.frequency.setValueAtTime(screamStartHz * 0.5, t);
    octave.frequency.exponentialRampToValueAtTime(screamEndHz * 0.5, t + screamDur * 0.85);
    octaveGain.gain.setValueAtTime(0.0001, t);
    octaveGain.gain.exponentialRampToValueAtTime(screamPeak * 0.55, t + 0.03);
    octaveGain.gain.exponentialRampToValueAtTime(0.0001, t + screamDur);
    octave.connect(octaveGain);
    octaveGain.connect(this.master);
    octave.start(t);
    octave.stop(t + screamDur + 0.05);

    // (5) Bandpass noise rumble tail — wreckage echo
    const tailBuf = this.makeNoiseBuffer(tailDur);
    if (tailBuf) {
      const tail = this.ctx.createBufferSource();
      tail.buffer = tailBuf;
      const tailFilter = this.ctx.createBiquadFilter();
      tailFilter.type = "bandpass";
      tailFilter.Q.value = 1.4;
      tailFilter.frequency.setValueAtTime(400, t);
      tailFilter.frequency.exponentialRampToValueAtTime(70, t + tailDur);
      const tailGain = this.ctx.createGain();
      tailGain.gain.setValueAtTime(0.0001, t);
      tailGain.gain.exponentialRampToValueAtTime(tailVol, t + 0.1);
      tailGain.gain.exponentialRampToValueAtTime(0.0001, t + tailDur);
      tail.connect(tailFilter);
      tailFilter.connect(tailGain);
      tailGain.connect(this.master);
      tail.start(t);
      tail.stop(t + tailDur + 0.05);
    }
  }

  private playWaveClear() {
    if (this.playBaked("waveClear", 1)) return;
    const eng = this.ensureToneEngine();
    if (!eng) return;
    const notes = ["E4", "G#4", "B4", "Eb5"];
    const now = Tone.now();
    for (let i = 0; i < notes.length; i++) {
      eng.waveClearSynth.triggerAttackRelease(notes[i], "4n", now + i * 0.06, 0.7);
    }
  }

  // Deep punchy kick on C2. Sine sweep + a tiny click for definition.
  // `pitchRatio` scales the tonal sweep so split-children of a bassteroid
  // can sound a fourth/octave below the parent (see Game.bassPitchRatio).
  private playBassKick(pitchRatio = 1) {
    if (this.playBaked("bassKick", pitchRatio)) return;
    const eng = this.ensureToneEngine();
    if (!eng) return;
    const note = 65.4 * pitchRatio;
    eng.bassKick.triggerAttackRelease(note, "16n", undefined, 0.95);
  }

  // Sub-bass "boom" on F2 (the IV of C major). Sine body with a brief
  // pitch sweep for thump, an F1 sub layer for body, and a short bandpassed
  // noise clack for attack. Heftier than the pluck, darker than the kick,
  // and stays inside the C-F-G chord pocket so layering with kick/pluck
  // reads as a I/IV/V bassline rather than a dissonant pile.
  private playBassBoom(pitchRatio = 1) {
    if (this.playBaked("bassBoom", pitchRatio)) return;
    const eng = this.ensureToneEngine();
    if (!eng) return;
    const note = 87.3 * pitchRatio;
    eng.bassBoom.triggerAttackRelease(note, "8n", undefined, 0.9);
  }

  // Percussive "snap" — a snare-leaning hybrid that gives beat 4 a sharp
  // accent without piling another sub onto the bottom. Bandpassed noise
  // body + a short tonal triangle at C3 that pitches down for a snare-like
  // body. Sits an octave above the kick/pluck/boom region so the four-voice
  // pattern reads as kick-pluck-boom-snap rather than a wall of low end.
  private playBassSnap(pitchRatio = 1) {
    if (this.playBaked("bassSnap", pitchRatio)) return;
    const eng = this.ensureToneEngine();
    if (!eng) return;
    eng.bassSnap.triggerAttackRelease("C3", "16n", undefined, 0.7 + pitchRatio * 0.0);
  }

  // Plucked sub-bass at G2 with a closing lowpass filter — distinct timbre
  // from the kick so the two layer rather than mask each other.
  private playBassPluck(pitchRatio = 1) {
    if (this.playBaked("bassPluck", pitchRatio)) return;
    const eng = this.ensureToneEngine();
    if (!eng) return;
    const note = 98 * pitchRatio;
    eng.bassPluck.triggerAttackRelease(note, "8n", undefined, 0.85);
  }

  // Crunch played when a bassteroid is shot. Deep, gravelly, sub-200 Hz —
  // a sawtooth sweep crashing into the bass register paired with a heavily
  // low-passed noise transient that sounds like cracking stone, not a tink.
  private playBassHit() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;

    // Body: detuned sawtooth pair sweeping from low-mid into the sub-bass
    // floor. Two oscs a tiny semitone-fraction apart fatten the sound and
    // give the slight beating that reads as "gravelly".
    const oscA = this.ctx.createOscillator();
    const oscB = this.ctx.createOscillator();
    oscA.type = "sawtooth";
    oscB.type = "sawtooth";
    oscA.frequency.setValueAtTime(180, t);
    oscA.frequency.exponentialRampToValueAtTime(48, t + 0.22);
    oscB.frequency.setValueAtTime(186, t);
    oscB.frequency.exponentialRampToValueAtTime(50, t + 0.22);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.28);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.42, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    oscA.start(t);
    oscB.start(t);
    oscA.stop(t + 0.42);
    oscB.stop(t + 0.42);

    // Crunch transient: noise pushed through a tight LOW band so it reads
    // as crumbling rock rather than a metallic tink. Centre frequency drops
    // through the hit so the texture goes from "crack" to "rumble".
    const noiseBuf = this.makeNoiseBuffer(0.22);
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const nFilter = this.ctx.createBiquadFilter();
    nFilter.type = "lowpass";
    nFilter.Q.value = 1.4;
    nFilter.frequency.setValueAtTime(700, t);
    nFilter.frequency.exponentialRampToValueAtTime(140, t + 0.2);
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.0001, t);
    nGain.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    noise.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.24);
  }

  // Deep echoing tail that plays on every bassteroid hit, regardless of
  // size. Implemented as four discrete sine thuds at decaying volume and an
  // increasingly dark lowpass — that gives a clearly perceived "echo from a
  // cave" character without dragging a Web Audio delay-feedback loop along
  // (which would leak nodes if the page is held open for a long session).
  // Stays sub-100 Hz so it sits below the kick/pluck without masking them.
  private playBassEcho() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const echoCount = 4;
    const echoSpacing = 0.22;
    const echoIndices = Array.from({ length: echoCount }, (_, i) => i);
    for (const i of echoIndices) {
      const start = t + i * echoSpacing;
      const decay = Math.pow(0.55, i);
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(82.4, start); // E2
      osc.frequency.exponentialRampToValueAtTime(45, start + 0.22);
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 600 * Math.pow(0.7, i);
      filter.Q.value = 0.7;
      const gain = this.ctx.createGain();
      const peak = 0.34 * decay;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      osc.start(start);
      osc.stop(start + 0.32);
    }
  }

  // High shimmery bell — three sine partials at near-bell ratios.
  private playChime() {
    if (this.playBaked("chime", 1)) return;
    const eng = this.ensureToneEngine();
    if (!eng) return;
    eng.chimeSynth.triggerAttackRelease(["C6", "G6"], "8n", undefined, 0.65);
  }

  // Lower bell with inharmonic partials — feels like a temple bell rather
  // than a wind-chime.
  private playBell() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const fundamentalFreq = cfgN("bell", "fundamentalHz", 220);
    const peakBase = cfgN("bell", "peak", 0.22);
    const decayBase = cfgN("bell", "decay", 1.4);
    const partialRatios = [
      1,
      cfgN("bell", "partial1Ratio", 2.76),
      cfgN("bell", "partial2Ratio", 5.4),
      cfgN("bell", "partial3Ratio", 8.93),
    ];
    for (let i = 0; i < partialRatios.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = fundamentalFreq * partialRatios[i];
      const peak = peakBase / (i + 1.2);
      const decay = Math.max(0.15, decayBase - i * 0.22);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }
  }

  // Tiny percussive tick that confirms an on-beat shot. High-passed noise
  // burst, very short and quiet so it sits underneath the existing fire sound
  // rather than masking it.
  private playComboTick() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const noiseBuf = this.makeNoiseBuffer(0.04);
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 4200;
    filter.Q.value = 0.7;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.05);
  }

  // Warm "you got the beat" cue — a soft mid-range fifth that sits under the
  // explosion thud instead of slicing through it. Dropped an octave from the
  // original sparkle so repeated on-beat kills don't fatigue the ear; the
  // sharper original lives on as the dedicated "tink" asteroid sound.
  private playComboSparkle(durationScale: number = 1) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const partialFrequencies = [880, 1318.5]; // A5, E6 (perfect fifth)
    const decay = 0.22 * durationScale;
    const stop = 0.24 * durationScale;
    for (let i = 0; i < partialFrequencies.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(partialFrequencies[i], t);
      const peak = 0.07 / (i + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + stop);
    }
  }

  playComboSparkleShort() { this.playComboSparkle(0.5); }

  // Escalating melody chime — one rounded synth note per successive on-beat
  // kill. All variants open with the same three universal anchor notes on a
  // C pedal (C2 → G2 → D3 — root, fifth, ninth), then branch into a scale
  // that matches the currently-playing halo music's modal colour:
  //   r2-sb / r2-el / r4-sb → C minor / dorian-leaning (haunting Eb, Bb)
  //   r3-el                 → C major pentatonic (open, hopeful)
  //   no music (default)    → C dorian without 3rd (mode-neutral)
  // r4-sb additionally drifts toward Cmaj7 colour at higher combos so the line
  // crosses the same major/minor ambiguity its arp does.
  // Voice: soft sine pad — slow attack, long round decay, gentle detune for
  // analog-synth warmth. No spatial panning: a melody should sit centered in
  // the mix instead of jumping with each kill.
  playComboChime(comboValue: number, _pos?: Pos, durationScale: number = 1) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (comboValue < 2) return;
    // Universal opening: root, fifth, ninth on the C pedal. Deep enough that
    // the climb has 13 more steps to ascend before getting strained.
    const ANCHOR_HZ: number[] = [
      65.41,   // C2
      98.00,   // G2
      146.83,  // D3
    ];
    // Scale tail (notes 3..15) per variation. Each is 13 ascending pitches
    // chosen so the final note of the cycle lands somewhere bright but not
    // piercing (≤ ~880 Hz / A5) — well under the music's upper-layer centroid
    // so the chime doesn't fight the music's high band.
    const TAIL_MINOR_DORIAN: number[] = [
      // Eb, F, G, Bb, C, Eb, F, G, Bb, C, Eb, F, G — C minor pentatonic + F.
      // Haunting: the Eb tracks the minor-third pad voicing.
      155.56, 174.61, 196.00, 233.08, 261.63,
      311.13, 349.23, 392.00, 466.16, 523.25,
      622.25, 698.46, 783.99,
    ];
    const TAIL_MAJOR: number[] = [
      // E, G, A, C, D, E, G, A, C, D, E, G, A — C major pentatonic.
      // Hopeful: pure C-major triadic colour.
      164.81, 196.00, 220.00, 261.63, 293.66,
      329.63, 392.00, 440.00, 523.25, 587.33,
      659.25, 783.99, 880.00,
    ];
    const TAIL_BITTERSWEET: number[] = [
      // E, G, Bb, C, Eb, F, G, Bb, C, D, Eb, G, Bb — smears Eb (minor3) with
      // E natural and Bb (Cmaj7 longing). r4-sb cycles all three colours, so
      // the chime crosses them too instead of committing to one.
      164.81, 196.00, 233.08, 261.63, 311.13,
      349.23, 392.00, 466.16, 523.25, 587.33,
      622.25, 783.99, 932.33,
    ];
    const TAIL_NO_3RD: number[] = [
      // F, G, A, C, D, F, G, A, C, D, F, G, A — C dorian/mixolydian crossover
      // with the major/minor 3rd avoided entirely. Mode-safe default when no
      // halo music is playing.
      174.61, 196.00, 220.00, 261.63, 293.66,
      349.23, 392.00, 440.00, 523.25, 587.33,
      698.46, 783.99, 880.00,
    ];
    const tailFor = (): number[] => {
      const v = this.haloMusic?.variation;
      if (v === "r3-el") return TAIL_MAJOR;
      if (v === "r4-sb") return TAIL_BITTERSWEET;
      if (v === "r2-sb" || v === "r2-el") return TAIL_MINOR_DORIAN;
      return TAIL_NO_3RD;
    };
    const scale = [...ANCHOR_HZ, ...tailFor()];
    const idx = (comboValue - 2) % scale.length;
    const fundamental = scale[idx];

    const t = this.ctx.currentTime;
    // Three detuned sines per note — fundamental + ±7-cent detune pair gives
    // a soft analog-synth chorus without any extra hardware. Lowpass tracks
    // fundamental so high notes don't shrill; low notes keep body.
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.6;
    // Cap the cutoff so deep notes still pass; never below 1.2 kHz so the
    // very lowest C2 has some upper-partial air, never above 3.2 kHz so the
    // top A5 stays soft.
    filter.frequency.value = Math.min(3200, Math.max(1200, fundamental * 3.0));

    // Volume scaled to ~2/3 of the previous bell version (fundamental 0.34
    // → 0.22 — split across three detuned voices so combined peak ~0.22).
    const peak = 0.22;
    const attack = 0.08;
    const sustain = 2.0 * durationScale;
    const release = 3.0 * durationScale;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + attack);
    env.gain.exponentialRampToValueAtTime(peak * 0.45, t + attack + sustain);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + sustain + release);
    env.connect(filter);
    filter.connect(this.master);

    const detuneCents = [0, -7, +7];
    const voices: OscillatorNode[] = [];
    for (const cents of detuneCents) {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = fundamental;
      osc.detune.value = cents;
      const vGain = this.ctx.createGain();
      vGain.gain.value = cents === 0 ? 0.5 : 0.32;
      osc.connect(vGain);
      vGain.connect(env);
      osc.start(t);
      voices.push(osc);
    }
    // Subtle octave-up shimmer at low fundamentals so the deepest notes still
    // read as a defined pitch instead of a rumble. Fades fast so it doesn't
    // colour the higher notes.
    if (fundamental < 200) {
      const shimmer = this.ctx.createOscillator();
      shimmer.type = "sine";
      shimmer.frequency.value = fundamental * 2;
      const sGain = this.ctx.createGain();
      sGain.gain.value = 0.18;
      shimmer.connect(sGain);
      sGain.connect(env);
      shimmer.start(t);
      voices.push(shimmer);
    }
    const stopAt = t + attack + sustain + release + 0.04;
    for (const v of voices) v.stop(stopAt);
  }

  // Bright glassy "tink" — high stacked sine fifth with a fast attack. Used
  // by the rare crystal asteroid kind. Designed to be ear-catching exactly
  // because it's uncommon; if it ever plays often, soften it back down.
  private playTink() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const peakBase = cfgN("tink", "peak", 0.18);
    const decay = cfgN("tink", "decay", 0.4);
    const partialFrequencies = [
      cfgN("tink", "partial1Hz", 1760),
      cfgN("tink", "partial2Hz", 2637),
    ];
    for (let i = 0; i < partialFrequencies.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(partialFrequencies[i], t);
      const peak = peakBase / (i + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + decay + 0.02);
    }
  }

  // Haunting bell voice for the wave-summary drain. Fires four-per-beat.
  // Root drops an octave from the old marimba (E5 → E4) so the line sits in
  // a deeper, more melancholic register. Sub-octave partial gives body, two
  // slightly detuned fundamentals produce a slow beat-frequency wobble that
  // reads as "uneasy", and a soft triangle high partial replaces the bright
  // inharmonic sparkle so the tone is round rather than glassy. Longer tail
  // (~0.32s) lets adjacent notes overlap into a continuous haunted line.
  private playScoreBlip(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const root = 330 * pitchRatio; // E4
    const layers: Array<{ freq: number; peak: number; decay: number; type: OscillatorType }> = [
      { freq: root * 0.5,    peak: 0.050, decay: 0.40, type: "sine" },
      { freq: root,          peak: 0.070, decay: 0.32, type: "sine" },
      { freq: root * 1.003,  peak: 0.060, decay: 0.32, type: "sine" }, // detune wobble
      { freq: root * 2,      peak: 0.022, decay: 0.18, type: "sine" },
      { freq: root * 3,      peak: 0.010, decay: 0.10, type: "triangle" },
    ];
    for (const { freq, peak, decay, type } of layers) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + decay + 0.02);
    }
  }

  // Downbeat anchor for the wave-summary drain — fires once per beat (every
  // 4th tick). Kick body grounds the time, a sustained minor-key chord
  // voicing layered on top carries the harmony. The chord rotates through
  // i — VI — III — VII (A minor → F → C → G) across the four downbeats of
  // each phrase so every 4-beat segment lands on different harmonic ground.
  // The drain melody's downbeat notes are chord tones of these voicings, so
  // the two voices interlock instead of fighting.
  private playSummaryDownbeat(chordIndex = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // Body: sine at A1 (~55 Hz) with a tiny initial pitch snap for "thump".
    //   Dropped a major third lower than before so it sits under the deeper
    //   scoreBlip without crowding the melody register.
    const body = this.ctx.createOscillator();
    const bodyGain = this.ctx.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(110, t);
    body.frequency.exponentialRampToValueAtTime(55, t + 0.014);
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.40, t + 0.003);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    body.connect(bodyGain);
    bodyGain.connect(this.master);
    body.start(t);
    body.stop(t + 0.24);
    // Click: short bandpassed noise so the transient locks the beat in time.
    //   Centered lower (900 Hz vs the old 1800) so it reads as a soft mallet
    //   rather than a crisp tick — fits the haunting palette.
    const noise = this.ctx.createBufferSource();
    const buf = this.ctx.createBuffer(1, 512, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 1.4;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.05, t + 0.001);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    noise.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.04);

    // Sustained chord voicing — root + minor/major triad + open fifth in the
    //   bell register, each chord's frequencies expressed as Hz triads.
    //   i: A minor (A3 E4 C5), VI: F major (F3 C4 A4), III: C major (C4 G4 E5),
    //   VII: G major (G3 D4 B4). The voicings stay within ~half an octave of
    //   each other so the rotation reads as motion, not jumps.
    const voicings: Array<[number, number, number]> = [
      [220.0, 329.6, 523.3], // i  — A minor
      [174.6, 261.6, 440.0], // VI — F major
      [261.6, 392.0, 659.3], // III — C major
      [196.0, 293.7, 493.9], // VII — G major
    ];
    const chord = voicings[chordIndex % voicings.length];
    // Chord notes use a slow attack (60ms) and long sustain (~1.4s) so each
    //   downbeat blooms under the four marimba-blip ticks that follow it,
    //   then fades just in time for the next downbeat's chord to take over.
    for (let i = 0; i < chord.length; i++) {
      const freq = chord[i];
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const peak = 0.085 / (1 + i * 0.35); // root loudest, top of chord quietest
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + 1.45);
    }
  }

  // Ascending sine arpeggio with a sparkle overlay — the "you got something
  // good" jingle that plays when the ship flies over a canister.
  private playPowerup() {
    if (this.playBaked("powerup", 1)) return;
    const eng = this.ensureToneEngine();
    if (!eng) return;
    const notes = ["C5", "E5", "G5", "C6"];
    const now = Tone.now();
    for (let i = 0; i < notes.length; i++) {
      eng.powerupSynth.triggerAttackRelease(notes[i], "16n", now + i * 0.06, 0.7);
    }
  }

  // Canister-appear: gentle ascending wind-chime sparkle. Three soft sine
  // partials of a Cmaj9 voicing arrive in rising sequence, slower and quieter
  // than playPowerup so the player reads "something nice just appeared" rather
  // than "pickup confirmed". Bandpass-filtered white-noise wash underneath
  // gives the air-suspended pod a breath of presence.
  private playCanisterAppear() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // Cmaj9 partials: C6, E6, G6, D7 — open, airy, unambiguously friendly.
    const partialFrequencies = [1046.5, 1318.5, 1568.0, 2349.3];
    for (let i = 0; i < partialFrequencies.length; i++) {
      const start = t + i * 0.085;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(partialFrequencies[i], start);
      const peak = 0.085 / (1 + i * 0.25);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(start);
      osc.stop(start + 0.95);
    }
    // Soft airy halo — bandpassed noise behind the partials.
    const noiseBuf = this.makeNoiseBuffer(0.6);
    if (noiseBuf) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const filter = this.ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(2400, t);
      filter.frequency.exponentialRampToValueAtTime(5000, t + 0.5);
      filter.Q.value = 1.4;
      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.exponentialRampToValueAtTime(0.04, t + 0.08);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(this.master);
      noise.start(t);
      noise.stop(t + 0.6);
    }
  }

  // Canister-destroyed: a soft sighing minor descent. Two sine voices fall a
  // minor third (E5 → C5 / G5 → Eb5) over ~0.7s with a slow vibrato; sits
  // *underneath* the explosionSmall the Game also plays, reading as the
  // pod's "regret" rather than another blast. Heavily attenuated so it
  // colors the explosion instead of competing with it.
  private playCanisterDestroyed() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // Voice pairs: [startHz, endHz]. The fall from a major triad partial
    // into a minor one is what gives this its "aw, no" quality.
    const voices: Array<[number, number]> = [
      [659.25, 523.25], // E5 → C5
      [783.99, 622.25], // G5 → Eb5
      [329.63, 261.63], // E4 → C4 (sub-octave, fuller body)
    ];
    for (let i = 0; i < voices.length; i++) {
      const [fStart, fEnd] = voices[i];
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(fStart, t + 0.04);
      osc.frequency.exponentialRampToValueAtTime(fEnd, t + 0.7);
      // Slow vibrato — gives the descent a vocal, almost weeping quality.
      const lfo = this.ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 5.5;
      const lfoDepth = this.ctx.createGain();
      lfoDepth.gain.value = fStart * 0.012;
      lfo.connect(lfoDepth);
      lfoDepth.connect(osc.frequency);
      const peak = 0.11 / (1 + i * 0.4);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + 1.15);
      lfo.stop(t + 1.15);
    }
  }

  // Combo-lost "wrrr" — a short downward pitch-bend on two detuned triangles
  // through a closing lowpass. Reads as a deflating/slowing motor, the
  // tonal opposite of the cyan→gold combo halo lighting up. Kept short
  // (~0.4s) so it doesn't step on the shot or hit that triggered the loss.
  private playComboLost() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // Two slightly detuned triangle voices — the small detune is what
    // gives the tail its buzzy "wrrr" character instead of a clean sigh.
    const voices: Array<{ start: number; end: number; detune: number; level: number }> = [
      { start: 392.0, end: 130.8, detune: 0, level: 0.16 },   // G4 → C3
      { start: 392.0, end: 130.8, detune: 12, level: 0.12 },  // detuned twin
    ];
    for (const v of voices) {
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(v.start, t);
      osc.frequency.exponentialRampToValueAtTime(v.end, t + 0.34);
      osc.detune.value = v.detune;
      // Lowpass closes alongside the pitch drop — kills the brightness so
      // the tail genuinely fades into the floor instead of buzzing on.
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 1.2;
      filter.frequency.setValueAtTime(1800, t);
      filter.frequency.exponentialRampToValueAtTime(380, t + 0.34);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(v.level, t + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.45);
    }
  }

  // Soft glassy "ting" with a quick noise wash — the shield absorbing a hit.
  private playShieldPop() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.3);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.38);

    const noiseBuf = this.makeNoiseBuffer(0.18);
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 3000;
    filter.Q.value = 2;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.16, t);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.2);
  }

  // Sine carrier with a fast vibrato — a vocal "ooo" warble.
  private playWarble() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 587.33; // D5
    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 8;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.value = 25;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.frequency);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.62);
    lfo.stop(t + 0.62);
  }
}
