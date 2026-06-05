"""Render the r2-el lonely violin via sfizz + Virtual Playing Orchestra 3.

Replaces the FluidSynth GM-41 Viola path in build_percussion.py with a real
sampled violin (No Budget Orchestra solo violin, packaged in VPO3). The
musical *line* — three phrases over 32s @ 120 BPM — is preserved verbatim
from build_r2_el_violin_events() so the audit work that picked those pitches
against the bed's chroma still applies.

What changes vs the old path:
  - Instrument: GM-41 Viola → VPO3 Solo Violin (real samples w/ baked vibrato)
  - Renderer:   fluidsynth + GeneralUser-GS.sf2 → sfizz_render + VPO3 SFZ
  - Expression: velocity-only → velocity + CC1 (mod wheel) + CC11 (expression)
    * CC1 on this SFZ lengthens the attack — perfect for slow bow swells on
      held notes. We ramp CC1 up during the long held notes (E4 8.0–12.0,
      G#4 48.0–54.0) and back down before short release notes.
    * CC11 shapes the overall dynamic envelope inside each phrase so the
      "swell-and-settle" reads as one breath rather than discrete attacks.
  - Register: bumped back up an octave on phrase 1 + 3. The viola-darkness
    workaround was for GM-41's tonal mismatch; the real samples sit in
    spectrum without that compensation, so we can use the violin's expressive
    register (E4–A5) where it actually sings.

Run:
   python build_r2el_violin_sfizz.py

Outputs raw/r2-el-percussion.wav (same name as old path, so process_percussion.py
picks it up unchanged).

One-time bootstrap (assets are gitignored — ~620 MB on disk):
   # 1. sfizz CLI (the SFZ sampler)
   mkdir -p tools/sfizz && cd /tmp
   curl -L https://github.com/sfztools/sfizz/releases/download/1.2.3/sfizz-1.2.3-macos.tar.gz | tar xz
   cp -R sfizz-1.2.3-macos/usr/local/* <music-gen>/tools/sfizz/

   # 2. VPO3 SFZ scripts (~540 KB)
   mkdir -p samples && cd samples
   curl -L https://virtualplaying.com/vp-downloads/Virtual-Playing-Orchestra3-2-4-standard-scripts.zip -o vpo3-scripts.zip
   unzip vpo3-scripts.zip -d vpo3-scripts

   # 3. VPO3 wave samples (~590 MB) — extracted INTO vpo3-scripts/ so the
   #    Virtual-Playing-Orchestra3/ root merges (Strings/ + libs/ siblings)
   curl -L https://archive.org/download/VirtualPlayingOrchestra31WaveFiles/Virtual-Playing-Orchestra3-1-wave-files.zip -o vpo3-waves.zip
   unzip vpo3-waves.zip -d vpo3-scripts
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
VIOLIN_CH = 0   # sfizz renders one SFZ; channel doesn't matter, use 0


# ── MIDI writer with CC support ───────────────────────────────────────────
# The build_v3.build_stem() helper only emits program changes + notes; we
# need CC1/CC11 ramps too. Rather than fork that, write a small dedicated
# encoder here. The MIDI binary format is simple enough that a 60-line
# implementation is cleaner than monkey-patching.

def _varlen(n: int) -> bytes:
    out = bytearray()
    out.append(n & 0x7F)
    n >>= 7
    while n:
        out.insert(0, 0x80 | (n & 0x7F))
        n >>= 7
    return bytes(out)


def write_midi(notes, cc_events, out_path: Path, tempo_bpm: int = BPM) -> None:
    """Encode notes + CC automation into a type-0 MIDI file.

    notes:     [(beat_on, beat_off, channel, midi_note, velocity), ...]
    cc_events: [(beat, channel, cc_number, value), ...]    value in 0..127
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
# Bed analysis (measured: bass fundamental tracker + combined chord chroma):
#   Bass pedal walk:
#     0–11s   A1  (Am)
#     12–13s  A→G chromatic slide
#     14–19s  G1  (G in the bass — but upper voices stay in C/Am territory,
#                  so the harmony reads as Am7/G → C/G, not pure G major)
#     20–28s  A1  returns
#     28–32s  E dominant suggestion (bass ambiguous, E becomes the
#             strongest chroma — Am/E or E hint, but with C natural still
#             prominent so NOT a clean E-major dominant)
#
#   Piano (melodic, 200–2k Hz)
#     Near-continuous 8th-note figuration in C4–E4. Frequently visits
#     C# and D# (chromatic neighbors), but every landing note is a C-maj
#     triad tone. The piano stays in a narrow ~5-semitone window all loop.
#
# Design principle: the piano is BUSY in a narrow mid-register window. The
# violin should live just above it (G4–E5) and play SHORT phrases that:
#   - use chord tones and tasteful extensions only (every note checked
#     against the chord at that beat — see per-phrase notes below)
#   - move in directions the piano doesn't (rising when piano is hovering,
#     descending when piano is climbing)
#   - keep ~50% silence so the listener registers each phrase as a "voice"
#     event rather than a continuous line
#
# Six short phrases instead of three long held notes. Same total airtime
# (~13s of sound, ~19s of silence) but with melodic identity per phrase.

