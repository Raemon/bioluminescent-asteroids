---
name: pulsar-music
description: Generate or edit looping background music for the Pulsar game's combo halo system (or any new music slot). Covers the ElevenLabs Music API + FluidSynth + numpy pipeline, the in-game-mix audit tool that substitutes for ears, the harmonic constraints that keep music from fighting the bass field, and the integration patterns in Sound.ts. Use when the user asks to create new halo music, replace an existing variation, add a fresh music slot, or critique a recently generated stem.
---

# Generating music for Pulsar

You have ears via tools, not directly. **Every aesthetic claim you make must be backed by an analysis script run — never assert "this sounds dreamy" without data.** The single biggest failure mode is generating something, writing prose about how it'll feel, and never verifying.

## Do not playtest the game to verify music

The game is slow to start up, requires browser interaction (clicking to grant audio context, then earning 4x/6x/12x combo), and routes through dozens of unrelated systems. **Do not launch a dev server, open a browser, or use Playwright on the game to verify a stem.** That includes:

- Don't start `npm run dev` / `vite` to "hear" the music
- Don't use `mcp__playwright__browser_*` to load the game
- Don't ask the user to run the game and report back unless you've already exhausted the analysis path

Instead, when you need to verify behavior beyond what the existing scripts cover, **write a disposable test script** that exercises just the audio path. Examples:

- To verify a stem loops cleanly: write a numpy/sox script that concatenates the stem with itself N times and saves a wav for the user to listen to once — no game.
- To verify two layers stack without clipping or beating: load both with librosa, sum them, write a wav, run the same analyze.py/deepinspect.py against the sum.
- To verify the 6x→12x transition feels smooth: write a python script that crossfades the stems on the same schedule Sound.ts uses (0.5s fade-in to peak) and writes the audio result. Compare to the analysis numbers.

The user trusts the analysis numbers + their own listen. They don't need (and don't want) you booting the game to confirm anything. If you genuinely can't determine something from analysis, **say so in the report** and let the user listen — don't try to listen on their behalf by driving the game.

## Read these first

Always read before generating:

1. **`scripts/music-gen/README.md`** — the pipeline overview. Has setup, iterate commands, invariants.
2. **`src/Sound.ts`** lines 90–135 (HaloMusicVariation type), 1920–2010 (startHaloMusic / setHaloMusicMelodicLayer / stopHaloMusic).
3. **`src/game/haloMusicConfig.ts`** — current pool + how the random pick works.
4. **`src/game/gameUpdate.ts`** — `syncHaloAmbient` shows how 4x/6x map to layers and how beat-clock alignment is computed.
5. **`src/Asteroid.ts`** for `BASS_MEASURE_LENGTH = 2.0` and `src/game/rhythmConstants.ts` for `BEAT_GRID = 0.5`. Tempo is **120 BPM** (4 beats × 0.5s).

The legacy synthesized halo pad in `Sound.ts` (`startHaloAmbient`) is the harmonic reference — read its comments to understand *why* C+G open fifth was chosen. Don't fight that strategy without a reason.

## Constraints that hold for every music slot

**Tempo.** 120 BPM. Stems must lock to this exactly (use `analyze.py lock-to-120` for ElevenLabs outputs that drift).

**Loop length.** 32 seconds = 4 measures × 4 bars at 120 BPM is the current standard. 8 seconds is too short — repetition fatigue hits within the second cycle. If the user wants something longer, multiples of `BASS_MEASURE_LENGTH = 2.0s` so the loop can align to the bass clock.

**Key/harmony.** C pedal. The bass field plays a C-major drone bed (bassA-D voices around C/E/G). Anything else risks the bass's E-natural fighting your minor-third. If you must deviate, run the in-game-mix audit and report the spectral collision.

**Voicing strategy.** C+G open fifth in the bass throughout. Upper voices may drift (E↔Eb, B↔Bb for major/minor/Cmaj7 colour) — that's the only harmonic movement you get for free.

**Internal structure.** 32-second loops need internal variation: A-A'-B-A' (4 phrases × 8s) or A-B-A-C (any 4-phrase shape). Otherwise it sounds like a static drone.

**Loudness.** Peak normalize to **-12 dBFS** (not -6 — round-1 was too hot). The in-game-mix audit determines the per-variation playback gain (see below). Don't ship without running it.

