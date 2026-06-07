"""Replacement flagship-sb-melodic: smooth synth (GM 82 Calliope) with a new
melodic line that breathes in the gaps left by the sparkle cascade.

Constraints inherited from flagship-sb:
  - 32s loop, 4 phrases x 4 bars at 120 BPM
  - Phrase order A / A' / B / A2 (B = Cmaj7 colour, others minor-3rd)
  - C-pedal harmony, sits above the arp (above G4) and below sparkle C6 peak

Why a different melody (not the saw lead riff):
  The previous take fought the sparkle cascade on beats 1, 5, 9, 13 of each
  phrase. This take places long sustained notes in the 3-5, 7-9, 11-13, 15-16
  windows so the cascade has air and the melody has space.

Instrument: GM 82 = Lead 3 (Calliope) — triangle-based smooth synth, no saw
bite. Renders with the same reverb-CC defaults build_stem sets (depth 80) so
it has air without sox post-processing piling on more wash.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_v3 import build_stem, render_midi, midi_note

OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)


def build_melodic_v2_events():
    """New melodic line. Each phrase = 16 beats. Long sustained notes that
    bloom in the windows between sparkle cascades (cascades occupy beats
    1.0-3.0, 5.0-7.0, 9.0-11.0, 13.0-15.0 within each phrase).

    The line traces an arc: A introduces, A' answers descending, B peaks on
    the Cmaj7 B/A colour, A2 resolves to root.

    (beat_offset_in_phrase, dur_beats, pitch, velocity)
    """
    phrase_lines = {
        # A: introduce — rising line through Cm chord tones
        "A": [
            (3.0,  1.5, "G4",  74),   # gap after first cascade
            (4.5,  0.5, "Bb4", 70),
            (7.0,  2.0, "C5",  82),   # gap after second cascade — held
            (11.0, 2.0, "Eb5", 86),   # gap after third — climb
            (15.0, 1.0, "D5",  78),   # tail — leading tone back to C
        ],
        # A1: answer — descend back down
        "A1": [
            (3.0,  2.0, "C5",  78),
            (7.0,  2.0, "Eb5", 84),
            (11.0, 1.5, "D5",  80),
            (12.5, 0.5, "C5",  72),
            (15.0, 1.0, "Bb4", 70),   # tail
        ],
        # B: peak — Cmaj7 colour, climbs to B5 (the colour tone)
        "B": [
            (3.0,  1.5, "A4",  80),
            (4.5,  0.5, "C5",  76),
            (7.0,  2.0, "E5",  88),   # the major-third lift
            (11.0, 2.0, "B5",  92),   # peak — the maj7
            (15.0, 1.0, "A5",  82),   # tail down off the peak
        ],
        # A2: resolve — final descent settling on C
        "A2": [
            (3.0,  2.0, "G4",  76),
            (7.0,  2.0, "Bb4", 80),
            (11.0, 1.5, "G4",  72),
            (12.5, 0.5, "Eb4", 68),
            (15.0, 1.0, "C4",  64),   # land on root
        ],
    }
    phrase_order = ["A", "A1", "B", "A2"]
    events = []
    for i, key in enumerate(phrase_order):
        offset = i * 16
        for b, d, pitch, vel in phrase_lines[key]:
            events.append((offset + b, d, 0, midi_note(pitch), vel))
    return events


def main():
    print("rendering flagship-sb-melodic v2 (FluidSynth GM 82 calliope)...")
    midi = build_stem(build_melodic_v2_events(), programs={0: 82})
    out = OUT / "flagship-sb-melodic.wav"
    render_midi(midi, out, gain=0.60)
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
