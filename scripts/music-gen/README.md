# Halo combo music generation pipeline

Variations of the 4x/6x/12x combo halo music, each with three stems (ambient + melodic + layer3). Loop length: 32 seconds = 4 phrases × 4 bars at 120 BPM. The bass holds a C+G open-fifth pedal throughout; the upper voices drift across the four phrases (maj third → min third → Cmaj7 → min third settle). Layer 3 is the per-variation "12x reward" — one new musical element chosen to thematically extend that variation's existing ambient + melodic stems (lonely violin, felt glockenspiel, plucked synth-bass arp, chime counter-melody).

Stems are picked at random from `HALO_MUSIC_POOL` in `src/game/haloMusicConfig.ts` each time combo crosses 4 from below.

## Variations

| name | source | aesthetic | playback gain (ambient·melodic / layer3) |
|------|--------|-----------|------------------------------------------|
| `r2-el` | ElevenLabs Music (ambient+melodic) / FluidSynth solo violin (layer 3) | cinematic strings + felt piano, with a lonely violin third voice | 0.25 / 0.45 |
| `r2-sb` | numpy sine pad + FluidSynth felt piano + sox reverb (ambient+melodic); FluidSynth felt-mallet glockenspiel arpeggio (layer 3) | warm and round; layer 3 = slow felt-chime arpeggio that extends the felt-piano sparkle | 0.30 / 0.40 |
| `r3-el` | ElevenLabs end-to-end synthwave (ambient+melodic) + FluidSynth pulsed synth-bass arp on off-beats (layer 3) | Juno-pad + soft lead; layer 3 = synthwave plucked-bass motion in the gaps | 0.22 / 0.30 |
| `r4-sb` | self-built rhythmic flagship + FluidSynth chime counter-melody (layer 3) | pulsing 16th-note arp + calliope; layer 3 = sparse glockenspiel counter-line that interlocks with the arp's rests | 0.25 / 0.32 |
| `r5-el` | ElevenLabs Music all three stems — generated as 64s pieces, best 32s windows extracted by `find_loop_r5.py` | dawn/vaporwave: glassy string-choir pad + sparse felt-bell sustains + bright crystal-glockenspiel arpeggio; mid-upper register throughout | 0.27 / 0.32 |
| `r6-el` | ElevenLabs Music all three stems — 64s pieces, best 32s window via `find_loop_r6.py`, melodic+layer3 onsets snapped to 8th-note grid via `quantize_to_beat.py` (piecewise rubberband stretching), ambient HPF'd at 200 Hz to keep bass kit clear | Outer-Wilds folk: distant drone pad + fingerpicked acoustic guitar (G mixolydian — V-over-I suspension) + slow held-note harmonica; haunting/gentle | 0.235 / 0.30 |

Final files live in `public/sounds/halo-music/{variation}-{ambient,melodic,layer3}.mp3`.

## Layered playback

- `ambient` plays whenever combo ≥ 4 (yellow halo)
- `melodic` ducks in at combo ≥ 6 (one fade ramp, no fresh `.start()` — keeps phase lock with ambient)
- `layer3` ducks in at combo ≥ 12 (per-variation new element — bloom-in over 0.7s)

All three sources are started simultaneously at the same `ctx.currentTime`, then layer gains are ramped. This guarantees sample-accurate phase alignment for the lifetime of the music.

## Layout

```
scripts/music-gen/
├── analyze.py            Inspect (BPM/key/loudness/centroid), lock-to-N-BPM,
│                         and mix N stems together
├── deepinspect.py        Per-band RMS, stereo correlation, chroma evolution
│                         over time, fade-in/out detection, loop-seam check
├── ingame_mix.py         Synthesize a representative bass kit + bg-beat
│                         segment, then mix it with a candidate halo music
│                         stem and report per-band dominance. The "ears" for
│                         a developer who can't listen.
├── eleven_music.py       Thin wrapper around the ElevenLabs Music API
├── build_v3.py           Tiny standalone MIDI writer used by build_r2 (and
│                         was the original cinematic-stem builder)
├── build_r2.py           Round-2 self-built variation. 32-second pad +
│                         held-note FluidSynth melody
├── process_r2.py         Post-processing pipeline. Trim to 32s, peak-normalize
│                         to -12 dBFS, fade edges, optional sox reverb, render
│                         to wav + mp3
├── soundfonts/
│   └── GeneralUser-GS.sf2  GM SoundFont, 30 MB, 261 instruments (gitignored)
├── raw/                  Direct outputs from ElevenLabs / FluidSynth / numpy
│                         (gitignored)
├── processed/            Pre-shipping wav + mp3 (gitignored)
├── mixaudit/             Scratch dir for in-game-mix tool (gitignored)
└── venv/                 Python venv (gitignored)
```

