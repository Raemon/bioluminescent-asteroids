type SoundName = "fire" | "explosionLarge" | "explosionMedium" | "explosionSmall" | "thrust" | "death" | "hyperspace" | "waveClear";

export class Sound {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  thrustNode: { osc: OscillatorNode; gain: GainNode; noise: AudioBufferSourceNode; noiseGain: GainNode } | null = null;
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
    const noiseBuf = this.makeNoiseBuffer(1.0);
    if (!noiseBuf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 600;
    noiseFilter.Q.value = 0.8;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.18, t + 0.08);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.master);
    noise.start(t);

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = 80;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.08);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);

    this.thrustNode = { osc, gain, noise, noiseGain };
  }

  stopThrust() {
    if (!this.ctx || !this.thrustNode) return;
    const t = this.ctx.currentTime;
    const { osc, gain, noise, noiseGain } = this.thrustNode;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    noiseGain.gain.cancelScheduledValues(t);
    noiseGain.gain.setValueAtTime(noiseGain.gain.value, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.stop(t + 0.1);
    noise.stop(t + 0.1);
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
}
