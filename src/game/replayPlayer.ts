import { ReplayInput } from "./replayInput";
import type { Ship } from "../Ship";
import type { ReplayCheckpoint, ReplayPayload } from "./replayFormat";

// One detected checkpoint mismatch: the frame it occurred on, the recording's
//   wall-time offset (sum of dt up to that frame, for "Ns in"), and every field
//   that drifted with its recorded vs replayed values + delta. Collected into a
//   queryable history so a desync can be inspected after the fact, not just on
//   the one frame a console.warn happened to fire.
export type CheckpointDivergence = {
  frame: number;
  timeSec: number;
  fields: { field: string; recorded: number; replayed: number; delta: number }[];
};

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
  // Loudly log only the FIRST divergence in full; later ones still accumulate
  //   into `divergences` but log compactly, so the console isn't flooded.
  private firstDivergenceLogged = false;
  // frameIndex → recorded beatTime adjustment the live run's resnap watchdog made.
  //   Replay has no audio clock, so it re-applies these instead of re-deriving them.
  private readonly beatResnapByFrame: Map<number, number>;
  // frameIndex → ground-truth sim-state checkpoint. Replay asserts against these.
  private readonly checkpointByFrame: Map<number, ReplayCheckpoint>;
  // frameIndex → recording wall-time (cumulative dt) at that frame, for "Ns in".
  private readonly frameTimeSec: Map<number, number>;
  // Full history of every checkpoint mismatch seen this playthrough. Cleared on
  //   rewindToStart so a fresh sweep/seek starts clean. Queryable post-hoc.
  readonly divergences: CheckpointDivergence[] = [];
  // When false, assertCheckpoint records into `divergences` but emits no console
  //   output — the precompute sweep sets this so only the end-of-sweep audit
  //   prints, instead of flooding the console with hundreds of cascade lines.
  logDivergences = true;
  // Full recorded vs replayed checkpoint at the FIRST divergence, for devtools
  //   inspection (window.__firstDivergence) without console truncation.
  firstDivergencePair: { recorded: ReplayCheckpoint; replayed: ReplayCheckpoint } | null = null;

  constructor(payload: ReplayPayload) {
    this.payload = payload;
    this.rhythmByFrame = new Int16Array(payload.frames.length);
    this.beatResnapByFrame = new Map(payload.beatResnaps ?? []);
    this.checkpointByFrame = new Map((payload.checkpoints ?? []).map((c) => [c.frame, c]));
    // Prefix-sum dt up to each checkpoint frame so divergences can report "Ns in".
    this.frameTimeSec = new Map();
    let t = 0;
    for (let i = 0; i < payload.frames.length; i++) {
      t += payload.frames[i][0];
      if (this.checkpointByFrame.has(i)) this.frameTimeSec.set(i, t);
    }
  }

  // True if this run carries checkpoints (older payloads / clip rebuilds may not).
  hasCheckpoints(): boolean {
    return this.checkpointByFrame.size > 0;
  }

  // Count of recorded beat-resnap corrections — zero means the watchdog never
  //   fired during recording, so any beatTime drift can't be a missing-resnap bug.
  beatResnapCount(): number {
    return this.beatResnapByFrame.size;
  }

  checkpointCount(): number {
    return this.checkpointByFrame.size;
  }

  // Assert the live sim state against the recorded checkpoint for the frame just
  //   consumed, if one exists. EVERY mismatch is appended to `divergences` (so the
  //   full drift history is queryable); the FIRST is logged loudly with full
  //   context, the rest compactly so the console isn't flooded. beatTime gets a
  //   float epsilon; the rest are exact integers. No early latch — we want to see
  //   the whole cascade (which field broke first vs. which followed).
  assertCheckpoint(state: Omit<ReplayCheckpoint, "frame">): void {
    const cp = this.checkpointByFrame.get(this.cursor - 1);
    if (!cp) return;
    const BEAT_EPS = 1e-3;
    const fields: CheckpointDivergence["fields"] = [];
    const check = (field: keyof typeof state, eps = 0) => {
      const recorded = cp[field];
      const replayed = state[field];
      const delta = replayed - recorded;
      if (Math.abs(delta) > eps) fields.push({ field, recorded, replayed, delta });
    };
    check("score");
    check("wave");
    check("lives");
    check("beatCombo");
    check("beatTime", BEAT_EPS);
    check("asteroids");
    check("bullets");
    check("aliens");
    check("rngState");
    if (fields.length === 0) return;
    const timeSec = this.frameTimeSec.get(cp.frame) ?? 0;
    this.divergences.push({ frame: cp.frame, timeSec, fields });
    if (this.firstDivergencePair === null) {
      this.firstDivergencePair = { recorded: cp, replayed: { frame: cp.frame, ...state } };
    }
    if (!this.logDivergences) return;
    if (!this.firstDivergenceLogged) {
      this.firstDivergenceLogged = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[replay] FIRST checkpoint divergence — frame ${cp.frame} (${timeSec.toFixed(2)}s in):`,
        fields,
        "\n  recorded:", cp,
        "\n  replayed:", { frame: cp.frame, ...state },
      );
    } else {
      const summary = fields.map((f) => `${f.field} Δ${f.delta}`).join(", ");
      // eslint-disable-next-line no-console
      console.warn(`[replay] divergence frame ${cp.frame} (${timeSec.toFixed(2)}s): ${summary}`);
    }
  }

  // The recorded beat-resnap adjustment for the frame just consumed (cursor - 1),
  //   or 0 if none. Applied to beatTime during replay to track the recording.
  beatResnapForCurrentFrame(): number {
    return this.beatResnapByFrame.get(this.cursor - 1) ?? 0;
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
    this.firstDivergenceLogged = false;
    this.divergences.length = 0;
    this.firstDivergencePair = null;
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
