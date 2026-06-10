"""knell-sb: alternate boss-fight variation — the death knell. Haunting
counterpart to crucible-sb's heroic brass: where crucible says "rise to the
fight", knell says "the bell tolls for one of you".

C MINOR like crucible-sb, same justification: C+G open fifth preserved in
the bass register so the bassteroid drone bed doesn't fight; the minor
third (Eb) and the b6 (Ab) colour tones are registered above the bass
voicings.

Loop: 32 seconds = 4 phrases × 4 bars at 120 BPM. Phrase shape A-A'-B-A2:
  A   : Cm          (Eb minor third — establish)
  A'  : Cm add b6   (Eb + Ab — the darkening)
  B   : Cmaj7       (B natural — the eerie lift, brief false hope)
  A2  : Cm          (settle; everything thins so the seam lands on decay)

Layer 1 (ambient, 4x): brooding pad + double-pulse heartbeat. Detuned sine
  bed (C2+G2 anchor, per-phrase upper voice) plus a C1 "lub-dub" heartbeat
  (strong hit, then a softer echo 0.75 beats later, every half-note) — more
  organic dread than crucible's single pulses. A faint G5 shimmer swells in
  during A' and B, gone by the seam.

Layer 2 (melodic, 6x): driving staccato string-ensemble ostinato (GM 48)
  in eighth notes around C3/Eb3/G3 — the relentless pursuit — plus tremolo
  strings (GM 44) swelling into each phrase boundary. B phrase thins the
  ostinato and lets a held tremolo B4 ring the maj7 colour.

Layer 3 (haunting, 12x): ghost choir (GM 52) singing a Dies-irae-shaded
  descending motif (C5 Bb4 C5 Ab4 … resolving to G4) in long tones, plus
  tubular bells (GM 14) tolling C4 on each phrase downbeat — the knell
  itself. Choir 400–1000 Hz, bells inharmonic upper partials.
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


def hz_of(pitch: str) -> float:
    return 440.0 * (2 ** ((midi_note(pitch) - 69) / 12.0))


# --- Layer 1: ambient — brooding pad + lub-dub heartbeat -------------------

def sine_pad(freqs: list[float], amps: list[float], dur_s: float) -> np.ndarray:
    """Sustained sine-pad bed. Three detuned voices per pitch for chorus."""
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    out = np.zeros(n, dtype=np.float32)
    for f, a in zip(freqs, amps):
        for cents in (-4, 0, 4):
            fd = f * (2 ** (cents / 1200))
            out += a * np.sin(2 * np.pi * fd * t).astype(np.float32) / 3
    return out.astype(np.float32)


def heartbeat_pulse(freq: float, dur_s: float, attack_s: float = 0.005,
                    decay_s: float = 0.45) -> np.ndarray:
    """Pure sine pulse, sharp attack + exponential decay (sub register)."""
    n = int(SR * dur_s)
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    t = np.arange(n) / SR
    out = np.sin(2 * np.pi * freq * t).astype(np.float32)
    env = np.exp(-t / decay_s).astype(np.float32)
    attack_n = max(1, int(attack_s * SR))
    env[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    return (out * env).astype(np.float32)


PHRASE_ORDER = ["A", "A1", "B", "A2"]

UPPER_VOICINGS = {
    "A":  ["Eb3"],
    "A1": ["Eb3", "Ab3"],
    "B":  ["B3"],
    "A2": ["Eb3"],
}
UPPER_AMPS = {
    "A":  [0.14],
    "A1": [0.12, 0.08],
    "B":  [0.11],
    "A2": [0.13],
}


def phrase_upper_voice(detune_cents: float) -> np.ndarray:
    """Per-phrase upper colour voice with cosine crossfades at boundaries."""
    phrase_n = int(PHRASE_S * SR)
    loop_n = int(LOOP_S * SR)
    upper = np.zeros(loop_n, dtype=np.float32)
    for i, key in enumerate(PHRASE_ORDER):
        freqs = [hz_of(p) * 2 ** (detune_cents / 1200) for p in UPPER_VOICINGS[key]]
        seg = sine_pad(freqs, UPPER_AMPS[key], PHRASE_S)
        start = i * phrase_n
        upper[start:start + phrase_n] = seg
    xfade_n = int(0.25 * SR)
    for i in range(len(PHRASE_ORDER)):
        boundary = i * phrase_n
        if boundary == 0 or boundary >= loop_n:
            continue
        a = max(0, boundary - xfade_n)
        b = min(loop_n, boundary + xfade_n)
        ramp = np.linspace(0, 1, b - a, dtype=np.float32)
        ramp = 0.5 * (1 - np.cos(np.pi * ramp))
        pre = upper[a:boundary].copy()
        post = upper[boundary:b].copy()
        upper[a:boundary] = pre * (1 - ramp[: boundary - a])
        upper[boundary:b] = post * ramp[boundary - a:]
    return upper


def knell_ambient_stereo() -> np.ndarray:
    loop_n = int(LOOP_S * SR)
    t = np.arange(loop_n) / SR

    def channel(detune_cents: float) -> np.ndarray:
        bass_pad = sine_pad(
            [hz_of("C2") * 2 ** (detune_cents / 1200),
             hz_of("G2") * 2 ** (detune_cents / 1200)],
            [0.20, 0.15],
            LOOP_S,
        )
        return bass_pad + phrase_upper_voice(detune_cents)

    # Lub-dub heartbeat: strong C1 hit, softer echo 0.75 beats later, pair
    # repeating every half-note. Mono — sub-bass is non-directional.
    heart = np.zeros(loop_n, dtype=np.float32)
    lub = heartbeat_pulse(hz_of("C1"), 1.0, attack_s=0.004, decay_s=0.40) * 0.55
    dub = heartbeat_pulse(hz_of("C1"), 0.8, attack_s=0.004, decay_s=0.30) * 0.30
    n_beats = int(LOOP_S / BEAT_S)
    for beat in range(0, n_beats, 2):
        for pulse, offset_beats in ((lub, 0.0), (dub, 0.75)):
            start = int((beat + offset_beats) * BEAT_S * SR)
            end = min(start + len(pulse), loop_n)
            if start < loop_n:
                heart[start:end] += pulse[: end - start]

    # Faint high shimmer (G5) that swells in across A' and B, gone by the
    # seam — the haunting glint above the dread. Slow tremolo so it breathes.
    shimmer_env = np.zeros(loop_n, dtype=np.float32)
    p = int(PHRASE_S * SR)
    rise = np.linspace(0, 1, p, dtype=np.float32) ** 2
    fall = np.linspace(1, 0, p, dtype=np.float32) ** 1.5
    shimmer_env[p:2 * p] = rise
    shimmer_env[2 * p:3 * p] = fall
    shimmer = (np.sin(2 * np.pi * hz_of("G5") * t)
               + 0.6 * np.sin(2 * np.pi * hz_of("G5") * 2 ** (6 / 1200) * t))
    shimmer = shimmer.astype(np.float32) * shimmer_env * 0.035
    shimmer *= (0.75 + 0.25 * np.sin(2 * np.pi * t / 1.5)).astype(np.float32)

    # Phrase-level swell — the boss breathing.
    swell = (0.88 + 0.12 * np.sin(2 * np.pi * t / PHRASE_S - np.pi / 2)).astype(np.float32)

    attack_n = int(0.4 * SR)
    release_n = int(1.0 * SR)

    def finish(mono: np.ndarray) -> np.ndarray:
        mono = (mono + heart + shimmer) * swell
        mono[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
        mono[-release_n:] *= np.linspace(1, 0, release_n, dtype=np.float32) ** 1.2
        return mono

    # Width from a +5-cent detuned right-channel twin (same strategy as
    # crucible-sb — an L/R delay phase-inverts the sub).
    l = finish(channel(0.0))
    r = finish(channel(5.0))

    peak = max(float(np.max(np.abs(l))), float(np.max(np.abs(r))))
    if peak > 0:
        g = (10 ** (-12 / 20)) / peak
        l, r = l * g, r * g
    return np.stack([l, r], axis=1)


# --- Layer 2: melodic — staccato string ostinato + tremolo swells ----------

def build_knell_ostinato_events():
    """String ensemble (GM 48, ch 0). Relentless eighth-note ostinato.

    Per measure (4 beats, 8 eighths): C C Eb C | C G3 Eb C with accents on
    beats 0 and 2. Phrase variations:
      A  : pattern as-is, all 4 measures
      A' : same but the Eb on the back half lifts to Ab3 (the b6 darkening)
      B  : measures 1-2 use E3 (major third) then the ostinato STOPS —
           measures 3-4 are silent under the held tremolo B4 so the maj7
           colour rings (same opening-up move as crucible's B phrase)
      A2 : velocities drop ~26; measure 4 silent so the loop tail decays
    """
    base = [
        (0.0, 0.40, "C3", 92), (0.5, 0.40, "C3", 74), (1.0, 0.40, "Eb3", 80),
        (1.5, 0.40, "C3", 74), (2.0, 0.40, "C3", 88), (2.5, 0.40, "G3", 78),
        (3.0, 0.40, "Eb3", 80), (3.5, 0.40, "C3", 72),
    ]

    def measure(colour: str, vel_off: int):
        out = []
        for b, d, p, v in base:
            pitch = colour if p == "Eb3" else p
            out.append((b, d, pitch, max(28, v + vel_off)))
        return out

    phrase_measures = {
        "A":  [measure("Eb3", 0)] * 4,
        "A1": [measure("Eb3", 2), measure("Eb3", 2), measure("Ab3", 4), measure("Ab3", 4)],
        "B":  [measure("E3", 4), measure("E3", 2), [], []],
        "A2": [measure("Eb3", -26), measure("Eb3", -26), measure("Eb3", -30), []],
    }
    events = []
    for i, key in enumerate(PHRASE_ORDER):
        for m, notes in enumerate(phrase_measures[key]):
            offset = i * 16 + m * 4
            for b, d, p, v in notes:
                events.append((offset + b, d, 0, midi_note(p), v))
    return events


def build_knell_tremolo_events():
    """Tremolo strings (GM 44, ch 1). Held swells that build into each
    phrase boundary, plus the B-phrase's ringing maj7.

      A  : Eb4 swell across beats 12-16 (into A')
      A' : Ab4 swell beats 8-16 (longer — dread building)
      B  : B4 held beats 4-14 (the lift rings while the ostinato stops)
      A2 : Eb4 soft, beats 8-14, decays before the seam
    """
    phrase_riffs = {
        "A":  [(12.0, 4.0, "Eb4", 66)],
        "A1": [(8.0, 8.0, "Ab4", 72)],
        "B":  [(4.0, 10.0, "B4", 84)],
        "A2": [(8.0, 6.0, "Eb4", 52)],
    }
    events = []
    for i, key in enumerate(PHRASE_ORDER):
        for b, d, p, v in phrase_riffs[key]:
            events.append((i * 16 + b, d, 1, midi_note(p), v))
    return events


# --- Layer 3: haunting — ghost choir + tolling bell ------------------------

def build_knell_choir_events():
    """Choir aahs (GM 52, ch 0). Dies-irae-shaded descending motif in long
    tones, placed against the ostinato's drive.

      A  : C5 .. Bb4 .. C5 .. Ab4   (the motif states itself)
      A' : C5 .. Bb4 .. Ab4 .. G4   (descends further — the descent of dread)
      B  : B4 held .. D5 held       (maj7 lift — choir turns briefly luminous)
      A2 : C5 .. Ab4 .. G4 long     (settles; G4 decays into the seam)
    """
    phrase_riffs = {
        "A":  [(2.0, 2.5, "C5", 76), (5.0, 2.5, "Bb4", 72),
               (8.5, 2.5, "C5", 78), (11.5, 3.5, "Ab4", 74)],
        "A1": [(2.0, 2.5, "C5", 78), (5.0, 2.5, "Bb4", 74),
               (8.5, 2.5, "Ab4", 76), (11.5, 3.5, "G4", 72)],
        "B":  [(2.0, 4.0, "B4", 82), (8.5, 4.5, "D5", 78)],
        "A2": [(2.0, 2.5, "C5", 68), (5.5, 2.5, "Ab4", 64),
               (9.0, 4.0, "G4", 58)],
    }
    events = []
    for i, key in enumerate(PHRASE_ORDER):
        for b, d, p, v in phrase_riffs[key]:
            events.append((i * 16 + b, d, 0, midi_note(p), v))
    return events


def build_knell_bell_events():
    """Tubular bells (GM 14, ch 1). The knell. One C4 toll on each phrase
    downbeat; phrase B adds a G4 answer at its midpoint (the lift heard in
    the bell too); A2's toll is soft — the bell receding.
    """
    events = []
    for i, key in enumerate(PHRASE_ORDER):
        offset = i * 16
        vel = 64 if key == "A2" else 96
        events.append((offset + 0.0, 3.0, 1, midi_note("C4"), vel))
        if key == "B":
            events.append((offset + 8.0, 3.0, 1, midi_note("G4"), 80))
    return events


def main():
    print("rendering knell-sb ambient (sine pad + lub-dub heartbeat + shimmer)…")
    ambient = knell_ambient_stereo()
    a_out = OUT / "knell-sb-ambient.wav"
    sf.write(str(a_out), ambient, SR, subtype="PCM_16")
    print(f"  wrote {a_out}  duration {ambient.shape[0]/SR:.2f}s")

    print("rendering knell-sb melodic (FluidSynth string ostinato + tremolo)…")
    melodic_midi = build_stem(
        build_knell_ostinato_events() + build_knell_tremolo_events(),
        programs={0: 48, 1: 44})
    m_out = OUT / "knell-sb-melodic.wav"
    render_midi(melodic_midi, m_out, gain=0.65)
    print(f"  wrote {m_out}")

    print("rendering knell-sb layer3 (FluidSynth choir + tubular bells)…")
    layer3_midi = build_stem(
        build_knell_choir_events() + build_knell_bell_events(),
        programs={0: 52, 1: 14})
    l_out = OUT / "knell-sb-layer3.wav"
    render_midi(layer3_midi, l_out, gain=0.65)
    print(f"  wrote {l_out}")


if __name__ == "__main__":
    main()