def violin_notes():
    # (beat_on, beat_off, pitch, velocity)
    # Three phrases, three slow bow strokes. Each is ONE held note that
    # ends with a step down — a slow leaning resolution to a neighboring
    # tone. This is the minimum motion needed to give a held note a
    # melodic shape (a destination) without sacrificing the lonely-voice
    # sparsity.
    #
    # ~13s of sound, ~19s of silence over the 32s loop. Same total
    # silence as a 6-phrase line, but only 3 sonic events to track.
    line = [
        # ── Phrase 1: "the question, half-answered" (4–10s) ───────────
        # Over Am (bed: A pedal + C-E-F-b6 voicing).
        #   B4 = 9th of Am — the wistful question, 5 seconds held
        #   A4 = root        — half-step sigh down to the tonic
        # The half-step descent B→A is the smallest interval of all
        # three phrases — appropriate to the opening "voice clearing
        # its throat" feel.
        (8.0,  18.0, "B4", 54),  # 5s held — the question
        (18.0, 20.0, "A4", 44),  # sigh resolves to root
        # silence: 20–28 (~10–14s)

        # ── Phrase 2: "the lift, leaning home" (14–22s) ───────────────
        # Over Am7/G ≈ C/G (bass has walked down to G; upper voices in
        # C territory).
        #   D5 = 9th of C  — the bittersweet lift, 5 seconds held
        #   C5 = root of C — whole-step lean down, lands home as the
        #                    bed voices C
        # Whole-step descent (a bigger interval than phrase 1) — the
        # phrase has more harmonic "weight" matching the bed's
        # modulation moment.
        (28.0, 38.0, "D5", 58),  # 5s held — the lift over the modulation
        (38.0, 41.0, "C5", 46),  # leans down to C as bed lands on C
        # silence: 41–52 (~20.5–26s) — the longest breath, lets Am return

        # ── Phrase 3: "the ache that doesn't quite resolve" (26–31.5s) ─
        # Over Am/E (Am in 2nd inversion — E is bass-prominent, C still
        # voiced).
        #   E5 = 5th of Am  — strong chord tone, 4 seconds held
        #   D5 = sus4 of Am — whole-step descent that STOPS on the
        #                     suspension, doesn't resolve
        # Same whole-step shape as phrase 2 but lands on a non-chord
        # tone (D5 sus4) instead of a chord tone. The pattern the ear
        # learned in phrase 2 (descend to home) gets denied here —
        # that's the "ache." On loop restart the D5 hangs into the
        # brief C-chord seam where it reads as the 9th of C — soft
        # re-entry, not jarring.
        (52.0, 60.0, "E5", 50),  # 4s held — the strong 5th
        (60.0, 63.5, "D5", 38),  # quietest note of the loop — fades
        # tail: 63.5–64 silent
    ]
    OVERLAP = 0.3
    notes = []
    for on, off, pitch, vel in line:
        notes.append((on, off + OVERLAP, VIOLIN_CH, midi_note(pitch), vel))
    return notes


