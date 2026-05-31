"""Build the per-variation layer-3 stems (the 12x combo reward).

One new musical element per song, chosen to thematically fit what's already
in the ambient + melodic layers. The earlier drum-kit attempt (see
build_percussion.py) was rejected — drums fought the bass clock and the
existing instrumental palette. This version stays inside each variation's
own voice family.

  r2-sb  felt-mallet glockenspiel arpeggio (slow, sparse, on-beat).
         Extends the felt-piano's sparkle into the upper octave. Not a drum
         — chime tones falling in a major-7th-coloured ascending pattern.
  r3-el  pulsed synth-bass arp on the off-beats (8th-note plucked saw at
         G2/B2/E3, mode-invariant; sits between the kick register and the
         soft lead). Synthwave-appropriate motion that vibes with the Juno
         pad without doubling the lead.
  r4-sb  glockenspiel counter-melody that plays in the gaps of the arp
         (slots 3/7/11/15 — the rest sixteenths). Same 16th grid, but the
         arp and layer 3 never strike together, so they read as one
         interlocked instrument.

r2-el's layer 3 is the lonely solo violin built in build_percussion.py
(file kept; this script does not rebuild it). It already shipped and the
user approved it.

Phrase plan applies to every layer-3 stem (same A-A'-B-A' as ambient/melodic):
  A   ground motif
  A'  same motif, lighter velocity
  B   peak motif — slightly different colour (maj7 / Bb voice etc.)
  A'  resolve

Outputs land in raw/{variation}-layer3.wav. Post-processing happens in
process_layer3.py — trim to 32s, peak-normalize to -12 dBFS, edge fades,
per-stem sox reverb, mp3 encode.
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
BEAT = 1.0
EIGHTH = 0.5
SIXTEENTH = 0.25
MEASURE_BEATS = 4
PHRASE_BEATS = MEASURE_BEATS * 4        # 16
LOOP_BEATS = PHRASE_BEATS * 4           # 64

# GM programs we use here. All non-drum (no channel 9).
PROG_GLOCK = 9          # Glockenspiel — clean bell tone, decays naturally
PROG_CELESTA = 8        # Celesta — softer than glock, more "felt"
PROG_SYNTHBASS = 39     # Synth Bass 2 — plucked sawtooth-ish, synthwave bread-and-butter


# ── r2-sb layer 3: felt-mallet glockenspiel arpeggio ──────────────────────
# Pairs with the r2-sb procedural sine pad + felt piano. The pad is warm and
# slow, the piano holds long notes. Layer 3 introduces *motion in the upper
# octave* via a slow ascending bell figure — one note per beat, octave above
# the felt piano so it sits clearly above without fighting the melodic
# layer's held tones. Velocities stay low (felt-mallet, not orchestral hit).
#
# Phrase voicings track the ambient pad's chord plan:
#   A:  C5 E5 G5 C6      (major third top, open and bright)
#   A': C5 Eb5 G5 C6     (minor third top — shadow)
#   B:  C5 E5 G5 B5      (Cmaj7 — adds the 7th for longing)
#   A': C5 Eb5 G5 C6     (settle back to the shadow voicing)
#
# Channel 2 chosen arbitrarily (non-drum). One note per beat = 4 notes/bar.
# Sparse-feeling because the long natural decay of glock means notes ring
# into each other instead of feeling busy.
GLOCK_CH = 2

def _r2_sb_phrase_pitches(phrase_idx: int) -> list[str]:
    if phrase_idx == 0:                 # A
        return ["C5", "E5", "G5", "C6"]
    if phrase_idx == 1 or phrase_idx == 3:  # A' (shadow)
        return ["C5", "Eb5", "G5", "C6"]
    return ["C5", "E5", "G5", "B5"]     # B (Cmaj7)

def build_r2_sb_events() -> list:
    events = []
    # Per-phrase velocity contour. Glock plays *quietly* (felt mallet feel).
    phrase_vel = [54, 46, 58, 48]   # A, A', B, A'
    for phrase_idx in range(4):
        phrase_start = phrase_idx * PHRASE_BEATS
        v_base = phrase_vel[phrase_idx]
        pitches = _r2_sb_phrase_pitches(phrase_idx)
        for measure in range(4):
            m_start = phrase_start + measure * MEASURE_BEATS
            # One note per beat, ascending across the bar (the 4 chord tones
            # of this phrase). Duration = 1 beat (will ring on naturally due
            # to glock decay; we don't damp).
            for beat_idx in range(4):
                # Light per-beat velocity contour: beat 1 strongest, others softer
                vel = v_base if beat_idx == 0 else v_base - 8
                events.append((m_start + beat_idx, 1.0, GLOCK_CH,
                               midi_note(pitches[beat_idx]), vel))
        # Phrase B accent: one extra octave-up sparkle on the and-of-4 of
        # measure 2 — single grace note that marks the peak phrase without
        # adding rhythmic noise.
        if phrase_idx == 2:
            events.append((phrase_start + 2 * MEASURE_BEATS + 3.5, 0.5, GLOCK_CH,
                           midi_note("E6"), 42))
    return events


# ── r3-el layer 3: pulsed synth-bass arp on the off-beats ────────────────
# Pairs with the EL synthwave Juno pad + soft lead. Synthwave loves a
# pulsing sequencer — that's the "rhythmic where appropriate" the user
# asked for. The new element is a plucked synth-bass voice that plays an
# 8th-note off-beat arp (the "and" of every beat), one octave below the
# soft lead, so it fills the sequencer-shaped hole between the lead's
# longer notes without competing for the melodic register.
#
# Pitches stay on mode-invariant chord tones (C/G/E or C/G/Eb) so it
# survives whatever colour the EL melodic layer happens to be in at any
# given moment — same defense as the legacy halo pad's C+G open fifth.
#
# Phrase voicings:
#   A:  G2 → E3 → G2 → C3     (open fifth + major third)
#   A': G2 → Eb3 → G2 → C3    (minor third shift)
#   B:  G2 → E3 → B2 → C3     (Cmaj7 — the maj7 in the arp itself)
#   A': G2 → Eb3 → G2 → C3
#
# Pattern is 8 notes per bar (one on each off-beat). Synth Bass 2 (GM 39)
# has a short plucked envelope — releases before the next note hits, so
# each pulse stands alone. Bass register (G2 = 98 Hz, C3 = 131 Hz) so it
# lives in the 60-200 Hz / lo-mid band — needs the in-game audit to keep
# it from masking the kick. Velocity stays low for the same reason.
SYNTHBASS_CH = 3

def _r3_el_phrase_pitches(phrase_idx: int) -> list[str]:
    # 4 notes per bar (one per off-beat); we cycle them
    if phrase_idx == 0:                 # A: maj 3rd
        return ["G2", "E3", "G2", "C3"]
    if phrase_idx == 1 or phrase_idx == 3:  # A': min 3rd
        return ["G2", "Eb3", "G2", "C3"]
    return ["G2", "E3", "B2", "C3"]     # B: Cmaj7

def build_r3_el_events() -> list:
    events = []
    phrase_vel = [62, 54, 68, 56]
    for phrase_idx in range(4):
        phrase_start = phrase_idx * PHRASE_BEATS
        v = phrase_vel[phrase_idx]
        pitches = _r3_el_phrase_pitches(phrase_idx)
        for measure in range(4):
            m_start = phrase_start + measure * MEASURE_BEATS
            # 8th-note off-beats only — the "and" of each beat. 4 hits per bar.
            # Each beat 0..3 → the off-beat lands at beat + 0.5
            for beat_idx in range(4):
                t = m_start + beat_idx + 0.5
                p = pitches[beat_idx]
                # Short duration so the pluck releases before the next note.
                events.append((t, 0.45, SYNTHBASS_CH, midi_note(p), v))
        # Phrase B lift: add one downbeat-of-measure-3 root hit (C2 — octave
        # below the arp) so the peak phrase feels grounded.
        if phrase_idx == 2:
            events.append((phrase_start + 2 * MEASURE_BEATS, 1.0, SYNTHBASS_CH,
                           midi_note("C2"), 64))
    return events


# ── r4-sb layer 3: glockenspiel counter-melody in the arp's rest slots ───
# Pairs with the r4-sb 16th-note arp (slot pattern: hits on slots 0/1/2,
# rest on slot 3, repeat per beat). The arp already saturates the rhythmic
# field; layer 3 must NOT add more 16ths. Instead it plays only on the
# slots the arp leaves empty (slot 3 of each beat = the "a" of the beat),
# producing one chime hit per beat that lands in the silence the arp
# created. The result reads as a single interlocked instrument.
#
# Pitches are high (C6-E6-G6 region) — well above the arp's C4-G4 home,
# well above the calliope melodic's 500-1500 Hz register. The chime is
# transparent in the mid/hi band so it never collides spectrally with
# the bass kit or the melodic layer.
#
# Phrase voicings (one chime per beat = 4 per bar = 16 per phrase, but
# we only play measure-relevant tones; the rest of the slots are silent
# so the layer doesn't blur into the arp):
#   A:  C6 G5 E6 G5     (light melodic shimmer)
#   A': C6 G5 Eb6 G5
#   B:  C6 B5 E6 D6     (Cmaj7 colour — adds 7th and 9th in upper voice)
#   A': C6 G5 Eb6 G5
#
# Slot 3 of each beat = beat_offset + 0.75 (where 1.0 = one quarter note).
GLOCK2_CH = 4

def _r4_sb_phrase_pitches(phrase_idx: int) -> list[str]:
    if phrase_idx == 0:                 # A
        return ["C6", "G5", "E6", "G5"]
    if phrase_idx == 1 or phrase_idx == 3:  # A' (shadow)
        return ["C6", "G5", "Eb6", "G5"]
    return ["C6", "B5", "E6", "D6"]     # B (Cmaj7 + 9)

def build_r4_sb_events() -> list:
    events = []
    phrase_vel = [50, 42, 56, 44]
    for phrase_idx in range(4):
        phrase_start = phrase_idx * PHRASE_BEATS
        v = phrase_vel[phrase_idx]
        pitches = _r4_sb_phrase_pitches(phrase_idx)
        for measure in range(4):
            m_start = phrase_start + measure * MEASURE_BEATS
            for beat_idx in range(4):
                # Strike on slot 3 of each beat (the "a" — 3rd sixteenth).
                # This is the slot the arp rests on; the chime fills it.
                # Skip beat 4's slot 3 on every other bar so it isn't
                # mechanical — gives the line breath.
                if measure % 2 == 1 and beat_idx == 3:
                    continue
                t = m_start + beat_idx + 0.75
                p = pitches[beat_idx]
                # Short duration (sixteenth) — glockenspiel decays naturally
                events.append((t, 0.25, GLOCK2_CH, midi_note(p), v))
        # Phrase B accent: open chord on the loop's halfway point (sounds at
        # measure 3 downbeat of phrase B) — a glock triad to mark the lift.
        if phrase_idx == 2:
            for p in ("C6", "E6", "G6"):
                events.append((phrase_start + 2 * MEASURE_BEATS, 1.0,
                               GLOCK2_CH, midi_note(p), 56))
    return events


def render_pitched_stem(events: list, programs: dict[int, int],
                        out_wav: Path, gain: float = 0.7) -> None:
    midi = build_stem(events, programs=programs)
    render_midi(midi, out_wav, gain=gain)


def main():
    # r2-sb: felt glockenspiel
    out_r2sb = OUT / "r2-sb-layer3.wav"
    render_pitched_stem(build_r2_sb_events(),
                        programs={GLOCK_CH: PROG_GLOCK},
                        out_wav=out_r2sb, gain=0.7)
    print(f"wrote {out_r2sb}")

    # r3-el: synth-bass arp
    out_r3el = OUT / "r3-el-layer3.wav"
    render_pitched_stem(build_r3_el_events(),
                        programs={SYNTHBASS_CH: PROG_SYNTHBASS},
                        out_wav=out_r3el, gain=0.7)
    print(f"wrote {out_r3el}")

    # r4-sb: glockenspiel counter-melody
    out_r4sb = OUT / "r4-sb-layer3.wav"
    render_pitched_stem(build_r4_sb_events(),
                        programs={GLOCK2_CH: PROG_GLOCK},
                        out_wav=out_r4sb, gain=0.7)
    print(f"wrote {out_r4sb}")


if __name__ == "__main__":
    main()
