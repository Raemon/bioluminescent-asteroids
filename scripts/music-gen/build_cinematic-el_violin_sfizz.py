"""Render the cinematic-el lonely violin via sfizz + Virtual Playing Orchestra 3.

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

Outputs raw/cinematic-el-percussion.wav (same name as old path, so process_percussion.py
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
# Bed analysis (measured chroma per 8s phrase — superseding the earlier
# read; the old design assumed B was the 9th of Am but B chroma is weak
# (0.13–0.16) while F chroma is STRONG (0.25–0.41). The piano is voicing
# C–E–F throughout, not a clean Cmaj triad — F is part of the colour):
#
#   Ph1  0–8s    bass A1  | piano C, E, F   → reads as Am add♭6 / Fmaj7/A
#   Ph2  8–16s   bass A→G | piano C, E, D   → Am7 → C/G (D appears, F fades)
#   Ph3  16–24s  bass G1  | piano C, E, F   → C/G with Fmaj7 colour
#   Ph4  24–32s  bass A1  | piano C, E, F   → returns to Am/F-colour
#
# Piano centroid is ~600 Hz (≈D5), peak −15.9 dBFS. Old violin sat at
# centroid 3597 Hz — an octave brighter than the piano AND peaking
# LOUDER (−13.4 dBFS). That alone explains "too loud, doesn't harmonize."
#
# Safe pitches per phrase (chord tones only, avoiding F when piano has F
# already and avoiding B which conflicts with the F):
#   Ph1  A4, C5, E5  (root, ♭3, 5 of Am)
#   Ph2  A4, C5, D5  (D is now safe — appears in piano; F just left)
#   Ph3  C5, E5, G4  (root/3rd/5th of C — G4 nests under the piano)
#   Ph4  A4, C5, E5  (same safe set as Ph1)
#
# Design principle for "simpler, quieter, harmonizes better":
#   - THREE short held notes only (no sigh-down second notes, no movement).
#     The old design had six events (3 holds + 3 descents); we halve that.
#   - Register sits a fifth or sixth above the piano's main figure
#     (G4–C5 instead of B4–E5). Closer to the piano = harmonizes; lower
#     pitches = quieter sample.
#   - Velocity capped at 38 (was 38–58). Combined with CC11 ceiling of
#     50 (was 92), the swell never exceeds the piano's headroom.
#   - ~9s of sound total (was ~13s). More space = more "voice from afar".

def violin_notes():
    # (beat_on, beat_off, pitch, velocity)
    # One pitch per phrase, three phrases. Each is a single slow bow
    # stroke whose only motion is the swell-and-release. No descents,
    # no second notes — the piano carries all the melodic motion.
    #
    # Pitch choice across the three phrases forms a gentle arch:
    #   Ph1: A4 (root of Am, lives under the piano figure)
    #   Ph2: C5 (root of C/G — lands ON the new bass move to G)
    #   Ph3: G4 (5th of C/G — lower than Ph2, the breath that exhales)
    # An A4 → C5 → G4 arch: rise, peak, settle. The settle (G4) is the
    # lowest note of the loop and the quietest velocity — so the loop
    # ends quieter than it began, and the seam back to A4 is a tiny
    # half-step lift (G4→A4) that's already a familiar interval.
    line = [
        # ── Phrase 1: A4 over Am (4–8s) ──────────────────────────────
        # Root of Am. Sits just below the piano's lowest C4–E4 figure
        # in pitch space (A4 is a sixth above C4) so it harmonizes
        # rather than overhangs. 3s held; ~9s silence after.
        (8.0,  14.0, "A4", 38),

        # ── Phrase 2: C5 over Am7→C/G (14–18s) ───────────────────────
        # Lands ON the bass's move down to G; C5 is the new root.
        # Slightly louder than Ph1 (vel 40) because this is the moment
        # of harmonic resolution — the listener should hear the violin
        # *agree* with the new chord.
        (28.0, 34.0, "C5", 40),

        # ── Phrase 3: G4 over C/G (22–26s) ───────────────────────────
        # 5th of C. Quietest, lowest note of the loop — the voice
        # receding before the Am return at 24s+. Lands during the
        # transition window so it dies into silence before Ph1 of the
        # NEXT loop iteration begins. Half-step up to A4 at seam = the
        # tiniest harmonic motion, ideal for a seamless loop point.
        (44.0, 50.0, "G4", 34),
        # silence 50–64 (~25–32s): >5s of pure piano + ambient before
        # the loop restarts. Maximum breath = maximum loneliness.
    ]
    OVERLAP = 0.3
    notes = []
    for on, off, pitch, vel in line:
        notes.append((on, off + OVERLAP, VIOLIN_CH, midi_note(pitch), vel))
    return notes


def violin_cc():
    """CC automation. CC1 = mod wheel = attack length on this SFZ
    (ampeg_attackcc1=0.5). CC11 = expression = per-sample volume curve.

    Three single-pitch phrases. Each gets the same shape: slow bow-in
    (CC1 high at attack), gentle swell to the midpoint, fade out before
    the note ends. CC11 ceiling is 50 (down from 92 in the old design)
    so the violin never out-shouts the piano.
    """
    events = [(0.0, VIOLIN_CH, 1, 60), (0.0, VIOLIN_CH, 11, 30)]

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

    # Phrase 1: A4 held 8.0–14.0 (3s). The voice entering — slow bow-in,
    # gentle swell, fade before release. CC11 caps at 45.
    ramp(8.0,  14.0, 1,  [(0, 110), (0.2, 65), (0.5, 35), (1.0, 30)])
    ramp(8.0,  14.0, 11, [(0, 18), (0.35, 42), (0.6, 45), (0.85, 35), (1.0, 20)])

    # Phrase 2: C5 held 28.0–34.0 (3s). The moment the violin agrees
    # with the new bass — slightly louder (CC11 max 50) but same shape.
    ramp(28.0, 34.0, 1,  [(0, 100), (0.2, 60), (0.5, 35), (1.0, 30)])
    ramp(28.0, 34.0, 11, [(0, 20), (0.35, 46), (0.6, 50), (0.85, 38), (1.0, 22)])

    # Phrase 3: G4 held 44.0–50.0 (3s). The exhale — quietest of the
    # three (CC11 max 38), slowest bow-in (CC1 starts at 120), longest
    # fade tail. The note dies before silence resumes at 50.
    ramp(44.0, 50.0, 1,  [(0, 120), (0.25, 75), (0.55, 45), (1.0, 40)])
    ramp(44.0, 50.0, 11, [(0, 15), (0.4, 35), (0.6, 38), (0.85, 28), (1.0, 14)])

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
    render(OUT / "cinematic-el-percussion.wav")


if __name__ == "__main__":
    main()
