"""Round 2 self-built variation. 32-second loop = 16 bars = 4 phrases.

Design lessons applied from round 1:
  - C pedal in the bass throughout (mode-invariant against C major bass bed)
  - Upper-voice drift, not chord progression
  - 4 phrases × 8 bars each — A, A', B, A' — so the loop has internal variety
  - Sustained tones in the melodic stem, harmonically incomplete alone
  - Self-built variation runs through sox reverb in post-process

Ambient stem voicing across 32 seconds:
  Phrase A  (0–8s):  C2 + G2 + G3 + E4   (open fifth + major third on top)
  Phrase A' (8–16s): C2 + G2 + G3 + Eb4  (subtle minor-third shift)
  Phrase B  (16–24s): C2 + G2 + B3 + E4  (Cmaj7 colour — adds longing)
  Phrase A' (24–32s): C2 + G2 + G3 + Eb4 (resolve back to minor-third settle)

Melodic stem: 4 long-held tones across the 32s, each chosen to resolve
ambiguously against the pad voicing of its phrase:
  Phrase A:  hold G4 (the fifth — solid)
  Phrase A': silence (breath)
  Phrase B:  hold D5 (the 9th over Cmaj7 — longing)
  Phrase A': hold E4 (the third — the resolution arrives quietly)
"""

from __future__ import annotations

import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
SF2 = HERE / "soundfonts" / "GeneralUser-GS.sf2"
OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(HERE))
from build_v3 import build_stem, render_midi, midi_note   # tiny MIDI helpers

SR = 44100
BPM = 120
BEAT_S = 60.0 / BPM         # 0.5
MEASURE_S = BEAT_S * 4      # 2.0
PHRASE_S = MEASURE_S * 4    # 8.0 (4-bar phrase)
LOOP_S = PHRASE_S * 4       # 32.0


# --- Procedural ambient: 32s C-pedal bed with upper voice drift ----------

def detuned_sines(freq: float, n: int, detunes_cents=(-3, 0, 3),
                  amp: float = 0.25, harmonic_mix: float = 0.0) -> np.ndarray:
    """Sum a few detuned sines for gentle chorus, optionally with a touch
    of 2nd + 3rd harmonic to add brightness without saw-buzz.

    harmonic_mix: 0.0 = pure sine (dark), 0.4 = ~triangle-ish, higher = brighter
    """
    t = np.arange(n) / SR
    out = np.zeros(n, dtype=np.float32)
    for c in detunes_cents:
        f = freq * (2 ** (c / 1200))
        v = np.sin(2 * np.pi * f * t).astype(np.float32)
        if harmonic_mix > 0:
            v += harmonic_mix * 0.5 * np.sin(2 * np.pi * 2 * f * t).astype(np.float32)
            v += harmonic_mix * 0.25 * np.sin(2 * np.pi * 3 * f * t).astype(np.float32)
        out += v
    return (out / len(detunes_cents) * amp).astype(np.float32)


def crossfade(a: np.ndarray, b: np.ndarray, fade_n: int) -> np.ndarray:
    """Crossfade `b` into `a` over the first `fade_n` samples of b. a and b
    must be the same length. Used to splice between phrase voicings."""
    out = a.copy()
    n = min(fade_n, len(a), len(b))
    if n <= 0:
        return out
    fade_in = np.linspace(0, 1, n, dtype=np.float32)
    fade_out = 1 - fade_in
    out[:n] = a[:n] * fade_out + b[:n] * fade_in
    out[n:] = b[n:]
    return out


def build_phrase_pad(voicing_hz: list[float], amp_per_voice: list[float],
                     phrase_n: int) -> np.ndarray:
    """Sustain each voice in the voicing for the full phrase length. Bass
    voices stay pure sine (warm, no buzz); upper voices get a touch of 2nd
    and 3rd harmonic so they actually have presence in the mid/high band.
    The threshold is per-voice frequency."""
    out = np.zeros(phrase_n, dtype=np.float32)
    for f, a in zip(voicing_hz, amp_per_voice):
        # Below 250 Hz = bass register, pure sine (warmth). Above = add harmonics.
        harm = 0.0 if f < 250 else 0.3 if f < 500 else 0.5
        out += detuned_sines(f, phrase_n, amp=a, harmonic_mix=harm)
    return out