**Loop seam.** 50 ms fade-in and fade-out. Verify with `deepinspect.py first_vs_last_correlation`.

**Phase alignment.** Both layers (ambient + melodic) must share the downbeat at sample 0. The game starts both at the same `ctx.currentTime` so they remain phase-locked for the lifetime of the music — if your stems' downbeats don't match, the melodic layer will be sample-misaligned when 6x triggers.

## The pipeline

```
scripts/music-gen/
├── eleven_music.py    EL Music API wrapper
├── build_v3.py        Tiny MIDI writer + FluidSynth render helper (library)
├── build_r2.py        Procedural numpy pad + FluidSynth piano (round-2 self-built)
├── analyze.py         Inspect / lock-to-BPM / mix
├── deepinspect.py     Per-band RMS, chroma evolution, stereo width, seam check
├── ingame_mix.py      Synth a representative bass+bg-beat segment, audit music against it
└── process_r2.py      Final pipeline: trim, fade, normalize, reverb, wav+mp3
```

### Workflow for a new variation

1. **Design the variation in writing first.** Decide source (ElevenLabs / FluidSynth / numpy / hybrid), aesthetic, gain target. Write down the chord-by-phrase plan (e.g., `A: Cmaj+E, A': Cmin+Eb, B: Cmaj7+B, A': Cmin+Eb`).
2. **Generate raw stems** to `raw/{name}-{ambient,melodic}.{mp3,wav}`. For EL: use affirmative phrasing ("sustained pads only" beats "no drums"). For self-built: edit `build_r2.py` chord lists.
3. **Inspect every raw stem**: `venv/bin/python analyze.py inspect raw/<name>.mp3` then `deepinspect.py` for structure. Check BPM, key, fades, onset count, centroid arc.
4. **Run the in-game-mix audit**: render the bed once with `ingame_mix.py render-bed mixaudit/bed.wav`, then for each stem `ingame_mix.py analyze-mix mixaudit/bed.wav raw/<name>.mp3 mixaudit/<name>-test.wav --gain 0.30`. Pass criteria: bass band 60–200 Hz wins by ≥6 dB; lo-mid 200–500 Hz wins by ≥4 dB. If music is fighting, lower the gain or revoice.
5. **Post-process** through `process_r2.py` (edit the function to point at your new raw files). Lands wav + mp3 in `processed/`.
6. **Audit the final mp3 + layer-mix preview** the same way. Lock in the per-variation playback gain.
7. **Wire into the game** (see next section).

### ElevenLabs prompts that work

EL is unreliable on negations and artist names — both trigger the content filter or get silently dropped.

