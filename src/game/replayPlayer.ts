import { ReplayInput } from "./replayInput";
import type { Ship } from "../Ship";
import type { ReplayPayload } from "./replayFormat";

// Drives a deterministic re-run from a serialised payload. Each tick:
//   1. tick(game) — pops the next frame; sets game's dt + key state on the
//      shared ReplayInput; returns false when the stream is exhausted.
//   2. gameUpdate runs as normal (read inputs, advance sim, fire audio).
export class ReplayPlayer {
  readonly payload: ReplayPayload;
  readonly input = new ReplayInput();
  // Per-frame rhythm (beatCombo) sampled during the re-sim, indexed by frame.
  //   The replay payload only stores inputs, so combo is recovered by stepping
  //   the sim; the scrubber draws this as a histogram. Filled lazily as frames
  //   are consumed (a startReplay precompute sweep fills the whole thing).
  readonly rhythmByFrame: Int16Array;
  // First frame of each wave (with its displayed wave number), recovered during
  //   the same re-sim sweep that fills rhythmByFrame. The scrubber marks these
  //   as dots with a "Wave N" tooltip.
  readonly waveStarts: { frame: number; wave: number }[] = [];
  private prevWave = 0;
  private cursor = 0;
  private divergenceReported = false;

  constructor(payload: ReplayPayload) {
    this.payload = payload;
    this.rhythmByFrame = new Int16Array(payload.frames.length);
  }

  // Record the rhythm value + watch for wave changes on the frame just consumed
  //   (cursor - 1). Called after the sim advances so it reflects the combo/wave
  //   that frame ended on.
  sampleRhythm(combo: number, wave: number): void {
    const i = this.cursor - 1;
    if (i >= 0 && i < this.rhythmByFrame.length) this.rhythmByFrame[i] = combo;
    if (wave !== this.prevWave) {
      this.prevWave = wave;
      if (i >= 0) this.waveStarts.push({ frame: i, wave });
    }
  }

  // Frames already consumed (== the playhead position for the scrubber).
  position(): number {
    return this.cursor;
  }

  total(): number {
    return this.payload.frames.length;
  }

  // Reset the playhead so a fresh world (rebuilt by seedReplayWorld) can replay
  //   from frame 0. The ReplayInput's key state resets too — otherwise a key
  //   left "down" at the old cursor would leak into the re-sim.
  rewindToStart(): void {
    this.cursor = 0;
    this.divergenceReported = false;
    this.input.keys.clear();
    this.input.justPressed.clear();
  }

  // The next recorded frame's dt (seconds) without consuming it, or null when
  //   finished. Lets the playback loop budget wall-clock time before stepping.
  peekFrameDt(): number | null {
    if (this.cursor >= this.payload.frames.length) return null;
    return this.payload.frames[this.cursor][0];
  }

  // Returns the next recorded dt (seconds), or null when finished. Mutates
  // the ReplayInput's key state in place so the rest of the sim doesn't need
  // to know a replay is happening.
  nextFrame(): number | null {
    if (this.cursor >= this.payload.frames.length) return null;
    const [dt, downMask, upMask] = this.payload.frames[this.cursor++];
    const downKeys: string[] = [];
    const upKeys: string[] = [];
    const vocab = this.payload.header.keyVocab;
    for (let i = 0; i < vocab.length; i++) {
      const bit = 1 << i;
      if (downMask & bit) downKeys.push(vocab[i]);
      if (upMask & bit) upKeys.push(vocab[i]);
    }
    this.input.applyFrame(downKeys, upKeys);
    return dt;
  }

  // Called after ship.update during replay. Compares the live ship state +
  //   input set against the recorded debugFrame; logs the first divergence so
  //   we can pinpoint where replay drifts from the original.
  checkShipAgainstRecording(ship: Ship): void {
    if (this.divergenceReported) return;
    const debug = this.payload.debugFrames;
    if (!debug) return;
    const i = this.cursor - 1;
    if (i < 0 || i >= debug.length) return;
    const rec = debug[i];
    const EPS = 1e-4;
    const liveKeys = [...this.input.keys].sort();
    const keysMatch = liveKeys.length === rec.keys.length && liveKeys.every((k, j) => k === rec.keys[j]);
    const posDiverged = Math.abs(ship.pos.x - rec.posX) > EPS || Math.abs(ship.pos.y - rec.posY) > EPS;
    const velDiverged = Math.abs(ship.vel.x - rec.velX) > EPS || Math.abs(ship.vel.y - rec.velY) > EPS;
    const headDiverged = Math.abs(ship.heading - rec.heading) > EPS;
    if (!keysMatch || posDiverged || velDiverged || headDiverged) {
      this.divergenceReported = true;
      // eslint-disable-next-line no-console
      console.warn("[replay] divergence at frame", i, {
        recorded: rec,
        replayed: {
          posX: ship.pos.x, posY: ship.pos.y,
          velX: ship.vel.x, velY: ship.vel.y,
          heading: ship.heading,
          keys: liveKeys,
        },
        deltas: {
          dPosX: ship.pos.x - rec.posX,
          dPosY: ship.pos.y - rec.posY,
          dVelX: ship.vel.x - rec.velX,
          dVelY: ship.vel.y - rec.velY,
          dHeading: ship.heading - rec.heading,
          keysMatch,
        },
      });
    }
  }

  done(): boolean {
    return this.cursor >= this.payload.frames.length;
  }
}