def slow_lowpass(signal: np.ndarray, cutoff_hz: np.ndarray) -> np.ndarray:
    """1-pole lowpass with time-varying cutoff. Adequate for warm pads."""
    out = np.empty_like(signal)
    state = 0.0
    for i in range(len(signal)):
        fc = float(cutoff_hz[i])
        a = 1.0 - np.exp(-2 * np.pi * fc / SR)
        state += a * (signal[i] - state)
        out[i] = state
    return out


def r2_ambient_stereo() -> np.ndarray:
    """Build the four phrases and crossfade them together."""
    phrase_n = int(PHRASE_S * SR)

    def hz_of(pitch: str) -> float:
        return 440.0 * (2 ** ((midi_note(pitch) - 69) / 12.0))

    # Per-phrase voicings + amplitudes. Bass C2+G2 is constant; upper voices
    # shift. Amplitudes weighted so the pedal is the foundation, upper voices
    # are tints. Added upper-octave voices (G4, C5) to give the pad presence
    # in the 500–1500 Hz range — without them, every voice sat below 350 Hz
    # and the mix audit showed the music vanishing under the bass kit.
    # Voicing amplitudes calibrated against the in-game-mix audit. Previous
    # round had bass voices at 0.40 and upper voices at 0.07–0.15, which
    # meant peak-normalization kept the bass intact and shrank the upper
    # voices to near-inaudibility. New balance: bass voices half-strength,
    # upper voices nearly equal to them. With harmonic content in upper
    # voices, this gives roughly equal energy per band.
    phrases = [
        # A: open fifth + major third + bright top
        ([hz_of("C2"), hz_of("G2"), hz_of("G3"), hz_of("E4"), hz_of("G4"), hz_of("C5")],
         [0.22, 0.18, 0.16, 0.16, 0.20, 0.16]),
        # A': open fifth + minor third + dimmer top
        ([hz_of("C2"), hz_of("G2"), hz_of("G3"), hz_of("Eb4"), hz_of("G4")],
         [0.22, 0.18, 0.16, 0.16, 0.18]),
        # B: Cmaj7 — adds B for longing, brighter top voicing
        ([hz_of("C2"), hz_of("G2"), hz_of("B3"), hz_of("E4"), hz_of("G4"), hz_of("D5")],
         [0.22, 0.18, 0.14, 0.16, 0.20, 0.16]),
        # A' again — resolve back to shadow
        ([hz_of("C2"), hz_of("G2"), hz_of("G3"), hz_of("Eb4"), hz_of("G4")],
         [0.22, 0.18, 0.16, 0.16, 0.18]),
    ]

    phrase_signals = [build_phrase_pad(v, a, phrase_n) for v, a in phrases]

    # Apply a slow tremolo-style amplitude swell within each phrase instead of
    # a lowpass sweep — the 1-pole lowpass was too aggressive at this Q and
    # killed all the upper-voice brightness. Amplitude swell preserves
    # spectral content; the "breath" still reads through the volume swell.
    t_phrase = np.arange(phrase_n) / SR
    phrase_lfo = np.sin(np.pi * t_phrase / PHRASE_S)  # 0 → 1 → 0 once per phrase
    swell_env = 0.7 + 0.3 * phrase_lfo
    phrase_signals = [(s * swell_env).astype(np.float32) for s in phrase_signals]

    # Simpler approach: place each phrase end-to-end, then apply a short
    # cosine-shaped crossfade at each seam in place. Each phrase signal has
    # length phrase_n; total length is LOOP_S * SR which is exactly 4 *
    # phrase_n. We splice with a `fade_n`-wide crossfade centered on each
    # phrase boundary, taking samples from both neighbours.
    fade_n = int(0.5 * SR)
    half_fade = fade_n // 2
    full = np.zeros(int(LOOP_S * SR), dtype=np.float32)
    for i, sig in enumerate(phrase_signals):
        start = i * phrase_n
        end = start + phrase_n
        full[start:end] = sig
    # Apply equal-power crossfade at each internal seam
    for boundary in range(1, len(phrase_signals)):
        seam = boundary * phrase_n
        a_start = max(0, seam - half_fade)
        b_end = min(len(full), seam + half_fade)
        n = b_end - a_start
        if n <= 0:
            continue
        # equal-power cosine crossfade
        ramp = np.linspace(0, 1, n, dtype=np.float32)
        fade_in = np.sin(0.5 * np.pi * ramp).astype(np.float32)
        fade_out = np.cos(0.5 * np.pi * ramp).astype(np.float32)
        # `full[a_start:b_end]` currently contains phrase[boundary-1] on the
        # left half and phrase[boundary] on the right half (we wrote them
        # end-to-end). To crossfade we need both signals overlapping the
        # whole window — rebuild from phrase_signals:
        left_phrase = phrase_signals[boundary - 1]
        right_phrase = phrase_signals[boundary]
        left_idx_start = (boundary - 1) * phrase_n
        left_offset = a_start - left_idx_start
        right_offset = a_start - seam        # negative on left half
        for j in range(n):
            li = left_offset + j
            ri = right_offset + j
            l = left_phrase[li] if 0 <= li < phrase_n else 0.0
            r = right_phrase[ri] if 0 <= ri < phrase_n else 0.0
            full[a_start + j] = l * fade_out[j] + r * fade_in[j]

    # Global attack/release: 1.5s fade-in at the head, 2.5s release at the tail
    attack_n = int(1.5 * SR)
    release_n = int(2.5 * SR)
    full[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    full[-release_n:] *= np.linspace(1, 0, release_n, dtype=np.float32) ** 1.5

    # Stereo width via L/R delay (~15ms)
    delay_n = int(0.015 * SR)
    l = full
    r = np.concatenate([np.zeros(delay_n, dtype=np.float32), full[:-delay_n]])

    # Normalize to -12 dBFS peak
    peak = max(float(np.max(np.abs(l))), float(np.max(np.abs(r))))
    if peak > 0:
        g = (10 ** (-12 / 20)) / peak
        l = l * g
        r = r * g

    return np.stack([l, r], axis=1)


# --- Melodic stem: long-held tones over the phrase structure -------------

def build_r2_melodic_events():
    """Four phrases of 8 bars each (8 seconds). Each phrase holds a single
    tone for most of the phrase. Phrase B is intentionally silent (breath).

    Beat positions in the full 32-second loop:
      Phrase A:  hold G4 (5th over C pedal)  — beats 0 to ~7
      Phrase A': silence                     — beats 16 to 32 (covers A' here)
      Phrase B:  hold D5 (9th, longing)      — beats 32 to ~38
      Phrase A': hold E4 (3rd, resolution)   — beats 48 to ~55
    Each held note has a slow swell + decay envelope built into the MIDI via
    velocity + a long sustain. We use felt piano (program 0)."""
    # Beat indices, 4 beats per measure, 4 measures per phrase = 16 beats/phrase
    # Phrase A: 0–16, A': 16–32, B: 32–48, A': 48–64
    melody = [
        # Phrase A: long G4
        (0.0,  10.0, "G4", 70),    # held into the start of A'
        # Phrase A': silence (breath)
        # Phrase B: long D5 (the 9th)
        (32.0, 12.0, "D5", 78),
        # Phrase A' (final): E4 (the third) — gentle resolution
        (48.0, 12.0, "E4", 64),
    ]
    return [(b, d, 0, midi_note(p), v) for b, d, p, v in melody]


def main():
    print("rendering r2 ambient (procedural)…")
    ambient = r2_ambient_stereo()
    a_out = OUT / "r2-ambient.wav"
    sf.write(str(a_out), ambient, SR, subtype="PCM_16")
    print(f"  wrote {a_out}  duration {ambient.shape[0]/SR:.2f}s")

    print("rendering r2 melodic (FluidSynth felt piano)…")
    midi = build_stem(build_r2_melodic_events(), programs={0: 0})
    m_out = OUT / "r2-melodic.wav"
    render_midi(midi, m_out, gain=0.7)
    print(f"  wrote {m_out}")


if __name__ == "__main__":
    main()