## Setup

```bash
cd scripts/music-gen
python3 -m venv venv
venv/bin/pip install librosa soundfile pyrubberband pydub numpy scipy requests
brew install sox fluid-synth   # rubberband + ffmpeg also needed

# SoundFont
mkdir -p soundfonts
curl -L -o soundfonts/GeneralUser-GS.sf2 \
  https://github.com/mrbumpy409/GeneralUser-GS/raw/main/GeneralUser-GS.sf2
```

## Iterate

```bash
cd scripts/music-gen
export ELEVENLABS_API_KEY=...

# regenerate one EL stem
venv/bin/python eleven_music.py \
  --out raw/r2-cinematic-ambient.mp3 \
  --length-ms 32000 \
  --prompt "120 BPM cinematic ambient bed, C pedal ..."

# regenerate the self-built variation (edit chord voicings inside build_r2.py)
venv/bin/python build_r2.py

# re-run post-process to land final stems in processed/
venv/bin/python process_r2.py

# audit a stem against the synthesized in-game bass bed
venv/bin/python ingame_mix.py render-bed mixaudit/bed.wav
venv/bin/python ingame_mix.py analyze-mix \
  mixaudit/bed.wav processed/r2-sb-ambient.mp3 mixaudit/check.wav --gain 0.30

# inspect any wav/mp3
venv/bin/python analyze.py inspect processed/r2-el-ambient.mp3
venv/bin/python deepinspect.py processed/r2-el-ambient.mp3

# copy finals into the game's assets dir
cp processed/r2-{el,sb}-{ambient,melodic}.mp3 ../../public/sounds/halo-music/
```

## Pipeline invariants

Every final stem satisfies:

- **Exactly 32.000 seconds** at 44.1 kHz, stereo
- **Peak normalized to -12 dBFS** (was -6 dBFS in r1 — too hot; the bass field
  was getting masked in 200–500 Hz)
- **50 ms fade-in / fade-out** so the loop seam doesn't click
- **Shared downbeat at sample 0** so ambient + melodic stay phase-locked when
  started simultaneously
- **C+G open-fifth bass pedal** so the music doesn't fight the bass field's
  C-major bed (same harmonic strategy as the legacy synthesized pad)

## Why two layers, not one?

Both `AudioBufferSourceNode`s are started at the same `ctx.currentTime`. When
combo hits 4, the ambient fades in immediately; when combo hits 6, the
melodic-layer gain ramps up from silence to full. Stems remain
sample-accurately phase-locked because the melodic source was already playing
silently — switching tiers is a gain ramp, not a fresh `source.start()` (which
would risk loop-phase drift).

## Why a 32s loop, not 8s?

8-second loops repeat ~5× per minute of sustained combo play. Even a good
musical phrase gets tedious-obvious within the second repetition. 32 seconds
with internal phrase variation (A-A'-B-A') feels structured rather than looped.

## Why a C pedal, not a chord progression?

The bass field in this game lives in a C-major drone bed (`bassA-D` voices
around C, E, G). The legacy synthesized halo pad uses a C+G open fifth
specifically because it's mode-invariant — works whether the wave is Lydian,
Phrygian, etc. Round 1 used a Cm-Ab-Eb-Bb progression which fought the bass
field's E-natural. Round 2 deferred to the bass: only the upper voice moves
(maj third, min third, maj7 colour), and the bottom always says "C".
