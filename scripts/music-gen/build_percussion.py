"""Build the per-variation percussion stems that replace the sparkle layer.

Three percussion stems (r2-sb, r3-el, r4-sb) + one exception:
  r2-el-percussion is actually a lonely solo violin (matches the r2-el
  cinematic-strings aesthetic; not a drum kit).

All loop 32s at 120 BPM = 4 phrases x 4 bars, sharing the downbeat at sample 0
so the layer stays phase-locked with the existing ambient + melodic stems.

Drum stems use MIDI channel 9 (GM drum channel — channel 10 in 1-indexed talk).
The build_stem() helper writes any (channel, note, vel) tuple to MIDI; we just
need to set channel=9 and pick the right percussion note numbers. We still send
a program-change for channel 9 so FluidSynth selects the right drum kit; the
GeneralUser-GS soundfont's drum kits live in bank 128 — fluidsynth will pick
the standard kit (program 0 = Standard Kit) when the GM-mode mapping is on,
which it is by default.

GM percussion note numbers used here:
   35 Acoustic Bass Drum     36 Bass Drum 1
   37 Side Stick             38 Acoustic Snare
   39 Hand Clap              40 Electric Snare
   42 Closed Hi-Hat          44 Pedal Hi-Hat
   46 Open Hi-Hat            49 Crash Cymbal 1
   51 Ride Cymbal 1          52 Chinese Cymbal

Phrase plan applies to every percussion variation:
  A   ground groove
  A'  same groove, lighter velocities
  B   peak phrase — open hat or extra accent
  A'  ground groove resolve

Outputs land in raw/{variation}-percussion.wav, post-processed by
process_percussion.py to land final mp3 + wav in processed/.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_v3 import build_stem, render_midi, midi_note   # MIDI helpers

OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

BPM = 120
BEAT = 1.0                              # in beats — quarter note
EIGHTH = 0.5
SIXTEENTH = 0.25
MEASURE_BEATS = 4
PHRASE_BEATS = MEASURE_BEATS * 4        # 16 beats per phrase
LOOP_BEATS = PHRASE_BEATS * 4           # 64 beats per loop

DRUM_CH = 9                             # GM drum channel (0-indexed)


# ── r2-sb percussion: warm-dry brushy kit ──────────────────────────────────
# Pairs with the r2-sb procedural sine pad + felt piano. The pad is warm and
# round, the piano sparse and held — drums must not poke. A soft kick on 1+3,
# brushed/side-stick rim on 2+4, and a quiet closed-hat 8th pulse. Phrase B
# briefly opens the hat for one bar of breath.
def build_r2_sb_events() -> list:
    events = []
    # Per-phrase velocity scale so the loop doesn't feel mechanical
    phrase_vel = [1.0, 0.85, 1.05, 0.85]    # A, A', B, A''
    for phrase_idx in range(4):
        phrase_start = phrase_idx * PHRASE_BEATS
        v = phrase_vel[phrase_idx]
        for measure in range(4):
            m_start = phrase_start + measure * MEASURE_BEATS
            # Kick on beats 1 and 3 — soft (vel ~62)
            events.append((m_start + 0, EIGHTH, DRUM_CH, 36, int(62 * v)))
            events.append((m_start + 2, EIGHTH, DRUM_CH, 36, int(58 * v)))
            # Side stick (37) on beats 2 and 4 — substitutes for snare, dryer
            events.append((m_start + 1, EIGHTH, DRUM_CH, 37, int(56 * v)))
            events.append((m_start + 3, EIGHTH, DRUM_CH, 37, int(56 * v)))
            # Closed hat 8ths on the "and" of every beat (off-beats) — quiet
            for beat in range(4):
                off = m_start + beat + 0.5
                events.append((off, EIGHTH, DRUM_CH, 42, int(36 * v)))
        # Phrase B: open hat once on the last "and-of-4" of measure 2 for lift
        if phrase_idx == 2:
            events.append((phrase_start + 2 * MEASURE_BEATS + 3.5, EIGHTH,
                           DRUM_CH, 46, int(48 * v)))
    # Final beat: skip a kick to leave breath before loop seam
    return events


# ── r3-el percussion: synthwave electronic kit ─────────────────────────────
# Pairs with the EL analog-synthwave Juno-pad + soft lead. Drum-machine feel:
# Linn-ish electronic kick on 1+3, electric snare on 2+4, 16th-note closed
# hats with off-beat ghost notes. Phrase B replaces beat 4 with an open-hat
# crash for the synthwave "drop" feel.
#
# GM's "Electronic Set" is in bank 0 program 24 (kit 25) of GS-mode kits;
# GeneralUser-GS lets us select it via a bank+program-change. Easier path:
# stay on the standard kit but use the "Electric Snare" (40) and a more
# clicky kick — sounds plenty electronic against the EL synthwave bed
# without needing to mess with bank-select sysex.
def build_r3_el_events() -> list:
    events = []
    phrase_vel = [1.0, 0.95, 1.1, 0.9]
    for phrase_idx in range(4):
        phrase_start = phrase_idx * PHRASE_BEATS
        v = phrase_vel[phrase_idx]
        for measure in range(4):
            m_start = phrase_start + measure * MEASURE_BEATS
            # Bass Drum 1 (36) — punchier than 35 — on beats 1 and 3
            events.append((m_start + 0, EIGHTH, DRUM_CH, 36, int(86 * v)))
            events.append((m_start + 2, EIGHTH, DRUM_CH, 36, int(80 * v)))
            # Electric Snare (40) on beats 2 and 4
            events.append((m_start + 1, EIGHTH, DRUM_CH, 40, int(78 * v)))
            events.append((m_start + 3, EIGHTH, DRUM_CH, 40, int(78 * v)))
            # 16th-note closed hat ostinato with velocity contour
            for s in range(16):
                slot = m_start + s * SIXTEENTH
                # Downbeat strong, off-beats softer, micro-beats softest
                if s % 4 == 0:
                    hv = 48
                elif s % 4 == 2:
                    hv = 38
                else:
                    hv = 28
                events.append((slot, SIXTEENTH, DRUM_CH, 42, int(hv * v)))
        # Phrase B (peak): open hat instead of last closed-hat 16th to mark lift
        if phrase_idx == 2:
            # Open hat on the and-of-4 of the final measure of phrase
            last_m_start = phrase_start + 3 * MEASURE_BEATS
            events.append((last_m_start + 3.5, EIGHTH, DRUM_CH, 46, int(56 * v)))
            # Crash on first downbeat of phrase 4 lives below (handled there)
    # Crash (49) on the first downbeat of phrase 4 (A'' resolve) — single hit
    # at the loop's "second half settles" boundary
    events.append((3 * PHRASE_BEATS, BEAT, DRUM_CH, 49, 70))
    return events


# ── r4-sb percussion: interlocked 16th-note kit ────────────────────────────
# Pairs with the r4-sb rhythmic flagship — pulsing arp + calliope melody. The
# arp already drives 16ths; drums should reinforce the pulse without doubling
# every 16th hit. Pattern: kick on 1 + 'a' of 3 (syncopated), snare on 2 + 4,
# closed hat 16ths with the same rest-slot map as the arp (rest on slots 3
# and 7 of each 8-slot cycle = 2-cycles-per-beat × 4 beats × 4 measures).
def build_r4_sb_events() -> list:
    events = []
    phrase_vel = [1.0, 0.9, 1.1, 0.9]
    for phrase_idx in range(4):
        phrase_start = phrase_idx * PHRASE_BEATS
        v = phrase_vel[phrase_idx]
        for measure in range(4):
            m_start = phrase_start + measure * MEASURE_BEATS
            # Kick on beat 1, syncopated on the 'a' (16th-4) of beat 2,
            # and on beat 3. Adds bounce without fighting the arp downbeats.
            events.append((m_start + 0,     EIGHTH, DRUM_CH, 36, int(82 * v)))
            events.append((m_start + 1.75,  SIXTEENTH, DRUM_CH, 36, int(60 * v)))
            events.append((m_start + 2,     EIGHTH, DRUM_CH, 36, int(74 * v)))
            # Snare on beats 2 and 4 (acoustic — 38)
            events.append((m_start + 1, EIGHTH, DRUM_CH, 38, int(74 * v)))
            events.append((m_start + 3, EIGHTH, DRUM_CH, 38, int(76 * v)))
            # Closed hat on 16ths with rests on slots 3 and 7 (matches arp gaps).
            # 8 cycles per measure? No — 16 slots = 4 beats * 4 sixteenths. Rest on
            # slots 3, 7, 11, 15 (the 4th sixteenth of each beat).
            for s in range(16):
                if s % 4 == 3:
                    continue   # rest — gives the same breath the arp does
                slot = m_start + s * SIXTEENTH
                if s % 4 == 0:
                    hv = 44
                elif s % 4 == 2:
                    hv = 34
                else:
                    hv = 26
                events.append((slot, SIXTEENTH, DRUM_CH, 42, int(hv * v)))
        # Phrase B: ride cymbal accent on each downbeat instead of hat,
        # to mark the peak — readable as "the chorus drop".
        if phrase_idx == 2:
            for measure in range(4):
                m_start = phrase_start + measure * MEASURE_BEATS
                events.append((m_start + 0, BEAT, DRUM_CH, 51, int(60 * v)))
    return events


# ── r2-el lonely violin (NOT percussion) ───────────────────────────────────
# Single-line solo violin (GM 40 = Violin). Sparse, melancholy, sits on the
# same channel as a melodic instrument. Designed to match the r2-el cinematic
# strings + felt piano aesthetic — feels like a fourth voice in the string
# section but with the bow held alone.
#
# Phrase structure mirrors the r2-el ambient/melodic harmonic plan:
#   A   long-held G4 (open fifth)         soft entrance
#   A'  brief F-Eb4 sigh, then silence    breath
#   B   slow E5-D5-C5 descent             peak phrase — longing
#   A'  held E4 resolution                quiet settle
#
# All within a single-voice register so it never harmonizes with itself.
# Channel 1 chosen arbitrarily for "non-drum melodic"; program 40 = Violin.
VIOLIN_CH = 1
VIOLIN_PROGRAM = 40

def build_r2_el_violin_events() -> list:
    # (beat, dur_beats, ch, midi_note, velocity)
    notes = [
        # Phrase A (0–16): held G4 — long, slow swell via two stacked attacks
        (0.0,  8.0,  "G4", 56),
        (8.0,  6.0,  "G4", 60),
        # Phrase A' (16–32): sigh F-Eb-D, then rest
        (18.0, 2.0,  "F4", 52),
        (20.5, 2.5,  "Eb4", 48),
        # Phrase B (32–48): slow E5→D5→C5 descent (peak phrase)
        (32.0, 6.0,  "E5", 64),
        (38.5, 4.0,  "D5", 60),
        (43.0, 4.0,  "C5", 56),
        # Phrase A'' (48–64): quiet E4 resolution
        (50.0, 10.0, "E4", 48),
    ]
    return [(b, d, VIOLIN_CH, midi_note(p), v) for b, d, p, v in notes]


def render_drum_stem(events: list, out_wav: Path, gain: float = 0.7) -> None:
    # programs={DRUM_CH: 0} sends a program-change 0 on the drum channel.
    # FluidSynth in GM-mode treats channel 9 as the drum channel regardless
    # of the program byte, so this just selects the Standard Kit.
    midi = build_stem(events, programs={DRUM_CH: 0})
    render_midi(midi, out_wav, gain=gain)


def render_violin_stem(events: list, out_wav: Path, gain: float = 0.7) -> None:
    midi = build_stem(events, programs={VIOLIN_CH: VIOLIN_PROGRAM})
    render_midi(midi, out_wav, gain=gain)


def main():
    out_r2sb = OUT / "r2-sb-percussion.wav"
    render_drum_stem(build_r2_sb_events(), out_r2sb, gain=0.75)
    print(f"wrote {out_r2sb}")

    out_r3el = OUT / "r3-el-percussion.wav"
    render_drum_stem(build_r3_el_events(), out_r3el, gain=0.75)
    print(f"wrote {out_r3el}")

    out_r4sb = OUT / "r4-sb-percussion.wav"
    render_drum_stem(build_r4_sb_events(), out_r4sb, gain=0.75)
    print(f"wrote {out_r4sb}")

    out_r2el = OUT / "r2-el-percussion.wav"   # named percussion for slot consistency
    render_violin_stem(build_r2_el_violin_events(), out_r2el, gain=0.65)
    print(f"wrote {out_r2el}")


if __name__ == "__main__":
    main()
