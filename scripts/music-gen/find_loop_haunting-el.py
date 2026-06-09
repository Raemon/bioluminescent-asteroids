"""Find best 32s loop window for each of 9 haunting-el raw stems.

The three variations (cathedral-hymn-el / lost-transmission-el /
underwater-requiem-el) are A-A'-B-A' through-composed 64s pieces from
ElevenLabs. We need to pick a 32s sub-window per stem that:

  - loops cleanly (head/tail spectral similarity is high), and
  - sits acceptably against the C-pedal bass field. Like the outerwilds
    finder, we accept C/E/G as the home pitches but tolerate G-rooted (V),
    A-rooted (vi), or F-rooted (IV) windows so long as truly-clashing
    pitches (F#, C#, D#, G#) stay low.
  - starts on the downbeat grid (multiples of 2.0s) so the loop lines up
    with the bass measure clock.

Runs all 9 stems and prints the top candidate per stem.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np

HERE = Path(__file__).resolve().parent
LOOP_S = 32.0
SR = 22050
SEAM_MS = 500
STEP_S = 0.5  # search at beat grid; align to downbeat post-hoc

# Tolerant of G/A/F roots like outerwilds; punish only true clashes.
PENALTY_WEIGHTS = np.array([
    0.0,  # C
    0.6,  # C#
    0.0,  # D
    0.4,  # D#  (Eb is good, but D# = Eb chroma — keep mild penalty as in outerwilds)
    0.0,  # E
    0.0,  # F   accepted (IV)
    0.7,  # F#
    0.0,  # G
    0.5,  # G#
    0.0,  # A
    0.3,  # A#
    0.0,  # B
])
# Reward C/G/E (bass field's primary pitches), tolerate A/B/F as colour.
FIT_WEIGHTS = np.array([
    1.0,  # C
    0.0,  # C#
    0.0,  # D
    0.0,  # D#
    0.7,  # E
    0.4,  # F   (IV — colour)
    0.0,  # F#
    1.0,  # G
    0.0,  # G#
    0.3,  # A
    0.0,  # A#
    0.4,  # B  (Cmaj7)
])

STEMS = [
    "cathedral-hymn-el-ambient",
    "cathedral-hymn-el-melodic",
    "cathedral-hymn-el-layer3",
    "lost-transmission-el-ambient",
    "lost-transmission-el-melodic",
    "lost-transmission-el-layer3",
    "underwater-requiem-el-ambient",
    "underwater-requiem-el-melodic",
    "underwater-requiem-el-layer3",
]


def seam_similarity(y: np.ndarray, sr: int) -> float:
    n = int(sr * SEAM_MS / 1000)
    if y.size < 2 * n:
        return 0.0
    head = y[:n]
    tail = y[-n:]
    mh = librosa.feature.melspectrogram(y=head, sr=sr, n_mels=32).mean(axis=1)
    mt = librosa.feature.melspectrogram(y=tail, sr=sr, n_mels=32).mean(axis=1)
    mh = mh / (np.linalg.norm(mh) + 1e-9)
    mt = mt / (np.linalg.norm(mt) + 1e-9)
    return float(np.dot(mh, mt))


def chroma_score(y: np.ndarray, sr: int) -> tuple[float, float]:
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    chroma = chroma / (chroma.sum() + 1e-9)
    fit = float(np.dot(chroma, FIT_WEIGHTS))
    fight = float(np.dot(chroma, PENALTY_WEIGHTS))
    return fit, fight


def find_best(path: Path):
    y, sr = librosa.load(str(path), sr=SR, mono=True)
    total_s = len(y) / sr
    if total_s < LOOP_S + 0.5:
        return None
    candidates = []
    offset = 0.0
    while offset + LOOP_S <= total_s:
        i0 = int(offset * sr)
        i1 = int((offset + LOOP_S) * sr)
        win = y[i0:i1]
        seam = seam_similarity(win, sr)
        fit, fight = chroma_score(win, sr)
        # Bonus for downbeat alignment (multiples of 2.0s)
        downbeat = 0.1 if abs(offset % 2.0) < 0.05 else 0.0
        score = 1.0 * seam + 1.0 * fit - 1.5 * fight + downbeat
        candidates.append({
            "offset_s": round(offset, 3),
            "seam": round(seam, 4),
            "fit": round(fit, 4),
            "fight": round(fight, 4),
            "score": round(score, 4),
        })
        offset += STEP_S
    candidates.sort(key=lambda c: c["score"], reverse=True)
    return candidates[:5]


def main():
    raw_dir = HERE / "raw"
    out = {}
    for stem in STEMS:
        path = raw_dir / f"{stem}.mp3"
        if not path.exists():
            out[stem] = {"error": "missing"}
            continue
        out[stem] = find_best(path)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
