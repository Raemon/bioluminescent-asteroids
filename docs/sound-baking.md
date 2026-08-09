# Baked sounds

Every sound effect in Pulsar is described exactly once, as a Web Audio graph
built by a `build*Graph(ctx, dest, t, …)` method on `Sound`. That one
description gets used two ways:

- **baked** — rendered offline into an `OfflineAudioContext`, encoded to
  `public/sounds/baked/<name>__<key>.mp3`, and played back as a buffer;
- **live** — built straight into the live `AudioContext` at play time.

The live path is the fallback. A voice plays live only while its mp3 is still
in flight (or missing/failed), which is why adding a bake can never make a
sound disappear — the worst case is the game does exactly what it did before
the file existed.

Key facts:

- The bake key is `pitchRatio` in `playBaked(name, key)`, quantized to four
  decimals for the filename. It usually isn't a pitch at all — it's whatever
  discrete parameter distinguishes the variants (a tier, a chord index, a
  fundamental in Hz).
- Rendering happens in the browser (`Sound.bakeSound`), dev-only, and POSTs
  the WAV to the `/__bake-dump__` hook in `vite.config.ts`, which pipes it
  through ffmpeg. **Existing files win** — the hook refuses to overwrite, so
  ordinary dev play never churns good bakes.
- `npm run bake` does that headlessly: boots `vite dev`, opens the page in
  Chromium (`playwright-core`, `CHROME_PATH` to point at a browser), and waits
  for `warmBakedCache` to drain. Requires ffmpeg with libmp3lame on PATH.
  `npm run bake -- --list` reports cache state without writing anything.

---

## Inventory

### Now baked (this pass added 94 variants)

| Voice | Variants baked | Key | Notes |
| --- | --- | --- | --- |
| `fire` | 1 | — | reads the `fire` semantic config block |
| `calibrationTap` | 1 | — | same recipe as `fire` minus the attack ramp |
| `explosionLarge/Medium/Small` | 3 | — | one graph, three config blocks |
| `asteroidBoomBeat` | 1 | — | rendered flat; the ±3% per-hit wobble rides as a `playbackRate` |
| `death` | 1 | — | config-driven |
| `bassHit`, `bassEcho` | 2 | — | |
| `bell` | 2 | pitch ratio | `1` (asteroid toll) and `1.189` (wave-summary row) |
| `warble`, `comboTick`, `tink`, `shieldPop` | 4 | — | |
| `comboSparkle` | 2 | duration scale | `1` in game, `0.5` in the killed parade |
| `crystalShatterLarge/Small` | 4 | ring pitch ratio | `0` = the on-beat "snap to G" sentinel, `1` = natural |
| `scoreBlip` | 7 | pitch ratio | the distinct pitches of the drain's 16-step line |
| `summaryDownbeat` / `…Ducked` | 8 | chord index | the i–VI–III–VII rotation, ducked and not |
| `pulsarHum` | 1 | — | 20 s graph, rendered to 5 s (see *tails*) |
| `shockwaveCharge`, `shockwaveBoom` | 2 | — | 12 s windup and the drop |
| `alienFireBig/Medium` | 8 | riff variant 0–3 | 8-shot cycle × 2 samples collapses to 4 renders each |
| `alienFireSmall`, `alienHit`, `alienExplode` | 3 | — | |
| `meteorShower`, `gemSwarm` | 2 | — | |
| `canisterAppear`, `canisterDestroyed` | 2 | — | |
| `comboLost`, `comboLostFire` | 2 | — | |
| `bossPulse`, `bossHit`, `bossEyeOpenStinger` | 3 | — | |
| `driftShotHit` | 6 | drift tier 1–6 | |
| `laserCharge` | 4 | charge dot 1–4 | |
| `laserChargeFail` | 1 | — | |
| `comboChime` | 24 | fundamental (Hz) | see below |

### Already baked before this pass

`bgBeat`, `fireBeat`, `chime`, `drainChime`, `powerup`, `waveClear`,
`bassKick/Boom/Pluck/Snap`, `cometNote`, `cometDestroyed(Sad)`, `bonusLife`,
`laserShot`, `chargeBed`, `streakShimmer`, `thrust`/`reverseThrust`/
`sideThrust`, `bassteroidDrone`, `alienDrone`, `firstDotHum`, `warbleDrone`,
and the four ElevenLabs `wraith*` one-shots.

