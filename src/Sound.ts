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

type SoundName =
  | "fire"
  | "fireBeat"
  | "explosionLarge"
  | "explosionMedium"
  | "explosionSmall"
  | "thrust"
  | "death"
  | "hyperspace"
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
  | "alienExplode";

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
  }

  resume() {
    this.ensureContext();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on && this.thrustNode) this.stopThrust();
    if (!on) this.stopAllAlienDrones();
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
    switch (name) {
      case "fire": this.playFire(); break;
      case "fireBeat": this.playFireBeat(); break;
      case "explosionLarge": this.playExplosion(0.7, 160, 0.55); break;
      case "explosionMedium": this.playExplosion(0.55, 230, 0.42); break;
      case "explosionSmall": this.playExplosion(0.4, 340, 0.3); break;
      case "thrust": this.startThrust(); break;
      case "death": this.playDeath(); break;
      case "hyperspace": this.playHyperspace(); break;
      case "waveClear": this.playWaveClear(); break;
      case "bassKick": this.playBassKick(pitchRatio); break;
      case "bassPluck": this.playBassPluck(pitchRatio); break;
      case "bassBoom": this.playBassBoom(pitchRatio); break;
      case "bassSnap": this.playBassSnap(pitchRatio); break;
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
      case "bgBeat": this.playBgBeat(pitchRatio); break;
      case "shockwaveCharge": this.playShockwaveCharge(); break;
      case "shockwaveBoom": this.playShockwaveBoom(); break;
      case "alienFireBig": this.playAlienFireBig(); break;
      case "alienFireMedium": this.playAlienFireMedium(); break;
      case "alienFireSmall": this.playAlienFireSmall(); break;
      case "alienHit": this.playAlienHit(); break;
      case "alienExplode": this.playAlienExplode(); break;
    }
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
  // (1.2s) so it tops out exactly as the flash fires.
  private playShockwaveCharge() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const duration = 1.2;

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
    const t = this.ctx.currentTime;
    const intensity = Math.max(0, Math.min(1, this.bgBeatIntensity));
    // Peak amplitude scales concavely with intensity. Floor (0.06) is below
    // every other gameplay sound (comboTick 0.18, chime partials 0.07) but
    // still clearly audible on laptop/phone speakers. Peak (~0.55) at full
    // intensity is heavier than explosions, which sells "ominous rumble" at
    // wave 30.
    const peak = 0.06 + intensity * intensity * 0.5;

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
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.6);

    // Sub-octave reinforcement (~32 Hz). Mostly inaudible as a pitch on
    // small speakers but adds the chest-rumble body on headphones/subwoofer.
    // Scaled aggressively with intensity so it barely contributes at wave 1
    // and dominates the low spectrum by wave 30.
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = baseFreq * 0.5;
    const subGain = this.ctx.createGain();
    const subPeak = peak * (0.3 + 0.7 * intensity);
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(subPeak, t + 0.05);
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

    const body = this.ctx.createOscillator();
    const bodyGain = this.ctx.createGain();
    body.type = "sine";
    body.frequency.value = 392; // G4
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    body.connect(bodyGain);
    bodyGain.connect(this.master);
    body.start(t);
    body.stop(t + 0.13);

    const partial = this.ctx.createOscillator();
    const partialGain = this.ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = 784; // G5
    partialGain.gain.setValueAtTime(0.0001, t);
    partialGain.gain.exponentialRampToValueAtTime(0.07, t + 0.003);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    partial.connect(partialGain);
    partialGain.connect(this.master);
    partial.start(t);
    partial.stop(t + 0.07);

    const tickBuf = this.makeNoiseBuffer(0.02);
    if (!tickBuf) return;
    const tick = this.ctx.createBufferSource();
    tick.buffer = tickBuf;
    const tickFilter = this.ctx.createBiquadFilter();
    tickFilter.type = "bandpass";
    tickFilter.frequency.value = 1600;
    tickFilter.Q.value = 1.2;
    const tickGain = this.ctx.createGain();
    tickGain.gain.setValueAtTime(0.04, t);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    tick.connect(tickFilter);
    tickFilter.connect(tickGain);
    tickGain.connect(this.master);
    tick.start(t);
    tick.stop(t + 0.025);
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
    const t = this.ctx.currentTime;

    const body = this.ctx.createOscillator();
    const bodyGain = this.ctx.createGain();
    body.type = "sine";
    body.frequency.value = 130.8; // C3
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.38, t + 0.005);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    body.connect(bodyGain);
    bodyGain.connect(this.master);
    body.start(t);
    body.stop(t + 0.27);

    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = "sine";
    sub.frequency.value = 65.4; // C2
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.28, t + 0.008);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 0.31);

    const partial = this.ctx.createOscillator();
    const partialGain = this.ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = 196; // G3 (perfect fifth above carrier)
    partialGain.gain.setValueAtTime(0.0001, t);
    partialGain.gain.exponentialRampToValueAtTime(0.12, t + 0.004);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    partial.connect(partialGain);
    partialGain.connect(this.master);
    partial.start(t);
    partial.stop(t + 0.12);

    const tickBuf = this.makeNoiseBuffer(0.03);
    if (!tickBuf) return;
    const tick = this.ctx.createBufferSource();
    tick.buffer = tickBuf;
    const tickFilter = this.ctx.createBiquadFilter();
    tickFilter.type = "bandpass";
    tickFilter.frequency.value = 600;
    tickFilter.Q.value = 1.0;
    const tickGain = this.ctx.createGain();
    tickGain.gain.setValueAtTime(0.09, t);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    tick.connect(tickFilter);
    tickFilter.connect(tickGain);
    tickGain.connect(this.master);
    tick.start(t);
    tick.stop(t + 0.035);
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

  private playHyperspace() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(1800, t + 0.25);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.55);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.65);

    const noiseBuf = this.makeNoiseBuffer(0.5);
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(4000, t + 0.3);
    filter.Q.value = 4;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.0001, t);
    nGain.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.5);
  }

  private playWaveClear() {
    if (!this.ctx || !this.master) return;
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
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140 * pitchRatio, t);
    osc.frequency.exponentialRampToValueAtTime(55 * pitchRatio, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.55, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.34);

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
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180 * pitchRatio, t);
    osc.frequency.exponentialRampToValueAtTime(87.3 * pitchRatio, t + 0.06);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.45);

    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = "sine";
    sub.frequency.value = 43.65 * pitchRatio; // F1
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.28, t + 0.01);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 0.55);

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
    const t = this.ctx.currentTime;
    const noiseBuf = this.makeNoiseBuffer(0.13);
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const nFilter = this.ctx.createBiquadFilter();
    nFilter.type = "bandpass";
    nFilter.frequency.setValueAtTime(1700, t);
    nFilter.frequency.exponentialRampToValueAtTime(700, t + 0.13);
    nFilter.Q.value = 1.1;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.28, t);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    noise.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.16);

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(330 * pitchRatio, t);
    osc.frequency.exponentialRampToValueAtTime(130.8 * pitchRatio, t + 0.09); // → C3
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  // Plucked sub-bass at G2 with a closing lowpass filter — distinct timbre
  // from the kick so the two layer rather than mask each other.
  private playBassPluck(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    osc1.type = "sawtooth";
    osc2.type = "triangle";
    osc1.frequency.value = 98.0 * pitchRatio;
    osc2.frequency.value = 98.3 * pitchRatio;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(1400, t);
    filter.frequency.exponentialRampToValueAtTime(220, t + 0.4);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.48);
    osc2.stop(t + 0.48);
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
    const t = this.ctx.currentTime;
    const fundamentalFreq = 1046.5; // C6
    const partialRatios = [1, 2.005, 3.01];
    for (let i = 0; i < partialRatios.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = fundamentalFreq * partialRatios[i];
      const peak = 0.16 / (i + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9 - i * 0.15);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + 1.0);
    }
  }

  // Lower bell with inharmonic partials — feels like a temple bell rather
  // than a wind-chime.
  private playBell() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const fundamentalFreq = 220; // A3
    const partialRatios = [1, 2.76, 5.4, 8.93];
    for (let i = 0; i < partialRatios.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = fundamentalFreq * partialRatios[i];
      const peak = 0.22 / (i + 1.2);
      const decay = 1.4 - i * 0.22;
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
    const partialFrequencies = [1760, 2637]; // A6, E7 (perfect fifth)
    for (let i = 0; i < partialFrequencies.length; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(partialFrequencies[i], t);
      const peak = 0.18 / (i + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.42);
    }
  }

  // Ascending sine arpeggio with a sparkle overlay — the "you got something
  // good" jingle that plays when the ship flies over a canister.
  private playPowerup() {
    if (!this.ctx || !this.master) return;
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
