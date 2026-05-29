"""Variation 3: Cinematic ambient (self-built with FluidSynth + GeneralUser GS).

Aesthetic mirror of v2 — felt piano + warm strings — but with surgical
control over every note. Outputs two WAV stems (ambient pad, melodic lead)
ready to drop into processed/.

Tempo: 120 BPM. Loop: 4 measures = 8 seconds.
Key: C minor. Progression: i-VI-III-VII (Cm-Ab-Eb-Bb), one chord per measure.

Two MIDI files → fluidsynth → WAV. We render at 44.1kHz, 16-bit stereo.

MIDI program (GM):
   48 = String Ensemble 1 (warm strings)
   88 = Lead 1 / square wave  → no, instead:
    0 = Acoustic Grand Piano (for felt piano feel — soft velocity)
   91 = Pad 4 (choir)
   89 = Pad 3 (polysynth) — used in v4
   95 = Pad 8 (sweep)     — used in v4
"""

from __future__ import annotations

import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SF2 = HERE / "soundfonts" / "GeneralUser-GS.sf2"
OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

# --- Tiny MIDI writer ------------------------------------------------------
# We don't need a library for this — a single-track MIDI is just a header
# plus a stream of (delta_time, event) pairs. Writing it by hand keeps the
# pipeline dependency-light.

TICKS_PER_BEAT = 480  # high enough resolution for sub-beat phrasing
BPM = 120


def varlen(n: int) -> bytes:
    """MIDI variable-length quantity encoding."""
    out = bytearray()
    out.append(n & 0x7F)
    n >>= 7
    while n:
        out.insert(0, 0x80 | (n & 0x7F))
        n >>= 7
    return bytes(out)


def midi_note(pitch: str) -> int:
    """Convert pitch name like 'C4', 'Eb3' to MIDI note number."""
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    name = pitch[0].upper()
    n = names[name]
    i = 1
    if i < len(pitch) and pitch[i] in "#b":
        n += 1 if pitch[i] == "#" else -1
        i += 1
    octave = int(pitch[i:])
    # MIDI 60 = C4
    return n + (octave + 1) * 12


def build_midi(events, tempo_bpm=BPM) -> bytes:
    """events: list of (beat_time, duration_beats, channel, midi_note, velocity)

    Channels we use:
       0 = piano / lead
       1 = strings / pad

    We allocate program-change events to set the GM program per channel.
    Caller is responsible for setting those via `prog` argument (see below
    callers — they call build_midi with programs already inserted).
    """
    # Sort events by start time
    events = sorted(events, key=lambda e: e[0])

    # Build a flat stream of (tick, status, data1, data2) for both note-on
    # and note-off, then walk it in time order emitting deltas.
    stream = []
    for start_beats, dur_beats, ch, note, vel in events:
        start_tick = int(round(start_beats * TICKS_PER_BEAT))
        end_tick = int(round((start_beats + dur_beats) * TICKS_PER_BEAT))
        stream.append((start_tick, 0x90 | ch, note, vel))
        stream.append((end_tick, 0x80 | ch, note, 0))
    stream.sort(key=lambda x: (x[0], 0 if (x[1] & 0xF0) == 0x80 else 1))

    track = bytearray()

    # Tempo meta event: microseconds per quarter
    mpqn = int(60_000_000 / tempo_bpm)
    track += varlen(0)
    track += bytes([0xFF, 0x51, 0x03,
                    (mpqn >> 16) & 0xFF, (mpqn >> 8) & 0xFF, mpqn & 0xFF])

    # Program changes (assume caller passes them as channel-keyed dict via
    # an extra return path — here we set defaults: ch0 piano(0), ch1 strings(48)).
    # Actual programs are set by the calling stem-build function via extra
    # events at tick 0 (status 0xC0|ch, program_byte). We'll piggyback on the
    # events list by treating duration 0 + note=-1 as a sentinel — but the
    # cleaner approach is to handle programs externally, which we do via
    # build_stem.

    last_tick = 0
    for tick, status, d1, d2 in stream:
        if d1 == -1:
            # program-change sentinel
            track += varlen(tick - last_tick)
            track += bytes([status, d2])  # status already encodes 0xC0|ch
        else:
            track += varlen(tick - last_tick)
            track += bytes([status, d1, d2])
        last_tick = tick

    # End-of-track
    track += varlen(0)
    track += bytes([0xFF, 0x2F, 0x00])

    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, TICKS_PER_BEAT)
    track_chunk = b"MTrk" + struct.pack(">I", len(track)) + bytes(track)
    return header + track_chunk


