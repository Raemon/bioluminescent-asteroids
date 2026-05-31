# Halo combo music generation pipeline

Variations of the 4x/6x/12x combo halo music, each with three stems (ambient + melodic + percussion). Loop length: 32 seconds = 4 phrases × 4 bars at 120 BPM. The bass holds a C+G open-fifth pedal throughout; the upper voices drift across the four phrases (maj third → min third → Cmaj7 → min third settle). The r2-el variation is an exception: its third stem is a lonely solo violin rather than a drum kit, matching the cinematic-strings aesthetic of the other r2-el layers.

Stems are picked at random from `HALO_MUSIC_POOL` in `src/game/haloMusicConfig.ts` each time combo crosses 4 from below.

## Variations

| name | source | aesthetic | playback gain (ambient/melodic / percussion) |
|------|--------|-----------|----------------------------------------------|
| `r2-el` | ElevenLabs Music (ambient+melodic) / FluidSynth solo violin (percussion slot — exception, not a drum kit) | cinematic strings + felt piano, with a lonely violin third voice | 0.25 / violin 0.45 |
| `r2-sb` | numpy sine pad with harmonic upper voices + FluidSynth felt piano + sox reverb (ambient+melodic); FluidSynth drum kit — soft kick + side-stick + closed hat (percussion) | warmer, drier; sparse brushy kit | 0.30 / percussion 0.55 |
| `r3-el` | ElevenLabs end-to-end synthwave (ambient+melodic) + FluidSynth electronic drum kit (percussion) | Juno-pad + soft lead + four-on-the-floor synth kit | 0.22 / percussion 0.55 |
| `r4-sb` | self-built rhythmic flagship + FluidSynth interlocked kit (percussion) | pulsing 16th-note arp + calliope-melody + 16th-note hat ostinato w/ syncopated kick | 0.25 / percussion 0.55 |

Final files live in `public/sounds/halo-music/{variation}-{ambient,melodic,percussion}.mp3`.

## Layered playback

- `ambient` plays whenever combo ≥ 4 (yellow halo)
- `melodic` ducks in at combo ≥ 6 (one fade ramp, no fresh `.start()` — keeps phase lock with ambient)
- `percussion` ducks in at combo ≥ 12 (drum kit or, for r2-el, lonely violin — bloom-in over 0.7s)

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
