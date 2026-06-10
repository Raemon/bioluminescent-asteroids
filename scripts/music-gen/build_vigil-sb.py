"""vigil-sb: the level-10 boss track, built as the *climax* of the levels
1–9 halo music rather than a genre change.

Design intent. crucible-sb (the original boss track, now retired) swapped the
warm halo palette for orchestral brass + French horn + timpani — the wrong
genre. knell-sb (kept, earmarked for the level-20 boss) is a funeral-bell
death knell. vigil-sb instead keeps the *exact halo palette* the player has
heard for nine levels — procedural detuned-sine C-pedal pad + FluidSynth felt
piano + a high glassy chime reward — and turns it climactic-and-scary through
tension *inside* that familiar warmth, not by replacing the instruments:

  - same C+G open-fifth pedal as every halo track, so it still "belongs"
  - upper-voice drift pulled darker (minor third leaned on; the hopeful Cmaj7
    "B" lift the halo pool uses is replaced by a Db(♭9) + F# tritone shadow
    that swells and pulls back — one semitone of dissonance reads as "scary"
    while everything else stays the same instrument family)
  - forward motion the static halo pads lack: the felt piano plays an
    insistent rising minor-pentatonic arpeggio that grows denser per phrase,
    and a sub heartbeat that DOUBLES from quarter-notes to eighth-notes in the
    final phrase — the climax tightening, not a new sound

C MINOR (like the boss tracks before it), C+G open fifth held in the bass so
the bassteroid C-major drone bed doesn't fight (the Eb minor third and the Db
flat-9 are registered above the bass voicings).

Loop: 32 s = 4 phrases × 4 bars at 120 BPM. Phrase shape A-A'-B-A'':
  A   : Cm                 (Eb minor third — the watch begins)
  A'  : Cm, darker         (Eb + a low Ab tension tone underneath)
  B   : C + Db(♭9) + F#    (the scare — dissonant shadow swells, then recedes)
  A'' : Cm, tightening     (Eb minor third; heartbeat doubles to eighths)

Layer 1 (ambient, 4x): warm minor C-pedal pad (the r2/musicbox sine family)
  + an accelerating C1 sub heartbeat. No melody.
Layer 2 (melodic, 6x): felt piano (GM 0) rising minor-pentatonic arpeggio,
  denser each phrase. The familiar halo timbre, now urgent.
Layer 3 (12x reward): glassy celesta (GM 9) high countermelody on tense scale
  tones (anxious-beautiful sparkle) + a felt-piano low-octave toll on phrase
  downbeats for weight (stays in the piano family — NOT a bell).
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


# --- Layer 1: ambient — warm minor C-pedal pad + accelerating heartbeat -----

def detuned_sines(freq: float, n: int, amp: float, harmonic_mix: float) -> np.ndarray:
    """Three detuned sines for gentle chorus, with optional 2nd+3rd harmonic
    for upper-voice presence. Same voicing strategy as the halo pool's r2 pad
    so vigil sits in the same timbral world."""
    t = np.arange(n) / SR
    out = np.zeros(n, dtype=np.float32)
    for c in (-4, 0, 4):
        f = freq * (2 ** (c / 1200))
        v = np.sin(2 * np.pi * f * t).astype(np.float32)
        if harmonic_mix > 0:
            v += harmonic_mix * 0.5 * np.sin(2 * np.pi * 2 * f * t).astype(np.float32)
            v += harmonic_mix * 0.25 * np.sin(2 * np.pi * 3 * f * t).astype(np.float32)
        out += v
    return (out / 3 * amp).astype(np.float32)


def build_phrase_pad(voicing_hz: list[float], amps: list[float], phrase_n: int) -> np.ndarray:
    out = np.zeros(phrase_n, dtype=np.float32)
    for f, a in zip(voicing_hz, amps):
        harm = 0.0 if f < 250 else 0.3 if f < 500 else 0.5
        out += detuned_sines(f, phrase_n, a, harm)
    return out


def heartbeat_pulse(freq: float, dur_s: float, decay_s: float) -> np.ndarray:
    """Sharp-attack, long-decay sine pulse. The boss's heartbeat; sits below
    the bass register so it doesn't fight the C/G drone above it."""
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    out = np.sin(2 * np.pi * freq * t).astype(np.float32)
    env = np.exp(-t / decay_s).astype(np.float32)
    attack_n = max(1, int(0.004 * SR))
    env[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    return (out * env).astype(np.float32)


def vigil_pad_mono() -> np.ndarray:
    """Four phrases (A-A'-B-A''), crossfaded. Pad only — no heartbeat (the
    heartbeat is summed in mono later so the L/R pad delay can't phase-invert
    its sub-bass).

    Per-phrase upper voicing over the constant C2+G2 open fifth:
      A   : G3 + Eb4              (Cm, the minor third)
      A'  : G3 + Eb4 + Ab3        (Cm, a low Ab tension tone darkens it)
      B   : Db4 + F#4 + Eb4       (♭9 + tritone shadow — the scare)
      A'' : G3 + Eb4              (Cm — resolve; heartbeat doubles instead)
    """
    phrase_n = int(PHRASE_S * SR)
    loop_n = int(LOOP_S * SR)

    # C+G open fifth held the whole loop — the bass anchor shared with every
    # halo track.
    bass = build_phrase_pad([hz_of("C2"), hz_of("G2")], [0.22, 0.18], loop_n)

    phrase_order = ["A", "A1", "B", "A2"]
    upper_voicings = {
        "A":  [hz_of("G3"), hz_of("Eb4")],
        "A1": [hz_of("Ab3"), hz_of("G3"), hz_of("Eb4")],
        "B":  [hz_of("Db4"), hz_of("F#4"), hz_of("Eb4")],
        "A2": [hz_of("G3"), hz_of("Eb4")],
    }
    upper_amps = {
        "A":  [0.16, 0.16],
        "A1": [0.11, 0.16, 0.16],
        "B":  [0.13, 0.11, 0.14],
        "A2": [0.16, 0.16],
    }

    upper = np.zeros(loop_n, dtype=np.float32)
    for i, key in enumerate(phrase_order):
        seg = build_phrase_pad(upper_voicings[key], upper_amps[key], phrase_n)
        # Per-phrase breath swell: 0.7→1.0→0.7. The B phrase swells harder
        # (0.6→1.1) so the dissonant shadow rises and recedes like a threat
        # cresting rather than just sitting there.
        t_phrase = np.arange(phrase_n) / SR
        lfo = np.sin(np.pi * t_phrase / PHRASE_S)
        swell = (0.6 + 0.5 * lfo) if key == "B" else (0.7 + 0.3 * lfo)
        upper[i * phrase_n:(i + 1) * phrase_n] = (seg * swell).astype(np.float32)

    # Equal-power cosine crossfade at each phrase seam so voicing swaps don't
    # click.
    xfade = int(0.3 * SR)
    for b in range(1, len(phrase_order)):
        seam = b * phrase_n
        a0 = max(0, seam - xfade)
        b0 = min(loop_n, seam + xfade)
        n = b0 - a0
        ramp = np.linspace(0, 1, n, dtype=np.float32)
        fin = np.sin(0.5 * np.pi * ramp).astype(np.float32)
        fout = np.cos(0.5 * np.pi * ramp).astype(np.float32)
        left = upper[a0:seam].copy()
        right = upper[seam:b0].copy()
        upper[a0:seam] = left * fout[: seam - a0]
        upper[seam:b0] = right * fin[seam - a0:]

    pad = bass + upper
    return pad.astype(np.float32)


def vigil_heart_mono() -> np.ndarray:
    """C1 sub heartbeat. Quarter-notes (every beat) through phrases A/A'/B; in
    the final phrase (A'') it DOUBLES to eighth-notes — the climax tightening.
    Pulse decays in ~0.4s so eighths stay articulate. Kept mono so the pad's
    L/R delay can't phase-invert this sub-bass (crucible hit exactly that and
    measured stereo_correlation = -0.30 before isolating the sub)."""
    loop_n = int(LOOP_S * SR)
    heart = np.zeros(loop_n, dtype=np.float32)
    # C2 (~65 Hz), not C1 — keeps the thump in the bass band instead of dumping
    # 60% of the stem into 20–60 Hz sub where it both swamps the pad and
    # collides with the bass kit's own sub. Amplitude trimmed so the pad reads
    # as the bed and the heartbeat as an accent.
    pulse = heartbeat_pulse(hz_of("C2"), 1.0, decay_s=0.40) * 0.32
    n_beats = int(LOOP_S / BEAT_S)
    final_phrase_start_beat = 3 * int(PHRASE_S / BEAT_S)  # beat 48
    for beat in range(n_beats):
        hits = [0.0]
        if beat >= final_phrase_start_beat:
            hits.append(0.5)
        for off in hits:
            start = int((beat + off) * BEAT_S * SR)
            end = min(start + len(pulse), loop_n)
            if end > start:
                heart[start:end] += pulse[: end - start]
    return heart.astype(np.float32)


def vigil_ambient_stereo() -> np.ndarray:
    """Widen the pad with a ~15 ms L/R delay (same trick as the r2 halo pad),
    then sum the heartbeat in mono into both channels so its sub-bass stays
    phase-coherent. Global edge fades applied last."""
    pad = vigil_pad_mono()
    heart = vigil_heart_mono()
    loop_n = pad.shape[0]

    delay_n = int(0.015 * SR)
    l = pad.copy()
    r = np.concatenate([np.zeros(delay_n, dtype=np.float32), pad[:-delay_n]])
    l += heart
    r += heart

    attack_n = int(0.6 * SR)
    release_n = int(1.5 * SR)
    for ch in (l, r):
        ch[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
        ch[-release_n:] *= np.linspace(1, 0, release_n, dtype=np.float32) ** 1.3

    peak = max(float(np.max(np.abs(l))), float(np.max(np.abs(r))))
    if peak > 0:
        g = (10 ** (-12 / 20)) / peak
        l, r = l * g, r * g
    return np.stack([l, r], axis=1)


# --- Layer 2: melodic — felt-piano rising arpeggio, denser each phrase -------

def build_vigil_melodic_events():
    """Felt piano (GM 0). A rising C-minor-pentatonic arpeggio (C-Eb-G-Bb-C)
    that grows denser and more insistent across the four phrases — the climax
    building. This is the same felt-piano voice the halo pool uses; the boss
    energy comes from the rhythmic acceleration, not a new instrument.

    Phrase A   : sparse quarter-note climb            C4 Eb4 G4 Bb4
    Phrase A'  : eighth-note climb, reaches higher    + C5, repeats
    Phrase B   : the scare — line bends to the ♭9/tritone shadow (Db5, F#4)
                 over the dissonant pad, then a held high G5 cresting
    Phrase A'' : fastest — sixteenth-flecked descent resolving down to C4,
                 winding the loop back to the top
    """
    pent_up = ["C4", "Eb4", "G4", "Bb4", "C5"]

    events = []

    def add(beat0, notes, step, dur, vel_base, vel_step=2):
        for k, p in enumerate(notes):
            events.append((beat0 + k * step, dur, 0, midi_note(p),
                           min(110, vel_base + k * vel_step)))

    # Phrase A (beats 0–15): sparse quarter-note climb, twice.
    add(0.0, pent_up[:4], 1.0, 0.9, 66)
    add(8.0, pent_up[:4], 1.0, 0.9, 70)

    # Phrase A' (beats 16–31): eighth-note climb reaching C5, three runs.
    add(16.0, pent_up, 0.5, 0.45, 74)
    add(19.0, pent_up, 0.5, 0.45, 78)
    add(24.0, pent_up, 0.5, 0.45, 82)
    add(27.0, pent_up[::-1], 0.5, 0.45, 76)

    # Phrase B (beats 32–47): the scare. Bend the line onto the dissonant
    # shadow tones (Db5 ♭9, F#4 tritone) the pad is holding, then crest on a
    # held high G5.
    scare = ["G4", "Bb4", "Db5", "Bb4", "F#4", "G4"]
    add(32.0, scare, 0.5, 0.45, 80, vel_step=3)
    events.append((35.5, 2.5, 0, midi_note("G5"), 100))   # crest, held
    add(40.0, scare, 0.5, 0.45, 84, vel_step=3)
    events.append((43.5, 3.0, 0, midi_note("Bb5"), 96))   # higher crest, held

    # Phrase A'' (beats 48–63): fastest, a sixteenth-flecked descent resolving
    # down to C4 so the loop seam lands on the root.
    desc = ["C5", "Bb4", "G4", "Eb4", "C4"]
    add(48.0, desc, 0.5, 0.4, 88, vel_step=-2)
    add(51.0, desc, 0.5, 0.4, 84, vel_step=-2)
    # final sixteenth flurry into the root
    flurry = ["G4", "C5", "Bb4", "G4", "Eb4", "C4"]
    for k, p in enumerate(flurry):
        events.append((56.0 + k * 0.5, 0.45, 0, midi_note(p), 78 - k * 4))
    events.append((60.0, 3.5, 0, midi_note("C4"), 70))    # held root, settle

    return events


# --- Layer 3: glassy celesta countermelody + felt-piano toll ----------------

def build_vigil_celesta_events():
    """Celesta (GM 9, channel 0). High, glassy sparkle — the 12x reward — but
    voiced on tense scale tones (Eb, Bb, Db) so the reward is anxious-beautiful
    rather than triumphant. One short phrase per 8-bar section, placed in the
    felt piano's rests."""
    phrase_riffs = {
        # (beat, dur, pitch, vel) within the phrase's 16-beat window
        "A":  [(4.0, 1.0, "Eb5", 70), (6.0, 1.0, "G5", 74), (12.0, 2.0, "Bb5", 72)],
        "A1": [(4.0, 1.0, "G5", 74), (6.0, 1.0, "Bb5", 78), (12.0, 2.0, "C6", 76)],
        # B leans into the dissonance: Db6 (♭9 up high) glints over the scare.
        "B":  [(2.0, 1.0, "Bb5", 80), (4.0, 1.5, "Db6", 84), (10.0, 2.0, "C6", 78)],
        "A2": [(4.0, 1.0, "G5", 72), (8.0, 1.0, "Eb5", 70), (12.0, 2.5, "C6", 68)],
    }
    order = ["A", "A1", "B", "A2"]
    events = []
    for i, key in enumerate(order):
        base = i * 16
        for b, d, p, v in phrase_riffs[key]:
            events.append((base + b, d, 0, midi_note(p), v))
    return events


def build_vigil_toll_events():
    """Felt piano (GM 0, channel 1) low-octave toll on each phrase downbeat —
    weight and inevitability, kept in the piano family rather than a bell so
    the boss still sounds like the halo world, not a funeral. C2+C3 octave at
    phrase starts; the final phrase adds a mid-phrase toll as the climax
    tightens."""
    events = []
    order_starts = [0, 16, 32, 48]
    for i, base in enumerate(order_starts):
        vel = 78 if i != 2 else 88   # B-phrase toll hits harder (the scare)
        events.append((base + 0.0, 3.5, 1, midi_note("C2"), vel))
        events.append((base + 0.0, 3.5, 1, midi_note("C3"), vel - 6))
    # extra toll mid-final-phrase
    events.append((56.0, 3.0, 1, midi_note("C2"), 82))
    events.append((56.0, 3.0, 1, midi_note("C3"), 76))
    return events


def main():
    print("rendering vigil-sb ambient (sine pad + accelerating heartbeat)…")
    ambient = vigil_ambient_stereo()
    a_out = OUT / "vigil-sb-ambient.wav"
    sf.write(str(a_out), ambient, SR, subtype="PCM_16")
    print(f"  wrote {a_out}  duration {ambient.shape[0]/SR:.2f}s")

    print("rendering vigil-sb melodic (FluidSynth felt piano arpeggio)…")
    melodic_midi = build_stem(build_vigil_melodic_events(), programs={0: 0})
    m_out = OUT / "vigil-sb-melodic.wav"
    render_midi(melodic_midi, m_out, gain=0.7)
    print(f"  wrote {m_out}")

    print("rendering vigil-sb layer3 (celesta countermelody + felt-piano toll)…")
    celesta = build_vigil_celesta_events()
    toll = build_vigil_toll_events()
    layer3_midi = build_stem(celesta + toll, programs={0: 9, 1: 0})
    l_out = OUT / "vigil-sb-layer3.wav"
    render_midi(layer3_midi, l_out, gain=0.7)
    print(f"  wrote {l_out}")


if __name__ == "__main__":
    main()
