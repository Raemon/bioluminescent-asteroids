"""Round-4 self-built flagship variation (flagship-sb): rhythmic + interlocked.

Distinct from r2/r3 — those are pads. This variation has *rhythmic content*
in every layer so the music interlocks with the game's bass-clock identity
rather than floating over it.

Loop: 32 seconds = 4 phrases × 4 bars at 120 BPM. C-pedal harmony, A-A'-B-A'.

Layer 1 (ambient, 4x): pulsing C-pedal pad with a 16th-note arpeggio
  ostinato playing C4-G4-Eb4-G4 (minor 3rd colour) in phrases A/A', shifting
  to C4-G4-E4-Bb4 (Cmaj7 colour) in phrase B. The arpeggio is a square-wave
  pluck filtered to ~1.2 kHz with a 100 ms decay envelope per note — sits
  in the 250-1500 Hz band, well clear of the bass.

Layer 2 (melodic, 6x): syncopated lead riff via FluidSynth synth lead
  (GM 81 = Lead 2 sawtooth). An 8-beat hook repeated each phrase, with the
  Phrase B variant climbing higher. Voice in the 500-1500 Hz range so it
  cuts through the arp without fighting the bass.

Layer 3 (sparkle, 12x): counter-melody on celesta (GM 8). 8th-note descending
  pattern that fills the gaps in the lead riff. Higher than both layers
  (above 1 kHz), no bass-band collision risk.

All three share a 16th-note grid so they interlock rhythmically. All three
share the C-pedal so they stack harmonically.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_v3 import build_stem, render_midi, midi_note

OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

SR = 44100
BPM = 120
BEAT_S = 60.0 / BPM         # 0.5
MEASURE_S = BEAT_S * 4      # 2.0
PHRASE_S = MEASURE_S * 4    # 8.0
LOOP_S = PHRASE_S * 4       # 32.0
SIXTEENTH_S = BEAT_S / 4    # 0.125


def hz_of(pitch: str) -> float:
    return 440.0 * (2 ** ((midi_note(pitch) - 69) / 12.0))


# --- Layer 1: ambient with 16th-note arpeggio over a slow C-pedal pad ----

def square_pluck(freq: float, dur_s: float, decay_s: float = 0.18,
                 brightness: float = 0.6) -> np.ndarray:
    """Filtered square-wave pluck — bandlimited by summing odd harmonics.
    brightness controls how many harmonics survive (0.4 = warm, 0.8 = bright).
    Per-note decay envelope makes it pluck rather than sustain."""
    n = int(SR * dur_s)
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    t = np.arange(n) / SR
    out = np.zeros(n, dtype=np.float32)
    # Sum odd harmonics with amplitude rolloff — produces a softer square
    # without aliasing in the upper register.
    max_harm = 9
    for h in range(1, max_harm + 1, 2):
        f = freq * h
        if f > SR / 2.5:
            break
        rolloff = (1.0 / h) * (brightness ** (h - 1))
        out += rolloff * np.sin(2 * np.pi * f * t).astype(np.float32)
    # Per-note envelope: instant attack, exponential decay
    env = np.exp(-t / decay_s).astype(np.float32)
    attack_n = int(0.005 * SR)
    if attack_n > 0:
        env[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    return (out * env * 0.18).astype(np.float32)


def sine_pad(freqs: list[float], amps: list[float], dur_s: float) -> np.ndarray:
    """Sustained sine-pad bed underneath the arp. Multi-voice C+G+third."""
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    out = np.zeros(n, dtype=np.float32)
    for f, a in zip(freqs, amps):
        # Three detuned voices per pitch for natural chorus
        for cents in (-4, 0, 4):
            fd = f * (2 ** (cents / 1200))
            out += a * np.sin(2 * np.pi * fd * t).astype(np.float32) / 3
    return out.astype(np.float32)


def r4_ambient_stereo() -> np.ndarray:
    """Build the ambient layer: pad bed + 16th-note arpeggio across 4 phrases."""
    phrase_n = int(PHRASE_S * SR)
    loop_n = int(LOOP_S * SR)

    # Per-phrase arpeggio: 4 sixteenth-notes per beat × 16 beats per phrase = 64 notes
    # But we play a 4-note cell repeating: that's 64/4 = 16 cell repetitions per phrase.
    # Cell varies by phrase voicing.
    # A  : C4 G4 Eb4 G4 (minor 3rd)
    # A' : C4 G4 Eb4 G4 (same — settle into pattern)
    # B  : C4 G4 E4  Bb4 (Cmaj7 — the 9th-7th lift)
    # A' : C4 G4 Eb4 G4 (resolve)
    phrase_arps = {
        "A":  ["C4", "G4", "Eb4", "G4"],
        "A1": ["C4", "G4", "Eb4", "G4"],
        "B":  ["C4", "G4", "E4",  "Bb4"],
        "A2": ["C4", "G4", "Eb4", "G4"],
    }
    phrase_order = ["A", "A1", "B", "A2"]

    # Pad bed: C2 + G2 sustained the whole loop, plus a per-phrase upper voice
    # that drifts (G3+Eb4 vs G3+E4 vs G3+B3 — same scheme as musicbox-sb).
    bass_pad = sine_pad(
        [hz_of("C2"), hz_of("G2"), hz_of("G3")],
        [0.18, 0.14, 0.12],
        LOOP_S,
    )

    # Per-phrase upper voice colour (just one extra voice, low amp)
    upper_voicings = {
        "A":  [hz_of("Eb4")],
        "A1": [hz_of("Eb4")],
        "B":  [hz_of("B3")],
        "A2": [hz_of("Eb4")],
    }
    upper = np.zeros(loop_n, dtype=np.float32)
    for i, key in enumerate(phrase_order):
        seg = sine_pad(upper_voicings[key], [0.10], PHRASE_S)
        start = i * phrase_n
        upper[start:start + phrase_n] = seg

    # Build the arpeggio track. Each phrase: 64 sixteenth-notes, cell of 4 notes.
    arp = np.zeros(loop_n, dtype=np.float32)
    sixteenth_n = int(SIXTEENTH_S * SR)
    # Pluck duration overlaps slightly with the next note for legato feel
    pluck_dur = SIXTEENTH_S * 1.6
    for i, key in enumerate(phrase_order):
        cell = phrase_arps[key]
        phrase_start = i * phrase_n
        for n in range(64):  # 64 sixteenth notes per phrase (4 measures × 4 beats × 4 sixteenths)
            pitch_name = cell[n % 4]
            freq = hz_of(pitch_name)
            # Velocity pattern: emphasize beats 1 and 3 (positions 0, 8, 16, 24, ...)
            # to give the pulse some forward motion
            sixteenth_in_beat = n % 4
            beat_in_measure = (n // 4) % 4
            if sixteenth_in_beat == 0 and beat_in_measure in (0, 2):
                vel = 1.0  # downbeat
            elif sixteenth_in_beat == 0:
                vel = 0.75  # other beats
            elif sixteenth_in_beat == 2:
                vel = 0.55  # off-beats
            else:
                vel = 0.40  # in-between
            pluck = square_pluck(freq, pluck_dur, decay_s=0.14, brightness=0.55) * vel
            start = phrase_start + n * sixteenth_n
            end = min(start + len(pluck), loop_n)
            arp[start:end] += pluck[: end - start]

    # Mix layers
    mono = bass_pad + upper + arp * 0.8

    # Phrase-level amplitude swell (very subtle — keeps the arp punchy)
    t = np.arange(loop_n) / SR
    swell = 0.85 + 0.15 * np.sin(2 * np.pi * t / PHRASE_S - np.pi / 2)
    mono *= swell

    # Global fade-in/out — short so the arp punches in cleanly
    attack_n = int(0.4 * SR)
    release_n = int(1.0 * SR)
    mono[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    mono[-release_n:] *= np.linspace(1, 0, release_n, dtype=np.float32) ** 1.2

    # Stereo via L/R delay (~12 ms)
    delay_n = int(0.012 * SR)
    l = mono
    r = np.concatenate([np.zeros(delay_n, dtype=np.float32), mono[:-delay_n]])

    # Peak-normalize to -12 dBFS
    peak = max(float(np.max(np.abs(l))), float(np.max(np.abs(r))))
    if peak > 0:
        g = (10 ** (-12 / 20)) / peak
        l = l * g
        r = r * g

    return np.stack([l, r], axis=1)


# --- Layer 2: melodic — syncopated lead riff -------------------------------

def build_r4_melodic_events():
    """Synth lead riff (GM 81 = Lead 2 sawtooth). 8-beat hook per phrase.

    Riff design — anchored to C/G chord tones, syncopated:
      Phrase A:  G4 Eb4 . G4 C5 . Eb5 D5   (rises, lands on the 2)
      Phrase A': G4 Eb4 . G4 C5 . Eb5 D5   (same)
      Phrase B:  G4 E4 . A4 D5 . F5 E5     (Cmaj7 colour, peaks higher)
      Phrase A': G4 Eb4 . G4 C5 . Eb5 C5   (resolves down to root)

    Each phrase = 16 beats; the 8-beat hook plays twice with the 2nd time
    landing on a sustained note. Velocities accent the syncopated notes.
    """
    # (beat_offset_in_phrase, dur_beats, pitch, velocity)
    phrase_riffs = {
        "A": [
            (0.0,  1.0, "G4",  90),
            (1.0,  0.5, "Eb4", 78),
            (2.0,  1.0, "G4",  88),
            (3.0,  1.0, "C5",  92),
            (4.5,  1.0, "Eb5", 96),
            (5.5,  2.5, "D5",  82),   # held — landing note
            # 2nd repeat with variation
            (8.0,  1.0, "G4",  86),
            (9.0,  0.5, "Eb4", 76),
            (10.0, 1.0, "G4",  88),
            (11.0, 1.0, "C5",  92),
            (12.5, 1.0, "Eb5", 96),
            (13.5, 2.5, "D5",  82),
        ],
        "A1": [
            (0.0,  1.0, "G4",  90),
            (1.0,  0.5, "Eb4", 78),
            (2.0,  1.0, "G4",  88),
            (3.0,  1.0, "C5",  92),
            (4.5,  1.0, "Eb5", 96),
            (5.5,  2.5, "D5",  82),
            (8.0,  1.0, "G4",  86),
            (9.0,  0.5, "Eb4", 76),
            (10.0, 1.0, "G4",  88),
            (11.0, 1.0, "C5",  92),
            (12.5, 1.0, "Eb5", 96),
            (13.5, 2.5, "D5",  82),
        ],
        "B": [
            (0.0,  1.0, "G4",  92),
            (1.0,  0.5, "E4",  80),
            (2.0,  1.0, "A4",  90),
            (3.0,  1.0, "D5",  98),
            (4.5,  1.0, "F5",  100),
            (5.5,  2.5, "E5",  88),   # peak — the maj7 colour
            (8.0,  1.0, "G4",  90),
            (9.0,  0.5, "E4",  78),
            (10.0, 1.0, "A4",  88),
            (11.0, 1.0, "D5",  96),
            (12.5, 1.0, "F5",  98),
            (13.5, 2.5, "E5",  86),
        ],
        "A2": [
            (0.0,  1.0, "G4",  86),
            (1.0,  0.5, "Eb4", 74),
            (2.0,  1.0, "G4",  84),
            (3.0,  1.0, "C5",  88),
            (4.5,  1.0, "Eb5", 92),
            (5.5,  2.5, "D5",  80),
            (8.0,  1.0, "G4",  82),
            (9.0,  0.5, "Eb4", 72),
            (10.0, 1.0, "G4",  84),
            (11.0, 1.0, "C5",  88),
            (12.5, 1.0, "Eb5", 90),
            (13.5, 2.5, "C5",  76),   # resolve to root
        ],
    }
    phrase_order = ["A", "A1", "B", "A2"]
    events = []
    for i, key in enumerate(phrase_order):
        offset = i * 16  # 16 beats per phrase
        for b, d, pitch, vel in phrase_riffs[key]:
            events.append((offset + b, d, 0, midi_note(pitch), vel))
    return events


# --- Layer 3: sparkle — counter-melody on celesta --------------------------

def build_r4_sparkle_events():
    """Celesta (GM 8) counter-melody. 8th-note descending pattern that fills
    the gaps in the lead riff. Higher register (C5-C6), staccato feel.

    Pattern per phrase: descending fragments at beats 1, 5, 9, 13 (offset
    from the riff's emphasis points). Each fragment is 4 fast 8th notes
    cascading down through chord tones.
    """
    phrase_orders = {
        "A":  ["C6", "G5", "Eb5", "G5"],
        "A1": ["C6", "G5", "Eb5", "G5"],
        "B":  ["C6", "G5", "E5",  "Bb5"],   # maj7 colour
        "A2": ["C6", "G5", "Eb5", "G5"],
    }
    phrase_order = ["A", "A1", "B", "A2"]
    events = []
    for i, key in enumerate(phrase_order):
        phrase_offset = i * 16
        cascade = phrase_orders[key]
        # Cascade fragments at beat 1, 5, 9, 13 of the phrase
        for fragment_start in (1.0, 5.0, 9.0, 13.0):
            for j, pitch in enumerate(cascade):
                beat = phrase_offset + fragment_start + j * 0.5  # 8th notes
                vel = 80 - j * 10  # taper from 80 down to 50
                events.append((beat, 0.45, 0, midi_note(pitch), vel))
    return events


def main():
    # --- Ambient: procedural ---
    print("rendering r4 ambient (procedural arp + pad)…")
    ambient = r4_ambient_stereo()
    a_out = OUT / "flagship-sb-ambient.wav"
    sf.write(str(a_out), ambient, SR, subtype="PCM_16")
    print(f"  wrote {a_out}  duration {ambient.shape[0]/SR:.2f}s")

    # --- Melodic: FluidSynth synth lead ---
    print("rendering r4 melodic (FluidSynth lead 2 sawtooth)…")
    melodic_midi = build_stem(build_r4_melodic_events(), programs={0: 81})
    m_out = OUT / "flagship-sb-melodic.wav"
    render_midi(melodic_midi, m_out, gain=0.55)
    print(f"  wrote {m_out}")

    # --- Sparkle: FluidSynth celesta ---
    print("rendering r4 sparkle (FluidSynth celesta)…")
    sparkle_midi = build_stem(build_r4_sparkle_events(), programs={0: 8})
    s_out = OUT / "flagship-sb-sparkle.wav"
    render_midi(sparkle_midi, s_out, gain=0.65)
    print(f"  wrote {s_out}")


if __name__ == "__main__":
    main()