def violin_cc():
    """CC automation. CC1 = mod wheel = attack length on this SFZ
    (ampeg_attackcc1=0.5). CC11 = expression = per-sample volume curve.

    Shorter notes than the previous draft, so the strategy changes:
      - Each phrase gets ONE coherent dynamic arc (CC11 swells through
        the phrase, then settles on the last note). The listener should
        hear "one breath" per phrase, not three separate bows.
      - CC1 is moderate at most attacks (40–60) — quick enough that
        each note lands cleanly, slow enough to read as a real bow
        stroke rather than a sharp pluck.
      - The two longest notes (F5 alone in phrase 4, E5 in phrase 6)
        get a slightly slower bow-in (CC1 ≈ 70) since they have time
        to develop.
    """
    events = [(0.0, VIOLIN_CH, 1, 30), (0.0, VIOLIN_CH, 11, 64)]

    def ramp(start_beat, end_beat, cc, points, steps=10):
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

    # Phrase 1: B4 held 8–18, then A4 sigh 18–20.
    # The "voice entering" — slow bow-in (CC1 high at attack), gentle
    # swell through the held note, soft sigh down.
    ramp(8.0,  18.0, 1,  [(0, 110), (0.15, 70), (0.4, 35), (1.0, 30)])
    ramp(8.0,  18.0, 11, [(0, 25), (0.35, 70), (0.55, 80), (0.8, 72), (1.0, 60)])
    ramp(18.0, 20.0, 1,  [(0, 30), (1.0, 25)])
    ramp(18.0, 20.0, 11, [(0, 60), (0.5, 50), (1.0, 35)])

    # Phrase 2: D5 held 28–38, then C5 lean down 38–41.
    # The peak phrase — longest hold, biggest swell, lands on C as the
    # bed voices C. Slightly stronger than phrase 1 (this is the moment
    # the violin steps into the light).
    ramp(28.0, 38.0, 1,  [(0, 95), (0.15, 65), (0.4, 40), (1.0, 35)])
    ramp(28.0, 38.0, 11, [(0, 30), (0.4, 82), (0.6, 92), (0.85, 80), (1.0, 68)])
    ramp(38.0, 41.0, 1,  [(0, 35), (1.0, 28)])
    ramp(38.0, 41.0, 11, [(0, 68), (0.5, 58), (1.0, 42)])

    # Phrase 3: E5 held 52–60, then D5 fade 60–63.5.
    # The quietest, slowest, longest-fading phrase. CC1 highest at
    # attack (the slowest bow of all — note materializes from silence).
    # CC11 never exceeds 70 and the D5 ends at 22 — barely audible,
    # the voice disappearing.
    ramp(52.0, 60.0, 1,  [(0, 120), (0.2, 80), (0.5, 50), (1.0, 45)])
    ramp(52.0, 60.0, 11, [(0, 18), (0.4, 65), (0.65, 70), (0.85, 60), (1.0, 50)])
    ramp(60.0, 63.5, 1,  [(0, 45), (1.0, 30)])
    ramp(60.0, 63.5, 11, [(0, 50), (0.4, 38), (1.0, 22)])

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
    write_midi(violin_notes(), violin_cc(), midi_path)

    env = dict(os.environ)
    # sfizz_render dylib lives next to the binary
    env["DYLD_LIBRARY_PATH"] = (
        f"{SFIZZ_LIB}:{env.get('DYLD_LIBRARY_PATH', '')}".rstrip(":")
    )
    cmd = [
        str(SFIZZ_BIN),
        "--sfz", str(SFZ),
        "--midi", str(midi_path),
        "--wav", str(out_wav),
        "--samplerate", str(sample_rate),
        "--quality", "10",          # high-quality resampling
        "--polyphony", "8",
    ]
    print("$", " ".join(cmd))
    subprocess.run(cmd, env=env, check=True)
    print(f"wrote {out_wav}")


def main():
    render(OUT / "r2-el-percussion.wav")


if __name__ == "__main__":
    main()
