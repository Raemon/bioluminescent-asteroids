"""Render the cinematic-el lonely violin via sfizz + Virtual Playing Orchestra 3.

Four-phrase variant: each phrase is a single bowed note that grows for 4s,
then pitch-bends a whole step into a second pitch for another 4s. Brief
rests between phrases. Overall volume rises across the four phrases.

Pitches were chosen against the measured chroma of the ambient + melodic
stems (per-phrase analysis at the top of `violin_notes`).

What changes vs the old 3-note path:
  - 4 phrases instead of 3, each holding two pitches via portamento.
  - Bends are emitted as MIDI pitch-wheel events (status 0xE0), not CC,
    so the SFZ's default ±2-semitone bend range carries the slide. All
    bends in this file are whole steps (±2 semitones), within range.
  - CC11 ceilings rise phrase-to-phrase (32 → 42 → 52 → 64) to deliver
    the requested "beautiful rising volume" arc. CC1 (attack-length on
    this SFZ) shapes a slow bow-in that takes the full 4 seconds before
    the bend begins.

Run:
   python build_cinematic-el_violin_sfizz.py

Outputs raw/cinematic-el-percussion.wav (same name as the old path so
process_percussion.py picks it up unchanged).
"""

from __future__ import annotations

import os
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_v3 import midi_note  # reuse the pitch parser

OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

SFIZZ_BIN = HERE / "tools" / "sfizz" / "bin" / "sfizz_render"
SFIZZ_LIB = HERE / "tools" / "sfizz" / "lib"
SFZ = HERE / "samples" / "vpo3-scripts" / "Virtual-Playing-Orchestra3" / "Strings" / "1st-violin-SOLO-normal-mod-wheel.sfz"

BPM = 120
TICKS_PER_BEAT = 480
VIOLIN_CH = 0
BEND_CENTER = 0x2000  # 8192 — pitchbend "no bend"
BEND_RANGE_SEMITONES = 2.0  # SFZ default when bend_up/bend_down unspecified


# ── MIDI writer with CC + pitch-wheel support ─────────────────────────────

def _varlen(n: int) -> bytes:
    out = bytearray()
    out.append(n & 0x7F)
    n >>= 7
    while n:
        out.insert(0, 0x80 | (n & 0x7F))
        n >>= 7
    return bytes(out)


def write_midi(notes, cc_events, bend_events, out_path: Path, tempo_bpm: int = BPM) -> None:
    """Encode notes + CC + pitch-wheel automation into a type-0 MIDI file.

    notes:       [(beat_on, beat_off, channel, midi_note, velocity), ...]
    cc_events:   [(beat, channel, cc_number, value), ...]      0..127
    bend_events: [(beat, channel, bend_14bit), ...]            0..16383 (8192 = no bend)
    """
    stream = []  # (tick, sort_key, status, d1, d2)
    for on, off, ch, n, vel in notes:
        on_t = int(round(on * TICKS_PER_BEAT))
        off_t = int(round(off * TICKS_PER_BEAT))
        stream.append((on_t,  1, 0x90 | ch, n, vel))
        stream.append((off_t, 0, 0x80 | ch, n, 0))
    for beat, ch, cc, val in cc_events:
        t = int(round(beat * TICKS_PER_BEAT))
        stream.append((t, 0, 0xB0 | ch, cc, max(0, min(127, int(val)))))
    for beat, ch, bend in bend_events:
        t = int(round(beat * TICKS_PER_BEAT))
        b = max(0, min(16383, int(bend)))
        stream.append((t, 0, 0xE0 | ch, b & 0x7F, (b >> 7) & 0x7F))
    stream.sort(key=lambda x: (x[0], x[1]))

    track = bytearray()
    mpqn = int(60_000_000 / tempo_bpm)
    track += _varlen(0)
    track += bytes([0xFF, 0x51, 0x03, (mpqn >> 16) & 0xFF, (mpqn >> 8) & 0xFF, mpqn & 0xFF])

    last_tick = 0
    for tick, _key, status, d1, d2 in stream:
        track += _varlen(tick - last_tick)
        track += bytes([status, d1, d2])
        last_tick = tick

    track += _varlen(0) + bytes([0xFF, 0x2F, 0x00])
    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, TICKS_PER_BEAT)
    out_path.write_bytes(header + b"MTrk" + struct.pack(">I", len(track)) + bytes(track))