def build_stem(events, programs: dict[int, int], tempo_bpm=BPM) -> bytes:
    """Wrap build_midi with program-change events at tick 0 for each
    (channel → GM program) entry in `programs`."""
    pc_events = []
    for ch, prog in programs.items():
        # sentinel events: status=0xC0|ch, d1=-1, d2=program
        pc_events.append((0.0, 0.0, ch, -1, 0))  # placeholder dur, will become PC

    # We don't actually use the sentinel above — instead we'll do PC by writing
    # a small prefix into the track. Simplest: write PCs as varlen 0 + 0xC0|ch
    # + program byte, then immediately follow with the regular note stream.
    # That requires patching build_midi; do it here directly.

    events = sorted(events, key=lambda e: e[0])

    stream = []
    for start_beats, dur_beats, ch, note, vel in events:
        start_tick = int(round(start_beats * TICKS_PER_BEAT))
        end_tick = int(round((start_beats + dur_beats) * TICKS_PER_BEAT))
        stream.append((start_tick, 0x90 | ch, note, vel))
        stream.append((end_tick, 0x80 | ch, note, 0))
    stream.sort(key=lambda x: (x[0], 0 if (x[1] & 0xF0) == 0x80 else 1))

    track = bytearray()

    # tempo
    mpqn = int(60_000_000 / tempo_bpm)
    track += varlen(0)
    track += bytes([0xFF, 0x51, 0x03,
                    (mpqn >> 16) & 0xFF, (mpqn >> 8) & 0xFF, mpqn & 0xFF])
    # program changes at tick 0
    for ch, prog in programs.items():
        track += varlen(0)
        track += bytes([0xC0 | ch, prog])
    # gentle reverb send for ambient feel — CC 91 (reverb depth) per channel
    for ch in programs:
        track += varlen(0)
        track += bytes([0xB0 | ch, 91, 80])  # reverb depth 80/127
        track += varlen(0)
        track += bytes([0xB0 | ch, 93, 30])  # chorus depth 30/127

    last_tick = 0
    for tick, status, d1, d2 in stream:
        track += varlen(tick - last_tick)
        track += bytes([status, d1, d2])
        last_tick = tick

    track += varlen(0)
    track += bytes([0xFF, 0x2F, 0x00])

    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, TICKS_PER_BEAT)
    return header + b"MTrk" + struct.pack(">I", len(track)) + bytes(track)


def render_midi(midi_bytes: bytes, wav_out: Path, gain: float = 0.6) -> None:
    """Run fluidsynth offline to render MIDI → WAV at 44.1k stereo 16-bit."""
    midi_tmp = wav_out.with_suffix(".mid")
    midi_tmp.write_bytes(midi_bytes)
    # fluidsynth: -F outfile -ni (no shell) -g gain -r samplerate
    cmd = [
        "fluidsynth", "-ni", "-g", str(gain), "-r", "44100",
        "-F", str(wav_out), str(SF2), str(midi_tmp),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


# --- v3: cinematic ambient bed + felt piano melody -------------------------

CHORDS = [
    # measure_index -> root_note_name (one chord per measure)
    # i  VI III VII  in C minor
    ("C3",  ["C3", "Eb3", "G3"]),    # Cm
    ("Ab2", ["Ab2", "C3", "Eb3"]),   # Ab major
    ("Eb3", ["Eb3", "G3", "Bb3"]),   # Eb major
    ("Bb2", ["Bb2", "D3", "F3"]),    # Bb major
]

MEASURES = 4  # 4 measures × 4 beats = 16 beats = 8 s @ 120 BPM


def build_v3_ambient_events():
    """Strings + low choir sustaining each chord across its full measure.
    Channel 1 = strings (program 48), channel 2 = choir pad (program 91)."""
    events = []
    for m, (_, voicings) in enumerate(CHORDS):
        for v in voicings:
            n = midi_note(v)
            # Strings: sustain entire measure with a slight crescendo
            # implemented by stacking two attacks (gives a re-bow swell feel)
            events.append((m * 4.0,       4.0, 1, n, 62))
            events.append((m * 4.0 + 2.0, 2.0, 1, n, 70))
        # Choir pad up an octave for air — only root + fifth
        for v in (voicings[0], voicings[2]):
            n = midi_note(v) + 12
            events.append((m * 4.0, 4.0, 2, n, 38))
    return events


def build_v3_melodic_events():
    """Felt piano melody. 8 phrases of 2 beats each. Each pitch chosen
    from chord tones + passing tones; the line walks up to a peak at
    measure 3 then resolves. Channel 0 = piano (program 0)."""
    # Pitches expressed by beat-time (in beats from start of loop)
    # m1 (Cm): C4 Eb4 G4 ; m2 (Ab): F4 Eb4 ; m3 (Eb): G4 Bb4 ; m4 (Bb): F4 D4
    melody = [
        # (beat_start, dur_beats, pitch, velocity)
        (0.0,  1.0, "C4",  72),
        (1.0,  1.0, "Eb4", 78),
        (2.0,  2.0, "G4",  82),

        (4.0,  1.5, "F4",  74),
        (5.5,  0.5, "Eb4", 70),
        (6.0,  2.0, "G4",  76),

        (8.0,  1.0, "Bb4", 90),  # peak
        (9.0,  1.0, "G4",  82),
        (10.0, 2.0, "Eb4", 74),

        (12.0, 1.0, "F4",  72),
        (13.0, 1.0, "D4",  72),
        (14.0, 2.0, "C4",  70),  # resolve down to root
    ]
    return [(b, d, 0, midi_note(p), v) for b, d, p, v in melody]


def main():
    ambient_midi = build_stem(
        build_v3_ambient_events(),
        programs={1: 48, 2: 91},  # strings, choir
    )
    melodic_midi = build_stem(
        build_v3_melodic_events(),
        programs={0: 0},  # piano
    )
    a_out = OUT / "v3-cinematic-ambient.wav"
    m_out = OUT / "v3-cinematic-melodic.wav"
    render_midi(ambient_midi, a_out, gain=0.8)
    render_midi(melodic_midi, m_out, gain=0.7)
    print(f"wrote {a_out}")
    print(f"wrote {m_out}")


if __name__ == "__main__":
    main()
