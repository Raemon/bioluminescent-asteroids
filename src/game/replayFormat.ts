// Replay wire format. JSON shape is stable across (v: 2) revisions; bump the
// version when the binary layout or sim semantics change.

export const REPLAY_FORMAT_VERSION = 5;

// v2 added tutorial/veteran/bindings so wave-1 spawn (which forks on those
//   flags) and per-action key mapping reproduce on a different machine.
// v4 restores the recorded beatOffset on playback and moves wave-transition
//   spawn + death-respawn onto the sim clock; pre-v4 re-sims desync, so decode
//   rejects them rather than replaying a run that drifts off the recording.
// v5 records the beat-resnap watchdog's per-frame beatTime adjustments. Live
//   play nudges beatTime toward the audio clock once a measure (bleed) or hard-
//   snaps after a stall; replay has no audio clock and disables the watchdog, so
//   without these the recorded beatTime trajectory is unreproducible and the run
//   drifts off-beat ~30s in. See ReplayBeatResnap + applyRecordedBeatResnap.
// Beat-clock snapshot taken on the recording's first captured frame. These are
//   all deterministic dt-sums / dt-derived indices accumulated during the held
//   intro; restoring them on replay reproduces the recording's frame-0 beat
//   state. beatTime drives perceivedBeatTime (the whole on-beat gate); the
//   indices keep the bass pulse scheduler + combo evaluator from replaying a
//   backlog or stalling on frame 0.
export type ReplayStartBeat = {
  beatTime: number;
  lastBgBeatIndex: number;
  nextBeatToEvaluate: number;
  lastBeatResnapAt: number;
};

export type ReplayHeader = {
  v: number;
  build: string;
  seed: number;
  beatOffset: number;
  w: number;
  h: number;
  dpr: number;
  keyVocab: string[];
  startedAt: number;
  // pre-sim flags that fork beginFirstWaveByTutorialFlag — without these the
  //   watcher's localStorage decides wave 1, which can disagree with the run.
  tutorial: boolean;
  veteran: boolean;
  // recorded action→keys map so the replay-time isDown lookup matches the
  //   recording even if the watcher has rebound their controls.
  bindings: Record<string, string[]>;
  // Beat-clock state at the first captured frame. The run holds the world under
  //   the calibration/pilot's-log intro (beatTime ticks, no frames captured), so
  //   by the time recording's frame 0 lands beatTime is already T_intro — but a
  //   replay's startGame resets it to 0 with no intro. Restoring this snapshot
  //   before the first recorded frame aligns the beat gate + bass clock with the
  //   recording from frame 0. See ReplayStartBeat.
  startBeat: ReplayStartBeat;
  score: number;
  wave: number;
  maxCombo: number;
  killCount: number;
};

// One frame = [dtSeconds, downMask, upMask]. Masks are bit-indexed against
//   header.keyVocab. dt stored as a raw float (seconds) so there's zero
//   quantization drift between recording and replay — any rounding would
//   compound in scale-with-dt physics like turn rate and thrust ramp.
export type ReplayFrame = [number, number, number];

// One beat-resnap correction the live run applied: [frameIndex, beatTimeDelta].
//   beatTimeDelta is the net change the watchdog made to beatTime on that frame
//   (a small bleed delta, or a large jump on a hard-snap). Sparse — only frames
//   with a nonzero correction are stored; a clean run records none. Replay adds
//   each delta back on its frame to reproduce the recording's beatTime exactly.
export type ReplayBeatResnap = [number, number];

// Per-frame ship snapshot for replay divergence debugging. Captured during the
//   live recording right after ship.update and packed alongside the input frames.
//   Replay re-captures the same snapshot post-ship.update and logs the first
//   frame whose state differs from the recording. Strip before shipping.
export type ReplayDebugFrame = {
  posX: number;
  posY: number;
  velX: number;
  velY: number;
  heading: number;
  keys: string[];
};

export type ReplayPayload = {
  header: ReplayHeader;
  frames: ReplayFrame[];
  // Sparse beat-resnap corrections, frame-indexed and ascending. Absent/empty
  //   when the run never drifted enough to trigger the watchdog.
  beatResnaps?: ReplayBeatResnap[];
  debugFrames?: ReplayDebugFrame[];
};

// ---------- (de)serialisation ----------

export const encodeReplay = async (payload: ReplayPayload): Promise<Uint8Array> => {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return await gzip(bytes);
};

export const decodeReplay = async (gz: Uint8Array): Promise<ReplayPayload> => {
  const bytes = await gunzip(gz);
  const json = new TextDecoder().decode(bytes);
  const payload = JSON.parse(json) as ReplayPayload;
  // Reject older formats outright: pre-v5 runs re-sim with a different beatOffset
  //   / wave-transition / respawn timing or lack recorded resnap corrections, so
  //   they'd drift off the recording. Better a clear failure than a wrong replay.
  if (payload.header.v !== REPLAY_FORMAT_VERSION) {
    throw new Error(`Unsupported replay version ${payload.header.v} (expected ${REPLAY_FORMAT_VERSION})`);
  }
  return payload;
};

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
};