# ── Musical line ──────────────────────────────────────────────────────────
# Per-phrase chroma of the OTHER TWO stems (measured 2026-06-07):
#   Ph1  0-8s    ambient A=0.99 E=0.39  | melodic C=0.92 E=0.56 F=0.41
#   Ph2  8-16s   ambient A=0.69 G=0.48  | melodic C=0.87 E=0.61 D=0.32
#   Ph3 16-24s   ambient A=0.64 G=0.62  | melodic C=0.90 E=0.63
#   Ph4 24-32s   ambient A=0.91 E=0.32  | melodic C=0.91 E=0.63 F=0.25
#
# Each violin phrase = single bowed note A held 4s while CC11 swells,
# then a whole-step pitch-wheel slide into pitch B held another 4s
# (with a small release before the next phrase).
#
#   Ph1   A4 -> G4     bow enters on Am root; slide down 2 semitones
#                  lands on G4, the 5th-of-C, just as melodic settles
#                  into its C-pedal. (-2 st bend; ±2 is within range.)
#
#   Ph2   C5 -> D5     bend matches the D=0.32 chroma the melodic shows
#                  in Ph2; D5 is the 9th of C, a soft brightening
#                  that does not fight the ambient's A->G walk-down.
#                  (+2 st bend.)
#
#   Ph3   E5 -> D5     E5 = strong chord tone vs melodic's E=0.63;
#                  bends down to land on the same D5 hinge as Ph2.
#                  (-2 st bend; mirrors Ph2's arc.)
#
#   Ph4   D5 -> E5     ascending bend into the climax pitch (E5,
#                  brightest chord-tone over the C-pedal). Highest
#                  CC11 ceiling of the loop. (+2 st bend.)
#
# Bend SHAPE: 8 small pitch-wheel events over a 0.6-beat ramp window
# (0.3s at 120 BPM). The ramp starts at the 4-second mark inside each
# phrase, so the first 4s is pure swell on note A, then the bend
# happens in ~0.3s, then 4s of held note B with the swell continuing.
# Short ramp = audible slide rather than a slow portamento smear.

# Beat math: 120 BPM => 2 beats/sec.
#   Ph1 slot 0-8s        beats  0-16
#   Ph2 slot 8-16s       beats 16-32
#   Ph3 slot 16-24s      beats 32-48
#   Ph4 slot 24-32s      beats 48-64
# Note-on at slot_start + 0.6 beats (0.3s lead-in silence)
# Bend at slot_start + 8 beats (the 4s point)
# Note-off at slot_start + 15.0 beats (0.5s release before next slot)

PHRASES = [
    # (slot_start_beat, pitch_A, pitch_B, velocity, cc11_peak, cc1_attack_curve)
    # cc1_attack_curve gives this phrase's CC1 ramp endpoint at the start
    # of the held-A section (lower = brighter/more focused bow attack,
    # higher = softer/longer bow-in).
    (0.0,  "A4", "G4", 36, 32, 110),
    (16.0, "C5", "D5", 40, 42, 100),
    (32.0, "E5", "D5", 46, 52,  90),
    (48.0, "D5", "E5", 56, 64,  80),
]
NOTE_LEAD_BEATS = 0.6     # silence before each phrase note-on (0.3s)
BEND_START_BEATS = 8.0    # 4s into the phrase
BEND_DURATION_BEATS = 0.6 # ~0.3s pitch-wheel ramp
NOTE_OFF_BEATS = 15.0     # 0.5s release tail at the end of the slot
BEND_RAMP_STEPS = 8


def violin_notes():
    """Each phrase is a single MIDI note that lasts the whole 7.5s of
    sound; the second pitch is achieved by pitch-wheel slide, not a
    second note-on. This is what gives the slide its bowed character —
    a re-articulated note would sound like a chord change instead.
    """
    notes = []
    for slot_start, pitch_a, _pitch_b, vel, _cc11_peak, _cc1_atk in PHRASES:
        on = slot_start + NOTE_LEAD_BEATS
        off = slot_start + NOTE_OFF_BEATS
        notes.append((on, off, VIOLIN_CH, midi_note(pitch_a), vel))
    return notes


