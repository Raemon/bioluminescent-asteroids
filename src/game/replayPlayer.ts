import { ReplayInput } from "./replayInput";
import type { ReplayPayload } from "./replayFormat";

// Drives a deterministic re-run from a serialised payload. Each tick:
//   1. tick(game) — pops the next frame; sets game's dt + key state on the
//      shared ReplayInput; returns false when the stream is exhausted.
//   2. gameUpdate runs as normal (read inputs, advance sim, fire audio).
export class ReplayPlayer {
  readonly payload: ReplayPayload;
  readonly input = new ReplayInput();
  private cursor = 0;

  constructor(payload: ReplayPayload) {
    this.payload = payload;
  }

  // Returns the next recorded dt (seconds), or null when finished. Mutates
  // the ReplayInput's key state in place so the rest of the sim doesn't need
  // to know a replay is happening.
  nextFrame(): number | null {
    if (this.cursor >= this.payload.frames.length) return null;
    const [dtMs, downMask, upMask] = this.payload.frames[this.cursor++];
    const downKeys: string[] = [];
    const upKeys: string[] = [];
    const vocab = this.payload.header.keyVocab;
    for (let i = 0; i < vocab.length; i++) {
      const bit = 1 << i;
      if (downMask & bit) downKeys.push(vocab[i]);
      if (upMask & bit) upKeys.push(vocab[i]);
    }
    this.input.applyFrame(downKeys, upKeys);
    return dtMs / 1000;
  }

  done(): boolean {
    return this.cursor >= this.payload.frames.length;
  }
}
