// Offline audio capture for the replay MP4/WAV exporter. Sound.ts drives every
//   voice off `this.ctx` (node factories + currentTime + the lookahead
//   scheduler's runningAudioTime), so capture works by swapping that field for
//   a CaptureAudioContext: the same dispatch code computes its parameters and
//   builds its real node graph, but on an OfflineAudioContext whose "now" is
//   the export clock — accumulated recorded dt, the same timeline the video
//   frames are stamped with. One startRendering() pass then produces the whole
//   soundtrack. No live audio plays and nothing is approximated per-voice:
//   baked one-shots, live-synth one-shots, spatial drones (per-frame
//   setTargetAtTime automation), halo music stems (gain-ramp tiers), vocals
//   and beat-scheduled cues all land through their normal code paths.

// Export clock: seconds of replay time consumed so far. The exporter sets
//   `now` to the frame's presentation time before stepping the sim, so every
//   ctx.currentTime read during that frame's update+render resolves to it.
//   This is the entire clock translation: beat-aligned voices compute
//   "runningAudioTime() + beatDelta / rate", which becomes an absolute offline
//   timestamp because runningAudioTime() reads this clock during capture.
export class ExportClock {
  now = 0;
}

type StartableNode = AudioBufferSourceNode | OscillatorNode | ConstantSourceNode;

// A source node's no-arg start()/stop() means "at ctx.currentTime" — but an
//   OfflineAudioContext's real currentTime is frozen at 0 until rendering, so
//   those calls must be re-anchored to the export clock. stop() additionally
//   swallows errors: Sound's release-cleanup setTimeouts run on the wall clock
//   and can fire after the capture ends, against an already-rendered graph.
const wrapSourceTiming = <T extends StartableNode>(node: T, clock: ExportClock): T => {
  const rawStart = node.start.bind(node) as (when?: number, offset?: number, duration?: number) => void;
  const rawStop = node.stop.bind(node);
  (node as AudioBufferSourceNode).start = (when?: number, offset?: number, duration?: number) => {
    if (duration !== undefined) rawStart(when ?? clock.now, offset, duration);
    else if (offset !== undefined) rawStart(when ?? clock.now, offset);
    else rawStart(when ?? clock.now);
  };
  node.stop = (when?: number) => {
    try { rawStop(when ?? clock.now); } catch { /* post-capture stray cleanup */ }
  };
  return node;
};

// The AudioContext surface Sound.ts actually touches (audit: grep `this.ctx.`
//   / `ctx.` in Sound.ts — the factories below plus currentTime, sampleRate,
//   state, destination, decodeAudioData, resume). `state` reports "running" so
//   runningAudioTime() keeps feeding the lookahead scheduler during capture.
//   Sound stores this via `as unknown as AudioContext`.
export class CaptureAudioContext {
  readonly offline: OfflineAudioContext;
  readonly clock: ExportClock;

  constructor(offline: OfflineAudioContext, clock: ExportClock) {
    this.offline = offline;
    this.clock = clock;
  }

  get currentTime(): number { return this.clock.now; }
  get sampleRate(): number { return this.offline.sampleRate; }
  get state(): AudioContextState { return "running"; }
  get destination(): AudioDestinationNode { return this.offline.destination; }

  resume(): Promise<void> { return Promise.resolve(); }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.offline.decodeAudioData(data);
  }

  createGain(): GainNode { return this.offline.createGain(); }
  createBiquadFilter(): BiquadFilterNode { return this.offline.createBiquadFilter(); }
  createDynamicsCompressor(): DynamicsCompressorNode { return this.offline.createDynamicsCompressor(); }
  createWaveShaper(): WaveShaperNode { return this.offline.createWaveShaper(); }
  createStereoPanner(): StereoPannerNode { return this.offline.createStereoPanner(); }
  createConvolver(): ConvolverNode { return this.offline.createConvolver(); }
  createAnalyser(): AnalyserNode { return this.offline.createAnalyser(); }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return this.offline.createBuffer(channels, length, sampleRate);
  }

  createOscillator(): OscillatorNode {
    return wrapSourceTiming(this.offline.createOscillator(), this.clock);
  }

  createBufferSource(): AudioBufferSourceNode {
    return wrapSourceTiming(this.offline.createBufferSource(), this.clock);
  }

  createConstantSource(): ConstantSourceNode {
    return wrapSourceTiming(this.offline.createConstantSource(), this.clock);
  }
}

// 16-bit PCM WAV blob from a rendered AudioBuffer — the Stage-A verification
//   artifact (window.__exportReplayAudio) for by-ear A/B against live playback.
export const encodeWavBlob = (buf: AudioBuffer): Blob => {
  const numCh = buf.numberOfChannels;
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * numCh * 2, true);
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
  return new Blob([out], { type: "audio/wav" });
};