### Deliberately still live

| Voice | Why | What baking it would take |
| --- | --- | --- |
| `startCometShimmer` | An indefinite pad whose first ~4 s is a scripted entrance (whoosh sweep, tension cluster) and whose remainder is a steady drone with three independent slow tremolos. | Split it the way `warbleDrone` is split: bake the entrance as a one-shot, bake the steady state as a seamless loop with every LFO rate snapped by `snapToLoop`, and cross the two at the seam. |
| `startHaloAmbient` | Same shape, plus two live morphs (`setHaloAmbientTier`, `setHaloAmbientCometMode`) that reshape the voicing while it sustains. | Bake one seamless loop per endpoint state and crossfade, exactly as `warbleDrone` does for phased-in/phased-out. |
| `playChime` at non-1 pitch | Already plays the baked buffer through `playbackRate`. | — |
| `bell` / `scoreBlip` / `crystalShatter` at pitches outside the tables above | The music page's piano roll can trigger them at arbitrary pitch. | Nothing — the live fallback is the feature here. |
| `playComboChime` at `durationScale ≠ 1` | Only the killed-parade replay shortens the note; a stretched buffer would shorten the attack and detune it. | — |

### The comboChime refactor

`playComboChime` was the one voice that genuinely rendered "slightly different
ways in different situations": the note it plays depends on the combo value
*and* on which halo music is up, because each music variation gets its own
13-note modal tail (minor/dorian, major pentatonic, or no-3rd). Keyed the
obvious way — (variation, combo step) — that's 42 renders.

The three tails overlap heavily, so the code now keys the bake by **the
fundamental in Hz** instead. 42 combinations collapse to 24 distinct notes,
`comboChime__261.6300.mp3` is shared by all three scales, and re-ordering or
extending a tail reuses the notes it already has rather than invalidating
every file. `Sound.COMBO_CHIME_PITCHES` is derived from the three tail tables,
so the enumeration can't drift from the thing being enumerated.

The same trick shrinks `alienFireBig/Medium`: an 8-step riff over 2 sampled
guitars looks like 8 renders per size, but the note alternates every shot and
the sample flips at the halfway point, so there are only 4 distinct
(sample, note) pairs. `Sound.alienFireVariant(step)` does that mapping.

---

## Where a bake can drift from the live render

Worth reading before adding a voice to the registry — most of these are the
reason a baked sound comes out subtly wrong rather than obviously broken.

**1. The master chain differs between the two legs.** Live voices run
`voice → chSfxLive → liveSum → compressor → limiter → destination`; baked
buffers run `buffer → chSfxBaked → bakedSum → limiter → destination`, skipping
the compressor because the mp3 is supposed to already carry it. So every bake
renders through `buildBakedMasterChain` — the same compressor and limiter
settings as `buildMixGraph`. Miss this and the baked clip comes back hotter
and less glued than the live one. `MASTER_BASE_GAIN` and `BAKED_BASE_GAIN` are
both 1.0, so there is no level offset between the legs.

Two residual differences are inherent to the design and predate this work:
the baked leg is limited twice (once into the file, once on the shared bus),
and the channel-volume slider sits *before* the compressor on the live leg but
*after* it on the baked leg — so pulling the SFX slider down compresses a live
voice less, and a baked voice not at all. Both apply equally to every voice
that was already baked.

**2. The compressor is program-dependent.** A bake can only ever capture the
sound in isolation. Live, `bassKick` and `explosionLarge` landing together duck
each other; baked, each one carries the compression it had when rendered
alone. This is the fundamental limit of the approach, not a bug in any
particular recipe, and it is why the *master* limiter is still live.

**3. Tails get chopped.** `ONE_SHOT_BAKE_LEN` must cover the graph's latest
`stop()`, not its perceptual length. A chop is an audible click, and it also
throws away reverb/echo tails that the live path would have kept ringing
(`asteroidBoomBeat`'s 1.3 s convolution tail outlasts every oscillator in the
graph). Overshooting is nearly free — trailing silence is what VBR mp3
compresses best. Two entries deliberately undershoot the graph's stop time:
`pulsarHum` runs oscillators for 20 s but its bus is at −80 dB by 4.5 s, and
`shockwaveCharge` is capped at its own 12 s duration.

