import * as Tone from "tone";
import { cfgN, cfgU } from "./soundConfig";

// Tone.js-based engine wiring. When `Sound.engine === "tone"`, sounds opt
// into a separate signal path: synths → fxBus (chorus → reverb) + dry →
// toneMaster → compressor → limiter → destination. The plain WebAudio
// `master` node still exists in parallel for legacy voices, but Tone routes
// through its own master so we can shape its sound independently.
type ToneEngineNodes = {
  toneMaster: Tone.Gain;
  reverbSend: Tone.Gain;
  reverb: Tone.Reverb;
  chorus: Tone.Chorus;
  compressor: Tone.Compressor;
  limiter: Tone.Limiter;
  // Input nodes for the legacy WebAudio chain. The hand-written voices all
  // target Sound.master; we route master → legacyBusDry + legacyBusWet so
  // every legacy sound gets the polished master chain when engine === "tone".
  legacyBusDry: Tone.Gain;
  legacyBusWet: Tone.Gain;
  cometMelodySynth: Tone.PolySynth;
  cometShimmerByKey: Map<object, ToneCometShimmer>;
  // Per-voice synths for the highest-impact sounds — the ones the player
  // hears most often or that most differentiate "polished" from "raw
  // oscillators". Everything else still uses the legacy WebAudio code; in
  // tone-engine mode it routes through the same master bus for shared
  // compressor/limiter/reverb polish.
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
};

// Per-comet shimmer pad. Underlies the comet melody for the entire lifetime
// of one comet — a soft chord wash that thickens whenever a comet is on
// screen. Set up once at spawn, torn down on despawn.
type CometShimmerNode = {
  oscs: OscillatorNode[];
  lfos: OscillatorNode[];
  mainGain: GainNode;
};

