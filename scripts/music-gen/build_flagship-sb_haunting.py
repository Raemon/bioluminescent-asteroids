"""flagship-sb melodic + layer3 — haunting orchestral take.

Replaces the previous calliope-melody + celesta-cascade pair (which had
off-beat attacks that distracted from the bass clock and instruments that
didn't fit the haunting vibe of flagship-sb-ambient).

Both new stems use Virtual Playing Orchestra 3 samples rendered via sfizz.
Every onset lands exactly on a quarter-beat boundary so nothing can read as
syncopated against the in-game bgBeat pulse. Long sustained notes carry the
attack-on-beat rule without needing rhythmic punctuation.

Loop: 32 s = 4 phrases x 4 bars at 120 BPM. C-pedal. Phrase order A/A1/B/A2
(B = Cmaj7 colour with B/A natural-7 lift; others minor-3rd / Eb colour).

Melodic (6x): solo cello sustain. Slow lyrical line in C3-E4. Every onset
on a quarter-beat, mostly downbeats. Arc: A introduces low, A1 lifts,
B peaks with the maj7 colour, A2 settles back to root.

Layer 3 (12x): female choir sustain "ahh". G4-C6 register. Onsets only on
phrase-downbeats (beats 0 and 8 within each 16-beat phrase) and one mid-
phrase voicing-change. Slow choir attack hides any micro-rhythm.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_v3 import build_stem, midi_note  # noqa: E402

OUT = HERE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

VPO_ROOT = HERE / "samples/vpo3-scripts/Virtual-Playing-Orchestra3"
SFIZZ_BIN = HERE / "tools/sfizz/bin/sfizz_render"

CELLO_SFZ = VPO_ROOT / "Strings/cello-SOLO-sustain.sfz"
CHOIR_SFZ = VPO_ROOT / "Vocals/choir-FEMALE-sustain.sfz"

BPM = 120
BEAT_S = 60.0 / BPM
PHRASE_BEATS = 16  # 4 measures x 4 beats
LOOP_BEATS = 64    # 4 phrases


def render_sfizz(midi_bytes: bytes, sfz_path: Path, wav_out: Path) -> None:
    """MIDI bytes -> sfizz -> wav. Writes a tmp .mid next to the wav."""
    midi_tmp = wav_out.with_suffix(".mid")
    midi_tmp.write_bytes(midi_bytes)
    cmd = [
        str(SFIZZ_BIN),
        "--sfz", str(sfz_path),
        "--midi", str(midi_tmp),
        "--wav", str(wav_out),
        "--samplerate", "44100",
        "--use-eot",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("sfizz stderr:", r.stderr)
        raise SystemExit(r.returncode)


# --- Melodic: solo cello, slow lyrical line --------------------------------

def build_melodic_events():
    """Long sustained cello notes. Onset positions (in beats from phrase start)
    are chosen from {0, 4, 8, 12} (the four strong beats of a 4/4 bar) so
    every note attacks exactly on a beat. Notes overlap slightly (legato).

    Pitch contour by phrase:
      A : C3   - G3   - Eb4 - G3    (rise into the Eb peak)
      A1: Eb3  - Bb3  - G3  - C4    (settles up an octave above A's start)
      B : G3   - C4   - E4  - B3    (Cmaj7 colour: E4 + B3 against the bass)
      A2: Eb4  - G3   - Eb3 - C3    (descent back to the cello's low root)
    """
    phrase_lines = {
        "A":  [(0.0, 4.0, "C3", 70),
               (4.0, 4.0, "G3", 78),
               (8.0, 4.0, "Eb4", 82),
               (12.0, 4.0, "G3", 74)],
        "A1": [(0.0, 4.0, "Eb3", 72),
               (4.0, 4.0, "Bb3", 80),
               (8.0, 4.0, "G3", 76),
               (12.0, 4.0, "C4", 82)],
        # B keeps the same cadence skeleton but the pitches shift to Cmaj7
        # colour - the E4 + B3 pair is the haunting lift over the C-pedal.
        "B":  [(0.0, 4.0, "G3", 76),
               (4.0, 4.0, "C4", 82),
               (8.0, 4.0, "E4", 86),
               (12.0, 4.0, "B3", 80)],
        "A2": [(0.0, 4.0, "Eb4", 78),
               (4.0, 4.0, "G3", 74),
               (8.0, 4.0, "Eb3", 70),
               (12.0, 4.0, "C3", 66)],
    }
    phrase_order = ["A", "A1", "B", "A2"]
    events = []
    for i, key in enumerate(phrase_order):
        offset = i * PHRASE_BEATS
        for b, d, pitch, vel in phrase_lines[key]:
            # Slight overlap into the next note (0.1 beats) for cello legato.
            # ampeg_release in the sfz handles the natural tail past note-off.
            events.append((offset + b, d + 0.1, 0, midi_note(pitch), vel))
    return events


# --- Layer 3: female choir, sparse "ahh" voicing ---------------------------

def build_layer3_events():
    """Female choir sustain. Onsets only on beats 0 and 8 within each phrase
    (the two strongest downbeats). Each note holds for half a phrase (8 beats
    = 4 seconds). Two-voice chord per onset so the choir reads as a pad chord
    rather than a single line.

    Voicings by phrase:
      A : G4 + C5    -> G4 + Bb4     (Eb-colour pair)
      A1: G4 + Eb5   -> A4 + C5      (Eb-colour climb)
      B : E5 + B4    -> E5 + A4      (Cmaj7 colour: E + B against the C-pedal)
      A2: G4 + Eb5   -> G4 + C5      (resolution back to the open fifth)
    """
    phrase_voicings = {
        "A":  [(0.0, ["G4", "C5"]),
               (8.0, ["G4", "Bb4"])],
        "A1": [(0.0, ["G4", "Eb5"]),
               (8.0, ["A4", "C5"])],
        "B":  [(0.0, ["E5", "B4"]),
               (8.0, ["E5", "A4"])],
        "A2": [(0.0, ["G4", "Eb5"]),
               (8.0, ["G4", "C5"])],
    }
    phrase_order = ["A", "A1", "B", "A2"]
    events = []
    for i, key in enumerate(phrase_order):
        offset = i * PHRASE_BEATS
        for b, pitches in phrase_voicings[key]:
            for p in pitches:
                # 8-beat sustain. The 0.3s sfz attack means the onset feels
                # like a swell rather than a strike - no risk of rhythmic
                # poke. Slight overlap into next chord for crossfade feel.
                # Velocity kept low (60-72) so the choir is a wash, not a
                # lead voice.
                vel = 64 if p[-1] == "4" else 60  # upper voices a hair softer
                events.append((offset + b, 8.0 + 0.2, 0, midi_note(p), vel))
    return events


def main():
    print("rendering flagship-sb-melodic (VPO solo cello sustain)...")
    mel_midi = build_stem(build_melodic_events(), programs={})
    render_sfizz(mel_midi, CELLO_SFZ, OUT / "flagship-sb-melodic.wav")
    print(f"  wrote {OUT / 'flagship-sb-melodic.wav'}")

    print("rendering flagship-sb-layer3 (VPO female choir sustain)...")
    l3_midi = build_stem(build_layer3_events(), programs={})
    render_sfizz(l3_midi, CHOIR_SFZ, OUT / "flagship-sb-layer3.wav")
    print(f"  wrote {OUT / 'flagship-sb-layer3.wav'}")


if __name__ == "__main__":
    main()
