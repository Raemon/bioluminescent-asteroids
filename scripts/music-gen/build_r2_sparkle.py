"""Round-2 12x sparkle layer (the 3rd tier above ambient + melodic).

Triggered at combo >= 12. Must feel like a *click into completeness* rather
than a new melody — sparse chimes outlining the chord-tone of each phrase,
optionally with a thin air-band wash. Sits in the 1–8 kHz register,
nowhere near the bass danger zone in 60–500 Hz.

Same 32-second loop = 4 phrases × 4 bars at 120 BPM as the other stems. The
chord-tones below mirror the build_r2 ambient pad's voicings exactly so the
sparkle harmonically resolves with the pad at every phrase boundary.

Two variations:
  musicbox-sb-sparkle  glockenspiel chimes only (program 9). Clean, dry-ish, sox
                 hall reverb 50/80/90 in post. Single-channel timbre.
  cinematic-el-sparkle  celesta chimes (program 8) + halo-pad sustained 5th (program
                 101) for a wash. Two channels. Used as the bright companion
                 to the EL strings/piano which sit dark.

Both are rendered via FluidSynth then post-processed by process_r2_sparkle.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_v3 import build_stem, render_midi, midi_note

OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

BPM = 120
BEAT_S = 60.0 / BPM         # 0.5
MEASURE_S = BEAT_S * 4      # 2.0
PHRASE_S = MEASURE_S * 4    # 8.0
LOOP_S = PHRASE_S * 4       # 32.0
# beats per phrase = 16, beats per loop = 64


# Per-phrase chime pitches. Each tuple is (beat_offset_within_phrase,
# duration_beats, pitch, velocity). Velocities kept gentle (45–72) so the
# chimes don't poke too brightly. Phrases mirror the build_r2 ambient pad:
#   A  : Cmaj + E (open fifth + maj 3rd top)
#   A' : Cmin + Eb (minor 3rd)
#   B  : Cmaj7 + B (the 9th adds longing)
#   A' : Cmin + Eb (resolve)
#
# The four phrases together outline a "ladder up, peak in B, fall and rest"
# arc. Phrase 4 ends with silence on the last 4 beats so the loop seam lands
# in air — no chime ringing across the seam.
PHRASE_CHIMES = {
    "A":  [(0.0,  4.0, "C6",  60),
           (4.0,  4.0, "G5",  55),
           (8.0,  4.0, "E6",  65),
           (12.0, 4.0, "G5",  50)],
    "A1": [(0.0,  4.0, "C6",  58),
           (4.0,  4.0, "G5",  52),
           (8.0,  4.0, "Eb6", 62),
           (12.0, 4.0, "G5",  48)],
    "B":  [(0.0,  4.0, "C6",  60),
           (4.0,  4.0, "B5",  58),
           (8.0,  4.0, "D6",  68),  # the 9th — peak velocity
           (12.0, 4.0, "E6",  62)],
    "A2": [(0.0,  4.0, "Eb6", 56),
           (4.0,  4.0, "G5",  50),
           (8.0,  4.0, "C6",  52)],
           # last 4 beats intentionally silent — breath before loop seam
}

PHRASE_ORDER = ["A", "A1", "B", "A2"]


def build_chime_events(channel: int) -> list:
    """Flatten the per-phrase chimes into absolute (beat, dur, ch, midi, vel)."""
    events = []
    for i, key in enumerate(PHRASE_ORDER):
        phrase_beat_offset = i * 16   # 4 measures × 4 beats per phrase
        for off, dur, pitch, vel in PHRASE_CHIMES[key]:
            events.append((phrase_beat_offset + off, dur,
                           channel, midi_note(pitch), vel))
    return events


def build_wash_events(channel: int) -> list:
    """Sustained C+G open fifth held the entire 32-second loop, low velocity.
    Used by the cinematic-el-sparkle variation as a halo-pad air-band wash under
    the celesta chimes. Two voices: G5 (the fifth) + C6. Phrase B briefly
    adds B5 to colour with the maj7."""
    events = [
        (0.0, 64.0, channel, midi_note("G5"), 28),  # whole loop
        (0.0, 64.0, channel, midi_note("C6"), 26),
        # B colour only during phrase B (beats 32–48)
        (32.0, 16.0, channel, midi_note("B5"), 24),
    ]
    return events


def main():
    # --- musicbox-sb-sparkle: glockenspiel only ---
    sb_events = build_chime_events(channel=0)
    sb_midi = build_stem(sb_events, programs={0: 9})  # GM 9 = Glockenspiel
    sb_out = OUT / "r2-sparkle-sb.wav"
    render_midi(sb_midi, sb_out, gain=0.75)
    print(f"wrote {sb_out}")

    # --- cinematic-el-sparkle: celesta chimes + halo-pad wash ---
    chime_events = build_chime_events(channel=0)
    wash_events = build_wash_events(channel=1)
    el_events = chime_events + wash_events
    # GM 8 = Celesta (bright bell), GM 101 = FX 6 Goblins / FX 5 Brightness;
    # but Pad 7 (program 100 = FX 5 'brightness') is too edgy. Try 101 first
    # then fall back to 91 (Pad 4 / choir) if too harsh — the choice mostly
    # affects the wash texture.
    el_midi = build_stem(el_events, programs={0: 8, 1: 101})
    el_out = OUT / "r2-sparkle-el.wav"
    render_midi(el_midi, el_out, gain=0.65)
    print(f"wrote {el_out}")


if __name__ == "__main__":
    main()
