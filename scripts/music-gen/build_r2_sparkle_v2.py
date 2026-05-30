"""Round-2 sparkle layer v2 — 16th-note arpeggio rework.

Replaces the original r2-{el,sb}-sparkle.mp3 (sparse chimes, 4 onsets/phrase)
with driving 16th-note ostinatos that pay off the 12x combo's doubled bullet
cadence. At 12x the player is firing on every 8th note; the sparkle layer
should give them a corresponding *rhythmic* payoff, not a decorative twinkle.

Density target: 12 of 16 sixteenth-note slots per measure get a note (so the
arp breathes — every 4th slot is a rest, landing on weak partials). 16 bars =
~192 onsets, vs the v1 sparkle's 16 onsets. Roughly a 12x increase.

Two variations (kept from v1 — same harmonic plan, same upper-voice melody
across phrases; only the rhythm + timbre change):

  r2-el-sparkle  Synth-arp ostinato on GM 88 (New Age Pad — bell attack +
                 short sustain, reads as cinematic-synthwave arp). Halo-pad
                 wash kept underneath (GM 101) for atmospheric depth so the
                 arp doesn't sound dry against EL's cinematic ambient.

  r2-sb-sparkle  Mandolin tremolo / fast-pluck on GM 25 (Steel String Guitar)
                 driven at 16th-note speed — the "fast-pluck FluidSynth
                 ostinato" alternative to glockenspiel chimes. No wash; the
                 r2-sb ambient is already a warm sine pad providing depth.

Phrase harmony mirrors the v1 sparkle + the build_r2 ambient pad voicing:
  A   Cmaj + E top
  A'  Cmin + Eb top
  B   Cmaj7 + B + D (the 9th — peak phrase)
  A'' Cmin + Eb resolve

Outputs land in raw/r2-sparkle-{el,sb}-v2.wav. Post-processed via
process_r2_sparkle.py (which gets a small tweak to read v2 inputs).
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
BEAT_S = 60.0 / BPM          # 0.5
SIXTEENTH = 0.25             # in beats — 16th-note
MEASURE_BEATS = 4
PHRASE_BEATS = MEASURE_BEATS * 4   # 16 beats per phrase
LOOP_BEATS = PHRASE_BEATS * 4      # 64 beats per loop


# Per-phrase pitch palettes. Each phrase walks an 8-note arp pattern that
# repeats every 2 beats (1 measure = 4 beats = 2 reps; 4 measures = 8 reps;
# 4 phrases = 32 reps across the loop). Rest slots intentionally on the 4th,
# 8th, 12th, 16th sixteenth (the weak partials) so the arp breathes.
#
# Pattern index: 0 1 2 3 4 5 6 7   (8 sixteenths per arp cycle = 2 beats)
# Rests on indices: 3, 7
PHRASE_ARPS = {
    # A — Cmaj + E top.  Notes outline C5-G5-E5-G5 with octave colour.
    "A":  ["C5", "G5", "E5", None, "G5", "C6", "E5", None],
    # A' — Cmin + Eb. Same shape but flatten the 3rd.
    "A1": ["C5", "G5", "Eb5", None, "G5", "C6", "Eb5", None],
    # B — Cmaj7 + B + D (9th).  Peak phrase: brighter, walks higher.
    "B":  ["C5", "G5", "B5", None, "D6", "C6", "B5", None],
    # A'' — Cmin + Eb resolve, descending.
    "A2": ["Eb5", "G5", "C5", None, "G5", "Eb5", "C5", None],
}

PHRASE_ORDER = ["A", "A1", "B", "A2"]

# Each 8-note cycle = 2 beats. A measure has 2 cycles. A phrase has 4
# measures = 8 cycles. A loop has 4 phrases = 32 cycles = 256 sixteenth
# slots. With rests on 2 of 8 slots, we get 32 * 6 = 192 onsets / loop.


def build_arp_events(channel: int, vel_base: int, vel_peak_phrase: int = 2,
                     duration_sixteenths: float = 0.95) -> list:
    """Flatten the per-phrase arp into absolute (beat, dur, ch, midi, vel).

    vel_base       Base velocity for non-peak phrases (A, A', A'').
    vel_peak_phrase  Index of the peak phrase (B) where velocities lift +12.
    duration_sixteenths  Note length, in sixteenths. 0.95 = ~94% of slot,
                         leaving a small gap so adjacent notes don't blur.

    Velocity contour within an arp cycle (8 sixteenths): the downbeat (index
    0) is loudest; index 4 (mid-cycle) is moderately strong; off-beats are
    softer. Plus phrase B lifts +12 across the whole phrase.
    """
    # In-cycle velocity offsets: index 0=+0, 1=-8, 2=-4, 3=rest, 4=-2,
    # 5=-8, 6=-4, 7=rest. Downbeat-strong, off-beat-soft.
    in_cycle_offsets = [0, -8, -4, 0, -2, -8, -4, 0]

    dur_beats = duration_sixteenths * SIXTEENTH

    events = []
    for phrase_idx, key in enumerate(PHRASE_ORDER):
        phrase_beat_offset = phrase_idx * PHRASE_BEATS
        phrase_vel_lift = 12 if phrase_idx == vel_peak_phrase else 0
        pattern = PHRASE_ARPS[key]
        # 8 cycles per phrase (4 measures × 2 cycles/measure)
        for cycle in range(8):
            cycle_beat_offset = phrase_beat_offset + cycle * (8 * SIXTEENTH)
            for slot, pitch in enumerate(pattern):
                if pitch is None:
                    continue
                slot_beat = cycle_beat_offset + slot * SIXTEENTH
                vel = vel_base + in_cycle_offsets[slot] + phrase_vel_lift
                vel = max(20, min(110, vel))
                events.append((slot_beat, dur_beats, channel,
                               midi_note(pitch), vel))
    return events


def build_wash_events(channel: int) -> list:
    """Sustained C+G open fifth held the entire 32-second loop, low velocity.
    Used only by the r2-el-sparkle variation to give the arp atmospheric
    depth (matches v1's halo-pad wash strategy). Phrase B briefly adds B5
    for the maj7 colour."""
    return [
        (0.0,  64.0, channel, midi_note("G5"), 26),
        (0.0,  64.0, channel, midi_note("C6"), 24),
        (32.0, 16.0, channel, midi_note("B5"), 22),   # B colour
    ]


def main():
    # --- r2-el-sparkle v2: synth arp + halo-pad wash ---
    # GM 88 = Pad 1 (New Age) — bell attack + short sustain. Sits at "synth
    # arpeggio" rather than "bell chime". Pairs cleanly with EL's cinematic
    # strings + felt piano.
    # GM 101 = FX 6 (Goblins) — same wash patch v1 used.
    el_arp = build_arp_events(channel=0, vel_base=68,
                              vel_peak_phrase=2, duration_sixteenths=0.95)
    el_wash = build_wash_events(channel=1)
    el_midi = build_stem(el_arp + el_wash, programs={0: 88, 1: 101})
    el_out = OUT / "r2-sparkle-el-v2.wav"
    render_midi(el_midi, el_out, gain=0.7)
    print(f"wrote {el_out}  ({len(el_arp)} arp + {len(el_wash)} wash events)")

    # --- r2-sb-sparkle v2: mandolin/fast-pluck ostinato ---
    # GM 25 = Steel String Guitar (warm fast pluck — readable as a tremolo
    # mandolin when driven at 16th-note speed). Drier voicing; no wash
    # because the r2-sb ambient already provides warm-sine atmosphere.
    # Slightly higher vel_base than EL since the SB ambient/melodic stack
    # is also drier and we want the sparkle to cut through.
    sb_arp = build_arp_events(channel=0, vel_base=72,
                              vel_peak_phrase=2, duration_sixteenths=0.85)
    sb_midi = build_stem(sb_arp, programs={0: 25})
    sb_out = OUT / "r2-sparkle-sb-v2.wav"
    render_midi(sb_midi, sb_out, gain=0.75)
    print(f"wrote {sb_out}  ({len(sb_arp)} pluck events)")


if __name__ == "__main__":
    main()
