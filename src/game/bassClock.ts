import type { Game } from "../Game";
import { BASS_MEASURE_LENGTH } from "../Asteroid";
import { BEAT_GRID } from "./rhythmConstants";

// Why: kick (C2), pluck (G2), boom (F2), snap (C3) — I-IV-V-percussion worst case stays musical.
export const BASS_KIND_SOUND: Record<"bassA" | "bassB" | "bassC" | "bassD", "bassKick" | "bassPluck" | "bassBoom" | "bassSnap"> = {
  bassA: "bassKick",
  bassB: "bassPluck",
  bassC: "bassBoom",
  bassD: "bassSnap",
};

// Why: gen-2 small drops a minor third so terminal pieces sit deeper but stay diatonic.
// Why: smalls land on A1/E2/D2/A2 → I/vi/V/ii flavour, pairs naturally with the C-F-G groundwork.
export const BASS_SPLIT_PITCH_RATIO = [1, 1, 0.8409] as const;

// Why: shares beatTime with bassteroids so the pulsar approach beat stays locked under slow-mo.
const tickBgBeats = (game: Game) => {
  const bgIdx = Math.floor(game.beatTime / BEAT_GRID);
  if (bgIdx < game.lastBgBeatIndex) game.lastBgBeatIndex = bgIdx - 1;
  while (game.lastBgBeatIndex < bgIdx) {
    game.lastBgBeatIndex += 1;
    const isOffbeat = (game.lastBgBeatIndex & 1) === 1;
    // Why: 1.122 = whole-step lift (E1→F#1) — distinct from the downbeat, mood intact.
    const pitchRatio = isOffbeat ? 1.122 : 1;
    game.sound.play("bgBeat", pitchRatio);
  }
};

// Why: kind binds the voice; measureOffset varies so split children carry timbre to new beat slots.
const tickBassAsteroids = (game: Game) => {
  for (const a of game.asteroids) {
    if (!a.isBass()) continue;
    while (game.beatTime >= a.nextBeatAt) {
      const sound = BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"];
      const pitchRatio = BASS_SPLIT_PITCH_RATIO[a.splitLevel] ?? 1;
      game.sound.play(sound, pitchRatio, a.pos);
      a.beatFlash = 1.0;
      // Why: re-snap to BEAT_GRID so accumulated float error can't drift the voice off the beat.
      a.nextBeatAt = Math.round((a.nextBeatAt + BASS_MEASURE_LENGTH) / BEAT_GRID) * BEAT_GRID;
    }
  }
};

// Why: shared beat clock makes comet notes land on the same audio frame as coincident bass hits.
const tickCometMelodies = (game: Game) => {
  for (const c of game.comets) {
    while (game.beatTime >= c.nextNoteBeatTime) {
      game.sound.play("cometNote", c.noteIndex, c.pos);
      c.noteIndex += 1;
      c.nextNoteBeatTime = Math.round((c.nextNoteBeatTime + BEAT_GRID) / BEAT_GRID) * BEAT_GRID;
    }
  }
};

// Why: one entry advances beatTime + every audio voice so they all slow together under slow-mo.
export const tickBassBeats = (game: Game, musicDt: number) => {
  game.beatTime += musicDt;
  tickBgBeats(game);
  tickBassAsteroids(game);
  tickCometMelodies(game);
};

// Why: gameover advances beatTime itself and detonates bass rocks on its own schedule, but the
//   bgBeat sub-bass + comet notes still need to fire — this keeps the music ticking under the
//   post-mortem parade without re-triggering the bass voices that detonation already plays.
export const tickAuxBeats = (game: Game) => {
  tickBgBeats(game);
  tickCometMelodies(game);
};
