import type { Game } from "../Game";
import type { Pos, SoundName } from "../Sound";
import { BEAT_GRID, PULSE_LOOKAHEAD } from "./rhythmConstants";

// General beat-grid cue scheduler: queue a one-shot at an absolute beatTime
//   and it fires through the same lookahead machinery as the bgBeat pulse —
//   handed to the audio hardware with an absolute start time once the slot
//   enters the lookahead window, so it lands sample-accurately even when the
//   deciding frame runs long. Cues are audio-only: enqueuing and firing touch
//   no sim state, so the queue is replay/headless-safe and never checkpointed.

export type BeatCue = {
  at: number;          // absolute beatTime, seconds
  name: SoundName;
  pitch: number;
  pos?: Pos;
  tag: string;         // cancellation group, e.g. "waveSummary"
};

export const enqueueBeatCue = (game: Game, cue: BeatCue) => {
  game.beatCues.push(cue);
};

export const cancelBeatCues = (game: Game, tag: string) => {
  game.beatCues = game.beatCues.filter((c) => c.tag !== tag);
};

// After a forward hard-snap, anything older than this is skipped silently
//   instead of machine-gunning every missed slot; within it, a cue still
//   plays (clamped to "now") so a marginal frame stall drops nothing.
const STALE_BEAT_WINDOW = BEAT_GRID / 2;

export const tickBeatCues = (game: Game, playbackRate = 1) => {
  if (game.beatCues.length === 0) return;
  const horizon = game.beatTime + PULSE_LOOKAHEAD * playbackRate;
  const kept: BeatCue[] = [];
  for (const cue of game.beatCues) {
    if (cue.at > horizon) {
      kept.push(cue);
      continue;
    }
    if (cue.at < game.beatTime - STALE_BEAT_WINDOW) continue;
    const when = game.sound.audioTimeForBeatDelta(cue.at - game.beatTime, playbackRate);
    if (when !== null) {
      game.sound.playAt(cue.name, cue.pitch, when, cue.pos);
    } else if (cue.at <= game.beatTime) {
      // Audio clock not running (pre-unlock, headless): fire due cues
      //   immediately; leave horizon-only cues queued for a later frame.
      game.sound.play(cue.name, cue.pitch, cue.pos);
    } else {
      kept.push(cue);
    }
  }
  game.beatCues = kept;
};
