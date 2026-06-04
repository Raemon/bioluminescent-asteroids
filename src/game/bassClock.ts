import type { Game } from "../Game";
import { BASS_MEASURE_LENGTH } from "../Asteroid";
import { BEAT_GRID } from "./rhythmConstants";

// kick (C2), pluck (G2), boom (F2), snap (C3) — I-IV-V-percussion worst case stays musical.
export const BASS_KIND_SOUND: Record<"bassA" | "bassB" | "bassC" | "bassD", "bassKick" | "bassPluck" | "bassBoom" | "bassSnap"> = {
  bassA: "bassKick",
  bassB: "bassPluck",
  bassC: "bassBoom",
  bassD: "bassSnap",
};

// gen-2 small drops a minor third so terminal pieces sit deeper but stay diatonic.
// smalls land on A1/E2/D2/A2 → I/vi/V/ii flavour, pairs naturally with the C-F-G groundwork.
export const BASS_SPLIT_PITCH_RATIO = [1, 1, 0.8409] as const;

// walks an eighth-note grid; sparkle tier adds lighter "and" hits between quarters
// so sound + rhythm gate both double at high combo. Shares beatTime so slow-mo
// drags the pulse along with the bass voices.
const tickBgBeats = (game: Game) => {
  const EIGHTH_GRID = BEAT_GRID / 2;
  const eighthIdx = Math.floor(game.beatTime / EIGHTH_GRID);
  // lastBgBeatIndex tracks eighth-note slots now. Reset is handled by the same
  // backward-jump guard the old loop used.
  if (eighthIdx < game.lastBgBeatIndex) game.lastBgBeatIndex = eighthIdx - 1;
  while (game.lastBgBeatIndex < eighthIdx) {
    game.lastBgBeatIndex += 1;
    const isQuarter = (game.lastBgBeatIndex & 1) === 0;
    if (isQuarter) {
      const quarterIdx = game.lastBgBeatIndex >> 1;
      const isOffbeat = (quarterIdx & 1) === 1;
      // 1.122 = whole-step lift (E1→F#1) — distinct from the downbeat, mood intact.
      const pitchRatio = isOffbeat ? 1.122 : 1;
      game.sound.play("bgBeat", pitchRatio);
    } else if (game.beatCombo >= 16) {
      // Doubletime "and": land on the eighth between quarter beats. The next
      // quarter slot's parity determines pitch — alternating C#/D# so the
      // syncopation oscillates rather than stutters on a single pitch.
      const nextQuarterIdx = (game.lastBgBeatIndex + 1) >> 1;
      const nextIsOffbeat = (nextQuarterIdx & 1) === 1;
      game.sound.playBgBeatLight(nextIsOffbeat ? 1.122 : 1);
    }
  }
};

// kind binds the voice; measureOffset varies so split children carry timbre to new beat slots.
const tickBassAsteroids = (game: Game) => {
  for (const a of game.asteroids) {
    if (!a.isBass()) continue;
    while (game.beatTime >= a.nextBeatAt) {
      const sound = BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"];
      const pitchRatio = BASS_SPLIT_PITCH_RATIO[a.splitLevel] ?? 1;
      game.sound.play(sound, pitchRatio, a.pos);
      a.beatFlash = 1.0;
      // re-snap to BEAT_GRID so accumulated float error can't drift the voice off the beat.
      a.nextBeatAt = Math.round((a.nextBeatAt + BASS_MEASURE_LENGTH) / BEAT_GRID) * BEAT_GRID;
    }
  }
};

// comet pulse matches the halo ambient melody step so the two lines hocket cleanly
const COMET_STEP = BEAT_GRID * 2;
const tickCometMelodies = (game: Game) => {
  for (const c of game.comets) {
    while (game.beatTime >= c.nextNoteBeatTime) {
      game.sound.play("cometNote", c.noteIndex, c.pos);
      c.noteIndex += 1;
      c.nextNoteBeatTime = Math.round((c.nextNoteBeatTime + COMET_STEP) / BEAT_GRID) * BEAT_GRID;
    }
  }
};

// one entry advances beatTime + every audio voice so they all slow together under slow-mo.
export const tickBassBeats = (game: Game, musicDt: number) => {
  game.beatTime += musicDt;
  tickBgBeats(game);
  tickBassAsteroids(game);
  tickCometMelodies(game);
};

// keeps bgBeat + comet melody ticking under the gameover parade
// without re-firing bass voices that the detonation schedule already plays
export const tickAuxBeats = (game: Game) => {
  tickBgBeats(game);
  tickCometMelodies(game);
};
