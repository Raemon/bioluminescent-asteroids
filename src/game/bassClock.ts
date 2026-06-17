import type { Game } from "../Game";
import { BASS_MEASURE_LENGTH } from "../Asteroid";
import { BEAT_GRID } from "./rhythmConstants";
import { ENTITY_CONFIG } from "./entityConfig";
import { TAU } from "../vec";

const WARBLE = ENTITY_CONFIG.warble;

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

// How far ahead of the audio clock we schedule pulse hits. A frame stall up to
// this long is absorbed silently: the beat was already handed to the audio
// hardware with an absolute start time, so it sounds on the sample regardless
// of when the next rAF frame lands. Too short and stalls leak through as lag;
// too long and the pulse feels detached from on-screen gameplay.
const PULSE_LOOKAHEAD = 0.12;

// walks an eighth-note grid; sparkle tier adds lighter "and" hits between quarters
// so sound + rhythm gate both double at high combo. Shares beatTime so slow-mo
// drags the pulse along with the bass voices.
//
// Lookahead-scheduled: rather than firing on the frame beatTime crosses a slot
// boundary (which pins the hit to a frame edge and slips whenever a frame runs
// long), we compute the absolute audio-clock time of each upcoming slot and
// hand it to the audio hardware ahead of time. playbackRate scales beatTime →
// audio-time so the pulse still slows correctly under slow-mo.
const tickBgBeats = (game: Game, playbackRate = 1) => {
  const EIGHTH_GRID = BEAT_GRID / 2;
  // Schedule every slot whose start lands at or before (now + lookahead). The
  // window is expressed in beatTime so it shrinks under slow-mo in lockstep
  // with the slot grid. Backward jumps (post hard-snap) reset the index.
  const horizonBeatTime = game.beatTime + PULSE_LOOKAHEAD * playbackRate;
  const horizonIdx = Math.floor(horizonBeatTime / EIGHTH_GRID);
  if (horizonIdx < game.lastBgBeatIndex) game.lastBgBeatIndex = horizonIdx - 1;
  while (game.lastBgBeatIndex < horizonIdx) {
    game.lastBgBeatIndex += 1;
    const slotIdx = game.lastBgBeatIndex;
    const slotBeatTime = slotIdx * EIGHTH_GRID;
    const beatDelta = slotBeatTime - game.beatTime;
    // Absolute audio-clock start; null before the context is running, in which
    // case we fall back to playing immediately (warmup, pre-unlock).
    const when = game.sound.audioTimeForBeatDelta(beatDelta, playbackRate);
    const isQuarter = (slotIdx & 1) === 0;
    if (isQuarter) {
      const quarterIdx = slotIdx >> 1;
      const isOffbeat = (quarterIdx & 1) === 1;
      // 1.122 = whole-step lift (E1→F#1) — distinct from the downbeat, mood intact.
      const pitchRatio = isOffbeat ? 1.122 : 1;
      if (when !== null) game.sound.playBgBeatAt(pitchRatio, when);
      else game.sound.play("bgBeat", pitchRatio);
    } else if (game.beatCombo >= 32) {
      // Doubletime "and": land on the eighth between quarter beats. The next
      // quarter slot's parity determines pitch — alternating C#/D# so the
      // syncopation oscillates rather than stutters on a single pitch.
      const nextQuarterIdx = (slotIdx + 1) >> 1;
      const nextIsOffbeat = (nextQuarterIdx & 1) === 1;
      if (when !== null) game.sound.playBgBeatLightAt(nextIsOffbeat ? 1.122 : 1, when);
      else game.sound.playBgBeatLight(nextIsOffbeat ? 1.122 : 1);
    }
  }
};

// kind binds the voice; measureOffset varies so split children carry timbre to new beat slots.
const tickBassAsteroids = (game: Game) => {
  for (const a of game.asteroids) {
    // Beat-active boss shards ride the same clock as Bassteroids — they flash
    // on their measure slot but stay silent (the boss music carries the audio,
    // and a stack of fragment voices would muddy it). The spread of their
    // offsets across the measure is what makes the broken-up planet read as an
    // escalating, denser pulse.
    const beatFragment = a.isBeatFragment();
    if (!a.isBass() && !beatFragment) continue;
    while (game.beatTime >= a.nextBeatAt) {
      if (!beatFragment) {
        const sound = BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"];
        const pitchRatio = BASS_SPLIT_PITCH_RATIO[a.splitLevel] ?? 1;
        game.sound.play(sound, pitchRatio, a.pos);
      }
      a.beatFlash = 1.0;
      // re-snap to BEAT_GRID so accumulated float error can't drift the voice off the beat.
      a.nextBeatAt = Math.round((a.nextBeatAt + BASS_MEASURE_LENGTH) / BEAT_GRID) * BEAT_GRID;
    }
    // Split children beat on a fraction of the measure (splitDelta); recover
    // this rock's actual interval from its split level so the phase ramp is
    // correct for every tier, not just whole-measure rocks.
    const interval = BASS_MEASURE_LENGTH / Math.pow(2, a.splitLevel);
    const remaining = a.nextBeatAt - game.beatTime;
    a.beatPhase = Math.max(0, Math.min(1, 1 - remaining / interval));
  }
};

// Warble phasing — every measure (4 beats) each warble fades from solid down
// to CFG.warble.lowOpacity and back on a cosine, and goes intangible while its
// opacity sits at/below CFG.warble.solidThreshold. Driven off game.beatTime so
// the ghost-window stays locked to the music even under slow-mo. A per-rock
// warblePhaseOffset spreads a field out of unison.
const tickWarbles = (game: Game) => {
  for (const a of game.asteroids) {
    if (a.kind !== "warble") continue;
    // 0→1 progress through the rock's own measure; 0/1 = solid peak, 0.5 = trough.
    const phase = ((game.beatTime + a.warblePhaseOffset) % BASS_MEASURE_LENGTH) / BASS_MEASURE_LENGTH;
    // cosine: 1 at the ends, 0 at the middle of the measure.
    const present = 0.5 + 0.5 * Math.cos(phase * TAU);
    a.warbleOpacity = WARBLE.lowOpacity + (1 - WARBLE.lowOpacity) * present;
    a.warbleSolid = a.warbleOpacity > WARBLE.solidThreshold;
  }
};

// comet pulse matches the halo ambient melody step so the two lines hocket cleanly
const COMET_STEP = BEAT_GRID * 2;
const tickCometMelodies = (game: Game) => {
  for (const c of game.comets) {
    if (c.isMeteor) continue;
    while (game.beatTime >= c.nextNoteBeatTime) {
      game.sound.play("cometNote", c.noteIndex, c.pos);
      c.noteIndex += 1;
      c.nextNoteBeatTime = Math.round((c.nextNoteBeatTime + COMET_STEP) / BEAT_GRID) * BEAT_GRID;
    }
  }
};

// one entry advances beatTime + every audio voice so they all slow together under slow-mo.
// playbackRate (musicDt/wallDt) lets the pulse scheduler convert beatTime → audio-clock time.
export const tickBassBeats = (game: Game, musicDt: number, playbackRate = 1) => {
  game.beatTime += musicDt;
  tickBgBeats(game, playbackRate);
  tickBassAsteroids(game);
  tickWarbles(game);
  tickCometMelodies(game);
};

// keeps bgBeat + comet melody ticking under the gameover parade
// without re-firing bass voices that the detonation schedule already plays
export const tickAuxBeats = (game: Game) => {
  tickBgBeats(game);
  tickCometMelodies(game);
};
