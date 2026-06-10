"""flagship-sb melodic + layer3 — ghost-duet take, fully procedural.

Replaces the VPO cello (melodic) + female choir (layer3) pair. That take
pasted sampled orchestra over a procedural synth arp — an aesthetic mismatch,
and the cello put most of its energy below 500 Hz where the arp and the bass
field already live. These stems keep the self-built synth identity of
flagship-sb-ambient and sit strictly above the arp's register.

Loop: 32 s = 4 phrases x 4 bars at 120 BPM. C-pedal. Phrase order A/A1/B/A2
(B = major/maj7 colour with E and B naturals; others Eb minor colour),
matching the ambient arp's per-phrase cells. Every onset on the quarter-beat
grid so nothing reads as syncopated against the bass clock.

Melodic (6x) — "ghost lead": theremin-like voice. Three detuned unison
  oscillators (sine + soft 2nd/3rd/4th harmonics), slow 150 ms attack,
  delayed vibrato, portamento between legato notes, dotted-quarter
  tempo-synced echo. Register G4-G5 — above the arp cell (C4-G4), home
  band 500-2k where music is allowed to win.

Layer 3 (12x) — "glass bells": sparse inharmonic bell strikes, three per
  phrase, G5-E6 fundamentals. Each partial is a detuned pair so the bell
  shimmers as it decays. Ping-pong dotted-quarter echo turns each strike
  into a receding call. Answers the lead in its rests.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_v3 import midi_note  # noqa: E402

OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

SR = 44100
BPM = 120
BEAT_S = 60.0 / BPM
PHRASE_BEATS = 16
LOOP_S = 32.0
LOOP_N = int(LOOP_S * SR)
DOTTED_QUARTER_S = BEAT_S * 1.5

rng = np.random.default_rng(7)


def hz_of(pitch: str) -> float:
    return 440.0 * (2 ** ((midi_note(pitch) - 69) / 12.0))


def cents_mul(c: float) -> float:
    return 2 ** (c / 1200.0)


# --- Melodic: ghost lead ----------------------------------------------------
#
# (beat_in_phrase, dur_beats, pitch, velocity 0-1). Notes whose onset equals
# the previous note's release glide from the previous pitch (portamento).
#
# A  : a question rising to C, then the Eb->D sigh
# A1 : the answer — climbs to Eb, settles back to C
# B  : the lift — E natural, peak on G5, hangs on B4 (maj7, unresolved)
# A2 : resolution — Eb colour returns, ends floating on the octave root
LEAD_PHRASES = {
    "A":  [(2.0, 2.0, "G4", 0.75), (4.0, 1.0, "Bb4", 0.62), (5.0, 3.0, "C5", 0.85),
           (10.0, 2.0, "Eb5", 0.92), (12.0, 3.0, "D5", 0.78)],
    "A1": [(2.0, 2.0, "C5", 0.80), (4.0, 1.0, "D5", 0.68), (5.0, 3.0, "Eb5", 0.90),
           (10.0, 2.0, "D5", 0.74), (12.0, 3.0, "C5", 0.68)],
    "B":  [(2.0, 2.0, "E5", 0.85), (4.0, 2.0, "D5", 0.72), (6.0, 3.0, "G5", 1.00),
           (10.0, 2.0, "E5", 0.80), (12.0, 3.0, "B4", 0.74)],
    "A2": [(2.0, 2.0, "Eb5", 0.80), (4.0, 2.0, "D5", 0.70), (6.0, 3.0, "C5", 0.74),
           (10.0, 2.0, "G4", 0.62), (12.0, 3.0, "C5", 0.70)],
}
PHRASE_ORDER = ["A", "A1", "B", "A2"]

LEAD_RELEASE_S = 0.6
LEAD_ATTACK_S = 0.15
GLIDE_S = 0.13
VIBRATO_HZ = 4.7
VIBRATO_CENTS = 16.0
VIBRATO_ONSET_S = 0.35


def render_lead() -> np.ndarray:
    left = np.zeros(LOOP_N, dtype=np.float64)
    right = np.zeros(LOOP_N, dtype=np.float64)

    for pi, key in enumerate(PHRASE_ORDER):
        notes = LEAD_PHRASES[key]
        for ni, (b, dur_b, pitch, vel) in enumerate(notes):
            start_beat = pi * PHRASE_BEATS + b
            f_target = hz_of(pitch)
            dur_s = dur_b * BEAT_S
            n = int((dur_s + LEAD_RELEASE_S) * SR)
            t = np.arange(n) / SR

            # Portamento when this onset equals the previous note's release
            freq = np.full(n, f_target)
            if ni > 0:
                pb, pd, ppitch, _ = notes[ni - 1]
                if abs((pb + pd) - b) < 1e-6:
                    f_prev = hz_of(ppitch)
                    gn = int(GLIDE_S * SR)
                    shape = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, gn))
                    freq[:gn] = f_prev * (f_target / f_prev) ** shape

            # Delayed vibrato, ramping in over ~0.9 s after onset
            depth = np.clip((t - VIBRATO_ONSET_S) / 0.9, 0.0, 1.0) * VIBRATO_CENTS
            vib = 2 ** ((depth * np.sin(2 * np.pi * VIBRATO_HZ * t
                                        + rng.uniform(0, 2 * np.pi))) / 1200.0)

            env = np.ones(n)
            an = int(LEAD_ATTACK_S * SR)
            env[:an] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, an))
            rn = int(LEAD_RELEASE_S * SR)
            env[-rn:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, rn))
            # slow breath swell so long notes feel bowed, not organ-held
            env *= 1.0 + 0.07 * np.sin(2 * np.pi * 0.22 * t + 1.1)

            # upper harmonics relax as the note sustains
            hfade = 1.0 - 0.35 * np.clip(t / max(dur_s, 1e-9), 0.0, 1.0)

            i0 = int(start_beat * BEAT_S * SR)
            i1 = min(i0 + n, LOOP_N)
            seg = i1 - i0
            if seg <= 0:
                continue

            for det, wl, wr in ((-6.0, 0.65, 0.35), (0.0, 0.5, 0.5), (6.0, 0.35, 0.65)):
                fv = freq * vib * cents_mul(det)
                phase = np.cumsum(2 * np.pi * fv / SR) + rng.uniform(0, 2 * np.pi)
                sig = np.sin(phase)
                sig += 0.22 * hfade * np.sin(2 * phase)
                sig += 0.10 * hfade * np.sin(3 * phase)
                sig += 0.045 * hfade * np.sin(4 * phase)
                sig *= env * vel / 3.0
                left[i0:i1] += wl * sig[:seg]
                right[i0:i1] += wr * sig[:seg]

    left, right = echo_pingpong(left, right, DOTTED_QUARTER_S,
                                gains=(0.30, 0.11, 0.04))
    return np.stack([left, right], axis=1)


# --- Layer 3: glass bells ---------------------------------------------------
#
# (beat_in_phrase, pitch, velocity). Strikes only on the quarter-beat grid,
# placed in the lead's rests (beats 0, 8, 11) so the two voices interlock.
BELL_PHRASES = {
    "A":  [(0.0, "G5", 0.70), (8.0, "C6", 0.85), (11.0, "Eb6", 0.68)],
    "A1": [(0.0, "G5", 0.62), (8.0, "Eb6", 0.80), (11.0, "D6", 0.68)],
    "B":  [(0.0, "E6", 0.80), (8.0, "B5", 0.74), (11.0, "D6", 0.66)],
    "A2": [(0.0, "C6", 0.80), (8.0, "Eb6", 0.70), (12.0, "G5", 0.55)],
}

# (ratio, amplitude, decay tau seconds) — inharmonic glass partials
BELL_PARTIALS = [
    (1.00, 1.00, 2.9),
    (2.31, 0.55, 1.6),
    (3.97, 0.30, 0.95),
    (5.92, 0.16, 0.55),
    (8.21, 0.08, 0.32),
]
BELL_TAIL_S = 3.2


def render_bells() -> np.ndarray:
    left = np.zeros(LOOP_N, dtype=np.float64)
    right = np.zeros(LOOP_N, dtype=np.float64)

    strike_idx = 0
    for pi, key in enumerate(PHRASE_ORDER):
        for b, pitch, vel in BELL_PHRASES[key]:
            start_beat = pi * PHRASE_BEATS + b
            f0 = hz_of(pitch)
            n = int(BELL_TAIL_S * SR)
            t = np.arange(n) / SR
            sig = np.zeros(n)
            for ratio, amp, tau in BELL_PARTIALS:
                fp = f0 * ratio
                if fp > SR / 2.4:
                    continue
                decay = np.exp(-t / tau)
                # detuned pair per partial — the beating is the shimmer
                for det in (-3.0, 3.0):
                    sig += 0.5 * amp * decay * np.sin(
                        2 * np.pi * fp * cents_mul(det) * t
                        + rng.uniform(0, 2 * np.pi))
            an = int(0.004 * SR)
            sig[:an] *= np.linspace(0, 1, an)
            sig *= vel * 0.5

            # alternate strikes left/right of center
            pan = 0.5 + (0.22 if strike_idx % 2 == 0 else -0.22)
            strike_idx += 1
            i0 = int(start_beat * BEAT_S * SR)
            i1 = min(i0 + n, LOOP_N)
            seg = i1 - i0
            if seg <= 0:
                continue
            left[i0:i1] += (1.0 - pan) * sig[:seg]
            right[i0:i1] += pan * sig[:seg]

    left, right = echo_pingpong(left, right, DOTTED_QUARTER_S,
                                gains=(0.38, 0.16, 0.06))
    return np.stack([left, right], axis=1)


# --- shared ------------------------------------------------------------------

def echo_pingpong(left: np.ndarray, right: np.ndarray, delay_s: float,
                  gains: tuple[float, ...]) -> tuple[np.ndarray, np.ndarray]:
    """Tempo-synced echo; each tap swaps channels for width."""
    dn = int(delay_s * SR)
    out_l, out_r = left.copy(), right.copy()
    for k, g in enumerate(gains):
        shift = dn * (k + 1)
        if shift >= len(left):
            break
        a, b = (right, left) if k % 2 == 0 else (left, right)
        out_l[shift:] += g * a[:-shift]
        out_r[shift:] += g * b[:-shift]
    return out_l, out_r


def write_stem(y: np.ndarray, out: Path) -> None:
    peak = float(np.max(np.abs(y)))
    if peak > 0:
        y = y * (0.5 / peak)
    sf.write(str(out), y.astype(np.float32), SR, subtype="PCM_16")
    print(f"  wrote {out}  raw peak {peak:.3f}")


def main():
    print("rendering flagship-sb-melodic (procedural ghost lead)...")
    write_stem(render_lead(), OUT / "flagship-sb-melodic.wav")

    print("rendering flagship-sb-layer3 (procedural glass bells)...")
    write_stem(render_bells(), OUT / "flagship-sb-layer3.wav")


if __name__ == "__main__":
    main()