def violin_cc():
    """CC1 = mod wheel (controls attack length on this SFZ).
    CC11 = expression (per-sample volume — the swell engine).

    Same shape every phrase: slow bow-in held over the first 4s,
    swell to CC11 peak just before the bend, fade through the bend
    and release. CC11 peak rises phrase-to-phrase for the volume arc.
    """
    events = [(0.0, VIOLIN_CH, 1, 60), (0.0, VIOLIN_CH, 11, 0)]

    def ramp(start_beat, end_beat, cc, points, steps=12):
        """points = [(t_frac, value), ...]. Linear between adjacent points."""
        dur = end_beat - start_beat
        if dur <= 0:
            return
        points = sorted(points, key=lambda p: p[0])
        for i in range(steps + 1):
            t = i / steps
            lo, hi = points[0], points[-1]
            for j in range(len(points) - 1):
                if points[j][0] <= t <= points[j + 1][0]:
                    lo, hi = points[j], points[j + 1]
                    break
            v = lo[1] if hi[0] == lo[0] else lo[1] + (hi[1] - lo[1]) * (t - lo[0]) / (hi[0] - lo[0])
            events.append((start_beat + t * dur, VIOLIN_CH, cc, v))

    for slot_start, _pa, _pb, _vel, cc11_peak, cc1_attack in PHRASES:
        on = slot_start + NOTE_LEAD_BEATS
        off = slot_start + NOTE_OFF_BEATS
        bend_at = slot_start + BEND_START_BEATS

        # CC1: very high right at note-on (long bow-in), drops over the
        # first 4 seconds so the swell sounds like the bow finding the
        # string. Stays low through the bend + held-B section.
        ramp(on, bend_at, 1,
             [(0.0, cc1_attack), (0.3, cc1_attack * 0.6), (1.0, 30)])
        ramp(bend_at, off, 1, [(0.0, 30), (1.0, 28)])

        # CC11: starts near silent, grows for 4s to peak just before
        # the bend, stays bright through the held-B section, fades
        # out in the last 1.5s before release. The phrase-to-phrase
        # peak climbs (32 -> 42 -> 52 -> 64) for the rising arc.
        ramp(on, bend_at, 11,
             [(0.0, 4), (0.4, cc11_peak * 0.55), (1.0, cc11_peak)])
        ramp(bend_at, off, 11,
             [(0.0, cc11_peak), (0.15, cc11_peak * 0.95),
              (0.7, cc11_peak * 0.70), (1.0, 6)])

    events.sort(key=lambda e: e[0])
    return events


def violin_bend():
    """Emit pitch-wheel events for each phrase's whole-step slide.

    All four bends are exactly ±2 semitones, matching the SFZ default
    bend range. Before each phrase we re-center the wheel so the
    note-on starts with no pre-existing bend from the previous phrase.
    """
    events = [(0.0, VIOLIN_CH, BEND_CENTER)]

    for slot_start, pitch_a, pitch_b, _vel, _cc11, _cc1 in PHRASES:
        on = slot_start + NOTE_LEAD_BEATS
        bend_at = slot_start + BEND_START_BEATS
        bend_end = bend_at + BEND_DURATION_BEATS

        semitones = midi_note(pitch_b) - midi_note(pitch_a)
        # ±2-semitone range => target_14bit = 8192 + 8191 * (semitones / 2)
        target = BEND_CENTER + int(round(8191 * (semitones / BEND_RANGE_SEMITONES)))
        target = max(0, min(16383, target))

        # Re-center exactly at note-on, then ramp during the bend window.
        events.append((on, VIOLIN_CH, BEND_CENTER))
        for i in range(BEND_RAMP_STEPS + 1):
            t = i / BEND_RAMP_STEPS
            beat = bend_at + t * BEND_DURATION_BEATS
            # Smoothstep ease so the slide does not sound mechanical.
            ease = t * t * (3 - 2 * t)
            value = int(round(BEND_CENTER + (target - BEND_CENTER) * ease))
            events.append((beat, VIOLIN_CH, value))
        # Hold the bend through note-off; small safety event at bend_end.
        events.append((bend_end, VIOLIN_CH, target))

    events.sort(key=lambda e: e[0])
    return events


# ── Render ────────────────────────────────────────────────────────────────

def render(out_wav: Path, sample_rate: int = 44100) -> None:
    if not SFIZZ_BIN.exists():
        raise SystemExit(f"sfizz_render not found at {SFIZZ_BIN}")
    if not SFZ.exists():
        raise SystemExit(f"SFZ not found at {SFZ}\n"
                         f"Did the VPO3 wave-files archive extract correctly?")

    midi_path = out_wav.with_suffix(".mid")
    write_midi(violin_notes(), violin_cc(), violin_bend(), midi_path)

    env = dict(os.environ)
    env["DYLD_LIBRARY_PATH"] = (
        f"{SFIZZ_LIB}:{env.get('DYLD_LIBRARY_PATH', '')}".rstrip(":")
    )
    cmd = [
        str(SFIZZ_BIN),
        "--sfz", str(SFZ),
        "--midi", str(midi_path),
        "--wav", str(out_wav),
        "--samplerate", str(sample_rate),
        "--quality", "10",
        "--polyphony", "8",
    ]
    print("$", " ".join(cmd))
    subprocess.run(cmd, env=env, check=True)
    print(f"wrote {out_wav}")


def main():
    render(OUT / "cinematic-el-percussion.wav")


if __name__ == "__main__":
    main()