**4. Noise buffers are shared, and only within a session.** The live path
caches one white-noise buffer per duration (`makeNoiseBuffer`), so repeated
plays of `explosionLarge` already reuse the same noise — but a fresh draw
happens on every page load. Baking freezes one particular draw forever.
White noise is white noise, so this is a statistical identity rather than a
sample-for-sample one; it is only worth worrying about for a voice whose
character comes from a *specific* noise realization, and none do.
`Sound.noiseBuffer(ctx, dur)` routes to the live cache when it's handed the
live context and allocates fresh otherwise, so the live path's allocation
behaviour is unchanged.

**5. Context-owned buffers can't cross contexts.** `boomReverbIR` caches its
impulse response for the live context only; an offline render builds its own.
A cached live buffer used in an offline render is a silent-failure class of
bug. (`AudioBuffer`s that come from `decodeAudioData` — the guitar samples —
*are* portable, which is why the sampled alien voices can bake at all.)

**6. Randomness in the recipe freezes.** `asteroidBoomBeat` picked a fresh ±3%
pitch jitter per hit; baked, that would become one fixed pitch and a burst of
kills would read as a single sample retriggering. The jitter now rides as a
`playbackRate` on the buffer source (the same trick `laserShot` uses), so the
variation survives. Note that a `playbackRate` wobble shifts the noise layers
along with the oscillators, where the live jitter only detuned the two
oscillators — at ±3% that is not audible, but it is a real difference.

**7. Config is frozen into the render.** `cfgN(...)` semantic knobs — `fire`'s
body/tick shape, the explosion trio, `death`, `bell`, `tink` — are read inside
the graph builders, so their values land in the mp3. **After editing a
semantic knob in `public/sounds/config.json`, delete that voice's mp3 and
re-bake, or the change won't be audible.** The bake script loads the config
before rendering anything, so it never freezes the hardcoded fallbacks.

The `universal` knobs behave differently, and not well: `volume` is applied by
`play()` through the per-call master swap, which `playBaked` bypasses, and
`pitch` is ignored by every voice that doesn't thread `pitchRatio` into its
recipe. So for a baked voice both universal knobs are dead. Today that changes
nothing — every voice baked here has `volume: 1` — but `fireBeat`'s
`volume: 0.93` and `pitch: 1.24` are already being silently dropped, and any
future tuning through the universal knobs on a baked sound will be too. Worth
fixing separately; it is not a regression from this change.

**8. Timing.** Live voices scheduled through `playAt` (the wave-summary cues)
have to honour `scheduledWhenForCall`, which is what `voiceTime(name)` is for.
All the new wrappers pass `voiceTime(name)` rather than `currentTime`, so the
live fallback lands on the same sample as the baked buffer would.

**9. The same-sound pileup duck.** `playBaked` attenuates the k-th copy of one
key started within 30 ms to `1/√k`, because identical buffers sum coherently
in a way live re-synthesis doesn't quite. So a same-frame multi-kill is
slightly quieter baked than live. That is intentional (it's what stopped the
mix clipping), and it now applies to voices that previously piled up
unattenuated.

**10. Sample rate.** Renders happen at the baking machine's `AudioContext`
rate; playback decodes and resamples to the player's. Nothing to do, but it
means bakes are not bit-reproducible across machines.

---

## Adding a voice to the bake

1. Split the play method into a `build<Name>Graph(ctx, dest, t, …)` that
   touches no live state — no `this.ctx`, no `this.master`, no
   `ctx.currentTime`, all times relative to `t`.
2. Make the play method `if (this.playBaked(name, key)) return;` and then call
   the builder into `this.master` at `this.voiceTime(name)`.
3. Register the builder in `Sound.oneShotGraph` and add a length to
   `Sound.ONE_SHOT_BAKE_LEN`.
4. Enumerate the variants in `warmBakedCache`'s lazy list. Lazy, not gated:
   the start gate exists for voices with no fallback, and these have one.
5. `npm run bake`, then commit the mp3s.
