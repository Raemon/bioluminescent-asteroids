"""Build the per-variation percussion stems that replace the sparkle layer.

Three percussion stems (musicbox-sb, synthwave-el, flagship-sb) + one exception:
  cinematic-el-percussion is actually a lonely solo violin (matches the cinematic-el
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


# ── musicbox-sb percussion: warm-dry brushy kit ──────────────────────────────────
# Pairs with the musicbox-sb procedural sine pad + felt piano. The pad is warm and
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


# ── synthwave-el percussion: synthwave electronic kit ─────────────────────────────
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


# ── flagship-sb percussion: interlocked 16th-note kit ────────────────────────────
# Pairs with the flagship-sb rhythmic flagship — pulsing arp + calliope melody. The
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


# ── cinematic-el lonely violin (NOT percussion) ───────────────────────────────────
# Single-line solo violin (GM 40 = Violin). Designed against the *actual*
# harmony of the cinematic-el ambient + melodic mp3s as measured by deepinspect.py
# chroma over time — not the imagined plan of the earlier draft:
#
#   0–3s   brief Cmaj fragment (the loop seam from the previous resolve)
#   3–14s  A minor drone (A-E with Bb passing colour)
#   14–23s modulates toward G (G-D-A — the brief lift)
#   23–32s back to A minor, with E-major dominant push (G#)
#
# Earlier draft built a relentless legato climbing scale through every
# 32nd-of-a-beat. That destroyed the "lonely" — a haunting solo needs real
# silence between phrases so each note can be heard as the voice's own
# choice, not part of a continuous line. It also wandered into G major
# while the bed is sitting in A minor, which the user flagged as not
# fitting the other two tracks.
#
# This version: 3 phrases of bowed cry separated by real bars of silence,
# all locked to A natural minor. Pitches drawn from the chord tones of
# whatever the bed is actually playing at that beat-window.
#
#   Phrase 1 (1–10)   the cry: E5 (open string) bow attack, hold,
#                     slow sigh E5 → D5 → C5 (i fifth → minor-3rd descent)
#   Phrase 2 (16–23)  the lift: A5 (octave above tonic) reaches up,
#                     descends G5 → F5 → D5 over the bed's G-modulation
#                     (F♮ matches the bed's F chroma at 17s)
#   Phrase 3 (24–32)  the leading-tone hang: long held G#5 over the bed's
#                     E-major dominant push, resolves down E5 → A4 (tonic)
#                     ringing into the loop seam
#
# Three musical ideas, not 40 stepwise notes. OVERLAP is large (0.6 beats)
# so the GM violin's per-note attack ties cleanly into the next note rather
# than re-articulating — closer to legato bowing than tongued sequencing.
# Bow-weight velocities use a swell-and-settle inside each held note via
# two stacked attacks (a soft entry, then a fuller second bow on the same
# pitch) — a trick borrowed from how the legacy halo pad fakes breath.
#
# Register lives in the viola's natural sweet spot (C4–E5) to match the
# felt-piano's mid-band centroid (~600 Hz) and the cinematic-strings'
# ambient (~890 Hz). The earlier draft sat the line in violin's E5–A5
# register where the bed has almost no energy — sounded like a spotlit
# soloist instead of a bowed voice floating *inside* the existing strings.
# Audit numbers that drove the register choice:
#   cinematic-el-ambient    band energy → 54% in 60–200 Hz, 29% in 200–500 Hz
#                                   <0.1% in 2–6 kHz
#   cinematic-el-melodic    band energy → 66% in 200–500 Hz, 24% in 500–2k Hz
#                                   <1.6% in 2–6 kHz
#   violin in E5–A5  band energy → 43% in 2–6 kHz (catastrophic mismatch)
# Dropping an octave and using Viola (GM 41 — darker, less upper-harmonic
# bite than GM 40 Violin) puts the line back inside the existing spectrum.
VIOLIN_CH = 1
VIOLIN_PROGRAM = 41   # Viola — darker bowed timbre than Violin (40)

def build_r2_el_violin_events() -> list:
    # OVERLAP is large here so adjacent notes tie legato — closer to bowed
    # phrasing than retriggered MIDI. Phrases are separated by silence
    # (no note events in those beat windows), not by overlap=0.
    OVERLAP = 0.6

    # (beat_on, beat_off, pitch, velocity)
    # 32s loop @ 120 BPM = 64 beats total.
    # Pitches dropped one octave from the earlier draft to put the line
    # inside the bed's spectral home (200–2k Hz). E4 is the viola open A
    # string + perfect-fourth; A3 is the viola C-string third — both warm.
    line = [
        # ── Phrase 1: "the cry" (beats 2–20, ~1–10s) ───────────────────
        # Bed: A minor with E pedal. Viola on E4 (perfect-unison E pitch
        # class with the bed's E pedal), then falls through the minor 3rd.
        (2.0,   8.0,  "E4", 58),   # soft bow attack, long hold
        (8.0,  12.0,  "E4", 70),   # second bow on the same note — swell
        (12.0, 16.0,  "D4", 64),   # the sigh begins
        (16.0, 20.0,  "C4", 56),   # natural-minor 3rd — lands and rings
        # silence beats 20–32: real breath before the lift

        # ── Phrase 2: "the lift" (beats 32–44, ~16–22s) ────────────────
        # Bed has modulated toward G major (G-D-A chroma, with F♮ leading
        # the way at the 17s mark). Viola climbs to A4 — the octave above
        # tonic, but over the G chord it reads as the suspended 9th, which
        # is the "ache" — then descends matching the bed's F♮.
        (32.0, 36.0,  "A4", 72),   # the reach — held over G-bed (sus-9th)
        (36.0, 39.0,  "G4", 66),   # release down to the bed's root note
        (39.0, 41.5,  "F4", 60),   # match the bed's F♮ chroma
        (41.5, 44.0,  "D4", 54),   # land on G major's 5th
        # silence beats 44–48: brief breath into the final phrase

        # ── Phrase 3: "the leading-tone hang" (beats 48–64, ~24–32s) ──
        # Bed is back in A minor with E-major dominant push (G# chroma
        # detected at 23s). Viola holds G#4 — the leading tone against
        # the natural-minor bed is the lonely interval. Then resolves down
        # E4 → A3 (the tonic on the viola C string, warmest possible).
        (48.0, 54.0,  "G#4", 64),  # the leading-tone hang — the haunt note
        (54.0, 57.0,  "G#4", 72),  # second bow weight, the cry peaks
        (57.0, 60.0,  "E4", 60),   # release down the perfect fifth
        (60.0, 63.5,  "A3", 50),   # tonic resolution — viola C-string warmth
        # last ~0.5 beat tails off into the loop fade
    ]
    return [
        (on, (off - on) + OVERLAP, VIOLIN_CH, midi_note(p), v)
        for on, off, p, v in line
    ]


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
    out_r2sb = OUT / "musicbox-sb-percussion.wav"
    render_drum_stem(build_r2_sb_events(), out_r2sb, gain=0.75)
    print(f"wrote {out_r2sb}")

    out_r3el = OUT / "synthwave-el-percussion.wav"
    render_drum_stem(build_r3_el_events(), out_r3el, gain=0.75)
    print(f"wrote {out_r3el}")

    out_r4sb = OUT / "flagship-sb-percussion.wav"
    render_drum_stem(build_r4_sb_events(), out_r4sb, gain=0.75)
    print(f"wrote {out_r4sb}")

    out_r2el = OUT / "cinematic-el-percussion.wav"   # named percussion for slot consistency
    render_violin_stem(build_r2_el_violin_events(), out_r2el, gain=0.65)
    print(f"wrote {out_r2el}")


if __name__ == "__main__":
    main()
