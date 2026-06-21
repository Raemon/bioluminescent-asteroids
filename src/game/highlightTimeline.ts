import type { Game } from "../Game";

// One rhythm chain: from the on-beat fire that primed it (beatCombo 0→1) to the
//   frame the rhythm was lost (dropped back to 0, or the 32→4 sparkle-drop, which
//   reads as "lost the streak" for highlight purposes). Frames are recorder frame
//   indices so the highlight clip can re-sim the exact window deterministically.
//   peakHeldFrames counts how many frames the chain sat at its peak value — the
//   tie-break for picking the showcased chain favours the *shortest* hold (the
//   most clutch peak) when several chains reach the same peak.
export type RhythmChain = {
  startFrame: number;
  peak: number;
  peakHeldFrames: number;
  lostFrame: number | null;
};

// Watches game.beatCombo across frames and segments the run into chains. Driven
//   from one place (end of updatePlaying) rather than every combo-mutation site,
//   so it can't miss a grow/loss path. Frame index is the recorder's just-captured
//   frame (frameCount()-1); no-ops when there's no recorder (i.e. during replay
//   playback, including the highlight clip itself, so it never re-records).
export class HighlightTimeline {
  readonly chains: RhythmChain[] = [];
  private prevCombo = 0;
  private current: RhythmChain | null = null;

  // Call once per simulated frame, after the frame's combo logic has run.
  observe(combo: number, frameIndex: number): void {
    const prev = this.prevCombo;
    this.prevCombo = combo;

    // Count EVERY frame the live chain sits at its peak (the combo rarely changes
    //   between hits, so this has to run on unchanged frames too — otherwise the
    //   "time held at peak" tie-break would always read 1). Done before the
    //   no-change early-out below.
    if (this.current && combo === this.current.peak && combo > 0) this.current.peakHeldFrames += 1;

    if (combo === prev) return;

    // 0 → nonzero: a fresh chain primes.
    if (prev === 0 && combo > 0) {
      this.current = { startFrame: frameIndex, peak: combo, peakHeldFrames: 1, lostFrame: null };
      this.chains.push(this.current);
      return;
    }
    if (!this.current) return;

    // Drop to 0 (hard loss) OR the 32→4 sparkle-drop: the streak is broken.
    //   Close the chain here. A subsequent re-prime opens a new one.
    if (combo === 0 || combo < this.current.peak) {
      this.current.lostFrame = frameIndex;
      this.current = null;
      // The sparkle-drop lands on 4 (not 0), so the chain technically continues
      //   at a lower tier — but "lost rhythm" per the spec is this break point, so
      //   we end the highlight here and let the next prime/grow open a new chain.
      if (combo > 0) {
        this.current = { startFrame: frameIndex, peak: combo, peakHeldFrames: 1, lostFrame: null };
        this.chains.push(this.current);
      }
      return;
    }

    // Growth to a new peak: this frame is the first one at the new peak, so seed
    //   the held-at-peak counter to 1 (the top-of-function counter skipped it
    //   because combo didn't yet equal the new peak).
    if (combo > this.current.peak) {
      this.current.peak = combo;
      this.current.peakHeldFrames = 1;
    }
  }
}

// Hook point: record this frame's combo against the timeline. Cheap; skips when
//   no recorder (replay/highlight playback) so highlight clips don't re-segment.
export const recordHighlightFrame = (game: Game): void => {
  if (!game.recorder) return;
  game.highlightTimeline.observe(game.beatCombo, game.recorder.frameCount() - 1);
};

// Pick the chain to showcase: highest peak; ties → shortest time held at peak
//   (most clutch); further ties → earliest. Returns null when no chain ever
//   reached a real streak (peak < 2) — caller falls back to the parade.
export const pickHighlightChain = (chains: readonly RhythmChain[]): RhythmChain | null => {
  let best: RhythmChain | null = null;
  for (const c of chains) {
    if (c.peak < 2) continue;
    if (
      best === null ||
      c.peak > best.peak ||
      (c.peak === best.peak && c.peakHeldFrames < best.peakHeldFrames) ||
      (c.peak === best.peak && c.peakHeldFrames === best.peakHeldFrames && c.startFrame < best.startFrame)
    ) {
      best = c;
    }
  }
  return best;
};
