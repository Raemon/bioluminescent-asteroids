import type { IInput } from "../Input";
import type { Ship } from "../Ship";
import type { Bindings } from "./controlBindings";
import { REPLAY_FORMAT_VERSION, encodeReplay, type ReplayDebugFrame, type ReplayFrame, type ReplayHeader } from "./replayFormat";

// Build hash from Vite at compile time so playback can warn about
// build-version mismatches. Falls back to "dev" when not injected.
const BUILD_HASH: string = (import.meta.env as unknown as { VITE_BUILD_HASH?: string })?.VITE_BUILD_HASH ?? "dev";

// Flip to true (or set window.__replayDebug = true before starting a run) to
//   record per-frame ship snapshots + log replay divergence. Off by default
//   because the snapshots bloat the uploaded payload past Vercel's body cap
//   on long runs (~5 min / 18k frames).
export const isReplayDebugEnabled = (): boolean =>
  (window as unknown as { __replayDebug?: boolean }).__replayDebug === true;

// Captures inputs + dt per frame. Vocab grows on first sight of each key; the
// per-frame masks reference vocab indices so the wire format stays compact.
export class ReplayRecorder {
  private frames: ReplayFrame[] = [];
  // Per-frame ship snapshots, only populated when isReplayDebugEnabled() at
  //   construction time. Packed into the serialized payload so __replayLast()
  //   can diff replay state against the recording.
  private debugFrames: ReplayDebugFrame[] | null = null;
  private vocab: string[] = [];
  private vocabIndex = new Map<string, number>();
  private lastKeys = new Set<string>();
  private header: Omit<ReplayHeader, "score" | "wave" | "maxCombo" | "killCount" | "keyVocab">;
  private startedAt = 0;

  constructor(meta: {
    seed: number;
    beatOffset: number;
    w: number;
    h: number;
    dpr: number;
    tutorial: boolean;
    veteran: boolean;
    bindings: Bindings;
  }) {
    this.startedAt = Date.now();
    if (isReplayDebugEnabled()) this.debugFrames = [];
    this.header = {
      v: REPLAY_FORMAT_VERSION,
      build: BUILD_HASH,
      seed: meta.seed,
      beatOffset: meta.beatOffset,
      w: meta.w,
      h: meta.h,
      dpr: meta.dpr,
      tutorial: meta.tutorial,
      veteran: meta.veteran,
      bindings: meta.bindings,
      startedAt: this.startedAt,
    };
  }

  captureFrame(dt: number, input: IInput): void {
    let downMask = 0;
    let upMask = 0;
    // Newly-pressed keys go into downMask; released keys (in lastKeys but not
    // current) go into upMask.
    for (const k of input.keys) {
      if (!this.lastKeys.has(k)) downMask |= 1 << this.bitFor(k);
    }
    for (const k of this.lastKeys) {
      if (!input.keys.has(k)) upMask |= 1 << this.bitFor(k);
    }
    this.frames.push([dt, downMask, upMask]);
    // Snapshot current key state for next-frame diff.
    this.lastKeys.clear();
    for (const k of input.keys) this.lastKeys.add(k);
  }

  private bitFor(key: string): number {
    let idx = this.vocabIndex.get(key);
    if (idx === undefined) {
      idx = this.vocab.length;
      // 32-bit mask cap; if a run uses more than 32 distinct keys we drop the
      // overflow rather than corrupt the bitmask. Real runs touch ~8 keys.
      if (idx >= 32) return 31;
      this.vocab.push(key);
      this.vocabIndex.set(key, idx);
    }
    return idx;
  }

  frameCount(): number {
    return this.frames.length;
  }

  captureShip(ship: Ship, input: IInput): void {
    if (!this.debugFrames) return;
    this.debugFrames.push({
      posX: ship.pos.x,
      posY: ship.pos.y,
      velX: ship.vel.x,
      velY: ship.vel.y,
      heading: ship.heading,
      keys: [...input.keys].sort(),
    });
  }

  // Build the final payload and gzip it. Caller provides the run summary
  // (score/wave/etc.) which only crystallises at game-over.
  async serialize(summary: { score: number; wave: number; maxCombo: number; killCount: number }): Promise<Uint8Array> {
    const header: ReplayHeader = {
      ...this.header,
      keyVocab: this.vocab.slice(),
      score: summary.score,
      wave: summary.wave,
      maxCombo: summary.maxCombo,
      killCount: summary.killCount,
    };
    return await encodeReplay({ header, frames: this.frames, debugFrames: this.debugFrames ?? undefined });
  }
}
