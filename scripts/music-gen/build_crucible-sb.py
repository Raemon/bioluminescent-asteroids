"""crucible-sb: climactic boss-fight variation. Three escalating layers
that match the player's rhythm gain during the level-10 boss encounter.

C MINOR (not C major like the other halo tracks) — the boss is the only
fight in the game; harmony shifts to minor to mark it. C+G open fifth
preserved in the bass register so the bassteroid drone bed doesn't fight
(the bass family voices C/E/G; the music's Eb minor third is registered
above the bass voicings).

Loop: 32 seconds = 4 phrases × 4 bars at 120 BPM. Phrase shape A-A'-B-A':
  A   : Cm        (Eb minor third)
  A'  : Cm        (same — settle the pulse)
  B   : Cmaj7     (lift to the major-7 colour — the player's brief reprieve)
  A'  : Cm        (resolve back to minor — the fight isn't over)

Layer 1 (ambient, 4x): brooding C-minor pedal. Three sustained sine voices
  (C2 + G2 + Eb3) for the chord bed, plus a slow 4-beat sub-pulse on C1
  with a hard attack envelope — the boss's heartbeat. No melody.

Layer 2 (melodic, 6x): rising marcato brass riff (FluidSynth GM 61 = Brass
  Section). Stabbing minor-pentatonic hook that climbs across each phrase.
  Sits 250-1500 Hz so it cuts through without fighting the bass register.

Layer 3 (heroic, 12x): solo French horn (GM 60) sustained counter-melody
  + sparse timpani (GM 47) downbeat strikes at phrase transitions. The
  "you're winning" reward layer. Horn voicing 500-1500 Hz, timpani in the
  100-180 Hz band (a tight collision risk with the bass — gain-mitigated).
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


# --- Layer 1: ambient — brooding C-minor pedal + heartbeat ----------------

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
                    decay_s: float = 0.55) -> np.ndarray:
    """Pure sine pulse with sharp attack + long exponential decay. Used for
    the boss's heartbeat in the ambient layer — sits below the bass register
    so it doesn't fight the C/G drone above it."""
    n = int(SR * dur_s)
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    t = np.arange(n) / SR
    out = np.sin(2 * np.pi * freq * t).astype(np.float32)
    env = np.exp(-t / decay_s).astype(np.float32)
    attack_n = max(1, int(attack_s * SR))
    env[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    return (out * env).astype(np.float32)


def crucible_ambient_stereo() -> np.ndarray:
    """Build the brooding ambient bed: low minor-chord pad + heartbeat sub.

    Per-phrase voicing drift:
      A   : C2 + G2 + Eb3   (Cm root + 5th + minor 3rd)
      A'  : C2 + G2 + Eb3   (same)
      B   : C2 + G2 + B3    (Cmaj7 — the major-7 lift)
      A'  : C2 + G2 + Eb3   (resolve back to minor)
    """
    phrase_n = int(PHRASE_S * SR)
    loop_n = int(LOOP_S * SR)

    # C+G open fifth held the entire loop — this is the bass anchor.
    bass_pad = sine_pad(
        [hz_of("C2"), hz_of("G2")],
        [0.20, 0.16],
        LOOP_S,
    )

    # Per-phrase upper voice that switches between minor-third (Eb3) and
    # major-7 (B3) colours.
    phrase_order = ["A", "A1", "B", "A2"]
    upper_voicings = {
        "A":  [hz_of("Eb3")],
        "A1": [hz_of("Eb3")],
        "B":  [hz_of("B3")],
        "A2": [hz_of("Eb3")],
    }
    upper_amps = {
        "A":  [0.14],
        "A1": [0.14],
        "B":  [0.11],
        "A2": [0.14],
    }
    upper = np.zeros(loop_n, dtype=np.float32)
    for i, key in enumerate(phrase_order):
        seg = sine_pad(upper_voicings[key], upper_amps[key], PHRASE_S)
        start = i * phrase_n
        upper[start:start + phrase_n] = seg
    # Smoothly crossfade between adjacent phrase upper-voice segments so the
    # B-phrase Eb3→B3 swap doesn't click.
    xfade_n = int(0.25 * SR)
    for i in range(len(phrase_order)):
        boundary = i * phrase_n
        if boundary == 0 or boundary >= loop_n:
            continue
        a = max(0, boundary - xfade_n)
        b = min(loop_n, boundary + xfade_n)
        n = b - a
        ramp = np.linspace(0, 1, n, dtype=np.float32)
        # 0..1 across the boundary; multiplied as cosine for equal-power feel
        ramp = 0.5 * (1 - np.cos(np.pi * ramp))
        # Save the pre/post regions so we can blend
        # (already overwritten when the next phrase wrote in; simple linear
        # crossfade is good enough at sine amplitudes this low)
        pre = upper[a:boundary].copy()
        post = upper[boundary:b].copy()
        upper[a:boundary] = pre * (1 - ramp[: boundary - a])
        upper[boundary:b] = post * ramp[boundary - a :]

    # Heartbeat: sub-bass C1 pulse every 2 beats (half-note), envelope decays
    # over 0.55s. Quieter than the pad so it sits behind it.
    heart = np.zeros(loop_n, dtype=np.float32)
    pulse = heartbeat_pulse(hz_of("C1"), 1.2, attack_s=0.004, decay_s=0.55) * 0.55
    n_beats = int(LOOP_S / BEAT_S)
    for beat in range(n_beats):
        if beat % 2 != 0:
            continue
        start = int(beat * BEAT_S * SR)
        end = min(start + len(pulse), loop_n)
        heart[start:end] += pulse[: end - start]

    mono = bass_pad + upper + heart

    # Slow phrase-level swell (very subtle — the boss is breathing).
    t = np.arange(loop_n) / SR
    swell = 0.88 + 0.12 * np.sin(2 * np.pi * t / PHRASE_S - np.pi / 2)
    mono *= swell

    # Global edges
    attack_n = int(0.4 * SR)
    release_n = int(1.0 * SR)
    mono[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    mono[-release_n:] *= np.linspace(1, 0, release_n, dtype=np.float32) ** 1.2

    # Stereo: instead of an L/R time delay (which causes phase inversion at
    # the heartbeat's sub-bass frequencies — verified by stereo_correlation
    # = -0.30 in deepinspect), build a slightly detuned twin pad on the right
    # channel. The mono sum stays positive, and the perceived width comes
    # from the chorus-like beating between the two voices.
    bass_pad_r = sine_pad(
        [hz_of("C2") * 2 ** (5 / 1200), hz_of("G2") * 2 ** (5 / 1200)],
        [0.20, 0.16],
        LOOP_S,
    )
    upper_r = np.zeros(loop_n, dtype=np.float32)
    for i, key in enumerate(phrase_order):
        detuned = [f * 2 ** (5 / 1200) for f in upper_voicings[key]]
        seg = sine_pad(detuned, upper_amps[key], PHRASE_S)
        start = i * phrase_n
        upper_r[start:start + phrase_n] = seg
    for i in range(len(phrase_order)):
        boundary = i * phrase_n
        if boundary == 0 or boundary >= loop_n:
            continue
        a = max(0, boundary - xfade_n)
        b = min(loop_n, boundary + xfade_n)
        n = b - a
        ramp = np.linspace(0, 1, n, dtype=np.float32)
        ramp = 0.5 * (1 - np.cos(np.pi * ramp))
        pre = upper_r[a:boundary].copy()
        post = upper_r[boundary:b].copy()
        upper_r[a:boundary] = pre * (1 - ramp[: boundary - a])
        upper_r[boundary:b] = post * ramp[boundary - a :]
    # Heartbeat stays mono (sub-bass is non-directional; L/R-different sub
    # voices just confuse the mix).
    mono_r = bass_pad_r + upper_r + heart
    mono_r *= swell
    mono_r[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    mono_r[-release_n:] *= np.linspace(1, 0, release_n, dtype=np.float32) ** 1.2

    l = mono
    r = mono_r

    peak = max(float(np.max(np.abs(l))), float(np.max(np.abs(r))))
    if peak > 0:
        g = (10 ** (-12 / 20)) / peak
        l = l * g
        r = r * g

    return np.stack([l, r], axis=1)


# --- Layer 2: melodic — rising marcato brass riff -------------------------

def build_crucible_melodic_events():
    """Brass section (GM 61). Per-phrase identity is the climactic structure.

    A / A' phrases keep the stabbing 6-note minor-pentatonic hook (the boss
    pressing forward). Phrase B *opens up* — the dense stab pattern thins out
    after beat 2 and the brass holds a B4 then D5 across the remaining beats
    so the Cmaj7 colour can actually ring instead of getting buried in stabs.
    Phrase A' (resolve) is much softer AND drops the second-hook repeat
    entirely so the last 8 beats of the loop are mostly silent — the seam
    lands on decay rather than on a hard cutoff.

    Per phrase (16 beats), shapes:
      A   : 6 stabs in beats 0-7 (the hook), repeated beats 8-15
      A'  : same shape, peak climbs one step higher
      B   : 3 stabs in beats 0-2, then held B4 (3 beats) + held D5 (2 beats);
            repeated in beats 8-15 with the same opening-up shape
      A'  : 6 stabs in beats 0-7 at low velocity (the resolve), NO repeat —
            beats 8-15 are silent. Tail of the loop is genuinely a settle.
    """
    phrase_riffs = {
        "A": [
            (0.0,  0.5, "G3",  90),
            (1.0,  0.6, "Eb4", 96),
            (1.75, 0.5, "G4",  92),
            (3.0,  0.6, "Bb4", 100),
            (4.0,  0.6, "G4",  88),
            (5.5,  1.5, "Eb4", 84),
        ],
        "A1": [
            (0.0,  0.5, "G3",  92),
            (1.0,  0.6, "Eb4", 96),
            (1.75, 0.5, "G4",  92),
            (3.0,  0.6, "Bb4", 102),
            (4.0,  0.6, "C5",  104),
            (5.5,  1.5, "G4",  86),
        ],
        "B": [
            # Opens like A — three driven stabs into beat 2.
            (0.0,  0.5, "G3",  96),
            (1.0,  0.6, "E4",  102),   # major 3rd
            (1.75, 0.5, "G4",  98),
            # Then THE LIFT: held B4 (3 beats) + held D5 (2 beats). The
            # held maj7 colour rings out instead of being buried under
            # stabbing surround tones, fixing the analysis finding that B
            # phrase was 97.6% chord-similar to A1.
            (3.0,  3.0, "B4",  108),   # major 7 — held, climax
            (6.0,  2.0, "D5",  100),   # 9 — held, lifts and resolves
        ],
        "A2": [
            # The resolve. Same 6-note hook shape, but ALL velocities drop
            # ~30 from A (mp instead of mf-f) so the listener feels the
            # phrase audibly winding down.
            (0.0,  0.5, "G3",  60),
            (1.0,  0.6, "Eb4", 64),
            (1.75, 0.5, "G4",  60),
            (3.0,  0.6, "Bb4", 66),
            (4.0,  0.6, "G4",  58),
            (5.5,  2.0, "Eb4", 54),    # final tail — held 2 beats, soft
        ],
    }
    phrase_order = ["A", "A1", "B", "A2"]
    events = []
    for i, key in enumerate(phrase_order):
        phrase_beat_offset = i * 16
        riff = phrase_riffs[key]
        # Phrases A / A1 / B play the 8-beat hook twice. Phrase A2 plays it
        # ONCE — the second 8 beats of A2 are silent so the loop's last 4
        # seconds decay into stillness before the next A-phrase downbeat.
        repeat_offsets = (0.0,) if key == "A2" else (0.0, 8.0)
        for repeat_offset in repeat_offsets:
            for b, d, pitch, vel in riff:
                adjusted_vel = vel - (4 if repeat_offset == 8.0 else 0)
                events.append((phrase_beat_offset + repeat_offset + b, d, 0,
                              midi_note(pitch), adjusted_vel))
    return events


# --- Layer 3: heroic — French horn sustains + timpani downbeat ------------

def build_crucible_horn_events():
    """French horn (GM 60). Sustained call-and-response over the brass riff.

    Each phrase plays a long-tone counter-line that holds notes while the
    brass riff stabs in the gaps. The horn's notes are placed in the rests
    of the marcato brass so they interlock rather than collide.

    Phrase shape (16 beats):
      A  : .. C5 (held 6 beats) .. Eb5 (held 5 beats) ..
      A' : .. C5 (6) .. G5 (5) ..   (climbs higher on the call)
      B  : .. C5 (6) .. B4 (5) ..   (Cmaj7 — settles on the maj7)
      A' : .. C5 (6) .. Eb5 (5) ..  (returns to minor)
    """
    phrase_riffs = {
        "A":  [(2.0, 5.5, "C5", 85), (8.5, 5.0, "Eb5", 88)],
        "A1": [(2.0, 5.5, "C5", 88), (8.5, 5.0, "G5",  92)],
        "B":  [(2.0, 5.5, "C5", 90), (8.5, 5.0, "B4",  84)],
        "A2": [(2.0, 5.5, "C5", 85), (8.5, 5.0, "Eb5", 86)],
    }
    phrase_order = ["A", "A1", "B", "A2"]
    events = []
    for i, key in enumerate(phrase_order):
        phrase_beat_offset = i * 16
        for b, d, pitch, vel in phrase_riffs[key]:
            events.append((phrase_beat_offset + b, d, 0, midi_note(pitch), vel))
    return events


def build_crucible_timp_events():
    """Timpani (GM 47). Marcato strikes at phrase transitions + downbeat
    accents. Tuned to C2 / G2 so the strikes reinforce the bass anchor
    without introducing a new pitch.

    Hits per phrase:
      beat 0  : C2 (downbeat — phrase opens)
      beat 8  : G2 (mid-phrase — the half-bar lift)
      beat 14 : C2-roll (the buildup into the next phrase)
    """
    phrase_order = ["A", "A1", "B", "A2"]
    events = []
    # Channel 1 — keeps the horn (channel 0) GM 60 separate.
    for i, _ in enumerate(phrase_order):
        phrase_beat_offset = i * 16
        events.append((phrase_beat_offset + 0.0,  1.2, 1, midi_note("C2"), 110))
        events.append((phrase_beat_offset + 8.0,  1.0, 1, midi_note("G2"),  92))
        # Tail roll into the next phrase — 4 fast strikes at beat 14
        for k in range(4):
            events.append((phrase_beat_offset + 14.0 + k * 0.5, 0.45, 1,
                          midi_note("C2"), 80 + k * 6))
    return events


def main():
    # --- Ambient: procedural ---
    print("rendering crucible-sb ambient (sine pad + heartbeat sub)…")
    ambient = crucible_ambient_stereo()
    a_out = OUT / "crucible-sb-ambient.wav"
    sf.write(str(a_out), ambient, SR, subtype="PCM_16")
    print(f"  wrote {a_out}  duration {ambient.shape[0]/SR:.2f}s")

    # --- Melodic: FluidSynth brass section (GM 61) ---
    print("rendering crucible-sb melodic (FluidSynth brass section)…")
    melodic_midi = build_stem(build_crucible_melodic_events(), programs={0: 61})
    m_out = OUT / "crucible-sb-melodic.wav"
    render_midi(melodic_midi, m_out, gain=0.65)
    print(f"  wrote {m_out}")

    # --- Layer 3: FluidSynth French horn (ch 0, GM 60) + Timpani (ch 1, GM 47) ---
    print("rendering crucible-sb layer3 (FluidSynth horn + timpani)…")
    horn_events = build_crucible_horn_events()
    timp_events = build_crucible_timp_events()
    layer3_midi = build_stem(horn_events + timp_events,
                              programs={0: 60, 1: 47})
    l_out = OUT / "crucible-sb-layer3.wav"
    render_midi(layer3_midi, l_out, gain=0.65)
    print(f"  wrote {l_out}")


if __name__ == "__main__":
    main()