export type SoundName =
  | "fire"
  | "fireBeat"
  | "explosionLarge"
  | "explosionMedium"
  | "explosionSmall"
  | "thrust"
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
  | "cometDestroyed";

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
  enabled = true;
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
  // Which engine routes the audio. Legacy hand-built WebAudio vs the Tone.js
  // polished path (default). In tone mode, *every* sound
  // (including hand-written synthesis that targets `this.master`) is siphoned
  // through the Tone fx bus → compressor → limiter, so the global character
  // changes engine-wide without rewriting each voice individually.
  engine: "legacy" | "tone" = "tone";
  toneEngine: ToneEngineNodes | null = null;
  // Legacy master compressor — held so we can disconnect it when switching to
  // tone mode (where the Tone chain owns mastering instead).
  legacyCompressor: DynamicsCompressorNode | null = null;

  ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.15;
    this.master.connect(compressor);
    compressor.connect(this.ctx.destination);
    this.legacyCompressor = compressor;
    // Direct-to-destination bus for pre-baked buffers (whose tail already
    // contains the full Tone master chain). Mirrors the master gain level so
    // baked and live voices sit at a comparable loudness.
    this.bakedOut = this.ctx.createGain();
    this.bakedOut.gain.value = 0.6;
    this.bakedOut.connect(this.ctx.destination);
    // If we boot with the tone engine active, build it now so the master bus
    // is hot before the first voice plays. ensureToneEngine ends by calling
    // applyEngineRouting, which swaps master off the legacy compressor and
    // onto the tone bus.
    if (this.engine === "tone") this.ensureToneEngine();
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

    // Legacy-bus inputs. Sound.master (the WebAudio GainNode every legacy
    // voice writes into) connects to both: dry sums straight into toneMaster
    // for presence; wet sends to the fx bus. The wet level is intentionally
    // subtle (~25%) so legacy percussion (bass kit, bg-beat) doesn't get
    // washed out in reverb. Comet voices already have a heavier wet send via
    // their own dedicated Tone synth path.
    const legacyBusDry = new Tone.Gain(0.95);
    const legacyBusWet = new Tone.Gain(0.25);
    legacyBusDry.connect(toneMaster);
    legacyBusWet.connect(reverbSend);

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
      filter: { type: "lowpass", Q: 6 },
      envelope: { attack: 0.005, decay: 0.18, sustain: 0.15, release: 0.45 },
      filterEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.05, release: 0.6, baseFrequency: 220, octaves: 3 },
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
      legacyBusDry,
      legacyBusWet,
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
    this.applyEngineRouting();
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
    // bgBeat: 2 base pitches (1 = downbeat C2, 1.122 = offbeat D2) × 11
    // intensity buckets. Encoded key is `actualPitch * 100 + intensityBucket`
    // — matches the call-site in playBgBeat.
    for (const basePitch of [1, 1.122]) {
      for (let bucket = 0; bucket <= 10; bucket++) {
        const intensityBucket = bucket / 10;
        this.queueBake("bgBeat", basePitch * 100 + intensityBucket);
      }
    }
  }

  // Trigger a bake for one (sound, pitchKey) pair if it isn't cached or in
  // flight. Bakes are serialized via bakeChain so Tone.setContext doesn't
  // race between concurrent renders.
  private queueBake(name: SoundName, pitchRatio: number) {
    const key = this.bakedKey(name, pitchRatio);
    if (this.bakedBuffers.has(key) || this.bakingInFlight.has(key)) return;
    this.bakingInFlight.add(key);
    this.bakeChain = this.bakeChain.then(() => this.bakeSound(name, pitchRatio).then((rendered) => {
      if (rendered) this.bakedBuffers.set(key, rendered);
      this.bakingInFlight.delete(key);
    }).catch(() => { this.bakingInFlight.delete(key); }));
  }

  // Swap the master-out connections so Sound.master either goes through the
  // legacy compressor (engine = "legacy") or through Tone's bus + master
  // chain (engine = "tone"). Both paths share the same Sound.master input
  // node, so individual voices don't care which engine is active.
  applyEngineRouting() {
    if (!this.ctx || !this.master) return;
    // Always start from a disconnected master to avoid double-routing.
    this.master.disconnect();
    if (this.engine === "tone" && this.toneEngine) {
      // Tone owns mastering: tap master into both dry and wet inputs of the
      // Tone bus. The Tone chain ends at ctx.destination via its limiter.
      // Use the underlying input AudioNode (Tone wraps a GainNode internally).
      this.master.connect(this.toneEngine.legacyBusDry.input as AudioNode);
      this.master.connect(this.toneEngine.legacyBusWet.input as AudioNode);
    } else if (this.legacyCompressor) {
      // Legacy: master → compressor → destination, as it has always been.
      this.master.connect(this.legacyCompressor);
    }
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

  private bakedKey(name: SoundName, pitchRatio: number): string {
    // Quantize to 4 decimals so floating-point noise doesn't fragment the cache.
    return `${name}|${pitchRatio.toFixed(4)}`;
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
      src.connect(this.bakedOut);
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
        // The composite key is `actualPitch * 100 + intensityBucket`. Decode:
        const intensity = pitchRatio - Math.floor(pitchRatio);
        const actualPitch = Math.floor(pitchRatio) / 100;
        const kick = wire(new Tone.MembraneSynth({ pitchDecay: 0.06, octaves: 6, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.5 }, volume: -6 }), 1, 0.1);
        const isOffbeat = actualPitch !== 1;
        const offbeatMul = isOffbeat ? 0.35 + intensity * 0.45 : 1;
        const levelMul = (0.35 + 0.65 * intensity) * offbeatMul;
        const velocity = (0.25 + intensity * 0.75) * levelMul;
        const note = actualPitch === 1 ? "C2" : "D2";
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

  // Cycle through engines: legacy <-> tone. Tears down active comet voices
  // on whichever side we just left so we don't double-trigger, then rewires
  // the master output.
  cycleEngine(): "legacy" | "tone" {
    this.stopAllCometShimmers();
    this.engine = this.engine === "legacy" ? "tone" : "legacy";
    if (this.engine === "tone") this.ensureToneEngine();
    this.applyEngineRouting();
    return this.engine;
  }

  resume() {
    this.ensureContext();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on && this.thrustNode) this.stopThrust();
    if (!on) this.stopAllAlienDrones();
    if (!on) this.stopAllBassteroidDrones();
    if (!on) this.stopAllCometShimmers();
  }

  // Start a continuous theremin-ish drone for an alien. The `key` is the
  // Alien instance (or any unique object) used to look up the drone when
  // it's time to stop it. Carrier frequency depends on size — bigger
  // saucers sit deeper in the mix so multiple aliens read as a chord
  // rather than a single wall of sound.
  startAlienDrone(key: object, size: "big" | "medium" | "small") {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.alienDrones.has(key)) return;
    const t = this.ctx.currentTime;

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
    mainGain.connect(this.master);

    oscA.start(t);
    oscB.start(t);
    pulseLfo.start(t);
    vibratoLfo.start(t);

    this.alienDrones.set(key, {
      oscA, oscB, pulseLfo, vibratoLfo, vibratoDepth, filter, pulseGain, mainGain,
    });
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
  startBassteroidDrone(key: object, kind: "bassA" | "bassB" | "bassC" | "bassD", size: "medium" | "small") {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.bassDrones.has(key)) return;
    const t = this.ctx.currentTime;

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
    mainGain.connect(this.master);

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

    this.bassDrones.set(key, { oscs, lfos, noise, mainGain });
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

  // Comet melody: an unsettling Phrygian/diminished motif that sits over
  // the bassteroid percussion. Pitches centre on C with a flattened 2nd
  // (Db) and a tritone (F#) so every phrase visits a tension interval
  // before resolving — the listener never quite settles. The line lives in
  // a lower octave than the old major-add9 version so it reads as looming
  // rather than ethereal.
  //
  // The melody is 16 steps long; one step plays per BEAT_GRID tick (0.5s), so
  // the full phrase is 8 seconds = 4 bass measures. Long-form: rises through
  // a half-step climb (C → Db) to the tritone (F#), sits on the b6 (Ab) for
  // dread, then falls chromatically back toward the root.
  private static readonly COMET_MELODY: (number | null)[] = [
    // C4  Db4  F#4   -   Ab4   G4  Db4   -    F4  Ab4  C5    -    B4   F#4  Eb4  -
    261.63, 277.18, 369.99, null, 415.30, 392.00, 277.18, null,
    349.23, 415.30, 523.25, null, 493.88, 369.99, 311.13, null,
  ];

  // Fire one note of the comet melody. `step` is the global step index since
  // the comet appeared; we modulo into the melody table so the phrase loops
  // smoothly for as long as the comet is on screen. Bell-like timbre — sine
  // fundamental with two soft inharmonic partials and a slow exponential
  // decay so each note rings into the next.
  playCometNote(step: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const melody = Sound.COMET_MELODY;
    const freq = melody[((step % melody.length) + melody.length) % melody.length];
    if (freq === null) return;

    if (this.engine === "tone") {
      const eng = this.ensureToneEngine();
      if (!eng) return;
      // Light velocity variation per step so the looping melody breathes
      // instead of mechanically repeating. Step 0/4/8/12 (the downbeats) hit
      // a touch harder.
      const isDownbeat = step % 4 === 0;
      const velocity = isDownbeat ? 0.85 : 0.6;
      eng.cometMelodySynth.triggerAttackRelease(freq, "2n", undefined, velocity);
      return;
    }

    const t = this.ctx.currentTime;

    // Three sine partials with mild inharmonic ratios — glassy/bell-like
    // without the metallic clang of true bell ratios. Each partial gets
    // its own envelope so the highs decay faster than the fundamental,
    // giving the note a soft "ping → hum → silence" shape.
    const partials = [1, 2.005, 3.012];
    const partialPeaks = [0.18, 0.08, 0.035];
    const partialDecays = [3.2, 2.0, 1.2];
    for (let i = 0; i < partials.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * partials[i];
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(partialPeaks[i], t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + partialDecays[i]);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + partialDecays[i] + 0.05);
    }

    // A second voice an octave up at a much lower level, panned-feeling via
    // slight detune. Adds shimmer to the top of each note so the melody
    // reads as "ethereal" rather than just "soft bell".
    const high = this.ctx.createOscillator();
    high.type = "sine";
    high.frequency.value = freq * 2.001;
    const highGain = this.ctx.createGain();
    highGain.gain.setValueAtTime(0.0001, t);
    highGain.gain.exponentialRampToValueAtTime(0.04, t + 0.03);
    highGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    high.connect(highGain);
    highGain.connect(this.master);
    high.start(t);
    high.stop(t + 2.5);
  }

  // Ominous voice held under the comet's entire lifetime. Begins with a
  // big "shhwwwoorrr" — a wide noise band sweeping from high down to mid,
  // panning the listener's attention to the comet's arrival — then settles
  // into a low, dissonant drone (minor 2nd + tritone over the root) that
  // hums for the comet's life. The drone is intentionally unresolved so
  // the comet feels threatening rather than tranquil.
  startCometShimmer(key: object) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;

    // The comet voice is built on the legacy WebAudio path for both engines —
    // the bandpass-swept noise + saw-cluster drone is easier to express here
    // than in Tone, and in tone-engine mode the legacy bus already routes
    // through the same compressor/limiter chain, so polish is shared.
    if (this.cometShimmers.has(key)) return;
    const t = this.ctx.currentTime;

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
    mainGain.connect(this.master);

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

    // ── Unsettling drone bed ─────────────────────────────────────────────
    // Low cluster: root C2 (65.4) + minor 2nd above (Db2 = 69.3) + tritone
    // (F#2 = 92.5). The minor-2nd interval is the textbook horror-movie
    // "wrong note"; the tritone is the medieval "diabolus in musica". Each
    // voice is two slightly detuned sawtooth oscillators run through a
    // dark lowpass, so the cluster reads as a thick rumbling drone rather
    // than three distinct pitches.
    const droneFreqs = [65.41, 69.30, 92.50];
    const tremRates = [0.07, 0.11, 0.13];

    const droneFilter = this.ctx.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.Q.value = 1.4;
    // Filter opens slowly during the entry, then settles dark.
    droneFilter.frequency.setValueAtTime(400, t);
    droneFilter.frequency.exponentialRampToValueAtTime(1100, t + 2.5);
    droneFilter.frequency.exponentialRampToValueAtTime(620, t + 6.0);
    droneFilter.connect(mainGain);

    for (let i = 0; i < droneFreqs.length; i++) {
      const f = droneFreqs[i];
      const oscA = this.ctx.createOscillator();
      const oscB = this.ctx.createOscillator();
      oscA.type = "sawtooth";
      oscB.type = "sawtooth";
      oscA.frequency.value = f;
      oscB.frequency.value = f * 1.011; // wider detune than the old pad — beats slowly

      const trem = this.ctx.createOscillator();
      trem.type = "sine";
      trem.frequency.value = tremRates[i];
      const tremDepth = this.ctx.createGain();
      tremDepth.gain.value = 0.4;
      const voiceGain = this.ctx.createGain();
      // Root strongest, tritone next, minor-2nd quietest so the wrong
      // note tints the cluster without dominating.
      const voiceLevel = i === 0 ? 0.55 : i === 2 ? 0.35 : 0.22;
      voiceGain.gain.value = voiceLevel;
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

    this.cometShimmers.set(key, { oscs, lfos, mainGain });
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

  stopAllCometShimmers() {
    for (const key of Array.from(this.cometShimmers.keys())) this.stopCometShimmer(key);
    if (this.toneEngine) {
      for (const key of Array.from(this.toneEngine.cometShimmerByKey.keys())) this.stopCometShimmer(key);
    }
  }

  private makeNoiseBuffer(duration: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buf = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  play(name: SoundName, pitchRatio = 1) {
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
    const u = cfgU(name);
    const effectivePitch = pitchRatio * u.pitch;
    const realMaster = this.master;
    let voiceGain: GainNode | null = null;
    if (u.volume !== 1) {
      voiceGain = this.ctx.createGain();
      voiceGain.gain.value = u.volume;
      voiceGain.connect(realMaster);
      this.master = voiceGain;
    }

    switch (name) {
      case "fire": this.playFire(); break;
      case "fireBeat": this.playFireBeat(); break;
      case "explosionLarge": this.playExplosion(cfgN("explosionLarge", "volume", 0.7), cfgN("explosionLarge", "lowpassStart", 160), cfgN("explosionLarge", "duration", 0.55)); break;
      case "explosionMedium": this.playExplosion(cfgN("explosionMedium", "volume", 0.55), cfgN("explosionMedium", "lowpassStart", 230), cfgN("explosionMedium", "duration", 0.42)); break;
      case "explosionSmall": this.playExplosion(cfgN("explosionSmall", "volume", 0.4), cfgN("explosionSmall", "lowpassStart", 340), cfgN("explosionSmall", "duration", 0.3)); break;
      case "thrust": this.startThrust(); break;
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
    }

    if (voiceGain) this.master = realMaster;
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

  // Alien destruction — descending arpeggio "dying robot" warble plus a
  // medium explosion so the hit reads as a kill, not a deflect.
  private playAlienExplode() {
    if (!this.ctx || !this.master) return;
    this.playExplosion(0.55, 230, 0.42);
    const t = this.ctx.currentTime;
    const notes = [880, 698.5, 523.25, 392, 261.6]; // A5 → F5 → C5 → G4 → C4
    for (let i = 0; i < notes.length; i++) {
      const start = t + i * 0.07;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.value = notes[i];
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.14, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(start);
      osc.stop(start + 0.2);
    }
  }

  // Warm-up tone played when the pulsar starts vibrating. Rising sawtooth
  // sweep with a parallel high partial — "winding up" the way an emergency
  // siren announces itself. Length matches Pulsar.SHOCK_VIBRATE_DURATION
  // (2.0s) so it tops out exactly as the flash fires.
  private playShockwaveCharge() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const duration = 2.0;

    // Sub carrier: deep sawtooth that rises only into the low bass, never
    // breaking into mid-range. Keeping the top end well under 200 Hz is what
    // makes the charge read as cavernous rather than whiny.
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(32, t);
    osc.frequency.exponentialRampToValueAtTime(160, t + duration);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 8;
    filter.frequency.setValueAtTime(160, t);
    filter.frequency.exponentialRampToValueAtTime(700, t + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.34, t + duration);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);

    // Sub-sine reinforcement: a near-DC tone that gives the charge real
    // chest-pressure presence even on speakers that roll off the saw's
    // fundamental.
    const subSine = this.ctx.createOscillator();
    subSine.type = "sine";
    subSine.frequency.setValueAtTime(24, t);
    subSine.frequency.exponentialRampToValueAtTime(80, t + duration);
    const subSineGain = this.ctx.createGain();
    subSineGain.gain.setValueAtTime(0.0001, t);
    subSineGain.gain.exponentialRampToValueAtTime(0.45, t + duration);
    subSine.connect(subSineGain);
    subSineGain.connect(this.master);
    subSine.start(t);
    subSine.stop(t + duration + 0.05);

    // Upper "shimmer" — kept low to preserve the deep character. Sits on a
    // fifth above the sub carrier and only reaches the low-mid band so the
    // pair reads as a chord winding up rather than a single rising tone.
    const sh = this.ctx.createOscillator();
    sh.type = "sine";
    sh.frequency.setValueAtTime(80, t);
    sh.frequency.exponentialRampToValueAtTime(480, t + duration);
    const shGain = this.ctx.createGain();
    shGain.gain.setValueAtTime(0.0001, t);
    shGain.gain.exponentialRampToValueAtTime(0.0001, t + duration * 0.4);
    shGain.gain.exponentialRampToValueAtTime(0.10, t + duration);
    sh.connect(shGain);
    shGain.connect(this.master);
    sh.start(t);
    sh.stop(t + duration + 0.05);
  }

  // Detonation: deep impact thud + low-mid pitched boom + a noise burst for
  // the wavefront. Hits hard at t=0 and decays in ~1.5s so it overlaps the
  // expanding ring without sustaining into the next several seconds of play.
  private playShockwaveBoom() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;

    // Sub thud — chest-thump kick to land the impact moment. Settles into
    // a near-DC rumble so the impact reads as a tectonic shift rather than
    // a snare-style transient.
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(70, t);
    sub.frequency.exponentialRampToValueAtTime(16, t + 0.6);
    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.95, t + 0.012);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 1.9);

    // Body — sawtooth booming pitch-down for the "wall of force" sense.
    // Kept entirely in the bass range with a low filter ceiling so the
    // detonation never gets bright or honky.
    const body = this.ctx.createOscillator();
    body.type = "sawtooth";
    body.frequency.setValueAtTime(110, t);
    body.frequency.exponentialRampToValueAtTime(28, t + 0.7);
    const bodyFilter = this.ctx.createBiquadFilter();
    bodyFilter.type = "lowpass";
    bodyFilter.Q.value = 3;
    bodyFilter.frequency.setValueAtTime(700, t);
    bodyFilter.frequency.exponentialRampToValueAtTime(110, t + 1.4);
    const bodyGain = this.ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
    body.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(this.master);
    body.start(t);
    body.stop(t + 1.8);

    // Noise wash — the wavefront passing over you. Bandpass sweep
    // downward into a deep rumble; we start lower and end lower than
    // before so the texture stays in "earthquake" territory rather than
    // ever brushing the highs.
    const noiseBuf = this.makeNoiseBuffer(1.8);
    if (noiseBuf) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = "bandpass";
      nFilter.frequency.setValueAtTime(900, t);
      nFilter.frequency.exponentialRampToValueAtTime(70, t + 1.2);
      nFilter.Q.value = 1.6;
      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.exponentialRampToValueAtTime(0.32, t + 0.025);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(this.master);
      noise.start(t);
      noise.stop(t + 1.85);
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
  private playBgBeat(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;
    if (this.bgBeatIntensity <= 0) return;
    const intensity = Math.max(0, Math.min(1, this.bgBeatIntensity));
    // Offbeats (2nd/4th beat) are further attenuated so the heartbeat reads
    // as a strong-weak pattern instead of a flat metronome. The reduction is
    // strongest at low intensity (where the beat should feel barely-there)
    // and eases as the pulsar gets close — at wave 30 the offbeat is only
    // slightly softer than the downbeat.
    const isOffbeat = pitchRatio !== 1;
    const offbeatMul = isOffbeat ? 0.35 + intensity * 0.45 : 1;
    // Overall level is scaled down at low intensity so the early-wave beat is
    // much quieter than before. Quadratic intensity squashes the floor hard
    // (0.35x at wave 1) while still reaching full level by wave 30.
    const levelMul = (0.35 + 0.65 * intensity) * offbeatMul;

    if (this.engine === "tone") {
      // bgBeat amplitude depends on bgBeatIntensity, which changes per wave.
      // Quantize intensity to 0.1 buckets so we cache ~10 buffers instead of
      // baking a new one for every float drift, but still track wave-to-wave
      // intensity ramping.
      const intensityBucket = Math.round(intensity * 10) / 10;
      const bgBeatPitchKey = pitchRatio * 100 + intensityBucket;
      if (this.playBaked("bgBeat", bgBeatPitchKey)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      const velocity = (0.25 + intensity * 0.75) * levelMul;
      const note = pitchRatio === 1 ? "C2" : "D2";
      eng.bgBeatKick.triggerAttackRelease(note, "8n", undefined, velocity);
      return;
    }

    const t = this.ctx.currentTime;
    // Peak amplitude scales concavely with intensity. Floor (0.06) is below
    // every other gameplay sound (comboTick 0.18, chime partials 0.07) but
    // still clearly audible on laptop/phone speakers. Peak (~0.55) at full
    // intensity is heavier than explosions, which sells "ominous rumble" at
    // wave 30.
    const peak = (0.06 + intensity * intensity * 0.5) * levelMul;

    // Body: sine at 65 Hz (C2) for downbeats, lifted by pitchRatio on
    // offbeats. C2 is high enough that even small speakers reproduce it,
    // unlike the sub-40 Hz we'd want for "deepest possible" — the sub
    // oscillator below handles the chest-thump end of the spectrum on
    // capable systems. Short downward pitch sweep gives each hit a thump.
    const baseFreq = 65 * pitchRatio;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(baseFreq * 1.4, t);
    osc.frequency.exponentialRampToValueAtTime(baseFreq, t + 0.08);
    const gain = this.ctx.createGain();
    // 5 ms attack matches the bass voices (bassKick 4 ms, bassBoom 5 ms,
    // bassPluck 6 ms, bassSnap 3 ms) so the perceived "thump" lands on the
    // same instant as the bassteroid voices triggered on the same beat.
    // Earlier value was 40 ms — long enough that the pulsar's hit was clearly
    // trailing the bass section.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.6);

    // Sub-octave reinforcement (~32 Hz). Mostly inaudible as a pitch on
    // small speakers but adds the chest-rumble body on headphones/subwoofer.
    // Scaled aggressively with intensity so it barely contributes at wave 1
    // and dominates the low spectrum by wave 30. Attack tightened from 50 ms
    // to 8 ms so the sub doesn't smear in late behind the body transient.
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = baseFreq * 0.5;
    const subGain = this.ctx.createGain();
    const subPeak = peak * (0.3 + 0.7 * intensity);
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(subPeak, t + 0.008);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 0.75);

    // Lowpassed noise rumble — only audible at higher intensities, so the
    // late-wave version has a gritty texture vs. the early-wave pure tone.
    if (intensity > 0.25) {
      const noiseBuf = this.makeNoiseBuffer(0.5);
      if (noiseBuf) {
        const noise = this.ctx.createBufferSource();
        noise.buffer = noiseBuf;
        const nFilter = this.ctx.createBiquadFilter();
        nFilter.type = "lowpass";
        nFilter.frequency.value = 180;
        nFilter.Q.value = 1.5;
        const nGain = this.ctx.createGain();
        const noisePeak = (intensity - 0.25) * 0.22;
        nGain.gain.setValueAtTime(0.0001, t);
        nGain.gain.exponentialRampToValueAtTime(noisePeak, t + 0.05);
        nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        noise.connect(nFilter);
        nFilter.connect(nGain);
        nGain.connect(this.master);
        noise.start(t);
        noise.stop(t + 0.55);
      }
    }
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
    if (!this.ctx || !this.master) return;

    if (this.engine === "tone") {
      if (this.playBaked("fireBeat", 1)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      eng.fireBeatBody.triggerAttackRelease("C3", "16n", undefined, 0.9);
      eng.fireBeatPluck.triggerAttack("G4");
      return;
    }

    const t = this.ctx.currentTime;
    const bodyHz = cfgN("fireBeat", "bodyHz", 130.8);
    const bodyPeak = cfgN("fireBeat", "bodyPeak", 0.38);
    const bodyDecay = cfgN("fireBeat", "bodyDecay", 0.24);
    const subHz = cfgN("fireBeat", "subHz", 65.4);
    const subPeak = cfgN("fireBeat", "subPeak", 0.28);
    const subDecay = cfgN("fireBeat", "subDecay", 0.28);
    const partialHz = cfgN("fireBeat", "partialHz", 196);
    const partialPeak = cfgN("fireBeat", "partialPeak", 0.12);
    const partialDecay = cfgN("fireBeat", "partialDecay", 0.1);
    const tickHz = cfgN("fireBeat", "tickHz", 600);
    const tickQ = cfgN("fireBeat", "tickQ", 1.0);
    const tickPeak = cfgN("fireBeat", "tickPeak", 0.09);
    const tickDecay = cfgN("fireBeat", "tickDecay", 0.03);

    const body = this.ctx.createOscillator();
    const bodyGain = this.ctx.createGain();
    body.type = "sine";
    body.frequency.value = bodyHz;
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(bodyPeak, t + 0.005);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + bodyDecay);
    body.connect(bodyGain);
    bodyGain.connect(this.master);
    body.start(t);
    body.stop(t + bodyDecay + 0.03);

    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = "sine";
    sub.frequency.value = subHz;
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(subPeak, t + 0.008);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + subDecay);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + subDecay + 0.03);

    const partial = this.ctx.createOscillator();
    const partialGain = this.ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = partialHz;
    partialGain.gain.setValueAtTime(0.0001, t);
    partialGain.gain.exponentialRampToValueAtTime(partialPeak, t + 0.004);
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

  private playDeath() {
    if (!this.ctx || !this.master) return;
    this.playExplosion(0.8, 180, 0.9);
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.7);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.95);
  }

  private playWaveClear() {
    if (!this.ctx || !this.master) return;

    if (this.engine === "tone") {
      if (this.playBaked("waveClear", 1)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      const notes = ["E4", "G#4", "B4", "Eb5"];
      const now = Tone.now();
      for (let i = 0; i < notes.length; i++) {
        eng.waveClearSynth.triggerAttackRelease(notes[i], "4n", now + i * 0.06, 0.7);
      }
      return;
    }

    const t = this.ctx.currentTime;
    const chordFrequencies = [330, 415, 494, 622];
    for (let i = 0; i < chordFrequencies.length; i++) {
      const freq = chordFrequencies[i];
      const start = t + i * 0.06;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(start);
      osc.stop(start + 0.7);
    }
  }

  // Deep punchy kick on C2. Sine sweep + a tiny click for definition.
  // `pitchRatio` scales the tonal sweep so split-children of a bassteroid
  // can sound a fourth/octave below the parent (see Game.bassPitchRatio).
  private playBassKick(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;

    if (this.engine === "tone") {
      if (this.playBaked("bassKick", pitchRatio)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      const note = 65.4 * pitchRatio;
      eng.bassKick.triggerAttackRelease(note, "16n", undefined, 0.95);
      return;
    }

    const t = this.ctx.currentTime;
    const startHz = cfgN("bassKick", "startHz", 140);
    const endHz = cfgN("bassKick", "endHz", 55);
    const sweepTime = cfgN("bassKick", "sweepTime", 0.09);
    const peak = cfgN("bassKick", "peak", 0.55);
    const decay = cfgN("bassKick", "decay", 0.32);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(startHz * pitchRatio, t);
    osc.frequency.exponentialRampToValueAtTime(endHz * pitchRatio, t + sweepTime);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + decay + 0.02);

    const clickBuf = this.makeNoiseBuffer(0.04);
    if (!clickBuf) return;
    const click = this.ctx.createBufferSource();
    click.buffer = clickBuf;
    const clickFilter = this.ctx.createBiquadFilter();
    clickFilter.type = "highpass";
    clickFilter.frequency.value = 1800;
    const clickGain = this.ctx.createGain();
    clickGain.gain.setValueAtTime(0.18, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(this.master);
    click.start(t);
    click.stop(t + 0.05);
  }

  // Sub-bass "boom" on F2 (the IV of C major). Sine body with a brief
  // pitch sweep for thump, an F1 sub layer for body, and a short bandpassed
  // noise clack for attack. Heftier than the pluck, darker than the kick,
  // and stays inside the C-F-G chord pocket so layering with kick/pluck
  // reads as a I/IV/V bassline rather than a dissonant pile.
  private playBassBoom(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;

    if (this.engine === "tone") {
      if (this.playBaked("bassBoom", pitchRatio)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      const note = 87.3 * pitchRatio;
      eng.bassBoom.triggerAttackRelease(note, "8n", undefined, 0.9);
      return;
    }

    const t = this.ctx.currentTime;
    const startHz = cfgN("bassBoom", "startHz", 180);
    const endHz = cfgN("bassBoom", "endHz", 87.3);
    const sweepTime = cfgN("bassBoom", "sweepTime", 0.06);
    const peak = cfgN("bassBoom", "peak", 0.5);
    const decay = cfgN("bassBoom", "decay", 0.42);
    const subHz = cfgN("bassBoom", "subHz", 43.65);
    const subPeak = cfgN("bassBoom", "subPeak", 0.28);
    const subDecay = cfgN("bassBoom", "subDecay", 0.5);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(startHz * pitchRatio, t);
    osc.frequency.exponentialRampToValueAtTime(endHz * pitchRatio, t + sweepTime);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + decay + 0.03);

    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = "sine";
    sub.frequency.value = subHz * pitchRatio;
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(subPeak, t + 0.01);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + subDecay);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + subDecay + 0.05);

    const clackBuf = this.makeNoiseBuffer(0.035);
    if (!clackBuf) return;
    const clack = this.ctx.createBufferSource();
    clack.buffer = clackBuf;
    const clackFilter = this.ctx.createBiquadFilter();
    clackFilter.type = "bandpass";
    clackFilter.frequency.value = 1100;
    clackFilter.Q.value = 1.4;
    const clackGain = this.ctx.createGain();
    clackGain.gain.setValueAtTime(0.14, t);
    clackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    clack.connect(clackFilter);
    clackFilter.connect(clackGain);
    clackGain.connect(this.master);
    clack.start(t);
    clack.stop(t + 0.04);
  }

  // Percussive "snap" — a snare-leaning hybrid that gives beat 4 a sharp
  // accent without piling another sub onto the bottom. Bandpassed noise
  // body + a short tonal triangle at C3 that pitches down for a snare-like
  // body. Sits an octave above the kick/pluck/boom region so the four-voice
  // pattern reads as kick-pluck-boom-snap rather than a wall of low end.
  private playBassSnap(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;

    if (this.engine === "tone") {
      if (this.playBaked("bassSnap", pitchRatio)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      eng.bassSnap.triggerAttackRelease("C3", "16n", undefined, 0.7 + pitchRatio * 0.0);
      return;
    }

    const t = this.ctx.currentTime;
    const noiseStartHz = cfgN("bassSnap", "noiseStartHz", 1700);
    const noiseEndHz = cfgN("bassSnap", "noiseEndHz", 700);
    const noiseQ = cfgN("bassSnap", "noiseQ", 1.1);
    const noisePeak = cfgN("bassSnap", "noisePeak", 0.28);
    const noiseDecay = cfgN("bassSnap", "noiseDecay", 0.15);
    const bodyStartHz = cfgN("bassSnap", "bodyStartHz", 330);
    const bodyEndHz = cfgN("bassSnap", "bodyEndHz", 130.8);
    const bodyPeak = cfgN("bassSnap", "bodyPeak", 0.22);
    const bodyDecay = cfgN("bassSnap", "bodyDecay", 0.12);
    const noiseBuf = this.makeNoiseBuffer(Math.max(0.05, noiseDecay - 0.02));
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const nFilter = this.ctx.createBiquadFilter();
    nFilter.type = "bandpass";
    nFilter.frequency.setValueAtTime(noiseStartHz, t);
    nFilter.frequency.exponentialRampToValueAtTime(noiseEndHz, t + noiseDecay - 0.02);
    nFilter.Q.value = noiseQ;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(noisePeak, t);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + noiseDecay);
    noise.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(this.master);
    noise.start(t);
    noise.stop(t + noiseDecay + 0.01);

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(bodyStartHz * pitchRatio, t);
    osc.frequency.exponentialRampToValueAtTime(bodyEndHz * pitchRatio, t + Math.max(0.02, bodyDecay - 0.03));
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(bodyPeak, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + bodyDecay);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + bodyDecay + 0.02);
  }

  // Plucked sub-bass at G2 with a closing lowpass filter — distinct timbre
  // from the kick so the two layer rather than mask each other.
  private playBassPluck(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;

    if (this.engine === "tone") {
      if (this.playBaked("bassPluck", pitchRatio)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      const note = 98 * pitchRatio;
      eng.bassPluck.triggerAttackRelease(note, "8n", undefined, 0.85);
      return;
    }

    const t = this.ctx.currentTime;
    const fundamentalHz = cfgN("bassPluck", "fundamentalHz", 98);
    const filterStartHz = cfgN("bassPluck", "filterStartHz", 1400);
    const filterEndHz = cfgN("bassPluck", "filterEndHz", 220);
    const filterQ = cfgN("bassPluck", "filterQ", 6);
    const peak = cfgN("bassPluck", "peak", 0.28);
    const decay = cfgN("bassPluck", "decay", 0.45);
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    osc1.type = "sawtooth";
    osc2.type = "triangle";
    osc1.frequency.value = fundamentalHz * pitchRatio;
    osc2.frequency.value = (fundamentalHz + 0.3) * pitchRatio;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = filterQ;
    filter.frequency.setValueAtTime(filterStartHz, t);
    filter.frequency.exponentialRampToValueAtTime(filterEndHz, t + decay * 0.89);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + decay + 0.03);
    osc2.stop(t + decay + 0.03);
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
    if (!this.ctx || !this.master) return;

    if (this.engine === "tone") {
      if (this.playBaked("chime", 1)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      eng.chimeSynth.triggerAttackRelease(["C6", "G6"], "8n", undefined, 0.65);
      return;
    }

    const t = this.ctx.currentTime;
    const fundamentalFreq = cfgN("chime", "fundamentalHz", 1046.5);
    const peakBase = cfgN("chime", "peak", 0.16);
    const decayBase = cfgN("chime", "decay", 0.9);
    const partialRatios = [
      1,
      cfgN("chime", "partial1Ratio", 2.005),
      cfgN("chime", "partial2Ratio", 3.01),
    ];
    for (let i = 0; i < partialRatios.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = fundamentalFreq * partialRatios[i];
      const peak = peakBase / (i + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.1, decayBase - i * 0.15));
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + decayBase + 0.1);
    }
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
  private playComboSparkle() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const partialFrequencies = [880, 1318.5]; // A5, E6 (perfect fifth)
    for (let i = 0; i < partialFrequencies.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(partialFrequencies[i], t);
      const peak = 0.07 / (i + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.24);
    }
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

  // Ascending sine arpeggio with a sparkle overlay — the "you got something
  // good" jingle that plays when the ship flies over a canister.
  private playPowerup() {
    if (!this.ctx || !this.master) return;

    if (this.engine === "tone") {
      if (this.playBaked("powerup", 1)) return;
      const eng = this.ensureToneEngine();
      if (!eng) return;
      const notes = ["C5", "E5", "G5", "C6"];
      const now = Tone.now();
      for (let i = 0; i < notes.length; i++) {
        eng.powerupSynth.triggerAttackRelease(notes[i], "16n", now + i * 0.06, 0.7);
      }
      return;
    }

    const t = this.ctx.currentTime;
    const arpeggioFrequencies = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    for (let i = 0; i < arpeggioFrequencies.length; i++) {
      const start = t + i * 0.06;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = arpeggioFrequencies[i];
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(start);
      osc.stop(start + 0.55);
    }
    const shimmer = this.ctx.createOscillator();
    const shimmerGain = this.ctx.createGain();
    shimmer.type = "sine";
    shimmer.frequency.setValueAtTime(2093, t);
    shimmer.frequency.exponentialRampToValueAtTime(3520, t + 0.35);
    shimmerGain.gain.setValueAtTime(0.0001, t);
    shimmerGain.gain.exponentialRampToValueAtTime(0.1, t + 0.06);
    shimmerGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(this.master);
    shimmer.start(t);
    shimmer.stop(t + 0.5);
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
