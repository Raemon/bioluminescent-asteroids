# Holistic sound polish — integration map

Four new modules in `src/sound/` you can plug in when ready. Each is independent
of the others — you can adopt them one at a time and a/b in-game.

## The big idea

Everything in the game is already locked to one `beatTime` clock at 120 BPM and
already sits in C major. The polish work is to make the harmony **move** with
the wave, the melody **evolve** with the comet, the percussion **groove** with
the field, and the stingers **belong** in the current harmony.

---

## 1. `Mode.ts` — modal progression (the centerpiece)

The single piece every other module hangs off of.

### Wire-up

In `Game.ts`, hold a `mode = new Mode()` instance, and at the start of each
wave call `this.mode.setWave(this.wave)`. Pass `this.mode` to any sound call
that needs harmony.

In `Sound.ts`, store a reference: `sound.mode = game.mode` (or pass through).

**That's it for the wiring.** The other three modules consume `Mode` directly.

### What changes in-game

You'll hear a clear, gradual harmonic darkening across the run:
- Waves 1-4: Lydian (bright, dreamy — open #4 on top of C)
- Waves 5-11: Ionian (standard major — heroic)
- Waves 12-17: Mixolydian (bluesy — flat 7 starts pulling things down)
- Waves 18-23: Dorian (melancholy but still hopeful)
- Waves 24-27: Aeolian (full natural minor)
- Waves 28+: Phrygian (the b2 — exotic, ominous, "the pulsar is here")

---

## 2. `CometMelody.ts` — generative phrases per comet

### Wire-up

Replace `Sound.COMET_MELODY` and `playCometNote(step)` logic.

In `Comet.ts`, add `melody: CometMelodyState` field. On comet spawn (in
`Game.spawnComet`), construct:

```ts
const slot = pickRegisterSlot(this.comets.length);
c.melody = new CometMelodyState(this.mode, slot, /* seed */ Date.now() ^ Math.floor(Math.random() * 0xffff));
```

In `Sound.playCometNote`, replace the static melody lookup with:
```ts
const freq = cometState.noteForStep(step);
if (freq === null) return;
// ... rest of the partial-stack synthesis stays identical
```

Game passes the comet's `melody` reference through (or Sound holds a Map
keyed by comet, parallel to `cometShimmers`).

### What changes in-game

- Single comet: each phrase has motif → answer → development → coda. Lasts
  twice as long before repeating, and the repeat is transposed up so the
  melody climbs across a comet's life rather than looping.
- Multiple comets: they auto-stratify into upper / middle / lower registers
  with different rhythmic densities. Two comets sound like a duet; three
  sound like a trio with a bass voice. The current setup just doubles the
  same phrase at the same pitch which causes ugly phasing.
- The mode change is *heard*: each comet's melody visits the mode's signature
  degree (Lydian #4, Phrygian b2, etc.) on a strong beat.

---

## 3. `Groove.ts` — bass-kit microtiming + accents + ghost notes

### Wire-up

In `Game.tickBassBeats`, before calling `this.sound.play(sound, pitchRatio)`,
shape the hit:

```ts
import { shapeHit } from "./sound/Groove";
// ...
const beatPos = Math.floor(a.nextBeatAt / BEAT_GRID); // beat slot in the global timeline
const fieldDensity = this.asteroids.filter(x => x.isBass()).length;
const shape = shapeHit(beatPos, fieldDensity);

// Schedule with the swing offset. Sound.play doesn't currently accept a
// delay or velocity — extend it (easy: add `when?: number, velocity?: number`
// optional args to .play and pass through to the underlying voices).
this.sound.play(sound, pitchRatio, /* whenSec */ shape.delaySec, /* velMul */ shape.velocityMul);

if (shape.addGhost) {
  this.sound.play(sound, pitchRatio * 0.5, shape.ghostDelaySec, shape.ghostVelocityMul);
}
```

Sound.ts needs a tiny extension: each voice's `triggerAttackRelease` already
accepts a time and velocity in Tone (e.g. `bassKick.triggerAttackRelease(note, "16n", time, velocity)`),
so plumbing this through is straightforward.

### What changes in-game

- Beats 1/3 hit harder; beats 2/4 sit back. Instantly transforms "metronome"
  into "groove".
- Offbeats sit very slightly late (53% swing) — felt as relaxed pocket, not
  heard as obvious triplets.
- Sparse fields (1-3 bassteroids) get ghost notes between the main hits, so
  there's always forward momentum. Dense fields suppress ghosts to keep the
  mix clear.
- Late-wave intensity opens the ghost-density cap so the groove *thickens*
  as the pulsar approaches.

---

## 4. `StingerBank.ts` — mode-aware chime/bell/tink/powerup/waveClear/warble

### Wire-up

In `Sound.playChime`:

```ts
const pitches = chimePitches(this.mode);
// existing partial-stack synthesis, but replace the hard-coded 1046.5 / partialRatios with pitches
```

Same for `playBell`, `playTink`, `playPowerup`, `playWaveClear`, `playWarble`.

For tone-engine paths, pass the computed pitches into the `triggerAttackRelease`
arrays instead of the hardcoded `["C6", "G6"]` etc.

### The killer move: `waveClear` previews the next mode

In `Game`, when a wave ends and you're about to call `playWaveClear`:

```ts
const previewMode = new Mode();
previewMode.setWave(this.wave + 1);  // mode of the wave we're about to enter
const chord = waveClearChord(previewMode);
this.sound.playWaveClearChord(chord);
```

So at wave 11 → 12, the wave-clear chord is in Mixolydian. At wave 23 → 24,
it's in Aeolian. The player hears the harmonic gear-shift one beat before
the new wave starts. Subtle, very beautiful.

---

## Suggested adoption order

1. **Mode + StingerBank first.** Lowest-risk, most-noticeable win. The bed
   is still doing its thing; only the stingers and the per-wave color move.
2. **CometMelody next.** Comets are the most melodic element; this turns
   them from a backing pad into a lead voice.
3. **Groove last.** Requires extending `Sound.play` with timing/velocity
   params, so a slightly larger plumbing change. Save it for when the
   other three are landed and you want to feel the rhythm section breathe.

## Audit before plugging in

The current `Sound.ts` has a baked-buffer cache (`bakedBuffers`) that pre-
renders fixed-pitch sounds. Mode-aware stingers can't be baked the same way
because their pitches change per wave. Two options:

- (a) Skip baking for stingers (their cost is small — they fire once per kill).
- (b) Bake them per-mode (6 modes × the existing pitch buckets). Probably overkill.

Recommend (a) for simplicity.
