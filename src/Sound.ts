type SoundName =
  | "fire"
  | "explosionLarge"
  | "explosionMedium"
  | "explosionSmall"
  | "thrust"
  | "death"
  | "hyperspace"
  | "waveClear"
  | "bassKick"
  | "bassPluck"
  | "bassHit"
  | "chime"
  | "bell"
  | "warble"
  | "comboTick"
  | "comboSparkle"
  | "tink"
  | "powerup"
  | "shieldPop";

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
  }

  private makeNoiseBuffer(duration: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buf = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  play(name: SoundName) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    switch (name) {
      case "fire": this.playFire(); break;
      case "explosionLarge": this.playExplosion(0.7, 220, 0.55); break;
      case "explosionMedium": this.playExplosion(0.55, 320, 0.42); break;
      case "explosionSmall": this.playExplosion(0.4, 480, 0.3); break;
      case "thrust": this.startThrust(); break;
      case "death": this.playDeath(); break;
      case "hyperspace": this.playHyperspace(); break;
      case "waveClear": this.playWaveClear(); break;
      case "bassKick": this.playBassKick(); break;
      case "bassPluck": this.playBassPluck(); break;
      case "bassHit": this.playBassHit(); break;
      case "chime": this.playChime(); break;
      case "bell": this.playBell(); break;
      case "warble": this.playWarble(); break;
      case "comboTick": this.playComboTick(); break;
      case "comboSparkle": this.playComboSparkle(); break;
      case "tink": this.playTink(); break;
      case "powerup": this.playPowerup(); break;
      case "shieldPop": this.playShieldPop(); break;
    }
  }

  private playFire() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.18);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);

    const shimmer = this.ctx.createOscillator();
    const shimmerGain = this.ctx.createGain();
    shimmer.type = "sine";
    shimmer.frequency.setValueAtTime(2200, t);
    shimmer.frequency.exponentialRampToValueAtTime(1400, t + 0.1);
    shimmerGain.gain.setValueAtTime(0.0001, t);
    shimmerGain.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
    shimmerGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(this.master);
    shimmer.start(t);
    shimmer.stop(t + 0.12);
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
  private playBassKick() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.09);
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

  // Plucked sub-bass at G2 with a closing lowpass filter — distinct timbre
  // from the kick so the two layer rather than mask each other.
  private playBassPluck() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    osc1.type = "sawtooth";
    osc2.type = "triangle";
    osc1.frequency.value = 98.0;
    osc2.frequency.value = 98.3;

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

  // The "cool initial noise" played when a bass asteroid is first shot. A
  // downward bitcrushed-feeling sweep with a noise transient on top.
  private playBassHit() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.28);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 8;
    filter.frequency.setValueAtTime(3500, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + 0.28);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.34);

    const noiseBuf = this.makeNoiseBuffer(0.18);
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const nFilter = this.ctx.createBiquadFilter();
    nFilter.type = "bandpass";
    nFilter.frequency.setValueAtTime(2000, t);
    nFilter.frequency.exponentialRampToValueAtTime(400, t + 0.18);
    nFilter.Q.value = 2;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.25, t);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    noise.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.2);
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
