"""Rebuild synthwave-el's layer 3: plucked-saw echo cascade (outrun delay arp).

The previous layer 3 (FluidSynth synth-bass arp, C2/G2 quarter notes) sat in
the same sub-500 Hz register as the ambient and melodic stems — the whole
variation has ~87% of its energy below 500 Hz and the 12x reward was
spectrally invisible. This version goes the opposite way: a sparse plucked
detuned-saw motif in C5-C6 whose dotted-eighth ping-pong delay fills the
empty upper register with cascading syncopation — the classic synthwave
sequencer-echo move.

Structure follows the variation's A-A'-B-A' phrase plan. Each measure
strikes only 2-3 notes; the 375 ms delay (dotted eighth at 120 BPM) supplies
the rest of the motion, echoing across the 0.5 s beat grid so the cascade
lands on-beat, off-beat, on-beat... in turn.

Phrase colour tones (top of the motif):
  A   E6   (maj 3rd)
  A'  Eb6  (shadow)
  B   B5 + D6 grace (Cmaj7 + 9 — busiest phrase)
  A'  Eb6  (settle; final measure tapers so the cascade decays into the seam)

Output: raw/synthwave-el-layer3.wav (then process via process_layer3-style
trim/fade/normalize/reverb).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
OUT = HERE / "raw" / "synthwave-el-layer3.wav"

SR = 44100
BPM = 120
BEAT_S = 60.0 / BPM            # 0.5
MEASURE_S = 4 * BEAT_S         # 2.0
LOOP_S = 32.0

DELAY_S = 0.375                # dotted eighth
DELAY_FEEDBACK = 0.48
DELAY_MIN_GAIN = 0.04

NOTE_RING_S = 1.1
ATTACK_S = 0.004
DECAY_TAU_S = 0.16
DETUNE_CENTS = 6.0
MAX_PARTIAL_HZ = 15000.0

A4 = 440.0
_NOTE_SEMIS = {"C": -9, "D": -7, "E": -5, "F": -4, "G": -2, "A": 0, "B": 2}


def pitch_hz(name: str) -> float:
    letter = name[0]
    rest = name[1:]
    semi = _NOTE_SEMIS[letter]
    if rest.startswith("b"):
        semi -= 1
        rest = rest[1:]
    elif rest.startswith("#"):
        semi += 1
        rest = rest[1:]
    octave = int(rest)
    return A4 * 2.0 ** (semi / 12.0 + (octave - 4))


def render_pluck(f0: float) -> np.ndarray:
    """Stereo pluck: two band-limited saws detuned +-6 cents, panned apart."""
    n = int(NOTE_RING_S * SR)
    t = np.arange(n) / SR

    def saw(f: float) -> np.ndarray:
        y = np.zeros(n)
        k = 1
        while k * f < MAX_PARTIAL_HZ:
            y += np.sin(2 * np.pi * k * f * t) / k
            k += 1
        return y

    lo = saw(f0 * 2.0 ** (-DETUNE_CENTS / 1200.0))
    hi = saw(f0 * 2.0 ** (+DETUNE_CENTS / 1200.0))

    env = np.exp(-t / DECAY_TAU_S)
    a = max(1, int(ATTACK_S * SR))
    env[:a] *= np.linspace(0.0, 1.0, a)
    # gentle tail-out so the ring ends at zero
    rel = max(1, int(0.05 * SR))
    env[-rel:] *= np.linspace(1.0, 0.0, rel)

    left = (0.65 * lo + 0.35 * hi) * env
    right = (0.35 * lo + 0.65 * hi) * env
    return np.stack([left, right])


# (beat-in-measure, pitch-or-COLOUR, velocity)
COLOUR = "@"
MOTIF_FULL = [(0.0, "C5", 1.00), (1.5, "G5", 0.78), (2.0, COLOUR, 0.88)]
MOTIF_NEUTRAL = [(0.0, "C5", 1.00), (1.5, "G5", 0.78), (2.0, "C6", 0.82)]
MOTIF_TAPER = [(0.0, "C5", 0.90)]

PHRASES = [
    {"colour": "E6", "vel": 1.00},   # A
    {"colour": "Eb6", "vel": 0.85},  # A'
    {"colour": "B5", "vel": 1.05},   # B
    {"colour": "Eb6", "vel": 0.80},  # A' settle
]


def build_events() -> list[tuple[float, str, float]]:
    """(time_s, pitch, amplitude) for every struck note in the 32 s loop."""
    events: list[tuple[float, str, float]] = []
    for pi, phrase in enumerate(PHRASES):
        for mi in range(4):
            m_start = (pi * 4 + mi) * MEASURE_S
            last_measure = pi == 3 and mi == 3
            if last_measure:
                motif = MOTIF_TAPER
            elif mi % 2 == 1:
                motif = MOTIF_NEUTRAL   # breathe: neutral colour on odd bars
            else:
                motif = MOTIF_FULL
            for beat, pitch, vel in motif:
                p = phrase["colour"] if pitch == COLOUR else pitch
                events.append((m_start + beat * BEAT_S, p, vel * phrase["vel"]))
            # B phrase: add the 9th on beat 3 of even bars for the peak lift
            if pi == 2 and mi % 2 == 0:
                events.append((m_start + 3 * BEAT_S, "D6", 0.72 * phrase["vel"]))
    return events


def main() -> None:
    loop_n = int(LOOP_S * SR)
    buf = np.zeros((2, loop_n))

    plucks: dict[str, np.ndarray] = {}
    for t0, pitch, amp in build_events():
        if pitch not in plucks:
            plucks[pitch] = render_pluck(pitch_hz(pitch))
        note = plucks[pitch]

        # dry hit + ping-pong echoes (echo k pans alternately L/R)
        k = 0
        g = 1.0
        while g >= DELAY_MIN_GAIN:
            start = int((t0 + k * DELAY_S) * SR)
            if start >= loop_n:
                break
            seg = note[:, : loop_n - start]
            if k == 0:
                l_gain, r_gain = 1.0, 1.0
            elif k % 2 == 1:
                l_gain, r_gain = 1.35, 0.45
            else:
                l_gain, r_gain = 0.45, 1.35
            buf[0, start : start + seg.shape[1]] += amp * g * l_gain * seg[0]
            buf[1, start : start + seg.shape[1]] += amp * g * r_gain * seg[1]
            k += 1
            g *= DELAY_FEEDBACK

    buf *= 0.9 / max(1e-9, float(np.max(np.abs(buf))))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(OUT), buf.T, SR, subtype="PCM_16")
    print(f"wrote {OUT} ({buf.shape[1] / SR:.3f}s)")


if __name__ == "__main__":
    main()