- **Do** use affirmative texture words: "sustained pads only", "long held tones", "felt-hammer piano", "legato strings".
- **Do** specify BPM, key, and structure: "120 BPM, C pedal, A-A'-B-A' structure across 32 seconds".
- **Don't** say "no drums" — say "sustained pads only" or "no rhythmic instruments". When negation is needed, phrase as a constraint on what's present, not what's absent.
- **Don't** name artists ("Hans Zimmer", etc.) — content filter.
- **Don't** use loaded emotional words ("intimate", "vulnerable") — these can trip the filter inconsistently. "Warm", "spacious", "calm" are safer.
- **Length:** EL ignores the requested duration sometimes. Always pass `--length-ms` and verify the output is actually that length. If it returns 70s when you asked for 32s, trim from a non-silent offset (see `process_r2.py`'s EL-melodic block).
- **Key mismatch:** if EL gives you the wrong key (e.g. G minor when you asked C minor), **regenerate** rather than pitch-shift in post. Pitch-shifting moves the entire spectral envelope and the timbre suffers. Each retry is a few hundred characters of credit — cheap.

Check credit balance before bulk generations:
```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
  https://api.elevenlabs.io/v1/user/subscription | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(f'{d[\"character_count\"]}/{d[\"character_limit\"]}')"
```

### Self-built / procedural prompts to yourself

- **Bass-register voices** (below 250 Hz): pure sine. Anything richer aliases and buzzes.
- **Mid-register voices** (250–500 Hz): sine + small (~0.3) 2nd and 3rd harmonic for presence.
- **Upper voices** (500+ Hz): sine + ~0.5 harmonic mix, OR a saw stack with a lowpass.
- **Amplitudes matter more than voicing.** If you set bass voices at 0.40 and upper voices at 0.10, peak-normalization will shrink the upper voices to inaudibility. Balance amplitudes per band, not per "feel".
- **FluidSynth output is dry.** Run it through `sox in.wav out.wav reverb 35 70 80` for a moderate hall — without reverb the GM SoundFont sounds like a workstation from 2003.
- **Stereo width.** Procedural mono pads sound flat. Either: L/R delay of ~12–15 ms, or run through sox chorus.

## The in-game-mix audit is your ears

You can't listen. The mix audit is the proxy. **Run it on every stem before declaring success.**

```bash
cd scripts/music-gen
venv/bin/python ingame_mix.py render-bed mixaudit/bed.wav   # one-time
venv/bin/python ingame_mix.py analyze-mix \
  mixaudit/bed.wav <candidate.mp3> mixaudit/check.wav --gain 0.30
```

Output gives `bed_minus_music_db` per band. Calibration targets:

| Band | Pass threshold | Why |
|---|---|---|
| `sub_20-60` | bass wins by ≥10 dB | Sub-bass should be the bass kit's alone |
| `bass_60-200` | bass wins by ≥6 dB | This is the bass family's home register |
| `lo_mid_200-500` | bass wins by ≥4 dB | Tightest band; biggest risk of fighting |
| `mid_500-2k` | either; music can win up to 6 dB | Music's natural home — being heard is OK |
| `hi_mid_2k-6k` | either | Sparkle band; bass has little energy here |
| `air_6k-16k` | either | Pads usually have nothing here anyway |

If lo-mid fails, the music is fighting the bass. Two fixes: lower gain (cheap, may make music inaudible), or revoice to push energy out of 200–500 Hz (harder, better outcome).

If sub fails (music has too much 20–60 Hz energy), trim the lowest voice. Pads don't need sub.

## Variation naming convention

**Use vibe-based names, not iteration numbers.** Variation IDs describe the *sound* (`cinematic-el`, `musicbox-sb`, `synthwave-el`, `flagship-sb`, `vaporwave-el`, `outerwilds-el`) — never `r2`, `r3`, `roundN`, or other version stamps. The `-el` / `-sb` suffix marks the source (`el` = ElevenLabs Music API; `sb` = self-built / procedural via FluidSynth + numpy). Two variations can share a vibe word only if they pair as `-el` / `-sb`; otherwise, pick a more specific vibe.

**During iteration** you may use working names (`new-variation`, `wip-1`, etc.) but **before merging to the pool, rename to a vibe**. If asked to "add a new variation," propose a vibe name in your first reply and use it throughout the pipeline so the audio files, code references, and pool entry all match.

Good: `vaporwave-el`, `musicbox-sb`, `outerwilds-el`.
Bad: `r7`, `round7-el`, `experiment-3`.

If you can't find a vibe word that fits, that's a signal the variation isn't distinct enough from the existing pool — flag it back to the user rather than shipping a generic name.

## Integration patterns

### Adding a new variation to the pool

1. Add the variation to the `HaloMusicVariation` union in `src/Sound.ts`:
   ```ts
   export type HaloMusicVariation =
     | "cinematic-el" | "musicbox-sb" | "your-new-vibe-el" | "none";
   ```
2. Add a gain target in `haloMusicGain`:
   ```ts
   case "your-new-vibe-el": return 0.28;  // from the audit
   ```
3. Drop stems into `sounds/halo-music/{your-new-vibe-el}-{ambient,melodic,layer3}.mp3`.
4. Add to `HALO_MUSIC_POOL` in `src/game/haloMusicConfig.ts` to enable random selection.
5. Add an entry to `VARIATION_META` in `src/music/page/MusicMixer.tsx` (label + blurb + gains) so the /music page knows what to display.
6. Add an entry to `public/sounds/music-config.json` mirroring the audit-tuned gains.
7. Type-check: `./node_modules/.bin/tsc -b`.

`startGame` in `lifecycle.ts` already preloads every pool entry — no change needed there.

### Adding a new music slot (not the halo)

If the user wants music for a different game moment (boss waves, title screen, etc.), follow the halo pattern in `Sound.ts`:

- Buffer cache `Map<string, AudioBuffer>` keyed by URL
- `loadFooBuffer` mirroring `loadHaloMusicBuffer`
- `playFoo` that creates two looping `AudioBufferSourceNode`s, schedules `.start()` aligned to the next `BASS_MEASURE_LENGTH` boundary
- `stopFoo` with a ~1.2s exponential fade-out
- Routes via `this.master` (NOT `bakedOut` — bakedOut bypasses the master comp/reverb, which is right for pre-baked one-shots but wrong for music you want sitting in the same bus as live voices)

If the new music has only one layer (no ambient/melodic split), drop the second AudioBufferSourceNode — but keep the beat-clock-aligned start.

## Common failure modes and how to detect them

| Failure | Detection | Fix |
|---|---|---|
| Music too short, loops obvious | Listener fatigue → just count: 8s loops repeat 7×/min | Make stems 32s+ with internal phrase variation |
| Music fighting bass | `ingame_mix.py` lo-mid `bed_minus_music_db < 4` | Lower gain, or revoice upper register |
| Music inaudible | `ingame_mix.py` mid-band `bed_minus_music_db > 25` | Raise gain, brighten voicing (add upper harmonic content), check spectral centroid |
| Loop seam clicks | `deepinspect.py first_vs_last_correlation` near 0, or audible thump | Apply 50 ms fades to both edges via `process_r2.py` `fade_edges` |
| Two layers drift out of phase | Loop start times differ between ambient and melodic | Ensure single `startAt` for both `.start()` calls in `Sound.ts` |
| EL ignores prompt structure | Output length wrong, or silent sections where you didn't ask for them | Trim from a known-non-silent offset; or regenerate with simpler structure |
| Layer is too rich alone | Melodic stem sounds like a finished melody | Re-prompt for "harmonically incomplete" / "long held tones" — the reward of 6x should be the *click into completeness* over the pad |

## When to ask the user

Most aesthetic decisions you can make yourself by running tools. **Ask before:**

- Spending more than ~5,000 ElevenLabs characters in one batch (check balance first, report)
- Changing `HALO_MUSIC_POOL` semantics (e.g., switching from random-per-trigger to per-run)
- Touching anything outside the music slot you were asked to work on
- Deleting existing music files (could be in use for A/B, even if not in the pool)

Don't ask: which key, which voicing, which gain, how to structure the loop, which library to use. Those are determined by the constraints above.

## Reporting back

When you finish a variation, report:

- **What you generated**, in 2–3 lines: source, aesthetic, key/voicing decisions
- **Audit results**, with the actual numbers: BPM detected, key detected, peak dBFS, the `bed_minus_music_db` table from `ingame_mix.py`, and the chosen playback gain
- **What you can't verify**: your ears. Be explicit about what depends on the user's listen — "the EL ambient may have piano onset hits in the sustained-pad sections (66 onsets above 2σ); can't tell from analysis if they're musical or rhythmic"
- **ElevenLabs credit spend** for this round
- **Honest self-critique**: one or two things that are likely weak that you couldn't fix without listening

The last point matters. Don't ship a stem and call it good — name the risks so the user knows what to listen for.

## Lessons from previous rounds (don't repeat these)

- **Round 1 (8s loops, Cm-Ab-Eb-Bb progression, gain 0.55):** Too short (looped 7×/min — instantly boring), wrong harmony (fought the bass C-major bed), too loud (lo-mid masked the bass at 200–500 Hz). Deleted.
- **Pitch-shifting EL output to fix key:** broke the timbre. Always regenerate instead.
- **"No drums" in EL prompts:** ignored. Use affirmative phrasing.
- **Procedural pad with only sine voices below 250 Hz:** inaudible against bass. Need harmonic content above 500 Hz or amplitude rebalancing.
- **1-pole lowpass at any reasonable cutoff:** kills brightness in pads. Use amplitude envelopes for "breath", not filter sweeps, unless you implement a proper state-variable filter.
- **Not aligning loop start to bass measure boundary:** chord changes in the music landed mid-bar relative to the bass kicks. Fixed in `gameUpdate.ts` via `measureAlignDelay`.
- **Asserting aesthetic claims without running the audit:** the failure mode that wasted the most time. Run the audit first, write the claim second.
